import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';
import i18next from 'i18next';

import SidebarFooter from '@/modules/sidebar/SidebarFooter';
import SidebarHeader from '@/modules/sidebar/SidebarHeader';
import SidebarRecentConversations from '@/modules/sidebar/SidebarRecentConversations';
import { i18n } from '@/modules/i18n';
import { api } from '@/shared/api';
import type { SessionRowActions } from '@/shared/types';
import zhSidebar from '@/modules/i18n/locales/zh-CN/sidebar.json';

const runtime = vi.hoisted(() => ({ desktop: true }));
const footerActions = vi.hoisted(() => ({ logout: vi.fn(), openAccounts: vi.fn(), refresh: vi.fn() }));
vi.mock('@/modules/auth/context/AuthContext', () => ({ useAuth: () => ({ user: { id: 1, username: 'ayase' }, logout: footerActions.logout }) }));
vi.mock('@/modules/claude-accounts/context/ClaudeAccountsContext', () => ({
  useOptionalClaudeAccounts: () => ({ snapshot: null, loading: true, error: null }),
  useClaudeAccounts: () => ({ snapshot: null, loading: true, refreshing: false, busy: false, error: null, login: null, loginError: null, loginBusy: false, openAccounts: footerActions.openAccounts, refresh: footerActions.refresh }),
}));
vi.mock('@/modules/plugins', () => ({ ClaudeUsageContent: () => null }));
vi.mock('@/shared/chisa', () => ({ isDesktop: () => runtime.desktop }));
vi.mock('@/shared/hooks/useProviderCapabilities', () => ({ useSessionForkingProviders: () => new Set(['claude', 'codex']) }));
vi.mock('@/modules/sidebar/hooks/useProviderSessionIdCopy', () => ({
  useProviderSessionIdCopy: () => ({ copyState: 'idle', copyLabel: 'Copy ID', setOptionsOpen: () => {}, handleCopyAction: () => {}, isCopyPending: false, CopyStateIcon: () => null }),
}));
const language = i18next.createInstance();
await language.init({ lng: 'zh-CN', resources: { 'zh-CN': { sidebar: zhSidebar } }, defaultNS: 'sidebar', interpolation: { escapeValue: false } });
const t = language.t.bind(language);
const noop = () => {};

beforeEach(() => { runtime.desktop = true; localStorage.clear(); vi.clearAllMocks(); });

test('the compact footer retains provider access, loading text and every account action', async () => {
  vi.spyOn(api.user, 'savePreferences').mockResolvedValue(Response.json({ success: true }));
  await i18n.changeLanguage('zh-CN');
  const settings = vi.fn();
  const { container } = render(<SidebarFooter onShowSettings={settings} t={t} />);
  const quotaTrigger = screen.getByRole('button', { name: '打开 Claude 账号与额度' });
  const accountTrigger = screen.getByRole('button', { name: '账户菜单：ayase' });
  expect(container.querySelector('.sidebar-account-quota')?.contains(quotaTrigger)).toBe(true);
  expect(container.querySelector('.sidebar-account-profile')?.contains(accountTrigger)).toBe(true);
  expect(quotaTrigger.textContent).toContain(i18n.t('claudeAccounts.loadingUsage', { ns: 'settings' }));
  expect(quotaTrigger.textContent).not.toContain('0%');
  expect(screen.queryByText(/ChisaCloudCode v/)).toBeNull();

  quotaTrigger.focus();
  fireEvent.click(quotaTrigger);
  expect(screen.getByRole('dialog', { name: 'Claude 账号与额度' })).toBeTruthy();
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(document.activeElement).toBe(quotaTrigger);

  fireEvent.click(accountTrigger);
  fireEvent.click(screen.getByRole('menuitem', { name: /ayase/ }));
  expect(screen.getByRole('dialog', { name: '账户资料' })).toBeTruthy();
  fireEvent.keyDown(document, { key: 'Escape' });

  fireEvent.click(accountTrigger);
  fireEvent.click(screen.getByRole('menuitem', { name: '使用情况' }));
  expect(screen.getByRole('dialog', { name: '使用情况' })).toBeTruthy();
  fireEvent.keyDown(document, { key: 'Escape' });

  fireEvent.click(accountTrigger);
  fireEvent.click(screen.getByRole('menuitem', { name: '设置' }));
  expect(settings).toHaveBeenCalledOnce();
  fireEvent.click(accountTrigger);
  fireEvent.click(screen.getByRole('menuitem', { name: '退出登录' }));
  expect(footerActions.logout).toHaveBeenCalledOnce();
});

function renderHeader(isMobile = false, isRefreshing = false) {
  const newSession = vi.fn();
  const createProject = vi.fn();
  const modeChange = vi.fn();
  const searchChange = vi.fn();
  const refresh = vi.fn();
  const view = render(<SidebarHeader isPWA={false} isMobile={isMobile} isLoading={false} projectsCount={0}
    runningSessionsCount={0} archivedSessionsCount={0} isArchivedSessionsLoading={false}
    searchFilter="" onSearchFilterChange={searchChange} onClearSearchFilter={noop}
    searchMode="conversations" onSearchModeChange={modeChange} onRefresh={refresh} isRefreshing={isRefreshing}
    onCreateProject={createProject} onNewSession={newSession} onCollapseSidebar={noop} t={t} />);
  return { ...view, newSession, createProject, modeChange, searchChange, refresh };
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

test('desktop recents overflow retains running, archive, refresh and create actions', () => {
  const actions = renderHeader();
  const openMenu = () => fireEvent.click(screen.getByRole('button', { name: '工作目录操作' }));
  expect(screen.queryByRole('button', { name: '运行中的会话' })).toBeNull();
  openMenu();
  fireEvent.click(screen.getByRole('menuitem', { name: '运行中的会话' }));
  expect(actions.modeChange).toHaveBeenCalledWith('running');
  openMenu();
  fireEvent.click(screen.getByRole('menuitem', { name: '归档' }));
  expect(actions.modeChange).toHaveBeenCalledWith('archived');
  openMenu();
  fireEvent.click(screen.getByRole('menuitem', { name: /刷新项目和会话/ }));
  expect(actions.refresh).toHaveBeenCalledOnce();
  openMenu();
  fireEvent.click(screen.getByRole('menuitem', { name: '创建新项目' }));
  expect(actions.createProject).toHaveBeenCalledOnce();
});

test('desktop recents overflow preserves disabled refresh and Escape focus return', () => {
  const actions = renderHeader(false, true);
  const trigger = screen.getByRole('button', { name: '工作目录操作' });
  fireEvent.click(trigger);
  const refresh = screen.getByRole('menuitem', { name: /刷新项目和会话/ }) as HTMLButtonElement;
  expect(refresh.disabled).toBe(true);
  fireEvent.click(refresh);
  expect(actions.refresh).not.toHaveBeenCalled();
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(screen.queryByRole('menu')).toBeNull();
  expect(document.activeElement).toBe(trigger);
});

function renderEmptyRecents({ hasError = false, isMobile = false } = {}) {
  const retry = vi.fn();
  const actions: SessionRowActions = {
    activeRename: null, activeSessions: new Set(), attentionSessionIds: new Set(),
    onRenameDraftChange: noop, onStartEditingSession: noop, onCancelEditingSession: noop,
    onSaveEditingSession: noop, onDeleteSession: noop,
  };
  const view = render(<SidebarRecentConversations isMobile={isMobile} conversations={[]}
    total={0} hasMore={false} isLoading={false} isLoadingMore={false} hasError={hasError} selectedSession={null}
    currentTime={new Date()} sessionActions={actions} onConversationSelect={noop} onLoadMore={noop} onRetry={retry} t={t} />);
  return { ...view, retry };
}

test('desktop empty recents renders one helper without the illustration or redundant title', () => {
  const { container } = renderEmptyRecents();
  expect(container.querySelector('.sidebar-recents-empty p')?.textContent).toBe(t('recent.desktopEmptyDescription', 'Start a new conversation to see it here.'));
  expect(screen.queryByText('暂无对话')).toBeNull();
  expect(container.querySelector('svg')).toBeNull();
});

test.each(['browser', 'mobile'])('%s retains the existing empty recents presentation', (environment) => {
  runtime.desktop = environment !== 'browser';
  const { container } = renderEmptyRecents({ isMobile: environment === 'mobile' });
  expect(screen.getByText('暂无对话')).toBeTruthy();
  expect(container.querySelector('svg')).toBeTruthy();
});

test('desktop recents errors retain a working retry action', () => {
  const { retry } = renderEmptyRecents({ hasError: true });
  expect(screen.getByText('加载最近对话失败')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
  expect(retry).toHaveBeenCalledOnce();
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
