import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';

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
const OFFER_LEASE_MS = 3_000;
const DEFAULT_CALL_MS = 85_000;
const TERMINAL_RETENTION_MS = 5 * 60_000;
const MAX_TERMINAL_RECEIPTS = 256;
const MAX_ACTIVE_IDS = 128;
const MAX_EVENTS_PER_CALL = 256;
const EVENT_KINDS = new Set(['create', 'write', 'remove', 'rename', 'reset']);

type RelayReply = { status: number; body: string };
type RelayJob = { requestId: string; payload: Record<string, unknown>; deadlineAt?: number };
type RelayPoll = { ready: boolean; jobs: RelayJob[]; protocol?: 2; epoch?: string; capabilities?: { events?: number } };
/** One agent-reported filesystem observation inside a workspace root; rootIdentity pins it to the verified physical directory when present. */
export type AgentWorkspaceFileEvent = { root: string; rootIdentity?: string; path: string; kind: 'create' | 'write' | 'remove' | 'rename' | 'reset' };
type WorkspaceEventListener = (notice: { ownerId: string; connectionId: string; events: AgentWorkspaceFileEvent[] }) => void;
type Pending = {
  job: RelayJob & { deadlineAt: number };
  resolve(value: RelayReply): void;
  reject(error: unknown): void;
  dispose(): void;
  // V1 marks delivery when offered. V2 marks it only after a durable native
  // receipt is acknowledged; an expired, unacknowledged offer cannot execute.
  delivered: boolean;
  receiptRequired?: boolean;
  offeredAt?: number;
  bytes: number;
  owner: string;
  control: boolean;
};
type TerminalReceipt = { at: number; kind: 'completed' | 'expired'; responseHash?: string };
type Poller = { protocol: 1 | 2; finish(jobs: RelayJob[], error?: unknown): void; reschedule(): void };
type Channel = {
  token: string;
  epoch: string;
  protocol: 1 | 2;
  lastActivity?: number;
  pending: Map<string, Pending>;
  terminal: Map<string, TerminalReceipt>;
  poller?: Poller;
};
type RelayDependencies = {
  lookup?: (owner: string, id: string) => { token: string | null; delivery?: string } | null;
  now?: () => number;
  offlineMs?: number;
  offerLeaseMs?: number;
  globalByteLimit?: number;
  ownerByteLimit?: number;
};

function fail(code: string, message: string, statusCode = 503, requestDispatched = false) {
  return new AppError(message, { code, statusCode, details: { requestDispatched } });
}
function requestId(value: unknown): string {
  if (typeof value !== 'string' || !REQUEST_ID.test(value)) throw fail('INVALID_AGENT_RELAY_REQUEST', 'Agent request identity is invalid.', 400);
  return value;
}
function readEpoch(value: unknown): string {
  if (typeof value !== 'string' || !REQUEST_ID.test(value)) throw fail('INVALID_AGENT_RELAY_EPOCH', 'Agent relay epoch is invalid.', 400);
  return value;
}
function responseHash(reply: RelayReply): string {
  return createHash('sha256').update(String(reply.status)).update('\0').update(reply.body).digest('hex');
}

/** SSH-workspaces tests inject a registry/clock; native routes and workspace transport share bounded, account-owned delivery state. V2 reoffers only unacknowledged receipts; V1 remains at-most-once. */
export function createAgentRelayBroker(dependencies: RelayDependencies = {}) {
  const lookup = dependencies.lookup ?? ((owner, id) => agentWorkspaceConnectionsDb.get(owner, id));
  const now = dependencies.now ?? Date.now;
  const offerLeaseMs = dependencies.offerLeaseMs ?? OFFER_LEASE_MS;
  const channels = new Map<string, Channel>();
  const ownerBytes = new Map<string, number>();
  let globalBytes = 0;
  const keyFor = (owner: string, id: string) => JSON.stringify([owner, id]);
  const online = (channel: Channel) => channel.lastActivity !== undefined && now() - channel.lastActivity <= (dependencies.offlineMs ?? 40_000);

  function release(pending: Pending) {
    globalBytes -= pending.bytes;
    const next = (ownerBytes.get(pending.owner) ?? 0) - pending.bytes;
    if (next > 0) ownerBytes.set(pending.owner, next); else ownerBytes.delete(pending.owner);
    pending.dispose();
  }
  function remember(channel: Channel, id: string, receipt: TerminalReceipt) {
    for (const [oldId, old] of channel.terminal) if (now() - old.at > TERMINAL_RETENTION_MS) channel.terminal.delete(oldId);
    channel.terminal.set(id, receipt);
    while (channel.terminal.size > MAX_TERMINAL_RECEIPTS) channel.terminal.delete(channel.terminal.keys().next().value!);
  }
  function remove(channel: Channel, id: string, error: AppError) {
    const pending = channel.pending.get(id);
    if (!pending) return;
    channel.pending.delete(id);
    remember(channel, id, { at: now(), kind: 'expired' });
    release(pending);
    pending.reject(error);
  }
  function expire(channel: Channel) {
    for (const [id, pending] of channel.pending) if (pending.job.deadlineAt <= now()) {
      remove(channel, id, fail('AGENT_RELAY_TIMEOUT', 'Agent request reached its caller deadline.', 504, pending.delivered));
    }
    for (const [id, receipt] of channel.terminal) if (now() - receipt.at > TERMINAL_RETENTION_MS) channel.terminal.delete(id);
  }

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
    channel.pending.clear(); channel.terminal.clear();
    channel.poller?.finish([], fail('AGENT_UNAUTHORIZED', 'The desktop Agent session changed.', 401));
    channels.delete(key);
  }

  function channelFor(owner: string, id: string, token: string) {
    authorize(owner, id, token);
    const key = keyFor(owner, id);
    let channel = channels.get(key);
    if (channel && channel.token !== token) { retire(key, channel); channel = undefined; }
    if (!channel) {
      // Caller deadlines own pending requests. Idle channels and their bounded
      // terminal receipts may be discarded; a new epoch fences old native work.
      for (const [oldKey, old] of channels) if (!old.pending.size && !old.poller && now() - (old.lastActivity ?? 0) > 60_000) retire(oldKey, old);
      if (channels.size >= MAX_CHANNELS) throw fail('AGENT_RELAY_BUSY', 'Agent relay capacity is temporarily full.');
      channel = { token, epoch: randomUUID(), protocol: 1, pending: new Map(), terminal: new Map() };
      channels.set(key, channel);
    }
    return channel;
  }

  function take(channel: Channel, protocol: 1 | 2): RelayJob[] {
    expire(channel);
    const eligible = [...channel.pending.values()].filter(pending => !pending.delivered
      && (pending.offeredAt === undefined || (protocol === 2 && pending.receiptRequired === true && now() - pending.offeredAt >= offerLeaseMs)));
    const controls = eligible.filter(pending => pending.control);
    const regular = eligible.filter(pending => !pending.control);
    // Controls lead each batch, but a continuous status stream cannot starve
    // every regular request. Each class is FIFO within the bounded batch.
    const selected = [...controls.slice(0, regular.length ? 3 : 4), ...regular].slice(0, 4);
    return selected.map(pending => {
      pending.receiptRequired = protocol === 2;
      pending.offeredAt = now();
      pending.delivered = protocol === 1;
      return protocol === 2 ? pending.job : { requestId: pending.job.requestId, payload: pending.job.payload };
    });
  }
  function nextOfferDelay(channel: Channel): number | undefined {
    let delay: number | undefined;
    for (const pending of channel.pending.values()) if (!pending.delivered && pending.receiptRequired && pending.offeredAt !== undefined) {
      const next = Math.max(1, pending.offeredAt + offerLeaseMs - now());
      if (delay === undefined || next < delay) delay = next;
    }
    return delay;
  }
  function wake(channel: Channel) {
    const poller = channel.poller;
    if (!poller) return;
    const jobs = take(channel, poller.protocol);
    if (jobs.length) poller.finish(jobs); else poller.reschedule();
  }
  function envelope(channel: Channel, protocol: 1 | 2, jobs: RelayJob[]): RelayPoll {
    // Protocol 2 advertises the events endpoint so a capable native agent can
    // push filesystem observations; older servers simply omit the field.
    return protocol === 2 ? { ready: true, protocol: 2, epoch: channel.epoch, jobs, capabilities: { events: 1 } } : { ready: true, jobs };
  }

  const eventListeners = new Set<WorkspaceEventListener>();

  return {
    /** Native polling negotiates receipt delivery with protocol=2; wait=0 never dispatches work. A channel cannot downgrade after opting into ACK-before-execution. */
    async poll(owner: string, id: string, token: string, signal?: AbortSignal, waitMs = POLL_MS, protocol: 1 | 2 = 1): Promise<RelayPoll> {
      signal?.throwIfAborted();
      const channel = channelFor(owner, id, token);
      if (channel.protocol === 2 && protocol !== 2) throw fail('AGENT_RELAY_PROTOCOL_CHANGED', 'This Agent session requires relay protocol 2.', 409);
      if (protocol === 2 && channel.protocol !== 2) {
        channel.poller?.finish([], fail('AGENT_RELAY_PROTOCOL_CHANGED', 'This Agent session switched to relay protocol 2.', 409));
        channel.protocol = 2;
      }
      channel.lastActivity = now();
      expire(channel);
      if (waitMs === 0) return envelope(channel, protocol, []);
      if (channel.poller) throw fail('AGENT_RELAY_POLL_IN_PROGRESS', 'This Agent already has an active receive request.', 409);
      const jobs = take(channel, protocol);
      if (jobs.length) return envelope(channel, protocol, jobs);
      return new Promise<RelayPoll>((resolve, reject) => {
        let done = false;
        let leaseTimer: ReturnType<typeof setTimeout> | undefined;
        const cancel = () => finish([], signal?.reason ?? fail('AGENT_RELAY_INTERRUPTED', 'Agent receive request was interrupted.', 499));
        const timer = setTimeout(() => finish([]), Math.max(1, Math.min(POLL_MS, waitMs)));
        timer.unref();
        const finish = (offered: RelayJob[], error?: unknown) => {
          if (done) return; done = true;
          clearTimeout(timer); clearTimeout(leaseTimer); signal?.removeEventListener('abort', cancel);
          if (channel.poller?.finish === finish) channel.poller = undefined;
          if (error) reject(error);
          else { channel.lastActivity = now(); resolve(envelope(channel, protocol, offered)); }
        };
        const reschedule = () => {
          clearTimeout(leaseTimer);
          const delay = protocol === 2 ? nextOfferDelay(channel) : undefined;
          if (!done && delay !== undefined) {
            leaseTimer = setTimeout(() => wake(channel), delay);
            leaseTimer.unref();
          }
        };
        channel.poller = { protocol, finish, reschedule };
        signal?.addEventListener('abort', cancel, { once: true });
        if (signal?.aborted) cancel(); else wake(channel);
      });
    },

    /** Workspace transport supplies its existing absolute deadline; abort/deadline removes correlation and heartbeat reports the native job obsolete. */
    async call(owner: string, id: string, token: string, payload: Record<string, unknown>, signal?: AbortSignal, options: { deadlineAt?: number } = {}): Promise<RelayReply> {
      signal?.throwIfAborted();
      const channel = channelFor(owner, id, token);
      expire(channel);
      if (!online(channel)) throw fail('AGENT_RELAY_OFFLINE', 'The desktop Agent is offline. Open the desktop and reconnect.');
      const encoded = JSON.stringify(payload);
      const bytes = Buffer.byteLength(encoded);
      if (bytes > MAX_PAYLOAD_BYTES) throw fail('AGENT_RELAY_REQUEST_TOO_LARGE', 'Agent request exceeds 12 MiB.', 413);
      const deadlineAt = options.deadlineAt ?? now() + DEFAULT_CALL_MS;
      if (!Number.isSafeInteger(deadlineAt)) throw fail('INVALID_AGENT_RELAY_DEADLINE', 'Agent caller deadline is invalid.', 400);
      if (deadlineAt <= now()) throw fail('AGENT_RELAY_TIMEOUT', 'Agent request reached its caller deadline.', 504);
      const request = payload.request as { op?: string } | undefined;
      const control = Boolean(request && ['job_status', 'job_cancel', 'job_output', 'operation_status', 'operation_cancel'].includes(request.op ?? ''));
      const sameKind = [...channel.pending.values()].filter(item => item.control === control).length;
      if (sameKind >= (control ? CONTROL_SLOTS : MAX_PENDING)
        || globalBytes + bytes > (dependencies.globalByteLimit ?? GLOBAL_BYTE_LIMIT) + (control ? CONTROL_BYTE_RESERVE : 0)
        || (ownerBytes.get(owner) ?? 0) + bytes > (dependencies.ownerByteLimit ?? OWNER_BYTE_LIMIT) + (control ? CONTROL_BYTE_RESERVE : 0)) {
        throw fail('AGENT_RELAY_BUSY', 'The desktop Agent has too much pending work.');
      }
      globalBytes += bytes; ownerBytes.set(owner, (ownerBytes.get(owner) ?? 0) + bytes);
      const idForRequest = randomUUID();
      return new Promise<RelayReply>((resolve, reject) => {
        const cancel = () => {
          const pending = channel.pending.get(idForRequest);
          if (pending) remove(channel, idForRequest, fail('AGENT_RELAY_INTERRUPTED', 'Agent request was interrupted; verify its result before retrying.', 499, pending.delivered));
        };
        const timer = setTimeout(() => {
          const pending = channel.pending.get(idForRequest);
          if (pending) remove(channel, idForRequest, fail('AGENT_RELAY_TIMEOUT', 'Agent request reached its caller deadline.', 504, pending.delivered));
        }, Math.min(2_147_483_647, Math.max(1, deadlineAt - now())));
        timer.unref();
        const pending: Pending = { job: { requestId: idForRequest, payload: JSON.parse(encoded) as Record<string, unknown>, deadlineAt },
          resolve, reject, delivered: false, bytes, owner, control,
          dispose: () => { clearTimeout(timer); signal?.removeEventListener('abort', cancel); } };
        channel.pending.set(idForRequest, pending);
        signal?.addEventListener('abort', cancel, { once: true });
        if (signal?.aborted) cancel(); else wake(channel);
      });
    },

    /** Native V2 persists a request before ACK and executes only when accepted; duplicate ACKs are safe and stale epochs can never authorize execution. */
    acknowledge(owner: string, id: string, token: string, value: unknown, epoch: unknown) {
      const requested = requestId(value), expectedEpoch = readEpoch(epoch);
      const channel = channelFor(owner, id, token);
      channel.lastActivity = now(); expire(channel);
      const result = (accepted: boolean) => ({ ok: true, accepted, epoch: channel.epoch });
      if (expectedEpoch !== channel.epoch) return result(false);
      const pending = channel.pending.get(requested);
      if (!pending || pending.receiptRequired !== true || pending.offeredAt === undefined) return result(false);
      pending.delivered = true;
      wake(channel);
      return result(true);
    },

    /** Native V2 can refuse an offered request before ACK when its durable journal cannot admit work. A rejection never grants execution rights or clears an already received operation. */
    rejectReceipt(owner: string, id: string, token: string, value: unknown, epoch: unknown) {
      const requested = requestId(value), expectedEpoch = readEpoch(epoch);
      const channel = channelFor(owner, id, token);
      channel.lastActivity = now(); expire(channel);
      const result = (accepted: boolean) => ({ ok: true, accepted, epoch: channel.epoch });
      if (expectedEpoch !== channel.epoch) return result(false);
      const pending = channel.pending.get(requested);
      if (!pending || pending.delivered || pending.receiptRequired !== true || pending.offeredAt === undefined) return result(false);
      const reply = { status: 503, body: JSON.stringify({ ok: false, protocol: 1, platform: 'win32', code: 'AGENT_BUSY',
        error: 'Desktop cannot admit this operation; journal capacity or storage is unavailable' }) };
      channel.pending.delete(requested); release(pending);
      remember(channel, requested, { at: now(), kind: 'completed', responseHash: responseHash(reply) });
      pending.resolve(reply);
      wake(channel);
      return result(true);
    },

    /** Native V2 heartbeat is independent from receives and helper execution. Missing/old-epoch correlations cancel local jobs, including reads whose HTTP caller left. */
    heartbeat(owner: string, id: string, token: string, epoch: unknown, activeRequestIds: unknown) {
      const expectedEpoch = readEpoch(epoch);
      if (!Array.isArray(activeRequestIds) || activeRequestIds.length > MAX_ACTIVE_IDS) throw fail('INVALID_AGENT_RELAY_HEARTBEAT', 'Agent heartbeat has too many active requests.', 400);
      const active = [...new Set(activeRequestIds.map(requestId))];
      const channel = channelFor(owner, id, token);
      channel.lastActivity = now(); expire(channel);
      return { ok: true, epoch: channel.epoch,
        obsoleteRequestIds: active.filter(activeId => expectedEpoch !== channel.epoch || !channel.pending.has(activeId)) };
    },

    /** Native result retries are terminal even after correlation expiry; the native journal retains its completed receipt. V1 keeps its original response shape, and bounded hashes reject conflicting duplicate V2 results. */
    settle(owner: string, id: string, token: string, value: unknown, response: unknown, epoch?: unknown) {
      const channel = channelFor(owner, id, token);
      const requested = requestId(value);
      if (!response || typeof response !== 'object' || Array.isArray(response)) throw fail('INVALID_AGENT_RELAY_RESULT', 'Agent result is invalid.', 400);
      const reply = response as Record<string, unknown>;
      if (!Number.isInteger(reply.status) || Number(reply.status) < 100 || Number(reply.status) > 599 || typeof reply.body !== 'string'
        || Buffer.byteLength(reply.body) > MAX_RESPONSE_BYTES) throw fail('INVALID_AGENT_RELAY_RESULT', 'Agent result is invalid or exceeds 16 MiB.', 400);
      const expectedEpoch = epoch === undefined ? undefined : readEpoch(epoch);
      channel.lastActivity = now(); expire(channel);
      const result = (accepted: boolean) => expectedEpoch === undefined
        ? { ok: true, accepted } : { ok: true, accepted, epoch: channel.epoch };
      if (expectedEpoch !== undefined && expectedEpoch !== channel.epoch) return result(false);
      const pending = channel.pending.get(requested);
      if (!pending) {
        const terminal = channel.terminal.get(requested);
        if (expectedEpoch !== undefined && terminal?.kind === 'completed' && terminal.responseHash !== responseHash({ status: Number(reply.status), body: reply.body })) {
          throw fail('INVALID_AGENT_RELAY_RESULT', 'An Agent request already has a different result.', 409);
        }
        return result(false);
      }
      if (!pending.delivered || (pending.receiptRequired && expectedEpoch === undefined)) throw fail('INVALID_AGENT_RELAY_RESULT', 'This Agent request was not acknowledged.', 409);
      channel.pending.delete(requested); release(pending);
      const completed = { status: Number(reply.status), body: reply.body };
      remember(channel, requested, { at: now(), kind: 'completed', responseHash: responseHash(completed) });
      pending.resolve(completed);
      wake(channel);
      return result(true);
    },

    /** Filesystem events are advisory fan-out, never durable work: epoch fencing applies, and a malformed batch fails validation instead of invalidating state. */
    events(owner: string, id: string, token: string, epoch: unknown, value: unknown) {
      const expectedEpoch = readEpoch(epoch);
      if (!Array.isArray(value) || value.length > MAX_EVENTS_PER_CALL) throw fail('INVALID_AGENT_RELAY_EVENTS', 'Agent event batch is invalid.', 400);
      const events: AgentWorkspaceFileEvent[] = value.map(item => {
        if (!item || typeof item !== 'object' || Array.isArray(item)) throw fail('INVALID_AGENT_RELAY_EVENTS', 'Agent event batch is invalid.', 400);
        const { root, rootIdentity, path: eventPath, kind } = item as Record<string, unknown>;
        if (typeof root !== 'string' || !root || root.length > 1024 || /[\u0000-\u001f\u007f]/.test(root)
          || (rootIdentity !== undefined && (typeof rootIdentity !== 'string' || rootIdentity.length > 256 || /[\u0000-\u001f\u007f]/.test(rootIdentity)))
          || typeof eventPath !== 'string' || eventPath.length > 2048 || /[\u0000-\u001f\u007f]/.test(eventPath)
          || typeof kind !== 'string' || !EVENT_KINDS.has(kind)) {
          throw fail('INVALID_AGENT_RELAY_EVENTS', 'Agent event batch is invalid.', 400);
        }
        return { root, rootIdentity, path: eventPath, kind } as AgentWorkspaceFileEvent;
      });
      const channel = channelFor(owner, id, token);
      channel.lastActivity = now(); expire(channel);
      if (expectedEpoch !== channel.epoch) return { ok: true, accepted: false, epoch: channel.epoch };
      for (const listener of eventListeners) {
        try { listener({ ownerId: owner, connectionId: id, events }); }
        catch { /* A consumer fault must not break event admission or other consumers. */ }
      }
      return { ok: true, accepted: true, epoch: channel.epoch, delivered: events.length };
    },

    /** The workspace-events fan-out registers once; callers of the route itself never see this registry. */
    onWorkspaceEvents(listener: WorkspaceEventListener): () => void {
      eventListeners.add(listener);
      return () => { eventListeners.delete(listener); };
    },

    /** Authenticated catalog routes expose counts and activity only; tokens, epochs, payloads and response bodies remain private. */
    status(owner: string, id: string) {
      const registered = lookup(owner, id);
      const channel = channels.get(keyFor(owner, id));
      if (!channel || !registered || registered.delivery !== 'relay' || channel.token !== registered.token) {
        return { online: false, protocol: 1, lastActivityAt: null, pendingCount: 0, offeredCount: 0, receivedCount: 0 };
      }
      expire(channel);
      return { online: online(channel), protocol: channel.protocol, lastActivityAt: channel.lastActivity ?? null,
        pendingCount: channel.pending.size,
        offeredCount: [...channel.pending.values()].filter(pending => pending.offeredAt !== undefined && !pending.delivered).length,
        receivedCount: [...channel.pending.values()].filter(pending => pending.delivered).length };
    },

    /** Registration rotation/logout removes old in-memory delivery rights; SQLite remains authoritative for every authenticated message. */
    invalidate(owner: string, id: string) {
      const key = keyFor(owner, id), channel = channels.get(key);
      if (channel) retire(key, channel);
    },
  };
}

/** Native relay routes and workspace transport share one bounded broker in the API process. */
export const agentRelayBroker = createAgentRelayBroker();
