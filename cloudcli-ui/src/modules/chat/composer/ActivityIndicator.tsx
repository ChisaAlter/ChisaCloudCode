import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Shimmer } from '@/shared/ui';
import type { SessionActivity } from '@/shared/types';

type ActivityIndicatorProps = {
  activity: SessionActivity | null;
  onAbort?: () => void;
  isInputFocused?: boolean;
};

const EXIT_ANIMATION_MS = 220;

/**
 * One status row above the composer while a turn is running: the current
 * activity, elapsed time after the first second, and stop. Rendered by
 * ChatComposer; it leaves as soon as the session drops out of the processing map.
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
  const label = (statusText || fallbackLabel).replace(/\.+$/, '');
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
        <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-[#ef73b0]" aria-hidden />
        <Shimmer className="font-medium">{label}</Shimmer>
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
