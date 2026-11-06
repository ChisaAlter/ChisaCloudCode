import { afterEach, beforeEach, expect, test, vi } from 'vitest';

const state = vi.hoisted(() => ({
  ticket: vi.fn(), revision: 0, desktop: false, lookup: vi.fn(), nativeUrl: vi.fn(), expired: false, end: vi.fn(),
  snapshot: { sessionInstanceId: 'one', serverKey: 'server-a', userId: '1', token: 'jwt.canary.signature', tokenRevision: 1, phase: 'ready', nativeGeneration: null, nativeHandle: null, storageMode: 'window' },
}));
vi.mock('@/shared/api', () => ({ api: { auth: { webSocketTicket: state.ticket } }, readApiJson: async (response: Response) => { if (!response.ok) throw new Error('Admission denied'); return response.json(); } }));
vi.mock('@/shared/authToken', () => ({
  getAuthSessionSnapshot: () => state.snapshot,
  isCurrentAuthSession: (value: typeof state.snapshot) => value.sessionInstanceId === state.snapshot.sessionInstanceId && value.serverKey === state.snapshot.serverKey,
  isAuthTokenExpired: () => state.expired, expireAuthSession: state.end,
}));
vi.mock('@/shared/chisa', () => ({ isDesktop: () => state.desktop, getServerTransportVersion: () => state.revision, FrontendBridge: { getApiConnection: state.lookup }, desktopWebSocketUrl: state.nativeUrl }));

import { resolveWebSocketAdmissionUrl } from '@/shared/webSocketAdmission';

function deferred<T>() { let resolve!: (value: T) => void; return { promise: new Promise<T>(done => { resolve = done; }), resolve: (value: T) => resolve(value) }; }
beforeEach(() => {
  vi.resetAllMocks(); state.revision = 0; state.desktop = false; state.expired = false;
  state.snapshot = { ...state.snapshot, sessionInstanceId: 'one', serverKey: 'server-a', phase: 'ready', token: 'jwt.canary.signature' };
  state.ticket.mockImplementation(async () => new Response(JSON.stringify({ ticket: 'a'.repeat(43), expiresAt: Math.floor(Date.now() / 1000) + 30 }), { status: 200 }));
});
afterEach(() => vi.restoreAllMocks());

test('browser admission only exposes the opaque ticket and asks API with the captured identity', async () => {
  const captured = state.snapshot;
  const url = await resolveWebSocketAdmissionUrl('/ws');
  expect(state.ticket).toHaveBeenCalledWith('/ws', { expectedSession: captured });
  expect(new URL(url).pathname).toBe('/ws'); expect(new URL(url).searchParams.get('ticket')).toBe('a'.repeat(43));
  expect(url).not.toContain('jwt.canary.signature'); expect(new URL(url).searchParams.has('token')).toBe(false);
});

test.each(['/shell', '/desktop-notifications', '/plugin-ws/approved'])('admission binds ticket requests to %s', async path => {
  expect(new URL(await resolveWebSocketAdmissionUrl(path)).pathname).toBe(path);
  expect(state.ticket).toHaveBeenCalledWith(path, { expectedSession: state.snapshot });
});

test('a late ticket or stale transport cannot create a URL for a replacement login', async () => {
  const response = deferred<Response>(); state.ticket.mockReturnValue(response.promise);
  const pending = resolveWebSocketAdmissionUrl('/ws'); state.snapshot = { ...state.snapshot, sessionInstanceId: 'two' };
  response.resolve(new Response(JSON.stringify({ ticket: 'a'.repeat(43), expiresAt: Math.floor(Date.now() / 1000) + 30 })));
  await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  const delayed = deferred<Response>(); state.ticket.mockReturnValue(delayed.promise);
  const transport = resolveWebSocketAdmissionUrl('/ws'); state.revision++;
  delayed.resolve(new Response(JSON.stringify({ ticket: 'a'.repeat(43), expiresAt: Math.floor(Date.now() / 1000) + 30 })));
  await expect(transport).rejects.toMatchObject({ name: 'AbortError' });
});

test('signed-out/platform, expired, denied and malformed admissions fail closed', async () => {
  state.snapshot.phase = 'signedOut'; await expect(resolveWebSocketAdmissionUrl('/ws')).rejects.toMatchObject({ name: 'AbortError' });
  expect(state.ticket).not.toHaveBeenCalled(); state.snapshot.phase = 'ready';
  state.expired = true; await expect(resolveWebSocketAdmissionUrl('/ws')).rejects.toMatchObject({ name: 'AbortError' }); expect(state.end).toHaveBeenCalled(); state.expired = false;
  for (const payload of [{ ticket: 'jwt.canary.signature', expiresAt: 1 }, { ticket: 'a'.repeat(43), expiresAt: 1 }, { ticket: 'a'.repeat(43), expiresAt: Math.floor(Date.now() / 1000) + 300 }]) {
    state.ticket.mockResolvedValue(new Response(JSON.stringify(payload))); await expect(resolveWebSocketAdmissionUrl('/ws')).rejects.toThrow('Invalid WebSocket');
  }
  state.ticket.mockResolvedValue(new Response('{}', { status: 401 })); await expect(resolveWebSocketAdmissionUrl('/ws')).rejects.toThrow('Admission denied');
  for (const path of ['/ws?token=secret', '/plugin-ws/a/b', '//evil.test/ws', '/shell/']) await expect(resolveWebSocketAdmissionUrl(path)).rejects.toThrow('Unsupported');
});

test('native admission uses the current bound capability without requesting a browser ticket', async () => {
  state.desktop = true; state.lookup.mockResolvedValue({}); state.nativeUrl.mockReturnValue('ws://127.0.0.1/channel/cap/ws');
  expect(await resolveWebSocketAdmissionUrl('/ws')).toBe('ws://127.0.0.1/channel/cap/ws');
  expect(state.ticket).not.toHaveBeenCalled(); expect(state.nativeUrl).toHaveBeenCalledWith('/ws', state.snapshot.token);
});
