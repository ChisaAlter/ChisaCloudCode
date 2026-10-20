import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from 'react-i18next';

import { api, readApiJson } from '@/shared/api';
import { Badge, Button, Input } from '@/shared/ui';

type ModelConnection = { id: string; name: string; baseUrl: string; model: string; hasApiKey: boolean; authType?: 'api_key' | 'auth_token' };
type ConnectionsSnapshot = { activeId: string | null; connections: ModelConnection[] };
type ConnectionsResponse = { success: true; data: ConnectionsSnapshot };
type ConnectionDraft = { name: string; baseUrl: string; model: string; apiKey: string; authType: 'api_key' | 'auth_token' };
type Feedback = { error: boolean; message: string };

const EMPTY_DRAFT: ConnectionDraft = { name: '', baseUrl: '', model: '', apiKey: '', authType: 'api_key' };
const PRESETS = [
  { id: 'custom', name: 'Custom', baseUrl: '', model: '' },
  { id: 'deepseek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/anthropic', model: 'deepseek-flash' },
  { id: 'kimi', name: 'Kimi', baseUrl: 'https://api.kimi.com/coding', model: 'kimi-for-coding' },
  { id: 'glm', name: 'GLM', baseUrl: 'https://open.bigmodel.cn/api/anthropic', model: 'glm-4.7' },
  { id: 'minimax', name: 'MiniMax', baseUrl: 'https://api.minimaxi.com/anthropic', model: 'MiniMax-M2.5' },
];

// Copy only public fields, even if a server accidentally includes a secret in its response.
function publicSnapshot(data: ConnectionsSnapshot): ConnectionsSnapshot {
  if (!data || !Array.isArray(data.connections) || !(data.activeId === null || typeof data.activeId === 'string')) throw new Error('Invalid connection list');
  return {
    activeId: data.activeId,
    connections: data.connections.map(connection => {
      if (!connection || !['id', 'name', 'baseUrl', 'model'].every(key => typeof connection[key as keyof ModelConnection] === 'string')
        || typeof connection.hasApiKey !== 'boolean'
        || (connection.authType !== undefined && !['api_key', 'auth_token'].includes(connection.authType))) throw new Error('Invalid connection');
      return { id: connection.id, name: connection.name, baseUrl: connection.baseUrl, model: connection.model, hasApiKey: connection.hasApiKey, ...(connection.authType ? { authType: connection.authType } : {}) };
    }),
  };
}

function normalizedEndpoint(value: string): string {
  const url = new URL(value.trim());
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash
    || /\/v1(?:\/messages)?\/*$/.test(url.pathname)) throw new Error('Invalid endpoint');
  return url.toString().replace(/\/+$/, '');
}

/** Used by the settings module's Models tab to manage per-account Anthropic Messages connections. */
export function ModelConnectionsSection() {
  const { t } = useTranslation('settings');
  // A confirmed server snapshot gates all operations and contains no API keys.
  const [snapshot, setSnapshot] = useState<ConnectionsSnapshot | null>(null);
  // The draft is transient; write-only replacement keys are discarded after success or cancel.
  const [draft, setDraft] = useState<ConnectionDraft>(EMPTY_DRAFT);
  // An existing id selects edit mode; null means create a new connection.
  const [editingId, setEditingId] = useState<string | null>(null);
  // Only one connection may present an inline deletion confirmation at a time.
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  // A failed initial request locks the form until an explicit successful retry.
  const [loadError, setLoadError] = useState(false);
  // Incrementing this counter restarts the abortable initial read.
  const [loadAttempt, setLoadAttempt] = useState(0);
  // Every mutation locks both the list and form until its response is confirmed.
  const [busy, setBusy] = useState(false);
  // Generic request results and local validation feedback never echo server error payloads.
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const editing = snapshot?.connections.find(connection => connection.id === editingId);

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await api.providers.connections.list({ signal: controller.signal });
        const { data } = await readApiJson<ConnectionsResponse>(response);
        const next = publicSnapshot(data);
        if (!controller.signal.aborted) setSnapshot(next);
      } catch {
        if (!controller.signal.aborted) setLoadError(true);
      }
    })();
    return () => controller.abort();
  }, [loadAttempt]);

  function resetDraft() {
    setEditingId(null);
    setDraft(EMPTY_DRAFT);
  }

  async function mutate(request: () => Promise<Response>, resetForm = false) {
    if (!snapshot || busy) return;
    setBusy(true);
    setFeedback(null);
    try {
      const { data } = await readApiJson<ConnectionsResponse>(await request());
      setSnapshot(publicSnapshot(data));
      setConfirmDeleteId(null);
      if (resetForm) resetDraft();
      setFeedback({ error: false, message: t('modelConnections.saved', { defaultValue: 'Settings saved. Changes apply to the next Claude turn; the connection has not been tested.' }) });
    } catch {
      setFeedback({ error: true, message: t('modelConnections.saveFailed', { defaultValue: 'Could not save model connections. Check your settings and try again.' }) });
    } finally {
      setBusy(false);
    }
  }

  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!snapshot || busy) return;
    setFeedback(null);
    const name = draft.name.trim();
    const model = draft.model.trim();
    const apiKey = draft.apiKey.trim();
    let baseUrl: string;
    try { baseUrl = normalizedEndpoint(draft.baseUrl); } catch {
      setFeedback({ error: true, message: t('modelConnections.invalidUrl', { defaultValue: 'Use an HTTP(S) base URL without credentials, query, fragment, or a trailing /v1 or /v1/messages.' }) });
      return;
    }
    if (!name || !model || /\s/.test(model) || (!apiKey && !editing?.hasApiKey)) {
      setFeedback({ error: true, message: t('modelConnections.required', { defaultValue: 'Enter a name, model without spaces, and API key. Leave the key blank only to retain an existing key.' }) });
      return;
    }
    if (editing && (normalizedEndpoint(editing.baseUrl) !== baseUrl || (editing.authType || 'api_key') !== draft.authType) && !apiKey) {
      setFeedback({ error: true, message: t('modelConnections.endpointKeyRequired', { defaultValue: 'Re-enter the API key when changing the endpoint.' }) });
      return;
    }
    const input = { name, baseUrl, model, ...(draft.authType !== 'api_key' || editing?.authType ? { authType: draft.authType } : {}), ...(apiKey ? { apiKey } : {}) };
    void mutate(() => editingId ? api.providers.connections.update(editingId, input) : api.providers.connections.create(input), true);
  }

  function edit(connection: ModelConnection) {
    setEditingId(connection.id);
    setDraft({ name: connection.name, baseUrl: connection.baseUrl, model: connection.model, apiKey: '', authType: connection.authType || 'api_key' });
    setConfirmDeleteId(null);
    setFeedback(null);
  }

  return (
    <section aria-label={t('modelConnections.title', { defaultValue: 'Other model connections' })} className="space-y-4 rounded-lg border border-border p-4">
      <div className="space-y-2">
        <h3 className="font-medium text-foreground">{t('modelConnections.title', { defaultValue: 'Other model connections' })}</h3>
        <p className="text-sm text-muted-foreground">{t('modelConnections.description', { defaultValue: 'Choose an Anthropic Messages connection for all Claude conversations on your account. Activation applies to the next turn; running turns are unchanged.' })}</p>
        <p className="text-sm text-muted-foreground">{t('modelConnections.protocol', { defaultValue: 'Only Anthropic Messages endpoints are supported. OpenAI-compatible APIs need protocol conversion through HiRoute; you can enter a compatible gateway endpoint here.' })}</p>
        <p className="text-xs text-muted-foreground">{t('modelConnections.secretHelp', { defaultValue: 'API keys are stored on the server and never loaded into this form or saved in browser storage. Configured does not mean connected or tested.' })}</p>
      </div>
      {!snapshot ? (
        loadError ? <div className="space-y-2">
          <p role="alert" className="text-sm text-red-600 dark:text-red-400">{t('modelConnections.loadFailed', { defaultValue: 'Could not load model connections. Retry before making changes.' })}</p>
          <Button variant="outline" size="sm" onClick={() => { setLoadError(false); setLoadAttempt(attempt => attempt + 1); }}>{t('modelConnections.retry', { defaultValue: 'Retry loading connections' })}</Button>
        </div> : <p role="status" className="text-sm text-muted-foreground">{t('modelConnections.loading', { defaultValue: 'Loading model connections…' })}</p>
      ) : <fieldset disabled={busy} className="min-w-0 space-y-5">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="secondary">{snapshot.activeId === null ? t('modelConnections.defaultActive', { defaultValue: 'No direct model connection selected' }) : t('modelConnections.customActive', { defaultValue: 'Custom connection selected' })}</Badge>
          <Button type="button" variant="outline" size="sm" onClick={() => void mutate(() => api.providers.connections.activate(null))}>{t('modelConnections.useDefault', { defaultValue: 'Return to default Claude' })}</Button>
        </div>
        <ul className="space-y-3" aria-label={t('modelConnections.list', { defaultValue: 'Saved model connections' })}>
          {snapshot.connections.map(connection => <li key={connection.id} className="space-y-2 rounded-md border border-border p-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium text-foreground">{connection.name}</span>
              <Badge variant="secondary">{t('modelConnections.configured', { defaultValue: 'Configured — not tested' })}</Badge>
              {connection.id === snapshot.activeId && <Badge>{t('modelConnections.active', { defaultValue: 'Active' })}</Badge>}
            </div>
            <p className="break-all text-sm text-muted-foreground">{connection.baseUrl}</p>
            <p className="break-all text-sm text-muted-foreground">{connection.model}</p>
            <div className="flex flex-wrap gap-2">
              <Button type="button" size="sm" variant="outline" disabled={connection.id === snapshot.activeId || !connection.hasApiKey} onClick={() => void mutate(() => api.providers.connections.activate(connection.id))}>{t('modelConnections.activate', { defaultValue: 'Activate' })}</Button>
              <Button type="button" size="sm" variant="outline" onClick={() => edit(connection)}>{t('modelConnections.edit', { defaultValue: 'Edit' })}</Button>
              <Button type="button" size="sm" variant="outline" onClick={() => setConfirmDeleteId(connection.id)}>{t('modelConnections.delete', { defaultValue: 'Delete' })}</Button>
            </div>
            {confirmDeleteId === connection.id && <div className="space-y-2">
              <p className="text-sm text-foreground">{t('modelConnections.confirmDelete', { defaultValue: 'Delete this connection? If it is active, default Claude will be selected.' })}</p>
              <div className="flex gap-2">
                <Button type="button" size="sm" variant="destructive" onClick={() => void mutate(() => api.providers.connections.remove(connection.id), editingId === connection.id)}>{t('modelConnections.deleteConfirm', { defaultValue: 'Confirm delete' })}</Button>
                <Button type="button" size="sm" variant="outline" onClick={() => setConfirmDeleteId(null)}>{t('modelConnections.cancelDelete', { defaultValue: 'Keep connection' })}</Button>
              </div>
            </div>}
          </li>)}
        </ul>
        {snapshot.connections.length === 0 && <p className="text-sm text-muted-foreground">{t('modelConnections.empty', { defaultValue: 'No custom model connections saved.' })}</p>}
        <form onSubmit={save} noValidate className="space-y-3">
          <h4 className="font-medium text-foreground">{editingId ? t('modelConnections.editTitle', { defaultValue: 'Edit connection' }) : t('modelConnections.createTitle', { defaultValue: 'Add connection' })}</h4>
          <label className="block space-y-1">
            <span className="text-sm font-medium text-foreground">{t('modelConnections.preset', { defaultValue: 'Provider preset' })}</span>
            <select value={PRESETS.find(preset => preset.id !== 'custom' && preset.name === draft.name && preset.baseUrl === draft.baseUrl && preset.model === draft.model)?.id ?? 'custom'} className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm" onChange={event => {
              const preset = PRESETS.find(item => item.id === event.target.value);
              if (preset) setDraft(preset.id === 'custom' ? EMPTY_DRAFT : { name: preset.name, baseUrl: preset.baseUrl, model: preset.model, apiKey: '', authType: 'api_key' });
              setFeedback(null);
            }}>
              {PRESETS.map(preset => <option key={preset.id} value={preset.id}>{preset.id === 'custom' ? t('modelConnections.custom', { defaultValue: 'Custom' }) : preset.name}</option>)}
            </select>
          </label>
          <p className="text-xs text-muted-foreground">{t('modelConnections.presetHelp', { defaultValue: 'Presets are editable examples, not verified connections. Check the current endpoint and model name with your provider.' })}</p>
          <label className="block space-y-1"><span className="text-sm font-medium text-foreground">{t('modelConnections.name', { defaultValue: 'Connection name' })}</span><Input value={draft.name} onChange={event => setDraft({ ...draft, name: event.target.value })} /></label>
          <label className="block space-y-1"><span className="text-sm font-medium text-foreground">{t('modelConnections.baseUrl', { defaultValue: 'Base URL' })}</span><Input type="url" value={draft.baseUrl} onChange={event => setDraft({ ...draft, baseUrl: event.target.value })} /></label>
          <label className="block space-y-1"><span className="text-sm font-medium text-foreground">{t('modelConnections.model', { defaultValue: 'Model name' })}</span><Input value={draft.model} onChange={event => setDraft({ ...draft, model: event.target.value })} /></label>
          <label className="block space-y-1"><span className="text-sm font-medium text-foreground">{t('modelConnections.authType')}</span>
            <select className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm" value={draft.authType} onChange={event => setDraft({ ...draft, authType: event.target.value as ConnectionDraft['authType'], apiKey: '' })}>
              <option value="api_key">{t('modelConnections.apiKeyHeader')}</option>
              <option value="auth_token">{t('modelConnections.bearerToken')}</option>
            </select>
          </label>
          <label className="block space-y-1"><span className="text-sm font-medium text-foreground">{t('modelConnections.apiKey', { defaultValue: 'API key' })}</span><Input type="password" autoComplete="new-password" spellCheck={false} value={draft.apiKey} onChange={event => setDraft({ ...draft, apiKey: event.target.value })} /></label>
          <p className="text-xs text-muted-foreground">{editing?.hasApiKey ? t('modelConnections.keyStored', { defaultValue: 'A key is saved. Leave blank to retain it; re-enter it when changing the endpoint.' }) : t('modelConnections.keyRequired', { defaultValue: 'Enter a key to save this connection.' })}</p>
          <div className="flex gap-2">
            <Button type="submit" size="sm">{busy ? t('modelConnections.saving', { defaultValue: 'Saving…' }) : t('modelConnections.save', { defaultValue: 'Save connection' })}</Button>
            {editingId && <Button type="button" size="sm" variant="outline" onClick={() => { resetDraft(); setFeedback(null); }}>{t('modelConnections.cancelEdit', { defaultValue: 'Cancel edit' })}</Button>}
          </div>
        </form>
      </fieldset>}
      {feedback && <p role={feedback.error ? 'alert' : 'status'} className={`text-sm ${feedback.error ? 'text-red-600 dark:text-red-400' : 'text-green-700 dark:text-green-400'}`}>{feedback.message}</p>}
    </section>
  );
}
