import assert from 'node:assert/strict';
import type { ReactNode } from 'react';
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { createInstance } from 'i18next';
import { I18nextProvider, initReactI18next } from 'react-i18next';
import { afterEach, beforeAll, beforeEach, test, vi } from 'vitest';

import { Markdown } from '@/modules/chat/transcript/Markdown';
import StreamingMarkdown from '@/modules/chat/transcript/StreamingMarkdown';
import { ToolRenderer } from '@/modules/chat/tools/ToolRenderer';
import enCommon from '@/modules/i18n/locales/en/common.json';
import enChat from '@/modules/i18n/locales/en/chat.json';

const translations = createInstance();
const nativeUrl = URL;
const fetchMock = vi.fn<typeof fetch>();
const createObjectUrl = vi.fn<(blob: Blob) => string>();
const revokeObjectUrl = vi.fn<(url: string) => void>();
const imageBytes = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS24AAAAASUVORK5CYII='), (byte) => byte.charCodeAt(0));

const imageResponse = () => new Response(imageBytes, { headers: { 'Content-Type': 'image/png' } });

function Translations({ children }: { children: ReactNode }) {
  return <I18nextProvider i18n={translations}>{children}</I18nextProvider>;
}

const renderMarkdown = (content: string, projectId = 'project-a', disableFileLinks = false) =>
  render(<Markdown projectId={projectId} disableFileLinks={disableFileLinks}>{content}</Markdown>, { wrapper: Translations });

function requestAt(index: number): { url: URL; options: RequestInit } {
  const [url, options] = fetchMock.mock.calls[index];
  return { url: new URL(String(url), 'https://service.example.test'), options: options ?? {} };
}

function pendingResponse() {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>((done) => { resolve = done; });
  return { promise, resolve };
}

beforeAll(async () => {
  await translations.use(initReactI18next).init({
    lng: 'en',
    fallbackLng: 'en',
    initImmediate: false,
    resources: { en: { common: enCommon, chat: enChat } },
  });
});

beforeEach(() => {
  vi.resetAllMocks();
  localStorage.clear();
  localStorage.setItem('auth-token', 'test.payload.signature');
  vi.stubGlobal('mygo', undefined);
  fetchMock.mockImplementation(async () => imageResponse());
  vi.stubGlobal('fetch', fetchMock);
  let nextObjectUrl = 0;
  createObjectUrl.mockImplementation(() => `blob:chat-image-${++nextObjectUrl}`);
  vi.stubGlobal('URL', class extends nativeUrl {
    static createObjectURL = createObjectUrl;
    static revokeObjectURL = revokeObjectUrl;
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
});

test('a project-relative image loads with authentication and inaccessible replacements report failure', async () => {
  const view = renderMarkdown('![Chart](images/chart.png)');
  await waitFor(() => assert.ok(view.queryByRole('img', { name: 'Chart' })));
  const image = view.getByRole('img', { name: 'Chart' });
  const originalSrc = image.getAttribute('src');
  assert.ok(originalSrc?.startsWith('blob:'));
  const request = requestAt(0);
  assert.equal(request.url.pathname, '/api/file-tree/projects/project-a/files/content');
  assert.equal(request.url.searchParams.get('path'), 'images/chart.png');
  assert.equal(new Headers(request.options.headers).get('Authorization'), 'Bearer test.payload.signature');
  const loadedBytes = await new Promise<ArrayBuffer>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(createObjectUrl.mock.calls[0][0]);
  });
  assert.deepEqual(new Uint8Array(loadedBytes), imageBytes);

  fetchMock.mockResolvedValueOnce(new Response('Forbidden', { status: 403 }));
  view.rerender(<Markdown projectId="project-a">{'![Private image](private.png)'}</Markdown>);
  await waitFor(() => assert.ok(view.getByRole('status').textContent?.includes(enCommon.fileTree.loadFailed)));
  assert.equal(view.queryByRole('img'), null);
  assert.ok(revokeObjectUrl.mock.calls.some(([url]) => url === originalSrc));
  assert.equal(fetchMock.mock.calls.length, 2, 'a failed image does not trigger automatic retries');
});

test('streamed settled and pending images both resolve against the selected project', async () => {
  const view = render(
    <StreamingMarkdown projectId="project-a" content={'![Settled](/workspace/images/settled.png)\n\n![Pending](images/pending.png)'} isStreaming />,
    { wrapper: Translations },
  );
  await waitFor(() => assert.equal(view.getAllByRole('img').length, 2));
  assert.deepEqual(fetchMock.mock.calls.map((_call, index) => requestAt(index).url.searchParams.get('path')).sort(), ['images/pending.png', 'images/settled.png']);
  assert.ok(fetchMock.mock.calls.every((_call, index) => requestAt(index).url.pathname === '/api/file-tree/projects/project-a/files/content'));
  assert.ok(view.getByRole('img', { name: 'Settled' }).getAttribute('src')?.startsWith('blob:'));
  assert.ok(view.getByRole('img', { name: 'Pending' }).getAttribute('src')?.startsWith('blob:'));
});

test('expanding a tool markdown result loads its image against the tool conversation project', async () => {
  const view = render(
    <ToolRenderer
      toolName="Task"
      toolInput={{ prompt: 'Return a chart' }}
      toolResult={{ content: '![Tool chart](/workspace/results/chart.png)' }}
      mode="result"
      selectedProject={{ projectId: 'project-tools', displayName: 'Tools', fullPath: '/srv/tools' }}
    />,
    { wrapper: Translations },
  );
  fireEvent.click(view.getByRole('button', { name: /Subagent result/ }));
  await waitFor(() => assert.ok(view.queryByRole('img', { name: 'Tool chart' })));
  assert.equal(requestAt(0).url.pathname, '/api/file-tree/projects/project-tools/files/content');
  assert.equal(requestAt(0).url.searchParams.get('path'), 'results/chart.png');
  assert.ok(view.getByRole('img', { name: 'Tool chart' }).getAttribute('src')?.startsWith('blob:'));
});

test('an explicit API image is fetched with the current account instead of becoming a bare img URL', async () => {
  const view = renderMarkdown('![Uploaded](/api/assets/images/upload.png)');
  await waitFor(() => assert.ok(view.queryByRole('img', { name: 'Uploaded' })));
  assert.equal(String(fetchMock.mock.calls[0][0]), '/api/assets/images/upload.png');
  assert.equal(new Headers(requestAt(0).options.headers).get('Authorization'), 'Bearer test.payload.signature');
  assert.ok(view.getByRole('img', { name: 'Uploaded' }).getAttribute('src')?.startsWith('blob:'));
});

test('POSIX, Windows-drive and file URL paths use the existing project content endpoint', async () => {
  const view = renderMarkdown('![POSIX](/srv/project/chart.png)\n\n![Drive](C:/project/chart.png)\n\n![File URL](file:///C:/project/chart%20one.png)');
  await waitFor(() => assert.equal(view.getAllByRole('img').length, 3));
  assert.deepEqual(fetchMock.mock.calls.map((_call, index) => requestAt(index).url.searchParams.get('path')).sort(), ['/srv/project/chart.png', 'C:/project/chart one.png', 'C:/project/chart.png']);
  assert.ok(fetchMock.mock.calls.every((_call, index) => requestAt(index).url.pathname === '/api/file-tree/projects/project-a/files/content'));
});

test('public URLs, image data and existing blob URLs retain their src without sending account credentials', () => {
  const data = 'data:image/png;base64,iVBORw0KGgo=';
  const view = renderMarkdown(`![Remote](https://images.example.test/chart.png)\n\n![Inline](${data})\n\n![Blob](blob:existing-image)`);
  assert.equal(view.getByRole('img', { name: 'Remote' }).getAttribute('src'), 'https://images.example.test/chart.png');
  assert.equal(view.getByRole('img', { name: 'Inline' }).getAttribute('src'), data);
  assert.equal(view.getByRole('img', { name: 'Blob' }).getAttribute('src'), 'blob:existing-image');
  assert.equal(fetchMock.mock.calls.length, 0);
});

test('unsafe image protocols and ordinary link protocols remain filtered', () => {
  const view = renderMarkdown('![Script](javascript:alert%281%29)\n\n![HTML](data:text/html;base64,AAAA)\n\n![Unknown](custom:payload)\n\n[Unsafe link](javascript:alert%281%29) [Data link](data:image/png;base64,AAAA) [Website](https://example.test/docs)');
  assert.equal(view.queryByRole('img'), null);
  assert.equal(view.getAllByRole('status').length, 3);
  const anchors = [...view.container.querySelectorAll('a')];
  assert.equal(anchors.find((anchor) => anchor.textContent === 'Unsafe link')?.getAttribute('href'), '');
  assert.equal(anchors.find((anchor) => anchor.textContent === 'Data link')?.getAttribute('href'), '');
  assert.equal(view.getByRole('link', { name: 'Website' }).getAttribute('href'), 'https://example.test/docs');
  assert.equal(fetchMock.mock.calls.length, 0);
});

test('native-agent markdown cannot resolve its file paths through a cloud project', () => {
  const view = renderMarkdown('![Local file](/workspace/private.png)\n\n![Public image](https://images.example.test/public.png)', 'project-a', true);
  assert.equal(view.queryByRole('img', { name: 'Local file' }), null);
  assert.ok(view.getByRole('status').textContent?.includes(enCommon.fileTree.loadFailed));
  assert.equal(view.getByRole('img', { name: 'Public image' }).getAttribute('src'), 'https://images.example.test/public.png');
  assert.equal(fetchMock.mock.calls.length, 0);
});

test('changing source and project cancels a pending image request and ignores its late response', async () => {
  const oldRequest = pendingResponse();
  const newRequest = pendingResponse();
  fetchMock.mockImplementationOnce(() => oldRequest.promise).mockImplementationOnce(() => newRequest.promise);
  const view = renderMarkdown('![Old](old.png)', 'project-a');
  assert.equal(fetchMock.mock.calls.length, 1);
  const oldSignal = requestAt(0).options.signal;
  view.rerender(<Markdown projectId="project-b">{'![Current](current.png)'}</Markdown>);
  assert.equal(fetchMock.mock.calls.length, 2);
  assert.equal(oldSignal?.aborted, true);
  assert.equal(requestAt(1).url.pathname, '/api/file-tree/projects/project-b/files/content');
  assert.equal(requestAt(1).url.searchParams.get('path'), 'current.png');

  await act(async () => { oldRequest.resolve(imageResponse()); await oldRequest.promise; });
  assert.equal(view.queryByRole('img'), null);
  assert.equal(createObjectUrl.mock.calls.length, 0);
  await act(async () => { newRequest.resolve(imageResponse()); await newRequest.promise; });
  await waitFor(() => assert.ok(view.queryByRole('img', { name: 'Current' })));
  assert.equal(view.queryByRole('img', { name: 'Old' }), null);
  assert.equal(createObjectUrl.mock.calls.length, 1);
});

test('lightboxes close normally and revisiting an image clears expansion and decode failures', () => {
  const imageA = '![Image A](https://images.example.test/a.png)';
  const imageB = '![Image B](https://images.example.test/b.png)';
  const view = renderMarkdown(imageA);
  fireEvent.click(view.getByRole('button', { name: 'Expand Image A' }));
  assert.ok(view.getByRole('dialog', { name: 'Image A' }));
  fireEvent.click(view.getByRole('button', { name: 'Close image preview' }));
  assert.equal(view.queryByRole('dialog'), null);
  fireEvent.click(view.getByRole('button', { name: 'Expand Image A' }));
  fireEvent.keyDown(document, { key: 'Escape' });
  assert.equal(view.queryByRole('dialog'), null);
  fireEvent.click(view.getByRole('button', { name: 'Expand Image A' }));
  fireEvent.click(view.getByRole('dialog', { name: 'Image A' }));
  assert.equal(view.queryByRole('dialog'), null);

  fireEvent.click(view.getByRole('button', { name: 'Expand Image A' }));
  view.rerender(<Markdown projectId="project-a">{imageB}</Markdown>);
  assert.equal(view.queryByRole('dialog'), null);
  view.rerender(<Markdown projectId="project-a">{imageA}</Markdown>);
  assert.equal(view.queryByRole('dialog'), null, 'returning to a previous image must not reopen its lightbox');
  fireEvent.error(view.getByRole('img', { name: 'Image A' }));
  assert.ok(view.getByRole('status').textContent?.includes(enCommon.fileTree.loadFailed));
  view.rerender(<Markdown projectId="project-a">{imageB}</Markdown>);
  view.rerender(<Markdown projectId="project-a">{imageA}</Markdown>);
  assert.ok(view.getByRole('img', { name: 'Image A' }));
  assert.equal(view.queryByRole('status'), null, 'returning to an image starts with a fresh decode state');
});

test('a loaded image is removed and its blob revoked while a different project is loading', async () => {
  const replacement = pendingResponse();
  fetchMock.mockImplementationOnce(async () => imageResponse()).mockImplementationOnce(() => replacement.promise);
  const view = renderMarkdown('![Chart](chart.png)', 'project-a');
  await waitFor(() => assert.ok(view.queryByRole('img', { name: 'Chart' })));
  const oldSrc = view.getByRole('img', { name: 'Chart' }).getAttribute('src');
  const oldSignal = requestAt(0).options.signal;
  view.rerender(<Markdown projectId="project-b">{'![Chart](chart.png)'}</Markdown>);
  assert.equal(view.queryByRole('img'), null, 'project A bytes cannot stay visible under project B');
  assert.equal(oldSignal?.aborted, true);
  assert.ok(revokeObjectUrl.mock.calls.some(([url]) => url === oldSrc));
  await act(async () => { replacement.resolve(imageResponse()); await replacement.promise; });
  await waitFor(() => assert.ok(view.queryByRole('img', { name: 'Chart' })));
  const newSrc = view.getByRole('img', { name: 'Chart' }).getAttribute('src');
  assert.notEqual(newSrc, oldSrc);
  view.unmount();
  assert.ok(revokeObjectUrl.mock.calls.some(([url]) => url === newSrc));
});
