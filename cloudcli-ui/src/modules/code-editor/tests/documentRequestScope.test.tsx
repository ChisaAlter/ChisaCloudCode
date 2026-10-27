import assert from 'node:assert/strict';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, test, vi } from 'vitest';
import { useCodeEditorDocument } from '@/modules/code-editor/hooks/useCodeEditorDocument';
import type { CodeEditorFile } from '@/shared/types';

const requests = vi.hoisted(() => ({ readFile: vi.fn(), saveFile: vi.fn() }));
vi.mock('@/shared/api', async (importOriginal) => ({ ...await importOriginal<Record<string, unknown>>(), api: requests }));
const file = (path: string): CodeEditorFile => ({ name: path, path, projectId: 'project' });
const json = (content: string, hash: string) => new Response(JSON.stringify({ content, hash }), { headers: { 'Content-Type': 'application/json' } });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
beforeEach(() => vi.resetAllMocks());
afterEach(() => cleanup());

test('a late old read cannot replace the new file or its unsaved edits', async () => {
  const old = deferred<Response>();
  requests.readFile.mockImplementation((_project, path) => path === 'a.ts' ? old.promise : Promise.resolve(json('B', 'hash-b')));
  const view = renderHook(({ current }) => useCodeEditorDocument({ file: current }), { initialProps: { current: file('a.ts') } });
  view.rerender({ current: file('b.ts') });
  await waitFor(() => assert.equal(view.result.current.content, 'B'));
  act(() => view.result.current.setContent('B edited'));
  await act(async () => { old.resolve(json('A', 'hash-a')); });
  assert.equal(view.result.current.content, 'B edited');
  assert.equal(view.result.current.loading, false);
  assert.equal(requests.readFile.mock.calls[0][2].signal.aborted, true);
});

test('a late save cannot change the new file hash or show success for it', async () => {
  const saving = deferred<Response>();
  requests.readFile.mockImplementation((_project, path) => Promise.resolve(json(path, `hash-${path}`)));
  requests.saveFile.mockImplementation((_project, path) => path === 'a.ts' ? saving.promise : Promise.resolve(json('saved B', 'new-b')));
  const view = renderHook(({ current }) => useCodeEditorDocument({ file: current }), { initialProps: { current: file('a.ts') } });
  await waitFor(() => assert.equal(view.result.current.loading, false));
  let pending!: Promise<void>;
  act(() => { pending = view.result.current.handleSave(); });
  view.rerender({ current: file('b.ts') });
  await waitFor(() => assert.equal(view.result.current.content, 'b.ts'));
  await act(async () => { saving.resolve(json('saved A', 'new-a')); await pending; });
  assert.equal(view.result.current.saveSuccess, false);
  await act(async () => { await view.result.current.handleSave(); });
  assert.equal(requests.saveFile.mock.calls[1][3], 'hash-b.ts');
  assert.equal(requests.saveFile.mock.calls[0][4].signal.aborted, true);
});

test('loading and failed reads cannot save an uninitialized or diagnostic buffer', async () => {
  const read = deferred<Response>();
  requests.readFile.mockReturnValue(read.promise);
  const view = renderHook(() => useCodeEditorDocument({ file: file('a.ts') }));
  await act(async () => { await view.result.current.handleSave(); });
  await act(async () => { read.resolve(new Response('', { status: 500 })); });
  await act(async () => { await view.result.current.handleSave(); });
  assert.equal(requests.saveFile.mock.calls.length, 0);
});

test('simultaneous shortcuts send one save and unmount cancels it', async () => {
  requests.readFile.mockResolvedValue(json('A', 'hash-a'));
  const saved = deferred<Response>();
  requests.saveFile.mockReturnValue(saved.promise);
  const view = renderHook(() => useCodeEditorDocument({ file: file('a.ts') }));
  await waitFor(() => assert.equal(view.result.current.loading, false));
  act(() => { void view.result.current.handleSave(); void view.result.current.handleSave(); });
  assert.equal(requests.saveFile.mock.calls.length, 1);
  view.unmount();
  assert.equal(requests.saveFile.mock.calls[0][4].signal.aborted, true);
  await act(async () => { saved.resolve(json('A', 'saved-a')); });
});

test('editing during a save never marks the newer unsaved buffer as saved', async () => {
  requests.readFile.mockResolvedValue(json('A', 'hash-a'));
  const saved = deferred<Response>();
  requests.saveFile.mockReturnValue(saved.promise);
  const view = renderHook(() => useCodeEditorDocument({ file: file('a.ts') }));
  await waitFor(() => assert.equal(view.result.current.loading, false));
  let pending!: Promise<void>;
  act(() => { pending = view.result.current.handleSave(); });
  act(() => view.result.current.setContent('new unsaved text'));
  await act(async () => { saved.resolve(json('A', 'saved-a')); await pending; });
  assert.equal(view.result.current.content, 'new unsaved text');
  assert.equal(view.result.current.saveSuccess, false);
  assert.equal(requests.saveFile.mock.calls.length, 1);
});

test('an explicit second save writes the latest buffer with the first confirmed CAS hash', async () => {
  requests.readFile.mockResolvedValue(json('A', 'hash-a'));
  const first = deferred<Response>();
  requests.saveFile.mockReturnValueOnce(first.promise).mockResolvedValueOnce(json('B', 'saved-b'));
  const view = renderHook(() => useCodeEditorDocument({ file: file('a.ts') }));
  await waitFor(() => assert.equal(view.result.current.loading, false));
  let pending!: Promise<void>;
  act(() => { pending = view.result.current.handleSave(); });
  act(() => view.result.current.setContent('B'));
  await act(async () => { await view.result.current.handleSave(); });
  assert.equal(requests.saveFile.mock.calls.length, 1);
  await act(async () => { first.resolve(json('A', 'saved-a')); await pending; });
  assert.deepEqual(requests.saveFile.mock.calls.map(call => call.slice(0, 4)), [
    ['project', 'a.ts', 'A', 'hash-a'], ['project', 'a.ts', 'B', 'saved-a'],
  ]);
  assert.equal(view.result.current.saveSuccess, true);
  act(() => view.result.current.setContent('C'));
  assert.equal(view.result.current.saveSuccess, false);
});

test('a failed save does not automatically run the requested follow-up write', async () => {
  requests.readFile.mockResolvedValue(json('A', 'hash-a'));
  const first = deferred<Response>();
  requests.saveFile.mockReturnValue(first.promise);
  const view = renderHook(() => useCodeEditorDocument({ file: file('a.ts') }));
  await waitFor(() => assert.equal(view.result.current.loading, false));
  let pending!: Promise<void>;
  act(() => { pending = view.result.current.handleSave(); });
  act(() => view.result.current.setContent('B'));
  await act(async () => { await view.result.current.handleSave(); });
  await act(async () => { first.resolve(new Response('{"error":"Conflict"}', { status: 409, headers: { 'Content-Type': 'application/json' } })); await pending; });
  assert.equal(requests.saveFile.mock.calls.length, 1);
  assert.equal(view.result.current.content, 'B');
  assert.equal(view.result.current.saveSuccess, false);
  assert.equal(view.result.current.saveError, 'Conflict');
});
