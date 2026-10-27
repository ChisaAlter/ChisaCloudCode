import assert from 'node:assert/strict';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { ClaudeAccountRenewalService } from '@/modules/providers/services/claude-accounts-renewal.service.js';
import type { ClaudeAccountCredentialRead } from '@/shared/types.js';

const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const credential = (now: number): ClaudeAccountCredentialRead => ({ accessToken: 'fixture-expired', expiresAt: now - 1, refreshable: true, email: 'fixture@example.test', organizationUuid: 'fixture-org', organizationName: 'Fixture', plan: 'pro', tier: null, unavailable: false, renewalFingerprint: 'one-way-fixture' });
class Child extends EventEmitter {
  pid = undefined;
  killed = 0;
  kill() { this.killed++; this.emit('close', null); return true; }
  asChild() { return this as unknown as ChildProcess; }
}

test('official renewal coalesces per account, uses isolated auth status, and retries transient failures without changing identity', async () => {
  let now = 1_000_000;
  const files = new Map([['user:1', credential(now)], ['user:2', { ...credential(now), email: 'other@example.test' }]]);
  const children: Array<{ child: Child; args: string[]; options: SpawnOptions }> = [];
  const renewal = new ClaudeAccountRenewalService({ now: () => now, resolveExecutable: () => 'fixture-cli', env: () => ({ ANTHROPIC_API_KEY: 'do-not-inherit', CLAUDE_CODE_OAUTH_TOKEN: 'do-not-inherit', CLAUDE_CODE_HOST_CREDS_FILE: '/foreign/creds', PATH: 'fixture' }), spawn: (_command, args, options) => { const child = new Child(); children.push({ child, args, options }); return child.asChild(); } });
  const read = (key: string) => () => files.get(key)!;
  const paths = (key: string) => () => ({ configDir: '/fixture/' + key + '/config', authDir: '/fixture/' + key + '/auth' });
  try {
    const first = renewal.ensure('user:1', read('user:1'), paths('user:1'));
    const same = renewal.ensure('user:1', read('user:1'), paths('user:1'));
    const other = renewal.ensure('user:2', read('user:2'), paths('user:2'));
    assert.equal(children.length, 2); assert.equal(renewal.isBusy('user:1'), true);
    assert.deepEqual(children[0].args.slice(-3), ['auth', 'status', '--json']);
    assert.equal(children[0].options.env?.CLAUDE_CONFIG_DIR, '/fixture/user:1/config');
    assert.equal(children[0].options.env?.CLAUDE_SECURESTORAGE_CONFIG_DIR, '/fixture/user:1/auth');
    assert.equal(children[0].options.env?.ANTHROPIC_API_KEY, ''); assert.equal(children[0].options.env?.CLAUDE_CODE_OAUTH_TOKEN, ''); assert.equal(children[0].options.env?.CLAUDE_CODE_HOST_CREDS_FILE, '');
    assert.deepEqual(children[0].options.stdio, ['ignore', 'ignore', 'ignore']);
    files.set('user:1', { ...files.get('user:1')!, accessToken: 'fixture-renewed', expiresAt: now + 3_600_000, renewalFingerprint: 'rotated' });
    children[0].child.emit('close', 0); children[1].child.emit('close', 0);
    await Promise.all([first, same, other]); assert.equal(renewal.isBusy('user:1'), false);
    assert.equal(files.get('user:2')?.refreshable, true);
    await renewal.ensure('user:1', read('user:1'), paths('user:1'));
    await renewal.ensure('user:2', read('user:2'), paths('user:2')); assert.equal(children.length, 2);
    now += 30_000;
    const retry = renewal.ensure('user:2', read('user:2'), paths('user:2')); assert.equal(children.length, 3);
    children[2].child.emit('close', 1); await retry;
    now += 30_000; await renewal.ensure('user:2', read('user:2'), paths('user:2')); assert.equal(children.length, 3);
    // A newly replaced refresh token bypasses old-login retry cooldown, without caching the token itself.
    files.set('user:2', { ...files.get('user:2')!, renewalFingerprint: 'new-refresh-digest' });
    const newLogin = renewal.ensure('user:2', read('user:2'), paths('user:2')); assert.equal(children.length, 4);
    children[3].child.emit('close', 0); await newLogin;
    await renewal.ensure('env-token', () => ({ ...credential(now), expiresAt: null, refreshable: false }), () => { throw new Error('Environment tokens must never enter renewal.'); });
    assert.equal(children.length, 4);
  } finally { await renewal.dispose(); }
});

test('bounded renewal shutdown kills stuck child and keeps credentials intact', async () => {
  const child = new Child(); const original = credential(Date.now());
  const renewal = new ClaudeAccountRenewalService({ timeoutMs: 15, resolveExecutable: () => 'fixture-cli', spawn: () => child.asChild() });
  const pending = renewal.ensure('fixture', () => original, () => ({ configDir: '/fixture', authDir: '/fixture' }));
  // Keep the test event loop alive while the production timeout deliberately remains unref'ed.
  const keepAlive = setTimeout(() => {}, 1000);
  try { await pending; assert.equal(child.killed, 1); assert.equal(original.refreshable, true); assert.equal(original.accessToken, 'fixture-expired'); assert.equal(renewal.isBusy('fixture'), false); }
  finally { clearTimeout(keepAlive); await renewal.dispose(); }
  await tick();
});
