import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from 'react-i18next';

import { api, readApiJson } from '@/shared/api';
import { Button, Input } from '@/shared/ui';

type HiRouteSettings = {
  enabled: boolean;
  baseUrl: string;
  routeModel: string;
  hasAuthToken: boolean;
};

type HiRouteResponse = { success: true; data: HiRouteSettings };

type Feedback = { kind: 'error' | 'success'; message: string };

/** Used by settings' Claude account and models tabs to configure routing for the current user. */
export function HiRouteSettingsSection() {
  const { t } = useTranslation('settings');
  // The editable server snapshot also records token presence without ever loading its value.
  const [settings, setSettings] = useState<HiRouteSettings | null>(null);
  // A replacement secret lives only in this mounted form and is discarded after a successful save.
  const [authToken, setAuthToken] = useState('');
  // Clearing a stored secret must be an explicit choice, separate from an empty replacement field.
  const [clearToken, setClearToken] = useState(false);
  // Failed initial loads keep the form unavailable so defaults cannot overwrite stored settings.
  const [loadError, setLoadError] = useState(false);
  // Retrying explicitly starts a fresh request after a failed initial load.
  const [loadAttempt, setLoadAttempt] = useState(0);
  // Saving locks the form until the server confirms the update.
  const [saving, setSaving] = useState(false);
  // Validation and request outcomes are announced beside the form that caused them.
  const [feedback, setFeedback] = useState<Feedback | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await api.providers.hiroute.settings({ signal: controller.signal });
        const { data } = await readApiJson<HiRouteResponse>(response);
        if (!controller.signal.aborted) {
          setSettings({ enabled: data.enabled, baseUrl: data.baseUrl, routeModel: data.routeModel, hasAuthToken: data.hasAuthToken });
        }
      } catch {
        if (!controller.signal.aborted) setLoadError(true);
      }
    })();
    return () => controller.abort();
  }, [loadAttempt]);

  async function saveSettings(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!settings || saving) return;
    setFeedback(null);
    const baseUrl = settings.baseUrl.trim();
    const routeModel = settings.routeModel.trim();
    const replacementToken = authToken.trim();

    if (baseUrl) {
      try {
        const url = new URL(baseUrl);
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash
          || /\/v1(?:\/messages)?\/?$/.test(url.pathname)) throw new Error('Invalid base URL');
      } catch {
        setFeedback({ kind: 'error', message: t('hiroute.invalidUrl') });
        return;
      }
    }
    if (settings.enabled && (!baseUrl || !routeModel || clearToken || (!settings.hasAuthToken && !replacementToken))) {
      setFeedback({ kind: 'error', message: t('hiroute.required') });
      return;
    }

    setSaving(true);
    try {
      const response = await api.providers.hiroute.saveSettings({
        enabled: settings.enabled,
        baseUrl,
        routeModel,
        // An omitted token retains the stored secret; only an explicit null removes it.
        ...(clearToken ? { authToken: null } : replacementToken ? { authToken: replacementToken } : {}),
      });
      const { data } = await readApiJson<HiRouteResponse>(response);
      setSettings({ enabled: data.enabled, baseUrl: data.baseUrl, routeModel: data.routeModel, hasAuthToken: data.hasAuthToken });
      setAuthToken('');
      setClearToken(false);
      setFeedback({ kind: 'success', message: t('hiroute.saved') });
    } catch {
      setFeedback({ kind: 'error', message: t('hiroute.saveFailed') });
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="space-y-4 rounded-lg border border-border p-4" aria-label={t('hiroute.title')}>
      <div className="space-y-2">
        <h4 className="font-medium text-foreground">{t('hiroute.title')}</h4>
        <p className="text-sm text-muted-foreground">{t('hiroute.description')}</p>
        <p className="text-sm text-muted-foreground">{t('hiroute.switching')}</p>
      </div>
      {!settings ? (
        loadError ? (
          <div className="space-y-2">
            <p role="alert" className="text-sm text-red-600 dark:text-red-400">{t('hiroute.loadFailed')}</p>
            <Button type="button" variant="outline" size="sm" onClick={() => { setLoadError(false); setLoadAttempt(attempt => attempt + 1); }}>{t('hiroute.retry')}</Button>
          </div>
        ) : <p role="status" className="text-sm text-muted-foreground">{t('hiroute.loading')}</p>
      ) : (
        <form onSubmit={saveSettings} noValidate className="space-y-4">
          <fieldset disabled={saving} className="space-y-4">
            <label className="flex items-center gap-2 text-sm font-medium text-foreground">
              <input type="checkbox" checked={settings.enabled} onChange={event => { setSettings({ ...settings, enabled: event.target.checked }); setFeedback(null); }} />
              {t('hiroute.enable')}
            </label>
            <label className="block space-y-1">
              <span className="text-sm font-medium text-foreground">{t('hiroute.baseUrl')}</span>
              <Input type="url" value={settings.baseUrl} placeholder="https://hiroute.example.com" onChange={event => { setSettings({ ...settings, baseUrl: event.target.value }); setFeedback(null); }} />
              <span className="block text-xs text-muted-foreground">{t('hiroute.baseUrlHelp')}</span>
            </label>
            <label className="block space-y-1">
              <span className="text-sm font-medium text-foreground">{t('hiroute.routeModel')}</span>
              <Input value={settings.routeModel} onChange={event => { setSettings({ ...settings, routeModel: event.target.value }); setFeedback(null); }} />
            </label>
            <label className="block space-y-1">
              <span className="text-sm font-medium text-foreground">{t('hiroute.authToken')}</span>
              <Input type="password" autoComplete="new-password" spellCheck={false} value={authToken} disabled={clearToken} onChange={event => { setAuthToken(event.target.value); setFeedback(null); }} />
              <span className="block text-xs text-muted-foreground">{t(settings.hasAuthToken ? 'hiroute.tokenStored' : 'hiroute.tokenMissing')}</span>
              <span className="block text-xs text-muted-foreground">{t('hiroute.tokenHelp')}</span>
            </label>
            {settings.hasAuthToken && (
              <label className="flex items-center gap-2 text-sm text-foreground">
                <input type="checkbox" checked={clearToken} onChange={event => { setClearToken(event.target.checked); setAuthToken(''); setFeedback(null); }} />
                {t('hiroute.clearToken')}
              </label>
            )}
            <Button type="submit" size="sm">{t(saving ? 'hiroute.saving' : 'hiroute.save')}</Button>
          </fieldset>
          {feedback && <p role={feedback.kind === 'error' ? 'alert' : 'status'} className={`text-sm ${feedback.kind === 'error' ? 'text-red-600 dark:text-red-400' : 'text-green-700 dark:text-green-400'}`}>{feedback.message}</p>}
        </form>
      )}
    </section>
  );
}
