import assert from 'node:assert/strict';
import * as childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { IncomingMessage } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test, { mock } from 'node:test';

const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), 'chisa-native-git-binding-'));
process.env.WORKSPACES_ROOT = fixtureRoot;
let workerRequests: Record<string, unknown>[] = [];
let allowReplica = false;
mock.module('node:child_process', { namedExports: {
  ...childProcess,
  spawn: (_command: string, args: string[]) => {
    assert.equal(allowReplica, true, 'a native Git read must not fall back to the replica');
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), kill() {},
    });
    if (args[0] === 'run') {
      let input = '';
      child.stdin.on('data', chunk => { input += String(chunk); });
      child.stdin.once('finish', () => queueMicrotask(() => {
        workerRequests.push(JSON.parse(input) as Record<string, unknown>);
        child.stdout.write(JSON.stringify({ ok: true, stdout: 'replica result', b64: Buffer.from('replica file').toString('base64'), exitCode: 0 }));
        child.emit('close', 0);
      }));
    } else queueMicrotask(() => child.emit('close', 0));
    return child as unknown as ReturnType<typeof childProcess.spawn>;
  },
} });
const { bridgeFileSystem, bridgeGitFileSystem, runWorkspaceCommand, withWorkspaceGitReadOperation } = await import('@/modules/workspace-bridge/index.js');
const { registerWorkspaceSyncControlHost } = await import('@/shared/index.js');
registerWorkspaceSyncControlHost('172.22.0.250');

type BridgeFixture = {
  marker: Record<string, unknown>;
  calls: Record<string, unknown>[];
  handle(request: Record<string, unknown>, incoming: IncomingMessage): Promise<Response> | Response;
};
const defaultReply = (request: Record<string, unknown>) => Response.json(request.action === 'prepare'
  ? { ok: true, localGitRead: true }
  : { ok: true, stdout: 'owner result', b64: Buffer.from('owner file').toString('base64'), exitCode: 0 });
const markerPath = (root: string) => path.join(root, '.chisa-bridge.json');
async function withWorkspace(run: (root: string, bridge: BridgeFixture) => Promise<void>) {
  const root = await mkdtemp(path.join(fixtureRoot, 'project-'));
  let fixtureError: unknown;
  const bridge: BridgeFixture = { marker: {}, calls: [], handle: defaultReply };
  const server = createServer((incoming, outgoing) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
      const request = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
      bridge.calls.push(request);
      // Every accepted request must still use the capability selected at admission.
      assert.equal(incoming.headers['x-bridge-token'], 'fixture-token');
      assert.equal(incoming.headers['x-binding-epoch'], 'fixture-epoch');
      assert.equal(Buffer.from(String(incoming.headers['x-cwd']), 'latin1').toString('utf8'), root);
      const reply = await bridge.handle(request, incoming);
      outgoing.writeHead(reply.status, { 'Content-Type': 'application/json' });
      outgoing.end(Buffer.from(await reply.arrayBuffer()));
    })().catch(error => {
      fixtureError = error;
      outgoing.writeHead(500, { 'Content-Type': 'application/json' });
      outgoing.end(JSON.stringify({ error: 'Native read fixture failed' }));
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  bridge.marker = { protocol: 2, port: address.port, token: 'fixture-token', bindingEpoch: 'fixture-epoch', localGitRead: true };
  await writeFile(markerPath(root), JSON.stringify(bridge.marker));
  workerRequests = [];
  allowReplica = false;
  try {
    await run(root, bridge);
    if (fixtureError) throw fixtureError;
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    assert.equal(path.dirname(root), fixtureRoot);
    await rm(root, { recursive: true, force: true });
    await rm(root + '.chisa-lease', { recursive: true, force: true });
  }
}
test.after(() => rm(fixtureRoot, { recursive: true, force: true }));

const staleBinding = { code: 'STALE_BINDING', statusCode: 409 };
const readOperations = {
  command: (root: string) => runWorkspaceCommand(root, 'git', ['status', '--porcelain'], { readOnly: true }),
  file: (root: string) => bridgeGitFileSystem({ readFile: async () => assert.fail('native file reads must not use the server filesystem') } as never).readFile(path.join(root, 'file.txt'), 'utf8'),
};
const bindingChanges: Record<string, Record<string, unknown> | null> = {
  epoch: { bindingEpoch: 'replacement-epoch' },
  token: { token: 'replacement-token' },
  host: { controlHost: '172.22.0.250' },
  port: { port: 1024 },
  protocol: { protocol: 1 },
  isolation: { execution: 'isolated-worktree' },
  session: { sessionId: 'replacement-session' },
  capability: { localGitRead: false },
  batching: { readBatch: true },
  removal: null,
};
for (const [operationName, read] of Object.entries(readOperations)) {
  for (const [changeName, change] of Object.entries(bindingChanges)) {
    test(`native ${operationName} rejects ${changeName} changes before the next read`, async () => {
      await withWorkspace(async (root, bridge) => {
        await withWorkspaceGitReadOperation(root, async () => {
          if (change) await writeFile(markerPath(root), JSON.stringify({ ...bridge.marker, ...change }));
          else await rm(markerPath(root));
          try { await assert.rejects(read(root), staleBinding); }
          finally { await writeFile(markerPath(root), JSON.stringify(bridge.marker)); }
        });
        assert.deepEqual(bridge.calls.map(call => call.action), ['prepare']);
        assert.equal(workerRequests.length, 0);
      });
    });
  }

  test(`native ${operationName} rejects a new nested workspace mapping`, async () => {
    await withWorkspace(async (root, bridge) => {
      const nested = path.join(root, 'nested');
      await mkdir(nested);
      await assert.rejects(withWorkspaceGitReadOperation(nested, async () => {
        await writeFile(markerPath(nested), JSON.stringify(bridge.marker));
        await read(nested);
      }), staleBinding);
      assert.deepEqual(bridge.calls.map(call => call.action), ['prepare']);
      assert.equal(workerRequests.length, 0);
    });
  });

  for (const change of ['replacement', 'removal']) {
    test(`native ${operationName} discards a response after marker ${change} in flight`, async () => {
      await withWorkspace(async (root, bridge) => {
        bridge.handle = async request => {
          if (request.action !== 'prepare') {
            if (change === 'removal') await rm(markerPath(root));
            else await writeFile(markerPath(root), JSON.stringify({ ...bridge.marker, bindingEpoch: 'replacement-epoch' }));
          }
          return defaultReply(request);
        };
        await withWorkspaceGitReadOperation(root, async () => {
          try { await assert.rejects(read(root), staleBinding); }
          finally { await writeFile(markerPath(root), JSON.stringify(bridge.marker)); }
        });
        assert.equal(bridge.calls.length, 2);
        assert.equal(workerRequests.length, 0);
      });
    });
  }
}

for (const change of ['replacement', 'removal']) {
  test(`native admission rejects marker ${change} while prepare is in flight`, async () => {
    await withWorkspace(async (root, bridge) => {
      bridge.handle = async request => {
        if (change === 'removal') await rm(markerPath(root));
        else await writeFile(markerPath(root), JSON.stringify({ ...bridge.marker, token: 'replacement-token' }));
        return defaultReply(request);
      };
      let entered = false;
      await assert.rejects(withWorkspaceGitReadOperation(root, async () => { entered = true; }), staleBinding);
      assert.equal(entered, false);
      assert.deepEqual(bridge.calls.map(call => call.action), ['prepare']);
    });
  });
}

test('native scope rejects removal after its last read before returning the response', async () => {
  await withWorkspace(async (root, bridge) => {
    await assert.rejects(withWorkspaceGitReadOperation(root, async () => {
      assert.equal((await readOperations.command(root))?.stdout, 'owner result');
      await rm(markerPath(root));
      return { success: true };
    }), staleBinding);
    assert.deepEqual(bridge.calls.map(call => call.action), ['prepare', 'command']);
  });
});

test('native metadata and stream reads keep their source when batching is advertised', async () => {
  await withWorkspace(async (root, bridge) => {
    bridge.marker.readBatch = true;
    await writeFile(markerPath(root), JSON.stringify(bridge.marker));
    bridge.handle = request => {
      if (request.action === 'stat' || request.action === 'lstat') return Response.json({ ok: true, size: 10, mtime: 1, mode: 0o644, dir: false, symlink: false });
      if (request.action === 'realpath') return Response.json({ ok: true, path: '/workspace/file.txt' });
      return defaultReply(request);
    };
    const files = bridgeFileSystem({} as never);
    await withWorkspaceGitReadOperation(root, async () => {
      const file = path.join(root, 'file.txt');
      assert.equal((await files.stat(file)).size, 10);
      assert.equal((await files.lstat(file)).isSymbolicLink(), false);
      assert.equal(await files.realpath(file), file);
      const chunks: Buffer[] = [];
      for await (const chunk of files.createReadStream(file)) chunks.push(Buffer.from(chunk));
      assert.equal(Buffer.concat(chunks).toString('utf8'), 'owner file');
      await assert.rejects(runWorkspaceCommand(root, 'cat', ['file.txt'], { readOnly: true }), { code: 'WORKSPACE_GIT_UNSUPPORTED' });
      await assert.rejects(async () => { for await (const entry of files.openDirectory(root)) assert.fail(entry.name); }, { code: 'WORKSPACE_GIT_UNSUPPORTED' });
    });
    assert.deepEqual(bridge.calls.map(call => call.action), ['prepare', 'stat', 'lstat', 'realpath', 'read']);
    assert.equal(workerRequests.length, 0);
  });
});

test('native filesystem adapters reject marker removal instead of using server files', async () => {
  await withWorkspace(async (root, bridge) => {
    const files = bridgeFileSystem({} as never);
    await withWorkspaceGitReadOperation(root, async () => {
      const file = path.join(root, 'file.txt');
      await rm(markerPath(root));
      try {
        await assert.rejects(files.stat(file), staleBinding);
        await assert.rejects(files.lstat(file), staleBinding);
        await assert.rejects(files.realpath(file), staleBinding);
        await assert.rejects(files.readTextFile(file), staleBinding);
        assert.throws(() => files.createReadStream(file), staleBinding);
      } finally { await writeFile(markerPath(root), JSON.stringify(bridge.marker)); }
    });
    assert.deepEqual(bridge.calls.map(call => call.action), ['prepare']);
    assert.equal(workerRequests.length, 0);
  });
});

test('native scope discards a buffered response when the handler catches a binding failure', async () => {
  await withWorkspace(async root => {
    await assert.rejects(withWorkspaceGitReadOperation(root, async () => {
      await rm(markerPath(root));
      try { await readOperations.command(root); }
      catch { return { success: true }; }
    }), staleBinding);
  });
});

test('replica scope keeps its selected source and rejects rebinding between commands and files', async () => {
  await withWorkspace(async (root, bridge) => {
    allowReplica = true;
    bridge.handle = request => {
      assert.equal(request.action, 'prepare');
      return Response.json({ error: 'Workspace is in use', code: 'WORKSPACE_BUSY' }, { status: 409 });
    };
    await assert.rejects(withWorkspaceGitReadOperation(root, async () => {
      assert.equal((await readOperations.command(root))?.stdout, 'replica result');
      assert.equal(await readOperations.file(root), 'replica file');
      await writeFile(markerPath(root), JSON.stringify({ ...bridge.marker, bindingEpoch: 'replacement-epoch' }));
      await readOperations.file(root);
    }), staleBinding);
    assert.deepEqual(bridge.calls.map(call => call.action), ['prepare']);
    assert.equal(workerRequests.length, 2);
    assert.ok(workerRequests.every(request => request.op !== 'exec' || request.readOnly === true));
  });
});
