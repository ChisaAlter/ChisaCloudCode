import { useEffect, useId, useState } from 'react';
import { CheckCircle2, Loader2 } from 'lucide-react';

import { FrontendBridge, onWorkspaceConnectionChanged } from '@/shared/chisa';
import type { ChisaState } from '@/shared/types';
import { Button } from '@/shared/ui';

/** AccountServerConnection shows automatic account-bound sync without another configuration form. */
export function WorkspaceConnectionForm() {
  const headingId = useId();
  // Display the native account's connection progress and outcome without assuming login means sync is ready.
  const [workspaceState, setWorkspaceState] = useState<ChisaState | null>(null);
  // Prevent overlapping account connection attempts.
  const [busy, setBusy] = useState(false);
  // Local bridge failures are displayed beside the connection controls.
  const [errorMessage, setErrorMessage] = useState('');

  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const state = await FrontendBridge.getState();
        if (!active) return;
        setWorkspaceState(state);
        // Joining login's in-flight setup gives its final result without starting another attempt.
        if (state.workspaceConnecting) {
          await FrontendBridge.connectAccountWorkspace();
          const settledState = await FrontendBridge.getState();
          if (active) setWorkspaceState(settledState);
        }
      } catch (error) {
        if (active) setErrorMessage(error instanceof Error ? error.message : '无法读取文件同步状态');
      }
    };
    const unsubscribe = onWorkspaceConnectionChanged(() => {
      void FrontendBridge.getState().then(state => {
        if (active) {
          setWorkspaceState(state);
          setErrorMessage('');
        }
      }).catch(error => {
        if (active) setErrorMessage(error instanceof Error ? error.message : '无法读取文件同步状态');
      });
    });
    void load();
    return () => { active = false; unsubscribe(); };
  }, []);

  const connect = async () => {
    setBusy(true);
    setErrorMessage('');
    try {
      const result = await FrontendBridge.connectAccountWorkspace();
      const state = await FrontendBridge.getState();
      setWorkspaceState(state);
      if (!result.ok) throw new Error(String(result.error || '文件同步连接失败'));
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : '文件同步连接失败');
    } finally {
      setBusy(false);
    }
  };

  const connecting = busy || Boolean(workspaceState?.workspaceConnecting && !errorMessage);
  const connected = Boolean(workspaceState?.tunnel && !workspaceState.workspaceError);
  const loading = workspaceState === null && !errorMessage;
  const error = connecting ? '' : errorMessage || workspaceState?.workspaceError;

  return <section className="space-y-3 border-t border-border pt-4" aria-labelledby={headingId}>
    <h3 id={headingId} className="text-sm font-medium">本地文件同步</h3>
    <p className="text-sm leading-relaxed text-muted-foreground">文件同步使用登录账号自动连接，无需另行配置。选择本机目录即可打开项目。</p>
    <div role="status" className="flex items-center gap-2 text-sm">
      {(connecting || loading) && <Loader2 aria-hidden="true" className="h-4 w-4 shrink-0 animate-spin text-muted-foreground" />}
      {connected && !connecting && <CheckCircle2 aria-hidden="true" className="h-4 w-4 shrink-0 text-muted-foreground" />}
      <span>{connecting ? '正在连接文件同步…' : loading ? '正在读取连接状态…' : connected ? '文件同步已连接，可以打开本机目录' : '文件同步尚未连接'}</span>
    </div>
    {error && <p role="alert" className="break-words text-sm leading-relaxed text-destructive">{error}</p>}
    <Button type="button" variant="outline" disabled={connecting || loading} onClick={() => void connect()}>
      {connecting ? '连接中…' : connected ? '重新连接' : '重试连接'}
    </Button>
  </section>;
}
