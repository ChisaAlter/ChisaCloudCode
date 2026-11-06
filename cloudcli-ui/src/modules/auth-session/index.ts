// Auth UI, shared transport and account-scoped stores share this authority without importing the auth UI barrel.
export {
  acknowledgeAuthSession, beginAuthServerSwitch, clearAuthToken, createAuthSessionStore,
  dispatchWithAuthSession, endAuthSessionWithRevocation, expireAuthSession, finishAuthServerSwitch, getAuthSessionSnapshot,
  getAuthSessionVersion, getAuthTokenRefreshDelay, getStoredAuthToken, initializeAuthSession,
  isAuthTokenExpired, isCurrentAuthSession, isValidRefreshedToken, observeNativeAuthSession,
  startAuthSession, storeAuthToken, subscribeToAuthSession, synchronizeAuthSession, TOKEN_EXPIRY_SKEW_MS,
} from '@/modules/auth-session/sessionStore';
