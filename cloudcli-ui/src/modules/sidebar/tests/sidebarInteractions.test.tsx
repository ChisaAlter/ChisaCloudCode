import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';
import i18next from 'i18next';
import { I18nextProvider } from 'react-i18next';

import SidebarProjectItem from '@/modules/sidebar/SidebarProjectItem';
import SidebarProjectSessions from '@/modules/sidebar/SidebarProjectSessions';
import SessionOptions from '@/modules/sidebar/SessionOptions';
import { UiPreferencesProvider, useSetUiPreference } from '@/shared/context/UiPreferencesContext';
import { readUserPreference, resetUserPreferences } from '@/shared/userSettings';
import { api } from '@/shared/api';
import type { Project, SessionWithProvider } from '@/shared/types';
import zhSidebar from '@/modules/i18n/locales/zh-CN/sidebar.json';

vi.mock('@/shared/hooks/useProviderCapabilities', () => ({ useSessionForkingProviders: () => new Set(['claude', 'codex']) }));
vi.mock('@/modules/sidebar/hooks/useCompactSidebar', () => ({ useCompactSidebar: () => false }));

const language = i18next.createInstance();
await language.init({ lng: 'zh-CN', resources: { 'zh-CN': { sidebar: zhSidebar } }, defaultNS: 'sidebar', interpolation: { escapeValue: false } });
const t = language.t.bind(language);
const noop = () => {};
const project = { projectId: 'p', displayName: 'ChisaCloudCode', fullPath: '/work/ChisaCloudCode' } as Project;
const sessions: SessionWithProvider[] = [
  { id: 'first', summary: '第一条对话', __provider: 'claude' },
  { id: 'second', summary: '第二条对话', __provider: 'codex' },
];
const callbacks = { onRenameDraftChange: noop, onStartEditingSession: vi.fn(), onCancelEditingSession: noop,
  onSaveEditingSession: noop, onProjectSelect: noop, onSessionSelect: vi.fn(), onDeleteSession: vi.fn(), onArchiveSession: vi.fn() };

beforeEach(() => {
  resetUserPreferences(); localStorage.clear(); vi.clearAllMocks();
  vi.spyOn(api, 'providerSessionId').mockResolvedValue(new Response(JSON.stringify({ data: { sessionId: 'provider-id' } })));
  vi.spyOn(api.user, 'savePreferences').mockResolvedValue(new Response('{}'));
});

test('directory menu owns rename/remove and only the header creates a conversation', () => {
  const create = vi.fn(); const rename = vi.fn(); const toggle = vi.fn();
  render(<I18nextProvider i18n={language}><SidebarProjectItem project={project} selectedProject={project} selectedSession={null}
    isExpanded isDeleting={false} isStarred={false} isEditing={false} renameDraft="" sessions={[]}
    initialSessionsLoaded isLoadingMoreSessions={false} activeSessions={new Set()} attentionSessionIds={new Set()}
    currentTime={new Date()} sessionRenameId={null} sessionRenameDraft=""
    tasksEnabled={false} mcpServerStatus={{}} onToggleProject={toggle} onToggleStarProject={noop}
    onStartEditingProject={rename} onCancelEditingProject={noop} onSaveProjectName={noop} onDeleteProject={noop}
    onLoadMoreSessions={noop} onNewSession={create} {...callbacks} t={t} /></I18nextProvider>);
  expect(screen.queryByRole('button', { name: '新建会话' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '在当前目录新建对话' }));
  expect(create).toHaveBeenCalledWith(project); expect(toggle).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '工作目录操作' }));
  expect(screen.getByRole('menuitem', { name: '移除项目' })).toBeTruthy();
  fireEvent.click(screen.getByRole('menuitem', { name: '重命名项目' }));
  expect(rename).toHaveBeenCalledWith(project); expect(toggle).not.toHaveBeenCalled();
});

test('right click opens a translated menu at the row, Escape returns focus, archive acts directly', async () => {
  render(<I18nextProvider i18n={language}><div data-session-row><a href="/session/first">第一条对话</a>
    <SessionOptions sessionId="first" sessionName="第一条对话" provider="claude" projectId="p" isProcessing={false} isEditing={false}
      renameDraft="" onFork={noop} {...callbacks} t={t} /></div></I18nextProvider>);
  expect(screen.queryByRole('button', { name: /对话操作/ })).toBeNull();
  fireEvent.contextMenu(screen.getByRole('link'), { clientX: 150, clientY: 80 });
  expect(screen.getByRole('menu').style.left).toBe('150px');
  await waitFor(() => expect(screen.getByRole('menuitem', { name: '复制 Claude 对话 ID' })).toBeTruthy());
  expect(screen.getByRole('menuitem', { name: /派生对话/ })).toBeTruthy();
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(screen.queryByRole('menu')).toBeNull(); expect(document.activeElement).toBe(screen.getByRole('link'));
  fireEvent.keyDown(screen.getByRole('link'), { key: 'F10', shiftKey: true });
  fireEvent.click(screen.getByRole('menuitem', { name: '归档对话' }));
  expect(callbacks.onArchiveSession).toHaveBeenCalledWith('first'); expect(callbacks.onDeleteSession).not.toHaveBeenCalled();
});

test('pin sorts loaded conversations, persists across remount and survives a UI preference toggle', async () => {
  function ToggleThinking() {
    const set = useSetUiPreference();
    return <button onClick={() => set('showThinking', false)}>切换思考</button>;
  }
  const view = <I18nextProvider i18n={language}><UiPreferencesProvider><ToggleThinking /><SidebarProjectSessions project={project}
    isExpanded sessions={sessions} selectedSession={null} initialSessionsLoaded hasMoreSessions={false} isLoadingMoreSessions={false}
    activeSessions={new Set()} attentionSessionIds={new Set()} currentTime={new Date()} sessionRenameId={null} sessionRenameDraft=""
    onLoadMoreSessions={noop} {...callbacks} t={t} /></UiPreferencesProvider></I18nextProvider>;
  const mounted = render(view);
  fireEvent.click(screen.getAllByRole('button', { name: '置顶对话' })[1]);
  expect(screen.getAllByRole('link')[0].textContent).toContain('第二条对话');
  fireEvent.click(screen.getByRole('button', { name: '切换思考' }));
  expect(readUserPreference<Record<string, unknown>>('uiPreferences', {}).pinnedSessionIds).toEqual(['second']);
  mounted.unmount(); render(view);
  expect(screen.getAllByRole('link')[0].textContent).toContain('第二条对话');
  fireEvent.click(screen.getByRole('button', { name: '取消置顶' }));
  expect(screen.getAllByRole('link')[0].textContent).toContain('第一条对话');
});

test('a running conversation can be pinned but does not expose archive/delete', () => {
  render(<I18nextProvider i18n={language}><div data-session-row><a href="/session/first">第一条对话</a>
    <SessionOptions sessionId="first" sessionName="第一条对话" provider="claude" projectId="p" isProcessing isEditing={false}
      renameDraft="" {...callbacks} t={t} /></div></I18nextProvider>);
  fireEvent.contextMenu(screen.getByRole('link'));
  expect(screen.getByRole('menuitem', { name: '置顶对话' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: '归档对话' })).toBeNull();
  expect(screen.queryByRole('menuitem', { name: '归档或删除对话' })).toBeNull();
});
