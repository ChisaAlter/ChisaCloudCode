import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ActivityIcon, ArrowDownIcon, MoreHorizontalIcon, PanelRightOpenIcon } from 'lucide-react';

import { ActionMenu } from '@/shared/ui';
import { useTasksSettings } from '@/modules/task-master';
import { PiAgentPanel } from '@/modules/local-agent';
import { isDesktop } from '@/shared/chisa';
import { useWebSocket } from '@/shared/context/WebSocketContext';
import PermissionContext from '@/modules/chat/context/PermissionContext';
import { api } from '@/shared/api';
import { DEFAULT_EFFORT_VALUE } from '@/shared/constants';
import type {
  ChatMessage,
  ChatReplayCursor,
  ChatStreamBuffer,
  Project,
  ProjectSession,
  PermissionMode,
  QueuedSendOptions,
  SessionEstablishedContext,
  SessionNavigationOptions,
} from '@/shared/types';
import { useChatProviderState } from '@/modules/chat/hooks/useChatProviderState';
import { useScheduledMessages } from '@/modules/chat/composer/useScheduledMessages';
import { useChatSessionState } from '@/modules/chat/hooks/useChatSessionState';
import { useChatRealtimeHandlers } from '@/modules/chat/hooks/useChatRealtimeHandlers';
import { useChatComposerState } from '@/modules/chat/hooks/useChatComposerState';
import { useSessionStore } from '@/modules/chat/hooks/useSessionStore';
import {
  useProcessingSessions,
  useSessionProtectionActions,
} from '@/shared/context/SessionProtectionContext';
import ChatMessagesPane from '@/modules/chat/transcript/ChatMessagesPane';
import ChatComposer from '@/modules/chat/composer/ChatComposer';
import CommandResultModal from '@/modules/chat/modals/CommandResultModal';

type ChatInterfaceProps = {
  isActive: boolean;
  selectedProject: Project | null;
  selectedSession: ProjectSession | null;
  ws: WebSocket | null;
  sendMessage: (message: unknown) => void;
  onFileOpen?: (filePath: string, diffInfo?: any) => void;
  onNavigateToSession?: (targetSessionId: string, options?: SessionNavigationOptions) => void;
  onSessionEstablished?: (sessionId: string, context: SessionEstablishedContext) => void;
  onShowSettings?: () => void;
  showRawParameters?: boolean;
  showThinking?: boolean;
  sendByCtrlEnter?: boolean;
  externalMessageUpdate?: number;
  newSessionTrigger?: number;
  onTaskClick?: (...args: unknown[]) => void;
  onShowAllTasks?: (() => void) | null;
};

/**
 * Used by the project-workspace module (via the chat barrel) to render a
 * project session's chat tab; it owns the session, provider, realtime and
 * composer state that ChatMessagesPane and ChatComposer render.
 */
function ChatInterface({
  isActive,
  selectedProject,
  selectedSession,
  ws,
  sendMessage,
  onFileOpen,
  onNavigateToSession,
  onSessionEstablished,
  onShowSettings,
  showRawParameters,
  showThinking,
  sendByCtrlEnter,
  externalMessageUpdate,
  newSessionTrigger,
  onShowAllTasks,
}: ChatInterfaceProps) {
  const { tasksEnabled, isTaskMasterInstalled } = useTasksSettings();
  const { subscribe } = useWebSocket();
  const { t } = useTranslation('chat');
  const processingSessions = useProcessingSessions();
  const {
    markSessionProcessing: onSessionProcessing,
    markSessionIdle: onSessionIdle,
  } = useSessionProtectionActions();

  const sessionStore = useSessionStore();
  // Native Pi ownership belongs to an app session and must disable cloud sends without creating queued drafts.
  const [piOwnership, setPiOwnership] = useState<{ sessionId: string; blocked: boolean | null; error?: string } | null>(null);
  // An explicit state recheck recovers failed initial reads without replaying any Pi task.
  const [piStateRefresh, setPiStateRefresh] = useState(0);
  // The private workspace is opened by the user and keeps running when visually closed.
  const [piOpen, setPiOpen] = useState(false);
  // Retain the user's Pi pane width while opening, closing or switching conversations.
  const [piPanePercent, setPiPanePercent] = useState(50);
  const splitPaneRef = useRef<HTMLDivElement | null>(null);
  const resizePiPane = (width: number) => {
    const rect = splitPaneRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return;
    const minimum = Math.min(320, rect.width * 0.45);
    setPiPanePercent(Math.max(minimum, Math.min(rect.width - minimum - 8, width)) / rect.width * 100);
  };
  // Local binding eligibility is scoped so a previous project's result cannot expose an invalid Pi entry.
  const [piEligibility, setPiEligibility] = useState<{ sessionId: string; eligible: boolean } | null>(null);
  // Each selected conversation retains its independent Pi draft when switching or closing the pane.
  const [piDrafts, setPiDrafts] = useState<Record<string, string>>({});
  const piOwnershipRef = useRef(piOwnership);
  const activePiSessionRef = useRef<string | null>(null);
  activePiSessionRef.current = selectedSession?.id || null;
  const handlePiOwnership = useCallback((sessionId: string, blocked: boolean | null, error?: string) => {
    if (activePiSessionRef.current !== sessionId) return;
    const ownership = { sessionId, blocked, error };
    piOwnershipRef.current = ownership;
    setPiOwnership(ownership);
  }, []);
  const canSubmitCloud = useCallback(() => !(
    piOwnershipRef.current?.sessionId === activePiSessionRef.current && piOwnershipRef.current?.blocked !== false
  ), []);
  // Background conversations retain their own paragraph and timer when the visible session changes.
  const streamBuffersRef = useRef(new Map<string, ChatStreamBuffer>());
  // When each session's `chat.subscribe` was last sent; idle acks older than
  // a later local request are discarded as stale.
  const statusCheckSentAtRef = useRef(new Map<string, number>());
  // Channel epochs reset replay watermarks; run ids only identify execution ownership.
  const replayCursorsRef = useRef(new Map<string, ChatReplayCursor>());

  const {
    provider,
    setProvider,
    providerModels,
    setStoredProviderModel,
    currentProviderEffort,
    currentProviderEffortOptions,
    currentProviderModel,
    currentResolvedModel,
    currentProviderModelOptions,
    permissionMode,
    pendingPermissionRequests,
    setPendingPermissionRequests,
    availablePermissionModes,
    selectPermissionMode,
    cyclePermissionMode,
    providerModelCatalog,
    providerModelsLoading,
    providerModelsError,
    reloadProviderModels,
    sessionOptionsReady,
    sessionOptionsError,
    reloadSessionOptions,
    providerModelActions,
    selectProviderModel,
    selectProviderEffort,
    resolvePermissionModeForProvider,
    supportsMessageEditing,
    supportsSessionForking,
  } = useChatProviderState({
    selectedSession,
    selectedProject,
    subscribe,
  });

  const {
    chatMessages,
    addMessage,
    sessionActivity,
    isProcessing,
    canAbortSession,
    currentSessionId,
    setCurrentSessionId,
    isLoadingSessionMessages,
    isLoadingMoreMessages,
    hasMoreMessages,
    totalMessages,
    isUserScrolledUp,
    setIsUserScrolledUp,
    tokenBudget,
    setTokenBudget,
    visibleMessageCount,
    visibleMessages,
    loadEarlierMessages,
    loadAllMessages,
    loadFullTranscript,
    allMessagesLoaded,
    isLoadingAllMessages,
    loadAllJustFinished,
    showLoadAllOverlay,
    createDiff,
    scrollContainerRef,
    scrollToBottom,
    scrollToBottomAndReset,
    handleScroll,
    requestLatestMessages,
  } = useChatSessionState({
    isActive,
    selectedProject,
    selectedSession,
    ws,
    sendMessage,
    externalMessageUpdate,
    newSessionTrigger,
    processingSessions,
    onSessionIdle,
    statusCheckSentAtRef,
    replayCursorsRef,
    sessionStore,
  });

  // Brand-new conversation: the composer allocated a stable session id via
  // the session gateway before the first send. Record it locally and put it
  // in the URL — this id never changes again, so there is no later handoff.
  const handleSessionEstablished = useCallback<NonNullable<ChatInterfaceProps['onSessionEstablished']>>((sessionId, context) => {
    setCurrentSessionId(sessionId);
    onSessionEstablished?.(sessionId, context);
    onNavigateToSession?.(sessionId);
  }, [setCurrentSessionId, onSessionEstablished, onNavigateToSession]);

  // Model and effort mutations settle independently; either user action cancels an older queue-control restore.
  const composerSelectionRequestsRef = useRef({ model: 0, effort: 0, restore: 0 });
  const restoreQueuedOptions = useCallback(async (options: QueuedSendOptions, isCurrent: () => boolean) => {
    const requests = composerSelectionRequestsRef.current;
    const restore = ++requests.restore;
    requests.model++;
    requests.effort++;
    const current = () => isCurrent() && requests.restore === restore;
    if (!current()) return;
    if (!sessionOptionsReady) throw new Error(sessionOptionsError || '请先恢复本会话模型设置，再重试编辑；完整排队草稿已保留。');
    const sessionId = selectedSession?.id || currentSessionId || null;
    if (typeof options.model === 'string') await selectProviderModel(provider, options.model, sessionId, current);
    if (!current()) return;
    // Missing effort is a raw no-override snapshot, not permission to persist a new session default.
    if (typeof options.effort === 'string') await selectProviderEffort(provider, options.effort, sessionId, current);
    if (!current()) return;
    if (typeof options.permissionMode === 'string') selectPermissionMode(resolvePermissionModeForProvider(provider, options.permissionMode));
  }, [currentSessionId, provider, resolvePermissionModeForProvider, selectPermissionMode, selectProviderEffort,
    selectProviderModel, selectedSession?.id, sessionOptionsError, sessionOptionsReady]);

  const {
    input,
    setInput,
    textareaRef,
    inputHighlightRef,
    isTextareaExpanded,
    filteredCommands,
    frequentCommands,
    commandQuery,
    showCommandMenu,
    selectedCommandIndex,
    resetCommandMenuState,
    handleCommandSelect,
    handleToggleCommandMenu,
    showFileDropdown,
    filteredFiles,
    selectedFileIndex,
    renderInputWithMentions,
    selectFile,
    draftAttachments,
    removeDraftAttachment,
    updateManualQueuedOptions,
    beginQueuedOptionsChange,
    manualQueuedOptions,
    captureDraftForSchedule,
    fileErrors,
    getRootProps,
    getInputProps,
    isDragActive,
    openAttachmentPicker,
    handleSubmit,
    canSubmitWithoutModelOptions,
    workspacePendingDraft,
    workspacePendingNotice,
    isWaitingForWorkspace,
    cancelWorkspaceSend,
    editWorkspaceSend,
    queuedDraft,
    editQueuedDraft,
    deleteQueuedDraft,
    handleVoiceTranscript,
    handleInputChange,
    handleKeyDown,
    handlePaste,
    handleTextareaClick,
    handleTextareaInput,
    syncInputOverlayScroll,
    handleClearInput,
    handleAbortSession,
    handlePermissionDecision,
    handleGrantToolPermission,
    handleInputFocusChange,
    isInputFocused,
    commandModalPayload,
    closeCommandModal,
    showCostModal,
    editingAnchorId,
    beginEditMessage,
    cancelEditMessage,
  } = useChatComposerState({
    isActive,
    selectedProject,
    selectedSession,
    currentSessionId,
    provider,
    permissionMode,
    cyclePermissionMode,
    currentProviderModel,
    currentProviderEffort,
    sessionOptionsReady,
    availablePermissionModes,
    onRestoreQueuedOptions: restoreQueuedOptions,
    isLoading: isProcessing,
    processingSessions,
    canAbortSession,
    tokenBudget,
    sendMessage,
    canSubmitCloud,
    sendByCtrlEnter,
    onSessionProcessing,
    onSessionEstablished: handleSessionEstablished,
    onFileOpen,
    onShowSettings,
    scrollToBottom,
    addMessage,
    setIsUserScrolledUp,
    setPendingPermissionRequests,
    resolvePermissionModeForProvider,
  });

  // On WebSocket reconnect, request a bounded persisted-tail sync (deferred
  // while Chat is hidden), then re-subscribe — the
  // `chat_subscribed` ack restores or clears the activity indicator, replays
  // missed live events, and re-attaches a still-running stream to this socket.
  const handleWebSocketReconnect = useCallback(async () => {
    if (!selectedProject || !selectedSession) return;
    await requestLatestMessages(selectedSession.id, isActive);
    try {
      sendMessage({
        type: 'chat.subscribe',
        sessions: [{
          sessionId: selectedSession.id,
          lastSeq: replayCursorsRef.current.get(selectedSession.id)?.seq ?? 0,
          replayEpoch: replayCursorsRef.current.get(selectedSession.id)?.replayEpoch,
          runId: replayCursorsRef.current.get(selectedSession.id)?.runId,
        }],
      });
      statusCheckSentAtRef.current.set(selectedSession.id, Date.now());
    } catch (error) {
      console.warn('Chat subscription awaits the next connection:', error);
    }
  }, [isActive, requestLatestMessages, selectedProject, selectedSession, sendMessage]);

  useChatRealtimeHandlers({
    isActive,
    subscribe,
    provider,
    selectedSession,
    currentSessionId,
    setTokenBudget,
    pendingPermissionRequests,
    setPendingPermissionRequests,
    streamBuffersRef,
    replayCursorsRef,
    statusCheckSentAtRef,
    onSessionProcessing,
    onSessionIdle,
    onWebSocketReconnect: handleWebSocketReconnect,
    requestLatestMessages,
    sessionStore,
  });

  useEffect(() => {
    if (!canAbortSession) {
      return;
    }

    const handleGlobalEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.repeat || event.defaultPrevented) {
        return;
      }

      event.preventDefault();
      handleAbortSession();
    };

    document.addEventListener('keydown', handleGlobalEscape, { capture: true });
    return () => {
      document.removeEventListener('keydown', handleGlobalEscape, { capture: true });
    };
  }, [canAbortSession, handleAbortSession]);

  useEffect(() => {
    return () => {
      streamBuffersRef.current.forEach(buffer => { if (buffer.timer !== null) clearTimeout(buffer.timer); });
      streamBuffersRef.current.clear();
    };
  }, []);

  /**
   * Branches the conversation into a new session that ends at this message,
   * then opens it. The session being viewed is left exactly as it was.
   */
  const handleForkFromMessage = useCallback(async (message: ChatMessage) => {
    const anchorId = message.transcriptAnchorId;
    const sourceSessionId = selectedSession?.id;
    if (!anchorId || !sourceSessionId) return;

    try {
      const response = await api.forkSession(sourceSessionId, { upToAnchorId: anchorId });
      const payload = await response.json();
      const forkedSessionId = payload?.data?.sessionId;
      if (!response.ok || typeof forkedSessionId !== 'string') {
        throw new Error(payload?.message || `HTTP ${response.status}`);
      }
      onNavigateToSession?.(forkedSessionId);
    } catch (error) {
      console.error('Error forking session:', error);
    }
  }, [onNavigateToSession, selectedSession?.id]);

  const { scheduledMessages, schedule: scheduleMessage, cancel: cancelScheduledMessage } =
    useScheduledMessages(selectedSession?.id || currentSessionId || null);
  const composerEffort = manualQueuedOptions
    ? typeof manualQueuedOptions.effort === 'string' ? manualQueuedOptions.effort : DEFAULT_EFFORT_VALUE
    : currentProviderEffort;

  /**
   * Hands the composer's current text to the server to send later, and clears
   * the box as a send would — the message has left the composer either way.
   */
  const handleScheduleMessage = useCallback(async (scheduledFor: Date) => {
    if (!sessionOptionsReady) return;
    const draft = captureDraftForSchedule();
    if (!draft.content) return;

    const scheduled = await scheduleMessage({
      content: draft.content,
      scheduledFor,
      options: { model: currentProviderModel, effort: composerEffort, permissionMode },
    });
    if (scheduled) {
      draft.clearIfUnchanged();
    }
  }, [captureDraftForSchedule, composerEffort, currentProviderModel, permissionMode, scheduleMessage, sessionOptionsReady]);

  const reloadComposerModels = useCallback(() => {
    reloadProviderModels();
    if (sessionOptionsError) reloadSessionOptions();
  }, [reloadProviderModels, reloadSessionOptions, sessionOptionsError]);

  const permissionContextValue = useMemo(() => ({
    pendingPermissionRequests,
    handlePermissionDecision,
  }), [pendingPermissionRequests, handlePermissionDecision]);

  // A composer pick becomes the default for new chats and, when a session is
  // open, is recorded against that session so reopening it restores this model.
  const handleSelectProviderModel = useCallback(async (...args: Parameters<typeof selectProviderModel>) => {
    const appliesToEditor = args[0] === provider
      && (args[2] || null) === (selectedSession?.id || currentSessionId || null);
    if (appliesToEditor) beginQueuedOptionsChange();
    const request = ++composerSelectionRequestsRef.current.model;
    if (appliesToEditor) composerSelectionRequestsRef.current.restore++;
    const selection = await selectProviderModel(...args);
    if (request === composerSelectionRequestsRef.current.model && appliesToEditor) {
      updateManualQueuedOptions({ model: selection.model });
    }
    return selection;
  }, [beginQueuedOptionsChange, currentSessionId, provider, selectProviderModel, selectedSession?.id, updateManualQueuedOptions]);

  const handleSelectComposerModel = useCallback(async (model: string) => {
    try {
      await handleSelectProviderModel(provider, model, selectedSession?.id || currentSessionId || null);
    } catch (error) {
      console.error('Error changing the active session model:', error);
    }
  }, [currentSessionId, handleSelectProviderModel, provider, selectedSession?.id]);

  const handleSelectComposerEffort = useCallback(async (effort: string) => {
    beginQueuedOptionsChange();
    const request = ++composerSelectionRequestsRef.current.effort;
    composerSelectionRequestsRef.current.restore++;
    try {
      const selection = await selectProviderEffort(provider, effort, selectedSession?.id || currentSessionId || null);
      if (request === composerSelectionRequestsRef.current.effort) updateManualQueuedOptions({ effort: selection.effort });
    } catch (error) {
      console.error('Error changing the active session reasoning effort:', error);
    }
  }, [beginQueuedOptionsChange, currentSessionId, provider, selectProviderEffort, selectedSession?.id, updateManualQueuedOptions]);

  const handleSelectComposerPermissionMode = useCallback((mode: PermissionMode) => {
    beginQueuedOptionsChange();
    composerSelectionRequestsRef.current.restore++;
    selectPermissionMode(mode);
    updateManualQueuedOptions({ permissionMode: mode });
  }, [beginQueuedOptionsChange, selectPermissionMode, updateManualQueuedOptions]);

  const selectedProviderLabel =
    provider === 'cursor'
      ? t('messageTypes.cursor')
      : provider === 'codex'
        ? t('messageTypes.codex')
        : provider === 'opencode'
            ? t('messageTypes.opencode', { defaultValue: 'OpenCode' })
          : t('messageTypes.claude');

  const piSessionId = selectedSession?.id || currentSessionId;
  activePiSessionRef.current = piSessionId;
  const piBlocksCloud = piOwnership?.sessionId === piSessionId && piOwnership.blocked !== false;
  const handlePiEligibility = useCallback((eligible: boolean) => {
    const sessionId = activePiSessionRef.current;
    if (sessionId) setPiEligibility({ sessionId, eligible });
  }, []);
  // Only a user-submitted Pi task reads history. This is the ordinary history
  // request; no Pi instructions, output, or identity are sent to Claude.
  const getClaudeContext = useCallback(async () => {
    const sessionId = piSessionId;
    if (!sessionId || activePiSessionRef.current !== sessionId) throw new Error('当前 Claude 会话已切换，请重新发送 Pi 任务。');
    const messages = await loadFullTranscript();
    if (activePiSessionRef.current !== sessionId) throw new Error('当前 Claude 会话已切换，请重新发送 Pi 任务。');
    if (sessionStore.getSessionSlot(sessionId)?.status === 'error') throw new Error('读取 Claude 上下文失败，Pi 尚未开始，请稍后重新发送。');
    return messages.filter((message) => !message.isThinking).map((message) => {
      if (message.isToolUse) {
        const input = typeof message.toolInput === 'string' ? message.toolInput : JSON.stringify(message.toolInput ?? '');
        const result = message.toolResult;
        const output = typeof result?.content === 'string' ? result.content : JSON.stringify(result?.content ?? '');
        return `Claude 工具：${message.toolName || '工具'}\n参数：${input}${result ? `\n${result.isError ? '失败' : '结果'}：${output}` : ''}`;
      }
      if (!message.content?.trim()) return '';
      if (message.type === 'user') return `用户：\n${message.content}`;
      if (message.type === 'assistant') return `Claude：\n${message.content}`;
      if (message.type === 'error') return `执行错误：\n${message.content}`;
      return '';
    }).filter(Boolean).join('\n\n');
  }, [loadFullTranscript, piSessionId, sessionStore]);
  const piAvailable = isDesktop() && provider === 'claude' && Boolean(piSessionId) && piEligibility?.sessionId === piSessionId && piEligibility.eligible;

  if (!selectedProject) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-center text-muted-foreground">
          <p className="text-sm">
            {t('projectSelection.startChatWithProvider', {
              provider: selectedProviderLabel,
              defaultValue: 'Select a project to start chatting with {{provider}}',
            })}
          </p>
        </div>
      </div>
    );
  }


  return (
    <PermissionContext.Provider value={permissionContextValue}>
      <div ref={splitPaneRef} className="flex h-full min-h-0 min-w-0">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {(piSessionId || tokenBudget) && <div className="chat-session-tools flex shrink-0 items-center justify-end gap-1 px-5 py-1">
          {piAvailable && <button type="button" aria-expanded={piOpen} className="flex items-center gap-2 rounded-lg px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground" onClick={() => setPiOpen((value) => !value)}><PanelRightOpenIcon className="h-3.5 w-3.5" />{piOpen ? '收起 Pi 工作区' : 'Pi 工作区'}</button>}
          <ActionMenu label={t('misc.sessionOptions', { defaultValue: 'Session options' })} ariaLabel={t('misc.sessionOptions', { defaultValue: 'Session options' })} icon={MoreHorizontalIcon} iconOnly variant="ghost" portal triggerClassName="h-7 w-7 rounded-lg p-0 text-muted-foreground" items={[{ key: 'usage', label: t('misc.showTokenUsage'), icon: ActivityIcon, onSelect: showCostModal }]} />
        </div>}
        <ChatMessagesPane
          scrollContainerRef={scrollContainerRef}
          // Not redundant with the `scroll` listener. A first page is 20 rows,
          // tool results fold into their calls, and the "load earlier" link is
          // hidden while more pages exist — so a short transcript is often not
          // scrollable at all and never emits `scroll`. Wheel and touch are
          // then the only way to reach the top pager or the "load all" overlay.
          onWheel={handleScroll}
          onTouchMove={handleScroll}
          isLoadingSessionMessages={isLoadingSessionMessages}
          isProcessing={isProcessing}
          chatMessages={chatMessages}
          selectedSession={selectedSession}
          currentSessionId={currentSessionId}
          provider={provider}
          setProvider={setProvider}
          textareaRef={textareaRef}
          providerModels={providerModels}
          setProviderModel={setStoredProviderModel}
          providerModelCatalog={providerModelCatalog}
          providerModelActions={providerModelActions}
          providerModelsLoading={providerModelsLoading}
          tasksEnabled={tasksEnabled}
          isTaskMasterInstalled={isTaskMasterInstalled}
          onShowAllTasks={onShowAllTasks}
          setInput={setInput}
          isLoadingMoreMessages={isLoadingMoreMessages}
          hasMoreMessages={hasMoreMessages}
          totalMessages={totalMessages}
          sessionMessagesCount={chatMessages.length}
          visibleMessageCount={visibleMessageCount}
          visibleMessages={visibleMessages}
          loadEarlierMessages={loadEarlierMessages}
          loadAllMessages={loadAllMessages}
          allMessagesLoaded={allMessagesLoaded}
          isLoadingAllMessages={isLoadingAllMessages}
          loadAllJustFinished={loadAllJustFinished}
          showLoadAllOverlay={showLoadAllOverlay}
          createDiff={createDiff}
          onFileOpen={onFileOpen}
          onShowSettings={onShowSettings}
          onGrantToolPermission={handleGrantToolPermission}
          showRawParameters={showRawParameters}
          showThinking={showThinking}
          selectedProject={selectedProject}
          // Editing replaces the turn and everything after it, so it is only
          // offered when the session is idle — a half-truncated transcript with
          // a live stream writing into it is not recoverable.
          onEditMessage={supportsMessageEditing && !isProcessing && !piBlocksCloud ? beginEditMessage : undefined}
          onForkFromMessage={supportsSessionForking ? handleForkFromMessage : undefined}
          onLoadFullTranscript={loadFullTranscript}
        />

        <div className="relative flex-shrink-0">
          {isUserScrolledUp && chatMessages.length > 0 && (
            <div className="pointer-events-none absolute -top-11 left-0 right-0 z-20 flex justify-center">
              <button
                type="button"
                onClick={scrollToBottomAndReset}
                aria-label={t('input.scrollToBottom', { defaultValue: 'Scroll to bottom' })}
                className="pointer-events-auto flex h-8 w-8 items-center justify-center rounded-full border border-border/50 bg-card text-muted-foreground shadow-sm transition-all duration-200 hover:bg-accent hover:text-foreground"
                title={t('input.scrollToBottom', { defaultValue: 'Scroll to bottom' })}
              >
                <ArrowDownIcon className="h-4 w-4" aria-hidden />
              </button>
            </div>
          )}

          {piBlocksCloud && <div role="status" className="mx-3 mb-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span>{piOwnership?.blocked === null
              ? piOwnership.error ? `尚未确认 Pi 工作区状态：${piOwnership.error}` : '正在确认 Pi 工作区状态，草稿可以继续编辑。'
              : 'Pi 正在操作或交还同一项目。Claude 草稿可以编辑，工作区交还后可发送。'}</span>
            {piOwnership?.blocked === null && piOwnership.error && <button type="button" className="rounded-md border border-border px-2 py-1 hover:bg-accent" onClick={() => setPiStateRefresh((revision) => revision + 1)}>重新检查状态</button>}
          </div>}
          <ChatComposer
          pendingPermissionRequests={pendingPermissionRequests}
          handlePermissionDecision={handlePermissionDecision}
          handleGrantToolPermission={handleGrantToolPermission}
          activity={sessionActivity}
          isLoading={isProcessing}
          onAbortSession={handleAbortSession}
          permissionMode={permissionMode}
          availablePermissionModes={availablePermissionModes}
          onSelectPermissionMode={handleSelectComposerPermissionMode}
          providerLabel={selectedProviderLabel}
          effort={composerEffort}
          availableEffortOptions={currentProviderEffortOptions}
          onSelectEffort={handleSelectComposerEffort}
          resolvedModel={currentResolvedModel}
          model={currentProviderModel}
          availableModelOptions={currentProviderModelOptions}
          onSelectModel={handleSelectComposerModel}
           modelsLoading={providerModelsLoading || (!sessionOptionsReady && !sessionOptionsError)}
           modelsError={providerModelsError || Boolean(sessionOptionsError)}
           modelsErrorMessage={sessionOptionsError || undefined}
           onReloadModels={reloadComposerModels}
           sendOptionsReady={sessionOptionsReady}
           canSubmitWithoutModelOptions={canSubmitWithoutModelOptions}
          isEditingSentMessage={Boolean(editingAnchorId)}
          onCancelEditMessage={cancelEditMessage}
          scheduledMessages={scheduledMessages}
          onScheduleMessage={handleScheduleMessage}
          onCancelScheduledMessage={cancelScheduledMessage}
          onToggleCommandMenu={handleToggleCommandMenu}
          hasInput={Boolean(input.trim())}
          onClearInput={handleClearInput}
          onSubmit={handleSubmit}
          isDragActive={isDragActive}
          queuedDraft={queuedDraft}
          workspacePendingDraft={workspacePendingDraft}
          workspacePendingNotice={workspacePendingNotice}
          isWaitingForWorkspace={isWaitingForWorkspace}
          onCancelWorkspaceSend={cancelWorkspaceSend}
          onEditWorkspaceSend={editWorkspaceSend}
          onEditQueuedDraft={editQueuedDraft}
          onDeleteQueuedDraft={deleteQueuedDraft}
           draftAttachments={draftAttachments}
           onRemoveAttachment={removeDraftAttachment}
          fileErrors={fileErrors}
          showFileDropdown={showFileDropdown}
          filteredFiles={filteredFiles}
          selectedFileIndex={selectedFileIndex}
          onSelectFile={selectFile}
          filteredCommands={filteredCommands}
          selectedCommandIndex={selectedCommandIndex}
          onCommandSelect={handleCommandSelect}
          onCloseCommandMenu={resetCommandMenuState}
          isCommandMenuOpen={showCommandMenu}
          frequentCommands={commandQuery ? [] : frequentCommands}
          getRootProps={getRootProps as (...args: unknown[]) => Record<string, unknown>}
          getInputProps={getInputProps as (...args: unknown[]) => Record<string, unknown>}
          openAttachmentPicker={openAttachmentPicker}
          inputHighlightRef={inputHighlightRef}
          renderInputWithMentions={renderInputWithMentions}
          textareaRef={textareaRef}
          input={input}
          onVoiceTranscript={handleVoiceTranscript}
          onInputChange={handleInputChange}
          onTextareaClick={handleTextareaClick}
          onTextareaKeyDown={handleKeyDown}
          onTextareaPaste={handlePaste}
          onTextareaScrollSync={syncInputOverlayScroll}
          onTextareaInput={handleTextareaInput}
          isInputFocused={isInputFocused}
          onInputFocusChange={handleInputFocusChange}
          placeholder={t('input.placeholder', { provider: selectedProviderLabel })}
          isTextareaExpanded={isTextareaExpanded}
          sendByCtrlEnter={sendByCtrlEnter}
        />
        </div>
      </div>
      {isDesktop() && provider === 'claude' && piSessionId && (
        <>
        {piOpen && piAvailable && <div role="separator" tabIndex={0} aria-orientation="vertical" aria-label="调整 Pi 工作区宽度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(piPanePercent)} aria-valuetext={`Pi 工作区 ${Math.round(piPanePercent)}%`}
          className="group relative z-10 w-2 shrink-0 cursor-col-resize touch-none outline-none"
          onPointerDown={event => { if (event.button !== 0) return; event.preventDefault(); event.currentTarget.focus(); event.currentTarget.setPointerCapture(event.pointerId); }}
          onPointerMove={event => { if (!event.currentTarget.hasPointerCapture(event.pointerId)) return; const rect = splitPaneRef.current?.getBoundingClientRect(); if (rect) resizePiPane(rect.right - event.clientX); }}
          onPointerUp={event => { if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }}
          onKeyDown={event => { if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return; event.preventDefault(); const rect = splitPaneRef.current?.getBoundingClientRect(); if (rect) resizePiPane(rect.width * piPanePercent / 100 + (event.key === 'ArrowLeft' ? 24 : -24)); }}>
          <span className="pointer-events-none absolute inset-y-0 left-1/2 w-px bg-border/60 transition-colors group-hover:bg-primary/50 group-focus-visible:bg-primary/50" />
          <span className="pointer-events-none absolute left-1/2 top-1/2 h-10 w-1 -translate-x-1/2 -translate-y-1/2 rounded-full bg-primary/50 opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100" />
        </div>}
        <aside className={piOpen && piAvailable ? 'flex min-h-0 min-w-0 shrink-0 flex-col' : 'hidden'} style={{ width: `${piPanePercent}%`, minWidth: 'min(320px, 45%)', maxWidth: 'calc(100% - min(320px, 45%) - 8px)' }} aria-label="Pi 右侧工作区">
          <PiAgentPanel key={`${selectedProject.fullPath}:${piSessionId}`} serverPath={selectedProject.fullPath || selectedProject.path || ''} sessionId={piSessionId} isActive={isActive} cloudBusy={isProcessing} input={piDrafts[piSessionId] || ''} onInputChange={(text) => setPiDrafts((previous) => ({ ...previous, [piSessionId]: text }))} getClaudeContext={getClaudeContext} onOwnershipChange={handlePiOwnership} onEligibilityChange={handlePiEligibility} onClose={() => setPiOpen(false)} refreshKey={piStateRefresh} />
        </aside>
        </>
      )}
      </div>

      <CommandResultModal
        payload={commandModalPayload}
        onClose={closeCommandModal}
        providerModelCatalog={providerModelCatalog}
        providerModelActions={providerModelActions}
        activeProvider={provider}
        activeProviderModel={currentProviderModel}
        currentSessionId={currentSessionId || selectedSession?.id || null}
        onSelectProviderModel={handleSelectProviderModel}
      />
    </PermissionContext.Provider>
  );
}

export default React.memo(ChatInterface);
