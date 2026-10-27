import { useEffect, useId, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { Check, CircleAlert, Globe, Loader2 } from 'lucide-react';

import { FrontendBridge } from '@/shared/chisa';
import { useAuth } from '@/modules/auth/context/AuthContext';
import { Button } from '@/shared/ui';

// Keep simultaneously mounted desktop login/settings forms aligned after a switch.
const SERVER_CHANGED_EVENT = 'chisa-account-server-changed';

type AccountServerConnectionProps = {
  onConnectionChange?: (ready: boolean) => void;
};

/** Desktop login, AccountPopup and Settings share the cloud account-service connection form. */
export function AccountServerConnection({ onConnectionChange }: AccountServerConnectionProps = {}) {
  const { logout } = useAuth();
  const originalUrl = useRef('');
  const serverInputId = useId();
  // The user edits the native app's server URL before any protected APIs are available.
  const [serverUrl, setServerUrl] = useState('');
  // Connection feedback stays local to the current attempted server address.
  const [message, setMessage] = useState('');
  // Separate successful connection feedback from an unsuccessful probe or edited URL.
  const [connected, setConnected] = useState(false);
  // Disable duplicate account-service connection attempts.
  const [connecting, setConnecting] = useState(false);
  useEffect(() => {
    let active = true;
    const handleServerChanged = (event: Event) => {
      const connectedUrl = (event as CustomEvent<string>).detail;
      originalUrl.current = connectedUrl;
      setServerUrl(connectedUrl);
      setConnected(false);
      setMessage('服务器地址已更新，请连接后登录');
      onConnectionChange?.(false);
    };
    window.addEventListener(SERVER_CHANGED_EVENT, handleServerChanged);
    void FrontendBridge.getState().then((state) => {
      if (!active) return;
      originalUrl.current = state.serverUrl || '';
      setServerUrl(originalUrl.current);
      // A saved/default address is configuration, not a successful connection probe.
      onConnectionChange?.(false);
    }).catch(() => { if (active) setMessage('无法读取账号服务配置，请填写服务器地址后重新连接'); });
    return () => { active = false; window.removeEventListener(SERVER_CHANGED_EVENT, handleServerChanged); };
  }, [onConnectionChange]);
  const connect = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setConnecting(true);
    setConnected(false);
    onConnectionChange?.(false);
    setMessage('');
    try {
      const result = await FrontendBridge.connectServer(serverUrl.trim());
      if (result.ok === false) throw new Error(String(result.error || '连接失败'));
      const connectedUrl = String(result.serverUrl || serverUrl.trim().replace(/\/$/, ''));
      if (originalUrl.current !== connectedUrl) {
        logout();
        window.dispatchEvent(new CustomEvent(SERVER_CHANGED_EVENT, { detail: connectedUrl }));
      }
      originalUrl.current = connectedUrl;
      setServerUrl(connectedUrl);
      onConnectionChange?.(true);
      setConnected(true);
      setMessage('已连接，可以登录');
    } catch (error) { setMessage(error instanceof Error ? error.message : '连接失败'); }
    finally { setConnecting(false); }
  };
  return (
    <div className="space-y-5">
      <form className="space-y-2.5" onSubmit={connect}>
        <label htmlFor={serverInputId} className="block text-sm font-medium">服务器地址</label>
        <div className="flex items-center gap-2">
          <div className="relative min-w-0 flex-1">
            <Globe aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <input
              id={serverInputId}
              type="url"
              required
              disabled={connecting}
              value={serverUrl}
              onChange={(event) => { setServerUrl(event.target.value); setConnected(false); onConnectionChange?.(false); setMessage(''); }}
              placeholder="https://your-server.com"
              autoComplete="url"
              spellCheck={false}
              aria-describedby={`${serverInputId}-status`}
              className="h-[42px] w-full rounded-lg border border-input bg-background pl-9 pr-3 text-sm outline-none transition-colors placeholder:text-muted-foreground/60 focus:border-primary focus:ring-2 focus:ring-primary/15 disabled:opacity-60"
            />
          </div>
          <Button type="submit" variant="outline" aria-label="连接服务器" disabled={connecting || !serverUrl.trim()} className="h-[42px] shrink-0 gap-1.5 rounded-lg px-3 text-xs font-medium shadow-none">
            {connecting ? <Loader2 aria-hidden="true" className="h-3.5 w-3.5 animate-spin" /> : connected ? <Check aria-hidden="true" className="h-3.5 w-3.5" /> : null}
            {connecting ? '连接中' : connected ? '重连' : '连接'}
          </Button>
        </div>
        <p id={`${serverInputId}-status`} role="status" className={`flex min-h-4 items-start gap-1.5 text-xs leading-relaxed ${connected ? 'text-emerald-700 dark:text-emerald-400' : message ? 'text-destructive' : 'text-muted-foreground'}`}>
          {message && (connected ? <Check aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0" /> : <CircleAlert aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0" />)}
          {message || '连接你的 ChisaCloudCode 服务器'}
        </p>
      </form>
    </div>
  );
}
