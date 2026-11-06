import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import type * as AuthTokenModule from '@/shared/authToken';

let auth: typeof AuthTokenModule;
const encoder = new TextEncoder();
function token(userId = 'alice') {
  return `e30.${Buffer.from(JSON.stringify({ userId, exp: Math.floor(Date.now() / 1000) + 600 })).toString('base64url')}.signature`;
}
async function flush() { for (let i = 0; i < 35; i++) await Promise.resolve(); }
function wire() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const cancel = vi.fn();
  const body = new ReadableStream<Uint8Array>({ start(value) { controller = value; }, cancel });
  return { response: new Response(body, { headers: { 'Content-Type': 'text/event-stream' } }), cancel,
    event: (type: string, data: unknown) => controller.enqueue(encoder.encode(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`)) };
}
function project(sessionId: string, projectId = 'project-a') {
  return { projectResult: { projectId, projectName: projectId, sessions: [
    { sessionId, provider: 'claude', sessionSummary: 'Label ' + sessionId, matches: [{ snippet: 'Hit ' + sessionId }] },
  ] } };
}

beforeEach(async () => {
  vi.resetModules(); vi.useFakeTimers(); localStorage.clear(); sessionStorage.clear();
  auth = await import('@/shared/authToken'); await auth.initializeAuthSession();
  const expected = await auth.startAuthSession(token()); auth.acknowledgeAuthSession(expected!);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

test('project search debounces and streams only matching project results through header-auth fetch', async () => {
  const stream = wire(); const fetcher = vi.fn(async () => stream.response); vi.stubGlobal('fetch', fetcher);
  const { useSessionMessageSearch } = await import('@/modules/command-palette/hooks/useSessionMessageSearch');
  const { result } = renderHook(() => useSessionMessageSearch('project-a', 'needle', true));
  expect(result.current).toEqual([]); await act(async () => { await vi.advanceTimersByTimeAsync(249); }); expect(fetcher).not.toHaveBeenCalled();
  await act(async () => { await vi.advanceTimersByTimeAsync(1); await flush(); });
  const init = (fetcher.mock.calls[0] as unknown as [string, RequestInit])[1];
  expect(new Headers(init.headers).get('Authorization')).toBe('Bearer ' + auth.getAuthSessionSnapshot().token);
  await act(async () => { stream.event('result', project('other', 'project-b')); stream.event('result', project('one')); await flush(); });
  expect(result.current).toEqual([{ sessionId: 'one', label: 'Label one', snippet: 'Hit one', provider: 'claude' }]);
  await act(async () => { stream.event('done', {}); await flush(); }); expect(stream.cancel).toHaveBeenCalledTimes(1);
});

test('query change clears old rows immediately and aborts its stream before the next debounce', async () => {
  const first = wire(); const second = wire(); const fetcher = vi.fn().mockResolvedValueOnce(first.response).mockResolvedValueOnce(second.response);
  vi.stubGlobal('fetch', fetcher); const { useSessionMessageSearch } = await import('@/modules/command-palette/hooks/useSessionMessageSearch');
  const { result, rerender } = renderHook(({ query }) => useSessionMessageSearch('project-a', query, true), { initialProps: { query: 'first' } });
  await act(async () => { await vi.advanceTimersByTimeAsync(250); first.event('result', project('old')); await flush(); });
  expect(result.current).toHaveLength(1); rerender({ query: 'second' });
  expect(result.current).toEqual([]); expect(first.cancel).toHaveBeenCalledTimes(1);
  expect(((fetcher.mock.calls[0] as unknown as [string, RequestInit])[1].signal)?.aborted).toBe(true);
  await act(async () => { await vi.advanceTimersByTimeAsync(250); second.event('result', project('new')); await flush(); });
  expect(result.current.map(item => item.sessionId)).toEqual(['new']);
});

test.each(['disabled', 'short', 'project', 'unmount'])('%s stops pending/live search and never retains the old results', async mode => {
  const stream = wire(); const fetcher = vi.fn(async () => stream.response); vi.stubGlobal('fetch', fetcher);
  const { useSessionMessageSearch } = await import('@/modules/command-palette/hooks/useSessionMessageSearch');
  const { result, rerender, unmount } = renderHook(({ projectId, query, enabled }) => useSessionMessageSearch(projectId, query, enabled), {
    initialProps: { projectId: 'project-a', query: 'needle', enabled: true },
  });
  await act(async () => { await vi.advanceTimersByTimeAsync(250); stream.event('result', project('old')); await flush(); });
  expect(result.current).toHaveLength(1);
  if (mode === 'unmount') unmount();
  else rerender({ projectId: mode === 'project' ? '' : 'project-a', query: mode === 'short' ? 'x' : 'needle', enabled: mode !== 'disabled' });
  expect(stream.cancel).toHaveBeenCalledTimes(1);
  if (mode !== 'unmount') expect(result.current).toEqual([]);
  await act(async () => { await vi.advanceTimersByTimeAsync(300); }); expect(fetcher).toHaveBeenCalledTimes(1);
});

test('account replacement clears existing matches, rejects old bytes and uses only the replacement Bearer on a new search', async () => {
  const first = wire(); const second = wire(); const fetcher = vi.fn().mockResolvedValueOnce(first.response).mockResolvedValueOnce(second.response);
  vi.stubGlobal('fetch', fetcher); const { useSessionMessageSearch } = await import('@/modules/command-palette/hooks/useSessionMessageSearch');
  const { result } = renderHook(() => useSessionMessageSearch('project-a', 'needle', true));
  await act(async () => { await vi.advanceTimersByTimeAsync(250); first.event('result', project('alice')); await flush(); });
  expect(result.current.map(item => item.sessionId)).toEqual(['alice']);
  await act(async () => { const expected = await auth.startAuthSession(token('bob')); auth.acknowledgeAuthSession(expected!); await flush(); });
  expect(result.current).toEqual([]); expect(first.cancel).toHaveBeenCalledTimes(1);
  await act(async () => { await vi.advanceTimersByTimeAsync(250); second.event('result', project('bob')); await flush(); });
  expect(result.current.map(item => item.sessionId)).toEqual(['bob']);
  expect(new Headers((fetcher.mock.calls[1] as [string, RequestInit])[1].headers).get('Authorization')).toBe('Bearer ' + auth.getAuthSessionSnapshot().token);
});

test('unmount during debounce causes no fetch and unmount during pending headers retires a late body', async () => {
  const { useSessionMessageSearch } = await import('@/modules/command-palette/hooks/useSessionMessageSearch');
  const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
  const early = renderHook(() => useSessionMessageSearch('project-a', 'needle', true)); early.unmount();
  await act(async () => { await vi.advanceTimersByTimeAsync(300); }); expect(fetcher).not.toHaveBeenCalled();
  let resolve!: (response: Response) => void; const pending = new Promise<Response>(done => { resolve = done; });
  const stream = wire(); fetcher.mockReturnValue(pending);
  const late = renderHook(() => useSessionMessageSearch('project-a', 'needle', true));
  await act(async () => { await vi.advanceTimersByTimeAsync(250); await flush(); }); late.unmount();
  await act(async () => { resolve(stream.response); await flush(); }); expect(stream.cancel).toHaveBeenCalledTimes(1);
});
