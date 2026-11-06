import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';

import { Shimmer } from '@/shared/ui';
import type { BackgroundTaskSummary, SessionActivity } from '@/shared/types';
import { describeBackgroundTask, ownBackgroundTasks } from '@/modules/chat/utils/backgroundTasks';

type ActivityIndicatorProps = {
  activity: SessionActivity | null;
  onAbort?: () => void;
  isInputFocused?: boolean;
};

const EXIT_ANIMATION_MS = 220;

/** What the background work is: the one task by kind and name, or how many when there are several. */
function describeBackgroundTasks(allTasks: BackgroundTaskSummary[], t: TFunction): string {
  const tasks = ownBackgroundTasks(allTasks);
  return tasks.length === 1
    ? describeBackgroundTask(tasks[0], t)
    : t('claudeStatus.backgroundTask.count', { count: tasks.length, defaultValue: '{{count}} tasks' });
}

/**
 * Minimal response-in-progress indicator, in the spirit of the inline status
 * lines in Claude Code / Codex / OpenCode: a shimmering activity label, the
 * elapsed time, and an interrupt affordance. Rendered only while the viewed
 * session has an entry in the processing map; it disappears the instant that
 * entry is removed.
 *
 * A session whose turn has ended while the tasks it launched still run is
 * drawn in the workflow and agent cards' purple, naming the work, and with no
 * Stop: nothing is responding, and the composer can send.
 *
 * Rendered by chat's ChatComposer above the input so the user can see and
 * interrupt the in-flight turn without leaving the composer.
 */
export default function ActivityIndicator({ activity, onAbort, isInputFocused = false }: ActivityIndicatorProps) {
  const { t } = useTranslation('chat');
  const [renderedActivity, setRenderedActivity] = useState<SessionActivity | null>(activity);
  const [isExiting, setIsExiting] = useState(false);
  const startedAt = renderedActivity?.startedAt ?? null;
  const [elapsedSeconds, setElapsedSeconds] = useState(0);

  useEffect(() => {
    if (activity) {
      setRenderedActivity(activity);
      setIsExiting(false);
      return;
    }

    if (!renderedActivity) return;

    setIsExiting(true);
    const timer = setTimeout(() => {
      setRenderedActivity(null);
      setIsExiting(false);
    }, EXIT_ANIMATION_MS);

    return () => clearTimeout(timer);
  }, [activity, renderedActivity]);

  useEffect(() => {
    if (startedAt === null) return;
    const update = () => setElapsedSeconds(Math.max(0, Math.floor((Date.now() - startedAt) / 1000)));
    update();
    const timer = setInterval(update, 1000);
    return () => clearInterval(timer);
  }, [startedAt]);

  if (!renderedActivity) return null;

  const fallbackLabel = t('claudeStatus.actions.thinking', { defaultValue: 'Thinking' });
  const statusText = renderedActivity.statusText === 'workspace_finalizing'
    ? t('claudeStatus.actions.workspaceFinalizing', { defaultValue: '正在完成云端工作区操作' })
    : renderedActivity.statusText === 'background_work'
      ? t('claudeStatus.actions.backgroundWork', { defaultValue: '后台任务仍在执行' })
      : renderedActivity.statusText;
  const isBackground = Boolean(renderedActivity.background);
  const label = isBackground ? t('claudeStatus.backgroundWork', 'Background work') : (statusText || fallbackLabel).replace(/\.+$/, '');
  const detail = isBackground ? describeBackgroundTasks(renderedActivity.tasks ?? [], t) : '';
  const minutes = Math.floor(elapsedSeconds / 60);
  const seconds = elapsedSeconds % 60;
  const elapsedLabel = elapsedSeconds < 1
    ? ''
    : minutes < 1
      ? t('claudeStatus.elapsed.seconds', { count: seconds, defaultValue: '{{count}}s' })
      : t('claudeStatus.elapsed.minutesSeconds', { minutes, seconds, defaultValue: '{{minutes}}m {{seconds}}s' });

  return (
    <div className={isExiting ? 'chat-activity-exit' : 'chat-activity-enter'}>
      <div className={`flex h-9 items-center gap-2 rounded-xl border bg-card px-3 text-xs ${
        isInputFocused ? 'border-primary/30' : 'border-border/60'
      }`}>
        <span className={`h-1.5 w-1.5 shrink-0 animate-pulse rounded-full ${isBackground ? 'bg-purple-500 dark:bg-purple-400' : 'bg-[#ef73b0]'}`} aria-hidden />
        <Shimmer className="shrink-0 font-medium">{label}</Shimmer>
        {detail && <span className="min-w-0 truncate text-muted-foreground" title={detail}>{detail}</span>}
        {elapsedLabel && <span className="tabular-nums text-muted-foreground">{elapsedLabel}</span>}
        <span className="flex-1" />
        {renderedActivity.canInterrupt && onAbort && (
          <button
            type="button"
            onClick={onAbort}
            className="pointer-events-auto inline-flex items-center gap-1.5 rounded-md px-1.5 py-1 text-muted-foreground hover:text-destructive"
            aria-label={t('claudeStatus.controls.stopGeneration', { defaultValue: 'Stop generation' })}
            title={t('claudeStatus.controls.pressEscToStop', { defaultValue: 'Press Esc to stop' })}
          >
            <svg className="h-2.5 w-2.5 fill-current" viewBox="0 0 24 24" aria-hidden>
              <rect x="6" y="6" width="12" height="12" rx="1.5" />
            </svg>
            <span>{t('claudeStatus.stop', { defaultValue: 'Stop' })}</span>
          </button>
        )}
      </div>
    </div>
  );
}
