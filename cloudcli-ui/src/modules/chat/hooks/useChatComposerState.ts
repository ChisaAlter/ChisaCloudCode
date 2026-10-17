import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  ChangeEvent,
  ClipboardEvent,
  Dispatch,
  FormEvent,
  KeyboardEvent,
  MouseEvent,
  SetStateAction,
  TouchEvent,
} from 'react';
import { useDropzone } from 'react-dropzone';

import { api } from '@/shared/api';
import { getAuthSessionVersion } from '@/shared/authToken';
import { FrontendBridge, getServerConnectionVersion, isDesktop, onWorkspaceSyncStateChanged } from '@/shared/chisa';
import { PROVIDER_PERMISSION_PREFERENCE_KEYS } from '@/shared/constants';
import { readUserPreference } from '@/shared/userSettings';
import type { ComposerDraftAttachment, ChisaSyncInfo, CommandModalPayload, CostCommandData, HelpCommandData, MarkSessionProcessing, ModelCommandData, QueuedDraft, SessionActivityMap, StatusCommandData,QueuedSendOptions,ChatAttachment,ChatMessage,PendingPermissionRequest,PermissionMode,SessionEstablishedContext,Project,ProjectSession,LLMProvider,SlashCommand } from '@/shared/types';
import { grantClaudeToolPermission } from '@/modules/chat/utils/chatPermissions';
import {
  clearQueuedMessage,
  hydrateChatDrafts,
  isChatDraftPending,
  readDraftText,
  readQueuedMessage,
  subscribeToChatDrafts,
  writeDraftText,
  writeQueuedMessage,
} from '@/shared/chatDrafts';
import { escapeRegExp } from '@/modules/chat/utils/chatFormatting';
import { useFileMentions } from '@/modules/chat/hooks/useFileMentions';
import { useInputHistory } from '@/modules/chat/hooks/useInputHistory';
import { useSlashCommands } from '@/modules/chat/hooks/useSlashCommands';

type UseChatComposerStateArgs = {
  isActive: boolean;
  selectedProject: Project | null;
  selectedSession: ProjectSession | null;
  currentSessionId: string | null;
  provider: LLMProvider;
  permissionMode: PermissionMode | string;
  cyclePermissionMode: () => void;
  resolvePermissionModeForProvider: (provider: LLMProvider, requestedMode: PermissionMode | string) => PermissionMode;
  /**
   * Model every send and command carries: the open session's model when there
   * is one, otherwise the user's per-provider selection.
   */
  currentProviderModel: string;
  currentProviderEffort: string;
  /** Existing conversations must restore their own options before taking a send snapshot. */
  sessionOptionsReady?: boolean;
  availablePermissionModes?: PermissionMode[];
  /** Restore saved controls only while the editor's scope and draft revision still match. */
  onRestoreQueuedOptions?: (options: QueuedSendOptions, isCurrent: () => boolean) => Promise<void> | void;
  isLoading: boolean;
  processingSessions?: SessionActivityMap;
  canAbortSession: boolean;
  tokenBudget: Record<string, unknown> | null;
  sendMessage: (message: unknown) => void;
  /** Desktop-only project lock; cloud payloads never carry the local lock owner. */
  canSubmitCloud?: () => boolean;
  sendByCtrlEnter?: boolean;
  onSessionProcessing?: MarkSessionProcessing;
  /**
   * Invoked with the freshly allocated session id when the user sends the
   * first message of a brand-new conversation. The backend allocates the id
   * via POST /api/providers/sessions BEFORE the websocket send, so the id is
   * stable for the conversation's whole lifetime — the consumer navigates to
   * /session/:id and records it as the current session.
   */
  onSessionEstablished?: (sessionId: string, context: SessionEstablishedContext) => void;
  onFileOpen?: (filePath: string, diffInfo?: unknown) => void;
  onShowSettings?: () => void;
  scrollToBottom: () => void;
  addMessage: (msg: ChatMessage) => void;
  setIsUserScrolledUp: (isScrolledUp: boolean) => void;
  setPendingPermissionRequests: Dispatch<SetStateAction<PendingPermissionRequest[]>>;
};

type MentionableFile = {
  name: string;
  path: string;
};

type CommandExecutionResult = {
  type: 'builtin' | 'custom';
  action?: string;
  data?: any;
  content?: string;
  hasBashCommands?: boolean;
  hasFileIncludes?: boolean;
};

type ComposerSubmission = QueuedDraft & {
  draftAttachments?: ComposerDraftAttachment[];
  targetSessionId?: string;
  createdSessionContext?: SessionEstablishedContext | null;
};

type WorkspacePendingSend = {
  submission: ComposerSubmission;
  scopeRevision: number;
  draftRevision: number;
  authVersion: number;
  connectionVersion: number;
  bindingEpoch: string | null;
  waiting: boolean;
  notice: string;
};





const createFakeSubmitEvent = () => {
  return { preventDefault: () => undefined } as unknown as FormEvent<HTMLFormElement>;
};

const MAX_ATTACHMENT_COUNT = 10;
const MAX_ATTACHMENT_SIZE = 10 * 1024 * 1024;
const WORKSPACE_WAIT_STATUSES = new Set(['checking', 'syncing', 'migrating', 'reserved']);

// The button and submission path must agree about commands that do not take a model snapshot.
const resolveComposerCommand = (input: string, commands: SlashCommand[], isLoading: boolean) => {
  const commandInput = input.trimEnd();
  const isHelpAlias = commandInput.trim().toLowerCase() === 'help';
  const firstSpace = commandInput.indexOf(' ');
  const commandName = isHelpAlias
    ? '/help'
    : firstSpace > 0 ? commandInput.slice(0, firstSpace) : commandInput;
  const matchedCommand = commandInput.startsWith('/') || isHelpAlias
    ? commands.find((command) => command.name === commandName)
      || (commandName === '/help' ? ({
        name: '/help',
        description: 'Show help documentation for Claude Code',
        namespace: 'builtin',
        metadata: { type: 'builtin' },
      } as SlashCommand) : undefined)
    : undefined;
  // A busy turn queues even builtin text under the existing contract and needs known options.
  const canSubmitWithoutModelOptions = !isLoading && Boolean(matchedCommand && matchedCommand.type !== 'skill'
    && (matchedCommand.namespace === 'builtin' || matchedCommand.type === 'built-in'
      || matchedCommand.metadata?.type === 'builtin'));
  return { commandInput, isHelpAlias, matchedCommand, canSubmitWithoutModelOptions };
};

const isImageAttachment = (attachment: ChatAttachment) => {
  if (attachment.mimeType?.startsWith('image/')) return true;
  return /\.(gif|jpe?g|png|svg|webp)$/i.test(attachment.path || attachment.name || '');
};

const uploadAttachmentFiles = async (files: File[]): Promise<unknown[]> => {
  if (files.length === 0) {
    return [];
  }

  const formData = new FormData();
  files.forEach((file) => {
    formData.append('files', file);
  });

  const response = await api.assets.uploadFiles(formData);

  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new Error(body?.error || 'Failed to upload files');
  }

  const result = await response.json();
  if (!Array.isArray(result.attachments) || result.attachments.length !== files.length) {
    throw new Error('File upload returned an incomplete result');
  }
  return result.attachments;
};


const restoreQueuedDraft = (sessionKey: string): QueuedDraft | null => {
  const saved = readQueuedMessage(sessionKey);
  return saved
    ? {
        content: saved.content,
        autoSend: saved.autoSend,
        claimRevision: saved.claimRevision,
        attachments: [],
        uploadedAttachments: saved.attachments ?? saved.images,
        options: saved.options,
      }
    : null;
};

const queuedAttachmentDraft = (draft: QueuedDraft): ComposerDraftAttachment[] => {
  const uploaded = (draft.uploadedAttachments ?? []) as ChatAttachment[];
  if (!uploaded.length) return draft.attachments.map(file => ({ file }));
  // Browser files correspond to the most recently uploaded descriptors; older restored assets have no File.
  const fileOffset = uploaded.length - draft.attachments.length;
  return uploaded.map((attachment, index) => {
    const file = draft.attachments[index - fileOffset];
    return file ? { file, uploaded: attachment } : { uploaded: attachment };
  });
};

const uploadDraftAttachments = async (items: ComposerDraftAttachment[]): Promise<ComposerDraftAttachment[]> => {
  const files = items.flatMap(item => !item.uploaded && item.file ? [item.file] : []);
  const uploaded = await uploadAttachmentFiles(files) as ChatAttachment[];
  let index = 0;
  return items.map(item => item.uploaded ? item : { ...item, uploaded: uploaded[index++] });
};

const getNotificationSessionSummary = (
  selectedSession: ProjectSession | null,
  fallbackInput: string,
): string | null => {
  const sessionSummary = selectedSession?.summary || selectedSession?.name || selectedSession?.title;
  if (typeof sessionSummary === 'string' && sessionSummary.trim()) {
    const normalized = sessionSummary.replace(/\s+/g, ' ').trim();
    return normalized.length > 80 ? `${normalized.slice(0, 77)}...` : normalized;
  }

  const normalizedFallback = fallbackInput.replace(/\s+/g, ' ').trim();
  if (!normalizedFallback) {
    return null;
  }

  return normalizedFallback.length > 80 ? `${normalizedFallback.slice(0, 77)}...` : normalizedFallback;
};

export function useChatComposerState({
  isActive,
  selectedProject,
  selectedSession,
  currentSessionId,
  provider,
  permissionMode,
  cyclePermissionMode,
  resolvePermissionModeForProvider,
  currentProviderModel,
  currentProviderEffort,
  sessionOptionsReady = true,
  availablePermissionModes = [],
  onRestoreQueuedOptions,
  isLoading,
  canAbortSession,
  tokenBudget,
  sendMessage,
  canSubmitCloud,
  sendByCtrlEnter,
  onSessionProcessing,
  onSessionEstablished,
  onFileOpen,
  onShowSettings,
  scrollToBottom,
  addMessage,
  setIsUserScrolledUp,
  setPendingPermissionRequests,
}: UseChatComposerStateArgs) {
  // The composer text together with the chat scope it belongs to. They are one
  // state rather than a value plus a ref because they have to move in lockstep:
  // on a session switch there is one commit where the scope has already changed
  // while the text has not, and anything that persisted the text in that commit
  // would write the previous session's message into the new session's draft.
  // A ref cannot express this — React evaluates a state updater eagerly, so a
  // ref set inside one is already ahead by the time the effects run.
  //
  // Restored synchronously from the draft mirror so a reload shows what was
  // being typed on the first paint rather than after the drafts request lands.
  /**
   * The already-sent message the composer is currently replacing, or null.
   *
   * Holds the anchor rather than the message, because that is all the send
   * needs and it keeps a stale message object from being captured while the
   * transcript refreshes underneath the composer.
   */
  const [editingState, setEditingState] = useState<{ scopeRevision: number; anchorId: string } | null>(null);

  const [inputState, setInputState] = useState<{ scope: string | null; value: string }>(() => {
    if (typeof window === 'undefined') {
      return { scope: null, value: '' };
    }
    const initialScope = selectedSession?.id || currentSessionId
      || (selectedProject ? `project:${selectedProject.projectId}` : null);
    return {
      scope: initialScope,
      value: initialScope ? readDraftText(initialScope) : '',
    };
  });
  const input = inputState.value;
  // Attachments stay with their draft scope while other conversations remain mounted.
  const [attachmentDrafts, setAttachmentDrafts] = useState<Map<string, ComposerDraftAttachment[]>>(() => new Map());
  const [fileErrors, setFileErrors] = useState<Map<string, string>>(new Map());
  const [isTextareaExpanded, setIsTextareaExpanded] = useState(false);
  const [commandModalPayload, setCommandModalPayload] = useState<CommandModalPayload | null>(null);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const inputHighlightRef = useRef<HTMLDivElement>(null);
  const textareaLineHeightRef = useRef<number | null>(null);
  const lastAutosizedInputRef = useRef<string | null>(null);
  const handleSubmitRef = useRef<
    ((
      event: FormEvent<HTMLFormElement> | MouseEvent | TouchEvent | KeyboardEvent<HTMLTextAreaElement>,
      queuedSubmission?: ComposerSubmission,
    ) => Promise<void>) | null
  >(null);
  // Text or attachment edits invalidate an async submit before it can clear
  // or dispatch a newer draft in the same conversation.
  const draftRevisionRef = useRef(0);
  // The active submission token prevents double Enter while upload/session
  // allocation is pending; a different scope can still start its own send.
  const pendingSubmitRef = useRef<{ scopeRevision: number } | null>(null);
  // Explicit queue editors retain their browser files when temporarily visiting another chat.
  const manualQueueEditorsRef = useRef(new Set<string>());
  // Explicit option picks also supersede an editor whose pause acknowledgement is still pending.
  const queueEditOperationRef = useRef<{ scopeRevision: number } | null>(null);
  const restoreQueuedOptionsRef = useRef(onRestoreQueuedOptions);
  restoreQueuedOptionsRef.current = onRestoreQueuedOptions;
  // A local send intent keeps the original editable draft until synchronization releases it.
  const [workspacePendingSend, setWorkspacePendingSend] = useState<WorkspacePendingSend | null>(null);
  const workspacePendingRef = useRef<WorkspacePendingSend | null>(null);
  const resumeWorkspaceSendRef = useRef<() => void>(() => {});
  const workspaceObservationRef = useRef<{
    scope: string;
    info: ChisaSyncInfo | null;
    error: string | null;
  }>({ scope: '', info: null, error: null });
  const cancelWorkspaceSend = useCallback(() => {
    workspacePendingRef.current = null;
    setWorkspacePendingSend(null);
  }, []);
  // Async work must not navigate or update a composer that has been removed.
  const mountedRef = useRef(true);
  const inputValueRef = useRef(input);
  const selectedProjectId = selectedProject?.projectId;
  // Prefer the stable backend-allocated id (selectedSession.id) but fall back
  // to currentSessionId for a just-established session that hasn't been
  // handed back to the parent's `selectedSession` prop yet.
  const sessionKey = selectedSession?.id || currentSessionId || null;
  // The chat scope a draft belongs to: the open session, or the project for a
  // chat that has not been sent yet and so has no session id. Drafts used to be
  // keyed by project alone, so every session in a project shared one draft.
  const draftScope = sessionKey ?? (selectedProjectId ? `project:${selectedProjectId}` : null);
  const attachmentScope = draftScope ? JSON.stringify([getAuthSessionVersion(), getServerConnectionVersion(), draftScope]) : null;
  const attachmentScopeRef = useRef(attachmentScope);
  attachmentScopeRef.current = attachmentScope;
  const draftAttachments = (attachmentScope && attachmentDrafts.get(attachmentScope)) || [];
  const attachedFiles = draftAttachments.flatMap(item => item.file ? [item.file] : []);
  const draftScopeRef = useRef(draftScope);
  draftScopeRef.current = draftScope;
  const serverConnectionVersion = getServerConnectionVersion();
  const workspacePath = selectedProject?.fullPath || selectedProject?.path || '';
  const waitForWorkspace = isDesktop() && provider === 'claude' && Boolean(workspacePath);
  const submissionScope = JSON.stringify([selectedProjectId, workspacePath, sessionKey, provider, serverConnectionVersion]);
  const submissionScopeRef = useRef({ value: submissionScope, revision: 0 });
  if (submissionScopeRef.current.value !== submissionScope) {
    submissionScopeRef.current = { value: submissionScope, revision: submissionScopeRef.current.revision + 1 };
  }
  if (workspaceObservationRef.current.scope !== submissionScope) {
    workspaceObservationRef.current = { scope: submissionScope, info: null, error: null };
  }
  const manualEditorScope = JSON.stringify([getAuthSessionVersion(), submissionScope]);
  const manualEditorScopeRef = useRef(manualEditorScope);
  manualEditorScopeRef.current = manualEditorScope;
  const editingAnchorId = editingState?.scopeRevision === submissionScopeRef.current.revision ? editingState.anchorId : null;
  const setEditingAnchorId = useCallback((anchorId: string | null) => {
    setEditingState(anchorId ? { scopeRevision: submissionScopeRef.current.revision, anchorId } : null);
  }, []);
  const setInput = useCallback<Dispatch<SetStateAction<string>>>((next) => {
    cancelWorkspaceSend();
    draftRevisionRef.current++;
    const value = typeof next === 'function' ? next(inputValueRef.current) : next;
    inputValueRef.current = value;
    setInputState({
      scope: draftScopeRef.current,
      value,
    });
    if (draftScopeRef.current) writeDraftText(draftScopeRef.current, value,
      manualQueueEditorsRef.current.has(manualEditorScopeRef.current));
  }, [cancelWorkspaceSend]);
  const setDraftAttachments = useCallback<Dispatch<SetStateAction<ComposerDraftAttachment[]>>>((next) => {
    const scope = attachmentScopeRef.current;
    if (!scope) return;
    cancelWorkspaceSend();
    draftRevisionRef.current++;
    setAttachmentDrafts(previous => {
      const items = previous.get(scope) ?? [];
      const value = typeof next === 'function' ? next(items) : next;
      const updated = new Map(previous);
      if (value.length) updated.set(scope, value);
      else updated.delete(scope);
      return updated;
    });
  }, [cancelWorkspaceSend]);
  const setAttachedFiles = useCallback<Dispatch<SetStateAction<File[]>>>((next) => {
    setDraftAttachments(items => {
      const currentFiles = items.flatMap(item => item.file ? [item.file] : []);
      const files = typeof next === 'function' ? next(currentFiles) : next;
      const restored = items.filter(item => !item.file);
      return [...restored, ...files.slice(0, MAX_ATTACHMENT_COUNT - restored.length)
        .map(file => items.find(item => item.file === file) ?? { file })];
    });
  }, [setDraftAttachments]);
  const clearDraftAttachments = useCallback(() => setDraftAttachments([]), [setDraftAttachments]);
  const removeDraftAttachment = useCallback((index: number) => {
    setDraftAttachments(items => items.filter((_, currentIndex) => currentIndex !== index));
  }, [setDraftAttachments]);
  const captureDraftForSchedule = useCallback(() => {
    const scope = draftScopeRef.current;
    const revision = draftRevisionRef.current;
    const scopeRevision = submissionScopeRef.current.revision;
    const authVersion = getAuthSessionVersion();
    const connectionVersion = getServerConnectionVersion();
    return {
      content: inputValueRef.current.trim(),
      clearIfUnchanged: () => {
        if (!mountedRef.current || draftScopeRef.current !== scope || draftRevisionRef.current !== revision
          || submissionScopeRef.current.revision !== scopeRevision || getAuthSessionVersion() !== authVersion
          || getServerConnectionVersion() !== connectionVersion) return;
        setInput('');
      },
    };
  }, [setInput]);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const acceptWorkspaceObservation = useCallback((next: ChisaSyncInfo) => {
    const observation = workspaceObservationRef.current;
    if (!mountedRef.current || observation.scope !== submissionScope || next.serverPath !== workspacePath
      || getServerConnectionVersion() !== serverConnectionVersion
      || (observation.info && next.sequence < observation.info.sequence)) return;
    workspaceObservationRef.current = { scope: submissionScope, info: next, error: null };
    resumeWorkspaceSendRef.current();
  }, [serverConnectionVersion, submissionScope, workspacePath]);

  const refreshWorkspaceObservation = useCallback(async () => {
    const sequence = workspaceObservationRef.current.info?.sequence;
    try {
      acceptWorkspaceObservation(await FrontendBridge.getProjectSync(workspacePath));
    } catch (error) {
      if (!mountedRef.current || submissionScopeRef.current.value !== submissionScope
        || getServerConnectionVersion() !== serverConnectionVersion
        || workspaceObservationRef.current.info?.sequence !== sequence) return;
      workspaceObservationRef.current = {
        scope: submissionScope,
        info: null,
        error: error instanceof Error ? error.message : String(error),
      };
      resumeWorkspaceSendRef.current();
    }
  }, [acceptWorkspaceObservation, serverConnectionVersion, submissionScope, workspacePath]);

  useEffect(() => {
    cancelWorkspaceSend();
    if (!waitForWorkspace) return;
    let disposed = false;
    const unsubscribe = onWorkspaceSyncStateChanged(next => {
      if (!disposed) acceptWorkspaceObservation(next);
    });
    void refreshWorkspaceObservation();
    return () => { disposed = true; unsubscribe(); };
  }, [acceptWorkspaceObservation, cancelWorkspaceSend, refreshWorkspaceObservation, waitForWorkspace]);

  // Recall writes go through the same pair of stores a send reads: the state
  // (for the render) and inputValueRef (so an immediate Enter submits the
  // recalled text, not a stale value).
  const setInputFromHistory = useCallback((value: string) => {
    setInput(value);
    inputValueRef.current = value;
  }, [setInput]);
  const { recordSentMessage, handleHistoryKeyDown } = useInputHistory({
    setInput: setInputFromHistory,
    textareaRef,
    scope: draftScope,
  });

  const [queuedDraft, setQueuedDraft] = useState<QueuedDraft | null>(() => {
    if (typeof window === 'undefined' || !sessionKey) {
      return null;
    }
    return restoreQueuedDraft(sessionKey);
  });
  // Uploaded descriptors remain durable as this explicit editor removes/replaces attachments.
  useEffect(() => {
    if (!sessionKey || !manualQueueEditorsRef.current.has(manualEditorScope)) return;
    const saved = readQueuedMessage(sessionKey);
    if (saved?.autoSend !== false) return;
    const attachments = draftAttachments.flatMap(item => item.uploaded ? [item.uploaded] : []);
    if (JSON.stringify(attachments) === JSON.stringify(saved.attachments ?? [])) return;
    const scopeRevision = submissionScopeRef.current.revision;
    void writeQueuedMessage(sessionKey, { ...saved, attachments }).catch(error => {
      if (mountedRef.current && submissionScopeRef.current.revision === scopeRevision
        && manualEditorScopeRef.current === manualEditorScope) addMessage({
        type: 'error', content: `附件更新未确认，草稿已保留：${error instanceof Error ? error.message : String(error)}`,
        timestamp: new Date(),
      });
    });
  }, [addMessage, draftAttachments, manualEditorScope, sessionKey]);
  const handleBuiltInCommand = useCallback(
    (result: CommandExecutionResult) => {
      const { action, data } = result;
      switch (action) {
        case 'help':
          setCommandModalPayload({
            kind: 'help',
            data: (data || {}) as HelpCommandData,
          });
          break;

        case 'models':
          setCommandModalPayload({
            kind: 'models',
            data: (data || {}) as ModelCommandData,
          });
          break;

        case 'cost': {
          setCommandModalPayload({
            kind: 'cost',
            data: (data || {}) as CostCommandData,
          });
          break;
        }

        case 'status': {
          setCommandModalPayload({
            kind: 'status',
            data: (data || {}) as StatusCommandData,
          });
          break;
        }

        case 'memory':
          if (data.error) {
            addMessage({
              type: 'assistant',
              content: `Warning: ${data.message}`,
              timestamp: Date.now(),
            });
          } else {
            addMessage({
              type: 'assistant',
              content: `${data.message}\n\nPath: \`${data.path}\``,
              timestamp: Date.now(),
            });
            if (data.exists && onFileOpen) {
              onFileOpen(data.path);
            }
          }
          break;

        case 'config':
          onShowSettings?.();
          break;

        default:
          console.warn('Unknown built-in command action:', action);
      }
    },
    [onFileOpen, onShowSettings, addMessage],
  );

  const closeCommandModal = useCallback(() => {
    setCommandModalPayload(null);
  }, []);

  const handleCustomCommand = useCallback(async (result: CommandExecutionResult) => {
    const { content, hasBashCommands } = result;

    if (hasBashCommands) {
      const confirmed = window.confirm(
        'This command contains bash commands that will be executed. Do you want to proceed?',
      );
      if (!confirmed) {
        addMessage({
          type: 'assistant',
          content: 'Command execution cancelled',
          timestamp: Date.now(),
        });
        return;
      }
    }

    const commandContent = content || '';
    setInput(commandContent);
    inputValueRef.current = commandContent;
    const scopeRevision = submissionScopeRef.current.revision;
    const draftRevision = draftRevisionRef.current;
    const authVersion = getAuthSessionVersion();

    // Defer submit to next tick so the command text is reflected in UI before dispatching.
    setTimeout(() => {
      if (mountedRef.current && submissionScopeRef.current.revision === scopeRevision
        && draftRevisionRef.current === draftRevision && getAuthSessionVersion() === authVersion
        && handleSubmitRef.current) {
        handleSubmitRef.current(createFakeSubmitEvent());
      }
    }, 0);
  }, [addMessage, setInput]);

  const executeCommand = useCallback(
    async (command: SlashCommand, rawInput?: string, options?: { preserveInput?: boolean }) => {
      if (!command || !selectedProject) {
        return false;
      }
      const scopeRevision = submissionScopeRef.current.revision;
      const draftRevision = draftRevisionRef.current;
      const authVersion = getAuthSessionVersion();
      const current = () => mountedRef.current
        && submissionScopeRef.current.revision === scopeRevision
        && draftRevisionRef.current === draftRevision
        && getAuthSessionVersion() === authVersion;

      try {
        const effectiveInput = rawInput ?? input;
        const commandMatch = effectiveInput.match(new RegExp(`${escapeRegExp(command.name)}\\s*(.*)`));
        const args =
          commandMatch && commandMatch[1] ? commandMatch[1].trim().split(/\s+/) : [];

        // The `/api/commands/execute` context sends `projectId` now instead of
        // a folder-derived project name; the path is still included verbatim.
        const context = {
          projectPath: selectedProject.fullPath || selectedProject.path,
          projectId: selectedProject.projectId,
          sessionId: currentSessionId || selectedSession?.id || null,
          provider,
          model: currentProviderModel,
          tokenUsage: tokenBudget,
        };

        const response = await api.commands.execute({
          commandName: command.name,
          commandPath: command.path,
          args,
          context,
        });

        if (!response.ok) {
          let errorMessage = `Failed to execute command (${response.status})`;
          try {
            const errorData = await response.json();
            errorMessage = errorData?.message || errorData?.error || errorMessage;
          } catch {
            // Ignore JSON parse failures and use fallback message.
          }
          throw new Error(errorMessage);
        }

        const result = (await response.json()) as CommandExecutionResult;
        if (!current()) return false;
        if (result.type === 'builtin') {
          handleBuiltInCommand(result);
          if (!options?.preserveInput) {
            setInput('');
            inputValueRef.current = '';
          }
        } else if (result.type === 'custom') {
          await handleCustomCommand(result);
        }
        return true;
      } catch (error) {
        if (!current()) return false;
        const message = error instanceof Error ? error.message : 'Unknown error';
        console.error('Error executing command:', error);
        addMessage({
          type: 'assistant',
          content: `Error executing command: ${message}`,
          timestamp: Date.now(),
        });
        return false;
      }
    },
    [
      currentProviderModel,
      currentSessionId,
      handleBuiltInCommand,
      handleCustomCommand,
      input,
      provider,
      selectedProject,
      selectedSession?.id,
      addMessage,
      setInput,
      tokenBudget,
    ],
  );

  const showCostModal = useCallback(() => {
    executeCommand(
      {
        name: '/cost',
        description: 'Display token usage information',
        namespace: 'builtin',
        metadata: { type: 'builtin' },
      } as SlashCommand,
      '/cost',
      { preserveInput: true },
    );
  }, [executeCommand]);

  const executeCommandFromMenu = useCallback(async (command: SlashCommand, rawInput?: string) => {
    await executeCommand(command, rawInput);
  }, [executeCommand]);

  const {
    slashCommands,
    slashCommandsCount,
    filteredCommands,
    frequentCommands,
    commandQuery,
    showCommandMenu,
    selectedCommandIndex,
    resetCommandMenuState,
    handleCommandSelect,
    handleToggleCommandMenu,
    handleCommandInputChange,
    handleCommandMenuKeyDown,
  } = useSlashCommands({
    selectedProject,
    provider,
    input,
    setInput,
    textareaRef,
    onExecuteCommand: executeCommandFromMenu,
  });
  const canResumePausedDraft = queuedDraft?.autoSend === false && !(queuedDraft.claimRevision && isLoading)
    && (manualQueueEditorsRef.current.has(manualEditorScope) || (!input.trim() && draftAttachments.length === 0));
  const canSubmitWithoutModelOptions = canResumePausedDraft
    || resolveComposerCommand(input, slashCommands, isLoading).canSubmitWithoutModelOptions;

  const {
    showFileDropdown,
    filteredFiles,
    selectedFileIndex,
    renderInputWithMentions,
    selectFile,
    setCursorPosition,
    handleFileMentionsKeyDown,
  } = useFileMentions({
    isActive,
    selectedProject,
    input,
    setInput,
    textareaRef,
  });

  const syncInputOverlayScroll = useCallback((target: HTMLTextAreaElement) => {
    if (!inputHighlightRef.current || !target) {
      return;
    }
    inputHighlightRef.current.scrollTop = target.scrollTop;
    inputHighlightRef.current.scrollLeft = target.scrollLeft;
  }, []);

  const resizeTextarea = useCallback((target: HTMLTextAreaElement) => {
    target.style.height = 'auto';
    const nextHeight = Math.max(22, target.scrollHeight);
    target.style.height = `${nextHeight}px`;

    let lineHeight = textareaLineHeightRef.current;
    if (!lineHeight) {
      lineHeight = parseInt(window.getComputedStyle(target).lineHeight);
      textareaLineHeightRef.current = Number.isFinite(lineHeight) ? lineHeight : 24;
    }

    const expanded = nextHeight > (textareaLineHeightRef.current || 24) * 2;
    setIsTextareaExpanded((previous) => previous === expanded ? previous : expanded);
    lastAutosizedInputRef.current = target.value;
  }, []);

  const handleAttachmentFiles = useCallback((files: File[]) => {
    const validFiles = files.filter((file) => {
      try {
        if (!file || typeof file !== 'object') {
          console.warn('Invalid file object:', file);
          return false;
        }

        if (file.size > MAX_ATTACHMENT_SIZE) {
          const fileName = file.name || 'Unknown file';
          setFileErrors((previous) => {
            const next = new Map(previous);
            next.set(fileName, 'File too large (max 10MB)');
            return next;
          });
          return false;
        }

        return true;
      } catch (error) {
        console.error('Error validating file:', error, file);
        return false;
      }
    });

    if (validFiles.length > 0) {
      setAttachedFiles((previous) => [...previous, ...validFiles].slice(0, MAX_ATTACHMENT_COUNT));
    }
  }, [setAttachedFiles]);

  const handlePaste = useCallback(
    (event: ClipboardEvent<HTMLTextAreaElement>) => {
      const items = Array.from(event.clipboardData.items);

      items.forEach((item) => {
        if (!item.type.startsWith('image/')) {
          return;
        }
        const file = item.getAsFile();
        if (file) {
          handleAttachmentFiles([file]);
        }
      });

      if (items.length === 0 && event.clipboardData.files.length > 0) {
        const files = Array.from(event.clipboardData.files);
        const imageFiles = files.filter((file) => file.type.startsWith('image/'));
        if (imageFiles.length > 0) {
          handleAttachmentFiles(imageFiles);
        }
      }
    },
    [handleAttachmentFiles],
  );

  const { getRootProps, getInputProps, isDragActive, open } = useDropzone({
    maxSize: MAX_ATTACHMENT_SIZE,
    maxFiles: MAX_ATTACHMENT_COUNT,
    onDrop: handleAttachmentFiles,
    noClick: true,
    noKeyboard: true,
  });

  // Snapshot of everything `chat.send` needs beyond the text itself. Built at
  // send time for immediate sends and at queue time for queued ones, so a
  // queued message keeps the provider settings it was composed under even if
  // it is later dispatched outside this composer (app-level auto-send).
  const buildSendOptions = useCallback((currentInput: string): QueuedSendOptions => {
    const getToolsSettings = () => readUserPreference(
      PROVIDER_PERMISSION_PREFERENCE_KEYS[provider],
      {
        allowedTools: [],
        disallowedTools: [],
        skipPermissions: false,
      },
    );

    const toolsSettings = getToolsSettings();

    return {
      model: currentProviderModel,
      effort: currentProviderEffort,
      permissionMode: resolvePermissionModeForProvider(provider, permissionMode),
      toolsSettings,
      skipPermissions: toolsSettings?.skipPermissions || false,
      sessionSummary: getNotificationSessionSummary(selectedSession, currentInput),
    };
  }, [
    currentProviderEffort,
    currentProviderModel,
    permissionMode,
    provider,
    resolvePermissionModeForProvider,
    selectedSession,
  ]);

  const submitContent = useCallback(
    async (
      queuedSubmission?: ComposerSubmission,
    ) => {
      if (canSubmitCloud && !canSubmitCloud()) return false;
      const existingPending = workspacePendingRef.current;
      if (!queuedSubmission && existingPending
        && existingPending.scopeRevision === submissionScopeRef.current.revision
        && existingPending.draftRevision === draftRevisionRef.current
        && existingPending.authVersion === getAuthSessionVersion()
        && existingPending.connectionVersion === getServerConnectionVersion()) {
        if (existingPending.waiting) return false;
        // Retrying a paused intent keeps uploaded assets and an allocated session id.
        queuedSubmission = existingPending.submission;
        cancelWorkspaceSend();
      }
      const savedQueuedDraft = sessionKey ? restoreQueuedDraft(sessionKey) : null;
      if (!queuedSubmission && queuedDraft?.autoSend === false && savedQueuedDraft?.autoSend !== false
        && sessionKey && isChatDraftPending(sessionKey)) {
        addMessage({ type: 'error', content: '排队消息未确认，草稿已保留；请先确认或编辑队列，勿重复发送。', timestamp: new Date() });
        return false;
      }
      const ownsManualEditor = manualQueueEditorsRef.current.has(manualEditorScopeRef.current);
      const hasPausedQueue = savedQueuedDraft?.autoSend === false && !(savedQueuedDraft.claimRevision && isLoading);
      const submittingManualDraft = queuedSubmission?.autoSend === false || (!queuedSubmission && hasPausedQueue
        && (ownsManualEditor || (!inputValueRef.current.trim() && draftAttachments.length === 0)));
      if (submittingManualDraft && !queuedSubmission && savedQueuedDraft) {
        queuedSubmission = {
          ...savedQueuedDraft,
          content: ownsManualEditor ? inputValueRef.current : savedQueuedDraft.content,
          draftAttachments: ownsManualEditor ? draftAttachments : queuedAttachmentDraft(savedQueuedDraft),
        };
      }
      if (isLoading && hasPausedQueue && !submittingManualDraft) {
        addMessage({ type: 'error', content: '已有暂停的排队消息，请先编辑或取消它；本次新草稿和附件已保留。', timestamp: new Date() });
        return false;
      }
      const currentInput = queuedSubmission?.content ?? inputValueRef.current;
      const currentAttachmentItems = queuedSubmission
        ? queuedSubmission.draftAttachments ?? queuedAttachmentDraft(queuedSubmission)
        : draftAttachments;
      const currentAttachments = currentAttachmentItems.flatMap(item => item.file ? [item.file] : []);
      const previouslyUploadedAttachments = currentAttachmentItems.flatMap(item => item.uploaded ? [item.uploaded] : []);
      const { commandInput, isHelpAlias, matchedCommand, canSubmitWithoutModelOptions: immediateBuiltin } =
        resolveComposerCommand(currentInput, slashCommands, isLoading);
      // Resumed synchronization intents already captured known options before waiting.
      if (!queuedSubmission && !sessionOptionsReady && !immediateBuiltin) return false;
      if (
        (
          !currentInput.trim()
          && currentAttachments.length === 0
          && previouslyUploadedAttachments.length === 0
        )
        || !selectedProject
      ) {
        return;
      }

      const scopeRevision = submissionScopeRef.current.revision;
      if (pendingSubmitRef.current?.scopeRevision === scopeRevision) return false;
      const submission = { scopeRevision };
      pendingSubmitRef.current = submission;
      const authVersion = getAuthSessionVersion();
      const connectionVersion = getServerConnectionVersion();
      const bindingEpoch = waitForWorkspace ? workspaceObservationRef.current.info?.bindingEpoch || null : null;
      const draftRevision = draftRevisionRef.current;
      const submittedDraftScope = draftScopeRef.current;
      const submittedAttachmentScope = attachmentScopeRef.current;
      const scopeCurrent = () => mountedRef.current
        && submissionScopeRef.current.revision === scopeRevision
        && getAuthSessionVersion() === authVersion
        && getServerConnectionVersion() === connectionVersion;
      const draftCurrent = () => scopeCurrent() && draftRevisionRef.current === draftRevision;
      const resolveAttachments = async () => {
        const items = await uploadDraftAttachments(currentAttachmentItems);
        if (!draftCurrent()) return null;
        if (submittedAttachmentScope) setAttachmentDrafts(previous => new Map(previous).set(submittedAttachmentScope, items));
        return items;
      };
      let handedToSocket = false;

      try {
        const submittedOptions = submittingManualDraft ? queuedSubmission?.options
          : queuedSubmission?.options ?? buildSendOptions(currentInput);
        const retainUntilWorkspaceReady = (snapshot: ComposerSubmission): boolean => {
          if (!waitForWorkspace) return false;
          const { info, error } = workspaceObservationRef.current;
          if (bindingEpoch && info?.bindingEpoch !== bindingEpoch) {
            const cancelled: WorkspacePendingSend = {
              submission: snapshot,
              scopeRevision,
              draftRevision,
              authVersion,
              connectionVersion,
              bindingEpoch,
              waiting: false,
              notice: '项目绑定已改变，自动发送已取消，草稿已保留。',
            };
            workspacePendingRef.current = cancelled;
            setWorkspacePendingSend(cancelled);
            return true;
          }
          if (info?.status === 'ready' || info?.status === 'unbound') return false;
          // Existing model-run queues stay server owned; only synchronization waits locally.
          if (isLoading) return false;
          const waiting = !error && (!info || WORKSPACE_WAIT_STATUSES.has(info.status));
          const pending: WorkspacePendingSend = {
            submission: snapshot,
            scopeRevision,
            draftRevision,
            authVersion,
            connectionVersion,
            bindingEpoch: info?.bindingEpoch || null,
            waiting,
            notice: waiting
              ? '同步完成并释放工作区后自动发送。编辑内容会取消本次自动发送。'
              : `同步未完成，消息仍在草稿中，请恢复同步后重新发送。${error || info?.detail || ''}`,
          };
          workspacePendingRef.current = pending;
          setWorkspacePendingSend(pending);
          // Initial state is checked once; subsequent progress comes from native events.
          if (!info && !error) void refreshWorkspaceObservation();
          return true;
        };
        if (retainUntilWorkspaceReady({
          ...queuedSubmission,
          content: currentInput,
          attachments: currentAttachments,
          uploadedAttachments: previouslyUploadedAttachments,
          draftAttachments: currentAttachmentItems,
          options: submittedOptions,
        })) return false;

        // A turn is already in flight: stash this message instead of sending it.
        // Upload attached files now so the queued record contains durable image
        // descriptors that can be sent even if another session is open later.
        if (isLoading || submittingManualDraft) {
          const queuedSessionKey = queuedSubmission?.targetSessionId || sessionKey;
          if (!queuedSessionKey) throw new Error('排队消息尚未关联会话，请等待会话加载完成。');
          const resolvedAttachments = await resolveAttachments();
          if (!resolvedAttachments) return false;
          const uploadedAttachments = resolvedAttachments.flatMap(item => item.uploaded ? [item.uploaded] : []);

          const durableDraft: QueuedDraft = {
            content: currentInput,
            attachments: currentAttachments,
            uploadedAttachments,
            options: submittedOptions,
            autoSend: true,
          };
          // Do not clear the user's input until the server owns this queue.
          await writeQueuedMessage(queuedSessionKey, {
            content: durableDraft.content,
            options: durableDraft.options,
            attachments: durableDraft.uploadedAttachments,
            autoSend: true,
          });

          // Recorded under the session the message was queued FOR, and before
          // the session-switch return below — the queued text must be
          // recallable even when it dispatches without this composer.
          recordSentMessage(currentInput, queuedSessionKey);

          if (!scopeCurrent()) return true;

          manualQueueEditorsRef.current.delete(manualEditorScopeRef.current);
          setQueuedDraft(durableDraft);
          // A newer draft typed during the queue acknowledgement stays intact.
          if (!draftCurrent()) return true;
          setInput('');
          inputValueRef.current = '';
          clearDraftAttachments();
          setFileErrors(new Map());
          resetCommandMenuState();
          setIsTextareaExpanded(false);
          if (textareaRef.current) {
            textareaRef.current.style.height = 'auto';
          }
          if (submittedDraftScope) {
            writeDraftText(submittedDraftScope, '');
          }
          return;
        }

        if (matchedCommand && matchedCommand.type !== 'skill') {
          const executed = await executeCommand(matchedCommand, isHelpAlias ? '/help' : commandInput, { preserveInput: true });
          if (!executed || !draftCurrent()) return false;
          recordSentMessage(currentInput);
          setInput('');
          inputValueRef.current = '';
          clearDraftAttachments();
          setFileErrors(new Map());
          resetCommandMenuState();
          setIsTextareaExpanded(false);
          if (textareaRef.current) {
            textareaRef.current.style.height = 'auto';
          }
          return;
        }

        const messageContent = currentInput;

        const resolvedAttachments = await resolveAttachments();
        if (!resolvedAttachments) return false;
        const uploadedAttachments = resolvedAttachments.flatMap(item => item.uploaded ? [item.uploaded] : []);

        const resolvedProjectPath = selectedProject.fullPath || selectedProject.path || '';
        const sessionSummary = getNotificationSessionSummary(selectedSession, currentInput);

        // The conversation always has a stable backend-allocated session id
        // BEFORE the first websocket send: brand-new chats allocate one here
        // via the session gateway. There is no client-visible session-id
        // handoff later — this id stays valid for the conversation's lifetime.
        let targetSessionId = queuedSubmission?.targetSessionId || selectedSession?.id || currentSessionId || null;
        let createdSessionContext: SessionEstablishedContext | null = queuedSubmission?.createdSessionContext ?? null;
        if (!targetSessionId) {
          let createdSessionName = sessionSummary;
          try {
            const response = await api.providers.createSession({
              provider,
              projectPath: resolvedProjectPath,
              initialMessage: messageContent,
            });
            if (!response.ok) {
              throw new Error(`Failed to create session (${response.status})`);
            }
            const body = await response.json();
            if (!draftCurrent()) return false;
            targetSessionId = body?.data?.sessionId || null;
            // A blank server name would leave the session unlabeled, so the local
            // summary stays the fallback unless a real name comes back.
            const returnedSessionName = typeof body?.data?.sessionName === 'string'
              ? body.data.sessionName.trim()
              : '';
            if (returnedSessionName) {
              createdSessionName = returnedSessionName;
            }
          } catch (error) {
            if (!scopeCurrent()) return false;
            const message = error instanceof Error ? error.message : 'Unknown error';
            console.error('Session creation failed:', error);
            addMessage({
              type: 'error',
              content: `Failed to start a new session: ${message}`,
              timestamp: new Date(),
            });
            return;
          }

          if (!targetSessionId) {
            addMessage({
              type: 'error',
              content: 'Failed to start a new session: no session id returned.',
              timestamp: new Date(),
            });
            return;
          }

          createdSessionContext = {
            provider,
            project: selectedProject,
            summary: createdSessionName,
          };
        }

        const attachmentRecords = uploadedAttachments as ChatAttachment[];
        if (!draftCurrent()) return false;
        if (canSubmitCloud && !canSubmitCloud()) return false;
        if (retainUntilWorkspaceReady({
          content: currentInput,
          attachments: currentAttachments,
          uploadedAttachments,
          draftAttachments: resolvedAttachments,
          options: submittedOptions,
          autoSend: queuedSubmission?.autoSend,
          targetSessionId,
          createdSessionContext,
        })) return false;
        const userMessage: ChatMessage = {
          type: 'user',
          content: currentInput,
          images: attachmentRecords.filter(isImageAttachment),
          files: attachmentRecords.filter((attachment) => !isImageAttachment(attachment)),
          timestamp: new Date(),
          // Tags this echo as the replacement, so the truncation the server
          // broadcasts a moment later cuts the turns being replaced without
          // taking the message the user just sent with them.
          ...(editingAnchorId ? { replacesAnchorId: editingAnchorId } : {}),
        };

        // One message shape for every provider. The backend resolves the
        // provider, project path, and provider-native resume id from the
        // session row; `options` only carries composer-level preferences.
        sendMessage({
          // Replacing an already-sent message is its own frame: it changes the
          // shape of the conversation, so it gets validated separately and can
          // report why it was refused.
          type: editingAnchorId ? 'chat.edit-send' : 'chat.send',
          sessionId: targetSessionId,
          ...(editingAnchorId ? { anchorId: editingAnchorId } : {}),
          content: messageContent,
          options: {
            ...submittedOptions,
            attachments: uploadedAttachments,
          },
        });
        handedToSocket = true;
        // A closed socket throws before the optimistic echo or draft is changed.
        addMessage(userMessage);
        onSessionProcessing?.(targetSessionId, {
          statusText: null,
          canInterrupt: true,
        });
        setIsUserScrolledUp(false);
        setTimeout(() => scrollToBottom(), 100);
        setEditingAnchorId(null);

        // Recorded under the (possibly just-allocated) session id, so the first
        // message of a new chat lands in the history of the session the user is
        // navigated to. Queued drafts were recorded when they were queued; the
        // consecutive-duplicate check keeps this second call a no-op.
        recordSentMessage(currentInput, targetSessionId);
        setInput('');
        inputValueRef.current = '';
        resetCommandMenuState();
        clearDraftAttachments();
        setFileErrors(new Map());
        setIsTextareaExpanded(false);

        if (textareaRef.current) {
          textareaRef.current.style.height = 'auto';
        }

        if (submittedDraftScope) {
          writeDraftText(submittedDraftScope, '');
        }
        if (createdSessionContext) onSessionEstablished?.(targetSessionId, createdSessionContext);
        return true;
      } catch (error) {
        if (scopeCurrent()) {
          addMessage({
            type: 'error',
            content: `${handedToSocket ? '消息已交给聊天连接，界面更新未完成，请先刷新状态，勿重复发送' : isLoading || submittingManualDraft ? '排队消息未确认，草稿已保留，请先刷新状态再决定是否重试' : '消息未发送，草稿已保留'}：${error instanceof Error ? error.message : String(error)}`,
            timestamp: new Date(),
          });
        }
        return false;
      } finally {
        if (pendingSubmitRef.current === submission) pendingSubmitRef.current = null;
      }
    },
    [
      selectedSession,
      queuedDraft,
      draftAttachments,
      buildSendOptions,
      currentSessionId,
      editingAnchorId,
      executeCommand,
      isLoading,
      onSessionProcessing,
      onSessionEstablished,
      provider,
      recordSentMessage,
      resetCommandMenuState,
      scrollToBottom,
      selectedProject,
      sendMessage,
      canSubmitCloud,
      sessionOptionsReady,
      cancelWorkspaceSend,
      refreshWorkspaceObservation,
      waitForWorkspace,
      sessionKey,
      addMessage,
      clearDraftAttachments,
      setEditingAnchorId,
      setInput,
      setIsUserScrolledUp,
      slashCommands,
    ],
  );

  const handleSubmit = useCallback(async (
    event: FormEvent<HTMLFormElement> | MouseEvent | TouchEvent | KeyboardEvent<HTMLTextAreaElement>,
    queuedSubmission?: ComposerSubmission,
  ) => {
    event.preventDefault();
    await submitContent(queuedSubmission);
  }, [submitContent]);

  useEffect(() => {
    handleSubmitRef.current = handleSubmit;
  }, [handleSubmit]);

  const resumeWorkspaceSend = useCallback(() => {
    const pending = workspacePendingRef.current;
    if (!pending?.waiting) return;
    if (!mountedRef.current || !isActive
      || submissionScopeRef.current.revision !== pending.scopeRevision
      || draftRevisionRef.current !== pending.draftRevision
      || getAuthSessionVersion() !== pending.authVersion
      || getServerConnectionVersion() !== pending.connectionVersion) {
      cancelWorkspaceSend();
      return;
    }
    const { info, error } = workspaceObservationRef.current;
    if (!info && !error) return;
    const pause = (notice: string) => {
      const paused = { ...pending, waiting: false, notice };
      workspacePendingRef.current = paused;
      setWorkspacePendingSend(paused);
    };
    if (error || (pending.bindingEpoch && info?.bindingEpoch !== pending.bindingEpoch)) {
      pause('同步连接或项目绑定已改变，自动发送已取消，草稿已保留。');
      return;
    }
    if (!info) return;
    if (!pending.bindingEpoch) pending.bindingEpoch = info.bindingEpoch || null;
    if (WORKSPACE_WAIT_STATUSES.has(info.status)) return;
    if (info.status !== 'ready' && info.status !== 'unbound') {
      pause(`同步未完成，自动发送已暂停，草稿已保留。${info.detail || ''}`);
      return;
    }
    if (canSubmitCloud && !canSubmitCloud()) {
      pause('工作区尚未交还，自动发送已取消，草稿已保留。');
      return;
    }
    if (isLoading) return;
    // Claim the intent before async work so duplicate ready frames cannot dispatch twice.
    workspacePendingRef.current = null;
    setWorkspacePendingSend(null);
    void handleSubmitRef.current?.(createFakeSubmitEvent(), pending.submission);
  }, [canSubmitCloud, cancelWorkspaceSend, isActive, isLoading]);
  resumeWorkspaceSendRef.current = resumeWorkspaceSend;

  useEffect(() => {
    if (!isActive) cancelWorkspaceSend();
    else resumeWorkspaceSend();
  }, [cancelWorkspaceSend, isActive, resumeWorkspaceSend, workspacePendingSend]);

  const editWorkspaceSend = useCallback(() => {
    cancelWorkspaceSend();
    textareaRef.current?.focus();
  }, [cancelWorkspaceSend]);

  // Reconcile claims and pauses as complete snapshots; the VPS remains the only dispatcher.
  useEffect(() => {
    if (!sessionKey || !queuedDraft) {
      return;
    }
    let cancelled = false;
    const reconcile = async () => {
      await hydrateChatDrafts();
      if (!cancelled && !isChatDraftPending(sessionKey)) {
        setQueuedDraft(restoreQueuedDraft(sessionKey));
      }
    };
    const timer = setInterval(() => void reconcile(), 5_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [queuedDraft, sessionKey]);

  const cancelQueuedDraft = useCallback(async (edit: boolean) => {
    if (!queuedDraft || !sessionKey) return;
    const scopeRevision = submissionScopeRef.current.revision;
    if (pendingSubmitRef.current?.scopeRevision === scopeRevision) return;
    const operation = { scopeRevision };
    pendingSubmitRef.current = operation;
    if (edit) queueEditOperationRef.current = operation;
    const draftRevision = draftRevisionRef.current;
    const authVersion = getAuthSessionVersion();
    const connectionVersion = getServerConnectionVersion();
    const editorScope = manualEditorScopeRef.current;
    const current = () => mountedRef.current && submissionScopeRef.current.revision === scopeRevision
      && getAuthSessionVersion() === authVersion && getServerConnectionVersion() === connectionVersion;
    try {
      if (edit) await writeQueuedMessage(sessionKey, {
        content: queuedDraft.content,
        attachments: queuedDraft.uploadedAttachments,
        options: queuedDraft.options,
        autoSend: false,
      });
      else await clearQueuedMessage(sessionKey);
      if (!current()) return;
      setQueuedDraft(edit ? { ...queuedDraft, claimRevision: undefined, autoSend: false } : null);
      if (edit && draftRevisionRef.current === draftRevision) {
        const alreadyEditing = manualQueueEditorsRef.current.has(editorScope);
        manualQueueEditorsRef.current.add(editorScope);
        setInput(queuedDraft.content);
        if (!alreadyEditing) setDraftAttachments(queuedAttachmentDraft(queuedDraft));
        textareaRef.current?.focus();
        const restoredRevision = draftRevisionRef.current;
        await restoreQueuedOptionsRef.current?.(queuedDraft.options ?? {},
          () => current() && draftRevisionRef.current === restoredRevision);
      } else if (!edit) {
        manualQueueEditorsRef.current.delete(editorScope);
      }
    } catch (error) {
      if (current()) addMessage({
        type: 'error',
        content: `${edit ? '编辑排队消息未完成，完整草稿已保留' : '未确认取消排队消息，请勿重复发送'}：${error instanceof Error ? error.message : String(error)}`,
        timestamp: new Date(),
      });
    } finally {
      if (pendingSubmitRef.current === operation) pendingSubmitRef.current = null;
      if (queueEditOperationRef.current === operation) queueEditOperationRef.current = null;
    }
  }, [addMessage, queuedDraft, sessionKey, setDraftAttachments, setInput]);
  const editQueuedDraft = useCallback(() => { void cancelQueuedDraft(true); }, [cancelQueuedDraft]);
  const deleteQueuedDraft = useCallback(() => { void cancelQueuedDraft(false); }, [cancelQueuedDraft]);

  const beginQueuedOptionsChange = useCallback(() => {
    if (manualQueueEditorsRef.current.has(manualEditorScopeRef.current)
      || queueEditOperationRef.current?.scopeRevision === submissionScopeRef.current.revision) {
      draftRevisionRef.current++;
    }
  }, []);

  // Capture the rendered editor generation so a delayed model/effort response cannot patch A after A→B→A.
  const optionEditorRevision = submissionScopeRef.current.revision;
  const updateManualQueuedOptions = useCallback((options: QueuedSendOptions) => {
    if (!sessionKey || submissionScopeRef.current.revision !== optionEditorRevision
      || manualEditorScopeRef.current !== manualEditorScope || !manualQueueEditorsRef.current.has(manualEditorScope)) return;
    const saved = readQueuedMessage(sessionKey);
    if (saved?.autoSend !== false) return;
    cancelWorkspaceSend();
    draftRevisionRef.current++;
    void writeQueuedMessage(sessionKey, { ...saved, options: { ...saved.options, ...options } }).catch(error => {
      if (mountedRef.current && submissionScopeRef.current.revision === optionEditorRevision
        && manualEditorScopeRef.current === manualEditorScope) addMessage({
        type: 'error', content: `发送选项更新未确认，完整草稿已保留：${error instanceof Error ? error.message : String(error)}`,
        timestamp: new Date(),
      });
    });
  }, [addMessage, cancelWorkspaceSend, manualEditorScope, optionEditorRevision, sessionKey]);

  // A voice transcript either fills the input (to edit before sending) or, when the
  // user tapped "stop and send", is submitted straight away. Mirror the value into
  // inputValueRef synchronously so handleSubmit reads the new text, not the stale state.
  const handleVoiceTranscript = useCallback((text: string, send?: boolean) => {
    const base = inputValueRef.current.trim();
    const next = base ? `${base} ${text}` : text;
    setInput(next);
    inputValueRef.current = next;
    if (send) handleSubmitRef.current?.(createFakeSubmitEvent());
  }, [setInput]);

  useEffect(() => {
    inputValueRef.current = input;
  }, [input]);

  // Swap in the open scope's draft, and pick up one that arrives from another
  // device with the hydrated drafts.
  useEffect(() => {
    if (!draftScope) {
      return;
    }

    const restoreDraft = () => {
      const savedInput = readDraftText(draftScope);
      if (sessionKey && (!isChatDraftPending(sessionKey) || readQueuedMessage(sessionKey)?.autoSend === false)) {
        setQueuedDraft(restoreQueuedDraft(sessionKey));
      }
      setInputState((previous) => {
        if (previous.scope === draftScope && previous.value === savedInput) {
          return previous;
        }
        draftRevisionRef.current++;
        cancelWorkspaceSend();
        inputValueRef.current = savedInput;
        return { scope: draftScope, value: savedInput };
      });
    };

    restoreDraft();
    return subscribeToChatDrafts(restoreDraft);
  }, [cancelWorkspaceSend, draftScope, sessionKey]);

  // Only persist text that was typed for the scope it is about to be written
  // to; see the inputState declaration for why the scope travels with the text.
  useEffect(() => {
    if (!draftScope || inputState.scope !== draftScope) {
      return;
    }
    writeDraftText(draftScope, inputState.value);
  }, [inputState, draftScope]);

  // Switching sessions swaps in that session's queued draft. Browser File
  // objects are local to the mounted composer, while their already-uploaded
  // descriptors restore from storage and remain sendable.
  useEffect(() => {
    if (!sessionKey) {
      setQueuedDraft(null);
      return;
    }
    setQueuedDraft(restoreQueuedDraft(sessionKey));
  }, [sessionKey]);

  useEffect(() => {
    if (!textareaRef.current) {
      return;
    }
    if (lastAutosizedInputRef.current === input) {
      return;
    }
    // Re-run for restored drafts and programmatic input changes. User typing is
    // already resized in onInput, so this avoids doing the same forced layout twice.
    resizeTextarea(textareaRef.current);
  }, [input, resizeTextarea]);

  useEffect(() => {
    if (!textareaRef.current || input.trim()) {
      return;
    }
    textareaRef.current.style.height = 'auto';
    setIsTextareaExpanded(false);
  }, [input]);

  const handleInputChange = useCallback(
    (event: ChangeEvent<HTMLTextAreaElement>) => {
      const newValue = event.target.value;
      const cursorPos = event.target.selectionStart;

      setInput(newValue);
      inputValueRef.current = newValue;
      setCursorPosition(cursorPos);

      if (!newValue.trim()) {
        event.target.style.height = 'auto';
        setIsTextareaExpanded(false);
        resetCommandMenuState();
        return;
      }

      handleCommandInputChange(newValue, cursorPos);
    },
    [handleCommandInputChange, resetCommandMenuState, setCursorPosition, setInput],
  );

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      if (handleCommandMenuKeyDown(event)) {
        return;
      }

      if (handleFileMentionsKeyDown(event)) {
        return;
      }

      if (handleHistoryKeyDown(event)) {
        return;
      }

      if (event.key === 'Tab' && !showFileDropdown && !showCommandMenu) {
        event.preventDefault();
        beginQueuedOptionsChange();
        cyclePermissionMode();
        if (availablePermissionModes.length) {
          const current = availablePermissionModes.indexOf(permissionMode as PermissionMode);
          updateManualQueuedOptions({ permissionMode: availablePermissionModes[(current + 1) % availablePermissionModes.length] });
        }
        return;
      }

      if (event.key === 'Enter') {
        if (event.nativeEvent.isComposing) {
          return;
        }

        if ((event.ctrlKey || event.metaKey) && !event.shiftKey) {
          event.preventDefault();
          handleSubmit(event);
        } else if (!event.shiftKey && !event.ctrlKey && !event.metaKey && !sendByCtrlEnter) {
          event.preventDefault();
          handleSubmit(event);
        }
      }
    },
    [
      cyclePermissionMode,
      beginQueuedOptionsChange,
      availablePermissionModes,
      permissionMode,
      updateManualQueuedOptions,
      handleCommandMenuKeyDown,
      handleFileMentionsKeyDown,
      handleHistoryKeyDown,
      handleSubmit,
      sendByCtrlEnter,
      showCommandMenu,
      showFileDropdown,
    ],
  );

  const handleTextareaClick = useCallback(
    (event: MouseEvent<HTMLTextAreaElement>) => {
      setCursorPosition(event.currentTarget.selectionStart);
    },
    [setCursorPosition],
  );

  const handleTextareaInput = useCallback(
    (event: FormEvent<HTMLTextAreaElement>) => {
      const target = event.currentTarget;
      resizeTextarea(target);
      setCursorPosition(target.selectionStart);
      syncInputOverlayScroll(target);
    },
    [resizeTextarea, setCursorPosition, syncInputOverlayScroll],
  );

  const handleClearInput = useCallback(() => {
    setInput('');
    inputValueRef.current = '';
    resetCommandMenuState();
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.focus();
    }
    setIsTextareaExpanded(false);
  }, [resetCommandMenuState, setInput]);

  const handleAbortSession = useCallback(() => {
    if (!canAbortSession) {
      return;
    }

    const targetSessionId = selectedSession?.id || currentSessionId || null;
    if (!targetSessionId) {
      console.warn('Abort requested but no session ID is available.');
      return;
    }

    // The backend resolves the provider from the session row, so no provider
    // field is needed here.
    try {
      sendMessage({
        type: 'chat.abort',
        sessionId: targetSessionId,
      });
    } catch (error) {
      addMessage({
        type: 'error',
        content: `停止请求未发送，任务状态尚未改变：${error instanceof Error ? error.message : String(error)}`,
        timestamp: new Date(),
      });
    }
  }, [addMessage, canAbortSession, currentSessionId, selectedSession?.id, sendMessage]);

  const handleGrantToolPermission = useCallback(
    (suggestion: { entry: string; toolName: string }) => {
      if (!suggestion || provider !== 'claude') {
        return { success: false };
      }
      return grantClaudeToolPermission(suggestion.entry);
    },
    [provider],
  );

  const handlePermissionDecision = useCallback(
    (
      requestIds: string | string[],
      decision: { allow?: boolean; message?: string; rememberEntry?: string | null; updatedInput?: unknown },
    ) => {
      const ids = Array.isArray(requestIds) ? requestIds : [requestIds];
      const validIds = ids.filter(Boolean);
      if (validIds.length === 0) {
        return;
      }

      const sentIds: string[] = [];
      try {
        for (const requestId of validIds) {
          sendMessage({
            type: 'chat.permission-response',
            requestId,
            allow: Boolean(decision?.allow),
            updatedInput: decision?.updatedInput,
            message: decision?.message,
            rememberEntry: decision?.rememberEntry,
          });
          sentIds.push(requestId);
        }
      } catch (error) {
        addMessage({
          type: 'error',
          content: `权限回复未全部发送，未发送的请求已保留：${error instanceof Error ? error.message : String(error)}`,
          timestamp: new Date(),
        });
      }
      if (sentIds.length) {
        if (provider === 'claude' && decision.rememberEntry && decision.allow) grantClaudeToolPermission(decision.rememberEntry);
        setPendingPermissionRequests((previous) =>
          previous.filter((request) => !sentIds.includes(request.requestId)),
        );
      }
    },
    [addMessage, provider, sendMessage, setPendingPermissionRequests],
  );

  const [isInputFocused, setIsInputFocused] = useState(false);

  const handleInputFocusChange = useCallback(
    (focused: boolean) => {
      setIsInputFocused(focused);
    },
    [],
  );

  /** Loads an already-sent message back into the composer to be replaced. */
  const beginEditMessage = useCallback((message: ChatMessage) => {
    if (!message.transcriptAnchorId) return;
    setEditingAnchorId(message.transcriptAnchorId);
    setInput(message.content || '');
    inputValueRef.current = message.content || '';
    textareaRef.current?.focus();
  }, [setEditingAnchorId, setInput]);

  const cancelEditMessage = useCallback(() => {
    setEditingAnchorId(null);
    setInput('');
    inputValueRef.current = '';
  }, [setEditingAnchorId, setInput]);

  return {
    input,
    setInput,
    editingAnchorId,
    beginEditMessage,
    cancelEditMessage,
    textareaRef,
    inputHighlightRef,
    isTextareaExpanded,
    slashCommandsCount,
    filteredCommands,
    frequentCommands,
    commandQuery,
    showCommandMenu,
    selectedCommandIndex,
    resetCommandMenuState,
    handleCommandSelect,
    handleToggleCommandMenu,
    showFileDropdown,
    filteredFiles: filteredFiles as MentionableFile[],
    selectedFileIndex,
    renderInputWithMentions,
    selectFile,
    attachedFiles,
    draftAttachments,
    setAttachedFiles,
    removeDraftAttachment,
    updateManualQueuedOptions,
    beginQueuedOptionsChange,
    manualQueuedOptions: queuedDraft?.autoSend === false && manualQueueEditorsRef.current.has(manualEditorScope)
      ? queuedDraft.options ?? {} : null,
    captureDraftForSchedule,
    fileErrors,
    getRootProps,
    getInputProps,
    isDragActive,
    openAttachmentPicker: open,
    handleSubmit,
    canSubmitWithoutModelOptions,
    workspacePendingDraft: workspacePendingSend?.scopeRevision === submissionScopeRef.current.revision
      ? workspacePendingSend.submission : null,
    workspacePendingNotice: workspacePendingSend?.notice,
    isWaitingForWorkspace: Boolean(workspacePendingSend?.scopeRevision === submissionScopeRef.current.revision
      && workspacePendingSend.waiting),
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
  };
}
