import { Loader2 } from 'lucide-react';

import { useSshAgent } from '@/modules/ssh-workspaces/context/SshAgentContext';
import { Button } from '@/shared/ui';

/** SSH setup and project-workspace show the same native registration, retry and reconnect state. */
export function SshAgentStatus({ profileId = '', disabled = false }: { profileId?: string; disabled?: boolean }) {
  const agent = useSshAgent();
  if (!agent) return null;
  const profile = agent.profiles.find(item => item.id === profileId) || (!profileId ? agent.profiles.find(item => item.mode === 'agent') : undefined);
  if (profile && profile.mode !== 'agent') return null;
  const id = profile?.id || profileId;
  const status = agent.statuses[id];
  const rawError = agent.errors[id] || agent.errors[''] || agent.errors.$profiles || status?.registrationError;
  // Translate only fixed built-in diagnostics; arbitrary native/server errors retain their original details.
  const nativeMessages = new Map([
    ['等待桌面 Agent 超时，请检查连接状态后重试。', '等待本机项目连接超时，请检查连接状态后重试。'],
    ['尚未确认 Agent 转发和账号登记，请检查状态后重试。', '尚未确认本机项目连接和账号登记，请检查状态后重试。'],
    ['无法准备桌面 Agent。', '无法准备本机项目连接。'],
  ]);
  const error = rawError ? nativeMessages.get(rawError) || rawError : undefined;
  const pending = agent.loading || agent.pending.includes(id) || agent.pending.includes('');
  const labels = { stopped: '本机项目连接已停止', starting: '正在连接本机项目', forwarding: '本机项目连接已建立', reconnecting: '本机项目连接正在重连', stopping: '正在停止本机项目连接', error: '本机项目连接失败' };
  const registration = status?.registrationState === 'registered' ? '账号已连接，项目目录仍需验证' : status?.registrationState === 'registering' ? '正在连接当前账号' : status?.registrationState === 'error' ? '账号连接失败' : '账号连接尚未确认';
  // The built-in success detail repeats the state above and exposes an internal transport name.
  const redundantMessage = status?.message === '账号 Agent 中继已连接；项目目录仍需独立验证' || status?.message === '账号 Agent 中继已连接；项目目录仍需独立验证。';
  const message = status?.message && !redundantMessage ? nativeMessages.get(status.message) || status.message : undefined;
  return <div className="space-y-2 text-sm">
    <p role="status">{pending && <Loader2 className="mr-1 inline h-3.5 w-3.5 animate-spin" />}{status ? `${labels[status.state]} · ${registration}${status.reconnectAttempt ? ` · 第 ${status.reconnectAttempt} 次重连` : ''}` : pending ? '正在准备本机项目连接…' : '本机项目连接尚未准备好。'}{message ? `：${message}` : ''}</p>
    {error && <p role="alert" className="break-words text-destructive">{error}</p>}
    {(!status || error || status.state === 'error' || status.state === 'stopped' || status.registrationState !== 'registered') && <Button type="button" variant="outline" size="sm" disabled={disabled || pending || status?.state === 'stopping'} onClick={() => void agent.ensure(id)}>{error ? '重试本机项目连接' : '准备本机项目连接'}</Button>}
  </div>;
}
