import { useCallback, useEffect, useRef, useState } from 'react';

import { safeBuildIdentity } from '@/shared/utils';
import { api } from '@/shared/api';
import { FrontendBridge, getServerConnectionVersion, isDesktop } from '@/shared/chisa';
import { getAuthSessionVersion } from '@/shared/authToken';
import { useConnectionIdentity } from '@/shared/hooks/useConnectionIdentity';
import type { ComponentBuildIdentity } from '@/shared/types';

/** Settings and sync diagnostics read component versions without connecting or repairing anything. */
export function useComponentVersions(scope = '') {
  const connectionIdentity = useConnectionIdentity();
  const identity = `${connectionIdentity}:${scope}`;
  const generation = useRef(0);
  // Results are scoped to the identity so a render never displays the previous account's version.
  const [snapshot, setSnapshot] = useState<{ identity: string; client: ComponentBuildIdentity; server: ComponentBuildIdentity } | null>(null);
  // Only explicit reads display activity; no timers or background retries are scheduled.
  const [loadingIdentity, setLoadingIdentity] = useState<string | null>(null);
  const frontend = safeBuildIdentity(typeof __BUILD_IDENTITY__ === 'undefined' ? null : __BUILD_IDENTITY__);
  const refresh = useCallback(async () => {
    const request = ++generation.current;
    const account = getAuthSessionVersion();
    const connection = getServerConnectionVersion();
    setSnapshot(null);
    setLoadingIdentity(identity);
    const [client, server] = await Promise.allSettled([
      isDesktop() ? FrontendBridge.getBuildIdentity() : Promise.resolve(null),
      api.system.version().then(response => response.ok ? response.json() : null),
    ]);
    if (request !== generation.current || account !== getAuthSessionVersion() || connection !== getServerConnectionVersion()) return;
    setSnapshot({ identity, client: safeBuildIdentity(client.status === 'fulfilled' ? client.value : null), server: safeBuildIdentity(server.status === 'fulfilled' ? server.value : null) });
    setLoadingIdentity(null);
  }, [identity]);
  useEffect(() => {
    // Capture the request counter itself; cleanup invalidates any outstanding read.
    const requests = generation;
    requests.current++;
    return () => { requests.current++; };
  }, [identity]);
  const current = snapshot?.identity === identity ? snapshot : null;
  return { frontend, client: current?.client ?? safeBuildIdentity(null), server: current?.server ?? safeBuildIdentity(null), refresh, loading: loadingIdentity === identity };
}
