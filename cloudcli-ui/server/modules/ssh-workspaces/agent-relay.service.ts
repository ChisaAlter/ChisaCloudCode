import { randomUUID, timingSafeEqual } from 'node:crypto';

import { agentWorkspaceConnectionsDb } from '@/modules/database/index.js';
import { AppError } from '@/shared/index.js';

const ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const TOKEN = /^[a-f0-9]{64}$/;
const REQUEST_ID = /^[a-f0-9-]{36}$/;
const MAX_PAYLOAD_BYTES = 12 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const MAX_PENDING = 32;
const CONTROL_SLOTS = 4;
const MAX_CHANNELS = 1000;
const GLOBAL_BYTE_LIMIT = 64 * 1024 * 1024;
const OWNER_BYTE_LIMIT = 24 * 1024 * 1024;
const CONTROL_BYTE_RESERVE = 1024 * 1024;
const POLL_MS = 25_000;

type RelayReply = { status: number; body: string };
type RelayJob = { requestId: string; payload: Record<string, unknown> };
type Pending = {
  job: RelayJob;
  resolve(value: RelayReply): void;
  reject(error: unknown): void;
  removeAbort(): void;
  delivered: boolean;
  bytes: number;
  owner: string;
  control: boolean;
};
type Poller = { finish(jobs: RelayJob[], error?: unknown): void };
type Channel = { token: string; lastPoll: number; pending: Map<string, Pending>; queue: string[]; poller?: Poller };
type RelayDependencies = {
  lookup?: (owner: string, id: string) => { token: string | null; delivery?: string } | null;
  now?: () => number;
  offlineMs?: number;
  globalByteLimit?: number;
  ownerByteLimit?: number;
};

function fail(code: string, message: string, statusCode = 503, requestDispatched = false) {
  return new AppError(message, { code, statusCode, details: { requestDispatched } });
}

/** SSH-workspaces tests inject a registry/clock; production uses the account-owned SQLite registry. Jobs are delivered at most once and never replayed after transport loss. */
export function createAgentRelayBroker(dependencies: RelayDependencies = {}) {
  const lookup = dependencies.lookup ?? ((owner, id) => agentWorkspaceConnectionsDb.get(owner, id));
  const now = dependencies.now ?? Date.now;
  const channels = new Map<string, Channel>();
  const ownerBytes = new Map<string, number>();
  let globalBytes = 0;
  function release(pending: Pending) {
    globalBytes -= pending.bytes;
    const next = (ownerBytes.get(pending.owner) ?? 0) - pending.bytes;
    if (next > 0) ownerBytes.set(pending.owner, next); else ownerBytes.delete(pending.owner);
    pending.removeAbort();
  }
  const keyFor = (owner: string, id: string) => JSON.stringify([owner, id]);

  function authorize(owner: string, id: string, token: string) {
    if (typeof owner !== 'string' || !owner || typeof id !== 'string' || !ID.test(id)
      || typeof token !== 'string' || token.length !== 64 || !TOKEN.test(token)) throw fail('AGENT_UNAUTHORIZED', 'Agent relay authorization failed.', 401);
    const row = lookup(owner, id);
    if (!row || row.delivery !== 'relay' || !row.token || row.token.length !== 64 || !TOKEN.test(row.token)
      || !timingSafeEqual(Buffer.from(row.token, 'hex'), Buffer.from(token, 'hex'))) {
      throw fail('AGENT_UNAUTHORIZED', 'Agent relay authorization failed.', 401);
    }
  }

  function retire(key: string, channel: Channel) {
    for (const pending of channel.pending.values()) {
      release(pending);
      pending.reject(fail('AGENT_RELAY_REPLACED', 'The desktop Agent session changed; inspect the previous operation before retrying.', 503, pending.delivered));
    }
    channel.pending.clear(); channel.queue = [];
    channel.poller?.finish([], fail('AGENT_UNAUTHORIZED', 'The desktop Agent session changed.', 401));
    channels.delete(key);
  }

  function channelFor(owner: string, id: string, token: string) {
    authorize(owner, id, token);
    const key = keyFor(owner, id);
    let channel = channels.get(key);
    if (channel && channel.token !== token) { retire(key, channel); channel = undefined; }
    if (!channel) {
      // Expired idle sessions have no durable work. Pending operations are
      // bounded per session and removed by their caller's request deadline.
      for (const [oldKey, old] of channels) if (!old.pending.size && !old.poller && now() - old.lastPoll > 60_000) retire(oldKey, old);
      if (channels.size >= MAX_CHANNELS) throw fail('AGENT_RELAY_BUSY', 'Agent relay capacity is temporarily full.');
      channel = { token, lastPoll: 0, pending: new Map(), queue: [] };
      channels.set(key, channel);
    }
    return channel;
  }

  function take(channel: Channel): RelayJob[] {
    const jobs: RelayJob[] = [];
    while (channel.queue.length && jobs.length < 4) {
      const id = channel.queue.shift()!;
      const pending = channel.pending.get(id);
      if (!pending || pending.delivered) continue;
      pending.delivered = true;
      jobs.push(pending.job);
    }
    return jobs;
  }

  function wake(channel: Channel) {
    if (channel.poller && channel.queue.length) channel.poller.finish(take(channel));
  }

  return {
    /** Authenticated desktop polling is the only delivery channel; wait=0 verifies the current registration without dispatching work. */
    async poll(owner: string, id: string, token: string, signal?: AbortSignal, waitMs = POLL_MS) {
      signal?.throwIfAborted();
      const channel = channelFor(owner, id, token);
      channel.lastPoll = now();
      if (waitMs === 0) return { ready: true, jobs: [] as RelayJob[] };
      if (channel.poller) throw fail('AGENT_RELAY_POLL_IN_PROGRESS', 'This Agent already has an active receive request.', 409);
      if (channel.queue.length) return { ready: true, jobs: take(channel) };
      return new Promise<{ ready: boolean; jobs: RelayJob[] }>((resolve, reject) => {
        let done = false;
        const cancel = () => finish([], signal?.reason ?? fail('AGENT_RELAY_INTERRUPTED', 'Agent receive request was interrupted.', 499));
        const timer = setTimeout(() => finish([]), Math.max(1, Math.min(POLL_MS, waitMs)));
        timer.unref();
        const finish = (jobs: RelayJob[], error?: unknown) => {
          if (done) return; done = true;
          clearTimeout(timer); signal?.removeEventListener('abort', cancel);
          if (channel.poller?.finish === finish) channel.poller = undefined;
          if (error) reject(error); else resolve({ ready: true, jobs });
        };
        channel.poller = { finish };
        signal?.addEventListener('abort', cancel, { once: true });
        if (signal?.aborted) cancel(); else wake(channel);
      });
    },

    /** Workspace transport waits for one desktop reply; abort discards the correlation but never resends a delivered operation. */
    async call(owner: string, id: string, token: string, payload: Record<string, unknown>, signal?: AbortSignal): Promise<RelayReply> {
      signal?.throwIfAborted();
      const channel = channelFor(owner, id, token);
      if (!channel.lastPoll || now() - channel.lastPoll > (dependencies.offlineMs ?? 40_000)) throw fail('AGENT_RELAY_OFFLINE', 'The desktop Agent is offline. Open the desktop and reconnect.');
      const bytes = Buffer.byteLength(JSON.stringify(payload));
      if (bytes > MAX_PAYLOAD_BYTES) throw fail('AGENT_RELAY_REQUEST_TOO_LARGE', 'Agent request exceeds 12 MiB.', 413);
      const request = payload.request as { op?: string } | undefined;
      const control = Boolean(request && ['job_status', 'job_cancel', 'operation_status', 'operation_cancel'].includes(request.op ?? ''));
      const sameKind = [...channel.pending.values()].filter(item => item.control === control).length;
      if (sameKind >= (control ? CONTROL_SLOTS : MAX_PENDING)
        || globalBytes + bytes > (dependencies.globalByteLimit ?? GLOBAL_BYTE_LIMIT) + (control ? CONTROL_BYTE_RESERVE : 0)
        || (ownerBytes.get(owner) ?? 0) + bytes > (dependencies.ownerByteLimit ?? OWNER_BYTE_LIMIT) + (control ? CONTROL_BYTE_RESERVE : 0)) {
        throw fail('AGENT_RELAY_BUSY', 'The desktop Agent has too much pending work.');
      }
      globalBytes += bytes; ownerBytes.set(owner, (ownerBytes.get(owner) ?? 0) + bytes);
      const requestId = randomUUID();
      return new Promise<RelayReply>((resolve, reject) => {
        const cancel = () => {
          const pending = channel.pending.get(requestId);
          if (!pending) return;
          channel.pending.delete(requestId); channel.queue = channel.queue.filter(key => key !== requestId);
          release(pending);
          reject(fail('AGENT_RELAY_INTERRUPTED', 'Agent request was interrupted; verify its result before retrying.', 499, pending.delivered));
        };
        const pending: Pending = { job: { requestId, payload }, resolve, reject, delivered: false, bytes, owner, control,
          removeAbort: () => signal?.removeEventListener('abort', cancel) };
        channel.pending.set(requestId, pending);
        // Cancellation/status has reserved slots and bytes behind long commands.
        if (control) channel.queue.unshift(requestId);
        else channel.queue.push(requestId);
        signal?.addEventListener('abort', cancel, { once: true });
        if (signal?.aborted) cancel(); else wake(channel);
      });
    },

    /** Repeated identical result delivery is harmless; a finished/expired correlation is acknowledged without executing anything. */
    settle(owner: string, id: string, token: string, requestId: unknown, response: unknown) {
      const channel = channelFor(owner, id, token);
      if (typeof requestId !== 'string' || !REQUEST_ID.test(requestId) || !response || typeof response !== 'object' || Array.isArray(response)) {
        throw fail('INVALID_AGENT_RELAY_RESULT', 'Agent result is invalid.', 400);
      }
      const reply = response as Record<string, unknown>;
      if (!Number.isInteger(reply.status) || Number(reply.status) < 100 || Number(reply.status) > 599 || typeof reply.body !== 'string'
        || Buffer.byteLength(reply.body) > MAX_RESPONSE_BYTES) throw fail('INVALID_AGENT_RELAY_RESULT', 'Agent result is invalid or exceeds 16 MiB.', 400);
      const pending = channel.pending.get(requestId);
      if (!pending) return { ok: true, accepted: false };
      if (!pending.delivered) throw fail('INVALID_AGENT_RELAY_RESULT', 'This Agent request was not delivered.', 409);
      channel.pending.delete(requestId); release(pending);
      pending.resolve({ status: Number(reply.status), body: reply.body });
      return { ok: true, accepted: true };
    },

    /** Registration rotation/logout removes old in-memory delivery rights; SQLite remains authoritative for every call and poll. */
    invalidate(owner: string, id: string) {
      const key = keyFor(owner, id), channel = channels.get(key);
      if (channel) retire(key, channel);
    },
  };
}

/** Native relay routes and workspace transport share one bounded broker in the API process. */
export const agentRelayBroker = createAgentRelayBroker();
