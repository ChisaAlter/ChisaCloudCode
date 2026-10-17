import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ReactNode } from 'react';

import { IS_PLATFORM } from '@/shared/utils';
import { api, ServiceConnectionError } from '@/shared/api';
import { FrontendBridge, isDesktop } from '@/shared/chisa';
import { AUTH_SESSION_EXPIRED_EVENT, AUTH_TOKEN_REFRESHED_EVENT, clearAuthToken, getAuthSessionVersion, getAuthTokenRefreshDelay, isValidRefreshedToken, startAuthSession, storeAuthToken } from '@/shared/authToken';
import { hydrateChatDrafts, resetChatDrafts } from '@/shared/chatDrafts';
import { hydrateUserPreferences, resetUserPreferences } from '@/shared/userSettings';
import type { AuthUserProfile } from '@/shared/types';

const AUTH_TOKEN_STORAGE_KEY = 'auth-token';

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
  error?: string | { message?: string };
  message?: string;
};

type AuthUserPayload = {
  user?: AuthUserProfile;
};

type OnboardingStatusPayload = {
  hasCompletedOnboarding?: boolean;
};

type ApiErrorPayload = {
  error?: string | { message?: string };
  message?: string;
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

function resolveApiErrorMessage(payload: ApiErrorPayload | null, fallback: string): string {
  if (!payload) {
    return fallback;
  }

  // Auth routes use the shared structured AppError envelope for failed logins.
  const error = payload.error;
  return (typeof error === 'string' ? error : error?.message) ?? payload.message ?? fallback;
}

const AuthContext = createContext<AuthContextValue | null>(null);

const readStoredToken = (): string | null => localStorage.getItem(AUTH_TOKEN_STORAGE_KEY);

const persistToken = (token: string) => {
  storeAuthToken(token);
};

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
  const [user, setUser] = useState<AuthUserProfile | null>(null);
  const [token, setToken] = useState<string | null>(() => readStoredToken());
  const [isLoading, setIsLoading] = useState(true);
  const [hasCompletedOnboarding, setHasCompletedOnboarding] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Refreshing an already authenticated identity must not unmount its workspace.
  const userRef = useRef(user);
  userRef.current = user;
  // Only the latest account check can apply its response or finish initial loading.
  const authCheckRevision = useRef(0);

  const setSession = useCallback((nextUser: AuthUserProfile, nextToken: string) => {
    startAuthSession(nextToken);
    userRef.current = nextUser;
    setUser(nextUser);
    setToken(nextToken);
  }, []);

  const clearSession = useCallback(() => {
    clearAuthToken();
    if (isDesktop()) void FrontendBridge.endServerSession().catch((error: unknown) => console.error('账号连接关闭失败', error));
    authCheckRevision.current += 1;
    userRef.current = null;
    setUser(null);
    setToken(null);
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

    const identity = getAuthSessionVersion();
    try {
      const response = await api.auth.refresh();
      if (!response.ok) {
        return;
      }

      const payload = await parseJsonSafely<AuthSessionPayload>(response);
      if (identity !== getAuthSessionVersion()) return;
      if (isValidRefreshedToken(payload?.token)) {
        setToken(payload.token);
        persistToken(payload.token);
      }
    } catch (caughtError) {
      if (identity !== getAuthSessionVersion()) return;
      // A transient network failure must not sign the user out. Focus/visibility
      // and the next scheduled refresh will retry while the token remains valid.
      console.warn('[Auth] Session refresh failed:', caughtError);
    }
  }, [token, user]);

  useEffect(() => {
    const handleTokenRefreshed = (event: Event) => {
      const nextToken = (event as CustomEvent<unknown>).detail;
      if (isValidRefreshedToken(nextToken)) {
        setToken(nextToken);
      }
    };
    const handleSessionExpired = () => {
      clearSession();
      setError(t(AUTH_ERROR_MESSAGES.sessionExpired));
    };

    window.addEventListener(AUTH_TOKEN_REFRESHED_EVENT, handleTokenRefreshed);
    window.addEventListener(AUTH_SESSION_EXPIRED_EVENT, handleSessionExpired);
    return () => {
      window.removeEventListener(AUTH_TOKEN_REFRESHED_EVENT, handleTokenRefreshed);
      window.removeEventListener(AUTH_SESSION_EXPIRED_EVENT, handleSessionExpired);
    };
  }, [clearSession, t]);

  const checkAuthStatus = useCallback(async () => {
    const identity = getAuthSessionVersion();
    const revision = ++authCheckRevision.current;
    const current = () => identity === getAuthSessionVersion() && revision === authCheckRevision.current;
    try {
      if (!userRef.current) setIsLoading(true);

      if (!token) {
        return;
      }

      // A removed token may have just emitted the session-expired notice; keep it until login.
      setError(null);
      const userResponse = await api.auth.user();
      if (!current()) return;
      if (!userResponse.ok) {
        if (userResponse.status === 401 || userResponse.status === 403) {
          clearSession();
        } else {
          setError(t(AUTH_ERROR_MESSAGES.authStatusCheckFailed));
        }
        return;
      }

      const userPayload = await parseJsonSafely<AuthUserPayload>(userResponse);
      if (!current()) return;
      if (!userPayload?.user) {
        clearSession();
        return;
      }

      userRef.current = userPayload.user;
      setUser(userPayload.user);
      await checkOnboardingStatus();
    } catch (caughtError) {
      if (!current()) return;
      console.error('[Auth] Auth status check failed:', caughtError);
      setError(t(AUTH_ERROR_MESSAGES.authStatusCheckFailed));
    } finally {
      if (current()) setIsLoading(false);
    }
  }, [checkOnboardingStatus, clearSession, t, token]);

  useEffect(() => {
    if (IS_PLATFORM) {
      setUser({ username: 'platform-user' });
      void checkOnboardingStatus().finally(() => {
        setIsLoading(false);
      });
      return;
    }

    void checkAuthStatus();
  }, [checkAuthStatus, checkOnboardingStatus]);

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

  const login = useCallback<AuthContextValue['login']>(
    async (username, password) => {
      const identity = getAuthSessionVersion();
      try {
        setError(null);
        const response = await api.auth.login(username, password);
        const payload = await parseJsonSafely<AuthSessionPayload>(response);
        if (identity !== getAuthSessionVersion()) return { success: false, error: 'Account session changed' };

        if (!response.ok || !payload?.token || !payload.user) {
          const message = resolveApiErrorMessage(payload, t(AUTH_ERROR_MESSAGES.loginFailed));
          setError(message);
          return { success: false, error: message };
        }

        setSession(payload.user, payload.token);
        await checkOnboardingStatus();
        return { success: true };
      } catch (caughtError) {
        if (identity !== getAuthSessionVersion()) return { success: false, error: 'Account session changed' };
        console.error('Login error:', caughtError);
        const message = caughtError instanceof ServiceConnectionError ? caughtError.message : t(AUTH_ERROR_MESSAGES.networkError);
        setError(message);
        return { success: false, error: message };
      }
    },
    [checkOnboardingStatus, setSession, t],
  );

  const logout = useCallback(() => {
    // JWT logout is client-side: the server endpoint does not maintain a
    // revocation list, so clearing the session is the complete operation.
    setError(null);
    clearSession();
  }, [clearSession]);

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
      user,
      token,
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
    ],
  );

  return <AuthContext.Provider value={contextValue}>{children}</AuthContext.Provider>;
}
