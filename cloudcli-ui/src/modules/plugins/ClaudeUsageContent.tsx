import { useTranslation } from 'react-i18next';

import { useAuth } from '@/modules/auth';
import { ClaudeUsagePanel } from '@/modules/plugins/ClaudeUsagePanel';
import { usePlugins } from '@/modules/plugins/context/PluginsContext';
import { Button } from '@/shared/ui';

/** Sidebar's account popup mounts the VPS-backed Claude quota when opened. */
export function ClaudeUsageContent() {
  const { t } = useTranslation('settings');
  const { user } = useAuth();
  const { plugins, loading, pluginsError, refreshPlugins } = usePlugins();
  const plugin = plugins.find((candidate) => candidate.name === 'claude-usage');
  if (loading && !plugin) return <p className="p-4 text-sm text-muted-foreground">{t('pluginSettings.scanningPlugins')}</p>;
  return <div>
    {pluginsError && <div className="space-y-3 p-4">
      <p role="alert" className="break-words text-sm text-destructive">{pluginsError}</p>
      <Button variant="outline" disabled={loading} onClick={() => void refreshPlugins()}>{t('common:buttons.retry')}</Button>
    </div>}
    {plugin?.enabled
      ? <ClaudeUsagePanel key={JSON.stringify([user?.id, user?.username])} />
      : !pluginsError && <p className="p-4 text-sm text-muted-foreground">{t('pluginSettings.usageDisabled', { defaultValue: 'Claude 额度已关闭，可在插件设置中启用。' })}</p>}
  </div>;
}
