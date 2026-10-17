import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { Loader2 } from 'lucide-react';

import { FrontendBridge } from '@/shared/chisa';
import { useAuth } from '@/modules/auth/context/AuthContext';
import { WorkspaceConnectionForm } from '@/modules/auth/WorkspaceConnectionForm';
import { Button } from '@/shared/ui';

/** AccountPopup and desktop Settings use this independent account-service and optional file-sync setup. */
export function AccountServerConnection() {
  const { user, logout } = useAuth();
  const originalUrl = useRef('');
  // The user edits the native app's server URL before any protected APIs are available.
  const [serverUrl, setServerUrl] = useState('');
  // Connection feedback stays local to the current attempted server address.
  const [message, setMessage] = useState('');
  // Disable duplicate account-service connection attempts.
  const [connecting, setConnecting] = useState(false);
  useEffect(() => { void FrontendBridge.getState().then((state) => {
    originalUrl.current = state.serverUrl || '';
    setServerUrl(originalUrl.current);
  }).catch(() => setMessage('无法读取账号服务配置')); }, []);
  const connect = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setConnecting(true);
    setMessage('');
    try {
      const result = await FrontendBridge.connectServer(serverUrl.trim());
      if (result.ok === false) throw new Error(String(result.error || '连接失败'));
      if (originalUrl.current !== serverUrl.trim().replace(/\/$/, '')) logout();
      originalUrl.current = String(result.serverUrl);
      setMessage('账号服务已连接，可以登录');
    } catch (error) { setMessage(error instanceof Error ? error.message : '连接失败'); }
    finally { setConnecting(false); }
  };
  return <div className="space-y-5"><form className="space-y-3" onSubmit={connect}>
    <p className="text-sm text-muted-foreground">填写自己的 HTTPS 服务地址，用于账号登录和聊天。</p>
    <label className="block space-y-2 text-sm"><span>账号服务地址</span><input type="url" required value={serverUrl} onChange={(event) => setServerUrl(event.target.value)} placeholder="https://你的服务地址" className="w-full rounded-lg border border-input bg-background px-3 py-2" /></label>
    <Button type="submit" disabled={connecting || !serverUrl.trim()}>{connecting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}{connecting ? '连接中…' : '连接账号服务'}</Button>
    {message && <p role="status" className="text-sm text-muted-foreground">{message}</p>}
  </form>{user && <WorkspaceConnectionForm />}</div>;
}
