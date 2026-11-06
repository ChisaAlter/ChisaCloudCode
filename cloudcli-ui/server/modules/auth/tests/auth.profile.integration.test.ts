import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';
import type { AddressInfo } from 'node:net';
import express from 'express';
import type { ErrorRequestHandler } from 'express';

type AccountHttpPayload = {
  token: string;
  user: { id: number; username: string; displayName: string | null; avatarDataUrl: string | null };
  error: { code: string };
};

const readPayload = (response: Response) => response.json() as Promise<AccountHttpPayload>;

test('only database-provisioned accounts can log in; their profile survives SQLite reopen', async () => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'chisa-account-'));
  const databasePath = path.join(fixtureRoot, 'account.db');
  // A new empty file prevents the production legacy-copy bootstrap from touching real account data.
  fs.writeFileSync(databasePath, '');
  const previousDatabase = process.env.DATABASE_PATH;
  const previousPlatform = process.env.VITE_IS_PLATFORM;
  process.env.DATABASE_PATH = databasePath;
  process.env.VITE_IS_PLATFORM = 'false';
  const { initializeDatabase, getConnection, closeConnection, userDb } = await import('@/modules/database/index.js');
  // Exercise the upgrade path too: this is the original account table before profile columns existed.
  getConnection().exec(`CREATE TABLE users (
    id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_login DATETIME, is_active BOOLEAN DEFAULT 1, git_name TEXT,
    git_email TEXT, has_completed_onboarding BOOLEAN DEFAULT 0
  )`);
  await initializeDatabase();
  const { authRoutes, verifyAuthToken, authenticateWebSocket, isAuthSessionActive, consumeWebSocketTicket } = await import('@/modules/auth/index.js');
  const { AppError } = await import('@/shared/index.js');
  const app = express();
  app.use(express.json({ limit: '4mb' }));
  app.use('/api/auth', authRoutes);
  const errors: ErrorRequestHandler = (error: unknown, _req, res, _next) => {
    if (error instanceof AppError) res.status(error.statusCode).json({ success: false, error: { code: error.code, message: error.message } });
    else res.status(500).json({ error: String(error) });
  };
  app.use(errors);
  const listener = app.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const origin = `http://127.0.0.1:${(listener.address() as AddressInfo).port}`;
  const request = (endpoint: string, method = 'GET', body?: unknown, token?: string) => fetch(`${origin}/api/auth${endpoint}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  try {
    const credentials = { username: 'account-qa', password: 'local-test-password' };
    const status = await request('/status');
    assert.equal(status.status, 200);
    assert.deepEqual(await status.json(), { isAuthenticated: false });
    const emptyLogin = await request('/login', 'POST', credentials);
    assert.equal(emptyLogin.status, 401);
    assert.equal((await readPayload(emptyLogin)).error.code, 'AUTH_INVALID_CREDENTIALS');
    const registered = await request('/register', 'POST', credentials);
    assert.equal(registered.status, 404);
    assert.equal(userDb.hasUsers(), false);

    // Provision through the existing database interface, as the server administrator does.
    const require = createRequire(import.meta.url);
    const bcrypt = require('bcrypt') as { hash(password: string, rounds: number): Promise<string> };
    userDb.createUser(credentials.username, await bcrypt.hash(credentials.password, 12));
    const login = await request('/login', 'POST', credentials);
    assert.equal(login.status, 200);
    const session = await readPayload(login);
    assert.equal(session.user.username, credentials.username);
    const refreshed = await request('/refresh', 'POST', undefined, session.token);
    assert.equal(refreshed.status, 200);
    const refreshedToken = (await readPayload(refreshed)).token;
    assert.equal((await request('/user', 'GET', undefined, refreshedToken)).status, 200);
    assert.deepEqual(verifyAuthToken(refreshedToken).session, verifyAuthToken(session.token).session);
    assert.equal(login.headers.get('cache-control'), 'no-store');
    assert.ok(authenticateWebSocket(session.token));
    const proof = verifyAuthToken(session.token).session;
    assert.equal(isAuthSessionActive(proof.id, proof.userId, proof.version), true);
    assert.equal((await request('/ws-ticket', 'POST', { path: '/ws' })).status, 401);
    assert.equal((await request('/ws-ticket', 'POST', { path: '/unknown' }, session.token)).status, 400);
    const ticketResponse = await request('/ws-ticket', 'POST', { path: '/ws' }, session.token);
    assert.equal(ticketResponse.status, 200);
    assert.equal(ticketResponse.headers.get('cache-control'), 'no-store');
    const ticket = await ticketResponse.json() as { ticket: string; expiresAt: number };
    assert.equal(consumeWebSocketTicket(ticket.ticket, '/ws')?.sessionId, proof.id);
    assert.equal(consumeWebSocketTicket(ticket.ticket, '/ws'), null);
    const outstanding = await (await request('/ws-ticket', 'POST', { path: '/shell' }, session.token)).json() as { ticket: string };
    const queryResponse = await fetch(`${origin}/api/auth/user?token=${encodeURIComponent(session.token)}`);
    assert.equal(queryResponse.status, 401);
    assert.equal(queryResponse.headers.get('x-auth-error'), 'invalid-token');
    const headerPrecedence = await fetch(`${origin}/api/auth/user?token=${encodeURIComponent(session.token)}`, { headers: { Authorization: 'Basic invalid' } });
    assert.equal(headerPrecedence.status, 401);
    assert.equal(headerPrecedence.headers.get('x-auth-error'), 'invalid-token');
    const wrongLogin = await request('/login', 'POST', { ...credentials, password: 'wrong-password' });
    assert.equal(wrongLogin.status, 401);
    assert.equal((await readPayload(wrongLogin)).error.code, 'AUTH_INVALID_CREDENTIALS');
    assert.equal((await request('/profile', 'PATCH', { displayName: '旁观者', avatarDataUrl: null })).status, 401);

    const avatarDataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aE04AAAAASUVORK5CYII=';
    const saved = await request('/profile', 'PATCH', { displayName: '  测试昵称  ', avatarDataUrl }, session.token);
    assert.equal(saved.status, 200);
    assert.equal((await readPayload(saved)).user.displayName, '测试昵称');
    assert.equal((await request('/logout', 'POST', undefined, session.token)).status, 200);
    assert.equal((await request('/user')).status, 401);
    for (const token of [session.token, refreshedToken]) {
      const refused = await request('/user', 'GET', undefined, token);
      assert.equal(refused.status, 401);
      assert.equal(refused.headers.get('x-auth-error'), 'invalid-token');
      assert.equal((await request('/refresh', 'POST', undefined, token)).status, 401);
      assert.equal(authenticateWebSocket(token), null);
    }
    assert.equal(isAuthSessionActive(proof.id, proof.userId, proof.version), false);
    assert.equal(consumeWebSocketTicket(outstanding.ticket, '/shell'), null);
    assert.equal((await request('/ws-ticket', 'POST', { path: '/ws' }, session.token)).status, 401);

    closeConnection();
    assert.equal((await request('/user', 'GET', undefined, session.token)).status, 401);
    const relogin = await request('/login', 'POST', credentials);
    assert.equal(relogin.status, 200);
    const nextSession = await readPayload(relogin);
    assert.equal(nextSession.user.displayName, '测试昵称');
    assert.equal(nextSession.user.avatarDataUrl, avatarDataUrl);
    assert.equal(nextSession.user.username, credentials.username);
    const reload = await request('/user', 'GET', undefined, nextSession.token);
    assert.equal((await readPayload(reload)).user.avatarDataUrl, avatarDataUrl);
    const invalidName = await request('/profile', 'PATCH', { displayName: '', avatarDataUrl }, nextSession.token);
    assert.equal(invalidName.status, 400);
    const invalidAvatar = await request('/profile', 'PATCH', { displayName: '未保存', avatarDataUrl: 'data:image/svg+xml;base64,PHN2Zz4=' }, nextSession.token);
    assert.equal(invalidAvatar.status, 400);
    const unchanged = await request('/user', 'GET', undefined, nextSession.token);
    assert.equal((await readPayload(unchanged)).user.displayName, '测试昵称');
  } finally {
    await new Promise<void>((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
    closeConnection();
    if (previousDatabase === undefined) delete process.env.DATABASE_PATH; else process.env.DATABASE_PATH = previousDatabase;
    if (previousPlatform === undefined) delete process.env.VITE_IS_PLATFORM; else process.env.VITE_IS_PLATFORM = previousPlatform;
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});
