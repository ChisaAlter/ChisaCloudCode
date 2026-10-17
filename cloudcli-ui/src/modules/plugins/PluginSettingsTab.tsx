import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2 } from 'lucide-react';

import { usePlugins } from '@/modules/plugins/context/PluginsContext';
import PluginIcon from '@/modules/plugins/PluginIcon';

const PLUGIN_TRANSLATIONS: Record<string, string> = {
  'project-stats': 'starterPlugin',
  'web-terminal': 'terminalPlugin',
  'workspace-scheduled-prompts': 'scheduledPromptPlugin',
  prism: 'prismCloudCLI',
  'session-manager': 'sessionManagerPlugin',
  'token-cost-calculator': 'tokenCostCalculatorPlugin',
  'task-queue': 'taskQueuePlugin',
  'claude-github-issue': 'githubIssuesBoardPlugin',
  'claude-usage': 'claudeUsagePlugin',
  'codex-usage': 'codexUsagePlugin',
};

/** Settings uses this tab to enable or disable plugins shipped with the app. */
export default function PluginSettingsTab() {
  const { t } = useTranslation('settings');
  const { plugins, loading, pluginsError, togglePlugin } = usePlugins();
  // Disable a switch while its server transition is in flight.
  const [pendingPlugins, setPendingPlugins] = useState<Set<string>>(new Set());
  // Keep switch failures beside the affected plugin without closing settings.
  const [toggleErrors, setToggleErrors] = useState<Record<string, string>>({});

  const handleToggle = async (name: string, enabled: boolean) => {
    setPendingPlugins((previous) => new Set(previous).add(name));
    setToggleErrors((previous) => { const next = { ...previous }; delete next[name]; return next; });
    const result = await togglePlugin(name, enabled);
    if (!result.success) setToggleErrors((previous) => ({ ...previous, [name]: result.error || t('pluginSettings.toggleFailed') }));
    setPendingPlugins((previous) => { const next = new Set(previous); next.delete(name); return next; });
  };

  return (
    <div className="space-y-5">
      <div>
        <h3 className="mb-1 text-base font-semibold text-foreground">{t('pluginSettings.title')}</h3>
        <p className="text-sm text-muted-foreground">{t('pluginSettings.bundledDescription', { defaultValue: '插件已随 ChisaCloudCode 内置，在这里开启或关闭。' })}</p>
      </div>
      {pluginsError && <p role="alert" className="text-sm text-destructive">{pluginsError}</p>}
      {loading ? (
        <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />{t('pluginSettings.scanningPlugins')}
        </div>
      ) : (
        <div className="space-y-2">
          {plugins.map((plugin) => {
            const translation = PLUGIN_TRANSLATIONS[plugin.name];
            const displayName = translation ? t(`pluginSettings.${translation}.name`) : plugin.displayName;
            const description = translation ? t(`pluginSettings.${translation}.description`) : plugin.description;
            return (
              <div key={plugin.name} className="rounded-lg border border-border bg-card p-4">
                <div className="grid grid-cols-[1.25rem_minmax(0,1fr)_2.25rem] items-start gap-3">
                  <PluginIcon pluginName={plugin.name} iconFile={plugin.icon} className="mt-0.5 h-5 w-5 text-foreground/80 [&>svg]:h-full [&>svg]:w-full" />
                  <div className="min-w-0">
                    <h4 className="text-sm font-semibold text-foreground">{displayName}</h4>
                    {description && <p className="mt-1 text-sm leading-snug text-muted-foreground">{description}</p>}
                    {toggleErrors[plugin.name] && <p role="alert" className="mt-2 text-sm text-destructive">{toggleErrors[plugin.name]}</p>}
                  </div>
                  <label className="relative mt-0.5 inline-flex h-5 w-9 cursor-pointer items-center">
                    <input type="checkbox" role="switch" className="peer sr-only" checked={plugin.enabled}
                      disabled={pendingPlugins.has(plugin.name)}
                      onChange={(event) => void handleToggle(plugin.name, event.target.checked)}
                      aria-label={`${displayName} · ${t(plugin.enabled ? 'pluginSettings.disable' : 'pluginSettings.enable')}`} />
                    <span aria-hidden="true" className="absolute inset-0 rounded-full bg-muted transition-colors peer-checked:bg-emerald-500 peer-disabled:opacity-50 peer-focus-visible:ring-2 peer-focus-visible:ring-ring peer-focus-visible:ring-offset-2" />
                    <span aria-hidden="true" className="relative ml-0.5 h-4 w-4 rounded-full bg-white shadow-sm transition-transform peer-checked:translate-x-4" />
                  </label>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
