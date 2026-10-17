import assert from 'node:assert/strict';

import { createRef, useEffect } from 'react';
import type { ComponentProps } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { act, render, waitFor } from '@testing-library/react';
import { beforeEach, test, vi } from 'vitest';

import { AuthProvider, useAuth } from '@/modules/auth';
import { TranscriptExportDocument } from '@/modules/chat/export/TranscriptExportDocument';
import ChatMessagesPane from '@/modules/chat/transcript/ChatMessagesPane';
import MessageComponent from '@/modules/chat/transcript/MessageComponent';
import { UiPreferencesProvider } from '@/shared/context/UiPreferencesContext';
import type { AuthUserProfile, ChatMessage, DiffLine } from '@/shared/types';
import type * as UserSettings from '@/shared/userSettings';

const requests = vi.hoisted(() => ({ user: vi.fn(), updateProfile: vi.fn(), onboardingStatus: vi.fn() }));
vi.mock('@/shared/api', () => ({ api: { auth: requests, user: { onboardingStatus: requests.onboardingStatus } } }));
vi.mock('@/shared/chatDrafts', () => ({ hydrateChatDrafts: vi.fn(), resetChatDrafts: vi.fn() }));
vi.mock('@/shared/userSettings', async (importOriginal) => ({
  ...await importOriginal<typeof UserSettings>(),
  hydrateUserPreferences: vi.fn(),
  resetUserPreferences: vi.fn(),
}));

// Keep the real auth context, pane, message and avatar. Account dialogs and
// export controls do not participate in the live profile-to-transcript update.
vi.mock('@/modules/auth/AccountPopup', () => ({ AccountPopup: () => null }));
vi.mock('@/modules/auth/AccountMenu', () => ({ AccountMenu: () => null }));
vi.mock('@/modules/auth/ProtectedRoute', () => ({ default: () => null }));
vi.mock('@/modules/chat/transcript/ChatExportMenu', () => ({ default: () => null }));
vi.mock('@/modules/chat/transcript/ProviderSelectionEmptyState', () => ({ default: () => null }));
vi.mock('@/modules/chat/transcript/MessageSpeakControl', () => ({ default: () => null }));

const FIRST_AVATAR = 'data:image/png;base64,Zmlyc3Q=';
const SAVED_AVATAR = 'data:image/png;base64,c2F2ZWQ=';
const initialUser: AuthUserProfile = { id: 1, username: 'demo-user', displayName: 'Demo User', avatarDataUrl: FIRST_AVATAR };
const userMessage: ChatMessage = { type: 'user', content: 'Keep this existing turn', timestamp: '2026-10-06T07:00:00.000Z' };
const assistantMessage: ChatMessage = { type: 'assistant', content: 'Existing reply', timestamp: '2026-10-06T07:00:01.000Z' };
const messages = [userMessage, assistantMessage];
const createDiff = (): DiffLine[] => [];
const noop = () => {};
const paneProps: ComponentProps<typeof ChatMessagesPane> = {
  scrollContainerRef: createRef<HTMLDivElement>(),
  onWheel: noop,
  onTouchMove: noop,
  isLoadingSessionMessages: false,
  chatMessages: messages,
  selectedSession: { id: 'session-a' },
  currentSessionId: 'session-a',
  provider: 'claude',
  setProvider: noop,
  textareaRef: createRef<HTMLTextAreaElement>(),
  providerModels: { claude: 'test', cursor: 'test', codex: 'test', opencode: 'test' },
  setProviderModel: noop,
  providerModelCatalog: {},
  providerModelActions: { create: async () => {}, update: async () => {}, remove: async () => {} },
  providerModelsLoading: false,
  tasksEnabled: false,
  isTaskMasterInstalled: false,
  setInput: noop,
  isLoadingMoreMessages: false,
  hasMoreMessages: false,
  totalMessages: messages.length,
  sessionMessagesCount: messages.length,
  visibleMessageCount: messages.length,
  visibleMessages: messages,
  loadEarlierMessages: noop,
  loadAllMessages: noop,
  allMessagesLoaded: true,
  isLoadingAllMessages: false,
  loadAllJustFinished: false,
  showLoadAllOverlay: false,
  createDiff,
  onGrantToolPermission: () => ({ success: true }),
  selectedProject: { projectId: 'project-a', displayName: 'Project A', fullPath: '/srv/project-a' },
};

let auth!: ReturnType<typeof useAuth>;
function AccountProbe() {
  const current = useAuth();
  useEffect(() => { auth = current; }, [current]);
  return null;
}
const liveTranscript = () => (
  <AuthProvider>
    <AccountProbe />
    <UiPreferencesProvider>
      <ChatMessagesPane {...paneProps} />
    </UiPreferencesProvider>
  </AuthProvider>
);
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });

beforeEach(() => {
  vi.resetAllMocks();
  localStorage.clear();
  localStorage.setItem('auth-token', 'initial.payload.signature');
  requests.user.mockImplementation(() => Promise.resolve(json({ user: initialUser })));
  requests.onboardingStatus.mockImplementation(() => Promise.resolve(json({ hasCompletedOnboarding: true })));
});

test('saving a profile updates the existing live user avatar through the memoized transcript', async () => {
  const view = render(liveTranscript());
  await waitFor(() => assert.equal(view.container.querySelector('.chat-message.user img')?.getAttribute('src'), FIRST_AVATAR));
  const userRow = view.container.querySelector('.chat-message.user');
  const image = userRow?.querySelector('img');
  const reply = view.container.querySelector('.chat-message.assistant');
  const providerAvatar = reply?.querySelector('svg');
  assert.ok(image);
  assert.ok(providerAvatar);

  requests.updateProfile.mockImplementation(() => Promise.resolve(json({ user: { ...initialUser, avatarDataUrl: SAVED_AVATAR } })));
  await act(async () => {
    const result = await auth.updateProfile('Demo User', SAVED_AVATAR);
    assert.deepEqual(result, { success: true });
  });
  // The account context, not a new message or a new pane instance, triggers it.
  assert.equal(image.getAttribute('src'), SAVED_AVATAR);
  view.rerender(liveTranscript());
  assert.equal(view.container.querySelector('.chat-message.user'), userRow);
  assert.equal(view.container.querySelector('.chat-message.user img'), image);
  assert.equal(image.getAttribute('src'), SAVED_AVATAR);
  assert.equal(view.container.querySelector('.chat-message.assistant'), reply);
  assert.equal(reply?.querySelector('svg'), providerAvatar);
  assert.equal(reply?.querySelector('img'), null, 'the account picture must not replace the provider avatar');
  assert.deepEqual(requests.updateProfile.mock.calls, [['Demo User', SAVED_AVATAR]]);
});

test('a missing profile and a static export render neutral avatars without an AuthProvider', () => {
  const view = render(<MessageComponent message={userMessage} prevMessage={null} createDiff={createDiff} provider="claude" />);
  assert.equal(view.container.querySelector('.chat-message.user img'), null);
  assert.ok(view.container.querySelector('.chat-message.user .lucide-user-round'));
  assert.notEqual(view.container.querySelector('.chat-message.user span')?.textContent, 'U');

  const exported = document.createElement('div');
  exported.innerHTML = renderToStaticMarkup(<TranscriptExportDocument messages={messages} createDiff={createDiff} provider="claude" />);
  assert.ok(exported.querySelector('.chat-message.user .lucide-user-round'));
  assert.equal(exported.querySelector('.chat-message.user img'), null);
  assert.match(exported.textContent ?? '', /Keep this existing turn/);
  assert.match(exported.textContent ?? '', /Existing reply/);
  assert.equal(requests.user.mock.calls.length, 0, 'standalone and export rows must not read an account');
  assert.equal(requests.updateProfile.mock.calls.length, 0);
});
