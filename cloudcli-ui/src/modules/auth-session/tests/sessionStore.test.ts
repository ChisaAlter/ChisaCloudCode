import { Buffer } from 'node:buffer';

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { createAuthSessionStore } from '@/modules/auth-session';
import type { AuthSessionPredecessor, AuthSessionSnapshot } from '@/shared/types';

const SERVER_KEY = 'https://accounts.test/instances/primary';
const OTHER_SERVER_KEY = 'https://accounts.test/instances/secondary';

// Explicit logout tests below share the same real lock-backed authority fixture as ordinary identity mutations.
const LEGACY_TOKEN_KEY = 'auth-token';

function token(userId: string, rotation: string): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({ userId, jti: rotation, iat: 1_700_000_000, exp: 4_102_444_800 })}.signature`;
}

const TOKEN_A = token('A', 'initial');
const TOKEN_A_REFRESHED = token('A', 'refreshed');
const TOKEN_A_OTHER_REFRESH = token('A', 'other-refresh');
const TOKEN_B = token('B', 'initial');

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function memoryStorage(): Storage {
  // Each window gets a separate map; only the explicitly injected origin map is shared.
  const values = new Map<string, string>();
  return {
    get length() { return values.size; },
    clear: () => values.clear(),
    getItem: key => values.get(String(key)) ?? null,
    key: index => [...values.keys()][index] ?? null,
    removeItem: key => { values.delete(String(key)); },
    setItem: (key, value) => { values.set(String(key), String(value)); },
  };
}

function storageText(storage: Storage): string {
  return Array.from({ length: storage.length }, (_, index) => storage.getItem(storage.key(index)!)).join('\n');
}

type LockTicket = { name: string; mode: LockMode; enter: () => void };

function controlledLocks() {
  // FIFO pending requests and active holders model one origin's real shared/exclusive lock host.
  const pending: LockTicket[] = [];
  const active = new Set<LockTicket>();
  const requested: Array<{ name: string; mode: LockMode }> = [];
  const barriers: Array<{ count: number; resolve: () => void }> = [];
  // Pausing grants lets tests enqueue actual store operations before choosing their linearization order.
  let paused = false;

  function drain(): void {
    if (paused) return;
    for (let index = 0; index < pending.length; index++) {
      const ticket = pending[index];
      if (pending.slice(0, index).some(earlier => earlier.name === ticket.name)) continue;
      if ([...active].some(holder => holder.name === ticket.name
        && (holder.mode === 'exclusive' || ticket.mode === 'exclusive'))) continue;
      pending.splice(index--, 1);
      active.add(ticket);
      ticket.enter();
    }
  }

  function request<T>(name: string, optionsOrCallback: LockOptions | LockGrantedCallback<T>, callback?: LockGrantedCallback<T>): Promise<T> {
    const options = typeof optionsOrCallback === 'function' ? {} : optionsOrCallback;
    const work = typeof optionsOrCallback === 'function' ? optionsOrCallback : callback!;
    const response = deferred<T>();
    const mode = options.mode ?? 'exclusive';
    const ticket: LockTicket = {
      name,
      mode,
      enter: () => {
        // Web Locks invokes a granted callback asynchronously and holds the lock for its returned promise.
        Promise.resolve().then(() => work({ name, mode })).then(value => {
          active.delete(ticket);
          drain();
          response.resolve(value);
        }, error => {
          active.delete(ticket);
          drain();
          response.reject(error);
        });
      },
    };
    pending.push(ticket);
    requested.push({ name, mode });
    for (let index = barriers.length - 1; index >= 0; index--) {
      if (requested.length >= barriers[index].count) barriers.splice(index, 1)[0].resolve();
    }
    drain();
    return response.promise;
  }

  const manager: LockManager = {
    request,
    query: async () => ({
      held: [...active].map(({ name, mode }) => ({ name, mode, clientId: 'fixture' })),
      pending: pending.map(({ name, mode }) => ({ name, mode, clientId: 'fixture' })),
    }),
  };

  return {
    manager,
    requested,
    pause: () => { paused = true; },
    resume: () => { paused = false; drain(); },
    whenRequested: (count: number) => requested.length >= count ? Promise.resolve() : new Promise<void>(resolve => {
      barriers.push({ count, resolve });
    }),
  };
}

type Store = ReturnType<typeof createAuthSessionStore>;
type Realm = {
  id: string;
  store: Store;
  windowStorage: Storage;
  readonly observed: AuthSessionSnapshot;
  readonly rendered: AuthSessionSnapshot;
  render: () => AuthSessionSnapshot;
};
type RealmOptions = { desktop?: boolean; withLocks?: boolean; serverKey?: string; windowStorage?: Storage };

function realmHost() {
  const sharedStorage = memoryStorage();
  const locks = controlledLocks();
  // Notifications carry only a wake-up destination, and are delivered explicitly rather than sharing a UI mirror.
  const notifications: string[] = [];
  const realms: Realm[] = [];

  function realm(id: string, options: RealmOptions = {}): Realm {
    const windowStorage = options.windowStorage ?? memoryStorage();
    const store = createAuthSessionStore({
      desktop: options.desktop ?? false,
      serverKey: options.serverKey ?? SERVER_KEY,
      sharedStorage,
      windowStorage,
      locks: options.withLocks === false ? undefined : locks.manager,
      notify: () => { for (const peer of realms) if (peer.id !== id) notifications.push(peer.id); },
    });
    // Subscription observation and rendered/verified UI identity intentionally advance independently.
    let observed = store.getSnapshot();
    let rendered: AuthSessionSnapshot | null = null;
    store.subscribe(() => { observed = store.getSnapshot(); });
    const client: Realm = {
      id,
      store,
      windowStorage,
      get observed() { return observed; },
      get rendered() {
        if (!rendered) throw new Error(`Realm ${id} has not rendered an account`);
        return rendered;
      },
      render: () => {
        rendered = store.getSnapshot();
        store.acknowledge(rendered);
        return rendered;
      },
    };
    realms.push(client);
    return client;
  }

  async function deliverNotifications(target?: Realm): Promise<void> {
    for (let index = 0; index < notifications.length;) {
      if (target && notifications[index] !== target.id) { index++; continue; }
      const [id] = notifications.splice(index, 1);
      const recipient = realms.find(client => client.id === id)!;
      await recipient.store.synchronize();
    }
  }

  return {
    realm, sharedStorage, locks, notifications, deliverNotifications,
    initialize: async () => {
      await Promise.all(realms.map(client => client.store.initialize()));
      await deliverNotifications();
      for (const client of realms) client.render();
    },
  };
}

async function login(client: Realm, credential = TOKEN_A, expected: AuthSessionPredecessor = client.rendered): Promise<AuthSessionSnapshot> {
  const next = await client.store.start(credential, expected);
  expect(next, 'a login with the current predecessor must commit').not.toBeNull();
  if (!next) throw new Error('Login did not commit');
  client.render();
  return next;
}

async function readyPair() {
  const host = realmHost();
  const left = host.realm('left');
  const right = host.realm('right');
  await host.initialize();
  await login(left);
  await host.deliverNotifications();
  right.render();
  return { host, left, right };
}

async function admittedToken(client: Realm, expected: AuthSessionPredecessor = client.rendered) {
  const admitted = await client.store.dispatch(expected, async current => current.token);
  return { snapshot: admitted.snapshot, token: await admitted.operation };
}

function nativeSnapshot(overrides: Partial<AuthSessionSnapshot> = {}): AuthSessionSnapshot {
  return {
    sessionInstanceId: 'native-session-A-00000001',
    nativeHandle: 'native-session-A-00000001',
    nativeGeneration: 11,
    serverKey: SERVER_KEY,
    userId: 'A',
    token: TOKEN_A,
    tokenRevision: 0,
    phase: 'ready',
    storageMode: 'window',
    ...overrides,
  };
}

beforeEach(() => {
  // No ambient navigator lock or legacy credential may accidentally join these isolated factory realms.
  vi.stubGlobal('navigator', { locks: undefined });
  localStorage.clear();
  sessionStorage.clear();
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('createAuthSessionStore across independent renderer realms', () => {
  test('ordinary identity snapshots keep a stable canonical shape and reference when reread unchanged', async () => {
    const host = realmHost(); const left = host.realm('left'); await left.store.initialize();
    const ready = await left.store.start(TOKEN_A); expect(ready).not.toBeNull();
    expect(Object.prototype.hasOwnProperty.call(ready!, 'revocationClosing')).toBe(false);
    const listener = vi.fn(); const unsubscribe = left.store.subscribe(listener);
    expect(await left.store.synchronize()).toBe(ready);
    expect(listener).not.toHaveBeenCalled();
    await left.store.refresh(TOKEN_A_REFRESHED, ready!); const refreshed = left.store.getSnapshot();
    expect(Object.prototype.hasOwnProperty.call(refreshed, 'revocationClosing')).toBe(false); listener.mockClear();
    expect(await left.store.synchronize()).toBe(refreshed); expect(listener).not.toHaveBeenCalled();
    unsubscribe();
  });

  test('A → B → A uses a new incarnation even when the exact A token is reused', async () => {
    const { host, left, right } = await readyPair();
    const originalA = left.rendered;
    const accountB = await login(right, TOKEN_B);
    const returnedA = await login(right, TOKEN_A);
    expect(new Set([originalA.sessionInstanceId, accountB.sessionInstanceId, returnedA.sessionInstanceId]).size).toBe(3);
    expect(left.observed).toEqual(originalA);

    const staleRequest = vi.fn(async (current: AuthSessionSnapshot) => current.token);
    await expect(left.store.dispatch(originalA, staleRequest)).rejects.toMatchObject({ name: 'AbortError' });
    expect(staleRequest).not.toHaveBeenCalled();
    expect(await left.store.refresh(TOKEN_A_REFRESHED, originalA)).toBe(false);
    expect(await left.store.start(TOKEN_B, originalA)).toBeNull();
    expect(await left.store.end(originalA)).toBe(false);
    await host.deliverNotifications();
    expect(left.observed).toEqual(returnedA);
    expect(right.observed).toEqual(returnedA);
    expect(left.store.isCurrent(originalA)).toBe(false);
  });

  test('a delayed notification cannot let UI A dispatch with authority B credentials', async () => {
    const { host, left, right } = await readyPair();
    const renderedA = left.rendered;
    const accountB = await login(right, TOKEN_B);
    expect(host.notifications).toContain(left.id);
    expect(left.observed).toEqual(renderedA);
    const dispatch = vi.fn(async (current: AuthSessionSnapshot) => current.token);

    await expect(left.store.dispatch(renderedA, dispatch)).rejects.toMatchObject({ name: 'AbortError' });
    expect(dispatch).not.toHaveBeenCalled();
    await host.deliverNotifications(left);
    expect(left.observed).toEqual(accountB);
    expect(left.rendered).toEqual(renderedA);
    // Even a caller that can see the new snapshot cannot borrow the unrendered account.
    await expect(left.store.dispatch(left.observed, dispatch)).rejects.toMatchObject({ name: 'AbortError' });
    left.store.acknowledge(renderedA);
    await expect(left.store.dispatch(left.observed, dispatch)).rejects.toMatchObject({ name: 'AbortError' });
    expect(dispatch).not.toHaveBeenCalled();

    left.render();
    const admitted = await left.store.dispatch(left.rendered, dispatch);
    expect(await admitted.operation).toBe(TOKEN_B);
    expect(admitted.snapshot).toEqual(accountB);
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  test('dispatch releases its shared lock while the network response is still pending', async () => {
    const { host, left, right } = await readyPair();
    const response = deferred<string>();
    const sent: string[] = [];
    const request = await left.store.dispatch(left.rendered, current => {
      sent.push(current.token!);
      return response.promise;
    });
    // Completing this exclusive mutation before resolving the network promise is the lock-lifetime assertion.
    const next = await login(right, TOKEN_B);
    response.resolve('old A result');
    expect(await request.operation).toBe('old A result');
    expect(sent).toEqual([TOKEN_A]);
    expect(request.snapshot.sessionInstanceId).not.toBe(next.sessionInstanceId);
    await host.deliverNotifications();
    expect(left.store.isCurrent(request.snapshot)).toBe(false);
    expect(await host.locks.manager.query()).toEqual({ held: [], pending: [] });
  });

  const mutationOrders = [
    ['refresh', 'login', 'logout'],
    ['refresh', 'logout', 'login'],
    ['login', 'refresh', 'logout'],
    ['login', 'logout', 'refresh'],
    ['logout', 'refresh', 'login'],
    ['logout', 'login', 'refresh'],
  ] as const;

  test.each(mutationOrders)('serializes concurrent %s / %s / %s against one predecessor', async (first, second, third) => {
    const { host, left, right } = await readyPair();
    const predecessor = left.rendered;
    const order = [first, second, third];
    const countBefore = host.locks.requested.length;
    host.locks.pause();
    const operations = order.map((action, index) => {
      const client = index % 2 === 0 ? left : right;
      if (action === 'refresh') return client.store.refresh(TOKEN_A_REFRESHED, predecessor);
      if (action === 'login') return client.store.start(TOKEN_B, predecessor);
      return client.store.end(predecessor);
    });
    await host.locks.whenRequested(countBefore + order.length);
    host.locks.resume();
    const results = await Promise.all(operations);
    expect(results.map(result => result !== false && result !== null)).toEqual([true, false, false]);
    await host.deliverNotifications();
    expect(right.observed).toEqual(left.observed);
    const current = left.observed;
    if (first === 'refresh') {
      expect(current).toMatchObject({ sessionInstanceId: predecessor.sessionInstanceId, userId: 'A', token: TOKEN_A_REFRESHED, tokenRevision: 1, phase: 'ready' });
    } else if (first === 'login') {
      expect(current.sessionInstanceId).not.toBe(predecessor.sessionInstanceId);
      expect(current).toMatchObject({ userId: 'B', token: TOKEN_B, tokenRevision: 0, phase: 'ready' });
    } else {
      expect(current.sessionInstanceId).not.toBe(predecessor.sessionInstanceId);
      expect(current).toMatchObject({ userId: null, token: null, tokenRevision: 0, phase: 'signedOut' });
    }
    expect(await host.locks.manager.query()).toEqual({ held: [], pending: [] });
  });

  test('two realms refreshing one token revision have exactly one winner', async () => {
    const { host, left, right } = await readyPair();
    const predecessor = left.rendered;
    const countBefore = host.locks.requested.length;
    host.locks.pause();
    const first = left.store.refresh(TOKEN_A_REFRESHED, predecessor);
    const second = right.store.refresh(TOKEN_A_OTHER_REFRESH, right.rendered);
    await host.locks.whenRequested(countBefore + 2);
    host.locks.resume();
    expect(await Promise.all([first, second])).toEqual([true, false]);
    await host.deliverNotifications();
    expect(left.observed).toMatchObject({ sessionInstanceId: predecessor.sessionInstanceId, tokenRevision: 1, token: TOKEN_A_REFRESHED });
    expect(right.observed).toEqual(left.observed);
    // Rotation preserves the verified UI identity while dispatch reads the current token under the lock.
    expect((await admittedToken(right, predecessor)).token).toBe(TOKEN_A_REFRESHED);
  });

  test.each(['delayed', 'observed'] as const)('an old 401 cannot end a refreshed revision with %s notifications', async notification => {
    const { host, left, right } = await readyPair();
    const response = deferred<{ status: number }>();
    const request = await left.store.dispatch(left.rendered, () => response.promise);
    expect(await right.store.refresh(TOKEN_A_REFRESHED, right.rendered)).toBe(true);
    if (notification === 'observed') await host.deliverNotifications();
    response.resolve({ status: 401 });
    expect((await request.operation).status).toBe(401);

    expect(await left.store.end(request.snapshot)).toBe(false);
    await host.deliverNotifications();
    expect(left.observed).toMatchObject({ sessionInstanceId: request.snapshot.sessionInstanceId, tokenRevision: 1, token: TOKEN_A_REFRESHED, phase: 'ready' });
    expect(right.observed).toEqual(left.observed);
    expect(left.store.isCurrent(request.snapshot, true)).toBe(false);
    expect(left.store.isCurrent(request.snapshot)).toBe(true);
    expect((await admittedToken(left, request.snapshot)).token).toBe(TOKEN_A_REFRESHED);
  });

  test('a cross-user refresh is rejected even when the caller mirror lags a token revision', async () => {
    const { host, left, right } = await readyPair();
    expect(await right.store.refresh(TOKEN_A_REFRESHED, right.rendered)).toBe(true);
    const currentPredecessor = right.observed;
    expect(left.observed.tokenRevision).toBe(0);
    expect(currentPredecessor.tokenRevision).toBe(1);

    expect.soft(await left.store.refresh(TOKEN_B, currentPredecessor)).toBe(false);
    await host.deliverNotifications();
    expect(left.observed).toMatchObject({ userId: 'A', token: TOKEN_A_REFRESHED, tokenRevision: 1 });
    expect(right.observed).toEqual(left.observed);
  });

  test('the authority isolates server namespaces even with the same origin storage and lock host', async () => {
    const host = realmHost();
    const left = host.realm('left');
    const otherServer = host.realm('other-server', { serverKey: OTHER_SERVER_KEY });
    await host.initialize();
    await login(left);
    await host.deliverNotifications();
    expect(otherServer.observed).toMatchObject({ serverKey: OTHER_SERVER_KEY, token: null, phase: 'signedOut' });
    const accountB = await login(otherServer, TOKEN_B);
    await host.deliverNotifications();
    expect(left.observed).toMatchObject({ serverKey: SERVER_KEY, token: TOKEN_A, userId: 'A' });
    expect(otherServer.observed).toEqual(accountB);
    expect((await admittedToken(left)).token).toBe(TOKEN_A);
    expect((await admittedToken(otherServer)).token).toBe(TOKEN_B);
  });

  test('without Web Locks the declared window scope never imports another window session', async () => {
    const host = realmHost();
    const left = host.realm('left', { withLocks: false });
    const right = host.realm('right', { withLocks: false });
    await host.initialize();
    expect(left.observed.storageMode).toBe('window');
    expect(right.observed.storageMode).toBe('window');
    expect(left.observed.sessionInstanceId).not.toBe(right.observed.sessionInstanceId);
    const accountA = await login(left);
    await host.deliverNotifications();
    expect(right.observed).toMatchObject({ token: null, phase: 'signedOut', storageMode: 'window' });
    const accountB = await login(right, TOKEN_B);
    await host.deliverNotifications();
    expect(left.observed).toEqual(accountA);
    expect(right.observed).toEqual(accountB);
    expect(storageText(host.sharedStorage)).not.toContain(TOKEN_A);
    expect(storageText(host.sharedStorage)).not.toContain(TOKEN_B);
    expect(storageText(left.windowStorage)).toContain(TOKEN_A);
    expect(storageText(left.windowStorage)).not.toContain(TOKEN_B);
    expect(storageText(right.windowStorage)).toContain(TOKEN_B);
    expect(storageText(right.windowStorage)).not.toContain(TOKEN_A);
    expect(host.locks.requested).toHaveLength(0);
    expect((await admittedToken(left)).token).toBe(TOKEN_A);
    expect((await admittedToken(right)).token).toBe(TOKEN_B);
  });

  test('shared legacy migration is locked once and logout leaves a tombstone for newly opened realms', async () => {
    const host = realmHost();
    host.sharedStorage.setItem(LEGACY_TOKEN_KEY, TOKEN_A);
    const read = vi.spyOn(host.sharedStorage, 'getItem');
    const left = host.realm('left');
    const right = host.realm('right');
    await host.initialize();
    expect(left.observed).toMatchObject({ token: TOKEN_A, userId: 'A', phase: 'ready', storageMode: 'shared' });
    expect(right.observed).toEqual(left.observed);
    expect(read.mock.calls.filter(([key]) => key === LEGACY_TOKEN_KEY)).toHaveLength(1);
    expect(host.sharedStorage.getItem(LEGACY_TOKEN_KEY)).toBeNull();
    const migrated = left.rendered;
    expect(await right.store.end(right.rendered)).toBe(true);
    await host.deliverNotifications();
    const tombstone = right.observed;
    expect(tombstone.sessionInstanceId).not.toBe(migrated.sessionInstanceId);
    const newlyOpened = host.realm('newly-opened');
    expect(await newlyOpened.store.initialize()).toEqual(tombstone);
    expect(tombstone).toMatchObject({ token: null, userId: null, phase: 'signedOut' });
    expect(storageText(host.sharedStorage)).not.toContain(TOKEN_A);
  });

  test('without an atomic shared authority legacy credentials require login instead of being claimed by competing windows', async () => {
    const host = realmHost();
    host.sharedStorage.setItem(LEGACY_TOKEN_KEY, TOKEN_A);
    const left = host.realm('left', { withLocks: false });
    const right = host.realm('right', { withLocks: false });
    const [leftInitial, rightInitial] = await Promise.all([left.store.initialize(), right.store.initialize()]);
    expect(leftInitial).toMatchObject({ token: null, storageMode: 'window', phase: 'signedOut' });
    expect(rightInitial).toMatchObject({ token: null, storageMode: 'window', phase: 'signedOut' });
    expect(leftInitial.sessionInstanceId).not.toBe(rightInitial.sessionInstanceId);
    left.render();
    right.render();
    expect(storageText(left.windowStorage)).not.toContain(TOKEN_A);
    expect(storageText(right.windowStorage)).not.toContain(TOKEN_A);
    // Isolated windows cannot safely claim a credential from shared storage without a lock.
    expect(host.sharedStorage.getItem(LEGACY_TOKEN_KEY)).toBe(TOKEN_A);
    await login(left, TOKEN_B);
    await host.deliverNotifications();
    expect(right.observed).toMatchObject({ token: null, phase: 'signedOut' });
    expect((await admittedToken(left)).token).toBe(TOKEN_B);
    const laterWindow = host.realm('later-window', { withLocks: false });
    expect(await laterWindow.store.initialize()).toMatchObject({ token: null, phase: 'signedOut', storageMode: 'window' });
    expect(storageText(laterWindow.windowStorage)).not.toContain(TOKEN_A);
  });

  test('an isolated fallback reload preserves only its own explicit login and never imports legacy shared credentials', async () => {
    const host = realmHost();
    host.sharedStorage.setItem(LEGACY_TOKEN_KEY, TOKEN_A);
    const left = host.realm('left', { withLocks: false });
    await left.store.initialize();
    left.render();
    const explicit = await login(left, TOKEN_B);
    const reloaded = host.realm('left-reloaded', { withLocks: false, windowStorage: left.windowStorage });
    const laterWindow = host.realm('later-window', { withLocks: false });
    expect(await reloaded.store.initialize()).toEqual(explicit);
    expect(await laterWindow.store.initialize()).toMatchObject({ token: null, phase: 'signedOut' });
    reloaded.render();
    expect((await admittedToken(reloaded)).token).toBe(TOKEN_B);
    expect(await reloaded.store.end(reloaded.rendered)).toBe(true);
    expect(await left.store.synchronize()).toMatchObject({ token: null, phase: 'signedOut' });
    expect(storageText(laterWindow.windowStorage)).not.toContain(TOKEN_A);
    expect(storageText(laterWindow.windowStorage)).not.toContain(TOKEN_B);
  });

  test.each(['failed probe', 'no-op probe'])('a web %s resumes exactly the predecessor session', async () => {
    const { host, left, right } = await readyPair();
    const previous = left.rendered;
    const identityVersion = left.store.getIdentityVersion();
    const attempt = left.store.beginSwitch();
    expect(left.observed.phase).toBe('switching');
    expect(left.store.isCurrent(previous)).toBe(false);
    const blocked = vi.fn(async (current: AuthSessionSnapshot) => current.token);
    await expect(left.store.dispatch(previous, blocked)).rejects.toMatchObject({ name: 'AbortError' });
    expect(blocked).not.toHaveBeenCalled();
    expect((await admittedToken(right)).token).toBe(TOKEN_A);

    await left.store.finishSwitch(attempt, false);
    await host.deliverNotifications();
    expect(left.observed).toEqual(previous);
    expect(left.store.getIdentityVersion()).toBe(identityVersion);
    expect(left.store.isCurrent(previous, true)).toBe(true);
    expect((await admittedToken(left, previous)).token).toBe(TOKEN_A);
  });

  test.each(['failed probe', 'no-op probe'])('a desktop %s restores the same native capability', async () => {
    const host = realmHost();
    const left = host.realm('left', { desktop: true });
    const right = host.realm('right', { desktop: true });
    await host.initialize();
    left.store.observeNative(nativeSnapshot());
    right.store.observeNative(nativeSnapshot());
    const previous = left.render();
    right.render();
    const attempt = left.store.beginSwitch();
    const blocked = vi.fn(async (current: AuthSessionSnapshot) => current.nativeHandle);
    await expect(left.store.dispatch(previous, blocked)).rejects.toMatchObject({ name: 'AbortError' });
    expect(blocked).not.toHaveBeenCalled();
    expect((await admittedToken(right)).snapshot.nativeHandle).toBe(previous.nativeHandle);

    await left.store.finishSwitch(attempt, false);
    expect(left.observed).toEqual(previous);
    expect(left.observed.nativeGeneration).toBe(11);
    expect(left.observed.nativeHandle).toBe(previous.nativeHandle);
    expect((await admittedToken(left, previous)).token).toBe(TOKEN_A);
    expect(host.sharedStorage.length).toBe(0);
  });

  test('native observations preserve immutable capability fields and remain local to each renderer', async () => {
    const host = realmHost();
    const left = host.realm('left', { desktop: true });
    const right = host.realm('right', { desktop: true });
    await host.initialize();
    const native = nativeSnapshot({ storageMode: 'shared' });
    const observed = left.store.observeNative(native);
    expect(observed).toEqual({ ...native, storageMode: 'window' });
    expect(Object.isFrozen(observed)).toBe(true);
    expect(right.observed).toMatchObject({ token: null, nativeHandle: null, phase: 'signedOut' });
    const blocked = vi.fn(async (current: AuthSessionSnapshot) => current.nativeHandle);
    await expect(left.store.dispatch(observed, blocked)).rejects.toMatchObject({ name: 'AbortError' });
    expect(blocked).not.toHaveBeenCalled();
    left.render();
    expect((await admittedToken(left)).snapshot).toEqual(observed);
    right.store.observeNative(native);
    right.render();
    expect((await admittedToken(right)).snapshot).toEqual(observed);
    expect(host.sharedStorage.length).toBe(0);
    expect(left.windowStorage.length).toBe(0);
    expect(right.windowStorage.length).toBe(0);
  });

  test('native rotation retains rendered identity but an old revision cannot end the new credential', async () => {
    const host = realmHost();
    const left = host.realm('left', { desktop: true });
    const right = host.realm('right', { desktop: true });
    await host.initialize();
    left.store.observeNative(nativeSnapshot());
    right.store.observeNative(nativeSnapshot());
    const previous = left.render();
    right.render();
    const version = left.store.getIdentityVersion();
    const rotated = nativeSnapshot({ token: TOKEN_A_REFRESHED, tokenRevision: 1 });
    left.store.observeNative(rotated);
    expect(left.store.getIdentityVersion()).toBe(version);
    expect(await left.store.end(previous)).toBe(false);
    expect((await admittedToken(left, previous)).snapshot).toEqual(rotated);
    expect(right.observed.tokenRevision).toBe(0);
    right.store.observeNative(rotated);
    expect((await admittedToken(right, previous)).token).toBe(TOKEN_A_REFRESHED);
  });

  test('normal native login handoff requires rendering the replacement before ordinary requests', async () => {
    const host = realmHost();
    const left = host.realm('left', { desktop: true });
    const right = host.realm('right', { desktop: true });
    await host.initialize();
    const signedOut = nativeSnapshot({ sessionInstanceId: 'native-login-predecessor-0001', nativeHandle: 'native-login-predecessor-0001', userId: null, token: null, phase: 'signedOut' });
    left.store.observeNative(signedOut);
    right.store.observeNative(signedOut);
    left.render();
    right.render();
    const loginRequest = await left.store.dispatch(signedOut, async current => {
      expect(current.nativeHandle).toBe(signedOut.nativeHandle);
      return nativeSnapshot({ nativeGeneration: 12 });
    }, true);
    const replacement = await loginRequest.operation;
    left.store.observeNative(replacement);
    const ordinaryRequest = vi.fn(async (current: AuthSessionSnapshot) => current.token);
    await expect(left.store.dispatch(signedOut, ordinaryRequest)).rejects.toMatchObject({ name: 'AbortError' });
    await expect(left.store.dispatch(replacement, ordinaryRequest)).rejects.toMatchObject({ name: 'AbortError' });
    expect(ordinaryRequest).not.toHaveBeenCalled();
    expect(right.observed).toEqual(signedOut);

    left.render();
    expect((await admittedToken(left)).snapshot).toEqual(replacement);
    right.store.observeNative(replacement);
    right.render();
    expect((await admittedToken(right)).token).toBe(TOKEN_A);
  });

  test('a native replacement observed during a switch is not overwritten by its predecessor on completion', async () => {
    const host = realmHost();
    const left = host.realm('left', { desktop: true });
    const right = host.realm('right', { desktop: true });
    await host.initialize();
    left.store.observeNative(nativeSnapshot());
    right.store.observeNative(nativeSnapshot());
    const previous = left.render();
    right.render();
    const attempt = left.store.beginSwitch();
    const replacement = nativeSnapshot({ sessionInstanceId: 'native-session-B-00000002', nativeHandle: 'native-session-B-00000002', nativeGeneration: 12, userId: 'B', token: TOKEN_B, serverKey: OTHER_SERVER_KEY });
    left.store.observeNative(replacement);
    await left.store.finishSwitch(attempt, false);
    expect(left.observed).toEqual(replacement);
    expect(right.observed).toEqual(previous);
    const blocked = vi.fn(async (current: AuthSessionSnapshot) => current.token);
    await expect(left.store.dispatch(previous, blocked)).rejects.toMatchObject({ name: 'AbortError' });
    await expect(left.store.dispatch(replacement, blocked)).rejects.toMatchObject({ name: 'AbortError' });
    expect(blocked).not.toHaveBeenCalled();
    left.render();
    expect((await admittedToken(left)).token).toBe(TOKEN_B);
  });
});

describe('explicit durable revocation transition', () => {
  test('fences synchronously, serializes intent/dispatch/clear, and releases the lock before a remote ACK', async () => {
    const { host, left, right } = await readyPair();
    const predecessor = left.rendered;
    const response = deferred<string>();
    const prepared = vi.fn((current: AuthSessionSnapshot) => {
      expect(current.sessionInstanceId).toBe(predecessor.sessionInstanceId);
      expect(current.token).toBe(predecessor.token);
      expect(current.tokenRevision).toBe(predecessor.tokenRevision);
      expect(left.observed.phase).toBe('closing');
      host.sharedStorage.setItem('pending:' + current.sessionInstanceId, current.token!);
      return { operation: response.promise };
    });
    const pending = left.store.endWithRevocation(predecessor, prepared);
    expect(left.observed.phase).toBe('closing');
    await expect(left.store.dispatch(predecessor, async () => 'unsafe')).rejects.toMatchObject({ name: 'AbortError' });
    const admitted = await pending;
    expect(admitted?.snapshot.phase).toBe('signedOut'); expect(prepared).toHaveBeenCalledTimes(1);
    await host.deliverNotifications(); right.render();
    const next = await login(right, TOKEN_B);
    expect(next.token).toBe(TOKEN_B);
    response.resolve('ack'); expect(await admitted!.operation).toBe('ack');
    await host.deliverNotifications(); expect(left.observed.token).toBe(TOKEN_B);
  });

  test('only one shared-tab attempt prepares the same predecessor; losing tab cannot revoke the replacement', async () => {
    const { host, left, right } = await readyPair();
    const first = vi.fn(() => ({ operation: Promise.resolve('left') }));
    const second = vi.fn(() => ({ operation: Promise.resolve('right') }));
    const results = await Promise.all([left.store.endWithRevocation(left.rendered, first), right.store.endWithRevocation(right.rendered, second)]);
    expect(results.filter(Boolean)).toHaveLength(1); expect(first.mock.calls.length + second.mock.calls.length).toBe(1);
    await host.deliverNotifications(); left.render(); right.render();
    const replacement = await login(left, TOKEN_B); await host.deliverNotifications();
    expect(right.observed.sessionInstanceId).toBe(replacement.sessionInstanceId);
  });

  test('failed durable preparation cannot be refreshed or synchronized into a usable ready account', async () => {
    const { host, left } = await readyPair();
    await expect(left.store.endWithRevocation(left.rendered, () => { throw new Error('storage-full'); })).rejects.toThrow('storage-full');
    expect(left.observed.phase).toBe('closing'); await left.store.synchronize(); expect(left.observed.phase).toBe('closing');
    expect(await left.store.refresh(TOKEN_A_REFRESHED, left.observed)).toBe(false);
    expect(await left.store.start(TOKEN_B, left.observed)).toBeNull();
    expect(await left.store.end(left.observed)).toBe(false);
    expect(left.observed.phase).toBe('closing');
    const callback = vi.fn(async () => 'unsafe'); await expect(left.store.dispatch(left.rendered, callback)).rejects.toMatchObject({ name: 'AbortError' });
    expect(callback).not.toHaveBeenCalled();
    const admitted = await left.store.endWithRevocation(left.observed, () => ({ operation: Promise.resolve('retry-ack') }));
    expect(admitted?.snapshot.phase).toBe('signedOut'); await host.deliverNotifications();
  });
});
