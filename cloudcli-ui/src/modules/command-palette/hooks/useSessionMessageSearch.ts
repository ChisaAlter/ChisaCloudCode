import { useEffect, useRef, useState, useSyncExternalStore } from 'react';

import { api } from '@/shared/api';
import { createAuthenticatedEventSource } from '@/shared/authenticatedEventSource';
import { getAuthSessionSnapshot, isCurrentAuthSession, subscribeToAuthSession } from '@/shared/authToken';
import { getServerTransportVersion, subscribeToServerConnection } from '@/shared/chisa';
import type { LLMProvider } from '@/shared/types';

export type SessionMessageMatch = {
  sessionId: string;
  label: string;
  snippet: string;
  provider: LLMProvider;
};

type ProjectResult = {
  projectId: string | null;
  projectName: string;
  sessions: Array<{
    sessionId: string;
    provider: LLMProvider;
    sessionSummary: string;
    matches: Array<{ snippet: string }>;
  }>;
};

const MIN_QUERY = 2;
const DEBOUNCE_MS = 250;

/** CommandPalette reads streamed message matches for its focused project and current account. */
export function useSessionMessageSearch(
  projectId: string | undefined,
  query: string,
  enabled: boolean,
) {
  const session = useSyncExternalStore(subscribeToAuthSession, getAuthSessionSnapshot, getAuthSessionSnapshot);
  const transport = useSyncExternalStore(subscribeToServerConnection, getServerTransportVersion, getServerTransportVersion);
  // Associate rendered matches with the exact search owner so a render before effect cleanup cannot show old results.
  const [result, setResult] = useState<{ owner: string; server: string; transport: number; projectId: string; query: string; items: SessionMessageMatch[] } | null>(null);
  // Invalidate queued listeners synchronously whenever a search is replaced or canceled.
  const seqRef = useRef(0);
  // Keep the current stream available for effect cleanup, including unmount during an async admission.
  const esRef = useRef<ReturnType<typeof createAuthenticatedEventSource> | null>(null);

  useEffect(() => {
    const trimmed = query.trim();
    const expected = getAuthSessionSnapshot();
    const seq = ++seqRef.current;
    esRef.current?.close();
    esRef.current = null;
    setResult(null);
    if (!enabled || !projectId || trimmed.length < MIN_QUERY) return;
    const controller = new AbortController();
    const current = () => !controller.signal.aborted && seq === seqRef.current && isCurrentAuthSession(expected)
      && transport === getServerTransportVersion();
    const handle = setTimeout(() => {
      if (!current()) return;
      const es = createAuthenticatedEventSource(api.searchConversationsUrl(trimmed), { expectedSession: expected, signal: controller.signal });
      esRef.current = es;
      const accumulated: SessionMessageMatch[] = [];

      es.addEventListener('result', (evt) => {
        if (!current()) { es.close(); return; }
        try {
          const data = JSON.parse(evt.data) as { projectResult: ProjectResult };
          const pr = data.projectResult;
          if (pr.projectId !== projectId) return;
          for (const s of pr.sessions) {
            accumulated.push({
              sessionId: s.sessionId,
              label: s.sessionSummary || s.sessionId,
              snippet: s.matches[0]?.snippet ?? '',
              provider: s.provider,
            });
          }
          setResult({ owner: expected.sessionInstanceId, server: expected.serverKey, transport, projectId, query: trimmed, items: [...accumulated] });
        } catch {
          // Ignore malformed application payloads; the shared parser owns framing and resource budgets.
        }
      });

      const finish = () => {
        es.close();
        if (esRef.current === es) esRef.current = null;
      };
      es.addEventListener('done', finish);
      es.addEventListener('error', finish);
    }, DEBOUNCE_MS);

    return () => {
      ++seqRef.current;
      clearTimeout(handle);
      controller.abort();
      esRef.current?.close();
      esRef.current = null;
    };
  }, [projectId, query, enabled, session.sessionInstanceId, session.serverKey, session.phase, transport]);

  return enabled && isCurrentAuthSession(session) && result && result.owner === session.sessionInstanceId && result.server === session.serverKey
    && result.transport === transport && result.projectId === projectId && result.query === query.trim() ? result.items : [];
}
