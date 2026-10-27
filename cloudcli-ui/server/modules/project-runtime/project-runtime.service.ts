import { randomUUID, createHash } from 'node:crypto';
import { constants, promises as fs } from 'node:fs';
import path from 'node:path';

import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import type { Options } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

import { AppError } from '@/shared/index.js';
import type { ProjectRuntimeLaunchContext, ProjectRuntimeManifest, WorkspaceDescriptor } from '@/shared/index.js';

import { createProjectContentResolver } from './project-runtime-content.service.js';
import { resolveProjectExtensions, matchesProjectExtensionPermission } from './project-runtime-extensions.service.js';
import { saveProjectRuntimeManifest, updateProjectRuntimeManifest, readProjectMemory, writeProjectMemory } from './project-runtime-state.service.js';

const MAX_FILE_BYTES = 256 * 1024;
type RpcResult = { b64?: string; hash?: string; size?: number; dir?: boolean; symlink?: boolean; mode?: number; path?: string; truncated?: boolean; entries?: Array<{ name: string; dir: boolean; stats?: { symlink?: boolean } }> };
type Input = {
  launch: ProjectRuntimeLaunchContext;
  descriptor: WorkspaceDescriptor;
  execute(request: Record<string, unknown>, signal?: AbortSignal): Promise<RpcResult>;
  assertCurrent(): void;
  signal: AbortSignal;
  options: Options;
};

function relativePath(candidate: string): string {
  const value = candidate.replace(/\\/g, '/').replace(/^\/workspace(?:\/|$)/, '');
  if (!value || value.startsWith('/') || value.startsWith('~') || /[\u0000-\u001f:]/.test(value)
    || value.split('/').some(part => part === '..' || part === '.' || !part || part.toLowerCase().startsWith('.chisa-'))) {
    throw new AppError('Project configuration must remain inside the selected workspace.', { code: 'PROJECT_RUNTIME_PATH_INVALID', statusCode: 400 });
  }
  return value;
}
function missing(error: unknown): boolean { return ['ENOENT', 'ENOTDIR'].includes(String((error as { code?: string })?.code)); }
function globMatch(pattern: string, name: string): boolean {
  return matchesProjectExtensionPermission(pattern, name);
}
function overlaps(left: string, right: string): boolean {
  if (globMatch(left, right) || globMatch(right, left)) return true;
  if (!left.includes('*') || !right.includes('*')) return false;
  const a = left.slice(0, left.indexOf('*')), b = right.slice(0, right.indexOf('*'));
  return a.startsWith(b) || b.startsWith(a);
}

/** Providers and bridge compose one cloud-owned configuration snapshot after exact workspace admission; remote content is read through execute, never the VPS metadata directory. */
export async function prepareProjectRuntime(input: Input) {
  const { launch, descriptor, options, signal } = input;
  const check = () => { signal.throwIfAborted(); input.assertCurrent(); };
  const runId = randomUUID();
  const manifest: ProjectRuntimeManifest = { runId, sessionId: launch.sessionId, projectId: descriptor.projectId,
    workspaceId: descriptor.workspaceId, generation: descriptor.generation, at: new Date().toISOString(), configRevision: '',
    status: 'loading', files: [], skills: [], mcp: [], warnings: [] };
  check();
  saveProjectRuntimeManifest(launch.userId, manifest, launch.accountKey);
  const persist = () => { check(); updateProjectRuntimeManifest(launch.userId, descriptor.projectId, runId, manifest, launch.accountKey); };
  const call = async (request: Record<string, unknown>) => { check(); const value = await input.execute(request, signal); check(); return value; };
  // The Windows helper already refuses links/reparse points. The cloud adapter
  // is checked component by component too, rather than trusting a text prefix.
  const safePath = async (candidate: string) => {
    const relative = relativePath(candidate);
    let cursor = '';
    let result: RpcResult = {};
    for (const component of relative.split('/')) {
      cursor += '/' + component;
      result = await call({ op: 'lstat', path: '/workspace' + cursor });
      if (result.symlink || ((result.mode ?? 0) & 0o170000) === 0o120000) throw new AppError('Linked project configuration is unsupported.', { code: 'PROJECT_RUNTIME_PATH_INVALID', statusCode: 400 });
    }
    return result;
  };
  const read = async (candidate: string): Promise<{ content: string; hash: string } | null> => {
    const relative = relativePath(candidate);
    try {
      const before = await safePath(relative);
      if (before.dir) throw new AppError('A project configuration file is a directory.', { code: 'PROJECT_RUNTIME_CONFIG_INVALID', statusCode: 400 });
      if ((before.size ?? 0) > MAX_FILE_BYTES) throw new AppError('Project configuration exceeds 256 KiB.', { code: 'PROJECT_RUNTIME_LIMIT', statusCode: 400 });
      const value = await call({ op: 'read', path: '/workspace/' + relative });
      await safePath(relative);
      if (typeof value.b64 !== 'string' || value.b64.length > Math.ceil(MAX_FILE_BYTES / 3) * 4 + 8) throw new AppError('Project configuration response exceeds its limit.', { code: 'PROJECT_RUNTIME_LIMIT', statusCode: 400 });
      const bytes = Buffer.from(value.b64, 'base64');
      if (bytes.length > MAX_FILE_BYTES) throw new AppError('Project configuration exceeds 256 KiB.', { code: 'PROJECT_RUNTIME_LIMIT', statusCode: 400 });
      return { content: new TextDecoder('utf-8', { fatal: true }).decode(bytes), hash: value.hash || createHash('sha256').update(bytes).digest('hex') };
    } catch (error) { check(); if (missing(error)) return null; throw error; }
  };
  const list = async (candidate: string) => {
    const relative = relativePath(candidate);
    try {
      const stats = await safePath(relative);
      if (!stats.dir) throw new AppError('A project configuration directory is not a directory.', { code: 'PROJECT_RUNTIME_CONFIG_INVALID', statusCode: 400 });
      const value = await call({ op: 'list', path: '/workspace/' + relative, includeStats: true });
      if (value.truncated || !Array.isArray(value.entries) || value.entries.length > 512) throw new AppError('Project configuration discovery exceeds its limit.', { code: 'PROJECT_RUNTIME_LIMIT', statusCode: 400 });
      await safePath(relative);
      if (value.entries.some(entry => entry.stats?.symlink)) throw new AppError('Linked project configuration entries are unsupported.', { code: 'PROJECT_RUNTIME_PATH_INVALID', statusCode: 400 });
      return value.entries.map(entry => ({ name: entry.name, directory: entry.dir }));
    } catch (error) { check(); if (missing(error)) return []; throw error; }
  };
  const accountRead = async (relative: string) => {
    check();
    const root = path.resolve(launch.configDir);
    const safe = relativePath(relative);
    const target = path.join(root, safe);
    try {
      let component = root;
      for (const part of safe.split('/')) {
        component = path.join(component, part);
        if ((await fs.lstat(component)).isSymbolicLink()) throw new AppError('Linked account configuration is unsupported.', { code: 'PROJECT_RUNTIME_PATH_INVALID', statusCode: 400 });
      }
      const metadata = await fs.lstat(target);
      if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 || metadata.size > MAX_FILE_BYTES) throw new AppError('Selected account configuration is not a bounded regular file.', { code: 'PROJECT_RUNTIME_CONFIG_INVALID', statusCode: 400 });
      if (path.resolve(await fs.realpath(target)) !== path.join(await fs.realpath(root), safe)) throw new AppError('Selected account configuration changed location.', { code: 'PROJECT_RUNTIME_PATH_INVALID', statusCode: 400 });
      const handle = await fs.open(target, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
      try {
        const opened = await handle.stat();
        if (opened.dev !== metadata.dev || opened.ino !== metadata.ino || opened.nlink !== 1 || !opened.isFile() || opened.size > MAX_FILE_BYTES) throw new AppError('Selected account configuration changed.', { code: 'PROJECT_RUNTIME_CONFIG_INVALID', statusCode: 409 });
        const text = await handle.readFile('utf8');
        check();
        if (Buffer.byteLength(text) > MAX_FILE_BYTES) throw new AppError('Selected account configuration exceeds its limit.', { code: 'PROJECT_RUNTIME_LIMIT', statusCode: 400 });
        return { content: text, hash: createHash('sha256').update(text).digest('hex') };
      } finally { await handle.close(); }
    } catch (error) { check(); if (missing(error)) return null; throw error; }
  };
  let remoteConfigBytes = 0;
  const measuredRead = async (candidate: string) => {
    const file = await read(candidate);
    remoteConfigBytes += file ? Buffer.byteLength(file.content, 'utf8') : 0;
    if (remoteConfigBytes > MAX_FILE_BYTES) throw new AppError('Combined project configuration exceeds 256 KiB.', { code: 'PROJECT_RUNTIME_LIMIT', statusCode: 400 });
    return file;
  };
  const resolver = createProjectContentResolver({ read: measuredRead, list, assertCurrent: check, signal });
  const accountList = async (candidate: string) => {
    check();
    if (!candidate.startsWith('.claude/skills')) return [];
    const relative = relativePath(candidate.replace(/^\.claude\//, ''));
    const root = path.resolve(launch.configDir);
    const directory = path.join(root, relative);
    try {
      let cursor = root;
      for (const part of relative.split('/')) {
        cursor = path.join(cursor, part);
        if ((await fs.lstat(cursor)).isSymbolicLink()) throw new AppError('Linked account skill directories are unsupported.', { code: 'PROJECT_RUNTIME_PATH_INVALID', statusCode: 400 });
      }
      const rows = await fs.readdir(directory, { withFileTypes: true });
      check();
      if (rows.length > 512 || rows.some(row => row.isSymbolicLink())) throw new AppError('Account skill discovery exceeds its safe bounds.', { code: 'PROJECT_RUNTIME_LIMIT', statusCode: 400 });
      return rows.map(row => ({ name: row.name, directory: row.isDirectory() }));
    } catch (error) { check(); if (missing(error)) return []; throw error; }
  };
  const accountResolver = createProjectContentResolver({
    read: relative => relative.startsWith('.claude/skills/') ? accountRead(relative.slice('.claude/'.length)) : Promise.resolve(null),
    list: accountList, assertCurrent: check, signal,
  });
  let accountRuntime: Awaited<ReturnType<typeof accountResolver.resolve>>;
  let runtime: Awaited<ReturnType<typeof resolver.resolve>>;
  let extensions: ReturnType<typeof resolveProjectExtensions>;
  try {
    runtime = await resolver.resolve({ prompt: launch.prompt });
    const command = /^\/([A-Za-z0-9_-]+)(?:\s|$)/.exec(launch.prompt.trim())?.[1]?.toLowerCase();
    accountRuntime = await accountResolver.resolve({ prompt: runtime.skills.some(skill => skill.name.toLowerCase() === command) ? '' : launch.prompt });
    const [accountSettings, accountMcp, projectMcp, accountInstructions] = await Promise.all([accountRead('settings.json'), accountRead('.claude.json'), read('.mcp.json'), accountRead('CLAUDE.md')]);
    if (accountInstructions) runtime.instructions = 'Cloud account instructions:\n' + accountInstructions.content + '\n\n' + runtime.instructions;
    runtime.instructions += accountRuntime.instructions ? '\n\nCloud account skill instructions:\n' + accountRuntime.instructions.replaceAll('/workspace/.claude/skills/', 'account-skill-resource://') : '';
    runtime.skills.push(...accountRuntime.skills.filter(skill => !runtime.skills.some(local => local.name.toLowerCase() === skill.name.toLowerCase())).map(skill => ({ ...skill, path: 'account/' + skill.path })));
    runtime.warnings.push(...accountRuntime.warnings.map(warning => 'account: ' + warning));
    for (const [file, label, kind] of [[accountSettings, 'account/settings.json', 'settings'], [accountMcp, 'account/.claude.json', 'mcp'], [projectMcp, '.mcp.json', 'mcp'], [accountInstructions, 'account/CLAUDE.md', 'instruction']] as const) {
      if (file) manifest.files.push({ path: label, hash: file.hash, kind });
    }
    const accountConfig = accountMcp ? JSON.parse(accountMcp.content) as Record<string, unknown> : {};
    const entries = accountConfig.projects && typeof accountConfig.projects === 'object' ? accountConfig.projects as Record<string, unknown> : {};
    const selected = entries[descriptor.sourceRoot] as { mcpServers?: Record<string, unknown> } | undefined;
    const rootServers = accountConfig.mcpServers && typeof accountConfig.mcpServers === 'object' ? accountConfig.mcpServers as Record<string, unknown> : {};
    extensions = resolveProjectExtensions({ accountSettings: accountSettings?.content,
      accountMcp: { mcpServers: { ...rootServers, ...selected?.mcpServers } }, projectMcp: projectMcp?.content,
      projectSettings: runtime.projectSettings, localSettings: runtime.localSettings,
      sessionPermissionMode: options.permissionMode, readOnly: input.options.permissionMode === 'plan' });
    if (extensions.configSources.some(source => source.status === 'invalid')) throw new AppError('Project MCP or account settings contain malformed JSON; inspect the configured source.', { code: 'PROJECT_RUNTIME_CONFIG_INVALID', statusCode: 400 });
    manifest.files.push(...runtime.sources, ...accountRuntime.sources.map(source => ({ ...source, path: 'account/' + source.path })));
    const explicitSkill = /^\/([A-Za-z0-9_-]+)(?:\s|$)/.exec(launch.prompt.trim())?.[1]?.toLowerCase();
    manifest.skills = runtime.skills.map(skill => ({ name: skill.name, path: skill.path,
      status: skill.unsupported.length ? 'unsupported' : explicitSkill === skill.name.toLowerCase() ? 'activated' : 'available',
      ...(skill.unsupported.length ? { reason: skill.unsupported.join(', ') } : {}) }));
    manifest.mcp = extensions.inventory.map(item => ({ name: item.name, transport: item.transport,
      location: item.transport === 'stdio' || item.reason === 'LOCAL_ENDPOINT_UNSUPPORTED' ? 'local' : 'cloud',
      status: item.status === 'enabled' ? 'selected' : item.status === 'invalid' ? 'failed' : item.status === 'shadowed' ? 'disabled' : item.status,
      ...(item.reason ? { reason: item.reason } : {}) }));
    manifest.warnings = [...runtime.warnings, ...extensions.warnings.map(warning => warning.source + ': ' + warning.code + ' — ' + warning.message)];
    if (manifest.files.length > 256 || manifest.skills.length > 100 || Buffer.byteLength(runtime.instructions, 'utf8') > MAX_FILE_BYTES) throw new AppError('Combined project and account context exceeds its limit.', { code: 'PROJECT_RUNTIME_LIMIT', statusCode: 400 });
    manifest.configRevision = createHash('sha256').update(JSON.stringify(manifest.files)).digest('hex');
    manifest.status = 'loaded';
    persist();
  } catch (error) {
    manifest.status = 'failed';
    manifest.error = error instanceof AppError ? error.code + ': ' + error.message : 'Project configuration could not be loaded.';
    // Failed/aborted preparation must remain diagnosable without hiding the primary error.
    updateProjectRuntimeManifest(launch.userId, descriptor.projectId, runId, manifest, launch.accountKey);
    throw error;
  }
  try {
  const before = options.systemPrompt;
  const append = typeof before === 'string' ? before : Array.isArray(before) ? before.join('\n') : typeof before === 'object' && before !== null && 'append' in before ? before.append || '' : '';
  if (extensions.defaults.model && options.model) manifest.warnings.push('项目模型默认值被当前会话的模型选择覆盖。');
  else if (extensions.defaults.model) options.model = extensions.defaults.model;
  if (extensions.defaults.effort) manifest.warnings.push('effortLevel 已读取；本轮沿用当前会话的推理强度选择。');
  const memory = readProjectMemory(launch.userId, descriptor.projectId);
  const catalog = runtime.skills.filter(skill => !skill.disableModelInvocation).map(skill => `${skill.name}: ${skill.description} (${skill.unsupported.length ? 'unsupported: ' + skill.unsupported.join(', ') : 'activate with project_context.activate_skill'})`).join('\n');
  options.systemPrompt = { type: 'preset', preset: 'claude_code', append: append + '\n\n' + runtime.instructions
    + (catalog ? '\n\nProject skills (read with project_context tools; this is not a native VPS Skill directory):\n' + catalog : '')
    + '\n\nProject configuration is loaded from the exact admitted remote workspace. File operations and project scripts must remain on that workspace. Scoped rules are returned with file reads; obtain rules before editing or running commands in a subdirectory.'
    + '\nProject memory is cloud-owned and isolated by application user and project. Use project_context.read_memory/write_memory for durable notes; never put credentials into memory.'
    + (memory.content ? '\n\nProject memory:\n' + memory.content : '') };
  const settings = typeof options.settings === 'object' ? options.settings : {};
  options.settings = { ...settings, permissions: extensions.settings.permissions };
  options.permissionMode = extensions.permissionMode as Options['permissionMode'];
  options.disallowedTools = [...new Set([...(options.disallowedTools ?? []), ...extensions.disallowedTools])];
  options.allowedTools = [...new Set([...(options.allowedTools ?? []), ...extensions.allowedTools])]
    .filter(name => ![...extensions.disallowedTools, ...extensions.askTools].some(rule => overlaps(rule, name)));
  const canUseTool = options.canUseTool;
  options.canUseTool = async (name, value, context) => {
    check();
    if (options.disallowedTools?.some(rule => globMatch(rule, name))) return { behavior: 'deny', message: 'Tool denied by project configuration.' };
    const requiresAsk = extensions.askTools.some(rule => globMatch(rule, name));
    if (options.permissionMode === 'dontAsk' && (requiresAsk || !options.allowedTools?.some(rule => globMatch(rule, name)))) return { behavior: 'deny', message: 'Unapproved tools are unavailable in dontAsk mode.' };
    return canUseTool ? canUseTool(name, value, requiresAsk ? { ...context, chisaForceAsk: true } as typeof context : context) : { behavior: 'deny', message: 'An explicit tool permission decision is required.' };
  };
  const result = async (action: () => Promise<unknown> | unknown) => {
    try { check(); const value = await action(); check(); return { content: [{ type: 'text' as const, text: typeof value === 'string' ? value : JSON.stringify(value) }] }; }
    catch (error) { return { isError: true, content: [{ type: 'text' as const, text: error instanceof AppError ? error.message : 'Project context request failed.' }] }; }
  };
  const contextTools = [
    tool('activate_skill', 'Read and activate a skill from this exact remote project. The returned instructions and relative resources execute through workspace tools; no VPS project shell is enabled.', { name: z.string(), arguments: z.string().default('') }, args => result(async () => {
      const metadata = runtime.skills.find(entry => entry.name.toLowerCase() === args.name.replace(/^\//, '').toLowerCase());
      const account = metadata?.path.startsWith('account/');
      const skill = await (account ? accountResolver : resolver).activateSkill(args.name, args.arguments);
      const item = manifest.skills.find(entry => entry.name === skill.name);
      if (item) item.status = 'activated';
      persist(); return account ? { ...skill, path: 'account/' + skill.path, body: skill.body.replaceAll('/workspace/.claude/skills/', 'account-skill-resource://') + '\nRead cloud account resources with project_context.read_skill_resource, not workspace file tools.' } : skill;
    })),
    tool('read_skill_resource', 'Read a bounded UTF-8 resource belonging to a selected cloud account skill; this cannot read credentials or arbitrary VPS files. Project skills use workspace file tools.', { name: z.string(), path: z.string() }, args => result(async () => {
      const metadata = runtime.skills.find(entry => entry.name.toLowerCase() === args.name.toLowerCase() && entry.path.startsWith('account/'));
      if (!metadata) throw new AppError('The selected account skill does not exist.', { code: 'PROJECT_RUNTIME_SKILL_NOT_FOUND', statusCode: 404 });
      const resource = relativePath(args.path);
      const relative = path.posix.join(path.posix.dirname(metadata.path.slice('account/.claude/'.length)), resource);
      const file = await accountRead(relative);
      if (!file) throw new AppError('The skill resource does not exist.', { code: 'PROJECT_RUNTIME_SKILL_NOT_FOUND', statusCode: 404 });
      return { path: 'account/' + relative, ...file };
    })),
    tool('read_rules', 'Read the project rules that apply to a relative or /workspace file path before modifying files or executing a project command.', { path: z.string() }, args => result(() => resolver.rulesForPath(args.path))),
    tool('read_memory', 'Read cloud project memory and its current SHA256 hash. Memory is isolated to this application user and stable project.', {}, () => result(() => readProjectMemory(launch.userId, descriptor.projectId))),
    ...((options.permissionMode === 'plan' || options.permissionMode === 'dontAsk') ? [] : [tool('write_memory', 'Replace cloud project memory using the exact last-read hash; do not store credentials. This does not write project files.', { content: z.string().max(65536), expectedHash: z.string() }, args => result(() => writeProjectMemory(launch.userId, descriptor.projectId, args.content, args.expectedHash)))]),
  ];
  const names = ['activate_skill', 'read_skill_resource', 'read_rules', 'read_memory', ...((options.permissionMode === 'plan' || options.permissionMode === 'dontAsk') ? [] : ['write_memory'])].map(name => 'mcp__project_context__' + name);
  const safeNames = names.filter(name => !name.endsWith('__write_memory') && !extensions.askTools.some(rule => globMatch(rule, name)) && !options.disallowedTools?.some(rule => globMatch(rule, name)));
  options.allowedTools = [...new Set([...(options.allowedTools ?? []), ...safeNames])];
  persist();
  return {
    server: createSdkMcpServer({ name: 'project_context', version: '1.0.0', tools: contextTools }),
    mcpServers: extensions.mcpServers,
    askTools: extensions.askTools,
    configuredAllowedTools: extensions.allowedTools,
    names,
    async rulesForPath(candidate: string) { check(); return resolver.rulesForPath(candidate); },
    observe(message: unknown) {
      if (!message || typeof message !== 'object') return;
      const event = message as { type?: string; subtype?: string; mcp_servers?: Array<{ name: string; status: string }> };
      if (event.type !== 'system' || event.subtype !== 'init' || !Array.isArray(event.mcp_servers)) return;
      for (const entry of manifest.mcp) {
        if (entry.status !== 'selected') continue;
        const actual = event.mcp_servers.find(server => server.name === entry.name);
        if (actual?.status === 'connected') entry.status = 'connected';
        else if (actual && ['failed', 'needs-auth', 'disabled'].includes(actual.status)) { entry.status = 'failed'; entry.reason = 'MCP_CONNECTION_' + actual.status.toUpperCase().replace('-', '_'); }
      }
      persist();
    },
    close(failed = false) {
      manifest.status = failed ? 'failed' : 'completed';
      if (failed && !manifest.error) manifest.error = 'Cloud run ended before configuration execution completed.';
      updateProjectRuntimeManifest(launch.userId, descriptor.projectId, runId, manifest, launch.accountKey);
    },
  };
  } catch (error) {
    manifest.status = 'failed';
    manifest.error = error instanceof AppError ? error.code + ': ' + error.message : 'Project context tools could not be prepared.';
    updateProjectRuntimeManifest(launch.userId, descriptor.projectId, runId, manifest, launch.accountKey);
    throw error;
  }
}
