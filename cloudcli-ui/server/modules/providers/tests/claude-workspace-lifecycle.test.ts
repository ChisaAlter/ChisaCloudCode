import assert from 'node:assert/strict';
import { once } from 'node:events';
import { promises as fs } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test, { mock } from 'node:test';


import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';

import { ClaudeSessionsProvider } from '@/modules/providers/list/claude/claude-sessions.provider.js';
import type { ProviderRuntimeContext } from '@/shared/index.js';
import type { NormalizedMessage } from '@/shared/types.js';
import { WORKSPACES_ROOT } from '@/shared/index.js';

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

let queries = 0;
let failedNotifications = 0;
let stoppedNotifications = 0;
let scenario: (input: Parameters<typeof import('@anthropic-ai/claude-agent-sdk').query>[0]) => unknown;
mock.module('@anthropic-ai/claude-agent-sdk', {
  namedExports: { tool, createSdkMcpServer, query: (input: Parameters<typeof import('@anthropic-ai/claude-agent-sdk').query>[0]) => { queries++; return scenario(input); } },
});
mock.module('@/shared/claude-cli-path.js', { namedExports: { resolveClaudeCodeExecutablePath: () => undefined } });
mock.module('@/modules/notifications/index.js', { namedExports: {
  createNotificationEvent: (event: unknown) => event,
  notifyBackgroundWorkCompleted() {},
  notifyRunFailed() { failedNotifications++; },
  notifyRunStopped() { stoppedNotifications++; },
  notifyUserIfEnabled() {},
} });
const { queryClaudeSDK, abortClaudeSDKSession, resolveToolApproval } = await import('@/modules/providers/list/claude/claude-runtime.provider.js');

async function fixture(run: (cwd: string, context: ProviderRuntimeContext, frames: NormalizedMessage[]) => Promise<void>) {
  await mkdir(WORKSPACES_ROOT, { recursive: true });
  const cwd = await mkdtemp(path.join(path.resolve(WORKSPACES_ROOT), 'chisa-sdk-lifecycle-'));
  await writeFile(path.join(cwd, 'README.md'), 'fixture');
  const access = fs.access.bind(fs);
  mock.method(fs, 'access', async (candidate: Parameters<typeof fs.access>[0], mode?: number) => {
    if (String(candidate) === path.join(os.homedir(), '.claude.json')) throw Object.assign(new Error('isolated'), { code: 'ENOENT' });
    return access(candidate, mode);
  });
  const context: ProviderRuntimeContext = {
    resolveProviderSessionId: () => null,
    resolveResumeModel: async () => 'sonnet',
    getProviderModels: async () => ({}) as never,
    normalizeMessage: () => [],
    isProviderInstalled: async () => true,
  };
  queries = 0;
  failedNotifications = 0;
  stoppedNotifications = 0;
  try { await run(cwd, context, []); }
  finally { mock.restoreAll(); await rm(cwd, { recursive: true, force: true }); }
}

test('bound workspace tools retain default confirmation and native-tool deny/allow policy', { timeout: 5000 }, async () => {
  await fixture(async (cwd, context, frames) => {
    await writeFile(path.join(cwd, '.chisa-bridge.json'), JSON.stringify({ protocol: 1, port: 19081, token: 'fixture', bindingEpoch: 'fixture' }));
    const cases = [
      { tool: 'mcp__workspace__write_file', input: { path: '/workspace/new.txt', expectedHash: null }, settings: {}, behavior: 'allow', asks: true },
      { tool: 'mcp__workspace__run_command', input: { command: 'git status --short', readOnly: true }, settings: {}, behavior: 'allow', asks: true },
      { tool: 'mcp__workspace__write_file', input: { expectedHash: null }, settings: { allowedTools: ['Write'], disallowedTools: ['Write'] }, behavior: 'deny', asks: false },
      { tool: 'mcp__workspace__write_file', input: { expectedHash: 'loaded-version' }, settings: { disallowedTools: ['Edit'] }, behavior: 'deny', asks: false },
      { tool: 'mcp__workspace__run_command', input: { command: 'git status --short' }, settings: { disallowedTools: ['Bash'] }, behavior: 'deny', asks: false },
      { tool: 'mcp__workspace__write_file', input: { expectedHash: null }, settings: { allowedTools: ['Write'] }, behavior: 'allow', asks: false },
      { tool: 'mcp__workspace__read_file', input: {}, settings: { allowedTools: ['Read'] }, behavior: 'allow', asks: false },
      { tool: 'mcp__workspace__list_files', input: {}, settings: { allowedTools: ['Glob'] }, behavior: 'allow', asks: false },
      { tool: 'mcp__workspace__search_files', input: { content: true }, settings: { allowedTools: ['Grep'] }, behavior: 'allow', asks: false },
      { tool: 'mcp__workspace__run_command', input: { command: 'git status --short' }, settings: { allowedTools: ['Bash(git status:*)'] }, behavior: 'allow', asks: false },
      { tool: 'mcp__workspace__write_file', input: { expectedHash: null }, settings: { allowedTools: ['mcp__workspace__write_file'] }, behavior: 'allow', asks: false },
    ];
    for (const [index, candidate] of cases.entries()) {
      frames.length = 0;
      let behavior: string | undefined;
      scenario = input => Object.assign((async function* () {
        assert.equal(input.options?.allowedTools?.some(tool => tool.startsWith('mcp__workspace')), false);
        const decision = await input.options!.canUseTool!(candidate.tool, candidate.input, { signal: new AbortController().signal } as never);
        assert.ok(decision);
        behavior = decision.behavior;
        yield { type: 'result', subtype: 'success' };
      })(), { close() {} });
      await queryClaudeSDK('fixture', { cwd, sessionId: `permission-${index}`, toolsSettings: { allowedTools: [], disallowedTools: [], skipPermissions: false, ...candidate.settings } }, {
        send: (frame: NormalizedMessage) => {
          frames.push(frame);
          if (frame.kind === 'permission_request') queueMicrotask(() => resolveToolApproval(frame.requestId, { allow: true }));
        },
      }, context);
      assert.equal(behavior, candidate.behavior, `${candidate.tool}: ${JSON.stringify(candidate.settings)}`);
      assert.equal(frames.some(frame => frame.kind === 'permission_request'), candidate.asks);
    }
  });
});

for (const stopBeforeExit of [true, false]) {
  test(`Claude reports real process stop before handback completes; cancellation before exit=${stopBeforeExit}`, { timeout: 8000 }, async () => {
    await fixture(async (cwd, context, frames) => {
      const iteratorClosed = gate();
      const launched = gate();
      const syncing = gate();
      const synchronized = gate();
      const operations: string[] = [];
      let child: import('node:child_process').ChildProcess | undefined;
      const server = createServer((incoming, response) => {
        void (async () => {
          const chunks: Buffer[] = [];
          for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
          const request = JSON.parse(Buffer.concat(chunks).toString()) as { op: string };
          operations.push(request.op);
          if (request.op === 'sync_end') {
            syncing.resolve(); await synchronized.promise;
            await rm(cwd + '.chisa-lease', { recursive: true });
          }
          response.end(JSON.stringify({ ok: true }));
        })().catch(error => { response.statusCode = 500; response.end(JSON.stringify({ error: String(error) })); });
      });
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
      const address = server.address();
      assert.ok(address && typeof address !== 'string');
      await writeFile(path.join(cwd, '.chisa-bridge.json'), JSON.stringify({ protocol: 2, port: address.port, token: 'fixture', bindingEpoch: 'fixture' }));
      scenario = input => {
        child = input.options!.spawnClaudeCodeProcess!({
          command: process.execPath, args: ['-e', "process.stdin.resume();process.stdin.on('data',data=>{if(data.toString().includes('exit'))process.exit(0)})"],
          cwd, env: { ...process.env }, signal: new AbortController().signal,
        } as never) as unknown as import('node:child_process').ChildProcess;
        launched.resolve();
        return Object.assign((async function* () { yield { type: 'system', subtype: 'init', session_id: 'real-process' }; await iteratorClosed.promise; })(), { close: () => iteratorClosed.resolve() });
      };
      let run: Promise<void> | undefined;
      let stop: Promise<boolean> | undefined;
      try {
        run = queryClaudeSDK('fixture', { cwd, sessionId: 'real-process-fixture' }, { send: (frame: NormalizedMessage) => frames.push(frame) }, context);
        await launched.promise;
        let stopConfirmed = false;
        if (stopBeforeExit) {
          stop = abortClaudeSDKSession('real-process-fixture').then(value => { stopConfirmed = value; return value; });
          await new Promise<void>(resolve => setImmediate(resolve));
          assert.equal(stopConfirmed, false);
          assert.equal(frames.some(frame => frame.text === 'model_stopped'), false);
        } else iteratorClosed.resolve();
        const exited = once(child!, 'close');
        child!.stdin!.write('exit\n');
        await exited;
        await syncing.promise;
        if (!stopBeforeExit) stop = abortClaudeSDKSession('real-process-fixture').then(value => { stopConfirmed = value; return value; });
        assert.equal(frames.filter(frame => frame.text === 'model_stopped').length, 1);
        assert.equal(frames.find(frame => frame.text === 'model_stopped')?.canInterrupt, false);
        assert.equal(stopConfirmed, false);
        assert.equal(frames.some(frame => frame.kind === 'complete'), false);
        await assert.rejects(queryClaudeSDK('must not overlap', { cwd, sessionId: 'real-process-fixture' }, { send() {} }, context), { code: 'RUN_IN_PROGRESS' });
        synchronized.resolve();
        assert.equal(await stop, true);
        await run;
        assert.deepEqual(operations, ['sync_begin', 'sync_end', 'sync_released']);
      } finally {
        synchronized.resolve();
        iteratorClosed.resolve();
        if (child && child.exitCode === null) child.kill('SIGKILL');
        await Promise.allSettled([run, stop]);
        server.closeAllConnections();
        await new Promise<void>(resolve => server.close(() => resolve()));
        await rm(cwd + '.chisa-lease', { recursive: true, force: true });
      }
    });
  });
}

test('Claude streams observed main-session versions without rewriting the pinned SDK model', { timeout: 5000 }, async () => {
  await fixture(async (cwd, context, frames) => {
    context.resolveResumeModel = async () => 'claude-opus-5-5';
    scenario = input => {
      assert.equal(input.options?.model, 'claude-opus-5-5');
      void (async () => { for await (const _message of input.prompt as AsyncIterable<unknown>) { /* consume held stdin */ } })();
      return Object.assign((async function* () {
        yield { type: 'system', subtype: 'init', session_id: 'provider-id', model: 'claude-opus-5-5' };
        yield { type: 'assistant', session_id: 'provider-id', message: { model: 'claude-opus-5-5' } };
        yield { type: 'assistant', session_id: 'provider-id', parent_tool_use_id: 'task', message: { model: 'claude-haiku-4-5' } };
        yield { type: 'result', subtype: 'success' };
      })(), { close() {} });
    };
    await queryClaudeSDK('fixture', { cwd, sessionId: 'version-fixture', model: 'claude-opus-5-5' }, { send: (frame: NormalizedMessage) => frames.push(frame) }, context);
    const updates = frames.filter(frame => frame.kind === 'status' && frame.text === 'model_resolved');
    assert.equal(updates.length, 1);
    assert.equal(updates[0].model, 'claude-opus-5-5');
  });
});

test('Claude result stays nonterminal until teardown and permits the next owner at complete', { timeout: 5000 }, async () => {
  await fixture(async (cwd, context, frames) => {
    const finished = gate();
    const result = gate();
    scenario = input => {
      const hold = finished;
      void (async () => { for await (const _message of input.prompt as AsyncIterable<unknown>) { /* consume held stdin */ } })();
      return Object.assign((async function* () { yield { type: 'result', subtype: 'success' }; await hold.promise; })(), { close: () => hold.resolve() });
    };
    let next: Promise<void> | undefined;
    const writer = { send: (frame: NormalizedMessage) => {
      frames.push(frame);
      if (frame.kind === 'status' && frame.text === 'workspace_finalizing') result.resolve();
      if (frame.kind === 'complete' && !next) next = queryClaudeSDK('next', { cwd, sessionId: 'finalize-fixture' }, { send() {} }, context);
    } };
    const first = queryClaudeSDK('first', { cwd, sessionId: 'finalize-fixture' }, writer, context);
    await result.promise;
    assert.equal(frames.some(frame => frame.kind === 'complete'), false);
    finished.resolve();
    await first;
    await next;
    assert.equal(queries, 2);
    assert.equal(frames.filter(frame => frame.kind === 'complete').length, 1);
    assert.equal(frames.find(frame => frame.kind === 'complete')?.exitCode, 0);
  });
});

test('initializing Claude can be stopped before the SDK or model is launched', { timeout: 5000 }, async () => {
  await fixture(async (cwd, context, frames) => {
    const entered = gate();
    const resolved = gate();
    context.resolveResumeModel = async () => { entered.resolve(); await resolved.promise; return 'sonnet'; };
    scenario = () => { throw new Error('SDK must not launch'); };
    const run = queryClaudeSDK('fixture', { cwd, sessionId: 'initializing-fixture' }, { send: (frame: NormalizedMessage) => frames.push(frame) }, context);
    await entered.promise;
    let confirmed = false;
    const stop = abortClaudeSDKSession('initializing-fixture').then(success => { confirmed = success; });
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(confirmed, false);
    resolved.resolve();
    await Promise.all([run, stop]);
    assert.equal(confirmed, true);
    assert.equal(queries, 0);
    assert.equal(frames.some(frame => frame.kind === 'complete'), false);
  });
});

test('true background work retains held stdin after result and releases it after its follow-up', { timeout: 5000 }, async () => {
  await fixture(async (cwd, context, frames) => {
    const background = gate();
    const followup = gate();
    const promptDone = gate();
    let stdinEnded = false;
    scenario = input => {
      void (async () => { for await (const _message of input.prompt as AsyncIterable<unknown>) { /* consume held stdin */ } stdinEnded = true; promptDone.resolve(); })();
      return Object.assign((async function* () {
        yield { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { run_in_background: true } }] } };
        yield { type: 'result', subtype: 'success' };
        await followup.promise;
        yield { type: 'result', subtype: 'success' };
        await promptDone.promise;
      })(), { close: () => promptDone.resolve() });
    };
    const run = queryClaudeSDK('fixture', { cwd, sessionId: 'background-fixture' }, { send: (frame: NormalizedMessage) => {
      frames.push(frame);
      if (frame.text === 'background_work') background.resolve();
    } }, context);
    await background.promise;
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(stdinEnded, false);
    assert.equal(frames.some(frame => frame.kind === 'complete'), false);
    followup.resolve();
    await run;
    assert.equal(stdinEnded, true);
    assert.equal(frames.filter(frame => frame.kind === 'complete').length, 1);
    assert.equal(frames.find(frame => frame.kind === 'complete')?.success, true);
  });
});

for (const failure of [
  { name: 'ordinary turn', background: false, subtype: 'success', is_error: true },
  { name: 'turn with background work', background: true, subtype: 'error_during_execution', is_error: true },
]) {
  test(`SDK error result from ${failure.name} closes stdin and completes as failure only after cleanup`, { timeout: 5000 }, async () => {
    await fixture(async (cwd, context, frames) => {
      const promptDone = gate();
      const cleanupDone = gate();
      scenario = input => {
        void (async () => {
          for await (const _message of input.prompt as AsyncIterable<unknown>) { /* consume held stdin */ }
          promptDone.resolve();
        })();
        return Object.assign((async function* () {
          if (failure.background) {
            yield { type: 'assistant', message: { role: 'assistant', content: [
              { type: 'tool_use', id: 'background-task', name: 'Bash', input: { run_in_background: true } },
            ] } };
          }
          // Simulate the SDK result contract, not a real upstream quota response.
          yield {
            type: 'result', subtype: failure.subtype, is_error: failure.is_error,
            result: 'Usage limit reached', errors: ['Usage limit reached'],
            duration_ms: 1, duration_api_ms: 1, num_turns: 1, stop_reason: null,
            total_cost_usd: 0, usage: { input_tokens: 0, output_tokens: 0 },
            modelUsage: {}, permission_denials: [], uuid: 'error-result', session_id: 'sdk-error-session',
          };
          await promptDone.promise;
          await cleanupDone.promise;
        })(), { close: () => promptDone.resolve() });
      };
      const run = queryClaudeSDK('fixture', { cwd, sessionId: 'sdk-error-fixture' }, {
        send: (frame: NormalizedMessage) => frames.push(frame),
      }, context);
      try {
        await promptDone.promise;
        assert.equal(frames.find(frame => frame.kind === 'error')?.content, 'Usage limit reached');
        assert.equal(frames.some(frame => frame.text === 'background_work'), false);
        assert.equal(frames.filter(frame => frame.kind === 'status').at(-1)?.text, 'workspace_finalizing');
        assert.equal(frames.some(frame => frame.kind === 'complete'), false);
        assert.equal(failedNotifications, 0);
        cleanupDone.resolve();
        await run;
        const terminal = frames.filter(frame => frame.kind === 'complete');
        assert.equal(terminal.length, 1);
        assert.equal(terminal[0]?.exitCode, 1);
        assert.equal(terminal[0]?.success, false);
        assert.equal(failedNotifications, 1);
        assert.equal(stoppedNotifications, 0);
      } finally {
        cleanupDone.resolve();
        await run;
      }
    });
  });
}

test('an SDK assistant quota error remains failed until cleanup and admits same-session resend at its terminal', { timeout: 5000 }, async () => {
  await fixture(async (cwd, context, frames) => {
    const normalizer = new ClaudeSessionsProvider();
    context.normalizeMessage = (raw, sessionId) => normalizer.normalizeMessage(raw, sessionId);
    const promptDone = gate();
    const cleanupDone = gate();
    scenario = input => {
      const first = queries === 1;
      const inputDone = first ? promptDone : gate();
      void (async () => { for await (const _message of input.prompt as AsyncIterable<unknown>) { /* consume real held input */ } inputDone.resolve(); })();
      return Object.assign((async function* () {
        if (first) {
          yield { type: 'assistant', uuid: 'quota-error', parent_tool_use_id: null, error: 'rate_limit', message: { role: 'assistant', content: [{ type: 'text', text: 'Usage limit reached (synthetic SDK contract)' }] } };
        }
        yield { type: 'result', subtype: 'success', is_error: false };
        await inputDone.promise;
        if (first) await cleanupDone.promise;
      })(), { close: () => inputDone.resolve() });
    };
    let next: Promise<void> | undefined;
    const run = queryClaudeSDK('first', { cwd, sessionId: 'assistant-error-resend' }, {
      send: (frame: NormalizedMessage) => {
        frames.push(frame);
        if (frame.kind === 'complete') next = queryClaudeSDK('resend', { cwd, sessionId: 'assistant-error-resend' }, { send() {} }, context);
      },
    }, context);
    try {
      await promptDone.promise;
      assert.equal(frames.some(frame => frame.kind === 'complete'), false);
      assert.equal(frames.find(frame => frame.kind === 'error')?.code, 'rate_limit');
      assert.equal(frames.some(frame => frame.kind === 'text'), false, 'the SDK quota error must not be a normal assistant reply');
      cleanupDone.resolve();
      await run;
      await next;
      assert.equal(queries, 2);
      assert.equal(frames.filter(frame => frame.kind === 'error').length, 1);
      const terminal = frames.filter(frame => frame.kind === 'complete');
      assert.equal(terminal.length, 1);
      assert.equal(terminal[0].exitCode, 1);
      assert.equal(terminal[0].success, false);
      assert.equal(failedNotifications, 1);
    } finally { cleanupDone.resolve(); await run; await next; }
  });
});

test('an SDK rate-limit warning does not turn a successful run into a failure', { timeout: 5000 }, async () => {
  await fixture(async (cwd, context, frames) => {
    const inputDone = gate();
    context.normalizeMessage = (raw, sessionId) => new ClaudeSessionsProvider().normalizeMessage(raw, sessionId);
    scenario = input => {
      void (async () => { for await (const _message of input.prompt as AsyncIterable<unknown>) { /* consume held input */ } inputDone.resolve(); })();
      return Object.assign((async function* () {
        yield { type: 'rate_limit_event', rate_limit_info: { status: 'allowed_warning', utilization: 0.95 } };
        yield { type: 'result', subtype: 'success', is_error: false };
        await inputDone.promise;
      })(), { close: () => inputDone.resolve() });
    };
    await queryClaudeSDK('warning', { cwd, sessionId: 'allowed-warning' }, { send: (frame: NormalizedMessage) => frames.push(frame) }, context);
    assert.equal(frames.some(frame => frame.kind === 'error'), false);
    assert.equal(frames.find(frame => frame.kind === 'complete')?.exitCode, 0);
    assert.equal(failedNotifications, 0);
  });
});
