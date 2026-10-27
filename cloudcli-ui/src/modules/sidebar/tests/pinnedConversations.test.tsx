import { render, screen } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';
import i18next from 'i18next';

import SidebarRecentConversations from '@/modules/sidebar/SidebarRecentConversations';
import type { SessionRowActions } from '@/shared/types';
import zhSidebar from '@/modules/i18n/locales/zh-CN/sidebar.json';

vi.mock('@/shared/chisa', () => ({ isDesktop: () => true }));
vi.mock('@/shared/hooks/useProviderCapabilities', () => ({ useSessionForkingProviders: () => new Set(['claude']) }));
vi.mock('@/modules/sidebar/hooks/useProviderSessionIdCopy', () => ({
  useProviderSessionIdCopy: () => ({
    copyState: 'idle',
    copyLabel: 'Copy ID',
    setOptionsOpen: () => {},
    handleCopyAction: () => {},
    isCopyPending: false,
    CopyStateIcon: () => null,
  }),
}));

const language = i18next.createInstance();
await language.init({
  lng: 'zh-CN',
  resources: { 'zh-CN': { sidebar: zhSidebar } },
  defaultNS: 'sidebar',
  interpolation: { escapeValue: false },
});
const t = language.t.bind(language);
const noop = () => {};

beforeEach(() => localStorage.clear());

test('a pinned conversation outside the loaded page remains visible', () => {
  const actions: SessionRowActions = {
    activeRename: null,
    activeSessions: new Set(),
    attentionSessionIds: new Set(),
    onRenameDraftChange: noop,
    onStartEditingSession: noop,
    onCancelEditingSession: noop,
    onSaveEditingSession: noop,
    onDeleteSession: noop,
    onArchiveSession: noop,
  };

  render(
    <SidebarRecentConversations
      conversations={[{
        sessionId: 'recent-session',
        provider: 'claude',
        projectId: 'project-1',
        projectDisplayName: 'Project',
        sessionTitle: 'Recent conversation',
        lastActivity: null,
      }]}
      pinnedConversations={[{
        sessionId: 'old-pinned-session',
        provider: 'claude',
        projectId: 'project-1',
        projectDisplayName: 'Project',
        sessionTitle: 'Old pinned conversation',
        lastActivity: null,
      }]}
      total={2}
      hasMore
      isLoading={false}
      isLoadingMore={false}
      hasError={false}
      selectedSession={null}
      currentTime={new Date()}
      sessionActions={actions}
      onConversationSelect={noop}
      onLoadMore={noop}
      onRetry={noop}
      t={t}
    />,
  );

  expect(screen.getByText('Old pinned conversation')).toBeTruthy();
  expect(screen.getByText('Recent conversation')).toBeTruthy();
});
