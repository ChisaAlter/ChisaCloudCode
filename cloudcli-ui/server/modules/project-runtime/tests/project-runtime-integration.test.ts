import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { mock } from 'node:test';

import type { Options } from '@anthropic-ai/claude-agent-sdk';

import { closeConnection, getConnection, initializeDatabase } from '@/modules/database/index.js';
import type { ProjectRuntimeLaunchContext, WorkspaceDescriptor } from '@/shared/index.js';

type MockTool = { name: string; invoke(input: Record<string, unknown>): Promise<{ isError?: boolean; content: Array<{ type: string; text: string }> }> };
type MockServer = { name: string; tools: MockTool[] };
let sdkCalls = 0;
mock.module('@anthropic-ai/claude-agent-sdk', { namedExports: {
  tool(name: string, _description: string, _schema: unknown, invoke: MockTool['invoke']) { return { name, invoke }; },
  createSdkMcpServer(input: MockServer) { return input; },
  query() { sdkCalls++; assert.fail('Preparation must finish before any SDK query or process launch.'); },
} });
const { prepareProjectRuntime } = await import('../project-runtime.service.js');
const { getProjectRuntimeManifest, readProjectMemory, writeProjectMemory } = await import('../project-runtime-state.service.js');

const hash = (content: string) => createHash('sha256').update(content).digest('hex');
const definition = (frontmatter: string, body: string) => `---\n${frontmatter}\n---\n${body}`;
const rpcMissing = () => Object.assign(new Error('Fixture remote path is absent'), { code: 'ENOENT' });

type Fixture = Awaited<ReturnType<typeof createFixture>>;
async function createFixture(files: Record<string, string> = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'project-runtime-integration-'));
  const previousDatabase = process.env.DATABASE_PATH;
  closeConnection();
  process.env.DATABASE_PATH = path.join(root, 'fixture.db');
  await writeFile(process.env.DATABASE_PATH, '', { flag: 'wx' });
  await initializeDatabase();
  const account = path.join(root, 'selected-account');
  const hostDecoy = path.join(root, 'metadata-anchor');
  await mkdir(account); await mkdir(hostDecoy);
  const descriptor: WorkspaceDescriptor = { workspaceId: 'workspace-1', projectId: 'project-1', generation: 'generation-1', kind: 'session', sessionId: 'session-1',
    rootPath: hostDecoy, sourceRoot: hostDecoy, sourceMode: 'ssh', displayPath: 'C:\\Remote\\Project',
    requestedMode: 'shared', effectiveMode: 'shared', phase: 'running', publicationState: 'integrated',
    capabilities: { read: true, write: true, git: true, shell: true, preview: false, integrate: false, cloudExecutionIndependentOfDesktop: false } };
  const launch: ProjectRuntimeLaunchContext = { userId: 'fixture-user', accountKey: 'selected-account-1', configDir: account, sessionId: 'session-1', prompt: 'Inspect project' };
  const controller = new AbortController();
  const requests: Array<Record<string, unknown>> = [];
  const remote = new Map(Object.entries(files));
  const links = new Set<string>();
  let current = true, checks = 0;
  let afterRpc: ((request: Record<string, unknown>) => void) | undefined;
  function assertCurrent() { checks++; if (!current) throw Object.assign(new Error('Fixture generation changed'), { code: 'WORKSPACE_GENERATION_CHANGED' }); }
  const execute: Parameters<typeof prepareProjectRuntime>[0]['execute'] = async (request, signal) => {
    assert.equal(signal, controller.signal, 'every RPC retains this admission cancellation signal');
    signal?.throwIfAborted();
    assertCurrent();
    requests.push({ ...request });
    const candidate = String(request.path);
    assert.ok(candidate.startsWith('/workspace/'), 'only admitted virtual project paths can be read');
    assert.equal(candidate.includes(hostDecoy), false);
    const relative = candidate.slice('/workspace/'.length);
    const content = remote.get(relative);
    const children = [...remote.keys()].filter(key => key.startsWith(relative + '/'));
    let result;
    if (request.op === 'lstat') {
      if (links.has(relative)) result = { symlink: true, mode: 0o120777, dir: true };
      else if (content !== undefined) result = { dir: false, size: Buffer.byteLength(content), mode: 0o100600 };
      else if (children.length) result = { dir: true, mode: 0o040700 };
      else throw rpcMissing();
    } else if (request.op === 'read') {
      if (content === undefined) throw rpcMissing();
      result = { b64: Buffer.from(content).toString('base64'), hash: hash(content) };
    } else if (request.op === 'list') {
      if (!children.length) throw rpcMissing();
      const entries = new Map<string, boolean>();
      for (const key of children) {
        const parts = key.slice(relative.length + 1).split('/');
        entries.set(parts[0], Boolean(entries.get(parts[0])) || parts.length > 1);
      }
      result = { entries: [...entries].reverse().map(([name, dir]) => ({ name, dir, stats: { symlink: links.has(relative + '/' + name) } })) };
    } else assert.fail('Preparation must never dispatch a command or file mutation: ' + String(request.op));
    afterRpc?.(request);
    return result;
  };
  async function dispose() {
    closeConnection();
    if (previousDatabase === undefined) delete process.env.DATABASE_PATH; else process.env.DATABASE_PATH = previousDatabase;
    assert.equal(path.dirname(path.resolve(root)), path.resolve(tmpdir()));
    assert.ok(path.basename(root).startsWith('project-runtime-integration-'));
    await rm(root, { recursive: true, force: true });
  }
  const options: Options = { cwd: hostDecoy, permissionMode: 'default', systemPrompt: { type: 'preset', preset: 'claude_code', append: 'Caller instruction' } };
  return { root, account, hostDecoy, descriptor, launch, controller, options, requests, remote, links, execute, assertCurrent, dispose,
    setCurrent(value: boolean) { current = value; }, afterRpc(value: typeof afterRpc) { afterRpc = value; }, checks: () => checks };
}

async function fixture(files: Record<string, string>, run: (current: Fixture) => Promise<void>) {
  const current = await createFixture(files);
  try { await run(current); } finally { await current.dispose(); }
}
function input(current: Fixture) {
  return { launch: current.launch, descriptor: current.descriptor, signal: current.controller.signal, options: current.options,
    execute: current.execute, assertCurrent: current.assertCurrent };
}
function serverTool(runtime: Awaited<ReturnType<typeof prepareProjectRuntime>>, name: string) {
  const tool = (runtime.server as unknown as MockServer).tools.find(candidate => candidate.name === name);
  assert.ok(tool, 'expected project context tool ' + name);
  return tool;
}
function manifest(current: Fixture) {
  return getProjectRuntimeManifest(current.launch.userId, current.descriptor.projectId, { accountKey: current.launch.accountKey, generation: current.descriptor.generation, workspaceId: current.descriptor.workspaceId });
}
function prompt(options: Options) {
  const value = options.systemPrompt;
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.join('\n');
  if (!value) return '';
  if (value.type === 'preset') return value.append ?? '';
  return Array.isArray(value.prompt) ? value.prompt.join('\n') : value.prompt;
}

test('preparation loads remote instructions, selected account policy and cloud memory before query with retained public MCP provenance', async () => fixture({
  'CLAUDE.md': 'Remote instructions\n@docs/guide.md',
  'docs/guide.md': 'Remote imported guidance',
  '.claude/settings.json': JSON.stringify({ enabledMcpJsonServers: ['docs'], permissions: { deny: ['Bash'], ask: ['Read'] } }),
  '.claude/settings.local.json': JSON.stringify({ permissions: { allow: ['Write'] } }),
  '.claude/rules/typescript.md': definition('paths: "src/**/*.ts"', 'TypeScript scoped rule'),
  '.claude/skills/check/SKILL.md': definition('description: Verify changes', 'Check body $ARGUMENTS'),
  '.mcp.json': JSON.stringify({ mcpServers: { docs: { type: 'http', url: 'https://docs.example.com/mcp', headers: { Authorization: 'Bearer remote-fixture-secret' } },
    windowsOnly: { command: 'C:\\Tools\\server.exe' } } }),
}, async current => {
  await writeFile(path.join(current.account, 'settings.json'), JSON.stringify({ permissions: { deny: ['mcp__docs__danger'] } }));
  await writeFile(path.join(current.account, '.claude.json'), JSON.stringify({ mcpServers: { accountDocs: { type: 'sse', url: 'https://account.example.com/events' } } }));
  writeProjectMemory(current.launch.userId, current.descriptor.projectId, 'Cloud-owned remembered note', readProjectMemory(current.launch.userId, current.descriptor.projectId).hash);
  current.launch.prompt = '/check main';
  current.options.allowedTools = ['mcp__workspace__*', 'mcp__docs__*'];
  current.options.permissionMode = 'bypassPermissions';
  // The provider captures options before the bridge clones and restricts them.
  // Model that original bypass snapshot so an omitted force-ask flag would allow.
  const originalProviderOptions = { ...current.options };
  let prompted = 0;
  const permissionContexts: Array<Parameters<NonNullable<Options['canUseTool']>>[2] & { chisaForceAsk?: boolean }> = [];
  current.options.canUseTool = async (_name, value, context) => {
    prompted++;
    permissionContexts.push(context);
    if (originalProviderOptions.permissionMode === 'bypassPermissions' && !(context as typeof context & { chisaForceAsk?: boolean }).chisaForceAsk) {
      return { behavior: 'allow', updatedInput: value };
    }
    return { behavior: 'deny', message: 'Fixture explicit approval needed' };
  };
  const runtime = await prepareProjectRuntime(input(current));
  assert.equal(sdkCalls, 0);
  assert.match(prompt(current.options), /Caller instruction/);
  assert.match(prompt(current.options), /Remote instructions[\s\S]*Remote imported guidance/);
  assert.match(prompt(current.options), /Check body main/);
  assert.match(prompt(current.options), /Cloud-owned remembered note/);
  assert.deepEqual(Object.keys(runtime.mcpServers).sort(), ['accountDocs', 'docs']);
  assert.equal(runtime.mcpServers.docs?.headers?.Authorization, 'Bearer remote-fixture-secret');
  const loaded = manifest(current)!;
  assert.equal(loaded.status, 'loaded');
  assert.match(loaded.configRevision, /^[a-f0-9]{64}$/);
  assert.ok(loaded.files.some(file => file.path === 'CLAUDE.md' && file.hash === hash(current.remote.get('CLAUDE.md')!)));
  assert.ok(loaded.files.some(file => file.path === '.mcp.json' && file.kind === 'mcp'));
  assert.deepEqual(loaded.skills.map(skill => [skill.name, skill.status]), [['check', 'activated']]);
  assert.ok(loaded.mcp.some(server => server.name === 'docs' && server.status === 'selected'));
  assert.ok(loaded.mcp.some(server => server.name === 'windowsOnly' && server.status === 'unsupported' && server.location === 'local'));
  assert.equal(JSON.stringify(loaded).includes('remote-fixture-secret'), false);
  assert.equal(getProjectRuntimeManifest(current.launch.userId, current.descriptor.projectId, { accountKey: 'foreign-account' }), null);
  assert.equal(current.options.allowedTools?.includes('mcp__workspace__read_file'), false, 'ask Read cannot become automatic');
  assert.equal(current.options.allowedTools?.includes('mcp__workspace__*'), false, 'a wildcard cannot bypass the narrower ask/deny rules');
  assert.equal(current.options.allowedTools?.includes('mcp__docs__*'), false, 'external MCP wildcard cannot bypass a project/account deny');
  const permission = current.options.canUseTool!;
  const context: Parameters<NonNullable<Options['canUseTool']>>[2] = { signal: current.controller.signal, toolUseID: 'tool-1', requestId: 'project-runtime-permission-request' };
  const commandDecision = await permission('mcp__workspace__run_command', {}, context);
  assert.ok(commandDecision, 'project deny returns an explicit permission decision');
  assert.equal(commandDecision.behavior, 'deny');
  const externalDecision = await permission('mcp__docs__danger', {}, context);
  assert.ok(externalDecision, 'account deny returns an explicit permission decision');
  assert.equal(externalDecision.behavior, 'deny');
  assert.equal(prompted, 0, 'project/account deny bypasses approval callback');
  const readDecision = await permission('mcp__workspace__read_file', {}, context);
  assert.ok(readDecision, 'project ask retains the explicit approval decision');
  assert.equal(readDecision.behavior, 'deny');
  assert.equal(prompted, 1, 'ask reaches the original explicit permission handler');
  assert.equal(permissionContexts[0]?.chisaForceAsk, true, 'project ask overrides the provider callback’s captured bypass options');
  assert.equal(permissionContexts[0]?.signal, context.signal);
  assert.equal(permissionContexts[0]?.toolUseID, context.toolUseID);
  assert.equal(permissionContexts[0]?.requestId, context.requestId);
  assert.equal(Object.hasOwn(context, 'chisaForceAsk'), false, 'the original SDK context is not mutated');
  assert.match(await runtime.rulesForPath('/workspace/src/main.ts'), /TypeScript scoped rule/);
  assert.equal(await runtime.rulesForPath('/workspace/docs/guide.md'), '');
  const activated = await serverTool(runtime, 'activate_skill').invoke({ name: 'check', arguments: 'extra' });
  assert.equal(activated.isError, undefined);
  assert.match(activated.content[0]!.text, /Check body extra/);
  runtime.observe({ type: 'system', subtype: 'init', mcp_servers: [{ name: 'docs', status: 'connected' }, { name: 'accountDocs', status: 'failed' }] });
  assert.ok(manifest(current)!.mcp.some(server => server.name === 'docs' && server.status === 'connected'));
  assert.ok(manifest(current)!.mcp.some(server => server.name === 'accountDocs' && server.status === 'failed'));
  runtime.close();
  assert.equal(manifest(current)?.status, 'completed');
  assert.ok(current.checks() > current.requests.length);
}));

test('missing remote configuration never falls back to the host metadata anchor', async () => fixture({}, async current => {
  await writeFile(path.join(current.hostDecoy, 'CLAUDE.md'), 'HOST DECOY MUST NEVER LOAD');
  const runtime = await prepareProjectRuntime(input(current));
  assert.doesNotMatch(prompt(current.options), /DECOY MUST NEVER LOAD/);
  assert.equal(manifest(current)?.files.length, 0);
  assert.ok(current.requests.every(request => ['lstat', 'read', 'list'].includes(String(request.op))));
  runtime.close();
}));

test('selected private account instructions and skill resources load without using another account or executing scripts', async () => fixture({}, async current => {
  const skillDirectory = path.join(current.account, 'skills', 'accountcheck');
  await mkdir(path.join(skillDirectory, 'references'), { recursive: true });
  await writeFile(path.join(current.account, 'CLAUDE.md'), 'Selected account private instructions');
  await writeFile(path.join(skillDirectory, 'SKILL.md'), definition('name: accountcheck\ndescription: Private account check', 'Account skill body $ARGUMENTS\nRead ${CLAUDE_SKILL_DIR}/references/guide.md'));
  await writeFile(path.join(skillDirectory, 'references', 'guide.md'), 'Private selected account resource');
  const foreignAccount = path.join(current.root, 'foreign-account');
  await mkdir(path.join(foreignAccount, 'skills', 'foreign'), { recursive: true });
  await writeFile(path.join(foreignAccount, 'CLAUDE.md'), 'FOREIGN ACCOUNT INSTRUCTIONS');
  await writeFile(path.join(foreignAccount, 'skills', 'foreign', 'SKILL.md'), definition('description: foreign', 'FOREIGN ACCOUNT SKILL'));
  current.launch.prompt = '/accountcheck target';
  const runtime = await prepareProjectRuntime(input(current));
  assert.match(prompt(current.options), /Selected account private instructions/);
  assert.match(prompt(current.options), /Account skill body target/);
  assert.match(prompt(current.options), /account-skill-resource:\/\/accountcheck\/references\/guide.md/);
  assert.doesNotMatch(prompt(current.options), /FOREIGN ACCOUNT/);
  assert.ok(manifest(current)!.files.some(file => file.path === 'account/CLAUDE.md' && file.hash === hash('Selected account private instructions')));
  assert.ok(manifest(current)!.skills.some(skill => skill.name === 'accountcheck' && skill.path.startsWith('account/') && skill.status === 'activated'));
  const activated = await serverTool(runtime, 'activate_skill').invoke({ name: 'accountcheck', arguments: 'manual' });
  assert.equal(activated.isError, undefined);
  assert.match(activated.content[0]!.text, /Account skill body manual/);
  assert.match(activated.content[0]!.text, /read_skill_resource/);
  const requestsBeforeResource = current.requests.length;
  const resource = await serverTool(runtime, 'read_skill_resource').invoke({ name: 'accountcheck', path: 'references/guide.md' });
  assert.equal(resource.isError, undefined);
  const body = JSON.parse(resource.content[0]!.text) as { content: string; hash: string; path: string };
  assert.equal(body.content, 'Private selected account resource');
  assert.equal(body.hash, hash(body.content));
  assert.ok(body.path.startsWith('account/'));
  assert.equal(current.requests.length, requestsBeforeResource, 'account resources never fall through to the Windows project RPC');
  const unknown = await serverTool(runtime, 'read_skill_resource').invoke({ name: 'foreign', path: 'SKILL.md' });
  assert.equal(unknown.isError, true);
  assert.ok(current.requests.every(request => ['lstat', 'read', 'list'].includes(String(request.op))));
  assert.equal(sdkCalls, 0);
  runtime.close();
}));

test('the admitted project skill wins a duplicate private account name for prompt and tool activation', async () => fixture({
  '.claude/skills/shared/SKILL.md': definition('name: shared\ndescription: Project takes precedence', 'PROJECT PRIORITY BODY $ARGUMENTS'),
}, async current => {
  const skillDirectory = path.join(current.account, 'skills', 'shared');
  await mkdir(skillDirectory, { recursive: true });
  await writeFile(path.join(skillDirectory, 'SKILL.md'), definition('name: shared\ndescription: Account fallback', 'ACCOUNT FALLBACK BODY $ARGUMENTS'));
  await writeFile(path.join(skillDirectory, 'private.md'), 'ACCOUNT RESOURCE MUST NOT BE EXPOSED AS PROJECT RESOURCE');
  current.launch.prompt = '/shared prompt';
  const runtime = await prepareProjectRuntime(input(current));
  assert.match(prompt(current.options), /PROJECT PRIORITY BODY prompt/);
  assert.doesNotMatch(prompt(current.options), /ACCOUNT FALLBACK BODY/);
  const skills = manifest(current)!.skills.filter(skill => skill.name === 'shared');
  assert.equal(skills.length, 1);
  assert.equal(skills[0]!.path, '.claude/skills/shared/SKILL.md');
  const activated = await serverTool(runtime, 'activate_skill').invoke({ name: 'shared', arguments: 'tool' });
  assert.equal(activated.isError, undefined);
  assert.match(activated.content[0]!.text, /PROJECT PRIORITY BODY tool/);
  assert.doesNotMatch(activated.content[0]!.text, /ACCOUNT FALLBACK BODY/);
  assert.equal((await serverTool(runtime, 'read_skill_resource').invoke({ name: 'shared', path: 'private.md' })).isError, true);
  runtime.close();
}));

test('private account skill resources reject credential traversal, absolute paths and post-discovery symbolic links', async () => fixture({}, async current => {
  const skillDirectory = path.join(current.account, 'skills', 'guarded');
  await mkdir(skillDirectory, { recursive: true });
  await writeFile(path.join(skillDirectory, 'SKILL.md'), definition('description: Guarded resource', 'Read a resource explicitly'));
  await writeFile(path.join(current.account, '.credentials.json'), 'ACCOUNT CREDENTIAL SENTINEL');
  const outside = path.join(current.root, 'outside-resource');
  await mkdir(outside);
  await writeFile(path.join(outside, 'private.txt'), 'OUTSIDE CREDENTIAL SENTINEL');
  const runtime = await prepareProjectRuntime(input(current));
  const resourceTool = serverTool(runtime, 'read_skill_resource');
  for (const candidate of ['../.credentials.json', '../../.credentials.json', 'references/../../.credentials.json', '/etc/passwd', 'C:\\credentials.json']) {
    const denied = await resourceTool.invoke({ name: 'guarded', path: candidate });
    assert.equal(denied.isError, true, candidate);
    assert.doesNotMatch(denied.content[0]!.text, /CREDENTIAL SENTINEL/);
  }
  await symlink(outside, path.join(skillDirectory, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  const linked = await resourceTool.invoke({ name: 'guarded', path: 'linked/private.txt' });
  assert.equal(linked.isError, true);
  assert.match(linked.content[0]!.text, /[Ll]ink/);
  assert.doesNotMatch(linked.content[0]!.text, /OUTSIDE CREDENTIAL SENTINEL/);
  assert.equal(JSON.stringify(manifest(current)).includes('CREDENTIAL SENTINEL'), false);
  runtime.close();
}));

test('advanced skills remain explicitly unsupported and never activate through context tools', async () => fixture({
  '.claude/skills/fork/SKILL.md': definition('description: Advanced\ncontext: fork\nagent: Explore', 'Must not become executable'),
}, async current => {
  const runtime = await prepareProjectRuntime(input(current));
  assert.equal(manifest(current)?.skills[0]?.status, 'unsupported');
  const activated = await serverTool(runtime, 'activate_skill').invoke({ name: 'fork', arguments: '' });
  assert.equal(activated.isError, true);
  assert.match(activated.content[0]!.text, /unsupported activation/);
  assert.equal(manifest(current)?.skills[0]?.status, 'unsupported');
  runtime.close(true);
  assert.equal(manifest(current)?.status, 'failed');
}));

test('present malformed configuration fails before query and persists sanitized failure provenance', async () => fixture({
  '.claude/settings.json': '{malformed',
}, async current => {
  await assert.rejects(prepareProjectRuntime(input(current)), { code: 'PROJECT_RUNTIME_CONFIG_INVALID' });
  assert.equal(sdkCalls, 0);
  assert.equal(manifest(current)?.status, 'failed');
  assert.match(manifest(current)!.error!, /PROJECT_RUNTIME_CONFIG_INVALID/);
  assert.doesNotMatch(manifest(current)!.error!, /\{malformed/);
  assert.match(prompt(current.options), /Caller instruction/);
}));

test('symbolic-link components and oversized remote content fail without host fallback or mutations', async () => {
  for (const scenario of ['link', 'oversize']) await fixture({ 'CLAUDE.md': scenario === 'oversize' ? 'x'.repeat(256 * 1024 + 1) : 'linked source' }, async current => {
    if (scenario === 'link') current.links.add('CLAUDE.md');
    await assert.rejects(prepareProjectRuntime(input(current)), { code: scenario === 'link' ? 'PROJECT_RUNTIME_PATH_INVALID' : 'PROJECT_RUNTIME_LIMIT' });
    assert.equal(manifest(current)?.status, 'failed');
    assert.equal(current.requests.some(request => request.op === 'read'), false);
  });
});

test('generation changes and cancellation after admitted RPC prevent preparation and persist failed status', async () => {
  for (const scenario of ['generation', 'abort']) await fixture({ 'CLAUDE.md': 'remote' }, async current => {
    current.afterRpc(() => { if (scenario === 'generation') current.setCurrent(false); else current.controller.abort(new Error('fixture disconnected')); });
    await assert.rejects(prepareProjectRuntime(input(current)), scenario === 'generation' ? { code: 'WORKSPACE_GENERATION_CHANGED' } : /fixture disconnected/);
    assert.equal(manifest(current)?.status, 'failed');
    assert.equal(current.requests.length, 1);
  });
});

test('project dontAsk denies unlisted and ask-scoped tools before an original bypass callback can allow them', async () => fixture({
  '.claude/settings.json': JSON.stringify({ permissions: { defaultMode: 'dontAsk', ask: ['Read'] } }),
}, async current => {
  current.options.permissionMode = 'bypassPermissions';
  current.options.allowedTools = ['mcp__workspace__read_file', 'mcp__workspace__list_files'];
  const capturedProviderOptions = { ...current.options };
  let callbackCalls = 0;
  current.options.canUseTool = async (_name, value) => {
    callbackCalls++;
    assert.equal(capturedProviderOptions.permissionMode, 'bypassPermissions');
    return { behavior: 'allow', updatedInput: value };
  };
  const runtime = await prepareProjectRuntime(input(current));
  assert.equal(current.options.permissionMode, 'dontAsk');
  assert.equal(current.options.allowedTools?.includes('mcp__workspace__read_file'), false);
  assert.equal(current.options.allowedTools?.includes('mcp__workspace__list_files'), true);
  const permission = current.options.canUseTool!;
  const context: Parameters<NonNullable<Options['canUseTool']>>[2] = { signal: current.controller.signal, toolUseID: 'dont-ask-tool', requestId: 'project-runtime-dont-ask-request' };
  for (const name of ['mcp__workspace__run_command', 'mcp__workspace__read_file']) {
    const decision = await permission(name, {}, context);
    assert.ok(decision, 'dontAsk returns an explicit permission decision for ' + name);
    assert.equal(decision.behavior, 'deny', name);
    assert.equal(callbackCalls, 0, 'dontAsk rejects without consulting the captured bypass callback');
  }
  const listDecision = await permission('mcp__workspace__list_files', {}, context);
  assert.ok(listDecision, 'the explicitly allowed inspection returns a permission decision');
  assert.equal(listDecision.behavior, 'allow');
  assert.equal(callbackCalls, 1, 'an explicitly allowed non-ask inspection remains available');
  assert.equal((runtime.server as unknown as MockServer).tools.some(tool => tool.name === 'write_memory'), false);
  runtime.close();
}));

test('cached context tools recheck generation and plan mode omits cloud memory mutation and external MCP', async () => fixture({
  '.claude/settings.json': JSON.stringify({ enabledMcpJsonServers: ['docs'] }),
  '.mcp.json': JSON.stringify({ mcpServers: { docs: { type: 'http', url: 'https://docs.example.com/mcp' } } }),
}, async current => {
  current.options.permissionMode = 'plan';
  writeProjectMemory(current.launch.userId, current.descriptor.projectId, 'Readable in plan', readProjectMemory(current.launch.userId, current.descriptor.projectId).hash);
  const runtime = await prepareProjectRuntime(input(current));
  assert.deepEqual(runtime.mcpServers, {});
  assert.ok(!(runtime.server as unknown as MockServer).tools.some(tool => tool.name === 'write_memory'));
  const memory = await serverTool(runtime, 'read_memory').invoke({});
  assert.match(memory.content[0]!.text, /Readable in plan/);
  const before = current.requests.length;
  current.setCurrent(false);
  await assert.rejects(runtime.rulesForPath('src/main.ts'), { code: 'WORKSPACE_GENERATION_CHANGED' });
  assert.equal((await serverTool(runtime, 'read_memory').invoke({})).isError, true);
  assert.equal(current.requests.length, before);
  runtime.close(true);
  assert.equal(manifest(current)?.status, 'failed');
}));

test('project defaults apply only without a current session model and report ignored effort', async () => fixture({
  '.claude/settings.json': JSON.stringify({ model: 'fixture-model', effortLevel: 'high' }),
}, async current => {
  const runtime = await prepareProjectRuntime(input(current));
  assert.equal(current.options.model, 'fixture-model');
  assert.match(manifest(current)!.warnings.join('\n'), /effortLevel/);
  runtime.close();
  current.options.model = 'chosen-session-model';
  const next = await prepareProjectRuntime(input(current));
  assert.equal(current.options.model, 'chosen-session-model');
  assert.match(manifest(current)!.warnings.join('\n'), /模型默认值/);
  next.close();
}));

test('discovered linked rules fail explicitly rather than silently disappearing', async () => fixture({
  '.claude/rules/linked.md': 'Linked rule must not be silently ignored',
}, async current => {
  current.links.add('.claude/rules/linked.md');
  await assert.rejects(prepareProjectRuntime(input(current)), { code: 'PROJECT_RUNTIME_PATH_INVALID' });
  assert.equal(manifest(current)?.status, 'failed');
}));

test('corrupt cloud memory fails preparation and records a failed rather than loaded manifest', async () => fixture({ 'CLAUDE.md': 'Remote' }, async current => {
  writeProjectMemory(current.launch.userId, current.descriptor.projectId, 'original', readProjectMemory(current.launch.userId, current.descriptor.projectId).hash);
  getConnection().prepare("UPDATE app_config SET value = ? WHERE key LIKE 'project-runtime:memory:%'").run('\u0000invalid');
  await assert.rejects(prepareProjectRuntime(input(current)), { code: 'PROJECT_MEMORY_INVALID' });
  assert.equal(manifest(current)?.status, 'failed');
}));

test('explicit string system prompts retain caller instructions while appending remote context', async () => fixture({ 'CLAUDE.md': 'Remote append' }, async current => {
  current.options.systemPrompt = 'Caller full system instructions';
  const runtime = await prepareProjectRuntime(input(current));
  assert.match(prompt(current.options), /Caller full system instructions/);
  assert.match(prompt(current.options), /Remote append/);
  runtime.close();
}));
