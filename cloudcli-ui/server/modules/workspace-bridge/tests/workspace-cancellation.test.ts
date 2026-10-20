import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn as realSpawn } from 'node:child_process';
import * as childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, request as httpRequest } from 'node:http';
import type { IncomingMessage } from 'node:http';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test, { mock } from 'node:test';

import express from 'express';
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';

import { AppError, WORKSPACES_ROOT } from '@/shared/index.js';
import type { FileTreeFileSystem } from '@/shared/index.js';

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
const { workspaceQuery, workspaceRequestScope, bridgeFileSystem, bridgeGitFileSystem, withWorkspaceWriteOperation, withWorkspaceGitReadOperation, runWorkspaceCommand, runWorkspaceGitBranchOperation, withWorkspaceMutation, executeSyncTransportWorker, prepareSyncTransportPreview, isWorkspaceBindingRoot } = await import('@/modules/workspace-bridge/index.js');
const { registerWorkspaceSyncRecoveryTransport } = await import('@/shared/index.js');

type ControlFixture = {
  marker: Record<string, unknown>;
  handle: (request: Record<string, unknown>, incoming: IncomingMessage) => Response | Promise<Response>;
  close: () => Promise<void>;
};

async function withWorkspace(run: (cwd: string, bridge: ControlFixture) => Promise<void>, protocol = 2) {
  await mkdir(WORKSPACES_ROOT, { recursive: true });
  const cwd = await mkdtemp(path.join(path.resolve(WORKSPACES_ROOT), '.chisa-cancel-qa-\u8f7d\u8d27\u8f66-%-'));
  let fixtureError: unknown;
  const bridge: ControlFixture = {
    marker: {},
    handle: () => new Response(JSON.stringify({ ok: true })),
    close: async () => {
      if (!server.listening) return;
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    },
  };
  // Exercise the real loopback transport without starting Claude or a container.
  const server = createServer((incoming, outgoing) => {
    void (async () => {
      assert.equal(incoming.method, 'POST');
      assert.equal(incoming.url, '/workspace/rpc');
      const chunks: Buffer[] = [];
      for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
      const request = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
      let reply = await bridge.handle(request, incoming);
      if (request.op === 'sync_end' && reply.ok && !(await reply.clone().json() as { error?: string }).error) {
        // The native sync_end owns compare-and-release; this local control
        // fixture models that contract without SSH or a real sync process.
        const root = Buffer.from(String(incoming.headers['x-cwd']), 'latin1').toString('utf8');
        const directory = root + '.chisa-lease';
        const current = JSON.parse(readFileSync(path.join(directory, 'state.json'), 'utf8'));
        if (current.id !== request.runId || current.epoch !== incoming.headers['x-binding-epoch'] ||
          current.owner !== 'sync-needed' || current.cleanupPending?.length || existsSync(path.join(directory, 'sync-job.json'))) {
          reply = Response.json({ code: 'WORKSPACE_CLEANUP_FAILED', error: 'Atomic handback refused an active or changed reservation' }, { status: 409 });
        } else await rm(directory, { recursive: true });
      }
      outgoing.writeHead(reply.status, { ...Object.fromEntries(reply.headers), 'Content-Type': 'application/json' });
      outgoing.end(Buffer.from(await reply.arrayBuffer()));
    })().catch(error => {
      fixtureError = error;
      outgoing.statusCode = 500;
      outgoing.end(JSON.stringify({ error: 'HTTP fixture failed' }));
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  bridge.marker = {
    protocol, port: address.port, token: 'fixture', bindingEpoch: 'fixture-epoch',
  };
  await writeFile(path.join(cwd, '.chisa-bridge.json'), JSON.stringify(bridge.marker));
  queries = 0;
  queryScenario = undefined;
  realChild = undefined;
  closed = gate();
  started = gate();
  try {
    await run(cwd, bridge);
    if (fixtureError) throw fixtureError;
  } catch (error) {
    if (fixtureError && fixtureError !== error) throw new AggregateError([fixtureError, error], 'Control fixture and caller assertions failed');
    throw error;
  }
  finally {
    const child = realChild as ReturnType<typeof realSpawn> | undefined;
    if (child && child.exitCode === null) child.kill('SIGKILL');
    mock.restoreAll();
    server.closeAllConnections();
    await bridge.close();
    assert.equal(path.dirname(cwd), path.resolve(WORKSPACES_ROOT));
    assert.equal(path.dirname(cwd + '.chisa-lease'), path.resolve(WORKSPACES_ROOT));
    await rm(cwd, { recursive: true, force: true });
    await rm(cwd + '.chisa-lease', { recursive: true, force: true });
  }
}

test('stop waits for synchronization and immediately permits another turn', async () => {
  await withWorkspace(async (cwd, bridge) => {
    const syncing = gate();
    const synchronized = gate();
    const operations: string[] = [];
    bridge.handle = async request => {
      operations.push(String(request.op));
      if (request.op === 'sync_end' && operations.length === 2) {
        syncing.resolve();
        await synchronized.promise;
      }
      return new Response(JSON.stringify({ ok: true }));
    };
    const first = workspaceQuery({ prompt: 'first', options: { cwd } });
    await first.next();
    const firstNext = first.next();
    await started.promise;
    let stopped = false;
    const stop = first.interrupt().then(() => { stopped = true; });
    await syncing.promise;
    assert.equal(stopped, false);
    assert.equal(JSON.parse(readFileSync(cwd + '.chisa-lease/state.json', 'utf8')).owner, 'sync-needed');
    synchronized.resolve();
    await stop;
    await firstNext;
    assert.equal(existsSync(cwd + '.chisa-lease'), false);

    closed = gate();
    started = gate();
    const second = workspaceQuery({ prompt: 'second', options: { cwd } });
    await second.next();
    const secondNext = second.next();
    await started.promise;
    await second.interrupt();
    await secondNext;
    assert.equal(queries, 2);
    assert.deepEqual(operations, ['sync_begin', 'sync_end', 'sync_released', 'sync_begin', 'sync_end', 'sync_released']);
  });
});

test('stop during sync_begin never launches Claude and still releases the lease', async () => {
  await withWorkspace(async (cwd, bridge) => {
    const syncing = gate();
    const synchronized = gate();
    const operations: string[] = [];
    bridge.handle = async request => {
      operations.push(String(request.op));
      if (request.op === 'sync_begin') { syncing.resolve(); await synchronized.promise; }
      return new Response(JSON.stringify({ ok: true }));
    };
    const query = workspaceQuery({ prompt: 'first', options: { cwd } });
    const next = assert.rejects(query.next(), { name: 'AbortError' });
    await syncing.promise;
    const stop = query.interrupt();
    synchronized.resolve();
    await stop;
    await next;
    assert.equal(queries, 0);
    assert.deepEqual(operations, ['sync_begin', 'sync_end', 'sync_released']);
    assert.equal(existsSync(cwd + '.chisa-lease'), false);
  });
});

test('stop cancels a running command and waits for container removal before sync_end', async () => {
  await withWorkspace(async (cwd, bridge) => {
    const running = gate();
    const removing = gate();
    const removed = gate();
    let commandCancelled = false;
    let syncEnded = false;
    spawnWorker = (args, options) => {
      const child = Object.assign(new EventEmitter(), {
        stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), kill() {},
      });
      if (args[0] === 'run') {
        assert.equal(options.killSignal, 'SIGKILL');
        options.signal!.addEventListener('abort', () => {
          commandCancelled = true;
          child.emit('error', new Error('command aborted'));
          child.emit('close', 1);
        }, { once: true });
        running.resolve();
      } else {
        assert.equal(args[0], 'rm');
        removing.resolve();
        void removed.promise.then(() => child.emit('close', 0));
      }
      return child;
    };
    bridge.handle = async request => {
      if (request.op === 'sync_end') {
        assert.equal(request.changed, true);
        syncEnded = true;
      }
      return new Response(JSON.stringify({ ok: true }));
    };
    const query = workspaceQuery({ prompt: 'command', options: { cwd } });
    await query.next();
    const next = query.next();
    await started.promise;
    const command = tools!.tools!.find(definition => definition.name === 'run_command')!;
    const result = command.handler({ command: 'sleep 600', path: '/workspace', timeoutSeconds: 600, readOnly: false }, {});
    await running.promise;
    const stop = query.interrupt();
    await removing.promise;
    assert.equal(commandCancelled, true);
    assert.equal(syncEnded, false);
    assert.equal(existsSync(cwd + '.chisa-lease'), true);
    removed.resolve();
    await stop;
    await next;
    assert.equal((await result).isError, true);
    assert.equal(syncEnded, true);
    assert.equal(existsSync(cwd + '.chisa-lease'), false);
  });
});

for (const readOnly of [true, false]) {
  test(`${readOnly ? 'read-only' : 'write-capable'} commands report the correct return-sync requirement`, async () => {
    await withWorkspace(async (cwd, bridge) => {
      let changed: boolean | undefined;
      spawnWorker = (args) => {
        const child = Object.assign(new EventEmitter(), {
          stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), kill() {},
        });
        if (args[0] === 'run') {
          assert.ok(args.includes(cwd + (readOnly ? ':/workspace:ro' : ':/workspace:rw')));
          child.stdin.once('finish', () => queueMicrotask(() => {
            child.stdout.write(JSON.stringify({ ok: true, stdout: 'OK', exitCode: 0 }));
            child.emit('close', 0);
          }));
        } else queueMicrotask(() => child.emit('close', 0));
        return child;
      };
      bridge.handle = async request => {
        if (request.op === 'sync_end') changed = Boolean(request.changed);
        return new Response(JSON.stringify({ ok: true }));
      };
      const query = workspaceQuery({ prompt: 'inspect', options: { cwd } });
      await query.next();
      const next = query.next();
      await started.promise;
      const command = tools!.tools!.find(definition => definition.name === 'run_command')!;
      const response = await command.handler({ command: 'cat README.txt', path: '/workspace', timeoutSeconds: 60, readOnly }, {});
      assert.equal(response.isError, undefined);
      await query.interrupt();
      await next;
      assert.equal(changed, !readOnly);
      assert.equal(existsSync(cwd + '.chisa-lease'), false);
    });
  });
}

test('failed synchronization keeps the barrier and rejects stop', async () => {
  await withWorkspace(async (cwd, bridge) => {
    bridge.handle = async request => {
      return request.op === 'sync_end'
        ? new Response(JSON.stringify({ error: 'sync conflict', code: 'SYNC_BLOCKED' }), { status: 409 })
        : new Response(JSON.stringify({ ok: true }));
    };
    const query = workspaceQuery({ prompt: 'first', options: { cwd } });
    await query.next();
    const next = assert.rejects(query.next(), { code: 'SYNC_BLOCKED' });
    await started.promise;
    await assert.rejects(query.interrupt(), { code: 'SYNC_BLOCKED' });
    await next;
    assert.equal(JSON.parse(readFileSync(cwd + '.chisa-lease/state.json', 'utf8')).owner, 'sync-needed');
  });
});

test('failed preparation requests full recovery instead of the read-only resume path', async () => {
  await withWorkspace(async (cwd, bridge) => {
    let recovered = false;
    bridge.handle = async request => {
      if (request.op === 'sync_begin') return new Response(JSON.stringify({ error: 'conflict', code: 'SYNC_BLOCKED' }), { status: 409 });
      if (request.op === 'sync_released') {
        assert.equal(existsSync(cwd + '.chisa-lease'), false);
        return Response.json({ ok: true });
      }
      assert.equal(request.op, 'sync_end');
      assert.equal(request.changed, true);
      recovered = true;
      return new Response(JSON.stringify({ ok: true }));
    };
    const query = workspaceQuery({ prompt: 'inspect', options: { cwd } });
    await assert.rejects(query.next(), { code: 'SYNC_BLOCKED' });
    assert.equal(queries, 0);
    assert.equal(recovered, true);
  });
});

test('real HTTP preserves UTF-8 workspace bytes and capability headers while enforcing business errors', async () => {
  await withWorkspace(async (cwd, bridge) => {
    const operations: string[] = [];
    bridge.handle = (request, incoming) => {
      assert.equal(Buffer.from(String(incoming.headers['x-cwd']), 'latin1').toString('utf8'), cwd);
      assert.equal(incoming.headers['x-bridge-token'], 'fixture');
      assert.equal(incoming.headers['x-binding-epoch'], 'fixture-epoch');
      assert.equal(incoming.headers['content-type'], 'application/json');
      assert.equal(Number(incoming.headers['content-length']), Buffer.byteLength(JSON.stringify(request)));
      operations.push(String(request.op));
      if (request.op === 'sync_begin') {
        return new Response(JSON.stringify({ error: 'Binding changed', code: 'WORKSPACE_UNAVAILABLE' }), { status: 409 });
      }
      if (request.op === 'sync_released') {
        assert.equal(existsSync(cwd + '.chisa-lease'), false);
        return Response.json({ ok: true });
      }
      assert.equal(request.op, 'sync_end');
      assert.equal(request.changed, true);
      return new Response(JSON.stringify({ ok: true }));
    };
    const query = workspaceQuery({ prompt: 'private task must not start', options: { cwd } });
    await assert.rejects(query.next(), (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, 'WORKSPACE_UNAVAILABLE');
      assert.equal(error.statusCode, 409);
      assert.equal(error.message, 'Project synchronization is blocked. Check synchronization details in the client settings.');
      return true;
    });
    assert.equal(queries, 0);
    assert.deepEqual(operations, ['sync_begin', 'sync_end', 'sync_released']);
    assert.equal(existsSync(cwd + '.chisa-lease'), false);
  });
});

test('a refused return-synchronization connection retains the lease and cannot replay completed work', async () => {
  await withWorkspace(async (cwd, bridge) => {
    const operations: string[] = [];
    bridge.handle = request => {
      operations.push(String(request.op));
      // Do not reuse a half-closed keepalive socket when the listener disappears.
      return new Response(JSON.stringify({ ok: true }), { headers: { Connection: 'close' } });
    };
    const diagnostics = mock.method(console, 'error', () => {});
    const query = workspaceQuery({ prompt: 'private already completed task', options: { cwd } });
    await query.next();
    const next = assert.rejects(query.next(), { code: 'WORKSPACE_UNAVAILABLE' });
    await started.promise;
    await bridge.close();
    await assert.rejects(query.interrupt(), (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, 'WORKSPACE_UNAVAILABLE');
      assert.equal(error.statusCode, 503);
      assert.match(error.message, /confirmation was not received/);
      assert.match(error.message, /Do not resend completed work/);
      const details = error.details as Record<string, unknown>;
      assert.equal(details.operation, 'sync_end');
      assert.equal(details.transportCode, 'ECONNREFUSED');
      assert.equal(details.timedOut, false);
      assert.equal(typeof details.elapsedMs, 'number');
      assert.deepEqual(Object.keys(details).sort(), ['elapsedMs', 'errorName', 'operation', 'timedOut', 'transportCode']);
      assert.ok(!JSON.stringify(details).includes(cwd));
      assert.doesNotMatch(JSON.stringify(details), /fixture|private already completed task/);
      return true;
    });
    await next;
    assert.equal(diagnostics.mock.callCount(), 1);
    assert.equal(diagnostics.mock.calls[0].arguments[0], '[workspace-control]');
    assert.deepEqual(operations, ['sync_begin']);
    assert.equal(JSON.parse(readFileSync(cwd + '.chisa-lease/state.json', 'utf8')).owner, 'sync-needed');

    const second = workspaceQuery({ prompt: 'do not replay the completed task', options: { cwd } });
    await assert.rejects(second.next(), { code: 'WORKSPACE_BUSY' });
    assert.equal(queries, 1);
    assert.equal(diagnostics.mock.callCount(), 1);
  });
});

test('an SDK iterator ending cannot release the workspace before its real child exits', { timeout: 5000 }, async () => {
  await withWorkspace(async (cwd, bridge) => {
    const operations: string[] = [];
    bridge.handle = request => { operations.push(String(request.op)); return Response.json({ ok: true }); };
    queryScenario = input => {
      input.options!.spawnClaudeCodeProcess!({
        command: process.execPath, args: ['-e', 'process.stdin.on("data",()=>process.exit(0));process.stdin.resume()'],
        cwd, env: { PATH: process.env.PATH }, signal: new AbortController().signal,
      });
      return Object.assign((async function* () { yield { type: 'result', subtype: 'success' }; })(), { close() {} });
    };
    const query = workspaceQuery({ prompt: 'fixture', options: { cwd } });
    await query.next();
    assert.ok(realChild);
    const returned = query.next();
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.deepEqual(operations, ['sync_begin']);
    assert.equal(existsSync(cwd + '.chisa-lease'), true);
    realChild.stdin!.write('exit\n');
    await returned;
    assert.deepEqual(operations, ['sync_begin', 'sync_end', 'sync_released']);
    assert.equal(existsSync(cwd + '.chisa-lease'), false);
  });
});

for (const notificationFails of [false, true]) {
  test(`released ownership is notified once after lease removal; failure=${notificationFails}`, async () => {
    await withWorkspace(async (cwd, bridge) => {
      const operations: string[] = [];
      let runId: unknown;
      const diagnostics = mock.method(console, 'error', () => {});
      bridge.handle = (request, incoming) => {
        operations.push(String(request.op));
        assert.equal(incoming.headers['x-bridge-token'], bridge.marker.token);
        assert.equal(incoming.headers['x-binding-epoch'], bridge.marker.bindingEpoch);
        if (request.op === 'sync_begin') runId = request.runId;
        assert.equal(request.runId, runId);
        if (request.op === 'sync_released') {
          assert.equal(existsSync(cwd + '.chisa-lease'), false);
          return notificationFails
            ? Response.json({ error: 'private fixture notification error', code: 'NOTIFICATION_FAILED' }, { status: 503 })
            : Response.json({ ok: true });
        }
        assert.equal(existsSync(cwd + '.chisa-lease'), true);
        return Response.json({ ok: true });
      };
      const query = workspaceQuery({ prompt: 'completed private fixture', options: { cwd } });
      await query.next();
      const completing = query.next();
      closed.resolve();
      assert.equal((await completing).done, true);
      assert.equal(queries, 1);
      assert.equal(typeof runId, 'string');
      assert.equal(existsSync(cwd + '.chisa-lease'), false);
      assert.deepEqual(operations, ['sync_begin', 'sync_end', 'sync_released']);
      assert.equal(diagnostics.mock.callCount(), notificationFails ? 1 : 0);
      if (notificationFails) {
        const [tag, details] = diagnostics.mock.calls[0].arguments;
        assert.equal(tag, '[workspace-release-notification]');
        assert.deepEqual(details, { errorName: 'AppError', code: 'NOTIFICATION_FAILED' });
        assert.deepEqual(Object.keys(details as object).sort(), ['code', 'errorName']);
        assert.ok(!JSON.stringify(details).includes(cwd));
        assert.doesNotMatch(JSON.stringify(details), /fixture|completed private/);
      }
    });
  });
}

test('preparation and cleanup failure retain the primary code and both error causes', async () => {
  await withWorkspace(async (cwd, bridge) => {
    bridge.handle = request => Response.json({ error: String(request.op), code: request.op === 'sync_begin' ? 'PREPARATION_FAILED' : 'RETURN_FAILED' }, { status: 409 });
    await assert.rejects(workspaceQuery({ prompt: 'fixture', options: { cwd } }).next(), (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, 'PREPARATION_FAILED');
      const causes = error as AppError & { cause: AppError; cleanupError: AppError };
      assert.equal(causes.cause.code, 'PREPARATION_FAILED');
      assert.equal(causes.cleanupError.code, 'RETURN_FAILED');
      return true;
    });
    assert.equal(queries, 0);
    assert.equal(JSON.parse(readFileSync(cwd + '.chisa-lease/state.json', 'utf8')).owner, 'sync-needed');
  });
});

test('iterator return cannot swallow a failed workspace cleanup', async () => {
  await withWorkspace(async (cwd, bridge) => {
    bridge.handle = request => request.op === 'sync_end'
      ? Response.json({ error: 'return failed', code: 'RETURN_FAILED' }, { status: 409 })
      : Response.json({ ok: true });
    const query = workspaceQuery({ prompt: 'fixture', options: { cwd } });
    await query.next();
    await assert.rejects(query.return(undefined), (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, 'RETURN_FAILED');
      assert.equal((error as AppError & { workspaceCleanupError: boolean }).workspaceCleanupError, true);
      return true;
    });
    assert.equal(JSON.parse(readFileSync(cwd + '.chisa-lease/state.json', 'utf8')).owner, 'sync-needed');
  });
});

for (const markerAt of ['before', 'during'] as const) {
  test(`remote job marker ${markerAt} sync_end prevents deleting the lease`, async () => {
    await withWorkspace(async (cwd, bridge) => {
      let ended = false;
      bridge.handle = async request => {
        if (request.op === 'sync_end') {
          ended = true;
          if (markerAt === 'during') await writeFile(cwd + '.chisa-lease/sync-job.json', '{}');
        }
        return Response.json({ ok: true });
      };
      const query = workspaceQuery({ prompt: 'fixture', options: { cwd } });
      await query.next();
      if (markerAt === 'before') await writeFile(cwd + '.chisa-lease/sync-job.json', '{}');
      const pending = assert.rejects(query.next(), { code: 'WORKSPACE_CLEANUP_FAILED' });
      await assert.rejects(query.interrupt(), { code: 'WORKSPACE_CLEANUP_FAILED' });
      await pending;
      assert.equal(ended, markerAt === 'during');
      assert.equal(existsSync(cwd + '.chisa-lease/sync-job.json'), true);
    });
  });
}

test('Docker cleanup failure persists the exact container barrier and refuses sync_end', async () => {
  await withWorkspace(async (cwd, bridge) => {
    let container = '';
    let ended = false;
    spawnWorker = args => {
      const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), kill() {} });
      queueMicrotask(() => {
        if (args[0] === 'run') {
          container = args[args.indexOf('--name') + 1]!;
          child.stdout.write(JSON.stringify({ ok: true, stdout: 'completed', exitCode: 0 }));
          child.emit('close', 0);
        } else child.emit('close', 1);
      });
      return child;
    };
    bridge.handle = request => { if (request.op === 'sync_end') ended = true; return Response.json({ ok: true }); };
    const query = workspaceQuery({ prompt: 'fixture', options: { cwd } });
    await query.next();
    const command = tools!.tools!.find(definition => definition.name === 'run_command')!;
    const response = await command.handler({ command: 'fixture', path: '/workspace', readOnly: false, timeoutSeconds: 60 }, {});
    assert.equal(response.isError, true);
    const lease = JSON.parse(readFileSync(cwd + '.chisa-lease/state.json', 'utf8'));
    assert.deepEqual(lease.cleanupPending, [container]);
    assert.equal(lease.owner, 'sync-needed');
    const pending = assert.rejects(query.next(), { code: 'WORKSPACE_CLEANUP_FAILED' });
    await assert.rejects(query.interrupt(), { code: 'WORKSPACE_CLEANUP_FAILED' });
    await pending;
    assert.equal(ended, false);
    assert.equal(existsSync(cwd + '.chisa-lease'), true);
  });
});

test('same-identity transport reconnect refreshes the port but never a changed token', async () => {
  await withWorkspace(async (cwd, bridge) => {
    await writeFile(path.join(cwd, '.chisa-bridge.json'), JSON.stringify({ ...bridge.marker, protocol: 1 }));
    workspaceQuery({ prompt: 'fixture', options: { cwd } });
    let requests = 0;
    const replacement = createServer(async (incoming, outgoing) => {
      for await (const _chunk of incoming) { /* consume the fixture request */ }
      requests++;
      outgoing.end(JSON.stringify({ b64: Buffer.from('new-port').toString('base64'), hash: 'hash' }));
    });
    await new Promise<void>(resolve => replacement.listen(0, '127.0.0.1', resolve));
    const address = replacement.address();
    assert.ok(address && typeof address !== 'string');
    try {
      await writeFile(path.join(cwd, '.chisa-bridge.json'), JSON.stringify({ ...bridge.marker, protocol: 1, port: address.port }));
      const read = tools!.tools!.find(definition => definition.name === 'read_file')!;
      const response = await read.handler({ path: '/workspace/file', encoding: 'utf8' }, {});
      assert.equal(response.isError, undefined);
      assert.equal(requests, 1);
      await writeFile(path.join(cwd, '.chisa-bridge.json'), JSON.stringify({ ...bridge.marker, protocol: 1, port: address.port, token: 'other' }));
      assert.equal((await read.handler({ path: '/workspace/file', encoding: 'utf8' }, {})).isError, true);
      assert.equal(requests, 1);
    } finally {
      replacement.closeAllConnections();
      await new Promise<void>(resolve => replacement.close(() => resolve()));
    }
  });
});

test('real HTTP disconnect cancels only its scoped read batch and preserves its deadline', { timeout: 5000 }, async () => {
  await withWorkspace(async (cwd, bridge) => {
    await writeFile(path.join(cwd, '.chisa-bridge.json'), JSON.stringify({ ...bridge.marker, protocol: 1, readBatch: true }));
    const fileSystem = bridgeFileSystem({} as FileTreeFileSystem);
    const entered = gate();
    const begin = gate();
    const cancelledControl = gate();
    const finishedCancelled = gate();
    const failed: unknown[] = [];
    const batches: string[][] = [];
    const deadline = Date.now() + 4000;
    bridge.handle = async (request, incoming) => {
      const paths = (request.requests as Array<{ path: string }>).map(item => item.path);
      batches.push(paths);
      assert.ok(paths.every(candidate => candidate.startsWith(paths[0]!.startsWith('/workspace/cancel') ? '/workspace/cancel' : '/workspace/keep')));
      assert.equal(Number(incoming.headers['x-chisa-deadline-ms']), deadline);
      if (paths[0]!.startsWith('/workspace/cancel')) {
        cancelledControl.resolve();
        await new Promise<void>(resolve => incoming.socket.once('close', () => resolve()));
      }
      return Response.json({ results: paths.map(() => ({ size: 1, mtime: 1, mode: 0o644, dir: false, symlink: false })) });
    };
    const app = express();
    app.use(workspaceRequestScope);
    let arrivals = 0;
    app.get('/:scope', async (request, response) => {
      if (++arrivals === 2) entered.resolve();
      await begin.promise;
      try {
        await Promise.all([0, 1].map(index => fileSystem.stat(path.join(cwd, `${request.params.scope}-${index}`))));
        response.json({ ok: true });
      } catch (error) {
        failed.push(error);
        if (!response.destroyed) response.status(499).end();
      } finally { if (request.params.scope === 'cancel') finishedCancelled.resolve(); }
    });
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>(resolve => server.once('listening', resolve));
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const cancelled = httpRequest({ hostname: '127.0.0.1', port: address.port, path: '/cancel', headers: { 'X-Chisa-Deadline-Ms': String(deadline) } });
    cancelled.on('error', () => {});
    cancelled.end();
    const kept = fetch(`http://127.0.0.1:${address.port}/keep`, { headers: { 'X-Chisa-Deadline-Ms': String(deadline) } });
    try {
      await entered.promise;
      begin.resolve();
      await cancelledControl.promise;
      cancelled.destroy();
      assert.deepEqual(await (await kept).json(), { ok: true });
      await finishedCancelled.promise;
      assert.equal(batches.length, 2);
      assert.equal(failed.length, 1);
      assert.equal((failed[0] as AppError).code, 'WORKSPACE_REQUEST_CANCELLED');
    } finally {
      cancelled.destroy();
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
});

for (const cancellation of ['disconnect', 'deadline'] as const) {
test(`HTTP ${cancellation} during write preparation never starts a worker or writes the file`, { timeout: 5000 }, async () => {
  await withWorkspace(async (cwd, bridge) => {
    const target = path.join(cwd, 'document.txt');
    await writeFile(target, 'unchanged');
    const beginning = gate();
    const finished = gate();
    const operations: string[] = [];
    let failure: unknown;
    let spawned = false;
    spawnWorker = () => { spawned = true; throw new Error('cancelled write must not start Docker'); };
    bridge.handle = async (request, incoming) => {
      operations.push(String(request.op));
      if (request.op === 'sync_begin') {
        beginning.resolve();
        await new Promise<void>(resolve => incoming.socket.once('close', () => resolve()));
      }
      return Response.json({ ok: true });
    };
    const fileSystem = bridgeFileSystem({} as FileTreeFileSystem);
    const app = express();
    app.use(workspaceRequestScope);
    app.post('/write', async (_request, response) => {
      try { await fileSystem.writeTextSnapshot!(target, 'must not be written', 'original-hash'); response.json({ ok: true }); }
      catch (error) { failure = error; if (!response.destroyed) response.status(499).end(); }
      finally { finished.resolve(); }
    });
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>(resolve => server.once('listening', resolve));
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const client = httpRequest({ hostname: '127.0.0.1', port: address.port, path: '/write', method: 'POST',
      headers: cancellation === 'deadline' ? { 'X-Chisa-Deadline-Ms': String(Date.now() + 200) } : {},
    });
    client.on('error', () => {});
    client.on('response', response => response.resume());
    client.end();
    try {
      await beginning.promise;
      if (cancellation === 'disconnect') client.destroy();
      await finished.promise;
      assert.equal((failure as AppError).code, 'WORKSPACE_REQUEST_CANCELLED');
      assert.equal(spawned, false);
      assert.equal(readFileSync(target, 'utf8'), 'unchanged');
      assert.deepEqual(operations, ['sync_begin', 'sync_end', 'sync_released']);
      assert.equal(existsSync(cwd + '.chisa-lease'), false);
    } finally {
      client.destroy();
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
});
}

async function withSecondWorkspace(bridge: ControlFixture, run: (second: string) => Promise<void>): Promise<void> {
  const second = await mkdtemp(path.join(path.resolve(WORKSPACES_ROOT), '.chisa-second-transaction-'));
  await writeFile(path.join(second, '.chisa-bridge.json'), JSON.stringify(bridge.marker));
  try { await run(second); }
  finally {
    await rm(second + '.chisa-lease', { recursive: true, force: true });
    await rm(second, { recursive: true, force: true });
  }
}

test('whole workspace mutations acquire all distinct roots in fixed order and serialize reversed callers', { timeout: 5000 }, async () => {
  await withWorkspace(async (first, bridge) => withSecondWorkspace(bridge, async second => {
    const entered = gate();
    const release = gate();
    const operations: Array<{ op: string; root: string }> = [];
    bridge.handle = (request, incoming) => {
      operations.push({ op: String(request.op), root: Buffer.from(String(incoming.headers['x-cwd']), 'latin1').toString('utf8') });
      return Response.json({ ok: true });
    };
    const ordered = [first, second].sort((left, right) => left.localeCompare(right));
    const run = withWorkspaceMutation([second, first, first], async () => {
      for (const root of ordered) {
        const lease = JSON.parse(readFileSync(root + '.chisa-lease/state.json', 'utf8'));
        assert.equal(lease.owner, 'claude');
        assert.equal(lease.mayWrite, true);
      }
      await assert.rejects(workspaceQuery({ prompt: 'cannot overlap the host transaction', options: { cwd: second } }).next(), { code: 'WORKSPACE_BUSY' });
      entered.resolve();
      await release.promise;
      return 'first';
    });
    await entered.promise;
    let secondEntered = false;
    const next = withWorkspaceMutation([first, second], async () => { secondEntered = true; return 'second'; });
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(secondEntered, false);
    assert.deepEqual(operations.filter(item => item.op === 'sync_begin').map(item => item.root), ordered);
    release.resolve();
    assert.deepEqual(await Promise.all([run, next]), ['first', 'second']);
    assert.equal(operations.filter(item => item.op === 'sync_begin').length, 4);
    assert.equal(operations.filter(item => item.op === 'sync_end').length, 4);
    for (const root of ordered) assert.equal(existsSync(root + '.chisa-lease'), false);
  }));
});

test('a busy second root releases the earlier claim without starting the host transaction', { timeout: 5000 }, async () => {
  await withWorkspace(async (first, bridge) => withSecondWorkspace(bridge, async second => {
    const ordered = [first, second].sort((left, right) => left.localeCompare(right));
    const occupied = ordered[1];
    await mkdir(occupied + '.chisa-lease');
    const foreign = { owner: 'pi', id: 'active-other-owner', epoch: 'fixture-epoch' };
    await writeFile(path.join(occupied + '.chisa-lease', 'state.json'), JSON.stringify(foreign));
    let entered = false;
    await assert.rejects(withWorkspaceMutation([second, first], async () => { entered = true; }), { code: 'WORKSPACE_BUSY' });
    assert.equal(entered, false);
    assert.equal(existsSync(ordered[0] + '.chisa-lease'), false);
    assert.deepEqual(JSON.parse(readFileSync(path.join(occupied + '.chisa-lease', 'state.json'), 'utf8')), foreign);
  }));
});

test('failed host mutations clean every claimed root and retain only the failed synchronization barrier', { timeout: 5000 }, async () => {
  await withWorkspace(async (first, bridge) => withSecondWorkspace(bridge, async second => {
    const ordered = [first, second].sort((left, right) => left.localeCompare(right));
    const failedRoot = ordered[1];
    const returned: string[] = [];
    bridge.handle = (request, incoming) => {
      const root = Buffer.from(String(incoming.headers['x-cwd']), 'latin1').toString('utf8');
      if (request.op === 'sync_end') {
        returned.push(root);
        if (root === failedRoot) return Response.json({ code: 'RETURN_FAILED', error: 'fixture return failed' }, { status: 503 });
      }
      return Response.json({ ok: true });
    };
    await assert.rejects(withWorkspaceMutation([first, second], async () => { throw new Error('host transaction failed'); }), error => {
      assert.match((error as Error).message, /host transaction failed/);
      assert.ok((error as Error & { cleanupError?: unknown }).cleanupError);
      return true;
    });
    assert.deepEqual(returned, [...ordered].reverse());
    assert.equal(existsSync(ordered[0] + '.chisa-lease'), false);
    assert.equal(JSON.parse(readFileSync(path.join(failedRoot + '.chisa-lease', 'state.json'), 'utf8')).owner, 'sync-needed');
  }));
});

test('unbound host transactions keep their original entry point without workspace callbacks', { timeout: 5000 }, async () => {
  await withWorkspace(async (root, bridge) => {
    bridge.handle = () => { throw new Error('unbound transactions must not call the bridge'); };
    assert.equal(isWorkspaceBindingRoot(root), true);
    assert.equal(isWorkspaceBindingRoot(path.join(root, 'ordinary-worktree')), false);
    assert.equal(isWorkspaceBindingRoot(WORKSPACES_ROOT), false);
    let calls = 0;
    assert.equal(await withWorkspaceMutation(WORKSPACES_ROOT, async () => { calls++; return 'unbound'; }), 'unbound');
    assert.equal(calls, 1);
  });
});

test('recovery-only transports block new admission but still settle the original workspace owner', { timeout: 5000 }, async () => {
  await withWorkspace(async (cwd, bridge) => {
    const operations: string[] = [];
    bridge.handle = request => { operations.push(String(request.op)); return Response.json({ ok: true }); };
    const query = workspaceQuery({ prompt: 'existing model owner', options: { cwd } });
    await query.next();
    const pending = query.next();
    registerWorkspaceSyncRecoveryTransport(cwd, '172.18.0.9');
    await assert.rejects(withWorkspaceMutation(cwd, async () => { throw new Error('must not start'); }), { code: 'WORKSPACE_RECOVERY_REQUIRED' });
    await assert.rejects(executeSyncTransportWorker(cwd, 'fixture-epoch', { op: 'read', path: '/workspace/file' }), { code: 'WORKSPACE_RECOVERY_REQUIRED' });
    assert.throws(() => prepareSyncTransportPreview(cwd, 'fixture-epoch'), { code: 'WORKSPACE_RECOVERY_REQUIRED' });
    await query.interrupt();
    await pending;
    assert.deepEqual(operations, ['sync_begin', 'sync_end', 'sync_released']);
    assert.equal(existsSync(cwd + '.chisa-lease'), false);
  });
});



test('idle Git reads use the native owner for commands and files without synchronization', async () => {
  await withWorkspace(async (cwd, bridge) => {
    bridge.marker.localGitRead = true;
    await writeFile(path.join(cwd, '.chisa-bridge.json'), JSON.stringify(bridge.marker));
    const calls: Record<string, unknown>[] = [];
    bridge.handle = async request => {
      calls.push(request);
      assert.equal(request.op, 'git_read');
      if (request.action === 'prepare') return Response.json({ ok: true, localGitRead: true });
      if (request.action === 'read') return Response.json({ ok: true, b64: Buffer.from('owner file').toString('base64') });
      assert.equal(request.action, 'command');
      assert.deepEqual(request.argv, ['git', '--no-optional-locks', 'branch', '-a']);
      assert.equal(request.readOnly, undefined);
      return Response.json({ ok: true, stdout: '* owner-branch\n', stderr: '', exitCode: 0 });
    };
    spawnWorker = () => { throw new Error('native reads must not start Docker'); };
    await withWorkspaceGitReadOperation(cwd, async () => {
      assert.match((await runWorkspaceCommand(cwd, 'git', ['branch', '-a'], { readOnly: true }))!.stdout!, /owner-branch/);
      assert.equal(await bridgeGitFileSystem({} as never).readFile(path.join(cwd, 'readme.txt'), 'utf8'), 'owner file');
    });
    assert.deepEqual(calls.map(call => call.action), ['prepare', 'command', 'read']);
    assert.equal(existsSync(cwd + '.chisa-lease'), false);
  });
});


test('one Git write reservation encloses all commands and waits for handback', async () => {
  await withWorkspace(async (cwd, bridge) => {
    const operations: string[] = [];
    const syncing = gate();
    const synchronized = gate();
    const work = gate();
    const entered = gate();
    const leaseIds: string[] = [];
    bridge.handle = async request => {
      operations.push(String(request.op));
      if (request.op === 'sync_end') { assert.equal(request.changed, true); syncing.resolve(); await synchronized.promise; }
      return Response.json({ ok: true });
    };
    spawnWorker = args => {
      const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), kill() {} });
      if (args[0] === 'run') {
        leaseIds.push(JSON.parse(readFileSync(cwd + '.chisa-lease/state.json', 'utf8')).id);
        assert.ok(args.includes(cwd + ':/workspace:rw'));
        child.stdin.once('finish', () => queueMicrotask(() => { child.stdout.write(JSON.stringify({ ok: true, stdout: '', exitCode: 0 })); child.emit('close', 0); }));
      } else queueMicrotask(() => child.emit('close', 0));
      return child;
    };
    let completed = false;
    const operation = withWorkspaceWriteOperation(cwd, async () => {
      entered.resolve(); await work.promise;
      await runWorkspaceCommand(cwd, 'git', ['status', '--porcelain']);
      await runWorkspaceCommand(cwd, 'git', ['commit', '-m', 'index only']);
    }).then(() => { completed = true; });
    await entered.promise;
    await assert.rejects(withWorkspaceWriteOperation(cwd, async () => {}), { code: 'WORKSPACE_BUSY' });
    await assert.rejects(bridgeGitFileSystem({} as never).unlink(path.join(cwd, 'file.txt')), { code: 'WORKSPACE_BUSY' });
    work.resolve();
    await syncing.promise;
    assert.equal(completed, false);
    assert.deepEqual(operations, ['sync_begin', 'sync_end']);
    assert.equal(leaseIds.length, 2);
    assert.equal(new Set(leaseIds).size, 1);
    synchronized.resolve();
    await operation;
    assert.equal(completed, true);
    assert.deepEqual(operations, ['sync_begin', 'sync_end', 'sync_released']);
    assert.equal(existsSync(cwd + '.chisa-lease'), false);
  });
});


test('mapped branch operations use the native capability without preholding a lease', async () => {
  await withWorkspace(async (cwd, bridge) => {
    bridge.marker.localGitRead = true;
    await writeFile(path.join(cwd, '.chisa-bridge.json'), JSON.stringify(bridge.marker));
    const calls: Record<string, unknown>[] = [];
    bridge.handle = async request => {
      calls.push(request);
      assert.equal(existsSync(cwd + '.chisa-lease'), false);
      if (request.op === 'git_read') return Response.json({ ok: true, localGitRead: true, gitBranch: true });
      assert.deepEqual(request, { op: 'git_branch', action: 'delete', branch: 'feature/old', force: true });
      return Response.json({ ok: true, stdout: 'Deleted branch feature/old', stderr: '', exitCode: 0 });
    };
    assert.equal((await runWorkspaceGitBranchOperation(cwd, 'delete', 'feature/old', true))!.exitCode, 0);
    assert.deepEqual(calls.map(call => call.op), ['git_read', 'git_branch']);
    for (const code of ['WORKSPACE_GIT_DIRTY', 'WORKSPACE_GIT_BRANCH_EXISTS', 'WORKSPACE_GIT_BRANCH_MISSING', 'WORKSPACE_GIT_REJECTED', 'SYNC_BLOCKED', 'WORKSPACE_RELEASE_FAILED']) {
      bridge.handle = async request => request.op === 'git_read'
        ? Response.json({ ok: true, localGitRead: true, gitBranch: true })
        : Response.json({ ok: false, code, error: 'Owner repository needs attention' });
      await assert.rejects(runWorkspaceGitBranchOperation(cwd, 'create', 'feature/new'), { code, statusCode: 409, message: 'Owner repository needs attention' });
    }
    bridge.handle = async () => Response.json({ ok: true, localGitRead: true });
    await assert.rejects(runWorkspaceGitBranchOperation(cwd, 'create', 'feature/new'), { code: 'WORKSPACE_GIT_UNSUPPORTED', statusCode: 409 });
  });
});


test('local shared-root write sessions serialize by project root', async () => {
  await withWorkspace(async cwd => {
    const first = workspaceQuery({ prompt: 'first local write', options: { cwd } });
    await first.next();
    await started.promise;

    closed = gate();
    started = gate();
    const second = workspaceQuery({ prompt: 'second local write', options: { cwd } });
    const secondNext = second.next();
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(queries, 1);

    await first.interrupt();
    await first.next();
    await started.promise;
    assert.equal(queries, 2);

    await second.interrupt();
    await secondNext;
  }, 1);
});


test('plan sessions can inspect a synced workspace without claiming the shared write lease', async () => {
  await withWorkspace(async (cwd, bridge) => {
    const operations: string[] = [];
    bridge.handle = request => {
      operations.push(String(request.op));
      return Response.json({ ok: true });
    };
    const query = workspaceQuery({ prompt: 'inspect only', options: { cwd, permissionMode: 'plan' } });
    await query.next();
    assert.equal(existsSync(cwd + '.chisa-lease'), false);
    const write = tools!.tools!.find(definition => definition.name === 'write_file')!;
    const writeResult = await write.handler({ path: '/workspace/blocked.txt', content: 'nope', expectedHash: null }, {});
    assert.equal(writeResult.isError, true);
    const writeMessage = writeResult.content?.[0];
    assert.equal(writeMessage?.type, 'text');
    assert.match(writeMessage.type === 'text' ? writeMessage.text : '', /只读/);
    const next = query.next();
    await started.promise;
    await query.interrupt();
    await next;
    assert.deepEqual(operations, []);
    assert.equal(queries, 1);
  });
});


test('write sessions use a retained isolated Git worktree instead of the synced root', async () => {
  await withWorkspace(async (cwd, bridge) => {
    const operations: string[] = [];
    bridge.handle = request => { operations.push(String(request.op)); return Response.json({ ok: true }); };
    const runRealGit = (args: string[]) => new Promise<void>((resolve, reject) => {
      const child = realSpawn('git', args, { cwd, windowsHide: true });
      child.once('error', reject);
      child.once('close', code => code === 0 ? resolve() : reject(new Error(`git exited ${code}`)));
    });
    await runRealGit(['init', '-b', 'main']);
    await runRealGit(['-c', 'user.name=QA', '-c', 'user.email=qa@localhost', 'commit', '--allow-empty', '-m', 'fixture']);
    await writeFile(path.join(cwd, 'uncommitted.txt'), 'current synchronized snapshot');
    const worktreeName = `session-worktree-1-${createHash('sha256').update('session-worktree-1').digest('hex').slice(0, 12)}`;
    const worktreeRoot = `${cwd}.chisa-worktrees/${worktreeName}`;
    spawnWorker = (args, options) => {
      if (args[0] === 'run') {
        const child = Object.assign(new EventEmitter(), {
          stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), kill() {},
        });
        let input = '';
        child.stdin.on('data', chunk => { input += chunk.toString(); });
        child.stdin.once('finish', () => queueMicrotask(() => {
          void (async () => {
            const request = JSON.parse(input || '{}') as { op?: string; path?: string; b64?: string };
            if (request.op === 'write' && request.path === '/workspace/isolated.txt') {
              await writeFile(path.join(worktreeRoot, 'isolated.txt'), Buffer.from(request.b64 || '', 'base64'));
            }
            child.stdout.write(JSON.stringify({ ok: true, stdout: '', exitCode: 0 }));
            child.emit('close', 0);
          })();
        }));
        return child;
      }
      if (args[0] === 'rm') {
        const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), kill() {} });
        queueMicrotask(() => child.emit('close', 0));
        return child;
      }
      return realSpawn('git', args, options as Parameters<typeof realSpawn>[2]);
    };
    const query = workspaceQuery({ prompt: 'edit in isolation', options: { cwd, chisaSessionId: 'session-worktree-1' } as never });
    await query.next();
    await started.promise;
    assert.equal(existsSync(worktreeRoot), true);
    const marker = JSON.parse(readFileSync(`${worktreeRoot}/.chisa-bridge.json`, 'utf8')) as Record<string, unknown>;
    assert.equal(marker.execution, 'isolated-worktree');
    assert.equal(marker.sessionId, 'session-worktree-1');
    assert.equal(await readFile(path.join(worktreeRoot, 'uncommitted.txt'), 'utf8'), 'current synchronized snapshot');
    assert.equal(existsSync(cwd + '.chisa-lease'), false);
    const write = tools!.tools!.find(definition => definition.name === 'write_file')!;
    const writeResult = await write.handler({ path: '/workspace/isolated.txt', content: 'isolated', expectedHash: null }, {});
    assert.equal(writeResult.isError, undefined);
    assert.deepEqual(operations, []);
    assert.equal(existsSync(path.join(cwd, 'isolated.txt')), false);
    assert.equal((await readFile(path.join(worktreeRoot, 'isolated.txt'), 'utf8')), 'isolated');
    assert.equal(existsSync(`${worktreeRoot}.chisa-lease`), true);
    await query.interrupt();
    await query.next();
    assert.deepEqual(bridge.marker, { protocol: 2, port: bridge.marker.port, token: 'fixture', bindingEpoch: 'fixture-epoch' });
    await runRealGit(['worktree', 'remove', '--force', worktreeRoot]);
    await runRealGit(['worktree', 'prune']);
  });
});


test('isolated startup reserves the source until worktree creation or shared lease handoff', { timeout: 10_000 }, async () => {
  for (const createsWorktree of [true, false]) {
    await withWorkspace(async (cwd, bridge) => {
      bridge.marker.localGitRead = true;
      await writeFile(path.join(cwd, '.chisa-bridge.json'), JSON.stringify(bridge.marker));
      const probing = gate();
      const finishProbe = gate();
      const syncing = gate();
      const finishSync = gate();
      const operations: string[] = [];
      let holdSync = !createsWorktree;
      bridge.handle = async request => {
        operations.push(String(request.op));
        if (request.op === 'git_read') return Response.json({ ok: true, localGitRead: true, gitBranch: true });
        if (request.op === 'sync_begin' && holdSync) {
          holdSync = false;
          syncing.resolve();
          await finishSync.promise;
        }
        return Response.json({ ok: true });
      };
      spawnWorker = args => {
        const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), kill() {} });
        if (args[0] === 'rev-parse') {
          probing.resolve();
          void finishProbe.promise.then(() => {
            if (createsWorktree) child.stdout.write(cwd + '\n');
            else child.stderr.write('fatal: not a git repository (or any of the parent directories): .git\n');
            child.emit('close', createsWorktree ? 0 : 128);
          });
        } else {
          assert.deepEqual(args.slice(0, 3), ['worktree', 'add', '-b']);
          void mkdir(args[4]!, { recursive: true }).then(() => child.emit('close', 0));
        }
        return child;
      };
      const query = workspaceQuery({ prompt: 'reserve isolated startup', options: { cwd, chisaSessionId: 'startup-race' } as never });
      const next = query.next();
      let writes = 0;
      const write = () => withWorkspaceWriteOperation(cwd, async () => { writes++; });
      try {
        await probing.promise;
        assert.equal(queries, 0);
        assert.equal(existsSync(cwd + '.chisa-lease'), false);
        await assert.rejects(write(), { code: 'WORKSPACE_BUSY', statusCode: 409 });
        await assert.rejects(runWorkspaceGitBranchOperation(cwd, 'create', 'during-probe'), { code: 'WORKSPACE_BUSY', statusCode: 409 });
        assert.deepEqual(operations, []);
        assert.equal(writes, 0);
        finishProbe.resolve();
        if (!createsWorktree) {
          await syncing.promise;
          assert.equal(existsSync(cwd + '.chisa-lease'), true);
          await assert.rejects(write(), { code: 'WORKSPACE_BUSY', statusCode: 409 });
          await assert.rejects(runWorkspaceGitBranchOperation(cwd, 'create', 'during-handoff'), { code: 'WORKSPACE_BUSY', statusCode: 409 });
          finishSync.resolve();
        }
        await next;
        await started.promise;
        assert.equal(queries, 1);
        if (createsWorktree) {
          assert.equal(existsSync(cwd + '.chisa-lease'), false);
          await write();
          assert.equal(writes, 1);
        } else {
          await assert.rejects(write(), { code: 'WORKSPACE_BUSY', statusCode: 409 });
        }
      } finally {
        finishProbe.resolve();
        finishSync.resolve();
        await next;
        await query.interrupt();
        await query.next();
        const worktreeParent = path.resolve(cwd + '.chisa-worktrees');
        assert.equal(path.dirname(worktreeParent), path.resolve(WORKSPACES_ROOT));
        await rm(worktreeParent, { recursive: true, force: true });
      }
      await write();
      assert.equal(writes, createsWorktree ? 2 : 1);
      assert.equal(existsSync(cwd + '.chisa-lease'), false);
    });
  }
});


test('corrupt shared lease reports a recoverable state error', async () => {
  await withWorkspace(async (cwd) => {
    await mkdir(cwd + '.chisa-lease', { recursive: true });
    await writeFile(cwd + '.chisa-lease/state.json', '{broken');
    const query = workspaceQuery({ prompt: 'corrupt lease', options: { cwd } });
    await assert.rejects(query.next(), { code: 'WORKSPACE_LEASE_CORRUPT', statusCode: 503 });
  });
});
