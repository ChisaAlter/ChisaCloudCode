import { useEffect, useRef } from 'react';
import { Archive, Check, Edit2, GitBranch, Pin, PinOff, Trash2, X } from 'lucide-react';
import type { TFunction } from 'i18next';

import { ActionMenu } from '@/shared/ui';
import { cn } from '@/shared/utils';
import type { LLMProvider } from '@/shared/types';
import { useSessionForkingProviders } from '@/shared/hooks/useProviderCapabilities';
import { useProviderSessionIdCopy } from '@/modules/sidebar/hooks/useProviderSessionIdCopy';
import { PROVIDER_LABELS } from '@/modules/sidebar/utils/sidebarProjectFormatting';
import { usePinnedSessions } from '@/modules/sidebar/hooks/usePinnedSessions';

type SessionOptionsProps = {
  sessionId: string;
  sessionName: string;
  provider: LLMProvider;
  /**
   * The project that owns the session. Null where the row does not know it, in
   * which case rename is withheld rather than guessed — it is keyed by project.
   */
  projectId: string | null;
  /** A running session cannot be deleted or forked, matching the Projects row. */
  isProcessing: boolean;
  isEditing: boolean;
  renameDraft: string;
  onRenameDraftChange: (draft: string) => void;
  onStartEditingSession: (projectId: string, sessionId: string, initialName: string) => void;
  onCancelEditingSession: () => void;
  onSaveEditingSession: (projectId: string, sessionId: string, summary: string, provider: LLMProvider) => void;
  onDeleteSession: (sessionId: string, sessionTitle: string) => void;
  onArchiveSession?: (sessionId: string) => void;
  /** Bound by the caller, which owns the session object the fork needs. */
  onFork?: () => void;
  /** Withheld where the row has nowhere to send a delete. */
  canDelete?: boolean;
  className?: string;
  t: TFunction;
};

/**
 * A session row's controls: the options menu, and the inline rename that
 * replaces it while a rename is open.
 *
 * Shared by the Projects list and the Conversations list so the two rows cannot
 * drift — the first cut of the Conversations row copied this markup, which is
 * how two rows end up diverging one fix at a time. Callers keep only what is
 * genuinely theirs: where the controls sit, and whether deleting is offered.
 */
export default function SessionOptions({
  sessionId,
  sessionName,
  provider,
  projectId,
  isProcessing,
  isEditing,
  renameDraft,
  onRenameDraftChange,
  onStartEditingSession,
  onCancelEditingSession,
  onSaveEditingSession,
  onDeleteSession,
  onArchiveSession,
  onFork,
  canDelete = true,
  className,
  t,
}: SessionOptionsProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const providerLabel = PROVIDER_LABELS[provider];
  const { pinnedSessionIds, togglePinnedSession } = usePinnedSessions();
  const isPinned = pinnedSessionIds.has(sessionId);
  const { copyState, copyLabel, setOptionsOpen, handleCopyAction, isCopyPending, CopyStateIcon } =
    useProviderSessionIdCopy(sessionId, providerLabel);

  // Read from the backend capability matrix rather than branching on the
  // provider id here; the request is cached module-side, so every row shares one.
  const forkableProviders = useSessionForkingProviders();
  const canFork = Boolean(onFork) && forkableProviders.has(provider) && !isProcessing;

  // While editing, dismiss only when the click lands outside the rename panel,
  // matching Escape and the cancel button.
  useEffect(() => {
    if (!isEditing) {
      return;
    }

    const handlePointerDown = (event: MouseEvent) => {
      const container = containerRef.current;
      if (container && !container.contains(event.target as Node)) {
        onCancelEditingSession();
      }
    };

    document.addEventListener('mousedown', handlePointerDown);
    return () => document.removeEventListener('mousedown', handlePointerDown);
  }, [isEditing, onCancelEditingSession]);

  const saveRename = () => {
    if (projectId === null) {
      onCancelEditingSession();
      return;
    }
    onSaveEditingSession(projectId, sessionId, renameDraft, provider);
  };

  return (
    <div ref={containerRef} className={cn('flex items-center gap-1', !isEditing && 'pointer-events-none', className)}>
      {isEditing ? (
        <>
          <input
            type="text"
            value={renameDraft}
            onChange={(event) => onRenameDraftChange(event.target.value)}
            onKeyDown={(event) => {
              event.stopPropagation();
              if (event.key === 'Enter') {
                saveRename();
              } else if (event.key === 'Escape') {
                onCancelEditingSession();
              }
            }}
            onClick={(event) => event.stopPropagation()}
            className="w-32 rounded border border-border bg-background px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-primary"
            autoFocus
          />
          <button
            className="flex h-6 w-6 items-center justify-center rounded bg-green-50 hover:bg-green-100 dark:bg-green-900/20 dark:hover:bg-green-900/40"
            onClick={(event) => {
              event.stopPropagation();
              saveRename();
            }}
            title={t('tooltips.save')}
          >
            <Check className="h-3 w-3 text-green-600 dark:text-green-400" />
          </button>
          <button
            className="flex h-6 w-6 items-center justify-center rounded bg-gray-50 hover:bg-gray-100 dark:bg-gray-900/20 dark:hover:bg-gray-900/40"
            onClick={(event) => {
              event.stopPropagation();
              onCancelEditingSession();
            }}
            title={t('tooltips.cancel')}
          >
            <X className="h-3 w-3 text-gray-600 dark:text-gray-400" />
          </button>
        </>
      ) : (
        <>
        <div className={cn('flex items-center gap-0.5 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100', isPinned ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none group-hover:pointer-events-auto group-focus-within:pointer-events-auto')}>
          <button type="button" className="sidebar-icon h-6 w-6" aria-label={t(isPinned ? 'sessionMenu.unpin' : 'sessionMenu.pin')} title={t(isPinned ? 'sessionMenu.unpin' : 'sessionMenu.pin')}
            onClick={(event) => { event.stopPropagation(); togglePinnedSession(sessionId); }}>
            <Pin className={cn('h-3.5 w-3.5', isPinned && 'fill-current')} />
          </button>
          {canDelete && !isProcessing && onArchiveSession && (
            <button type="button" className="sidebar-icon h-6 w-6" aria-label={t('sessionMenu.archive')} title={t('sessionMenu.archive')}
              onClick={(event) => { event.stopPropagation(); onArchiveSession(sessionId); }}>
              <Archive className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
        <ActionMenu
          label={t('sessionMenu.options')}
          ariaLabel={t('sessionMenu.optionsFor', { name: sessionName })}
          contextMenuSelector="[data-session-row]"
          iconOnly
          portal
          variant="ghost"
          size="icon"
          onOpenChange={setOptionsOpen}
          triggerClassName="h-7 w-7 text-muted-foreground opacity-70 hover:bg-muted hover:opacity-100"
          menuClassName="pointer-events-auto w-[260px] rounded-xl p-1.5 shadow-xl"
          header={(
            <div className="mb-1 border-b border-border px-3 py-2">
              <p className="truncate text-xs font-medium text-foreground" title={sessionName}>
                {sessionName}
              </p>
              <p className="mt-0.5 text-[11px] text-muted-foreground">{t('sessionMenu.providerSession', { provider: providerLabel })}</p>
            </div>
          )}
          items={[
            ...(projectId !== null ? [{
              key: 'rename',
              label: t('sessionMenu.rename'),
              icon: Edit2,
              onSelect: () => onStartEditingSession(projectId, sessionId, sessionName),
            }] : []),
            {
              key: 'copy',
              label: copyLabel,
              description: copyState === 'error' ? t('sessionMenu.retry') : undefined,
              icon: CopyStateIcon,
              loading: isCopyPending,
              closeOnSelect: false,
              onSelect: handleCopyAction,
            },
            ...(canFork && onFork ? [{
              key: 'fork',
              label: t('sessionMenu.fork'),
              description: t('sessionMenu.forkDescription'),
              icon: GitBranch,
              onSelect: onFork,
            }] : []),
            {
              key: 'pin', label: t(isPinned ? 'sessionMenu.unpin' : 'sessionMenu.pin'),
              icon: isPinned ? PinOff : Pin, onSelect: () => togglePinnedSession(sessionId),
            },
            ...(canDelete && !isProcessing && onArchiveSession ? [{
              key: 'archive', label: t('sessionMenu.archive'), icon: Archive,
              onSelect: () => onArchiveSession(sessionId),
            }] : []),
            ...(canDelete && !isProcessing ? [{
              key: 'delete',
              label: t('sessionMenu.archiveOrDelete'),
              icon: Trash2,
              isDanger: true,
              showDividerBefore: true,
              onSelect: () => onDeleteSession(sessionId, sessionName),
            }] : []),
          ]}
        />
        </>
      )}
    </div>
  );
}
