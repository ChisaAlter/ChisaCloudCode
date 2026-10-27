import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { closeConnection, initializeDatabase } from '@/modules/database/index.js';
import { createCodexRuntime } from '@/modules/providers/list/codex/codex-runtime.provider.js';
import { CodexSessionsProvider } from '@/modules/providers/list/codex/codex-sessions.provider.js';
import { runProviderProcess } from '@/modules/providers/services/provider-process.service.js';
import { cursorRuntime } from '@/modules/providers/list/cursor/cursor-runtime.provider.js';
import { opencodeRuntime } from '@/modules/providers/list/opencode/opencode-runtime.provider.js';
import { CursorSessionsProvider } from '@/modules/providers/list/cursor/cursor-sessions.provider.js';
import { OpenCodeSessionsProvider } from '@/modules/providers/list/opencode/opencode-sessions.provider.js';
import { createProviderRuntimeService } from '@/modules/providers/services/provider-runtime.service.js';
import type { IProvider } from '@/shared/index.js';

const runFile = promisify(execFile);

function deferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function isAlive(pid: number) {
  try { process.kill(pid, 0); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false; throw error; }
}

async function launcher(root: string, name: string, script: string) {
  const source = path.join(root, `${name}.cjs`);
  await writeFile(source, script);
  if (process.platform === 'win32') await writeFile(path.join(root, `${name}.cmd`), `@echo off\r\nnode "%~dp0${name}.cjs" %*\r\n`);
  else {
    const executable = path.join(root, name);
    await writeFile(executable, `#!/bin/sh\nexec '${process.execPath.replaceAll("'", "'\\''")}' '${source.replaceAll("'", "'\\''")}' "$@"\n`);
    await chmod(executable, 0o755);
  }
}

for (const provider of ['codex', 'cursor', 'opencode'] as const) {
  for (const cancelled of [false, true]) {
    test(`${provider} public run${cancelled ? '/abort' : ''} stops orphan tool before handback and complete`, { timeout: 30_000 }, async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), `provider-tree-${provider}-`));
      const execution = path.join(root, 'execution');
      await mkdir(execution);
      const originalEnv = { ...process.env };
      const ready = deferred();
      const closing = deferred();
      const release = deferred();
      const messages: any[] = [];
      let childPid: number | undefined;
      let toolPid: number | undefined;
      let closed = false;
      let pending: Promise<unknown> | undefined;
      try {
        // Provider completion reads durable session metadata. Use a fresh app
        // database, including its schema, without migrating a developer's DB.
        closeConnection();
        process.env.DATABASE_PATH = path.join(root, 'app.db');
        await writeFile(process.env.DATABASE_PATH, '');
        await initializeDatabase();
        await runFile('git', ['init', execution]);
        const source = `
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
fs.writeFileSync(process.env.CHISA_TEST_CAPTURE, JSON.stringify({cwd:process.cwd(), args:process.argv.slice(2), pid:process.pid}));
if (process.env.CHISA_TEST_PROVIDER === 'codex') {
  let prompt = ''; process.stdin.on('data', chunk => prompt += chunk); process.stdin.on('end', () => fs.writeFileSync(process.env.CHISA_TEST_CAPTURE + '.prompt', prompt));
}
const tool = spawn(process.execPath, ['-e', "require('node:fs').writeFileSync(process.env.CHISA_TEST_TOOL_PID, String(process.pid)); process.on('SIGTERM',()=>{}); setInterval(()=>{}, 1000)"], {stdio:'ignore', env:{...process.env, NODE_OPTIONS:''}});
tool.unref();
const emit = () => {
  if (!fs.existsSync(process.env.CHISA_TEST_TOOL_PID)) return setTimeout(emit, 5);
  if (process.env.CHISA_TEST_PROVIDER === 'codex') {
    console.log(JSON.stringify({type:'thread.started',thread_id:'native-tree'}));
    console.log(JSON.stringify({type:'item.completed',item:{id:'reply',type:'agent_message',text:'fixture ready'}}));
    console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:1,output_tokens:1}}));
  } else if (process.env.CHISA_TEST_PROVIDER === 'cursor') {
    console.log(JSON.stringify({type:'system',subtype:'init',session_id:'native-tree'}));
    console.log(JSON.stringify({type:'assistant',message:{role:'assistant',content:[{type:'text',text:'fixture ready'}]}}));
    console.log(JSON.stringify({type:'result',subtype:'success'}));
  } else {
    console.log(JSON.stringify({type:'text',sessionID:'native-tree',text:'fixture ready'}));
    console.log(JSON.stringify({type:'step_finish',sessionID:'native-tree'}));
  }
  if (process.env.CHISA_TEST_HOLD !== '1') setTimeout(() => process.exit(0), 50);
};
emit();
if (process.env.CHISA_TEST_HOLD === '1') { process.on('SIGTERM',()=>{}); setInterval(()=>{},1000); }
`;
        await launcher(root, provider === 'cursor' ? 'cursor-agent' : 'opencode', source);
        const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === 'path') || 'PATH';
        process.env[pathKey] = `${root}${path.delimiter}${process.env[pathKey] || ''}`;
        const capture = path.join(root, 'capture.json');
        const toolCapture = path.join(root, 'tool.pid');
        process.env.CHISA_TEST_CAPTURE = capture;
        process.env.CHISA_TEST_TOOL_PID = toolCapture;
        process.env.CHISA_TEST_PROVIDER = provider;
        process.env.CHISA_TEST_HOLD = cancelled ? '1' : '0';
        // The worker has its own cwd, so source-mode aliases cannot depend on
        // discovering the repository config by walking from that cwd.
        process.env.TSX_TSCONFIG_PATH = path.resolve('server/tsconfig.json');
        const preload = path.join(root, 'fake-codex-preload.cjs');
        if (provider === 'codex') await writeFile(preload, `const Module = require('node:module'); const originalResolve = Module._resolveFilename; Module._resolveFilename = function(request, parent, isMain, ...rest) { return isMain ? __filename : originalResolve.call(this, request, parent, isMain, ...rest); }; require(${JSON.stringify(path.join(root, 'opencode.cjs'))});`);
        const runtime = provider === 'codex' ? createCodexRuntime((job, handlers, signal) => {
          assert.equal(job.kind, 'codex');
          return runProviderProcess({ ...job, executable: process.execPath, env: { ...process.env, NODE_OPTIONS: `--require=${JSON.stringify(preload)}` } } as any, handlers, signal);
        }) : provider === 'cursor' ? cursorRuntime : opencodeRuntime;
        const sessions = provider === 'codex' ? new CodexSessionsProvider() : provider === 'cursor' ? new CursorSessionsProvider() : new OpenCodeSessionsProvider();
        const adapter = { id: provider, runtime, sessions, auth: { getStatus: async () => ({ installed: true }) } } as unknown as IProvider;
        const service = createProviderRuntimeService({
          listProviders: () => [adapter], resolveProvider: () => adapter,
          resolveProviderSessionId: () => null, resolveResumeModel: async () => 'fake-model',
          getProviderModels: async () => ({ OPTIONS: [], DEFAULT: 'fake-model' }),
          getSessionSource: () => ({ project_path: root, workspace_mode: 'isolated', provider }),
          authorizeRun() {},
          // This fixture uses the real host process-tree supervisor and each
          // adapter's trusted fake executable factory; Docker has a separate
          // actual-admission fixture and must not replace this factory.
          createContainerProviderRunner: () => assert.fail('Unbound host process fixture must retain its trusted fake adapter runner'),
          admitWorkspaceExecution: async (input) => {
            assert.equal(input.cwd, root);
            return {
              sourceCwd: root, cwd: execution, sourceRoot: root, executionRoot: execution,
              bound: false, bindingKind: 'none', isolated: false, readOnly: false, revoke() {}, assertCurrent() {},
              async execute() { throw new Error('Unexpected workspace RPC in host process fixture'); },
              async spawnProcess() { throw new Error('Unexpected container launch in host process fixture'); },
              async close() {
                let observed: any;
                try { observed = JSON.parse(await readFile(capture, 'utf8')); }
                catch (error) { throw new Error(`CLI did not launch. Events=${JSON.stringify(messages)}`, { cause: error }); }
                childPid = observed.pid;
                toolPid = Number(await readFile(toolCapture, 'utf8'));
                assert.equal(observed.cwd, execution);
                assert.equal(isAlive(childPid!), false, 'CLI must have exited before handback');
                assert.equal(isAlive(toolPid!), false, 'orphan tool must have exited before handback');
                closing.resolve();
                await release.promise;
                closed = true;
              },
            };
          },
        });
        pending = service.run(provider, 'fixture', { sessionId: 'app-tree', files: [{ path: path.join(root, 'brief.pdf'), name: 'brief.pdf', mimeType: 'application/pdf' }] }, {
          isWebSocketWriter: true,
          send(message: any) {
            if (message.kind === 'complete') assert.equal(closed, true);
            messages.push(message);
            if (message.content === 'fixture ready') ready.resolve();
          },
        });
        void pending.catch((error) => { ready.reject(error); closing.reject(error); });
        await ready.promise;
        assert.equal(messages.some((message) => message.kind === 'complete'), false);
        let aborted = false;
        const aborting = cancelled ? service.abort(provider, 'app-tree').then((result) => { aborted = true; return result; }) : null;
        await closing.promise;
        assert.equal(messages.some((message) => message.kind === 'complete'), false);
        if (cancelled) assert.equal(aborted, false);
        release.resolve();
        if (aborting) assert.equal(await aborting, true);
        await pending;
        assert.equal(messages.filter((message) => message.kind === 'complete').length, cancelled ? 0 : 1);
        const args = JSON.parse(await readFile(capture, 'utf8')).args as string[];
        if (provider === 'codex') {
          assert.match(await readFile(capture + '.prompt', 'utf8'), /<files_input>[\s\S]*brief\.pdf/);
          assert.ok(args.includes('--cd'));
          assert.equal(args[args.indexOf('--cd') + 1], execution);
        } else assert.ok(args.some((arg) => arg.includes('<files_input>') && arg.includes('brief.pdf')));
        if (provider === 'opencode') assert.equal(args[args.indexOf('--dir') + 1], execution);
      } catch (error) {
        throw new Error(`Fixture messages: ${JSON.stringify(messages)}`, { cause: error });
      } finally {
        release.resolve();
        // Cleanup is limited to this fixture's own recorded processes.
        for (const pid of [childPid, toolPid]) if (pid && isAlive(pid)) { try { process.kill(pid, 'SIGKILL'); } catch {} }
        closeConnection();
        for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
        Object.assign(process.env, originalEnv);
        await rm(root, { recursive: true, force: true });
      }
    });
  }
}
