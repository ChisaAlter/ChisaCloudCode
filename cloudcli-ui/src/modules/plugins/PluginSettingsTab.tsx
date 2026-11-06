import { useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2 } from 'lucide-react';

import { getAuthSessionSnapshot, isCurrentAuthSession, subscribeToAuthSession } from '@/modules/auth-session';
import { api, readApiErrorMessage } from '@/shared/api';
import type { Plugin } from '@/shared/types';
import { usePlugins } from '@/modules/plugins/context/PluginsContext';
import PluginIcon from '@/modules/plugins/PluginIcon';

const PLUGIN_TRANSLATIONS: Record<string, string> = {
  'project-stats': 'starterPlugin', 'web-terminal': 'terminalPlugin', 'workspace-scheduled-prompts': 'scheduledPromptPlugin',
  prism: 'prismCloudCLI', 'session-manager': 'sessionManagerPlugin', 'token-cost-calculator': 'tokenCostCalculatorPlugin',
  'task-queue': 'taskQueuePlugin', 'claude-github-issue': 'githubIssuesBoardPlugin', 'claude-usage': 'claudeUsagePlugin',
  'codex-usage': 'codexUsagePlugin', 'glm-usage': 'glmUsagePlugin', 'agent-monitor': 'agentMonitorPlugin',
};

/** Settings reviews exact plugin versions and permissions before the installation owner grants execution. */
export default function PluginSettingsTab() {
  const { t } = useTranslation('settings');
  const { plugins, loading, pluginsError, togglePlugin } = usePlugins();
  const session = useSyncExternalStore(subscribeToAuthSession, getAuthSessionSnapshot, getAuthSessionSnapshot);
  // Mutations reserve a plugin until the server confirms its lifecycle transition.
  const [pending, setPending] = useState<Set<string>>(new Set());
  // Errors stay adjacent to the affected review rather than disappearing with settings.
  const [errors, setErrors] = useState<Record<string, { sessionId: string; message: string }>>({});
  // The review is immutable and tied to the account that fetched it; confirmation never reads a new account's JWT.
  const [review, setReview] = useState<{ plugin: Plugin; session: typeof session } | null>(null);
  // Explicit checkbox consent is required again for every fetched digest.
  const [confirmed, setConfirmed] = useState(false);
  const currentReview = review && isCurrentAuthSession(review.session) && session.phase === 'ready' ? review : null;
  const errorText = async (response: Response) => {
    try { return readApiErrorMessage(await response.json()) ?? `Plugin request failed (${response.status})`; }
    catch { return `Plugin request failed (${response.status})`; }
  };
  const run = async (name: string, work: () => Promise<void>) => {
    const captured = session;
    setPending(prior => new Set(prior).add(name));
    setErrors(prior => { const next = { ...prior }; delete next[name]; return next; });
    try { await work(); } catch (error) {
      if (isCurrentAuthSession(captured)) setErrors(prior => ({ ...prior, [name]: { sessionId: captured.sessionInstanceId, message: error instanceof Error ? error.message : String(error) } }));
    }
    finally { setPending(prior => { const next = new Set(prior); next.delete(name); return next; }); }
  };
  const reviewPlugin = (name: string) => run(name, async () => {
    const captured = session;
    const response = await api.plugins.review(name, { expectedSession: captured });
    if (!response.ok) throw new Error(await errorText(response));
    const plugin: Plugin = await response.json();
    if (!isCurrentAuthSession(captured)) throw new DOMException('Plugin account session changed', 'AbortError');
    if (plugin.security?.model !== 'trusted-only' || !/^sha256:[a-f0-9]{64}$/.test(plugin.security.digest)) throw new Error('The server did not provide a reviewable plugin digest.');
    setReview({ plugin, session: captured }); setConfirmed(false);
  });
  const disable = (name: string) => run(name, async () => {
    const result = await togglePlugin(name, false);
    if (!result.success) throw new Error(result.error ?? t('pluginSettings.toggleFailed'));
  });
  const approve = () => {
    if (!currentReview?.plugin.security || !confirmed) return;
    const capturedReview = currentReview;
    void run(capturedReview.plugin.name, async () => {
      if (!isCurrentAuthSession(capturedReview.session)) throw new DOMException('Plugin account session changed', 'AbortError');
      const security = capturedReview.plugin.security!;
      const result = await togglePlugin(capturedReview.plugin.name, true, { confirmed: true,
        expectedDigest: security.digest, grantedPermissions: [...security.permissions] });
      if (!result.success) throw new Error(result.error ?? t('pluginSettings.toggleFailed'));
      setReview(null); setConfirmed(false);
    });
  };
  return <div className="space-y-5">
    <div><h3 className="mb-1 text-base font-semibold text-foreground">{t('pluginSettings.title')}</h3>
      <p className="text-sm text-muted-foreground">Only trusted extensions run. Review source, version, digest and permissions before enabling. Community resources must be staged locally by the installation owner; network command installation is disabled.</p></div>
    {pluginsError && <p role="alert" className="text-sm text-destructive">{pluginsError}</p>}
    {loading ? <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />{t('pluginSettings.scanningPlugins')}</div>
      : <div className="space-y-2">{plugins.map(plugin => {
        const translation = PLUGIN_TRANSLATIONS[plugin.name];
        const displayName = translation ? t(`pluginSettings.${translation}.name`) : plugin.displayName;
        const description = translation ? t(`pluginSettings.${translation}.description`) : plugin.description;
        return <div key={plugin.name} className="rounded-lg border border-border bg-card p-4">
          <div className="grid grid-cols-[1.25rem_minmax(0,1fr)_2.25rem] items-start gap-3">
            <PluginIcon pluginName={plugin.name} iconFile={plugin.icon} className="mt-0.5 h-5 w-5 text-foreground/80 [&>svg]:h-full [&>svg]:w-full" />
            <div className="min-w-0"><h4 className="text-sm font-semibold text-foreground">{displayName}</h4>
              {description && <p className="mt-1 text-sm leading-snug text-muted-foreground">{description}</p>}
              <p className="mt-1 break-all text-xs text-muted-foreground">{plugin.version} · {plugin.security?.source.location ?? 'Unverified source'} · {plugin.security?.permitted ? 'Trusted and permitted' : 'Review required'}</p>
              <button type="button" className="mt-2 text-sm underline" disabled={pending.has(plugin.name)} onClick={() => void reviewPlugin(plugin.name)}>Review version and permissions</button>
              {errors[plugin.name]?.sessionId === session.sessionInstanceId && <p role="alert" className="mt-2 text-sm text-destructive">{errors[plugin.name].message}</p>}
            </div>
            <label className="relative mt-0.5 inline-flex h-5 w-9 cursor-pointer items-center">
              <input type="checkbox" role="switch" className="peer sr-only" checked={plugin.enabled}
                disabled={pending.has(plugin.name) || session.phase !== 'ready'}
                onChange={event => { if (event.target.checked) void reviewPlugin(plugin.name); else void disable(plugin.name); }}
                aria-label={`${displayName} · ${t(plugin.enabled ? 'pluginSettings.disable' : 'pluginSettings.enable')}`} />
              <span aria-hidden="true" className="absolute inset-0 rounded-full bg-muted transition-colors peer-checked:bg-emerald-500 peer-disabled:opacity-50 peer-focus-visible:ring-2 peer-focus-visible:ring-ring peer-focus-visible:ring-offset-2" />
              <span aria-hidden="true" className="relative ml-0.5 h-4 w-4 rounded-full bg-white shadow-sm transition-transform peer-checked:translate-x-4" />
            </label>
          </div>
        </div>;
      })}</div>}
    {currentReview && <section aria-label="Plugin trust review" className="space-y-3 rounded-lg border border-border p-4">
      <h4 className="text-sm font-semibold">{currentReview.plugin.displayName} · {currentReview.plugin.version}</h4>
      <dl className="space-y-2 break-all text-sm"><div><dt>Source</dt><dd>{currentReview.plugin.security!.source.location}</dd></div>
        <div><dt>SHA-256</dt><dd>{currentReview.plugin.security!.digest}</dd></div></dl>
      <p className="text-sm">This trusted extension can run in the application origin. Backend process permission also permits commands and filesystem/network access as the application identity. Untrusted isolation is unavailable.</p>
      <ul className="list-inside list-disc text-sm">{currentReview.plugin.security!.permissions.map(permission => <li key={permission}>{permission}</li>)}</ul>
      <label className="flex gap-2 text-sm"><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} />I trust this exact source and digest and permit all listed capabilities.</label>
      <div className="flex flex-wrap gap-3"><button type="button" className="rounded-md bg-primary px-3 py-2 text-sm text-primary-foreground" disabled={!confirmed || pending.has(currentReview.plugin.name)} onClick={approve}>Trust and enable this version</button>
        <button type="button" className="rounded-md border border-border px-3 py-2 text-sm" onClick={() => { setReview(null); setConfirmed(false); }}>Cancel</button></div>
    </section>}
  </div>;
}
