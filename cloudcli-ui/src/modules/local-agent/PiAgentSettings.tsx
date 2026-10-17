import { useEffect, useRef, useState } from 'react';

import { FrontendBridge, onPiConfigChanged } from '@/shared/chisa';
import type { PiConfigInput, PiConfigView } from '@/shared/types';

function savedForm(view: PiConfigView): PiConfigInput {
  return { provider: view.provider || 'custom', model: view.model || '', baseUrl: view.baseUrl || '', api: view.api || 'openai-completions', apiKey: '' };
}

/** Desktop settings and PiModelMenu use this form without displaying saved credentials. */
export function PiAgentSettings({ compact = false, onConfigChange }: { compact?: boolean; onConfigChange?: (config: PiConfigView) => void }) {
  // Keep the public saved configuration separate from the user's unsaved, write-only key.
  const [config, setConfig] = useState<PiConfigView | null>(null);
  // Preserve editable fields while a save or native installation is in progress.
  const [form, setForm] = useState<PiConfigInput>({ provider: 'custom', model: '', baseUrl: '', api: 'openai-completions', apiKey: '' });
  // Prevent concurrent native install/save operations and show their result.
  const [busy, setBusy] = useState(false);
  // Show configuration failures without exposing RPC payloads or credentials.
  const [note, setNote] = useState('');
  const mounted = useRef(false);
  const formRevision = useRef(0);
  const formEdited = useRef(false);
  const configRevision = useRef(0);
  const configCallback = useRef(onConfigChange);
  configCallback.current = onConfigChange;

  useEffect(() => {
    let alive = true;
    mounted.current = true;
    const receive = (view: PiConfigView) => {
      setConfig(view);
      configCallback.current?.(view);
      if (!formEdited.current) setForm(savedForm(view));
    };
    // Subscribe first so a delayed initial read cannot replace a saved model.
    const unsubscribe = onPiConfigChanged(view => {
      configRevision.current++;
      receive(view);
    });
    const revision = configRevision.current;
    void FrontendBridge.piGetConfig().then((view) => {
      if (!alive || revision !== configRevision.current) return;
      if (view.ok === false) throw new Error(view.error || '读取 Pi 配置失败');
      receive(view);
    }).catch((error) => { if (alive && revision === configRevision.current) setNote(error instanceof Error ? error.message : String(error)); });
    return () => { alive = false; mounted.current = false; unsubscribe(); };
  }, []);

  const editForm = (patch: Partial<PiConfigInput>) => {
    formRevision.current++;
    formEdited.current = true;
    setForm(value => ({ ...value, ...patch }));
  };

  const run = async (install: boolean) => {
    const submittedRevision = formRevision.current;
    const submittedForm = { ...form };
    setBusy(true);
    setNote('');
    try {
      let view: PiConfigView;
      let revision: number;
      if (install) {
        const result = await FrontendBridge.piInstall();
        if (!result.ok) throw new Error(result.error || 'Pi 操作未完成');
        revision = configRevision.current;
        view = await FrontendBridge.piGetConfig();
      } else {
        view = await FrontendBridge.piSaveConfig(submittedForm);
        revision = configRevision.current;
      }
      if (!mounted.current) return;
      if (view.ok === false) throw new Error(view.error || '读取 Pi 配置失败');
      if (revision === configRevision.current) {
        configRevision.current++;
        setConfig(view);
        configCallback.current?.(view);
      }
      // Installation never submits the draft. A save only clears its own unchanged draft.
      if (!install && submittedRevision === formRevision.current) {
        formEdited.current = false;
        setForm(savedForm(view));
      }
      setNote(install ? 'Pi 已安装。' : 'Pi 配置已保存。');
    } catch (error) {
      if (mounted.current) setNote(error instanceof Error ? error.message : String(error));
    } finally {
      if (mounted.current) setBusy(false);
    }
  };

  return (
    <section className={compact ? 'w-80 max-w-full space-y-3 p-2.5 text-xs' : 'space-y-3 rounded-lg border p-4 text-sm'} aria-label="本地 Pi 设置">
      <h3 className={compact ? 'text-[11px] font-medium text-muted-foreground' : 'font-medium'}>{compact ? 'Pi 模型配置' : '本地 Pi · Windows 原生'}</h3>
      {!compact && <>
        <p className="text-xs text-muted-foreground">Pi 在本机项目目录独立运行，使用自己的模型配置。对话、执行记录和配置不会自动发送给 Claude。</p>
        <p className="text-xs text-muted-foreground">Pi 使用当前 Windows 账户权限，负责本机项目的构建和桌面操作；Claude 的项目工具在 VPS 执行。</p>
      </>}
      <p className={compact ? 'text-muted-foreground' : undefined}>{config?.installed ? `已安装 ${config.version || ''}` : '尚未安装 Pi'} · {config?.configured ? '模型已配置' : '需要配置模型'}</p>
      <div className={compact ? 'grid gap-3' : 'grid gap-3 sm:grid-cols-2'}>
        <label className="space-y-1">服务商<select className="w-full rounded border bg-background px-3 py-2" value={form.provider} onChange={(event) => editForm({ provider: event.target.value })}><option value="custom">自定义 API</option><option value="anthropic">Anthropic</option><option value="openai">OpenAI</option><option value="google">Google</option><option value="openrouter">OpenRouter</option></select></label>
        <label className="space-y-1">模型<input className="w-full rounded border bg-transparent px-3 py-2" value={form.model} placeholder="模型 ID" onChange={(event) => editForm({ model: event.target.value })} /></label>
        <label className="space-y-1">API 地址<input className="w-full rounded border bg-transparent px-3 py-2" value={form.baseUrl} placeholder={form.provider === 'custom' ? '自定义 API 地址（必填）' : '留空使用服务商默认地址'} onChange={(event) => editForm({ baseUrl: event.target.value })} /></label>
        {form.provider === 'custom' && <label className="space-y-1">API 协议<select className="w-full rounded border bg-background px-3 py-2" value={form.api} onChange={(event) => editForm({ api: event.target.value as PiConfigInput['api'] })}><option value="openai-completions">OpenAI Chat Completions</option><option value="openai-responses">OpenAI Responses</option><option value="anthropic-messages">Anthropic Messages</option></select></label>}
      </div>
      <label className="block space-y-1">API Key<input type="password" autoComplete="new-password" className="w-full rounded border bg-transparent px-3 py-2" value={form.apiKey} placeholder={config?.hasApiKey && config.provider === form.provider && config.baseUrl === form.baseUrl ? '已保存密钥；留空保留' : '输入你自己的 API Key；更换服务商或地址需重新填写'} onChange={(event) => editForm({ apiKey: event.target.value })} /></label>
      <div className="flex flex-wrap gap-2">
        <button type="button" className="rounded border px-3 py-2 disabled:opacity-50" disabled={busy} onClick={() => void run(true)}>安装 Pi</button>
        <button type="button" className="rounded bg-primary px-3 py-2 text-primary-foreground disabled:opacity-50" disabled={busy || !form.provider.trim() || !form.model.trim() || (form.provider === 'custom' && !form.baseUrl.trim())} onClick={() => void run(false)}>{busy ? '处理中…' : '保存模型配置'}</button>
      </div>
      {note && <p role="status" className="text-xs text-muted-foreground">{note}</p>}
    </section>
  );
}
