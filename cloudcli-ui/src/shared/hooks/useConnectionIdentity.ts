import { useSyncExternalStore } from 'react';

import { AUTH_IDENTITY_CHANGED_EVENT, getAuthSessionVersion } from '@/shared/authToken';
import { getServerConnectionVersion, SERVER_CONNECTION_CHANGED_EVENT } from '@/shared/chisa';

function subscribe(listener: () => void) {
  window.addEventListener(AUTH_IDENTITY_CHANGED_EVENT, listener);
  window.addEventListener(SERVER_CONNECTION_CHANGED_EVENT, listener);
  return () => {
    window.removeEventListener(AUTH_IDENTITY_CHANGED_EVENT, listener);
    window.removeEventListener(SERVER_CONNECTION_CHANGED_EVENT, listener);
  };
}

/** About and workspace observations must restart when the account or connection changes. */
export function useConnectionIdentity() {
  return useSyncExternalStore(subscribe, () => `${getAuthSessionVersion()}:${getServerConnectionVersion()}`);
}
