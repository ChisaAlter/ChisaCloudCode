import { createContext, useContext, useEffect, useMemo, useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';

import { getAuthSessionVersion } from '@/shared/authToken';
import { FrontendBridge, getServerConnectionVersion, isDesktop } from '@/shared/chisa';
import type { SshAgentController, SshAgentEnsureResult, SshTunnelProfilesResult, SshTunnelStatus } from '@/shared/types';

const SshAgentContext = createContext<SshAgentController | null>(null);

function createController() {
  const authVersion = getAuthSessionVersion();
  const serverVersion = getServerConnectionVersion();
  let disposed = false;
  let activated = false;
  // One account snapshot outlives setup panels so failures and pending work survive their unmounts.
  let snapshot = { profiles: [] as SshAgentController['profiles'], statuses: {} as SshAgentController['statuses'], loading: false, pending: [] as string[], errors: {} as Record<string, string>, revision: 0 };
  const listeners = new Set<() => void>();
  const inflight = new Map<string, Promise<SshAgentEnsureResult | null>>();
  const attempted = new Set<string>();
  let refreshing: Promise<SshTunnelProfilesResult | null> | null = null;
  const current = () => !disposed && authVersion === getAuthSessionVersion() && serverVersion === getServerConnectionVersion();
  const publish = (patch: Partial<typeof snapshot>) => {
    if (!current()) return;
    // Match native default selection: prefer saved HTTPS relay, then deterministic legacy Agent.
    const profiles = patch.profiles ? [...patch.profiles].sort((a, b) => Number(b.agentTransport === 'relay') - Number(a.agentTransport === 'relay') || a.id.localeCompare(b.id)) : snapshot.profiles;
    snapshot = { ...snapshot, ...patch, profiles };
    listeners.forEach(listener => listener());
  };
  const ready = (status?: SshTunnelStatus) => status?.state === 'forwarding' && status.outerConnected && status.registrationState === 'registered';
  const timed = async <T,>(operation: Promise<T>, milliseconds: number): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([operation, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('等待桌面 Agent 超时，请检查连接状态后重试。')), milliseconds); })]);
    } finally { clearTimeout(timer); }
  };
  const acceptStatus = (status: SshTunnelStatus) => {
    if ((snapshot.statuses[status.profileId]?.generation ?? -1) > status.generation) return;
    const wasReady = ready(snapshot.statuses[status.profileId]);
    const errors = { ...snapshot.errors };
    if (ready(status)) { delete errors[status.profileId]; delete errors['']; }
    publish({ statuses: { ...snapshot.statuses, [status.profileId]: status }, errors, revision: snapshot.revision + (!wasReady && ready(status) ? 1 : 0) });
  };
  const refresh = (): Promise<SshTunnelProfilesResult | null> => {
    if (!current() || !isDesktop()) return Promise.resolve(null);
    activated = true;
    if (refreshing) return refreshing;
    publish({ loading: snapshot.profiles.length === 0 });
    const previousStatuses = snapshot.statuses;
    refreshing = (async () => {
      try {
        const result = await timed(FrontendBridge.getSshTunnelProfiles(), 15000);
        if (!current()) return null;
        if (!result.ok || !Array.isArray(result.profiles) || !Array.isArray(result.statuses)) throw new Error(result.error || '无法读取当前账号的桌面 SSH 配置。');
        const errors = { ...snapshot.errors }; delete errors['$profiles'];
        publish({ profiles: result.profiles, errors });
        result.statuses.forEach(status => {
          // A lookup begun before Ensure completed must not roll back its newer status.
          if (snapshot.statuses[status.profileId] === previousStatuses[status.profileId]) acceptStatus(status);
        });
        return result;
      } catch (failure) {
        publish({ errors: { ...snapshot.errors, $profiles: failure instanceof Error ? failure.message : '无法读取桌面 SSH 配置。' } });
        return null;
      } finally { publish({ loading: false }); refreshing = null; }
    })();
    return refreshing;
  };
  const ensure = (profileId = ''): Promise<SshAgentEnsureResult | null> => {
    if (!current() || !isDesktop()) return Promise.resolve(null);
    activated = true;
    // Resolve the default to the same key as explicit callers whenever the saved catalog is known.
    const id = profileId || snapshot.profiles.find(profile => profile.mode === 'agent')?.id || '';
    const joined = inflight.get(id) || (id === snapshot.profiles.find(profile => profile.mode === 'agent')?.id ? inflight.get('') : undefined);
    if (joined) return joined;
    attempted.add(id);
    const errors = { ...snapshot.errors }; delete errors[id]; delete errors[''];
    publish({ pending: [...snapshot.pending, id], errors });
    const operation = (async () => {
      try {
        const result = await timed(FrontendBridge.ensureSshAgent(id), 40000);
        if (!current()) return null;
        if (result.profile) {
          attempted.add(result.profile.id);
          publish({ profiles: [...snapshot.profiles.filter(profile => profile.id !== result.profile!.id), result.profile] });
        }
        if (result.status) acceptStatus(result.status);
        if (!result.ok || !ready(result.status)) throw new Error(result.error || result.status?.registrationError || result.status?.message || '尚未确认 Agent 转发和账号登记，请检查状态后重试。');
        return result;
      } catch (failure) {
        publish({ errors: { ...snapshot.errors, [id]: failure instanceof Error ? failure.message : '无法准备桌面 Agent。' } });
        return null;
      } finally {
        inflight.delete(id);
        publish({ pending: snapshot.pending.filter(value => value !== id) });
      }
    })();
    inflight.set(id, operation);
    return operation;
  };
  const activate = async (connectionId?: string) => {
    const listed = await refresh();
    if (!current() || !listed) return;
    // A selected remote catalog entry must never start an unrelated local profile.
    const profile = connectionId ? listed.profiles?.find(item => item.id === connectionId && item.mode === 'agent') : snapshot.profiles.find(item => item.mode === 'agent');
    if (connectionId !== '' && !profile) return;
    const id = profile?.id || '';
    if (!attempted.has(id) && !ready(snapshot.statuses[id])) await ensure(id);
  };
  return {
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    getSnapshot: () => snapshot,
    refresh, ensure, activate,
    poll: () => { if (activated && document.visibilityState !== 'hidden') void refresh(); },
    resume: () => { disposed = false; },
    dispose: () => { disposed = true; },
  };
}

/** App mounts this beneath auth; SSH setup and selected projects share its lazy, account-bound controller. */
export function SshAgentProvider({ accountId, children }: { accountId: string | null; children: ReactNode }) {
  const account = accountId ? JSON.stringify([accountId, getAuthSessionVersion(), getServerConnectionVersion()]) : null;
  const controller = useMemo(() => account && isDesktop() ? createController() : null, [account]);
  useEffect(() => {
    if (!controller) return;
    controller.resume();
    const timer = window.setInterval(controller.poll, 2500);
    window.addEventListener('focus', controller.poll);
    return () => { window.clearInterval(timer); window.removeEventListener('focus', controller.poll); controller.dispose(); };
  }, [controller]);
  return controller ? <ControllerValue key={account} controller={controller}>{children}</ControllerValue> : <SshAgentContext.Provider value={null}>{children}</SshAgentContext.Provider>;
}

function ControllerValue({ controller, children }: { controller: ReturnType<typeof createController>; children: ReactNode }) {
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const value = useMemo(() => ({ ...snapshot, refresh: controller.refresh, ensure: controller.ensure, activate: controller.activate }), [snapshot, controller]);
  return <SshAgentContext.Provider value={value}>{children}</SshAgentContext.Provider>;
}

/** SSH panels and project-workspace use the same lifecycle instead of per-panel native startup. */
export function useSshAgent() { return useContext(SshAgentContext); }
