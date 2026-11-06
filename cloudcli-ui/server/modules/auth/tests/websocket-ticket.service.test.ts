import assert from 'node:assert/strict';
import test from 'node:test';

import { AppError } from '@/shared/index.js';
import type { AuthSessionContext } from '@/shared/index.js';
import { createWebSocketTicketService } from '../websocket-ticket.service.js';

const session: AuthSessionContext = { id: '11111111-1111-4111-8111-111111111111', userId: 1, version: 2, createdAt: 900, expiresAt: 2000 };
const hasCode = (code: string) => (error: unknown) => error instanceof AppError && error.code === code;
function fixture(options: { capacity?: number; sessionCapacity?: number } = {}) {
  const state = { time: 1000, active: true, storageFailure: false };
  const service = createWebSocketTicketService({ ...options, now: () => state.time,
    isSessionActive: (id, userId, version) => {
      if (state.storageFailure) throw new Error('storage unavailable');
      return state.active && userId === 1 && version === 2 && [session.id, 'second-session'].includes(id);
    },
    getUser: id => id === 1 ? { id, username: 'alice' } : undefined,
  });
  return { state, service };
}

test('opaque ticket carries no claims and consumes exactly once on its exact path', () => {
  const { service } = fixture();
  for (const path of ['/ws', '/shell', '/desktop-notifications', '/plugin-ws/plugin_1-safe']) {
    const issued = service.issue(session, path);
    assert.match(issued.ticket, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(issued.expiresAt, 1030);
    assert.deepEqual(service.consume(issued.ticket, path), { id: 1, userId: 1, username: 'alice',
      sessionId: session.id, sessionVersion: 2, sessionExpiresAt: 2000 });
    assert.equal(service.consume(issued.ticket, path), null);
  }
});

test('wrong path burns a ticket and invalid paths never mint tickets', () => {
  const { service } = fixture();
  const issued = service.issue(session, '/ws');
  assert.equal(service.consume(issued.ticket, '/shell'), null);
  assert.equal(service.consume(issued.ticket, '/ws'), null);
  for (const path of [null, '', '/ws/', '//ws', '/ws?query=1', '/ws\n', ' /ws', '/ws ', '/plugin-ws/', '/plugin-ws/../ws',
    '/plugin-ws/name/more', '/plugin-ws/name%2fother', '/plugin-ws/名字', `/plugin-ws/${'a'.repeat(256)}`]) {
    assert.throws(() => service.issue(session, path), hasCode('AUTH_WS_PATH_INVALID'));
  }
  for (const ticket of [null, '', 'bad', ['bad'], 'a'.repeat(44), 'a'.repeat(43)]) assert.equal(service.consume(ticket, '/ws'), null);
});

test('ticket expiration is exact and never outlives its authenticated session', () => {
  const { state, service } = fixture();
  const ticket = service.issue(session, '/ws');
  state.time = ticket.expiresAt;
  assert.equal(service.consume(ticket.ticket, '/ws'), null);
  state.time = 1990;
  const short = service.issue(session, '/ws');
  assert.equal(short.expiresAt, 2000);
  state.time = 2000;
  assert.equal(service.consume(short.ticket, '/ws'), null);
  assert.throws(() => service.issue(session, '/ws'), hasCode('AUTH_TOKEN_INVALID'));
});

test('missing session/platform bypass, revocation and operational failure are closed', () => {
  const { state, service } = fixture();
  assert.throws(() => service.issue(undefined, '/ws'), hasCode('AUTH_TOKEN_INVALID'));
  const ticket = service.issue(session, '/ws');
  state.active = false;
  assert.equal(service.consume(ticket.ticket, '/ws'), null);
  assert.throws(() => service.issue(session, '/ws'), hasCode('AUTH_TOKEN_INVALID'));
  state.active = true;
  assert.equal(service.consume(ticket.ticket, '/ws'), null);
  const next = service.issue(session, '/ws');
  state.storageFailure = true;
  assert.equal(service.consume(next.ticket, '/ws'), null);
  assert.throws(() => service.issue(session, '/ws'), /storage unavailable/);
  state.storageFailure = false;
  assert.equal(service.consume(next.ticket, '/ws'), null);
});

test('per-session and global limits do not evict live tickets and expired capacity is recovered', () => {
  const { state, service } = fixture({ capacity: 3, sessionCapacity: 2 });
  const first = service.issue(session, '/ws');
  service.issue(session, '/ws');
  assert.throws(() => service.issue(session, '/ws'), hasCode('AUTH_WS_TICKETS_BUSY'));
  const second = { ...session, id: 'second-session' };
  const third = service.issue(second, '/ws');
  assert.throws(() => service.issue(second, '/ws'), error => error instanceof AppError && error.statusCode === 503
    && (error.details as { retryAfterSeconds: number }).retryAfterSeconds === 1);
  assert.ok(service.consume(first.ticket, '/ws'));
  assert.ok(service.issue(second, '/ws'));
  state.time += 30;
  assert.equal(service.consume(third.ticket, '/ws'), null);
  assert.ok(service.issue(session, '/ws'));
});

test('the stored session proof is immutable after issuance and missing users are rejected', () => {
  const { service } = fixture();
  const proof = { ...session };
  const ticket = service.issue(proof, '/ws');
  proof.userId = 999; proof.version = 999; proof.expiresAt = 999;
  assert.equal(service.consume(ticket.ticket, '/ws')?.userId, 1);
  const missing = createWebSocketTicketService({ now: () => 1000, isSessionActive: () => true, getUser: () => undefined });
  assert.equal(missing.consume(missing.issue(session, '/ws').ticket, '/ws'), null);
});
