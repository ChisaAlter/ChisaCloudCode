// Opt-in Node 22 QA: compile this file, then run it with
// --experimental-test-module-mocks --test --test-timeout=370000.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test, { mock } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

type WorkspaceQuery = (input: { prompt: string; options: { cwd: string } }) => AsyncIterable<unknown>;
type BaselineOutcome = { elapsedMs: number; errorName?: string; transportCode?: string; success: boolean };

test('real 305-second sync confirmation outlives default fetch headers timeout', {
  skip: process.env.CHISA_QA_CONTROL_TIMEOUT !== '1', timeout: 370_000,
}, async () => {
  assert.equal(Number(process.versions.node.split('.')[0]), 22, 'this boundary must run on the target Node 22 runtime');
  const moduleURL = new URL(process.env.CHISA_QA_CONTROL_MODULE ?? '');
  assert.equal(moduleURL.protocol, 'file:');
  const modulePath = fileURLToPath(moduleURL);
  assert.ok(path.isAbsolute(modulePath) && existsSync(modulePath), 'compiled candidate service must exist');
  const root = path.resolve(process.env.WORKSPACES_ROOT ?? '');
  const temporaryRoot = path.resolve(os.tmpdir());
  assert.ok(root.startsWith(temporaryRoot + path.sep), 'WORKSPACES_ROOT must be a dedicated temporary QA directory');
  await mkdir(root, { recursive: true });
  const cwd = await mkdtemp(path.join(root, 'control-timeout-qa-'));
  const leaseDirectory = cwd + '.chisa-lease';
  const token = randomUUID();
  const epoch = randomUUID();
  const delayMs = 305_000;
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const operations: string[] = [];
  const handlerErrors: unknown[] = [];
  let queries = 0;
  let syncEndStarted!: () => void;
  const syncEndReceived = new Promise<void>(resolve => { syncEndStarted = resolve; });
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      try {
        const payload = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
        const baseline = request.url === '/old-baseline';
        if (!baseline) {
          assert.equal(request.url, '/workspace/rpc');
          assert.equal(request.headers['x-bridge-token'], token);
          assert.equal(request.headers['x-binding-epoch'], epoch);
          assert.equal(Buffer.from(String(request.headers['x-cwd']), 'latin1').toString('utf8'), cwd);
          assert.ok(payload.op === 'sync_begin' || payload.op === 'sync_end' || payload.op === 'sync_released', 'no project tool may run in this QA');
          operations.push(String(payload.op));
        }
        const send = () => {
          if (response.destroyed) return;
          // A successful native handback atomically releases its reservation.
          if (!baseline && payload.op === 'sync_end') rmSync(leaseDirectory, { recursive: true });
          response.setHeader('Content-Type', 'application/json');
          response.end(JSON.stringify({ ok: true }));
        };
        if (!baseline && payload.op !== 'sync_end') {
          send();
        } else {
          if (!baseline) {
            assert.equal(JSON.parse(readFileSync(path.join(leaseDirectory, 'state.json'), 'utf8')).owner, 'sync-needed');
            syncEndStarted();
          }
          // Do not write or flush headers before this timer: that is the original failure boundary.
          const timer = setTimeout(() => { timers.delete(timer); send(); }, delayMs);
          timers.add(timer);
          response.once('close', () => { clearTimeout(timer); timers.delete(timer); });
        }
      } catch (error) {
        handlerErrors.push(error);
        response.statusCode = 500;
        response.end(JSON.stringify({ error: 'QA request assertion failed' }));
      }
    });
  });
  try {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    await writeFile(path.join(cwd, '.chisa-bridge.json'), JSON.stringify({
      protocol: 2, port: address.port, token, bindingEpoch: epoch, readBatch: true,
    }));
    const require = createRequire(import.meta.url);
    const sdkPath = require.resolve('@anthropic-ai/claude-agent-sdk');
    const sdk = await import(pathToFileURL(sdkPath).href) as typeof import('@anthropic-ai/claude-agent-sdk');
    mock.module(sdkPath, {
      namedExports: {
        tool: sdk.tool,
        createSdkMcpServer: sdk.createSdkMcpServer,
        query: () => {
          queries++;
          const stream = (async function* () { yield { type: 'system', subtype: 'init', session_id: 'no-model-qa' }; })();
          return Object.assign(stream, { close() {} });
        },
      },
    });
    // No static service/shared import may run before the isolated WORKSPACES_ROOT is set.
    const { workspaceQuery } = await import(moduleURL.href) as { workspaceQuery: WorkspaceQuery };
    assert.equal(typeof workspaceQuery, 'function');
    const baselineStartedAt = Date.now();
    const baseline: Promise<BaselineOutcome> = fetch(`http://127.0.0.1:${address.port}/old-baseline`, {
      method: 'POST', body: JSON.stringify({ op: 'baseline' }), signal: AbortSignal.timeout(650_000),
    }).then(async response => {
      await response.text();
      return { elapsedMs: Date.now() - baselineStartedAt, success: true };
    }, (error: unknown) => {
      const failure = error as Error & { cause?: { code?: string } };
      return { elapsedMs: Date.now() - baselineStartedAt, errorName: failure.name, transportCode: failure.cause?.code, success: false };
    });
    const fixedStartedAt = Date.now();
    const fixed = (async () => {
      for await (const _message of workspaceQuery({ prompt: 'No model or tools are allowed in this QA', options: { cwd } })) {
        // Consume through done so the service waits for native's atomic handback.
      }
      return { elapsedMs: Date.now() - fixedStartedAt, leaseReleased: !existsSync(leaseDirectory) };
    })();
    await Promise.race([syncEndReceived, fixed]);
    assert.equal(JSON.parse(readFileSync(path.join(leaseDirectory, 'state.json'), 'utf8')).owner, 'sync-needed');
    const [oldResult, fixedResult] = await Promise.all([baseline, fixed]);
    console.log(JSON.stringify({
      event: 'workspace_control_timeout_observation', nodeVersion: process.version, delayMs,
      serviceModule: modulePath, serviceSha256: createHash('sha256').update(readFileSync(modulePath)).digest('hex'),
      cwd, leaseDirectory, baseline: oldResult, fixed: fixedResult, queries, operations,
    }));
    assert.deepEqual(handlerErrors, []);
    assert.equal(oldResult.success, false, 'the unchanged built-in fetch baseline must actually fail');
    assert.equal(oldResult.transportCode, 'UND_ERR_HEADERS_TIMEOUT');
    assert.ok(oldResult.elapsedMs >= 295_000 && oldResult.elapsedMs < delayMs, 'baseline must hit its real five-minute header deadline');
    assert.ok(fixedResult.elapsedMs >= delayMs && fixedResult.elapsedMs < 370_000);
    assert.equal(fixedResult.leaseReleased, true);
    assert.equal(queries, 1, 'only the mocked SDK query may run');
    assert.deepEqual(operations, ['sync_begin', 'sync_end', 'sync_released']);
  } finally {
    timers.forEach(clearTimeout);
    timers.clear();
    server.closeAllConnections();
    if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    mock.restoreAll();
    assert.equal(path.dirname(cwd), root);
    assert.ok(path.basename(cwd).startsWith('control-timeout-qa-'));
    await rm(cwd, { recursive: true, force: true });
    await rm(leaseDirectory, { recursive: true, force: true });
    assert.equal(existsSync(cwd) || existsSync(leaseDirectory), false);
    console.log(JSON.stringify({ event: 'workspace_control_timeout_cleanup', cwd, leaseDirectory, removed: true }));
  }
});
