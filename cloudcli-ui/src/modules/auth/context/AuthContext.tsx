import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import type { ReactNode } from 'react';

import { IS_PLATFORM } from '@/shared/utils';
import { api, getResponseAuthSession, readApiErrorMessage, ServiceConnectionError } from '@/shared/api';
import { FrontendBridge, isDesktop } from '@/shared/chisa';
import { acknowledgeAuthSession, clearAuthToken, getAuthSessionSnapshot, getAuthSessionVersion, getAuthTokenRefreshDelay, initializeAuthSession, isCurrentAuthSession, isValidRefreshedToken, startAuthSession, storeAuthToken, subscribeToAuthSession } from '@/shared/authToken';
import { hydrateChatDrafts, resetChatDrafts } from '@/shared/chatDrafts';
import { hydrateUserPreferences, resetUserPreferences } from '@/shared/userSettings';
import type { AuthSessionSnapshot, AuthUserProfile } from '@/shared/types';
import { logoutWebSession, pendingWebRevocations, retryWebRevocations } from '@/modules/auth/web-revocation.service';

const AUTH_ERROR_MESSAGES = {
  authStatusCheckFailed: 'errors.authStatusCheckFailed',
  loginFailed: 'errors.loginFailed',
  networkError: 'errors.networkError',
  sessionExpired: 'errors.sessionExpired',
} as const;

type AuthActionResult = { success: true } | { success: false; error: string };

type AuthSessionPayload = {
  token?: string;
  user?: AuthUserProfile;
};

type AuthUserPayload = {
  user?: AuthUserProfile;
};

type OnboardingStatusPayload = {
  hasCompletedOnboarding?: boolean;
};

type AuthContextValue = {
  user: AuthUserProfile | null;
  token: string | null;
  isLoading: boolean;
  hasCompletedOnboarding: boolean;
  error: string | null;
  login: (username: string, password: string) => Promise<AuthActionResult>;
  logout: () => void;
  updateProfile: (displayName: string, avatarDataUrl: string | null) => Promise<AuthActionResult>;
  refreshAuthStatus: () => Promise<void>;
  refreshOnboardingStatus: () => Promise<void>;
};

type AuthProviderProps = {
  children: ReactNode;
};

async function parseJsonSafely<T>(response: Response): Promise<T | null> {
  try {
    return (await response.json()) as T;
  } catch {
    return null;
  }
}

const AuthContext = createContext<AuthContextValue | null>(null);

const readStoredToken = (): string | null => getAuthSessionSnapshot().token;

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }

  return context;
}

/** Used by App to expose the session, and its login/logout actions, to every module through useAuth. */
export function AuthProvider({ children }: AuthProviderProps) {
  const { t } = useTranslation('auth');
  // Auth and every transport observe the same committed identity, including cross-window changes.
  const session = useSyncExternalStore(subscribeToAuthSession, getAuthSessionSnapshot, getAuthSessionSnapshot);
  // The profile belongs to verifiedSessionId; a remotely replaced identity is hidden before effects run.
  const [user, setUser] = useState<AuthUserProfile | null>(null);
  const token = session.token;
  // Verification ownership prevents old-account content dispatching with another window's newly committed identity.
  const [verifiedSessionId, setVerifiedSessionId] = useState<string | null>(null);
  // Profile verification records its originating incarnation before React state commits, fencing stale effects.
  const verifiedSessionRef = useRef<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [hasCompletedOnboarding, setHasCompletedOnboarding] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Refreshing an already authenticated identity must not unmount its workspace.
  const userRef = useRef(user);
  userRef.current = user;
  // Only the latest account check can apply its response or finish initial loading.
  const authCheckRevision = useRef(0);
  // A stored session that cannot be checked yet remains retryable without resubmitting credentials.
  const [connectionRetry, setConnectionRetry] = useState(0);
  // Retry backoff is reset when the account is verified or explicitly signed out.
  const retryAttempt = useRef(0);
  // Logout notices belong only to the signed-out successor; late old receipts cannot affect a replacement account.
  const [logoutNotice, setLogoutNotice] = useState<{ identity: string; message: string; retryable: boolean } | null>(null);
  // One explicit attempt owns its closing transition until local persistence completes; network ACK may finish later.
  const explicitLogout = useRef(false);
  // An earlier remote ACK cannot unlock a newer login's independently running logout transition.
  const logoutAttempt = useRef(0);

  const clearSession = useCallback(() => {
    const expected = getAuthSessionSnapshot();
    // Capture the predecessor before yielding; never revoke a later renderer/native identity.
    if (isDesktop()) {
      void FrontendBridge.endServerSession().catch(() => setError('账号连接关闭失败，请重新连接并检查登录状态'));
    } else {
      void clearAuthToken(expected).catch(() => setError('无法更新本地登录状态，请重试注销'));
    }
    authCheckRevision.current += 1;
    retryAttempt.current = 0;
    setConnectionRetry(0);
    userRef.current = null;
    setUser(null);
    verifiedSessionRef.current = null;
    setVerifiedSessionId(null);
    setIsLoading(false);
    // Otherwise the next person to sign in on this device would start out
    // looking at the previous user's theme, language, permissions and drafts.
    resetUserPreferences();
    resetChatDrafts();
  }, []);

  // Preferences live in auth.db, so they can only be fetched once there is a
  // user to fetch them for. Until this resolves, every reader falls back to the
  // localStorage mirror of the last known server state.
  const userKey = user ? String(user.id ?? user.username) : null;
  useEffect(() => {
    if (!userKey) {
      return;
    }
    void hydrateUserPreferences();
    void hydrateChatDrafts();
  }, [userKey]);

  const checkOnboardingStatus = useCallback(async () => {
    const identity = getAuthSessionVersion();
    try {
      const response = await api.user.onboardingStatus();
      if (!response.ok) {
        return;
      }

      const payload = await parseJsonSafely<OnboardingStatusPayload>(response);
      if (identity !== getAuthSessionVersion()) return;
      setHasCompletedOnboarding(Boolean(payload?.hasCompletedOnboarding));
    } catch (caughtError) {
      if (identity !== getAuthSessionVersion()) return;
      console.error('Error checking onboarding status:', caughtError);
      // Fail open to avoid blocking access on transient onboarding status errors.
      setHasCompletedOnboarding(true);
    }
  }, []);

  const refreshOnboardingStatus = useCallback(async () => {
    await checkOnboardingStatus();
  }, [checkOnboardingStatus]);

  const refreshSession = useCallback(async () => {
    if (IS_PLATFORM || !token || !user) {
      return;
    }

    const expected = getAuthSessionSnapshot();
    try {
      const response = await api.auth.refresh();
      if (!response.ok) {
        return;
      }

      const payload = await parseJsonSafely<AuthSessionPayload>(response);
      if (!isCurrentAuthSession(expected)) return;
      if (!isDesktop() && isValidRefreshedToken(payload?.token)) await storeAuthToken(payload.token, expected);
    } catch (caughtError) {
      if (!isCurrentAuthSession(expected)) return;
      // A transient network failure must not sign the user out. Focus/visibility
      // and the next scheduled refresh will retry while the token remains valid.
      console.warn('[Auth] Session refresh failed:', caughtError);
    }
  }, [token, user]);

  useLayoutEffect(() => {
    if (session.phase === 'ready' && verifiedSessionId === session.sessionInstanceId) acknowledgeAuthSession(session);
  }, [session, verifiedSessionId]);

  useEffect(() => {
    if (verifiedSessionRef.current === session.sessionInstanceId) return;
    authCheckRevision.current++;
    userRef.current = null;
    setUser(null);
    verifiedSessionRef.current = null;
    setVerifiedSessionId(null);
    resetUserPreferences();
    resetChatDrafts();
    if (session.phase === 'signedOut' || session.phase === 'closing') setIsLoading(false);
  }, [session.sessionInstanceId]);

  // The startup check below needs `t` only for its failure message.
  // react-i18next gives `t` a new identity on every language change, so
  // depending on it would re-run that check - and swap the whole app for the
  // loading screen - whenever the language changes, including when sign-in
  // adopts the language saved on another device.
  const tRef = useRef(t);
  useEffect(() => {
    tRef.current = t;
  }, [t]);

  const checkAuthStatus = useCallback(async () => {
    const revision = ++authCheckRevision.current;
    let expected = getAuthSessionSnapshot();
    const current = () => isCurrentAuthSession(expected) && revision === authCheckRevision.current;
    try {
      expected = await initializeAuthSession();
      if (expected.phase === 'closing') return;
      if (!userRef.current && retryAttempt.current === 0) setIsLoading(true);

      // Read the stored token instead of depending on `token` state: this
      // bootstrap flips `isLoading`, which swaps the whole app for the loading
      // screen, so it must run once on mount and not again on every
      // X-Refreshed-Token rotation (each one remounted the workspace, #1269).
      if (isDesktop()) {
        const connection = await FrontendBridge.getApiConnection();
        if (revision !== authCheckRevision.current) return;
        expected = getAuthSessionSnapshot();
        if (!connection.authenticated && !connection.restorationToken) return;
      } else if (!readStoredToken()) return;

      // A removed token may have just emitted the session-expired notice; keep it until login.
      setError(null);
      const userResponse = await api.auth.user();
      if (isDesktop() && revision === authCheckRevision.current) expected = getResponseAuthSession(userResponse) ?? expected;
      if (!current()) return;
      if (!userResponse.ok) {
        if (userResponse.status === 401 || userResponse.status === 403) {
          const rejectedSession = getResponseAuthSession(userResponse) ?? expected;
          if (!isCurrentAuthSession(rejectedSession, true)) return;
          clearSession();
        } else {
          retryAttempt.current += 1;
          setConnectionRetry(value => value + 1);
          setError('暂时无法连接账号服务，已保留登录状态，恢复连接后会自动重试。');
        }
        return;
      }

      const userPayload = await parseJsonSafely<AuthUserPayload>(userResponse);
      if (!current()) return;
      if (!userPayload?.user) {
        clearSession();
        return;
      }

      retryAttempt.current = 0;
      setConnectionRetry(0);
      userRef.current = userPayload.user;
      setUser(userPayload.user);
      verifiedSessionRef.current = expected.sessionInstanceId;
      setVerifiedSessionId(expected.sessionInstanceId);
      acknowledgeAuthSession(expected);
      await checkOnboardingStatus();
    } catch (caughtError) {
      if (!current()) return;
      console.error('[Auth] Auth status check failed:', caughtError);
      retryAttempt.current += 1;
      setConnectionRetry(value => value + 1);
      setError(tRef.current(AUTH_ERROR_MESSAGES.authStatusCheckFailed));
    } finally {
      if (current() || (revision === authCheckRevision.current && getAuthSessionSnapshot().phase === 'signedOut')) setIsLoading(false);
    }
  }, [checkOnboardingStatus, clearSession]);

  useEffect(() => {
    if (IS_PLATFORM) {
      setUser({ username: 'platform-user' });
      void checkOnboardingStatus().finally(() => {
        setIsLoading(false);
      });
      return;
    }

    void checkAuthStatus();
  }, [checkAuthStatus, checkOnboardingStatus, session.sessionInstanceId]);

  useEffect(() => {
    if (IS_PLATFORM || !token || !user) {
      return undefined;
    }

    const refreshIfNeeded = () => {
      const refreshDelay = getAuthTokenRefreshDelay(token);
      if (refreshDelay !== null && refreshDelay <= 0) {
        void refreshSession();
      }
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        refreshIfNeeded();
      }
    };

    const refreshDelay = getAuthTokenRefreshDelay(token);
    const refreshTimer = refreshDelay === null
      ? null
      : window.setTimeout(() => void refreshSession(), refreshDelay);

    window.addEventListener('focus', refreshIfNeeded);
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      if (refreshTimer !== null) {
        window.clearTimeout(refreshTimer);
      }
      window.removeEventListener('focus', refreshIfNeeded);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [refreshSession, token, user]);

  useEffect(() => {
    if (IS_PLATFORM || !token || !connectionRetry) return;
    const identity = getAuthSessionVersion();
    let pending = false;
    const retry = async () => {
      if (pending || identity !== getAuthSessionVersion()) return;
      pending = true;
      try { await checkAuthStatus(); } finally { pending = false; }
    };
    const timer = window.setTimeout(() => void retry(), Math.min(30000, 1000 * 2 ** Math.min(retryAttempt.current - 1, 5)));
    const onOnline = () => { void retry(); };
    window.addEventListener('online', onOnline);
    window.addEventListener('focus', onOnline);
    return () => { window.clearTimeout(timer); window.removeEventListener('online', onOnline); window.removeEventListener('focus', onOnline); };
  }, [token, connectionRetry, checkAuthStatus]);

  // Settle onboarding before publishing the signed-in user so the workspace mounts once.
  // A new account epoch also invalidates replies still in flight for the previous identity.
  const publishSession = useCallback(async (nextUser: AuthUserProfile, nextToken: string, predecessor: AuthSessionSnapshot) => {
    if (!isCurrentAuthSession(predecessor)) return false;
    if (!isDesktop()) {
      const next = await startAuthSession(nextToken, predecessor);
      if (!next) return false;
    }
    const expected = getAuthSessionSnapshot();
    if (expected.phase !== 'ready' || !expected.token) return false;
    userRef.current = nextUser;
    setUser(nextUser);
    verifiedSessionRef.current = expected.sessionInstanceId;
    setVerifiedSessionId(expected.sessionInstanceId);
    acknowledgeAuthSession(expected);
    await checkOnboardingStatus();
    return isCurrentAuthSession(expected);
  }, [checkOnboardingStatus]);

  const login = useCallback<AuthContextValue['login']>(
    async (username, password) => {
      const identity = getAuthSessionVersion();
      try {
        setError(null);
        const response = await api.auth.login(username, password);
        const responseSession = getResponseAuthSession(response) ?? getAuthSessionSnapshot();
        const payload = await parseJsonSafely<AuthSessionPayload>(response);
        if (!isCurrentAuthSession(responseSession)) return { success: false, error: 'Account session changed' };
        if (!isDesktop() && identity !== getAuthSessionVersion()) return { success: false, error: 'Account session changed' };

        if (!response.ok || !payload?.token || !payload.user) {
          // Most auth failures arrive as the structured AppError envelope; passing its
          // `error` object on would render it as a React child and blank the screen.
          const message = readApiErrorMessage(payload) ?? t(AUTH_ERROR_MESSAGES.loginFailed);
          setError(message);
          return { success: false, error: message };
        }

        if (!await publishSession(payload.user, payload.token, responseSession)) {
          return { success: false, error: 'Account session changed' };
        }
        return { success: true };
      } catch (caughtError) {
        if (identity !== getAuthSessionVersion()) return { success: false, error: 'Account session changed' };
        console.error('Login error:', caughtError);
        const message = caughtError instanceof ServiceConnectionError ? caughtError.message : t(AUTH_ERROR_MESSAGES.networkError);
        setError(message);
        return { success: false, error: message };
      }
    },
    [publishSession, t],
  );

  const logout = useCallback(() => {
    const expected = getAuthSessionSnapshot();
    if (explicitLogout.current || !expected.token || !['ready', 'closing'].includes(expected.phase)) return;
    explicitLogout.current = true;
    const attempt = ++logoutAttempt.current;
    authCheckRevision.current++;
    retryAttempt.current = 0;
    setConnectionRetry(0);
    setError(null);
    setLogoutNotice({ identity: expected.sessionInstanceId, message: '正在安全退出并记录服务器会话吊销…', retryable: false });
    const clearVisibleAccount = () => {
      userRef.current = null; setUser(null); verifiedSessionRef.current = null; setVerifiedSessionId(null); setIsLoading(false);
      resetUserPreferences(); resetChatDrafts();
    };
    const message = (status: string | undefined) => status === 'revoked' ? '服务器已确认退出登录。'
      : status === 'expired' ? '原会话已到期；未收到服务器注销确认。'
        : status === 'rejected' ? '服务器未确认原会话注销，已保留待处理记录。'
          : status === 'not-required' ? '已退出本地登录。'
            : '已退出本地登录，服务器会话吊销待确认；恢复连接后会继续重试。';
    const run = async () => {
      try {
        if (isDesktop()) {
          const operation = FrontendBridge.endServerSession();
          clearVisibleAccount();
          const result = await operation;
          if (!result.ok || !result.receipt?.localCleared) throw new Error('Native logout was not durably committed');
          const current = getAuthSessionSnapshot();
          if (current.phase === 'signedOut' && !current.token && current.serverKey === expected.serverKey
            && result.connection?.sessionHandle === current.sessionInstanceId) {
            setLogoutNotice({ identity: current.sessionInstanceId, message: message(result.receipt.remoteStatus), retryable: result.receipt.pendingRevocation });
          }
          return;
        }
        // This call synchronously freezes authority. Its transaction persists the outbox and dispatches the captured Bearer before clearing local login.
        const operation = logoutWebSession(expected);
        clearVisibleAccount();
        const admitted = await operation;
        if (!admitted) {
          const current = getAuthSessionSnapshot();
          if (current.phase === 'ready' && current.sessionInstanceId === expected.sessionInstanceId) {
            setError('登录凭据在注销前已更新，请重试注销。');
            void checkAuthStatus();
          }
          return;
        }
        const successor = admitted.snapshot;
        if (isCurrentAuthSession(successor) && successor.phase === 'signedOut') {
          setLogoutNotice({ identity: successor.sessionInstanceId, message: message('pending'), retryable: true });
        }
        // Release the UI action before an offline request settles; a newer login is independent of this receipt.
        if (logoutAttempt.current === attempt) explicitLogout.current = false;
        const receipt = await admitted.operation;
        if (isCurrentAuthSession(successor) && getAuthSessionSnapshot().phase === 'signedOut') {
          setLogoutNotice({ identity: successor.sessionInstanceId, message: message(receipt.remoteStatus), retryable: receipt.remoteStatus === 'pending' || receipt.remoteStatus === 'rejected' });
        }
      } catch {
        const current = getAuthSessionSnapshot();
        if (current.sessionInstanceId === expected.sessionInstanceId && current.serverKey === expected.serverKey) {
          setLogoutNotice({ identity: expected.sessionInstanceId, message: '注销记录未能安全保存，登录已暂停。请重试注销；尚未确认服务器会话吊销。', retryable: true });
        }
      } finally { if (logoutAttempt.current === attempt) explicitLogout.current = false; }
    };
    void run();
  }, [checkAuthStatus]);

  useEffect(() => {
    if (isDesktop()) return;
    const expected = getAuthSessionSnapshot();
    if (expected.sessionInstanceId !== session.sessionInstanceId || expected.serverKey !== session.serverKey || expected.phase !== session.phase) return;
    const current = () => isCurrentAuthSession(expected) && getAuthSessionSnapshot().phase === 'signedOut';
    let disposed = false;
    let pending = false;
    const retry = async () => {
      if (pending) return;
      pending = true;
      try {
        const receipts = await retryWebRevocations();
        if (disposed || !current() || !receipts.length) return;
        const unresolved = receipts.some(receipt => receipt.remoteStatus === 'pending' || receipt.remoteStatus === 'rejected');
        const expired = receipts.some(receipt => receipt.remoteStatus === 'expired');
        setLogoutNotice({ identity: expected.sessionInstanceId, retryable: unresolved,
          message: unresolved ? '已退出本地登录，服务器会话吊销待确认；恢复连接后会继续重试。'
            : expired ? '原会话已到期；未收到服务器注销确认。' : '服务器已确认退出登录。' });
      } catch {
        if (!disposed && current()) setLogoutNotice({ identity: expected.sessionInstanceId, message: '无法读取待处理的注销记录，请重试。', retryable: true });
      } finally { pending = false; }
    };
    void pendingWebRevocations().then(receipts => {
      if (disposed || !receipts.length) return;
      if (current()) setLogoutNotice({ identity: expected.sessionInstanceId, message: '已退出本地登录，服务器会话吊销待确认；恢复连接后会继续重试。', retryable: true });
      void retry();
    }).catch(() => {
      // Persistence unavailable is surfaced by an explicit logout; bootstrap must still permit a fresh login.
    });
    const onOnline = () => { void retry(); };
    const timer = window.setInterval(onOnline, 30_000);
    window.addEventListener('online', onOnline); window.addEventListener('focus', onOnline);
    return () => { disposed = true; window.clearInterval(timer); window.removeEventListener('online', onOnline); window.removeEventListener('focus', onOnline); };
  }, [session.sessionInstanceId, session.serverKey, session.phase]);

  const updateProfile = useCallback<AuthContextValue['updateProfile']>(async (displayName, avatarDataUrl) => {
    const identity = getAuthSessionVersion();
    try {
      const response = await api.auth.updateProfile(displayName, avatarDataUrl);
      const payload = await parseJsonSafely<AuthUserPayload & { error?: string | { message?: string } }>(response);
      if (identity !== getAuthSessionVersion() || !userRef.current) {
        return { success: false, error: 'Account session changed; the profile reply was discarded' };
      }
      if (!response.ok || !payload?.user) {
        const detail = payload?.error;
        return { success: false, error: typeof detail === 'string' ? detail : detail?.message || '保存账户资料失败' };
      }
      userRef.current = payload.user;
      setUser(payload.user);
      return { success: true };
    } catch {
      return { success: false, error: '无法连接服务器，账户资料未保存' };
    }
  }, []);

  const contextValue = useMemo<AuthContextValue>(
    () => ({
      user: IS_PLATFORM || (session.phase === 'ready' && verifiedSessionId === session.sessionInstanceId) ? user : null,
      token: session.phase === 'ready' ? token : null,
      isLoading,
      hasCompletedOnboarding,
      error,
      login,
      logout,
      updateProfile,
      refreshAuthStatus: checkAuthStatus,
      refreshOnboardingStatus,
    }),
    [
      error,
      hasCompletedOnboarding,
      isLoading,
      login,
      logout,
      refreshOnboardingStatus,
      token,
      user,
      updateProfile,
      checkAuthStatus,
      session.phase,
      session.sessionInstanceId,
      verifiedSessionId,
    ],
  );

  const visibleLogoutNotice = logoutNotice?.identity === session.sessionInstanceId
    && ['signedOut', 'closing'].includes(session.phase) ? logoutNotice
      : session.phase === 'closing' ? { identity: session.sessionInstanceId, message: '登录已暂停，原会话注销尚未完成。请重试注销确认。', retryable: true } : null;
  return <AuthContext.Provider value={contextValue}>
    {visibleLogoutNotice && <div role="status" className="mx-auto mb-3 max-w-xl text-sm text-muted-foreground">
      <p>{visibleLogoutNotice.message}</p>
      {visibleLogoutNotice.retryable && <button type="button" className="mt-2 underline underline-offset-4" onClick={() => {
        if (session.phase === 'closing') logout();
        else if (isDesktop()) void FrontendBridge.getApiConnection().catch(() => {});
        else window.dispatchEvent(new Event('online'));
      }}>重试注销确认</button>}
    </div>}
    {children}
  </AuthContext.Provider>;
}
