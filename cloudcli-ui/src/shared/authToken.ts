// Compatibility entry for existing feature readers; the auth-session module owns the single identity authority.
export {
  acknowledgeAuthSession, beginAuthServerSwitch, clearAuthToken, dispatchWithAuthSession,
  endAuthSessionWithRevocation, expireAuthSession, finishAuthServerSwitch, getAuthSessionSnapshot, getAuthSessionVersion,
  getAuthTokenRefreshDelay, getStoredAuthToken, initializeAuthSession, isAuthTokenExpired,
  isCurrentAuthSession, isValidRefreshedToken, observeNativeAuthSession, startAuthSession,
  storeAuthToken, subscribeToAuthSession, synchronizeAuthSession, TOKEN_EXPIRY_SKEW_MS,
} from '@/modules/auth-session';

/** Legacy auth UI listeners use credential-free events; new consumers subscribe to the immutable authority. */
export const AUTH_TOKEN_REFRESHED_EVENT = 'auth-token-refreshed';
/** Legacy auth UI listeners use this only for a conditionally committed expiry. */
export const AUTH_SESSION_EXPIRED_EVENT = 'auth-session-expired';
