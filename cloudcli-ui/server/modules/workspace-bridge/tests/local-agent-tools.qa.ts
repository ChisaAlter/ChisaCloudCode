// Run with TSX_TSCONFIG_PATH=server/tsconfig.json and Node --import tsx
// --experimental-test-module-mocks --test; no Claude process is launched.
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'node:http';
import type { IncomingMessage } from 'node:http';
import test, { mock } from 'node:test';

import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';

import { WORKSPACES_ROOT } from '@/shared/index.js';

type ServerOptions = Parameters<typeof createSdkMcpServer>[0];
let registered: ServerOptions | undefined;
mock.module('@anthropic-ai/claude-agent-sdk', {
  namedExports: {
    tool,
    createSdkMcpServer: (options: ServerOptions) => {
      registered = options;
      return createSdkMcpServer(options);
    },
    // Observe the actual SDK tool registration without starting Claude.
    query: () => ({}),
  },
});
const { workspaceQuery } = await import('@/modules/workspace-bridge/index.js');

const PROJECT_TOOLS = ['list_files', 'read_file', 'write_file', 'search_files', 'run_command', 'start_preview', 'preview_status', 'stop_preview'];
const PRIVATE_AGENT_CONTEXT = /\bpi\b|local[_ -]agent|windows|native|delegate/i;

type ControlFixture = {
  requests: Array<Record<string, unknown>>;
  handle: (request: Record<string, unknown>, incoming: IncomingMessage) => Response | Promise<Response>;
};

async function withBinding(localAgent: boolean | undefined, run: (cwd: string, bridge: ControlFixture) => Promise<void>): Promise<void> {
  const cwd = await mkdtemp(path.join(path.resolve(WORKSPACES_ROOT), '.chisa-workspace-isolation-qa-载货车-%-'));
  let fixtureError: unknown;
  const bridge: ControlFixture = {
    requests: [],
    handle: () => { throw new Error('Workspace discovery must not issue RPC'); },
  };
  const server = createServer((incoming, outgoing) => {
    void (async () => {
      assert.equal(incoming.method, 'POST');
      assert.equal(incoming.url, '/workspace/rpc');
      assert.equal(incoming.headers['x-bridge-token'], 'fixture-capability');
      assert.equal(incoming.headers['x-binding-epoch'], 'fixture-epoch');
      assert.equal(Buffer.from(String(incoming.headers['x-cwd']), 'latin1').toString('utf8'), cwd);
      const chunks: Buffer[] = [];
      for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
      const request = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
      bridge.requests.push(request);
      const reply = await bridge.handle(request, incoming);
      outgoing.writeHead(reply.status, { 'Content-Type': 'application/json' });
      outgoing.end(Buffer.from(await reply.arrayBuffer()));
    })().catch(error => {
      fixtureError = error;
      outgoing.statusCode = 500;
      outgoing.end(JSON.stringify({ error: 'HTTP fixture failed' }));
    });
  });
  try {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    await writeFile(path.join(cwd, '.chisa-bridge.json'), JSON.stringify({
      protocol: 1, port: address.port, token: 'fixture-capability', bindingEpoch: 'fixture-epoch',
      ...(localAgent === undefined ? {} : { localAgent }),
    }));
    registered = undefined;
    await run(cwd, bridge);
    if (fixtureError) throw fixtureError;
  } finally {
    mock.restoreAll();
    server.closeAllConnections();
    if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    assert.equal(path.dirname(cwd), path.resolve(WORKSPACES_ROOT));
    await rm(cwd, { recursive: true, force: true });
  }
}

async function invoke(name: string, args: Record<string, unknown> = {}) {
  const definition = registered?.tools?.find(candidate => candidate.name === name);
  assert.ok(definition, `${name} is registered`);
  const response = await definition.handler(args, {});
  const first = response.content[0];
  assert.ok(first && first.type === 'text');
  return { isError: response.isError, value: JSON.parse(first.text) as Record<string, unknown> };
}

test('workspace discovery exposes only project tools, including with a legacy local-agent marker', async () => {
  for (const marker of [undefined, false, true]) {
    await withBinding(marker, async (cwd, bridge) => {
      const input: Parameters<typeof workspaceQuery>[0] = { prompt: 'Inspect the project', options: { cwd } };
      workspaceQuery(input);
      assert.deepEqual(registered?.tools?.map(definition => definition.name), PROJECT_TOOLS);
      assert.deepEqual(input.options?.allowedTools, [], 'Workspace discovery must not auto-approve project reads or writes');
      assert.equal(input.options?.strictMcpConfig, true);
      assert.deepEqual(Object.keys(input.options?.mcpServers ?? {}), ['workspace']);
      const systemPrompt = input.options?.systemPrompt;
      assert.ok(systemPrompt && typeof systemPrompt === 'object' && 'append' in systemPrompt);
      assert.doesNotMatch(String(systemPrompt.append), PRIVATE_AGENT_CONTEXT);
      assert.doesNotMatch(JSON.stringify(registered?.tools?.map(({ name, description }) => ({ name, description }))), PRIVATE_AGENT_CONTEXT);
      assert.equal(bridge.requests.length, 0);
    });
  }
});

test('project reads and commands retain their results without discovering or querying a private agent', async () => {
  await withBinding(true, async (cwd, bridge) => {
    bridge.handle = request => {
      assert.doesNotMatch(String(request.op), /^pi_/);
      const response = request.op === 'read'
        ? { b64: Buffer.from('project body').toString('base64'), hash: 'fixture-hash' }
        : { stdout: 'project result\n', stderr: '', exitCode: 0 };
      return new Response(JSON.stringify(response));
    };
    workspaceQuery({ prompt: 'Read the project', options: { cwd } });
    const read = await invoke('read_file', { path: '/workspace/README.md', encoding: 'utf8' });
    assert.deepEqual(read.value, { content: 'project body', encoding: 'utf8', hash: 'fixture-hash' });
    const command = await invoke('run_command', { command: 'echo project result', path: '/workspace', timeoutSeconds: 60 });
    assert.deepEqual(command.value, { stdout: 'project result\n', stderr: '', exitCode: 0 });
    assert.deepEqual(bridge.requests.map(request => request.op), ['read', 'exec']);
    assert.ok(bridge.requests.every(request => !('sessionId' in request) && !('origin' in request)));
  });
});

test('a Chinese project path reaches the desktop over real HTTP with unchanged UTF-8 bytes', async () => {
  await withBinding(undefined, async (cwd, bridge) => {
    let receivedPath: string | undefined;
    bridge.handle = (_body, request) => {
      receivedPath = Buffer.from(String(request.headers['x-cwd']), 'latin1').toString('utf8');
      assert.equal(request.headers['x-bridge-token'], 'fixture-capability');
      assert.equal(request.headers['x-binding-epoch'], 'fixture-epoch');
      return Response.json({ b64: Buffer.from('project body').toString('base64'), hash: 'fixture-hash' });
    };
    workspaceQuery({ prompt: 'Read the project', options: { cwd } });
    const read = await invoke('read_file', { path: '/workspace/README.md', encoding: 'utf8' });
    assert.equal(read.isError, undefined);
    assert.equal(read.value.content, 'project body');
    assert.equal(receivedPath, cwd);
  });
});
