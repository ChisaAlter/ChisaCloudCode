import assert from 'node:assert/strict';

import { act, renderHook } from '@testing-library/react';
import { beforeEach, test, vi } from 'vitest';

import { useFileTreeData } from '@/modules/file-tree/hooks/useFileTreeData';
import { api } from '@/shared/api';
import type { FileTreeNode, Project } from '@/shared/types';

vi.mock('@/shared/api', () => ({ api: { getFiles: vi.fn() } }));

const PROJECT: Project = { projectId: 'one', displayName: 'One', fullPath: '/one' };
const OTHER_PROJECT: Project = { projectId: 'two', displayName: 'Two', fullPath: '/two' };
const getFiles = vi.mocked(api.getFiles);
const folder = (path: string): FileTreeNode => ({ name: path.split('/').pop()!, path, type: 'directory' });
const file = (path: string): FileTreeNode => ({ name: path.split('/').pop()!, path, type: 'file' });
const response = (files: FileTreeNode[]): Response => ({ ok: true, json: async () => files }) as Response;

const setup = async () => {
  let view!: ReturnType<typeof renderHook<ReturnType<typeof useFileTreeData>, Project>>;
  await act(async () => {
    view = renderHook((project: Project | null) => useFileTreeData(project), { initialProps: PROJECT });
  });
  return view;
};

beforeEach(() => getFiles.mockReset());

test('root and requested folders load shallowly, pending and empty folders are not fetched twice', async () => {
  getFiles.mockResolvedValueOnce(response([folder('/one/src'), file('/one/readme.md')]));
  const view = await setup();
  assert.equal(getFiles.mock.calls.length, 1);
  assert.equal(getFiles.mock.calls[0][1]?.shallow, true);
  assert.equal(getFiles.mock.calls[0][1]?.directoryPath, undefined);

  let finish!: (response: Response) => void;
  getFiles.mockReturnValueOnce(new Promise<Response>((resolve) => { finish = resolve; }));
  let pending!: Promise<void>;
  act(() => { pending = view.result.current.loadDirectory('/one/src'); });
  assert.equal(view.result.current.loadingDirectoryCount, 1);
  assert.equal(getFiles.mock.calls[1][1]?.shallow, true);
  assert.equal(getFiles.mock.calls[1][1]?.directoryPath, '/one/src');
  await act(async () => { await view.result.current.loadDirectory('/one/src'); });
  assert.equal(getFiles.mock.calls.length, 2);
  await act(async () => { finish(response([])); await pending; });
  assert.deepEqual(view.result.current.files[0].children, []);
  assert.equal(view.result.current.loadingDirectoryCount, 0);
  await act(async () => { await view.result.current.loadDirectory('/one/src'); });
  assert.equal(getFiles.mock.calls.length, 2);
});

test('a folder failure keeps the root usable and exposes the server error', async () => {
  const root = [folder('/one/src'), file('/one/readme.md')];
  getFiles.mockResolvedValueOnce(response(root));
  const view = await setup();
  getFiles.mockResolvedValueOnce({ ok: false, text: async () => JSON.stringify({ error: 'Workspace is disconnected' }) } as Response);
  await act(async () => { await view.result.current.loadDirectory('/one/src'); });
  assert.deepEqual(view.result.current.files, root);
  assert.equal(view.result.current.error, null);
  assert.equal(view.result.current.directoryError, '/one/src: Workspace is disconnected');
  assert.equal(view.result.current.loadingDirectoryCount, 0);
  getFiles.mockResolvedValueOnce(response([file('/one/src/main.ts')]));
  await act(async () => { await view.result.current.loadDirectory('/one/src'); });
  assert.equal(view.result.current.files[0].children?.[0].name, 'main.ts');
  assert.equal(view.result.current.directoryError, null);
});

test('the total loaded tree allows 10000 entries and refuses the next merge without discarding entries', async () => {
  getFiles.mockResolvedValueOnce(response([folder('/one/a'), folder('/one/b')]));
  const view = await setup();
  getFiles.mockResolvedValueOnce(response(Array.from({ length: 9998 }, (_, index) => file(`/one/a/${index}.ts`))));
  await act(async () => { await view.result.current.loadDirectory('/one/a'); });
  assert.equal(view.result.current.files[0].children?.length, 9998);
  const acceptedFiles = view.result.current.files;
  getFiles.mockResolvedValueOnce(response([file('/one/b/extra.ts')]));
  await act(async () => { await view.result.current.loadDirectory('/one/b'); });
  assert.equal(view.result.current.files, acceptedFiles);
  assert.equal(view.result.current.files[1].children, undefined);
  assert.match(view.result.current.directoryError ?? '', /10000/);
});

test('refresh reads the current root again and leaves folders unloaded until requested', async () => {
  getFiles.mockResolvedValueOnce(response([folder('/one/src')]));
  const view = await setup();
  getFiles.mockResolvedValueOnce(response([file('/one/src/old.ts')]));
  await act(async () => { await view.result.current.loadDirectory('/one/src'); });
  assert.equal(view.result.current.files[0].children?.[0].name, 'old.ts');
  getFiles.mockResolvedValueOnce(response([folder('/one/src'), file('/one/new.md')]));
  await act(async () => { view.result.current.refreshFiles(); });
  assert.equal(view.result.current.files[0].children, undefined);
  assert.equal(view.result.current.files[1].name, 'new.md');
  assert.equal(getFiles.mock.calls.length, 3);
  assert.equal(getFiles.mock.calls[2][1]?.directoryPath, undefined);
  getFiles.mockResolvedValueOnce(response([file('/one/src/new.ts')]));
  await act(async () => { await view.result.current.loadDirectory('/one/src'); });
  assert.deepEqual(view.result.current.files[0].children, [file('/one/src/new.ts')]);
});

test('a native folder response arriving after project switch cannot change the new tree', async () => {
  getFiles.mockResolvedValueOnce(response([folder('/one/src')]));
  const view = await setup();
  let finishOld!: (response: Response) => void;
  getFiles.mockReturnValueOnce(new Promise<Response>((resolve) => { finishOld = resolve; }));
  let pending!: Promise<void>;
  act(() => { pending = view.result.current.loadDirectory('/one/src'); });
  const oldSignal = getFiles.mock.calls[1][1]?.signal;
  const newRoot = [file('/two/new.md')];
  getFiles.mockResolvedValueOnce(response(newRoot));
  await act(async () => { view.rerender(OTHER_PROJECT); });
  assert.equal(oldSignal?.aborted, true);
  await act(async () => { finishOld(response([file('/one/src/stale.ts')])); await pending; });
  assert.deepEqual(view.result.current.files, newRoot);
  assert.equal(view.result.current.loadingDirectoryCount, 0);
  assert.equal(view.result.current.directoryError, null);
});
