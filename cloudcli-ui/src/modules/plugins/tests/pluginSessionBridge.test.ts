import { expect, test, vi } from 'vitest';

import type { dispatchWithAuthSession } from '@/modules/auth-session';
import { createPluginSessionBridge } from '@/modules/plugins/pluginSessionBridge';
import type { AuthSessionPredecessor, AuthSessionSnapshot, Plugin } from '@/shared/types';

function fixture() {
  let session: AuthSessionSnapshot = { serverKey: 'https://a.test', userId: '1', sessionInstanceId: 'first-login', token: 'a-token', tokenRevision: 0, phase: 'ready', nativeGeneration: null, nativeHandle: null, storageMode: 'window' };
  const listeners = new Set<() => void>();
  const captured = session;
  const plugin: Plugin = { name: 'demo', displayName: 'Demo', version: '1', author: '', description: '', entry: 'index.js', server: 'server.js', icon: '',
    type: 'module', slot: 'tab', enabled: true, serverRunning: true, dirName: 'demo', repoUrl: null, permissions: ['host:context', 'host:rpc'],
    security: { model: 'trusted-only', digest: `sha256:${'a'.repeat(64)}`, source: { kind: 'local', location: 'local:demo', version: '1' },
      permissions: ['host:context', 'host:rpc'], trusted: true, permitted: true, reviewRequired: false, releaseTrusted: false, approvedOwnerId: '1' } };
  const rpc = vi.fn(async (..._args: unknown[]) => Response.json({ ok: true }));
  const host = { getSession: () => session, isCurrent: (value: AuthSessionPredecessor) => value.sessionInstanceId === session.sessionInstanceId && value.serverKey === session.serverKey,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; }, rpc };
  return { plugin, captured, rpc, host, change(patch: Partial<AuthSessionSnapshot>) { session = { ...session, ...patch }; for (const listener of listeners) listener(); } };
}

test('normal trusted permitted RPC binds its captured session and never returns long term credential fields', async () => {
  const { plugin, captured, rpc, host } = fixture();
  rpc.mockResolvedValue(Response.json({ ok: true, accessToken: 'longterm', nested: { api_key: 'hidden', hasToken: true }, data: [1, 2] }));
  const bridge = createPluginSessionBridge(plugin, captured, host);
  expect(await bridge.request('GET', '/usage?days=30')).toEqual({ ok: true, nested: { hasToken: true }, data: [1, 2] });
  expect(rpc).toHaveBeenCalledWith('demo', 'GET', 'usage?days=30', undefined, expect.objectContaining({ expectedSession: captured, signal: expect.any(AbortSignal) }));
  bridge.dispose();
});

test('untrusted or unpermitted plugins cannot receive RPC even if marked enabled', async () => {
  for (const patch of [{ trusted: false }, { permitted: false }, { permissions: ['host:context'] }]) {
    const { plugin, captured, rpc, host } = fixture();
    plugin.security = { ...plugin.security!, ...patch };
    const bridge = createPluginSessionBridge(plugin, captured, host);
    await expect(bridge.request('GET', 'usage')).rejects.toThrow(/trusted and permitted/);
    expect(rpc).not.toHaveBeenCalled(); bridge.dispose();
  }
});

test('retained old callbacks cannot dispatch using a new JWT after account switch or logout', async () => {
  for (const patch of [{ sessionInstanceId: 'second-login', userId: '2', token: 'b-token' }, { phase: 'closing' as const }]) {
    const { plugin, captured, rpc, host, change } = fixture();
    const bridge = createPluginSessionBridge(plugin, captured, host);
    const retained = bridge.request;
    change(patch);
    await expect(retained('POST', 'mutate', {})).rejects.toThrow(/session changed/);
    await expect(bridge.fetch('mutate', { method: 'POST', body: '{}' })).rejects.toThrow(/session changed/);
    expect(rpc).not.toHaveBeenCalled(); bridge.dispose();
  }
});

test('an old response completing after identity change is discarded and its signal aborted', async () => {
  const { plugin, captured, rpc, host, change } = fixture();
  let finish!: (value: Response) => void;
  rpc.mockReturnValue(new Promise(resolve => { finish = resolve; }));
  const bridge = createPluginSessionBridge(plugin, captured, host);
  const result = bridge.request('GET', 'usage');
  const signal = (rpc.mock.calls[0] as unknown as unknown[])[4] as { signal: AbortSignal };
  change({ sessionInstanceId: 'new-login', token: 'b-token' });
  finish(Response.json({ account: 'old' }));
  await expect(result).rejects.toThrow(/session changed/); expect(signal.signal.aborted).toBe(true); bridge.dispose();
});

test('path, method, request structure and credential injection attempts are rejected before transport', async () => {
  const { plugin, captured, rpc, host } = fixture();
  const bridge = createPluginSessionBridge(plugin, captured, host);
  for (const path of ['https://evil.test', '//evil.test', '../config', '%2e%2e/secret', 'usage?token=secret', 'usage#fragment', 'usage\\escape']) {
    await expect(bridge.request('GET', path)).rejects.toThrow();
  }
  await expect(bridge.request('CONNECT', '/')).rejects.toThrow(/method/);
  await expect(bridge.fetch('usage', { headers: { Authorization: 'Bearer arbitrary' } })).rejects.toThrow(/credentials/);
  expect(rpc).not.toHaveBeenCalled(); bridge.dispose();
});

test('host owns socket URLs and revokes a normal permitted socket when the account ends', async () => {
  const { plugin, captured, host, change } = fixture();
  plugin.security!.permissions.push('host:websocket');
  class Socket extends EventTarget {
    static OPEN = 1;
    static instances: Socket[] = [];
    readyState = 0;
    sent: string[] = [];
    closed = false;
    constructor(readonly url: string) { super(); Socket.instances.push(this); }
    send(data: string) { this.sent.push(data); }
    close() { this.closed = true; this.readyState = 3; }
  }
  const socketUrl = vi.fn(async () => 'wss://host.test/plugin-ws/demo?ticket=single-use-ticket');
  const dispatch = async (_expected: unknown, operation: (snapshot: AuthSessionSnapshot) => Promise<unknown>) => ({ snapshot: captured, operation: operation(captured) });
  const bridge = createPluginSessionBridge(plugin, captured, { ...host, socketUrl, dispatch: dispatch as typeof dispatchWithAuthSession, WebSocket: Socket as unknown as typeof WebSocket });
  const events = { open: vi.fn(), message: vi.fn(), close: vi.fn(), error: vi.fn() };
  const proxy = await bridge.openSocket(events);
  const socket = Socket.instances[0]; socket.readyState = 1; socket.dispatchEvent(new Event('open'));
  proxy.send('hello'); expect(socket.sent).toEqual(['hello']); expect(events.open).toHaveBeenCalledOnce();
  expect(proxy).not.toHaveProperty('url'); expect(proxy).not.toHaveProperty('token');
  change({ sessionInstanceId: 'new-account', token: 'new-token', userId: '2' });
  expect(socket.closed).toBe(true); expect(() => proxy.send('late')).toThrow(/session changed/);
  expect(socketUrl).toHaveBeenCalledTimes(1); bridge.dispose();
});
