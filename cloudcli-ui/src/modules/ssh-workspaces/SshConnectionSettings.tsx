import { useEffect, useRef, useState } from 'react';
import { FolderOpen, Loader2, RefreshCw } from 'lucide-react';

import { useSshAgent } from '@/modules/ssh-workspaces/context/SshAgentContext';
import { SshAgentStatus } from '@/modules/ssh-workspaces/SshAgentStatus';
import { getAuthSessionVersion } from '@/shared/authToken';
import { getServerConnectionVersion } from '@/shared/chisa';
import { FrontendBridge, isDesktop } from '@/shared/chisa';
import { Button, Input } from '@/shared/ui';
import type { SshHelperInstallResult, SshNativeResult, SshPreflight, SshTunnelProfile, SshTunnelProfileInput, SshTunnelStatus } from '@/shared/types';

const EMPTY_PROFILE: SshTunnelProfileInput = { mode: 'agent', agentTransport: 'relay', name: '', sshHost: '', sshPort: 22, sshUser: '', keyPath: '', knownHostsPath: '', remotePort: 0, localPort: 18765 };
const tunnelLabels: Record<SshTunnelStatus['state'], string> = { stopped: '已停止', starting: '正在连接', forwarding: '转发已建立，目录尚未验证', reconnecting: '正在重连', stopping: '正在停止', error: '连接失败' };

function requireSuccess<T extends SshNativeResult>(result: T): T {
  if (!result.ok) throw new Error(result.error || '本地项目连接操作未完成。');
  return result;
}

/** Chisa settings uses this explicit native tunnel setup without affecting cloud account login. */
export function SshConnectionSettings() {
  const desktop = isDesktop();
  const agent = useSshAgent();
  const accountKey = JSON.stringify([getAuthSessionVersion(), getServerConnectionVersion()]);
  // Native setup stays collapsed so opening cloud settings does not initialize SSH capabilities.
  const [open, setOpen] = useState(false);
  // The account-scoped catalog is loaded only while this section is open.
  const [nativeProfiles, setProfiles] = useState<SshTunnelProfile[]>([]);
  const profiles = agent?.profiles ?? nativeProfiles;
  // A single draft edits the selected profile without mutating the saved native state.
  const [draft, setDraft] = useState<SshTunnelProfileInput>(EMPTY_PROFILE);
  const relay = (draft.mode || 'ssh') === 'agent' && draft.agentTransport === 'relay';
  // Actual manager statuses are distinct from successful Windows root verification.
  const [statuses, setStatuses] = useState<Record<string, SshTunnelStatus>>({});
  // Native prerequisite feedback never triggers installation or service changes.
  const [preflight, setPreflight] = useState<SshPreflight | null>(null);
  // Busy actions prevent overlapping saves, picker operations and lifecycle requests.
  const [busy, setBusy] = useState<string | null>(null);
  // Persistent errors keep failures visible until a user action succeeds.
  const [error, setError] = useState<string | null>(null);
  // A helper installation receipt exposes only its path and access requirements.
  const [helper, setHelper] = useState<SshHelperInstallResult | null>(null);
  // Confirm successful persistence without confusing it with tunnel or directory readiness.
  const [notice, setNotice] = useState<string | null>(null);
  const generationRef = useRef(0);
  const defaultsLoadedRef = useRef(false);
  const selectedRef = useRef(draft.id);
  selectedRef.current = draft.id;

  const refresh = async (generation = generationRef.current) => {
    const authVersion = getAuthSessionVersion();
    const serverVersion = getServerConnectionVersion();
    const value = requireSuccess(await (agent ? agent.refresh().then(result => result || { ok: false, error: '无法读取桌面项目连接配置。' }) : FrontendBridge.getSshTunnelProfiles()));
    if (generation !== generationRef.current || authVersion !== getAuthSessionVersion() || serverVersion !== getServerConnectionVersion()) return;
    if (!Array.isArray(value.profiles) || !Array.isArray(value.statuses)) throw new Error('桌面未返回有效的项目连接配置，请更新客户端。');
    const loadedProfiles = value.profiles;
    setProfiles(loadedProfiles);
    setDraft(previous => {
      if (previous.id || previous.name || previous.sshHost) return previous;
      const first = loadedProfiles[0];
      return first ? { ...first, mode: first.mode || 'ssh' } : previous;
    });
    setStatuses(Object.fromEntries(value.statuses.map(status => [status.profileId, status])));
  };

  useEffect(() => {
    ++generationRef.current;
    setDraft({ ...EMPTY_PROFILE }); setProfiles([]); setStatuses({}); setPreflight(null); setHelper(null); setError(null); setNotice(null); setBusy(null);
    defaultsLoadedRef.current = false;
  }, [accountKey]);

  useEffect(() => {
    if (agent?.profiles.length) setDraft(previous => previous.id || previous.name || previous.sshHost ? previous : { ...agent.profiles[0], mode: agent.profiles[0].mode || 'ssh' });
  }, [agent?.profiles]);

  useEffect(() => {
    if (!open || !desktop) return;
    const generation = ++generationRef.current;
    setBusy('load');
    setError(null);
    void refresh(generation).catch(failure => { if (generation === generationRef.current) setError(failure instanceof Error ? failure.message : '无法读取项目连接配置。'); }).finally(() => { if (generation === generationRef.current) setBusy(null); });
    return () => { ++generationRef.current; };
  }, [open, desktop, accountKey]);

  useEffect(() => {
    if (!open || !desktop || relay || defaultsLoadedRef.current) return;
    defaultsLoadedRef.current = true;
    const generation = generationRef.current;
    void Promise.resolve(FrontendBridge.getSshDefaults()).then(result => {
      if (!result || generation !== generationRef.current) return;
      if (!result.ok || !result.sshHost) return;
      setDraft(previous => previous.id || previous.name || previous.sshHost ? previous : {
        ...previous,
        sshHost: result.sshHost!,
        sshPort: result.sshPort || 22,
        sshUser: result.sshUser || '',
        keyPath: result.keyPath || '',
        knownHostsPath: result.knownHostsPath || '',
        remotePort: result.remotePort || 18766,
        localPort: result.localPort || 18765,
      });
    }).catch(() => { /* Defaults are optional; the user can still fill the form. */ });
  }, [open, desktop, accountKey, relay]);

  useEffect(() => {
    if (!open || !desktop || !draft.id || agent) return;
    const id = draft.id;
    let cancelled = false;
    let pending = false;
    const poll = async () => {
      if (cancelled || pending || document.visibilityState === 'hidden') return;
      pending = true;
      try {
        const result = requireSuccess(await FrontendBridge.getSshTunnelStatus(id));
        if (!cancelled && selectedRef.current === id && result.status) setStatuses(previous => ({ ...previous, [id]: result.status! }));
      } catch (failure) {
        if (!cancelled && selectedRef.current === id) setError(failure instanceof Error ? failure.message : '无法刷新项目连接状态。');
      } finally { pending = false; }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 2500);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [open, desktop, draft.id, accountKey, agent?.refresh]);

  const perform = async (action: string, operation: (isCurrent: () => boolean) => Promise<void>) => {
    const generation = generationRef.current;
    const authVersion = getAuthSessionVersion();
    const serverVersion = getServerConnectionVersion();
    const isCurrent = () => generation === generationRef.current && authVersion === getAuthSessionVersion() && serverVersion === getServerConnectionVersion();
    setBusy(action);
    setError(null);
    setNotice(null);
    try { await operation(isCurrent); }
    catch (failure) { if (isCurrent()) setError(failure instanceof Error ? failure.message : '项目连接操作失败。'); }
    finally { if (isCurrent()) setBusy(null); }
  };

  const update = <K extends keyof SshTunnelProfileInput>(key: K, value: SshTunnelProfileInput[K]) => setDraft(previous => ({ ...previous, [key]: value }));
  const selectFile = (field: 'keyPath' | 'knownHostsPath') => perform('picker', async isCurrent => {
    const result = await (field === 'keyPath' ? FrontendBridge.selectSshIdentityFile() : FrontendBridge.selectSshKnownHostsFile());
    if (!isCurrent() || result.cancelled) return;
    if (!result.ok || !result.path) throw new Error(result.error || '未选择配置文件。');
    update(field, result.path);
  });
  const save = () => perform('save', async isCurrent => {
    const mode = draft.mode || 'ssh';
    const relay = mode === 'agent' && draft.agentTransport === 'relay';
    if (!draft.name.trim()) throw new Error('请填写配置名称。');
    if (!relay && (!draft.sshHost.trim() || !draft.sshUser.trim() || !draft.keyPath.trim() || !draft.knownHostsPath.trim())) throw new Error('请填写 VPS SSH 地址、账户和两个文件路径。');
    if (!relay && ![draft.sshPort, draft.remotePort, draft.localPort].every(port => Number.isInteger(port) && port >= 1 && port <= 65535)) throw new Error('端口必须是 1 到 65535 的整数；反向端口应填写服务器分配的端口。');
    if (!relay && mode === 'agent' && draft.localPort < 1024) throw new Error('本机项目连接端口须为 1024 到 65535。');
    const result = requireSuccess(await FrontendBridge.saveSshTunnelProfile({ ...draft, mode, name: draft.name.trim(), sshHost: draft.sshHost.trim(), sshUser: draft.sshUser.trim(), keyPath: draft.keyPath.trim(), knownHostsPath: draft.knownHostsPath.trim() }));
    if (!isCurrent()) return;
    if (!result.profile) throw new Error('桌面未返回已保存的配置。');
    setDraft(result.profile);
    await refresh();
    if (isCurrent()) setNotice(relay ? '配置已保存。尚未连接这台电脑或验证项目目录。' : '配置已保存。尚未启动 SSH 隧道或验证项目目录。');
  });
  const control = (start: boolean) => perform(start ? 'start' : 'stop', async isCurrent => {
    if (!draft.id) throw new Error('请先保存连接配置。');
    const current = profiles.find(profile => profile.id === draft.id);
    if (start && current?.mode === 'agent') {
      if (!agent) throw new Error('当前账号的本机项目连接尚未准备好。');
      await agent.ensure(draft.id);
      return;
    }
    const result = requireSuccess(await (start ? FrontendBridge.startSshTunnel(draft.id) : FrontendBridge.stopSshTunnel(draft.id)));
    if (!isCurrent()) return;
    if (!result.status) throw new Error('桌面未返回连接状态。');
    setStatuses(previous => ({ ...previous, [result.status!.profileId]: result.status! }));
    if (agent) await agent.refresh();
  });
  const status = draft.id ? agent?.statuses[draft.id] || statuses[draft.id] : undefined;
  const saved = draft.id ? profiles.find(profile => profile.id === draft.id) : undefined;
  const changed = Boolean(saved && (Object.keys(EMPTY_PROFILE) as (keyof typeof EMPTY_PROFILE)[]).some(key => saved[key] !== draft[key]));
  const running = status?.state === 'starting' || status?.state === 'forwarding' || status?.state === 'reconnecting' || status?.state === 'stopping';

  if (!desktop) return <section className="space-y-2"><h3 className="text-sm font-semibold">本机项目连接</h3><p className="text-sm text-muted-foreground">浏览器可以使用服务器已登记的本地项目连接。连接这台电脑需要 ChisaCloudCode 桌面应用。Claude Code 在 VPS 运行，本机无需安装 Claude Code。</p></section>;

  return <details open={open} onToggle={event => setOpen(event.currentTarget.open)} className="rounded-lg border border-border p-4">
    <summary className="cursor-pointer text-sm font-semibold">本机项目连接</summary>
    {open && <div className="mt-4 space-y-4">
      <p className="text-sm text-muted-foreground">Claude Code 在 VPS 运行，本机无需安装 Claude Code。本机项目连接由桌面应用内置，只负责访问 Windows 项目文件和执行 Git、构建、测试。默认通过当前账号连接，无需 SSH 配置或管理员权限；项目文件放在 VPS 时无需本机连接。</p>
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="outline" size="sm" disabled={Boolean(busy)} onClick={() => void perform('preflight', async isCurrent => { const result = await FrontendBridge.getSshPreflight(); if (isCurrent()) setPreflight(result); })}>检查本机环境</Button>
        <Button type="button" variant="outline" size="sm" disabled={Boolean(busy)} onClick={() => void perform('helper', async isCurrent => { const result = requireSuccess(await FrontendBridge.installSshWorkspaceHelper()); if (isCurrent()) setHelper(result); })}>准备项目连接脚本</Button>
        <Button type="button" variant="ghost" size="sm" disabled={Boolean(busy)} onClick={() => void perform('refresh', () => refresh())}><RefreshCw className="mr-1 h-3.5 w-3.5" />刷新</Button>
      </div>
      {preflight && (() => {
        const agentMode = (draft.mode || 'ssh') === 'agent';
        const issues = (preflight.issues || []).filter(issue => !(agentMode && ['SSH_SERVER_MISSING', 'SSH_SERVER_STOPPED'].includes(issue.code)));
        const ready = agentMode ? Boolean(preflight.agentAvailable || preflight.sshAvailable) : preflight.ok;
        return <div role="status" className="space-y-1 text-sm"><p>{ready ? (agentMode ? '本机项目连接可用；仍需连接账号并验证项目目录。' : '本机 SSH 前提已满足，仍需验证服务器连接和项目目录。') : '本机环境需要处理以下问题：'}</p>{issues.map(issue => <p key={issue.code} className="text-muted-foreground">{issue.message}</p>)}{preflight.error && <p className="text-destructive">{preflight.error}</p>}</div>;
      })()}
      {helper?.path && <div role="status" className="space-y-1 text-sm"><p className="break-all">辅助脚本：{helper.path}</p><p className="text-muted-foreground">{helper.accessNotice || '将此路径登记到服务器连接配置，并确认 SSH 登录账户可以读取。尚未修改访问权限。'}</p></div>}
      <div className="space-y-2"><label htmlFor="ssh-native-profile" className="text-sm font-medium">{relay ? '连接配置' : '隧道配置'}</label><select id="ssh-native-profile" value={draft.id || ''} onChange={event => { const profile = profiles.find(item => item.id === event.target.value); setDraft(profile ? { ...profile, mode: profile.mode || 'ssh' } : { ...EMPTY_PROFILE }); setError(null); setNotice(null); }} disabled={Boolean(busy)} className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"><option value="">新建配置</option>{profiles.map(profile => <option key={profile.id} value={profile.id}>{profile.mode === 'agent' && profile.name === '本机 Agent' ? '本机项目连接' : profile.name}</option>)}</select></div>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="space-y-1 text-sm"><span>连接方式</span><select value={relay ? 'relay' : draft.mode === 'agent' ? 'agent-ssh' : 'ssh'} onChange={event => setDraft(previous => ({ ...previous, mode: event.target.value === 'ssh' ? 'ssh' : 'agent', agentTransport: event.target.value === 'relay' ? 'relay' : 'ssh' }))} disabled={Boolean(busy) || running} className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"><option value="relay">本机项目连接（默认）</option><option value="agent-ssh">高级：本机项目连接（反向 SSH）</option><option value="ssh">高级：系统 SSH 服务（兼容）</option></select></label>
        <label className="space-y-1 text-sm"><span>配置名称</span><Input value={draft.mode === 'agent' && draft.name === '本机 Agent' ? '本机项目连接' : draft.name} onChange={event => update('name', event.target.value)} disabled={Boolean(busy) || running} /></label>
        {!relay && <><label className="space-y-1 text-sm"><span>VPS SSH 地址</span><Input value={draft.sshHost} onChange={event => update('sshHost', event.target.value)} disabled={Boolean(busy) || running} placeholder="vps.example.com" /></label>
        <label className="space-y-1 text-sm"><span>VPS SSH 账户</span><Input value={draft.sshUser} onChange={event => update('sshUser', event.target.value)} disabled={Boolean(busy) || running} placeholder="受限转发账户" /></label>
        <label className="space-y-1 text-sm"><span>VPS SSH 端口</span><Input type="number" min={1} max={65535} value={draft.sshPort || ''} onChange={event => update('sshPort', Number(event.target.value))} disabled={Boolean(busy) || running} /></label>
        <label className="space-y-1 text-sm"><span>VPS 反向监听端口</span><Input type="number" min={1} max={65535} value={draft.remotePort || ''} onChange={event => update('remotePort', Number(event.target.value))} disabled={Boolean(busy) || running} /></label>
        <label className="space-y-1 text-sm"><span>{(draft.mode || 'ssh') === 'agent' ? '本机项目连接端口' : '本机 SSH 端口'}</span><Input type="number" min={1} max={65535} value={draft.localPort || ''} onChange={event => update('localPort', Number(event.target.value))} disabled={Boolean(busy) || running} /></label></>}
      </div>
      {!relay && (['keyPath', 'knownHostsPath'] as const).map(field => <div key={field} className="space-y-1"><label htmlFor={`ssh-native-${field}`} className="text-sm">{field === 'keyPath' ? '隧道私钥文件路径' : '已验证的 known_hosts 文件路径'}</label><div className="flex gap-2"><Input id={`ssh-native-${field}`} value={draft[field]} onChange={event => update(field, event.target.value)} disabled={Boolean(busy) || running} className="min-w-0 flex-1 font-mono text-xs" /><Button type="button" variant="outline" disabled={Boolean(busy) || running} onClick={() => void selectFile(field)} aria-label={field === 'keyPath' ? '选择隧道私钥文件' : '选择 known_hosts 文件'}><FolderOpen className="h-4 w-4" /></Button></div></div>)}
      <p className="text-xs text-muted-foreground">{relay ? '本机项目连接使用当前账号服务，无需 SSH 密钥、端口或管理员权限。桌面应用负责保持连接，项目目录仍需验证。' : '高级连接仅保存文件引用，不填写私钥内容或密码。此处是 Windows → VPS 的反向 SSH 隧道；本机项目连接无需 Windows SSH 服务。'}</p>
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" variant="outline" disabled={Boolean(busy) || running} onClick={() => void save()}>保存配置</Button>
        <Button type="button" variant="outline" disabled={Boolean(busy) || !draft.id || changed || running} onClick={() => void control(true)}>{relay ? '连接项目' : '启动隧道'}</Button>
        <Button type="button" variant="outline" disabled={Boolean(busy) || !draft.id || !running} onClick={() => void control(false)}>{relay ? '断开连接' : '停止隧道'}</Button>
        {busy && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" aria-label="正在处理项目连接" />}
      </div>
      {(draft.mode || 'ssh') === 'agent' && agent ? <SshAgentStatus profileId={draft.id} disabled={Boolean(busy) || changed} /> : status && <p role="status" className="text-sm">{tunnelLabels[status.state]}{status.message ? `：${status.message}` : ''}</p>}
      {notice && <p role="status" className="text-sm">{notice}</p>}
      {error && <p role="alert" className="break-words text-sm text-destructive">{error}</p>}
      <p className="text-xs text-muted-foreground">连接建立后，请在新建项目中选择“本机项目（云端 Claude）”并验证目录。关闭应用或切换账号会断开本机项目连接，项目文件仍留在原电脑；Claude Code 始终在 VPS 运行。</p>
    </div>}
  </details>;
}
