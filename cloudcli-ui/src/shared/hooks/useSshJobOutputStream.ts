import { useEffect, useState } from 'react';

import { api } from '@/shared/api';

type JobOutputChunkResponse = {
  ok?: boolean;
  jobId?: string | null;
  stream?: 'stdout' | 'stderr';
  offset?: number;
  total?: number;
  chunk?: string;
  eof?: boolean;
  state?: string;
  truncated?: boolean;
};

type StreamSnapshot = {
  stdout: string;
  stderr: string;
  truncated: boolean;
  state: string | null;
};

const EMPTY_SNAPSHOT: StreamSnapshot = {
  stdout: '',
  stderr: '',
  truncated: false,
  state: null,
};

function decodeBase64Bytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

/**
 * Polls incremental stdout/stderr spill chunks from `/api/ssh-workspaces/job-output`
 * while an SSH workspace command is running or under recovery inspection.
 * Degrades silently when the helper or test mock does not provide `jobOutput`.
 */
export function useSshJobOutputStream({
  enabled,
  projectId,
  generation,
  jobId,
  intervalMs = 200,
}: {
  enabled: boolean;
  projectId?: string | null;
  generation?: string | null;
  jobId?: string | null;
  intervalMs?: number;
}): StreamSnapshot {
  const scopeKey = enabled && projectId ? `${projectId}:${generation ?? ''}:${jobId ?? ''}` : '';
  const [state, setState] = useState<{ key: string; snapshot: StreamSnapshot }>({
    key: '',
    snapshot: EMPTY_SNAPSHOT,
  });

  useEffect(() => {
    const jobOutput = api.sshWorkspaces?.jobOutput;
    if (!enabled || !projectId || !scopeKey || typeof jobOutput !== 'function') {
      return;
    }

    let cancelled = false;
    const controller = new AbortController();
    let trackedJobId: string | null = jobId ?? null;
    let stdoutOffset = 0;
    let stderrOffset = 0;
    let stdoutText = '';
    let stderrText = '';
    let isTruncated = false;
    let lastState: string | null = null;
    let stdoutDecoder = new TextDecoder('utf-8');
    let stderrDecoder = new TextDecoder('utf-8');

    const resetForJob = (nextJobId: string) => {
      trackedJobId = nextJobId;
      stdoutOffset = 0;
      stderrOffset = 0;
      stdoutText = '';
      stderrText = '';
      isTruncated = false;
      stdoutDecoder = new TextDecoder('utf-8');
      stderrDecoder = new TextDecoder('utf-8');
    };

    const pullStream = async (stream: 'stdout' | 'stderr'): Promise<JobOutputChunkResponse | null> => {
      const offset = stream === 'stdout' ? stdoutOffset : stderrOffset;
      const response = await jobOutput(
        {
          projectId,
          ...(generation ? { generation } : {}),
          ...(jobId ? { jobId } : trackedJobId ? { jobId: trackedJobId } : {}),
          stream,
          offset,
          maxBytes: 65536,
        },
        { signal: controller.signal },
      );
      if (!response.ok) return null;
      const data = (await response.json()) as JobOutputChunkResponse;
      if (cancelled || !data || data.ok === false) return null;
      if (typeof data.jobId === 'string' && data.jobId && trackedJobId && data.jobId !== trackedJobId && !jobId) {
        resetForJob(data.jobId);
      } else if (typeof data.jobId === 'string' && data.jobId && !trackedJobId) {
        trackedJobId = data.jobId;
      }
      if (typeof data.chunk === 'string' && data.chunk.length > 0) {
        const bytes = decodeBase64Bytes(data.chunk);
        if (bytes.length > 0) {
          if (stream === 'stdout') {
            stdoutOffset += bytes.length;
            stdoutText += stdoutDecoder.decode(bytes, { stream: true });
          } else {
            stderrOffset += bytes.length;
            stderrText += stderrDecoder.decode(bytes, { stream: true });
          }
        }
      }
      if (data.truncated) isTruncated = true;
      if (typeof data.state === 'string') lastState = data.state;
      return data;
    };

    void (async () => {
      while (!cancelled && !controller.signal.aborted) {
        try {
          const out = await pullStream('stdout');
          if (cancelled || controller.signal.aborted || !out) break;
          const err = await pullStream('stderr');
          if (cancelled || controller.signal.aborted || !err) break;
          setState((prev) => (
            prev.key === scopeKey
            && prev.snapshot.stdout === stdoutText
            && prev.snapshot.stderr === stderrText
            && prev.snapshot.truncated === isTruncated
            && prev.snapshot.state === lastState
              ? prev
              : {
                  key: scopeKey,
                  snapshot: { stdout: stdoutText, stderr: stderrText, truncated: isTruncated, state: lastState },
                }
          ));
          if (
            out.jobId
            && out.state
            && out.state !== 'running'
            && out.state !== 'idle'
            && out.eof
            && err.eof
          ) {
            break;
          }
        } catch {
          break;
        }
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, intervalMs);
          controller.signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
        });
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [enabled, projectId, generation, jobId, intervalMs, scopeKey]);

  return state.key === scopeKey ? state.snapshot : EMPTY_SNAPSHOT;
}
