import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import express from 'express';
import type { ErrorRequestHandler, RequestHandler } from 'express';

import { AppError } from '@/shared/index.js';
import type { AuthenticatedHttpRequest, AuthSessionContext } from '@/shared/index.js';
import { createAuthRouter } from '../auth.routes.js';
import { createAuthService } from '../auth.service.js';
import { createLoginGuard } from '../login-guard.service.js';

type Dependencies = Parameters<typeof createAuthService>[0];
const session: AuthSessionContext = { id: '11111111-1111-4111-8111-111111111111', userId: 1, version: 0, createdAt: 1000, expiresAt: 2000 };
const user = { id: 1, username: 'alice', password_hash: 'fixture-hash', auth_version: 0 };
const hasProof: RequestHandler = (req, _res, next) => {
  const request = req as AuthenticatedHttpRequest;
  request.user = user; request.authSession = session; next();
};
function dependencies(overrides: Partial<Dependencies> = {}): Dependencies {
  return {
    users: { getUserByUsername: () => undefined, updateLastLogin: () => undefined, updateProfile: () => undefined },
    comparePassword: async () => false, generateToken: () => 'fixture-token', refreshToken: () => 'refreshed-token',
    revokeSession: () => undefined, issueWebSocketTicket: () => ({ ticket: 'fixture-ticket', expiresAt: 1030 }), ...overrides,
  };
}
async function withRouter(options: Dependencies, authenticate: RequestHandler, run: (origin: string) => Promise<void>) {
  const app = express();
  app.set('trust proxy', true); // Deliberately permissive proxy config cannot alter the login budget source.
  app.use(express.json());
  app.use('/api/auth', createAuthRouter(createAuthService(options), authenticate));
  const errors: ErrorRequestHandler = (error: unknown, _req, res, _next) => {
    if (error instanceof AppError) res.status(error.statusCode).json({ error: { code: error.code, message: error.message } });
    else res.status(500).json({ error: 'Unexpected fixture failure' });
  };
  app.use(errors);
  const listener = app.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  try { await run(`http://127.0.0.1:${(listener.address() as AddressInfo).port}/api/auth`); }
  finally { await new Promise<void>((resolve, reject) => listener.close(error => error ? reject(error) : resolve())); }
}
function post(origin: string, endpoint: string, body?: unknown, headers: Record<string, string> = {}) {
  return fetch(`${origin}${endpoint}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}

test('changing forwarded headers cannot evade the socket-source login budget', async () => {
  let comparisons = 0;
  await withRouter(dependencies({ loginGuard: createLoginGuard({ sourceLimit: 3 }),
    comparePassword: async () => { comparisons += 1; return false; },
  }), hasProof, async origin => {
    for (let index = 0; index < 4; index += 1) {
      const response = await post(origin, '/login', { username: `unknown-${index}`, password: 'fixture-input' }, {
        'X-Forwarded-For': `203.0.113.${index + 1}`, Forwarded: `for=198.51.100.${index + 1}`,
      });
      assert.equal(response.status, index < 3 ? 401 : 429);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.equal(response.headers.get('x-auth-error'), null);
      if (index === 3) {
        assert.ok(Number(response.headers.get('retry-after')) >= 1);
        assert.equal((await response.json() as { error: { code: string } }).error.code, 'AUTH_LOGIN_RATE_LIMITED');
      }
    }
    assert.equal(comparisons, 3);
  });
});

test('operational login, refresh, logout and ticket failures produce retryable 503 without invalid-token headers', async () => {
  const fail = (): never => { throw new Error('private database details must stay internal'); };
  await withRouter(dependencies({ comparePassword: async () => fail(), refreshToken: fail,
    revokeSession: fail, issueWebSocketTicket: fail,
  }), hasProof, async origin => {
    for (const [endpoint, body] of [
      ['/login', { username: 'alice', password: 'fixture-input' }], ['/refresh', undefined],
      ['/logout', undefined], ['/ws-ticket', { path: '/ws' }],
    ] as const) {
      const response = await post(origin, endpoint, body, { Authorization: 'Bearer fixture-token' });
      assert.equal(response.status, 503, endpoint);
      assert.equal(response.headers.get('retry-after'), '1');
      assert.equal(response.headers.get('x-auth-error'), null);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      const payload = await response.json() as { error: { code: string; message: string } };
      assert.equal(payload.error.code, 'AUTH_UNAVAILABLE');
      assert.equal(payload.error.message.includes('private database'), false);
    }
  });
});

test('ticket route requires explicit Bearer and persisted session even with platform-style middleware', async () => {
  let calls = 0;
  const options = dependencies({ isPlatform: true, issueWebSocketTicket: (proof, path) => {
    calls += 1; assert.deepEqual(proof, session); assert.equal(path, '/shell');
    return { ticket: 'fixture-ticket', expiresAt: 1030 };
  } });
  await withRouter(options, hasProof, async origin => {
    for (const headers of [{}, { Authorization: 'Basic fixture' }] as Record<string, string>[]) {
      const response = await post(origin, '/ws-ticket', { path: '/shell' }, headers);
      assert.equal(response.status, 401); assert.equal(response.headers.get('x-auth-error'), 'invalid-token');
    }
    const response = await post(origin, '/ws-ticket', { path: '/shell' }, { Authorization: 'Bearer fixture-token' });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ticket: 'fixture-ticket', expiresAt: 1030 });
    assert.equal(calls, 1);
  });
  await withRouter(options, (req, _res, next) => { (req as AuthenticatedHttpRequest).user = user; next(); }, async origin => {
    const response = await post(origin, '/ws-ticket', { path: '/shell' }, { Authorization: 'Bearer fixture-token' });
    assert.equal(response.status, 401); assert.equal(calls, 1);
  });
});

test('post-verification session expiry and revocation preserve native X-Auth-Error values', async () => {
  for (const [code, header] of [['AUTH_TOKEN_EXPIRED', 'session-expired'], ['AUTH_TOKEN_INVALID', 'invalid-token']] as const) {
    await withRouter(dependencies({ refreshToken: () => { throw new AppError('Session rejected', { code, statusCode: 401 }); } }),
      hasProof, async origin => {
        const response = await post(origin, '/refresh');
        assert.equal(response.status, 401); assert.equal(response.headers.get('x-auth-error'), header);
      });
  }
});

test('saturated bcrypt admission returns 503 immediately and recovers after the active request completes', async () => {
  let release: (() => void) | undefined;
  let entered: (() => void) | undefined;
  const comparisonStarted = new Promise<void>(resolve => { entered = resolve; });
  const comparison = new Promise<void>(resolve => { release = resolve; });
  let comparisons = 0;
  await withRouter(dependencies({ loginGuard: createLoginGuard({ concurrency: 1 }), comparePassword: async () => {
    comparisons += 1; entered!(); await comparison; return false;
  } }), hasProof, async origin => {
    const first = post(origin, '/login', { username: 'first', password: 'fixture-input' });
    await comparisonStarted;
    try {
      const blocked = await post(origin, '/login', { username: 'second', password: 'fixture-input' });
      assert.equal(blocked.status, 503); assert.equal(blocked.headers.get('retry-after'), '1');
      assert.equal(blocked.headers.get('x-auth-error'), null); assert.equal(comparisons, 1);
    } finally { release!(); await first; }
    const recovered = await post(origin, '/login', { username: 'third', password: 'fixture-input' });
    assert.equal(recovered.status, 401); assert.equal(comparisons, 2);
  });
});
