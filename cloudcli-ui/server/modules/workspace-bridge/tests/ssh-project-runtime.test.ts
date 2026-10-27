import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { mock } from 'node:test';

import type { Options, query } from '@anthropic-ai/claude-agent-sdk';

import { closeConnection, initializeDatabase } from '@/modules/database/index.js';
import type { ProjectRuntimeLaunchContext, SshProjectTarget, WorkspaceDescriptor } from '@/shared/index.js';

type MockTool = { name: string; invoke(input: Record<string, unknown>): Promise<{ isError?: boolean; content: Array<{ type: string; text: string }> }> };
type MockServer = { name: string; tools: MockTool[] };
let onQuery: (input: Parameters<typeof query>[0]) => void | Promise<void>;
let queryCalls = 0;
mock.module('@anthropic-ai/claude-agent-sdk', { namedExports: {
  tool(name: string, _description: string, _schema: unknown, invoke: MockTool['invoke']) { return { name, invoke }; },
  createSdkMcpServer(input: MockServer) { return input; },
  query(input: Parameters<typeof query>[0]) {
    queryCalls++;
    return Object.assign((async function* () {
      await onQuery(input);
      yield { type: 'system', subtype: 'init', mcp_servers: [{ name: 'docs', status: 'connected' }] };
      yield { type: 'result', subtype: 'success' };
    })(), { close() {} });
  },
} });
// Load the real wrapper after installing the one SDK mock used by both the
// wrapper and project-runtime; no SDK process or external MCP network is started.
const { sshWorkspaceQuery } = await import('../ssh-workspace-query.service.js');
const { getProjectRuntimeManifest } = await import('@/modules/project-runtime/index.js');

type Admit = Parameters<typeof sshWorkspaceQuery>[2];
const digest = (content: string) => createHash('sha256').update(content).digest('hex');
async function fixture(files: Record<string, string>, run: (value: {
  target: SshProjectTarget; sessionId: string; options: Options & { chisaSessionId: string; chisaProjectRuntime: ProjectRuntimeLaunchContext; chisaWorkspaceDescriptor: WorkspaceDescriptor };
  admit: Admit; manifest(): ReturnType<typeof getProjectRuntimeManifest>; closes(): number; requests: Array<Record<string, unknown>>;
}) => Promise<void>) {
  const root = await mkdtemp(path.join(tmpdir(), 'ssh-project-runtime-'));
  const previousDatabase = process.env.DATABASE_PATH;
  closeConnection();
  process.env.DATABASE_PATH = path.join(root, 'fixture.db');
  await writeFile(process.env.DATABASE_PATH, '', { flag: 'wx' });
  await initializeDatabase();
  const account = path.join(root, 'private-account');
  await mkdir(account);
  const projectId = randomUUID();
  const sessionId = 'app-session-' + randomUUID();
  const target: SshProjectTarget = { projectId, ownerId: 'fixture-owner', connectionId: 'windows-fixture', connectionLabel: 'Windows fixture',
    rootPath: 'C:\\Remote\\Project', rootIdentity: 'physical-root', anchorPath: path.join(root, 'metadata-anchor'),
    generation: 'generation-1', workspaceId: 'source-workspace', phase: 'running', activeRunId: 'owned-run', pendingJobId: null };
  const expected: WorkspaceDescriptor = { projectId, workspaceId: `${target.workspaceId}:session:${sessionId}`, generation: target.generation,
    kind: 'session', sessionId, rootPath: target.anchorPath, sourceRoot: target.anchorPath, sourceMode: 'ssh', displayPath: target.rootPath,
    requestedMode: 'shared', effectiveMode: 'shared', phase: 'running', publicationState: 'integrated',
    capabilities: { read: true, write: true, git: true, shell: true, preview: false, integrate: false, cloudExecutionIndependentOfDesktop: false } };
  const launch: ProjectRuntimeLaunchContext = { userId: target.ownerId, accountKey: 'subscription:private-fixture', configDir: account, sessionId, prompt: 'Inspect the remote project' };
  const options: Options & { chisaSessionId: string; chisaProjectRuntime: ProjectRuntimeLaunchContext; chisaWorkspaceDescriptor: WorkspaceDescriptor } = {
    cwd: target.anchorPath, permissionMode: 'bypassPermissions', chisaSessionId: sessionId, chisaProjectRuntime: launch, chisaWorkspaceDescriptor: expected,
    systemPrompt: { type: 'preset', preset: 'claude_code', append: 'Original caller instructions' },
  };
  const requests: Array<Record<string, unknown>> = [];
  const remote = new Map(Object.entries(files));
  let active = false, closeCalls = 0;
  const admit: Admit = async input => {
    assert.equal(input.cwd, target.anchorPath);
    assert.equal(input.sessionId, sessionId);
    assert.equal(input.expectedWorkspace, expected);
    assert.equal(input.workspaceMode, 'shared');
    active = true;
    const assertCurrent = () => { assert.equal(active, true, 'configuration and tool RPC require the exact live admission'); };
    return {
      cwd: target.anchorPath, sourceRoot: target.anchorPath, assertCurrent,
      async execute(request: Record<string, unknown>, signal?: AbortSignal) {
        assertCurrent();
        assert.equal(signal, input.signal);
        signal?.throwIfAborted();
        requests.push({ ...request });
        const relative = String(request.path).replace(/^\/workspace\//, '');
        const content = remote.get(relative);
        const children = [...remote.keys()].filter(key => key.startsWith(relative + '/'));
        const missing = () => { throw Object.assign(new Error('Fixture optional config absent'), { code: 'ENOENT' }); };
        if (request.op === 'lstat') {
          if (content !== undefined) return { dir: false, size: Buffer.byteLength(content), mode: 0o100600 };
          return children.length ? { dir: true, mode: 0o040700 } : missing();
        }
        if (request.op === 'read') return content === undefined ? missing() : { b64: Buffer.from(content).toString('base64'), hash: digest(content) };
        if (request.op === 'list') {
          if (!children.length) return missing();
          const names = new Map<string, boolean>();
          for (const child of children) { const parts = child.slice(relative.length + 1).split('/'); names.set(parts[0], parts.length > 1 || Boolean(names.get(parts[0]))); }
          return { entries: [...names].map(([name, dir]) => ({ name, dir, stats: { symlink: false } })) };
        }
        assert.fail('A project runtime test must not execute commands or mutate remote files.');
      },
      async close() { closeCalls++; active = false; },
    } as Awaited<ReturnType<Admit>>;
  };
  queryCalls = 0;
  try {
    await run({ target, sessionId, options, admit, requests, closes: () => closeCalls,
      manifest: () => getProjectRuntimeManifest(target.ownerId, projectId, { accountKey: launch.accountKey, workspaceId: expected.workspaceId, generation: target.generation }) });
  } finally {
    closeConnection();
    if (previousDatabase === undefined) delete process.env.DATABASE_PATH; else process.env.DATABASE_PATH = previousDatabase;
    assert.equal(path.dirname(path.resolve(root)), path.resolve(tmpdir()));
    assert.ok(path.basename(root).startsWith('ssh-project-runtime-'));
    await rm(root, { recursive: true, force: true });
  }
}

function prompt(options: Options) {
  const value = options.systemPrompt;
  return typeof value === 'string' ? value : Array.isArray(value) ? value.join('\n') : value?.append ?? '';
}

test('actual SSH query wrapper prepares session-scoped provenance and keeps configured MCP beside workspace tools', async () => fixture({
  'CLAUDE.md': 'Actual Windows project instructions',
  '.claude/settings.json': JSON.stringify({ enabledMcpJsonServers: ['docs'] }),
  '.mcp.json': JSON.stringify({ mcpServers: { docs: { type: 'http', url: 'https://docs.example.com/mcp' } } }),
}, async current => {
  onQuery = input => {
    const options = input.options!;
    assert.equal(current.manifest()?.status, 'loaded', 'runtime is prepared before SDK query iteration');
    assert.equal(current.manifest()?.sessionId, current.sessionId);
    assert.equal(current.manifest()?.workspaceId, `${current.target.workspaceId}:session:${current.sessionId}`);
    assert.equal(current.manifest()?.generation, current.target.generation);
    assert.match(prompt(options), /Original caller instructions/);
    assert.match(prompt(options), /Actual Windows project instructions/);
    assert.match(prompt(options), /Windows PowerShell/);
    assert.equal(options.strictMcpConfig, true);
    assert.deepEqual(Object.keys(options.mcpServers ?? {}).sort(), ['docs', 'project_context', 'workspace']);
    assert.equal((options.mcpServers!.docs as { url: string }).url, 'https://docs.example.com/mcp');
    assert.equal(options.cwd, current.target.anchorPath);
    assert.deepEqual(options.settingSources, []);
    for (const field of ['chisaSessionId', 'chisaProjectRuntime', 'chisaWorkspaceDescriptor', 'chisaPrepareLaunch', 'workspaceMode']) assert.equal(field in options, false, field);
  };
  const stream = sshWorkspaceQuery({ prompt: 'fixture SDK prompt', options: current.options }, current.target, current.admit);
  for await (const _event of stream) { /* Real wrapper iterates only the mocked SDK. */ }
  assert.equal(queryCalls, 1);
  assert.equal(current.closes(), 1);
  assert.equal(current.manifest()?.status, 'completed');
  assert.ok(current.manifest()?.mcp.some(server => server.name === 'docs' && server.status === 'connected'));
  assert.equal('chisaProjectRuntime' in current.options, false);
}));

test('actual SSH query wrapper preserves project ask against captured bypass and attaches scoped rules to file reads', async () => fixture({
  'CLAUDE.md': 'Ask policy fixture',
  '.claude/settings.json': JSON.stringify({ permissions: { ask: ['Read'], deny: ['Bash'] } }),
  '.claude/rules/source.md': '---\npaths: "src/**/*.ts"\n---\nScoped TypeScript rule',
  'src/index.ts': 'export const fixture = true;',
}, async current => {
  const capturedOriginal = { ...current.options };
  let permissionCalls = 0;
  current.options.canUseTool = async (_name, toolInput, context) => {
    permissionCalls++;
    assert.equal(capturedOriginal.permissionMode, 'bypassPermissions');
    if (!(context as typeof context & { chisaForceAsk?: boolean }).chisaForceAsk) return { behavior: 'allow', updatedInput: toolInput };
    return { behavior: 'deny', message: 'Explicit user approval was not supplied' };
  };
  onQuery = async input => {
    const options = input.options!;
    assert.equal(options.allowedTools?.includes('mcp__workspace__read_file'), false);
    const context = { signal: new AbortController().signal, toolUseID: 'wrapper-tool' } as Parameters<NonNullable<Options['canUseTool']>>[2];
    assert.equal((await options.canUseTool!('mcp__workspace__run_command', {}, context)).behavior, 'deny');
    assert.equal(permissionCalls, 0, 'deny wins before the captured bypass callback');
    assert.equal((await options.canUseTool!('mcp__workspace__read_file', { path: '/workspace/src/index.ts' }, context)).behavior, 'deny');
    assert.equal(permissionCalls, 1, 'ask crosses both wrapper layers and forces explicit permission');
    const workspace = options.mcpServers!.workspace as unknown as MockServer;
    const read = workspace.tools.find(tool => tool.name === 'read_file')!;
    const result = await read.invoke({ path: '/workspace/src/index.ts', encoding: 'utf8' });
    assert.equal(result.isError, undefined);
    const content = JSON.parse(result.content[0]!.text) as { content: string; projectRules: string };
    assert.equal(content.content, 'export const fixture = true;');
    assert.match(content.projectRules, /Scoped TypeScript rule/);
    assert.equal(current.manifest()?.workspaceId, `${current.target.workspaceId}:session:${current.sessionId}`);
  };
  for await (const _event of sshWorkspaceQuery({ prompt: 'fixture', options: current.options }, current.target, current.admit)) { /* SDK is mocked. */ }
  assert.equal(queryCalls, 1);
  assert.equal(current.closes(), 1);
  assert.equal(current.manifest()?.status, 'completed');
  assert.ok(current.requests.every(request => ['lstat', 'list', 'read'].includes(String(request.op))));
}));
