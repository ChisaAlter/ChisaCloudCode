import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { CLAUDE_PREDEFINED_MODELS } from '@/modules/providers/list/claude/claude-models.provider.js';
import {
  getPendingApprovalsForSession,
  queryClaudeSDK,
  resolveToolApproval,
} from '@/modules/providers/list/claude/claude-runtime.provider.js';
import type { AnyRecord, ProviderRuntimeContext, ProviderRuntimeWriter } from '@/shared/index.js';

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

type AuthFixture = {
  cwd: string;
  sessionId: string;
  context: ProviderRuntimeContext;
  writer: ProviderRuntimeWriter & { active: boolean };
  revoked: Error;
  sent: AnyRecord[];
};

async function fixture(run: (value: AuthFixture) => Promise<void>) {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'claude-runtime-auth-'));
  const sessionId = `claude-auth-${randomUUID()}`;
  const revoked = Object.assign(new Error('Login session was revoked'), { code: 'UNAUTHORIZED' });
  const sent: AnyRecord[] = [];
  const writer: AuthFixture['writer'] = {
    userId: null,
    active: true,
    // A real writer method depends on its receiver. Adapter callbacks must not detach it.
    assertActive() { if (!this.active) throw revoked; },
    send(message) { sent.push(message as AnyRecord); },
  };
  const context: ProviderRuntimeContext = {
    resolveProviderSessionId: () => null,
    resolveResumeModel: async () => undefined,
    getProviderModels: async () => CLAUDE_PREDEFINED_MODELS as never,
    normalizeMessage: () => [],
    isProviderInstalled: async () => true,
    createQuery: () => Object.assign((async function* () {
      yield { type: 'result', subtype: 'success' };
    })(), { interrupt: async () => {} }),
  };
  try { await run({ cwd, sessionId, context, writer, revoked, sent }); }
  finally { await rm(cwd, { recursive: true, force: true }); }
}

test('Claude makes zero SDK calls when the login is revoked during model preparation', { timeout: 10_000 }, () => fixture(async ({ cwd, sessionId, context, writer, revoked }) => {
  const entered = gate();
  const resume = gate();
  let queries = 0;
  context.getProviderModels = async () => {
    entered.resolve();
    await resume.promise;
    return CLAUDE_PREDEFINED_MODELS as never;
  };
  context.createQuery = () => { queries += 1; throw new Error('SDK must not be called'); };
  const running = queryClaudeSDK('hello', { cwd, sessionId }, writer, context);
  void running.catch(() => {});
  try {
    await Promise.race([entered.promise, running.then(() => { throw new Error('Run ended before preparation'); })]);
    writer.active = false;
    resume.resolve();
    await assert.rejects(running, (error) => error === revoked);
    assert.equal(queries, 0, 'revocation is not an SDK hook mismatch and must not enter the compatibility retry');
  } finally {
    resume.resolve();
    await running.catch(() => {});
  }
}));

test('Claude makes zero compatibility retries when the first SDK call revokes the login', () => fixture(async ({ cwd, sessionId, context, writer, revoked }) => {
  let queries = 0;
  context.createQuery = ({ options }) => {
    queries += 1;
    assert.ok(options.hooks, 'the first call exercises the hook-compatibility branch');
    writer.active = false;
    throw new Error('Unsupported SDK hook shape');
  };
  await assert.rejects(queryClaudeSDK('hello', { cwd, sessionId }, writer, context), (error) => error === revoked);
  assert.equal(queries, 1, 'the original call is allowed, but revocation must prevent a second SDK call');
}));

test('Claude still retries hook compatibility once while the login is active', () => fixture(async ({ cwd, sessionId, context, writer }) => {
  const createQuery = context.createQuery!;
  let queries = 0;
  context.createQuery = (input) => {
    queries += 1;
    if (queries === 1) {
      assert.ok(input.options.hooks);
      throw new Error('Unsupported SDK hook shape');
    }
    assert.equal(input.options.hooks, undefined);
    return createQuery(input);
  };
  await queryClaudeSDK('hello', { cwd, sessionId }, writer, context);
  assert.equal(queries, 2);
}));

test('Claude retains the captured persistent login check independently from socket and run completion', () => fixture(async ({ cwd, sessionId, context, writer, revoked }) => {
  let loginActive = true;
  let guard: (() => void) | undefined;
  writer.assertAuthSessionActive = function () { if (!loginActive) throw revoked; };
  const createQuery = context.createQuery!;
  context.createQuery = (input) => {
    assert.equal(typeof input.options.chisaAssertAuthActive, 'function');
    guard = input.options.chisaAssertAuthActive;
    return createQuery(input);
  };
  await queryClaudeSDK('hello', { cwd, sessionId, chisaAssertAuthActive: () => { throw new Error('forged option'); } }, writer, context);
  assert.ok(guard, 'the adapter installs its own server writer guard');
  writer.active = false;
  assert.doesNotThrow(guard, 'an ordinary transport disconnect or settled run does not revoke a healthy login');
  loginActive = false;
  assert.throws(guard, (error) => error === revoked, 'logout revokes the captured check even after the query has completed');
}));

for (const revoke of [true, false]) {
  test(`Claude ${revoke ? 'rejects a revoked login' : 'continues an active login'} after awaited tool approval`, { timeout: 10_000 }, () => fixture(async ({ cwd, sessionId, context, writer, revoked, sent }) => {
    const entered = gate();
    const permissionController = new AbortController();
    let queries = 0;
    let continuations = 0;
    let sdkOptions: AnyRecord | undefined;
    context.createQuery = ({ options }) => {
      queries += 1;
      sdkOptions = options;
      return Object.assign((async function* () {
        const pending = options.canUseTool('Bash', { command: 'echo fixture' }, { signal: permissionController.signal, chisaForceAsk: true });
        entered.resolve();
        const decision = await pending;
        assert.equal(decision.behavior, 'allow');
        continuations += 1;
        yield { type: 'result', subtype: 'success' };
      })(), { interrupt: async () => {} });
    };
    const running = queryClaudeSDK('hello', { cwd, sessionId, toolsSettings: { allowedTools: [], disallowedTools: [] } }, writer, context);
    void running.catch(() => {});
    try {
      await Promise.race([entered.promise, running.then(() => { throw new Error('Run ended before tool approval'); })]);
      const pending = getPendingApprovalsForSession(sessionId);
      assert.equal(pending.length, 1, 'approval is registered and awaiting a client decision');
      assert.equal(sent.filter((message) => message.kind === 'permission_request').length, 1);
      assert.equal(continuations, 0);
      if (revoke) writer.active = false;
      resolveToolApproval(pending[0].requestId, { allow: true, rememberEntry: 'Bash(echo fixture)', updatedInput: { command: 'echo approved' } });
      if (revoke) await assert.rejects(running, (error) => error === revoked);
      else await running;
      assert.equal(queries, 1);
      assert.equal(continuations, revoke ? 0 : 1, 'a revoked decision cannot reach SDK tool execution');
      assert.equal(sent.filter((message) => message.kind === 'permission_resolved').length, revoke ? 0 : 1);
      assert.equal(sdkOptions?.allowedTools.includes('Bash(echo fixture)'), !revoke, 'revocation must also prevent remembered-rule mutation');
      assert.deepEqual(getPendingApprovalsForSession(sessionId), []);
    } finally {
      permissionController.abort();
      await running.catch(() => {});
    }
  }));
}
