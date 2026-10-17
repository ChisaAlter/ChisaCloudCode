import { MessageSquare } from 'lucide-react';
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';

import { APP_VERSION, CHISA_WORDMARK_FONT_FAMILY } from '@/shared/constants';
import { useComponentVersions } from '@/shared/hooks/useComponentVersions';
import type { ComponentBuildIdentity } from '@/shared/types';
import { isDesktop } from '@/shared/chisa';

/** Settings uses this tab to identify the application and preserve its license attribution. */
export default function AboutTab() {
  const { t } = useTranslation('settings');
  const versions = useComponentVersions();
  const { refresh } = versions;
  useEffect(() => { void refresh(); }, [refresh]);
  const describe = (value: ComponentBuildIdentity) => `${value.version ?? '未知'} · ${value.commit?.slice(0, 12) ?? '源码标识未知'}${value.dirty === true ? ' · 含未提交修改' : value.dirty === null ? ' · 源码状态未知' : ''}`;

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
      <div className="space-y-3 border-t border-border/50 pt-4 text-sm">
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2">
          <dt className="text-muted-foreground">桌面客户端</dt><dd className="break-words">{isDesktop() ? describe(versions.client) : '当前为浏览器，不适用'}</dd>
          <dt className="text-muted-foreground">前端界面</dt><dd className="break-words">{describe(versions.frontend)}</dd>
          <dt className="text-muted-foreground">当前服务端</dt><dd className="break-words">{describe(versions.server)}</dd>
        </dl>
        <p className="text-xs text-muted-foreground">未知表示尚未读取、连接不可用或此版本未提供标识。含未提交修改的构建不能仅凭源码标识还原。</p>
        <button type="button" disabled={versions.loading} onClick={() => void versions.refresh()} className="rounded border border-border px-3 py-1.5 outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50">{versions.loading ? '正在读取版本…' : '刷新版本'}</button>
      </div>
      <div className="space-y-2 border-t border-border/50 pt-4 text-xs text-muted-foreground">
        <p>{t('about.licensed')}</p>
        <p>{t('about.attribution')}</p>
      </div>
    </div>
  );
}
