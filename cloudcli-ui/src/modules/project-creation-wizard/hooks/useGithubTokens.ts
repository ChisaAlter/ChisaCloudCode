import { useEffect, useMemo, useRef, useState } from 'react';

import { fetchGithubTokenCredentials } from '@/modules/project-creation-wizard/utils/workspaceApi';
import { getAuthSessionVersion } from '@/shared/authToken';
import { getServerConnectionVersion } from '@/shared/chisa';
import type { GithubTokenCredential } from '@/shared/types';

type UseGithubTokensParams = { shouldLoad: boolean; selectedTokenId: string; onAutoSelectToken: (tokenId: string) => void };

/** The creation wizard lists credentials belonging only to the current account and server. */
export const useGithubTokens = ({ shouldLoad, selectedTokenId, onAutoSelectToken }: UseGithubTokensParams) => {
  const identity = () => `${getAuthSessionVersion()}:${getServerConnectionVersion()}`;
  // Cached credential labels must never cross account or server transitions.
  const [owner, setOwner] = useState(identity);
  // Successful credentials are retained only for the matching identity.
  const [tokens, setTokens] = useState<GithubTokenCredential[]>([]);
  // Loading and failures belong to the current credential lookup.
  const [loading, setLoading] = useState(false);
  // Inline failures leave the form usable for unauthenticated public imports.
  const [loadError, setLoadError] = useState<string | null>(null);
  const loadedOwner = useRef<string | null>(null);
  const request = useRef(0);
  useEffect(() => {
    const timer = setInterval(() => {
      const next = identity();
      if (next === owner) return;
      ++request.current;
      loadedOwner.current = null;
      setTokens([]); setLoading(false); setLoadError(null); setOwner(next);
      onAutoSelectToken('');
    }, 250);
    return () => clearInterval(timer);
  }, [owner, onAutoSelectToken]);
  useEffect(() => {
    if (!shouldLoad || loadedOwner.current === owner) return;
    const generation = ++request.current;
    let disposed = false;
    const current = () => !disposed && generation === request.current && owner === identity();
    setLoading(true); setLoadError(null);
    void fetchGithubTokenCredentials().then(activeTokens => {
      if (!current()) return;
      setTokens(activeTokens); loadedOwner.current = owner;
      if (activeTokens.length && !selectedTokenId) onAutoSelectToken(String(activeTokens[0].id));
    }, error => {
      if (current()) setLoadError(error instanceof Error ? error.message : '无法读取 GitHub 凭据');
    }).finally(() => { if (current()) setLoading(false); });
    return () => { disposed = true; };
  }, [owner, onAutoSelectToken, selectedTokenId, shouldLoad]);
  const selectedTokenName = useMemo(() => tokens.find(token => String(token.id) === selectedTokenId)?.credential_name || null, [selectedTokenId, tokens]);
  return { tokens, loading, loadError, selectedTokenName };
};
