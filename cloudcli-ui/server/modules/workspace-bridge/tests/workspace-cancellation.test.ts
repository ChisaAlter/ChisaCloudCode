import assert from 'node:assert/strict';
import { spawn as realSpawn } from 'node:child_process';
import * as childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test, { mock } from 'node:test';

import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';

const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), 'chisa-cloud-cancel-'));
process.env.WORKSPACES_ROOT = fixtureRoot;

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

type ServerOptions = Parameters<typeof createSdkMcpServer>[0];
let tools: ServerOptions | undefined;
let queries = 0;
let closed = gate();
let started = gate();
let spawnWorker: (args: string[], options: { signal?: AbortSignal; killSignal?: string | number }) => EventEmitter;
let queryScenario: ((input: Parameters<typeof import('@anthropic-ai/claude-agent-sdk').query>[0]) => unknown) | undefined;
let realChild: ReturnType<typeof realSpawn> | undefined;
// Controlled cloud fixtures have exact protocol-3 markers and a sandbox network,
// but do not restore an account runtime or contact Docker during admission.
mock.module('@/modules/workspace-runtime/index.js', { namedExports: {
  ensureCloudWorkspaceBinding() {}, excludeCloudWorkspaceMetadata() {}, getWorkspaceRuntimeIdentity() { return undefined; },
  executeWorkspaceRuntimePreview() { assert.fail('unexpected preview'); },
} });
mock.module('@anthropic-ai/claude-agent-sdk', {
  namedExports: {
    tool,
    createSdkMcpServer: (options: ServerOptions) => {
      tools = options;
      return createSdkMcpServer(options);
    },
    query: (input: Parameters<typeof import('@anthropic-ai/claude-agent-sdk').query>[0]) => {
      queries++;
      if (queryScenario) return queryScenario(input);
      const completion = closed;
      const stream = (async function* () {
        started.resolve();
        yield { type: 'system', subtype: 'init', session_id: 'fixture' };
        await completion.promise;
      })();
      return Object.assign(stream, { close: () => completion.resolve() });
    },
  },
});
mock.module('node:child_process', {
  namedExports: { ...childProcess, spawn: (command: string, args: string[], options: Parameters<typeof realSpawn>[2]) => {
    if (command === process.execPath) { realChild = realSpawn(command, args, options); return realChild; }
    return spawnWorker(args, options ?? {});
  } },
});
const { admitWorkspaceExecution, workspaceQuery, bridgeFileSystem, bridgeGitFileSystem, withWorkspaceWriteOperation, withWorkspaceGitReadOperation, runWorkspaceCommand, runWorkspaceGitBranchOperation } = await import('@/modules/workspace-bridge/index.js');
const { registerWorkspaceRuntimeNetwork } = await import('@/shared/index.js');
registerWorkspaceRuntimeNetwork(fixtureRoot, 'chisa-workspace-network-' + 'c'.repeat(24), 'cancellation-fixture');
test.after(async () => { assert.equal(path.dirname(fixtureRoot), os.tmpdir()); await rm(fixtureRoot, { recursive: true, force: true }); });

function worker() { return Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), kill() {} }); }
function finish(child: ReturnType<typeof worker>, code = 0, value: Record<string, unknown> = { ok: true, stdout: 'completed', exitCode: 0 }) {
  queueMicrotask(() => { child.stdout.write(JSON.stringify(value)); child.emit('close', code); });
}
async function withWorkspace(run: (cwd: string) => Promise<void>, protocol = 3) {
  const cwd = await mkdtemp(path.join(fixtureRoot, 'project-载货车-%-'));
  const marker = protocol === 3
    ? { protocol, root: cwd, owner: 'cloud-cancellation-fixture', bindingEpoch: 'fixture-epoch' }
    : { protocol, port: 19081, token: 'retired-capability', bindingEpoch: 'fixture-epoch' };
  await writeFile(path.join(cwd, '.chisa-bridge.json'), JSON.stringify(marker));
  queries = 0; queryScenario = undefined; realChild = undefined; tools = undefined;
  closed = gate(); started = gate();
  spawnWorker = args => {
    const child = worker();
    if (args[0] === 'run') child.stdin.once('finish', () => finish(child));
    else finish(child);
    return child;
  };
  try { await run(cwd); }
  finally {
    const child = realChild as ReturnType<typeof realSpawn> | undefined;
    if (child && child.exitCode === null) child.kill('SIGKILL');
    mock.restoreAll();
    for (const target of [cwd, cwd + '.chisa-lease', cwd + '.chisa-worktrees', cwd + '.chisa-state']) {
      assert.equal(path.dirname(target), fixtureRoot); await rm(target, { recursive: true, force: true });
    }
  }
}

for (const owner of ['claude', 'sync-needed']) {
  test(`cloud Git snapshot reads remain read-only while ${owner} owns the workspace`, async () => {
    await withWorkspace(async cwd => {
      await mkdir(cwd + '.chisa-lease');
      const state = JSON.stringify({ owner, id: 'other-owner', epoch: 'fixture-epoch' });
      await writeFile(cwd + '.chisa-lease/state.json', state);
      spawnWorker = args => {
        const child = worker();
        if (args[0] === 'run') {
          assert.ok(args.includes(cwd + ':/workspace:ro'));
          let input = '';
          child.stdin.on('data', chunk => { input += String(chunk); });
          child.stdin.once('finish', () => {
            const request = JSON.parse(input);
            assert.equal(request.readOnly, true);
            assert.ok(request.argv.includes('--no-optional-locks'));
            finish(child, 0, { ok: true, stdout: '* snapshot\n', exitCode: 0 });
          });
        } else finish(child);
        return child;
      };
      await withWorkspaceGitReadOperation(cwd, async () => {
        assert.match((await runWorkspaceCommand(cwd, 'git', ['branch', '-a'], { readOnly: true }))!.stdout!, /snapshot/);
      });
      assert.equal(await readFile(cwd + '.chisa-lease/state.json', 'utf8'), state);
      await assert.rejects(withWorkspaceWriteOperation(cwd, async () => {}), { code: 'WORKSPACE_BUSY' });
    });
  });
}

test('one cloud Git write reservation encloses all commands and blocks unrelated writes', async () => {
  await withWorkspace(async cwd => {
    const work = gate(); const entered = gate(); const leaseIds: string[] = [];
    spawnWorker = args => {
      const child = worker();
      if (args[0] === 'run') {
        leaseIds.push(JSON.parse(readFileSync(cwd + '.chisa-lease/state.json', 'utf8')).id);
        assert.ok(args.includes(cwd + ':/workspace:rw'));
        child.stdin.once('finish', () => finish(child));
      } else finish(child);
      return child;
    };
    const operation = withWorkspaceWriteOperation(cwd, async () => {
      entered.resolve(); await work.promise;
      await runWorkspaceCommand(cwd, 'git', ['status', '--porcelain']);
      await runWorkspaceCommand(cwd, 'git', ['commit', '-m', 'index only']);
    });
    await entered.promise;
    try {
      await assert.rejects(withWorkspaceWriteOperation(cwd, async () => {}), { code: 'WORKSPACE_BUSY' });
      await assert.rejects(bridgeGitFileSystem({} as never).unlink(path.join(cwd, 'file.txt')), { code: 'WORKSPACE_BUSY' });
    } finally { work.resolve(); }
    await operation;
    assert.equal(leaseIds.length, 2); assert.equal(new Set(leaseIds).size, 1);
    assert.equal(existsSync(cwd + '.chisa-lease'), false);
  });
});

test('Claude launch preparation waits for admission, is consumed once and cancellation prevents SDK launch', async () => {
  await withWorkspace(async cwd => {
    const prepared = gate();
    const complete = gate();
    const controller = new AbortController();
    const calls: string[] = [];
    const options = { cwd, abortController: controller, chisaPrepareLaunch: async (actualCwd: string) => {
      assert.equal(existsSync(cwd + '.chisa-lease'), true);
      calls.push(actualCwd); prepared.resolve(); await complete.promise;
    } };
    const query = workspaceQuery({ prompt: 'cancel during preparation', options });
    const next = query.next();
    await prepared.promise;
    assert.equal('chisaPrepareLaunch' in options, false);
    assert.equal(queries, 0);
    controller.abort(); complete.resolve();
    await assert.rejects(next, (error: unknown) => (error as { name: string }).name === 'AbortError');
    assert.deepEqual(calls, [cwd]);
    assert.equal(queries, 0);
    assert.equal(existsSync(cwd + '.chisa-lease'), false);
  });
});

test('cloud stop releases exact ownership and immediately permits another turn', async () => {
  await withWorkspace(async cwd => {
    for (const prompt of ['first', 'second']) {
      closed = gate(); started = gate();
      const query = workspaceQuery({ prompt, options: { cwd } });
      await query.next();
      const next = query.next(); await started.promise;
      assert.equal(existsSync(cwd + '.chisa-lease'), true);
      await query.interrupt(); await next;
      assert.equal(existsSync(cwd + '.chisa-lease'), false);
    }
    assert.equal(queries, 2);
  });
});

test('cloud plan sessions retain an exact lease and reject write tools', async () => {
  await withWorkspace(async cwd => {
    const query = workspaceQuery({ prompt: 'inspect only', options: { cwd, permissionMode: 'plan' } });
    await query.next();
    assert.equal(existsSync(cwd + '.chisa-lease'), true);
    const write = tools!.tools!.find(definition => definition.name === 'write_file')!;
    const result = await write.handler({ path: '/workspace/blocked.txt', content: 'nope', expectedHash: null }, {});
    assert.equal(result.isError, true);
    assert.match(JSON.stringify(result.content), /只读/);
    const next = query.next(); await started.promise;
    await query.interrupt(); await next;
    assert.equal(queries, 1);
    assert.equal(existsSync(cwd + '.chisa-lease'), false);
  });
});

test('stop cancels a running command but retains its lease until container removal is confirmed', async () => {
  await withWorkspace(async cwd => {
    const running = gate(); const removing = gate(); const removed = gate();
    let commandCancelled = false; let stopped = false;
    spawnWorker = (args, options) => {
      const child = worker();
      if (args[0] === 'run') {
        assert.equal(options.killSignal, 'SIGKILL');
        options.signal!.addEventListener('abort', () => {
          commandCancelled = true; child.emit('error', new Error('command aborted')); child.emit('close', 1);
        }, { once: true });
        running.resolve();
      } else {
        assert.equal(args[0], 'rm'); removing.resolve();
        void removed.promise.then(() => child.emit('close', 0));
      }
      return child;
    };
    const query = workspaceQuery({ prompt: 'command', options: { cwd } });
    await query.next(); const next = query.next(); await started.promise;
    const command = tools!.tools!.find(definition => definition.name === 'run_command')!;
    const result = command.handler({ command: 'sleep 600', path: '/workspace', timeoutSeconds: 600, readOnly: false }, {});
    await running.promise;
    const stop = query.interrupt().then(() => { stopped = true; });
    try {
      await removing.promise;
      assert.equal(commandCancelled, true); assert.equal(stopped, false);
      assert.equal(existsSync(cwd + '.chisa-lease'), true);
      await assert.rejects(admitWorkspaceExecution({ cwd }), { code: 'WORKSPACE_BUSY' });
    } finally { removed.resolve(); }
    await stop; await next;
    assert.equal((await result).isError, true);
    assert.equal(existsSync(cwd + '.chisa-lease'), false);
  });
});

for (const readOnly of [true, false]) {
  test(`${readOnly ? 'read-only' : 'write-capable'} cloud commands use the correct mount and mutation state`, async () => {
    await withWorkspace(async cwd => {
      spawnWorker = args => {
        const child = worker();
        if (args[0] === 'run') {
          assert.ok(args.includes(cwd + (readOnly ? ':/workspace:ro' : ':/workspace:rw')));
          child.stdin.once('finish', () => finish(child));
        } else finish(child);
        return child;
      };
      const query = workspaceQuery({ prompt: 'inspect', options: { cwd } });
      await query.next(); const next = query.next(); await started.promise;
      const command = tools!.tools!.find(definition => definition.name === 'run_command')!;
      const response = await command.handler({ command: 'cat README.txt', path: '/workspace', timeoutSeconds: 60, readOnly }, {});
      assert.equal(response.isError, undefined);
      assert.equal(JSON.parse(await readFile(cwd + '.chisa-lease/state.json', 'utf8')).mayWrite, !readOnly);
      await query.interrupt(); await next;
      assert.equal(existsSync(cwd + '.chisa-lease'), false);
    });
  });
}

for (const synchronous of [false, true]) {
  test(`a busy error after SDK launch never becomes an unsent admission; synchronous=${synchronous}`, async () => {
    await withWorkspace(async cwd => {
      const original = Object.assign(new Error('SDK tool was busy after launch'), { code: 'WORKSPACE_BUSY' });
      queryScenario = () => {
        if (synchronous) throw original;
        return Object.assign((async function* () { yield await Promise.reject(original); })(), { close() {} });
      };
      await assert.rejects(workspaceQuery({ prompt: 'launched fixture', options: { cwd } }).next(), (error: unknown) => {
        assert.equal(error, original); assert.equal('workspaceAdmissionRejected' in original, false); return true;
      });
      assert.equal(queries, 1); assert.equal(existsSync(cwd + '.chisa-lease'), false);
    });
  });
}

test('an SDK iterator ending cannot release cloud ownership before its real child exits', { timeout: 5000 }, async () => {
  await withWorkspace(async cwd => {
    queryScenario = input => {
      input.options!.spawnClaudeCodeProcess!({
        command: process.execPath, args: ['-e', 'process.stdin.on("data",()=>process.exit(0));process.stdin.resume()'],
        cwd, env: { PATH: process.env.PATH }, signal: new AbortController().signal,
      });
      return Object.assign((async function* () { yield { type: 'result', subtype: 'success' }; })(), { close() {} });
    };
    const query = workspaceQuery({ prompt: 'fixture', options: { cwd } });
    await query.next(); assert.ok(realChild);
    let completed = false;
    const returned = query.next().then(value => { completed = true; return value; });
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(completed, false); assert.equal(existsSync(cwd + '.chisa-lease'), true);
    realChild.stdin!.write('exit\n'); await returned;
    assert.equal(existsSync(cwd + '.chisa-lease'), false);
  });
});

for (const changedField of ['id', 'epoch', 'owner', 'pid', 'processStartTime', 'bootId'] as const) {
  test(`cloud close cannot release a replaced lease ${changedField}`, async () => {
    await withWorkspace(async cwd => {
      const run = await admitWorkspaceExecution({ cwd, workspaceMode: 'shared' });
      const lease = JSON.parse(await readFile(cwd + '.chisa-lease/state.json', 'utf8'));
      const replacement = { ...lease, [changedField]: changedField === 'pid' ? process.pid + 1 : changedField === 'owner' ? 'pi' : 'replacement' };
      await writeFile(cwd + '.chisa-lease/state.json', JSON.stringify(replacement));
      await assert.rejects(run.close(), { code: ['id', 'epoch', 'owner'].includes(changedField) ? 'WORKSPACE_CLEANUP_FAILED' : 'WORKSPACE_BUSY', workspaceCleanupError: true });
      assert.deepEqual(JSON.parse(await readFile(cwd + '.chisa-lease/state.json', 'utf8')), replacement);
      await assert.rejects(admitWorkspaceExecution({ cwd }), { code: 'WORKSPACE_BUSY' });
    });
  });
}

test('unconfirmed cloud container cleanup persists its exact barrier and prevents completion', async () => {
  await withWorkspace(async cwd => {
    let container = '';
    spawnWorker = args => {
      const child = worker();
      if (args[0] === 'run') {
        container = args[args.indexOf('--name') + 1]!;
        child.stdin.once('finish', () => finish(child));
      } else finish(child, 1);
      return child;
    };
    const query = workspaceQuery({ prompt: 'fixture', options: { cwd } }); await query.next();
    const command = tools!.tools!.find(definition => definition.name === 'run_command')!;
    const response = await command.handler({ command: 'fixture', path: '/workspace', readOnly: false, timeoutSeconds: 60 }, {});
    assert.equal(response.isError, true);
    const lease = JSON.parse(await readFile(cwd + '.chisa-lease/state.json', 'utf8'));
    assert.deepEqual(lease.cleanupPending, [container]); assert.equal(lease.owner, 'sync-needed');
    const pending = assert.rejects(query.next(), { code: 'WORKSPACE_CLEANUP_FAILED' });
    await assert.rejects(query.interrupt(), { code: 'WORKSPACE_CLEANUP_FAILED' }); await pending;
    assert.deepEqual(JSON.parse(await readFile(cwd + '.chisa-lease/state.json', 'utf8')).cleanupPending, [container]);
  });
});

test('corrupt cloud lease reports a recoverable state error', async () => {
  await withWorkspace(async cwd => {
    await mkdir(cwd + '.chisa-lease', { recursive: true }); await writeFile(cwd + '.chisa-lease/state.json', '{broken');
    await assert.rejects(workspaceQuery({ prompt: 'corrupt lease', options: { cwd } }).next(), { code: 'WORKSPACE_LEASE_CORRUPT', statusCode: 503 });
  });
});

test('public admitted execute drains the actual cloud worker before close and forbids borrowed writes', async () => {
  await withWorkspace(async cwd => {
    const running = gate(); const complete = gate();
    spawnWorker = args => {
      const child = worker();
      if (args[0] === 'run') {
        running.resolve(); void complete.promise.then(() => finish(child, 0, { ok: true, stdout: 'actual executor result', exitCode: 0 }));
      } else finish(child);
      return child;
    };
    const run = await admitWorkspaceExecution({ cwd, workspaceMode: 'shared' });
    const execution = run.execute({ op: 'exec', path: '/workspace', argv: ['git', 'status'], readOnly: false }); await running.promise;
    await assert.rejects(bridgeFileSystem({} as never).writeTextFile(path.join(cwd, 'borrowed.txt'), 'no'), { code: 'WORKSPACE_BUSY' });
    let released = false;
    const closing = run.close().then(() => { released = true; });
    try {
      await assert.rejects(run.execute({ op: 'read', path: '/workspace/readme.txt' }), { code: 'WORKSPACE_BUSY' });
      assert.equal(released, false); assert.equal(existsSync(cwd + '.chisa-lease'), true);
    } finally { complete.resolve(); }
    assert.equal((await execution).stdout, 'actual executor result'); await closing;
    assert.equal(existsSync(cwd + '.chisa-lease'), false);
  });
});

test('public admitted execute enforces plan mode and refuses lifecycle/control operations', async () => {
  await withWorkspace(async cwd => {
    const run = await admitWorkspaceExecution({ cwd, workspaceMode: 'shared', readOnly: true });
    await assert.rejects(run.execute({ op: 'exec', argv: ['touch', 'forbidden'], readOnly: false }), { code: 'WORKSPACE_READ_ONLY' });
    await assert.rejects(run.execute({ op: 'sync_end' }), { code: 'INVALID_REQUEST' }); await run.close();
  });
});

test('public admitted streaming process confirms container removal before releasing cloud ownership', async () => {
  await withWorkspace(async cwd => {
    const running = gate(); const removing = gate(); const removed = gate();
    spawnWorker = (args, options) => {
      const child = worker();
      if (args[0] === 'run') {
        assert.ok(args.includes(`type=bind,src=${cwd},dst=${cwd}`));
        options.signal!.addEventListener('abort', () => { child.emit('error', Object.assign(new Error('aborted'), { name: 'AbortError' })); child.emit('close', 1, 'SIGKILL'); }, { once: true });
        running.resolve();
      } else { assert.equal(args[0], 'rm'); removing.resolve(); void removed.promise.then(() => child.emit('close', 0)); }
      return child;
    };
    const run = await admitWorkspaceExecution({ cwd, workspaceMode: 'shared' });
    const child = await run.spawnProcess({ command: 'node', args: ['worker'] }); await running.promise;
    const lease = JSON.parse(await readFile(cwd + '.chisa-lease/state.json', 'utf8')); assert.equal(lease.cleanupPending.length, 1);
    const stopping = child.close(); await removing.promise;
    let completed = false; const closing = run.close().then(() => { completed = true; });
    assert.equal(existsSync(cwd + '.chisa-lease'), true); assert.equal(completed, false);
    removed.resolve(); await stopping; await closing;
    assert.equal(existsSync(cwd + '.chisa-lease'), false);
  });
});

test('retired protocol-1 metadata and chat remain offline but file, command and branch execution are removed', async () => {
  await withWorkspace(async cwd => {
    spawnWorker = () => { assert.fail('retired local operations must never start Docker'); };
    const query = workspaceQuery({ prompt: 'offline chat', options: { cwd } }); await query.next();
    assert.equal(queries, 1); assert.equal(existsSync(cwd + '.chisa-lease'), false);
    const read = tools!.tools!.find(definition => definition.name === 'read_file')!;
    const result = await read.handler({ path: '/workspace/file.txt', encoding: 'utf8' }, {});
    assert.equal(result.isError, true); assert.match(JSON.stringify(result.content), /removed/i);
    await assert.rejects(bridgeFileSystem({} as never).readTextFile(path.join(cwd, 'file.txt')), { code: 'LOCAL_WORKSPACE_REMOVED' });
    await query.interrupt();
    await assert.rejects(runWorkspaceCommand(cwd, 'git', ['status']), { code: 'LOCAL_WORKSPACE_REMOVED' });
    await assert.rejects(runWorkspaceGitBranchOperation(cwd, 'create', 'old-local'), { code: 'LOCAL_WORKSPACE_REMOVED' });
  }, 1);
});
