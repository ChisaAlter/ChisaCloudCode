import { useEffect, useRef, useState } from 'react';
import { FolderOpen, Loader2, RefreshCw } from 'lucide-react';

import { api, readApiJson } from '@/shared/api';
import { FrontendBridge, isDesktop } from '@/shared/chisa';
import { Button, Input } from '@/shared/ui';
import { useSshAgent } from '@/modules/ssh-workspaces/context/SshAgentContext';
import { SshAgentStatus } from '@/modules/ssh-workspaces/SshAgentStatus';
import { getAuthSessionVersion } from '@/shared/authToken';
import { getServerConnectionVersion } from '@/shared/chisa';
import type { SshWorkspaceConnection, SshWorkspaceConnectionsResponse, SshWorkspaceProbe } from '@/shared/types';

type SshProjectFieldsProps = {
  connectionId: string;
  rootPath: string;
  verified: SshWorkspaceProbe | null;
  disabled?: boolean;
  onConnectionChange: (id: string) => void;
  onRootPathChange: (path: string) => void;
  onVerified: (probe: SshWorkspaceProbe | null, connectionLabel?: string) => void;
};

/** Project creation uses this server-catalog selector and end-to-end Windows directory probe. */
export function SshProjectFields({ connectionId, rootPath, verified, disabled = false, onConnectionChange, onRootPathChange, onVerified }: SshProjectFieldsProps) {
  // Catalog loading and failures remain visible without requiring a native desktop bridge.
  const [catalog, setCatalog] = useState<{ connections: SshWorkspaceConnection[]; configured: boolean; loading: boolean; error: string | null }>({ connections: [], configured: false, loading: true, error: null });
  // A refresh explicitly reloads endpoint configuration after external pairing or setup.
  const [catalogVersion, setCatalogVersion] = useState(0);
  // Only the current directory's probe may publish its result to the wizard.
  const [probing, setProbing] = useState(false);
  // Picker and probe failures do not erase the user's entered path.
  const [error, setError] = useState<string | null>(null);
  // Explicitly connecting this computer remains available when the catalog belongs to another desktop.
  const [connectingComputer, setConnectingComputer] = useState(false);
  const agent = useSshAgent();
  const accountKey = JSON.stringify([getAuthSessionVersion(), getServerConnectionVersion()]);
  const selectionKey = JSON.stringify([accountKey, connectionId, rootPath]);
  const selectionKeyRef = useRef(selectionKey);
  selectionKeyRef.current = selectionKey;
  const requestRef = useRef(0);
  const probeControllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    const authVersion = getAuthSessionVersion();
    const serverVersion = getServerConnectionVersion();
    const current = () => !controller.signal.aborted && authVersion === getAuthSessionVersion() && serverVersion === getServerConnectionVersion();
    setCatalog(previous => ({ ...previous, loading: true, error: null }));
    void api.sshWorkspaces.connections({ signal: controller.signal }).then(readApiJson<SshWorkspaceConnectionsResponse>).then(value => {
      if (!current()) return;
      if (!Array.isArray(value.connections) || typeof value.configured !== 'boolean') throw new Error('项目连接列表无效，请检查服务器版本。');
      setCatalog({ connections: value.connections, configured: value.configured, loading: false, error: null });
    }).catch(failure => {
      if (current()) setCatalog({ connections: [], configured: false, loading: false, error: failure instanceof Error ? failure.message : '无法读取项目连接。' });
    });
    return () => controller.abort();
  }, [catalogVersion, accountKey, agent?.revision]);

  useEffect(() => {
    ++requestRef.current;
    probeControllerRef.current?.abort();
    setProbing(false);
    setConnectingComputer(false);
    setError(null);
    return () => { ++requestRef.current; probeControllerRef.current?.abort(); };
  }, [selectionKey]);

  const connection = catalog.connections.find(item => item.id === connectionId);
  const selectedNativeAgent = agent?.profiles.some(item => item.id === connectionId && item.mode === 'agent');
  const builtInConnection = connection?.transport === 'agent' || selectedNativeAgent;
  // Only the native default label is translated for display; saved IDs and custom names remain intact.
  const connectionLabel = builtInConnection && connection?.name === '本机 Agent' ? '本机项目连接' : connection?.name;
  const connectComputer = async () => {
    if (!agent || connectingComputer) return;
    const authVersion = getAuthSessionVersion();
    const serverVersion = getServerConnectionVersion();
    const key = selectionKey;
    const request = requestRef.current;
    setConnectingComputer(true);
    setError(null);
    try {
      const result = await agent.ensure('');
      if (request !== requestRef.current || selectionKeyRef.current !== key || authVersion !== getAuthSessionVersion() || serverVersion !== getServerConnectionVersion()) return;
      if (!result?.ok || !result.profile) throw new Error('尚未连接这台电脑，请检查本机项目连接状态后重试。');
      setCatalogVersion(value => value + 1);
      onVerified(null);
      onConnectionChange(result.profile.id);
    } catch (failure) {
      if (request === requestRef.current && authVersion === getAuthSessionVersion() && serverVersion === getServerConnectionVersion()) setError(failure instanceof Error ? failure.message : '无法连接这台电脑。');
    } finally {
      if (request === requestRef.current && authVersion === getAuthSessionVersion() && serverVersion === getServerConnectionVersion()) setConnectingComputer(false);
    }
  };
  useEffect(() => {
    if (disabled || catalog.loading || catalog.error || !agent) return;
    if (connectionId) void agent.activate(connectionId);
    else if (catalog.connections.length === 0) void agent.activate('');
    else if (catalog.connections.length === 1) void agent.activate(catalog.connections[0].id);
  }, [disabled, catalog.loading, catalog.error, catalog.connections, connectionId, agent?.activate]);

  useEffect(() => {
    if (!connectionId && catalog.connections.length === 1) onConnectionChange(catalog.connections[0].id);
  }, [catalog.connections, connectionId, onConnectionChange]);

  const probe = async () => {
    if (!connection || !/^[a-zA-Z]:[\\/]/.test(rootPath.trim())) {
      setError('请选择已登记的项目连接，并填写 Windows 绝对项目目录。');
      return;
    }
    const key = selectionKey;
    const identity = getAuthSessionVersion();
    const server = getServerConnectionVersion();
    const request = ++requestRef.current;
    const controller = new AbortController();
    probeControllerRef.current?.abort();
    probeControllerRef.current = controller;
    onVerified(null);
    setProbing(true);
    setError(null);
    try {
      if (agent?.profiles.some(item => item.id === connectionId && item.mode === 'agent')) {
        const ensured = await agent.ensure(connectionId);
        if (request !== requestRef.current || selectionKeyRef.current !== key || controller.signal.aborted || identity !== getAuthSessionVersion() || server !== getServerConnectionVersion()) return;
        if (!ensured?.ok) throw new Error('本机项目连接尚未准备好，请查看连接状态并重试。');
      }
      const response = await api.sshWorkspaces.probe({ connectionId, rootPath: rootPath.trim() }, { signal: controller.signal });
      const value = await readApiJson<SshWorkspaceProbe>(response);
      if (request !== requestRef.current || selectionKeyRef.current !== key || controller.signal.aborted || identity !== getAuthSessionVersion() || server !== getServerConnectionVersion()) return;
      if (value.ok !== true || value.platform !== 'win32' || !value.rootPath || !value.rootIdentity) throw new Error('服务器未返回有效的 Windows 目录身份，尚未完成验证。');
      if (value.existingProject && (value.existingProject.sourceMode !== 'ssh' || !value.existingProject.projectId || !value.existingProject.displayName || typeof value.existingProject.isArchived !== 'boolean')) throw new Error('服务器返回的已有项目信息无效，请重新验证。');
      onVerified(value, connectionLabel);
    } catch (failure) {
      if (request === requestRef.current && !controller.signal.aborted && identity === getAuthSessionVersion() && server === getServerConnectionVersion()) setError(failure instanceof Error ? failure.message : '项目目录验证失败。');
    } finally {
      if (request === requestRef.current) setProbing(false);
    }
  };

  const pickFolder = async () => {
    const key = selectionKey;
    const identity = getAuthSessionVersion();
    const server = getServerConnectionVersion();
    const request = requestRef.current;
    setError(null);
    try {
      const result = await FrontendBridge.selectSshLocalFolder();
      if (result.cancelled || selectionKeyRef.current !== key || request !== requestRef.current || identity !== getAuthSessionVersion() || server !== getServerConnectionVersion()) return;
      if (!result.ok || !result.path) throw new Error(result.error || '无法选择本地目录。');
      onRootPathChange(result.path);
    } catch (failure) { if (request === requestRef.current && identity === getAuthSessionVersion() && server === getServerConnectionVersion()) setError(failure instanceof Error ? failure.message : '无法选择本地目录。'); }
  };

  return <div className="space-y-4">
    <p className="text-sm text-muted-foreground">Claude Code 在 VPS 运行，本机无需安装 Claude Code。本机项目连接只负责访问 Windows 项目文件，并在该电脑执行 Git、构建和测试；项目文件保留在原目录。</p>
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <label htmlFor="ssh-project-connection" className="text-sm font-medium">本地连接</label>
        <Button type="button" variant="ghost" size="sm" onClick={() => { ++requestRef.current; probeControllerRef.current?.abort(); setProbing(false); onVerified(null); setCatalogVersion(value => value + 1); }} disabled={disabled || catalog.loading}><RefreshCw className="mr-1 h-3.5 w-3.5" />刷新连接</Button>
      </div>
      <select id="ssh-project-connection" className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm" value={connectionId} disabled={disabled || catalog.loading} onChange={event => onConnectionChange(event.target.value)}>
        <option value="">{catalog.loading ? '正在读取连接…' : '选择已登记的本地连接'}</option>
        {catalog.connections.map(item => {
          const builtIn = item.transport === 'agent' || agent?.profiles.some(profile => profile.id === item.id && profile.mode === 'agent');
          return <option key={item.id} value={item.id}>{builtIn && item.name === '本机 Agent' ? '本机项目连接' : item.name}{item.username && !(builtIn && item.username === 'desktop-agent') ? ` · ${item.username}` : ''}</option>;
        })}
      </select>
      {catalog.error && <p role="alert" className="text-sm text-destructive">{catalog.error}</p>}
      {!catalog.loading && !catalog.error && catalog.connections.length === 0 && <div className="space-y-2" role="status">
        <p className="text-sm text-muted-foreground">{isDesktop() ? '本机项目连接尚未登记，正在连接这台电脑。' : `${catalog.configured ? '当前账号尚无可用本地连接。' : '服务器尚未登记本地连接。'} 可在桌面“设置 → Chisa → 本机项目连接”连接这台电脑，无需在本机安装 Claude Code。`}</p>
      </div>}
      {isDesktop() && agent && !selectedNativeAgent && <Button type="button" variant="outline" size="sm" disabled={disabled || connectingComputer || agent.loading || agent.pending.length > 0} onClick={() => void connectComputer()}>{connectingComputer && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}{connectingComputer ? '正在连接这台电脑…' : '连接这台电脑'}</Button>}
      {isDesktop() && (!connectionId || agent?.errors.$profiles || selectedNativeAgent) && <SshAgentStatus profileId={connectionId} disabled={disabled} />}
    </div>
    <div className="space-y-2">
      <label htmlFor="ssh-project-root" className="text-sm font-medium">Windows 项目目录</label>
      <div className="flex gap-2">
        <Input id="ssh-project-root" value={rootPath} onChange={event => onRootPathChange(event.target.value)} placeholder="C:\\work\\my-project" disabled={disabled} className="min-w-0 flex-1 font-mono text-sm" />
        {isDesktop() && <Button type="button" variant="outline" onClick={() => void pickFolder()} disabled={disabled} aria-label="选择 Windows 项目目录"><FolderOpen className="h-4 w-4" /></Button>}
      </div>
      <p className="text-xs text-muted-foreground">此目录必须已存在，且当前 Windows 账户{builtInConnection ? '' : '或所选 SSH 账户'}有读取和开发权限。云端 Claude 直接使用此目录，不复制仓库。</p>
    </div>
    <div className="space-y-2">
      <Button type="button" variant="outline" onClick={() => void probe()} disabled={disabled || probing || catalog.loading || !connection || !rootPath.trim()}>{probing && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}{probing ? '正在验证 Windows 目录…' : connection && !builtInConnection ? '验证 SSH 连接和目录' : '验证连接和目录'}</Button>
      {verified && <p role="status" className="break-all text-sm text-foreground">已验证：{verified.rootPath}{verified.username ? ` · ${verified.username}` : ''}。{verified.existingProject ? '打开时' : '创建时'}服务器会再次检查。</p>}
      {verified?.existingProject && <p role="status" className="break-words text-sm text-foreground">此目录已在当前账号中登记为「{verified.existingProject.displayName}」。{verified.existingProject.isArchived ? '该项目已归档，恢复后将打开原项目。' : '可直接打开已有项目。'}</p>}
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    </div>
  </div>;
}
