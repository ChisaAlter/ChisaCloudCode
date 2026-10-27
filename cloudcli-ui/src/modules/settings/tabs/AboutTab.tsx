import { MessageSquare } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { APP_VERSION, CHISA_WORDMARK_FONT_FAMILY } from '@/shared/constants';

/** Settings uses this tab to identify the application and preserve its license attribution. */
export default function AboutTab() {
  const { t } = useTranslation('settings');

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/90 shadow-sm">
          <MessageSquare className="h-5 w-5 text-primary-foreground" />
        </div>
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-base font-semibold text-foreground" style={{ fontFamily: CHISA_WORDMARK_FONT_FAMILY }}>
              ChisaCloudCode
            </h3>
            {APP_VERSION && <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">v{APP_VERSION}</span>}
          </div>
          <p className="mt-0.5 text-sm text-muted-foreground">{t('about.tagline')}</p>
        </div>
      </div>
      <div className="space-y-2 border-t border-border/50 pt-4 text-xs text-muted-foreground">
        <p>{t('about.licensed')}</p>
        <p>{t('about.attribution')}</p>
      </div>
    </div>
  );
}
