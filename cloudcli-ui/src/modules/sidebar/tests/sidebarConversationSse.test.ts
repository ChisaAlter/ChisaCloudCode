import { act, cleanup, renderHook } from '@testing-library/react';
import type { TFunction } from 'i18next';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import type * as AuthTokenModule from '@/shared/authToken';

vi.mock('@/modules/command-palette', () => ({ usePaletteOps: () => ({ refreshProjects: vi.fn() }) }));
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
const projectResult = { projectId: 'project-a', projectName: 'Project A', sessions: [] };
async function harness() {
  const { useSidebarController } = await import('@/modules/sidebar/hooks/useSidebarController');
  const args = { projects: [], selectedProject: null, selectedSession: null,
    activeSessions: new Set<string>(), backgroundSessionIds: new Set<string>(), isLoading: false, isMobile: false,
    t: ((key: string) => key) as TFunction, onRefresh: vi.fn(), onProjectSelect: vi.fn(), onSessionSelect: vi.fn(),
    setCurrentProject: vi.fn(), setSidebarVisible: vi.fn(), sidebarVisible: true };
  return renderHook(() => useSidebarController(args));
}
async function search(rendered: Awaited<ReturnType<typeof harness>>, query = 'needle') {
  act(() => { rendered.result.current.setSearchMode('conversations'); rendered.result.current.setSearchFilter(query); });
  await act(async () => { await vi.advanceTimersByTimeAsync(300); await flush(); });
}

beforeEach(async () => {
  vi.resetModules(); vi.useFakeTimers(); localStorage.clear(); sessionStorage.clear();
  auth = await import('@/shared/authToken'); await auth.initializeAuthSession();
  const expected = await auth.startAuthSession(token()); auth.acknowledgeAuthSession(expected!);
  const { api } = await import('@/shared/api');
  vi.spyOn(api, 'archivedProjects').mockImplementation(async () => Response.json({ data: { projects: [] } }));
  vi.spyOn(api, 'getArchivedSessions').mockImplementation(async () => Response.json({ data: { sessions: [] } }));
  vi.spyOn(api, 'recentConversations').mockImplementation(async () => Response.json({ data: { conversations: [], total: 0, hasMore: false } }));
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

test('sidebar preserves title-results, result, progress and done from header-auth SSE', async () => {
  const stream = wire(); const fetcher = vi.fn(async () => stream.response); vi.stubGlobal('fetch', fetcher);
  const rendered = await harness(); await search(rendered);
  expect(rendered.result.current.isSearching).toBe(true);
  const titleResults = [{ sessionId: 'title-match', sessionTitle: 'Needle' }];
  await act(async () => { stream.event('title-results', { titleResults }); stream.event('result', {
    projectResult, totalMatches: 2, scannedProjects: 1, totalProjects: 3,
  }); await flush(); });
  expect(rendered.result.current.conversationResults).toEqual({ results: [projectResult], titleResults, totalMatches: 2, query: 'needle' });
  expect(rendered.result.current.searchProgress).toEqual({ scannedProjects: 1, totalProjects: 3 });
  await act(async () => { stream.event('progress', { totalMatches: 2, scannedProjects: 3, totalProjects: 3 }); await flush(); });
  expect(rendered.result.current.searchProgress).toEqual({ scannedProjects: 3, totalProjects: 3 });
  await act(async () => { stream.event('done', {}); await flush(); });
  expect(rendered.result.current.isSearching).toBe(false); expect(rendered.result.current.searchProgress).toBeNull();
  expect(rendered.result.current.conversationResults?.totalMatches).toBe(2); expect(stream.cancel).toHaveBeenCalledTimes(1);
  const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
  expect(url).not.toContain(auth.getAuthSessionSnapshot().token); expect(new Headers(init.headers).get('Authorization')).toBe('Bearer ' + auth.getAuthSessionSnapshot().token);
});

test.each(['error-event', 'http401'])('%s releases searching/progress and keeps only this search partial results', async mode => {
  const stream = wire(); const fetcher = vi.fn(async () => mode === 'http401'
    ? new Response(stream.response.body, { status: 401 }) : stream.response);
  vi.stubGlobal('fetch', fetcher); const rendered = await harness(); await search(rendered);
  if (mode === 'error-event') await act(async () => {
    stream.event('result', { projectResult, totalMatches: 1, scannedProjects: 1, totalProjects: 2 }); stream.event('error', { error: 'Search failed' }); await flush();
  });
  expect(rendered.result.current.isSearching).toBe(false); expect(rendered.result.current.searchProgress).toBeNull();
  expect(rendered.result.current.conversationResults?.results).toEqual(mode === 'error-event' ? [projectResult] : []);
  expect(stream.cancel).toHaveBeenCalledTimes(1); expect(fetcher).toHaveBeenCalledTimes(1);
});

test.each(['clear', 'query', 'mode', 'unmount'])('%s stops the live reader and invalidates pending results immediately', async mode => {
  const stream = wire(); const fetcher = vi.fn(async () => stream.response); vi.stubGlobal('fetch', fetcher);
  const rendered = await harness(); await search(rendered);
  await act(async () => { stream.event('result', { projectResult, totalMatches: 1 }); await flush(); });
  expect(rendered.result.current.conversationResults?.results).toHaveLength(1);
  if (mode === 'unmount') rendered.unmount();
  else act(() => {
    if (mode === 'clear') rendered.result.current.clearConversationResults();
    else if (mode === 'query') rendered.result.current.setSearchFilter('next query');
    else rendered.result.current.setSearchMode('projects');
  });
  await act(flush); expect(stream.cancel).toHaveBeenCalledTimes(1);
  expect(((fetcher.mock.calls[0] as unknown as [string, RequestInit])[1].signal)?.aborted).toBe(true);
  if (mode !== 'unmount') { expect(rendered.result.current.conversationResults).toBeNull(); expect(rendered.result.current.isSearching).toBe(false); }
});

test('account switch clears visible rows/progress and the old sidebar cannot start a replacement account search', async () => {
  const stream = wire(); const fetcher = vi.fn(async () => stream.response); vi.stubGlobal('fetch', fetcher);
  const rendered = await harness(); await search(rendered);
  await act(async () => { stream.event('result', { projectResult, totalMatches: 1, scannedProjects: 1, totalProjects: 2 }); await flush(); });
  expect(rendered.result.current.conversationResults?.results).toHaveLength(1);
  await act(async () => { const expected = await auth.startAuthSession(token('bob')); auth.acknowledgeAuthSession(expected!); await flush(); });
  expect(stream.cancel).toHaveBeenCalledTimes(1); expect(rendered.result.current.conversationResults).toBeNull();
  expect(rendered.result.current.searchProgress).toBeNull(); expect(rendered.result.current.isSearching).toBe(false);
  act(() => rendered.result.current.setSearchFilter('bob query'));
  await act(async () => { await vi.advanceTimersByTimeAsync(300); await flush(); }); expect(fetcher).toHaveBeenCalledTimes(1);
});

test('unmount while headers are pending aborts synchronously and releases a late response body', async () => {
  let resolve!: (response: Response) => void; const response = new Promise<Response>(done => { resolve = done; });
  const stream = wire(); const fetcher = vi.fn(() => response); vi.stubGlobal('fetch', fetcher);
  const rendered = await harness(); await search(rendered); rendered.unmount();
  expect(((fetcher.mock.calls[0] as unknown as [string, RequestInit])[1].signal)?.aborted).toBe(true);
  await act(async () => { resolve(stream.response); await flush(); }); expect(stream.cancel).toHaveBeenCalledTimes(1);
});
