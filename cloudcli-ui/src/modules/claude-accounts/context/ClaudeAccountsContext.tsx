import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { api, readApiJson, subscribeToProviderConnectionChanges } from '@/shared/api';
import type {
  ClaudeAccountActionResult,
  ClaudeAccountLogin,
  ClaudeAccountSummary,
  ClaudeAccountUsage,
  ClaudeAccountsContextValue,
  ClaudeAccountsState,
} from '@/shared/types';

const ClaudeAccountsContext = createContext<ClaudeAccountsContextValue | null>(null);
const POLL_MS = 15 * 60_000;
const FOCUS_STALE_MS = 5 * 60_000;
const INACTIVE_DEBOUNCE_MS = 60_000;
const PENDING_LOGIN = new Set(['starting', 'waiting_code', 'completing']);

type Envelope<T> = { success: true; data: T };

function publicUsage(usage: ClaudeAccountUsage): ClaudeAccountUsage {
  if (!usage || !['ok', 'error', 'unavailable', 'loading'].includes(usage.status) || !Array.isArray(usage.windows)) {
    throw new Error('Invalid Claude usage response');
  }
  return {
    status: usage.status,
    windows: usage.windows.filter(window => window && typeof window.kind === 'string' && Number.isFinite(window.usedPercent)).map(window => ({
      kind: window.kind,
      label: typeof window.label === 'string' ? window.label : window.kind,
      usedPercent: Math.min(100, Math.max(0, window.usedPercent)),
      resetsAt: typeof window.resetsAt === 'number' && Number.isFinite(window.resetsAt) ? window.resetsAt : null,
    })),
    updatedAt: typeof usage.updatedAt === 'number' && Number.isFinite(usage.updatedAt) ? usage.updatedAt : null,
    checkedAt: Number.isFinite(usage.checkedAt) ? usage.checkedAt : 0,
    error: typeof usage.error === 'string' ? usage.error : null,
    failureKind: typeof usage.failureKind === 'string' ? usage.failureKind : undefined,
    retryAt: typeof usage.retryAt === 'number' && Number.isFinite(usage.retryAt) ? usage.retryAt : undefined,
    stale: usage.stale === true,
    extraUsage: usage.extraUsage ? {
      enabled: usage.extraUsage.enabled === true,
      spent: typeof usage.extraUsage.spent === 'number' && Number.isFinite(usage.extraUsage.spent) ? usage.extraUsage.spent : null,
      limit: typeof usage.extraUsage.limit === 'number' && Number.isFinite(usage.extraUsage.limit) ? usage.extraUsage.limit : null,
      balance: typeof usage.extraUsage.balance === 'number' && Number.isFinite(usage.extraUsage.balance) ? usage.extraUsage.balance : null,
      usedPercent: typeof usage.extraUsage.usedPercent === 'number' && Number.isFinite(usage.extraUsage.usedPercent) ? usage.extraUsage.usedPercent : null,
      currency: typeof usage.extraUsage.currency === 'string' ? usage.extraUsage.currency : 'USD',
    } : null,
  };
}

function publicAccount(account: ClaudeAccountSummary): ClaudeAccountSummary {
  if (!account || typeof account.id !== 'string' || typeof account.name !== 'string') throw new Error('Invalid Claude account response');
  return {
    id: account.id,
    name: account.name,
    email: typeof account.email === 'string' ? account.email : null,
    organizationName: typeof account.organizationName === 'string' ? account.organizationName : null,
    plan: typeof account.plan === 'string' ? account.plan : null,
    needsSignIn: account.needsSignIn === true,
    createdAt: Number.isFinite(account.createdAt) ? account.createdAt : 0,
    updatedAt: Number.isFinite(account.updatedAt) ? account.updatedAt : 0,
    usage: publicUsage(account.usage),
  };
}

function publicSnapshot(state: ClaudeAccountsState): ClaudeAccountsState {
  if (!state || !Array.isArray(state.accounts) || !state.runtime || typeof state.runtime.id !== 'string'
    || !(state.activeId === null || typeof state.activeId === 'string') || !state.route
    || !['subscription', 'api', 'hiroute', 'default'].includes(state.route.kind)) throw new Error('Invalid Claude accounts response');
  return {
    runtime: { id: state.runtime.id, label: state.runtime.label },
    activeId: state.activeId,
    accounts: state.accounts.map(publicAccount),
    defaultAccount: state.defaultAccount ? publicAccount(state.defaultAccount) : null,
    route: { kind: state.route.kind, label: state.route.label, accountId: state.route.accountId },
  };
}

function publicLogin(login: ClaudeAccountLogin): ClaudeAccountLogin {
  if (!login || typeof login.id !== 'string' || typeof login.accountId !== 'string'
    || !['starting', 'waiting_code', 'completing', 'succeeded', 'failed', 'cancelled'].includes(login.status)
    || !Number.isFinite(login.expiresAt)) throw new Error('Invalid Claude sign-in response');
  return { id: login.id, accountId: login.accountId, status: login.status, url: typeof login.url === 'string' ? login.url : null,
    error: typeof login.error === 'string' ? login.error : null, expiresAt: login.expiresAt };
}

/** App mounts one provider per protected account/server identity; sidebar and account/settings panels share its snapshots. */
export function ClaudeAccountsProvider({ children }: { children: ReactNode }) {
  const { t } = useTranslation('settings');
  // Only allowlisted public account data is retained for the current App-owned account identity.
  const [snapshot, setSnapshot] = useState<ClaudeAccountsState | null>(null);
  // Initial loading is distinct from background refresh so successful readings stay visible.
  const [loading, setLoading] = useState(true);
  // One refresh indicator covers the coalesced active or all-account request.
  const [refreshing, setRefreshing] = useState(false);
  // Account changes serialize client controls until the server confirms the selection.
  const [busy, setBusy] = useState(false);
  // A failed read or mutation remains visible without deleting the last account snapshot.
  const [error, setError] = useState<string | null>(null);
  // A login task survives closing the dialog, allowing the same task to be resumed.
  const [login, setLogin] = useState<ClaudeAccountLogin | null>(null);
  // Transport failures are separate from the CLI task's own failure reason.
  const [loginError, setLoginError] = useState<string | null>(null);
  // Code submission and cancellation cannot race another login operation.
  const [loginBusy, setLoginBusy] = useState(false);
  const mounted = useRef(false);
  const snapshotRef = useRef<ClaudeAccountsState | null>(null);
  const busyRef = useRef(false);
  const refreshingRef = useRef(false);
  const stateGeneration = useRef(0);
  const stateRequest = useRef<AbortController | null>(null);
  const loginGeneration = useRef(0);
  const loginRequest = useRef<AbortController | null>(null);
  const loginRef = useRef<ClaudeAccountLogin | null>(null);
  const loginBusyRef = useRef(false);
  const lastAllRefresh = useRef(0);
  const allReadInFlight = useRef(false);
  const pendingRouteRead = useRef(false);
  const completedLogin = useRef<string | null>(null);
  const translate = useRef(t);
  useEffect(() => { translate.current = t; }, [t]);

  const failure = useCallback((cause: unknown) => cause instanceof Error && cause.message
    ? cause.message : translate.current('claudeAccounts.requestFailed'), []);

  const accept = useCallback((next: ClaudeAccountsState) => {
    snapshotRef.current = next;
    setSnapshot(next);
  }, []);

  const readState = useCallback(async (mode: 'state' | 'active' | 'all', automatic = false) => {
    if (busyRef.current || (automatic && document.visibilityState === 'hidden')) return;
    if (automatic && refreshingRef.current && mode !== 'all') return;
    if (mode === 'all' && allReadInFlight.current) return;
    const current = snapshotRef.current;
    const active = current?.activeId === null ? current.defaultAccount : current?.accounts.find(account => account.id === current.activeId);
    if (automatic && mode === 'active' && active?.usage.retryAt && active.usage.retryAt > Date.now()) return;
    stateRequest.current?.abort();
    const controller = new AbortController();
    stateRequest.current = controller;
    const generation = ++stateGeneration.current;
    refreshingRef.current = true;
    allReadInFlight.current = mode === 'all';
    setRefreshing(true);
    try {
      const response = mode === 'state'
        ? await api.providers.claudeAccounts.state({ signal: controller.signal })
        : await api.providers.claudeAccounts.refresh(mode === 'all' ? { all: true } : { id: current?.activeId ?? null }, { signal: controller.signal });
      const result = await readApiJson<Envelope<ClaudeAccountsState>>(response);
      const next = publicSnapshot(result.data);
      if (!mounted.current || controller.signal.aborted || generation !== stateGeneration.current) return;
      accept(next);
      setError(null);
      if (mode === 'all') lastAllRefresh.current = Date.now();
    } catch (cause) {
      if (mounted.current && !controller.signal.aborted && generation === stateGeneration.current) setError(failure(cause));
    } finally {
      if (mounted.current && generation === stateGeneration.current) {
        refreshingRef.current = false;
        allReadInFlight.current = false;
        setRefreshing(false);
        setLoading(false);
      }
    }
  }, [accept, failure]);

  const refresh = useCallback(async (options: { all?: boolean; automatic?: boolean } = {}) => {
    await readState(options.all ? 'all' : 'active', options.automatic);
  }, [readState]);

  useEffect(() => {
    mounted.current = true;
    void readState('state');
    const onFocus = () => {
      if (document.visibilityState === 'hidden') return;
      const state = snapshotRef.current;
      const account = state?.activeId === null ? state.defaultAccount : state?.accounts.find(item => item.id === state.activeId);
      if (!account || Date.now() - account.usage.checkedAt >= FOCUS_STALE_MS) void readState('active', true);
    };
    const timer = window.setInterval(() => { void readState('active', true); }, POLL_MS);
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onFocus);
    return () => {
      mounted.current = false;
      stateGeneration.current += 1;
      loginGeneration.current += 1;
      stateRequest.current?.abort();
      loginRequest.current?.abort();
      window.clearInterval(timer);
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onFocus);
    };
  }, [readState]);

  const openAccounts = useCallback(() => {
    if (Date.now() - lastAllRefresh.current >= INACTIVE_DEBOUNCE_MS) {
      // Only a successful read starts the debounce; opening during initial load must still fetch inactive accounts.
      void readState('all', true);
    }
  }, [readState]);

  useEffect(() => subscribeToProviderConnectionChanges(source => {
    if (source !== 'connections') return;
    if (busyRef.current) {
      // Do not supersede an account mutation; drain the changed-route metadata after it settles.
      pendingRouteRead.current = true;
    } else {
      void readState('state');
    }
  }), [readState]);

  const mutate = useCallback(async (operation: (signal: AbortSignal) => Promise<Response>): Promise<ClaudeAccountActionResult> => {
    if (busyRef.current) return { ok: false };
    busyRef.current = true;
    setBusy(true);
    setError(null);
    stateRequest.current?.abort();
    const generation = ++stateGeneration.current;
    const controller = new AbortController();
    stateRequest.current = controller;
    refreshingRef.current = false;
    allReadInFlight.current = false;
    setRefreshing(false);
    let succeeded = false;
    try {
      const result = await readApiJson<Envelope<ClaudeAccountsState>>(await operation(controller.signal));
      if (!mounted.current || controller.signal.aborted || generation !== stateGeneration.current) return { ok: false };
      accept(publicSnapshot(result.data));
      succeeded = true;
      // The mutation response is already authoritative; refresh reads newly selected quota afterwards.
      return { ok: true };
    } catch (cause) {
      const message = failure(cause);
      if (mounted.current && !controller.signal.aborted && generation === stateGeneration.current) setError(message);
      return { ok: false, error: message };
    } finally {
      if (mounted.current && generation === stateGeneration.current) {
        busyRef.current = false;
        setBusy(false);
        if (pendingRouteRead.current) {
          pendingRouteRead.current = false;
          void readState('state');
        } else if (succeeded) {
          void readState('active', true);
        }
      }
    }
  }, [accept, failure, readState]);

  const activate = useCallback((id: string | null) => mutate(signal => api.providers.claudeAccounts.activate(id, { signal })), [mutate]);
  const rename = useCallback((id: string, name: string) => mutate(signal => api.providers.claudeAccounts.rename(id, name, { signal })), [mutate]);
  const remove = useCallback((id: string) => mutate(signal => api.providers.claudeAccounts.remove(id, { signal })), [mutate]);

  const loginOperation = useCallback(async (operation: (signal: AbortSignal) => Promise<Response>, cancelled = false): Promise<ClaudeAccountActionResult> => {
    if (loginBusyRef.current) return { ok: false };
    loginBusyRef.current = true;
    setLoginBusy(true);
    setLoginError(null);
    loginRequest.current?.abort();
    const generation = ++loginGeneration.current;
    const controller = new AbortController();
    loginRequest.current = controller;
    try {
      const result = await readApiJson<Envelope<ClaudeAccountLogin>>(await operation(controller.signal));
      if (!mounted.current || controller.signal.aborted || generation !== loginGeneration.current) return { ok: false };
      const next = result.data ? publicLogin(result.data) : cancelled && loginRef.current ? { ...loginRef.current, status: 'cancelled' as const } : null;
      loginRef.current = next;
      setLogin(next);
      return { ok: true };
    } catch (cause) {
      const message = failure(cause);
      if (mounted.current && !controller.signal.aborted && generation === loginGeneration.current) setLoginError(message);
      return { ok: false, error: message };
    } finally {
      if (mounted.current && generation === loginGeneration.current) {
        loginBusyRef.current = false;
        setLoginBusy(false);
      }
    }
  }, [failure]);

  const startLogin = useCallback((input: { accountId?: string; name?: string } = {}) => loginOperation(signal => api.providers.claudeAccounts.login(input, { signal })), [loginOperation]);
  const submitCode = useCallback((code: string) => loginRef.current
    ? loginOperation(signal => api.providers.claudeAccounts.submitCode(loginRef.current!.id, code, { signal }))
    : Promise.resolve({ ok: false }), [loginOperation]);
  const cancelLogin = useCallback(() => loginRef.current
    ? loginOperation(signal => api.providers.claudeAccounts.cancelLogin(loginRef.current!.id, { signal }), true)
    : Promise.resolve({ ok: false }), [loginOperation]);
  const dismissLogin = useCallback(() => {
    if (loginRef.current && PENDING_LOGIN.has(loginRef.current.status)) return;
    loginGeneration.current += 1;
    loginRequest.current?.abort();
    loginRef.current = null;
    setLogin(null);
    setLoginError(null);
  }, []);

  useEffect(() => {
    if (!login) return;
    if (login.status === 'succeeded') {
      if (completedLogin.current !== login.id) {
        completedLogin.current = login.id;
        void readState('state').then(() => readState('all', true));
      }
      return;
    }
    if (!PENDING_LOGIN.has(login.status)) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    let pollController: AbortController | null = null;
    const poll = async () => {
      if (disposed) return;
      if (loginBusyRef.current || document.visibilityState === 'hidden') {
        timer = setTimeout(poll, 2000);
        return;
      }
      const generation = loginGeneration.current;
      pollController = new AbortController();
      try {
        const result = await readApiJson<Envelope<ClaudeAccountLogin>>(await api.providers.claudeAccounts.loginStatus(login.id, { signal: pollController.signal }));
        if (disposed || pollController.signal.aborted || !mounted.current || generation !== loginGeneration.current) return;
        const next = publicLogin(result.data);
        const previousStatus = loginRef.current?.status;
        loginRef.current = next;
        setLogin(next);
        // An unchanged status poll must not erase an actionable code-submission error.
        if (next.status !== previousStatus || !PENDING_LOGIN.has(next.status)) setLoginError(null);
      } catch (cause) {
        if (!disposed && !pollController.signal.aborted && generation === loginGeneration.current) setLoginError(failure(cause));
      } finally {
        if (!disposed) timer = setTimeout(poll, 2000);
      }
    };
    timer = setTimeout(poll, 1500);
    return () => { disposed = true; clearTimeout(timer); pollController?.abort(); };
  }, [failure, login, readState]);

  const value = useMemo<ClaudeAccountsContextValue>(() => ({ snapshot, loading, refreshing, busy, error, login, loginError, loginBusy,
    refresh, openAccounts, activate, rename, remove, startLogin, submitCode, cancelLogin, dismissLogin }),
  [snapshot, loading, refreshing, busy, error, login, loginError, loginBusy, refresh, openAccounts, activate, rename, remove, startLogin, submitCode, cancelLogin, dismissLogin]);
  return <ClaudeAccountsContext.Provider value={value}>{children}</ClaudeAccountsContext.Provider>;
}

/** Sidebar can also render in signed-out or isolated shells, where quota has no protected account owner. */
// Context hooks intentionally share their owning provider without a cross-module export.
// oxlint-disable-next-line react/only-export-components
export function useOptionalClaudeAccounts() {
  return useContext(ClaudeAccountsContext);
}

/** Quota triggers and account panels share the provider mounted by App; never fetch outside protected auth. */
// oxlint-disable-next-line react/only-export-components
export function useClaudeAccounts() {
  const context = useOptionalClaudeAccounts();
  if (!context) throw new Error('Claude account controls require ClaudeAccountsProvider');
  return context;
}
