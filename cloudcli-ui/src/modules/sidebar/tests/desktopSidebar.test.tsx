import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';
import i18next from 'i18next';

import SidebarHeader from '@/modules/sidebar/SidebarHeader';
import SidebarRecentConversations from '@/modules/sidebar/SidebarRecentConversations';
import type { SessionRowActions } from '@/shared/types';
import zhSidebar from '@/modules/i18n/locales/zh-CN/sidebar.json';

const runtime = vi.hoisted(() => ({ desktop: true }));
vi.mock('@/shared/chisa', () => ({ isDesktop: () => runtime.desktop }));
vi.mock('@/shared/hooks/useProviderCapabilities', () => ({ useSessionForkingProviders: () => new Set(['claude', 'codex']) }));
vi.mock('@/modules/sidebar/hooks/useProviderSessionIdCopy', () => ({
  useProviderSessionIdCopy: () => ({ copyState: 'idle', copyLabel: 'Copy ID', setOptionsOpen: () => {}, handleCopyAction: () => {}, isCopyPending: false, CopyStateIcon: () => null }),
}));
const language = i18next.createInstance();
await language.init({ lng: 'zh-CN', resources: { 'zh-CN': { sidebar: zhSidebar } }, defaultNS: 'sidebar', interpolation: { escapeValue: false } });
const t = language.t.bind(language);
const noop = () => {};

beforeEach(() => { runtime.desktop = true; localStorage.clear(); });

function renderHeader(isMobile = false) {
  const newSession = vi.fn();
  const createProject = vi.fn();
  const modeChange = vi.fn();
  const searchChange = vi.fn();
  const view = render(<SidebarHeader isPWA={false} isMobile={isMobile} isLoading={false} projectsCount={0}
    runningSessionsCount={0} archivedSessionsCount={0} isArchivedSessionsLoading={false}
    searchFilter="" onSearchFilterChange={searchChange} onClearSearchFilter={noop}
    searchMode="conversations" onSearchModeChange={modeChange} onRefresh={noop} isRefreshing={false}
    onCreateProject={createProject} onNewSession={newSession} onCollapseSidebar={noop} t={t} />);
  return { ...view, newSession, createProject, modeChange, searchChange };
}

test('desktop compose shortcut and navigation preserve real handlers even in an empty rail', () => {
  const actions = renderHeader();
  fireEvent.click(screen.getByRole('button', { name: /新建会话/ }));
  fireEvent.keyDown(window, { key: 'n', code: 'KeyN', ctrlKey: true, altKey: true });
  expect(actions.newSession).toHaveBeenCalledTimes(2);
  expect(actions.createProject).not.toHaveBeenCalled();
  expect(screen.getByText('Ctrl Alt N')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '项目' }));
  expect(actions.modeChange).toHaveBeenCalledWith('projects');
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'workspace' } });
  expect(actions.searchChange).toHaveBeenCalledWith('workspace');
  actions.unmount();
  fireEvent.keyDown(window, { key: 'n', code: 'KeyN', ctrlKey: true, altKey: true });
  expect(actions.newSession).toHaveBeenCalledTimes(2);
});

test.each(['browser', 'mobile'])('%s keeps existing header behavior without native shortcuts', (environment) => {
  runtime.desktop = environment !== 'browser';
  const actions = renderHeader(environment === 'mobile');
  expect(screen.queryByRole('searchbox')).toBeNull();
  expect(screen.queryByText('Ctrl Alt N')).toBeNull();
  fireEvent.keyDown(window, { key: 'n', code: 'KeyN', ctrlKey: true, altKey: true });
  expect(actions.newSession).not.toHaveBeenCalled();
});

test('desktop hover options open the existing menu and archive the selected conversation', () => {
  const archive = vi.fn();
  const select = vi.fn();
  const actions: SessionRowActions = {
    activeRename: null, activeSessions: new Set(), attentionSessionIds: new Set(),
    onRenameDraftChange: noop, onStartEditingSession: noop, onCancelEditingSession: noop,
    onSaveEditingSession: noop, onDeleteSession: noop, onArchiveSession: archive,
  };
  render(<SidebarRecentConversations conversations={[{ sessionId: 's1', provider: 'claude', projectId: 'p1', projectDisplayName: 'Project', sessionTitle: 'Test conversation', lastActivity: null }]}
    total={1} hasMore={false} isLoading={false} isLoadingMore={false} hasError={false} selectedSession={null}
    currentTime={new Date()} sessionActions={actions} onConversationSelect={select} onLoadMore={noop} onRetry={noop} t={t} />);
  fireEvent.click(screen.getByRole('button', { name: /Test conversation/ }));
  expect(screen.getByRole('menuitem', { name: '重命名对话' })).toBeTruthy();
  fireEvent.click(screen.getByRole('menuitem', { name: '归档对话' }));
  expect(archive).toHaveBeenCalledWith('s1');
  expect(select).not.toHaveBeenCalled();
});
