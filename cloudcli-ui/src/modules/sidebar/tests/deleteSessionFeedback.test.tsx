import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import i18next from 'i18next';
import { useEffect } from 'react';
import type { ComponentProps } from 'react';

import type * as AuthTokenModule from '@/shared/authToken';
import type * as ChisaModule from '@/shared/chisa';
import { useSidebarController } from '@/modules/sidebar/hooks/useSidebarController';
import SidebarModals from '@/modules/sidebar/SidebarModals';
import SidebarContent from '@/modules/sidebar/SidebarContent';
import { api } from '@/shared/api';
import type { Project } from '@/shared/types';
import zhSidebar from '@/modules/i18n/locales/zh-CN/sidebar.json';

const runtime = vi.hoisted(() => ({ auth: 1, server: 1 }));
vi.mock('@/shared/authToken', async importOriginal => ({ ...await importOriginal<typeof AuthTokenModule>(), getAuthSessionVersion: () => runtime.auth }));
vi.mock('@/shared/chisa', async importOriginal => ({ ...await importOriginal<typeof ChisaModule>(), getServerConnectionVersion: () => runtime.server, isDesktop: () => true }));
vi.mock('@/modules/command-palette', () => ({ usePaletteOps: () => ({ refreshProjects: () => {} }) }));
vi.mock('@/modules/settings', () => ({ Settings: () => null }));
vi.mock('@/modules/project-creation-wizard', () => ({ ProjectCreationWizard: () => null }));
vi.mock('@/modules/sidebar/SidebarHeader', () => ({ default: () => <div data-testid="sidebar-header" /> }));
vi.mock('@/modules/sidebar/SidebarFooter', () => ({ default: () => null }));
vi.mock('@/modules/sidebar/SidebarProjectList', () => ({ default: () => <div data-testid="sidebar-items" /> }));
vi.mock('@/modules/sidebar/SidebarRecentConversations', () => ({ default: () => <div data-testid="sidebar-items" /> }));

const language = i18next.createInstance();
await language.init({ lng: 'zh-CN', resources: { 'zh-CN': { sidebar: zhSidebar } }, defaultNS: 'sidebar', interpolation: { escapeValue: false } });
const t = language.t.bind(language);
const selectedProject: Project = { projectId: 'selected-project', fullPath: '/selected', displayName: 'Selected project' };
const targetProject: Project = { projectId: 'row-project', fullPath: '/row', displayName: 'Row project' };
const projects = [selectedProject, targetProject];
const noop = () => {};
let controller: ReturnType<typeof useSidebarController>;
const deleted = vi.fn();
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function Harness({ onDeleted = deleted }: { onDeleted?: (id: string) => void }) {
  const state = useSidebarController({ projects, selectedProject, selectedSession: { id: 'selected-session' },
    activeSessions: new Set(), isLoading: false, isMobile: false, t, onRefresh: noop, onProjectSelect: noop, onSessionSelect: noop,
    onSessionDelete: onDeleted, setCurrentProject: noop, setSidebarVisible: noop, sidebarVisible: true });
  useEffect(() => { controller = state; }, [state]);
  return <>
    <button onClick={() => controller.showDeleteSessionConfirmation('row-session', 'Row session')}>delete-row</button>
    <button onClick={() => controller.archiveSession('row-session')}>archive-row</button>
    <output data-testid="recent-total">{state.recentConversationsTotal}</output>
    <output data-testid="recent-ids">{state.recentConversations.map(row => row.sessionId).join(',')}</output>
    <output data-testid="pinned-ids">{state.pinnedConversations.map(row => row.sessionId).join(',')}</output>
    <SidebarModals projects={[selectedProject, targetProject]} showSettings={false} settingsInitialTab="general" onCloseSettings={noop}
      showNewProject={false} onCloseNewProject={noop} onProjectCreated={noop} pendingDeletion={state.pendingDeletion}
      isDeleting={state.isDeleting} deletionError={state.deletionError} onCancelDeletion={state.cancelDeletion}
      onConfirmDeleteProject={state.confirmDeleteProject} onConfirmDeleteSession={state.confirmDeleteSession} t={t} />
    <SidebarContent isPWA={false} isMobile={false} isLoading={false} projects={[selectedProject, targetProject]} runningSessionsCount={0}
      archivedProjects={[]} archivedSessions={[]} archivedSessionsCount={0} isArchivedSessionsLoading={false}
      recentConversations={[]} pinnedConversations={[]} recentConversationsTotal={0} recentConversationsHasMore={false}
      isRecentConversationsLoading={false} isLoadingMoreRecentConversations={false} recentConversationsError={false}
      sidebarError={state.sidebarError} onDismissSidebarError={state.dismissSidebarError}
      searchFilter="" onSearchFilterChange={noop} onClearSearchFilter={noop} searchMode="conversations" onSearchModeChange={noop}
      conversationResults={null} isSearching={false} searchProgress={null} onRestoreArchivedProject={noop} onLoadMoreRecentConversations={noop}
      onRetryRecentConversations={noop} onArchivedSessionClick={noop} onRestoreArchivedSession={noop} onDeleteArchivedSession={noop}
      onConversationResultClick={noop} onRefresh={noop} isRefreshing={false} onCreateProject={noop} onCollapseSidebar={noop} onShowSettings={noop}
      projectListProps={{ activeRename: null, selectedProject: null } as ComponentProps<typeof SidebarContent>['projectListProps']} t={t} />
  </>;
}
function busyResponse() { return Response.json({ success: false, error: { code: 'WORKSPACE_BUSY', message: '工作区正在处理任务，请稍后重试。' } }, { status: 409 }); }

beforeEach(() => {
  runtime.auth = 1; runtime.server = 1; deleted.mockReset();
  vi.spyOn(window, 'alert').mockImplementation(noop);
  vi.spyOn(api, 'archivedProjects').mockImplementation(async () => Response.json({ data: { projects: [] } }));
  vi.spyOn(api, 'getArchivedSessions').mockImplementation(async () => Response.json({ data: { sessions: [] } }));
  vi.spyOn(api, 'recentConversations').mockImplementation(async () => Response.json({ data: { conversations: [{ sessionId: 'row-session' }], pinned: [{ sessionId: 'row-session' }], total: 3, hasMore: false } }));
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

test('a structured API failure remains in confirmation and retry deletes the row session without a native alert', async () => {
  const first = deferred<Response>();
  const request = vi.spyOn(globalThis, 'fetch').mockReturnValueOnce(first.promise).mockResolvedValueOnce(Response.json({ success: true }));
  render(<Harness />);
  await waitFor(() => expect(screen.getByTestId('recent-total').textContent).toBe('3'));
  fireEvent.click(screen.getByRole('button', { name: 'delete-row' }));
  const dialog = screen.getByRole('dialog');
  const confirm = within(dialog).getByRole<HTMLButtonElement>('button', { name: '永久删除' });
  fireEvent.click(confirm);
  fireEvent.click(confirm);
  await act(async () => { await controller.confirmDeleteSession(true); controller.cancelDeletion(); });
  fireEvent.click(within(dialog).getByRole('button', { name: '取消' }));
  fireEvent.keyDown(document, { key: 'Escape' });
  const backdrop = dialog.parentElement?.firstElementChild;
  if (backdrop) fireEvent.click(backdrop);
  expect(screen.getByRole('dialog')).toBe(dialog);
  expect(confirm.disabled).toBe(true);
  expect(request).toHaveBeenCalledTimes(1);
  expect(String(request.mock.calls[0][0])).toBe('/api/providers/sessions/row-session?force=true');
  await act(async () => { first.resolve(busyResponse()); });
  expect(within(dialog).getByRole('alert').textContent).toContain('工作区正在处理任务，请稍后重试。 (WORKSPACE_BUSY)');
  expect(confirm.disabled).toBe(false);
  expect(deleted).not.toHaveBeenCalled();
  expect(screen.getByTestId('recent-ids').textContent).toContain('row-session');
  fireEvent.click(confirm);
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(deleted).toHaveBeenCalledExactlyOnceWith('row-session');
  expect(screen.getByTestId('recent-ids').textContent).toBe('');
  expect(screen.getByTestId('pinned-ids').textContent).toBe('');
  expect(screen.getByTestId('recent-total').textContent).toBe('2');
  expect(request).toHaveBeenCalledTimes(2);
  expect(window.alert).not.toHaveBeenCalled();
});

test('invalid JSON keeps confirmation retryable with a local error instead of leaking the response body', async () => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('<html>private upstream error</html>', { status: 502 }));
  render(<Harness />);
  fireEvent.click(screen.getByRole('button', { name: 'delete-row' }));
  fireEvent.click(screen.getByRole('button', { name: '永久删除' }));
  const error = await screen.findByRole('alert');
  expect(error.textContent).toBe(t('messages.deleteSessionFailed'));
  expect(error.textContent).not.toContain('private upstream');
  expect(screen.getByRole<HTMLButtonElement>('button', { name: '永久删除' }).disabled).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: '取消' }));
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(window.alert).not.toHaveBeenCalled();
});

test('direct archive errors appear above sidebar items without opening a confirmation', async () => {
  const request = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(busyResponse());
  render(<Harness />);
  fireEvent.click(screen.getByRole('button', { name: 'archive-row' }));
  const error = await screen.findByRole('alert');
  expect(error.textContent).toContain('WORKSPACE_BUSY');
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(error.compareDocumentPosition(screen.getByTestId('sidebar-items')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(String(request.mock.calls[0][0])).toBe('/api/providers/sessions/row-session');
  fireEvent.click(within(error).getByRole('button'));
  expect(screen.queryByRole('alert')).toBeNull();
  expect(deleted).not.toHaveBeenCalled();
  expect(window.alert).not.toHaveBeenCalled();
});

test('late response bodies from another account cannot delete rows, close confirmation or publish errors', async () => {
  const body = deferred<{ success: true }>();
  const response = Response.json({ success: true });
  vi.spyOn(response, 'json').mockReturnValueOnce(body.promise);
  vi.spyOn(api, 'deleteSession').mockResolvedValueOnce(response);
  render(<Harness />);
  fireEvent.click(screen.getByRole('button', { name: 'delete-row' }));
  let pending!: Promise<void>;
  act(() => { pending = controller.confirmDeleteSession(true); });
  await act(async () => {});
  runtime.auth += 1;
  await act(async () => { body.resolve({ success: true }); await pending; });
  expect(deleted).not.toHaveBeenCalled();
  expect(screen.getByRole('dialog')).toBeTruthy();
  expect(screen.queryByRole('alert')).toBeNull();
  expect(screen.getByRole<HTMLButtonElement>('button', { name: '永久删除' }).disabled).toBe(true);
  expect(window.alert).not.toHaveBeenCalled();
});

test('unmount aborts deletion and a late success cannot notify the previous account', async () => {
  const response = deferred<Response>();
  const remove = vi.spyOn(api, 'deleteSession').mockReturnValueOnce(response.promise);
  const view = render(<Harness />);
  let pending!: Promise<void>;
  act(() => { controller.showDeleteSessionConfirmation('row-session', 'Row session'); });
  act(() => { pending = controller.confirmDeleteSession(true); });
  const signal = remove.mock.calls[0][2]?.signal;
  view.unmount();
  expect(signal?.aborted).toBe(true);
  await act(async () => { response.resolve(Response.json({ success: true })); await pending; });
  expect(deleted).not.toHaveBeenCalled();
  expect(window.alert).not.toHaveBeenCalled();
});

test('successful deletion calls the latest selection callback after navigation during the request', async () => {
  const response = deferred<Response>();
  vi.spyOn(api, 'deleteSession').mockReturnValueOnce(response.promise);
  const previous = vi.fn(); const latest = vi.fn();
  const view = render(<Harness onDeleted={previous} />);
  act(() => { controller.showDeleteSessionConfirmation('row-session', 'Row session'); });
  let pending!: Promise<void>;
  act(() => { pending = controller.confirmDeleteSession(true); });
  view.rerender(<Harness onDeleted={latest} />);
  await act(async () => { response.resolve(Response.json({ success: true })); await pending; });
  expect(previous).not.toHaveBeenCalled();
  expect(latest).toHaveBeenCalledExactlyOnceWith('row-session');
});
