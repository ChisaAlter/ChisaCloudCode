import path from 'node:path';

import { AppError, parseFrontMatter } from '@/shared/index.js';
import type { FileTreeFileSystem, WorkspaceDescriptor, WorkspaceSelector } from '@/shared/index.js';

type CommandContext = {
  projectId?: string;
  projectPath?: string;
  workspaceId?: string;
  generation?: string;
  sessionId?: string;
  provider?: unknown;
  model?: unknown;
  tokenUsage?: unknown;
};
type CommandDefinition = {
  name: string;
  description: string;
  namespace: string;
  metadata: Record<string, unknown>;
  path?: string;
  relativePath?: string;
};
type CommandsDependencies = {
  files: Pick<FileTreeFileSystem, 'lstat' | 'openDirectory' | 'realpath' | 'readTextFile'>;
  homeDirectory(): string;
  readPackage(): Promise<string>;
  models: typeof import('@/modules/providers/index.js').providerModelsService;
  workspace: {
    resolve(projectId: string, selector?: WorkspaceSelector): WorkspaceDescriptor;
    assert(descriptor: WorkspaceDescriptor): void;
    isBound(candidate: string): boolean;
    projectIdForPath(candidate: string): string | null;
  };
  runtime: {
    uptime(): number;
    memoryUsage(): NodeJS.MemoryUsage;
    version: string;
    platform: NodeJS.Platform;
    pid: number;
  };
};

const builtInCommands: CommandDefinition[] = [
  { name: '/help', description: 'Show help documentation for Claude Code', namespace: 'builtin', metadata: { type: 'builtin' } },
  { name: '/models', description: 'View available models for the current provider', namespace: 'builtin', metadata: { type: 'builtin' } },
  { name: '/cost', description: 'Display token usage information', namespace: 'builtin', metadata: { type: 'builtin' } },
  { name: '/memory', description: 'Open CLAUDE.md memory file for editing', namespace: 'builtin', metadata: { type: 'builtin' } },
  { name: '/config', description: 'Open settings and configuration', namespace: 'builtin', metadata: { type: 'builtin' } },
  { name: '/status', description: 'Show system status and version information', namespace: 'builtin', metadata: { type: 'builtin' } },
];
const providerLabels = { claude: 'Claude', cursor: 'Cursor', codex: 'Codex', opencode: 'OpenCode' };

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function errorCode(error: unknown): unknown { return record(error).code; }
function selectionError(message: string, code = 'WORKSPACE_SELECTION_MISMATCH', statusCode = 409): AppError {
  return new AppError(message, { code, statusCode });
}
function denied(): AppError {
  return new AppError('Command files must stay inside the selected .claude/commands directory without private paths or symbolic links', { code: 'COMMAND_PATH_DENIED', statusCode: 403 });
}
function under(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== '' && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}
function privatePath(relative: string): boolean {
  return relative.split(/[\\/]/).some(part => part.toLowerCase().startsWith('.chisa-'));
}

/** Commands composition and tests use this service to prepare prompts inside a verified workspace. */
export function createCommandsService(dependencies: CommandsDependencies) {
  const { files, workspace, models, runtime } = dependencies;

  function resolveContext(context: CommandContext): WorkspaceDescriptor | undefined {
    const selector = context.workspaceId && context.generation
      ? { workspaceId: context.workspaceId, generation: context.generation }
      : undefined;
    if (Boolean(context.workspaceId) !== Boolean(context.generation)) {
      throw selectionError('workspaceId and generation must be supplied together', 'INVALID_WORKSPACE_SELECTOR', 400);
    }
    let projectId = context.projectId;
    if (!projectId && selector) throw selectionError('projectId is required with a workspace selector', 'PROJECT_ID_REQUIRED', 400);
    if (!projectId && context.projectPath) {
      // Only registered, unbound legacy clients may select by path. A bound
      // project requires the explicit durable id even when its path is known.
      if (workspace.isBound(context.projectPath)) throw selectionError('projectId is required for a bound project', 'PROJECT_ID_REQUIRED', 400);
      projectId = workspace.projectIdForPath(context.projectPath) ?? undefined;
      if (!projectId) throw selectionError('Project not found', 'PROJECT_NOT_FOUND', 404);
    }
    if (!projectId) return undefined;
    if (!selector) return workspace.resolve(projectId);
    if (!context.sessionId) return workspace.resolve(projectId, selector);
    try {
      return workspace.resolve(projectId, { ...selector, sessionId: context.sessionId });
    } catch (error) {
      // The catalog has already verified durable session/project ownership.
      // Never convert stale identity, a missing session or another session's
      // workspace into permission to read the source replica.
      if (errorCode(error) !== 'WORKSPACE_SESSION_NOT_READY') throw error;
      const replica = workspace.resolve(projectId, selector);
      if (replica.kind !== 'cloudReplica') throw selectionError('An unmaterialized session may only select its cloud replica');
      return replica;
    }
  }

  async function inContext<T extends Record<string, unknown>>(
    context: CommandContext,
    operation: (root: string | undefined, checked: <R>(read: () => Promise<R>) => Promise<R>) => Promise<T>,
  ): Promise<T & { workspace?: WorkspaceDescriptor }> {
    const descriptor = resolveContext(context);
    const assertCurrent = () => {
      if (!descriptor) return;
      const current = resolveContext(context);
      if (!current || current.workspaceId !== descriptor.workspaceId || current.generation !== descriptor.generation
        || current.projectId !== descriptor.projectId || current.rootPath !== descriptor.rootPath
        || current.sourceRoot !== descriptor.sourceRoot || current.sessionId !== descriptor.sessionId
        || current.kind !== descriptor.kind || current.effectiveMode !== descriptor.effectiveMode) {
        throw selectionError('Workspace changed while preparing the command');
      }
      workspace.assert(descriptor);
    };
    const checked = async <R>(read: () => Promise<R>): Promise<R> => {
      assertCurrent();
      try { return await read(); }
      finally { assertCurrent(); }
    };
    const result = await checked(() => operation(descriptor?.rootPath, checked));
    return { ...result, ...(descriptor ? { workspace: descriptor } : {}) };
  }

  async function safePath(root: string, candidate: string, checked: <R>(read: () => Promise<R>) => Promise<R>) {
    const relative = path.relative(root, candidate);
    if (!under(root, candidate) || privatePath(relative)) throw denied();
    let current = root;
    const ancestors = relative.split(path.sep).map(part => { current = path.join(current, part); return current; });
    // Independent metadata reads share one bridge batch. Every component is still
    // checked before canonicalization, and callers repeat this full check after reading content.
    const results = await Promise.allSettled(ancestors.map(ancestor => checked(() => files.lstat(ancestor))));
    const stats = results.map(result => {
      if (result.status === 'rejected') throw result.reason;
      if (result.value.isSymbolicLink()) throw denied();
      return result.value;
    });
    const [canonicalRoot, canonicalPath] = await Promise.all([checked(() => files.realpath(root)), checked(() => files.realpath(candidate))]);
    if (!under(canonicalRoot, canonicalPath) || privatePath(path.relative(canonicalRoot, canonicalPath))) throw denied();
    return stats[stats.length - 1]!;
  }

  async function scan(root: string, namespace: string, checked: <R>(read: () => Promise<R>) => Promise<R>): Promise<CommandDefinition[]> {
    const base = path.join(root, '.claude', 'commands');
    const commands: CommandDefinition[] = [];
    async function visit(directory: string): Promise<void> {
      const directoryStats = await safePath(root, directory, checked);
      if (!directoryStats.isDirectory()) return;
      const entries = await checked(async () => {
        const result = [];
        for await (const entry of files.openDirectory(directory)) result.push(entry);
        return result;
      });
      for (const entry of entries) {
        if (!entry.name || entry.name === '.' || entry.name === '..' || /[\\/]/.test(entry.name) || privatePath(entry.name)) continue;
        const fullPath = path.join(directory, entry.name);
        const stats = await checked(() => files.lstat(fullPath));
        if (stats.isSymbolicLink()) continue;
        if (stats.isDirectory()) { await visit(fullPath); continue; }
        if (!entry.name.endsWith('.md') || (stats.mode & 0o170000) !== 0o100000) continue;
        await safePath(root, fullPath, checked);
        const text = await checked(() => files.readTextFile(fullPath));
        await safePath(root, fullPath, checked);
        let parsed: ReturnType<typeof parseFrontMatter>;
        try { parsed = parseFrontMatter(text); }
        catch { continue; }
        const relativePath = path.relative(base, fullPath);
        const metadata = record(parsed.data);
        commands.push({
          name: '/' + relativePath.replace(/\.md$/, '').replace(/\\/g, '/'),
          path: fullPath,
          relativePath,
          description: typeof metadata.description === 'string' ? metadata.description : (parsed.content.trim().split('\n')[0] ?? '').replace(/^#+\s*/, '').trim(),
          namespace,
          metadata,
        });
      }
    }
    try { await safePath(root, base, checked); }
    catch (error) {
      // Only an absent optional command folder is normal. Losing a file during
      // traversal must not turn an interrupted scan into a partial success.
      if (errorCode(error) === 'ENOENT') return [];
      throw error;
    }
    await visit(base);
    return commands;
  }

  async function builtin(command: string, context: CommandContext, root: string | undefined, checked: <R>(read: () => Promise<R>) => Promise<R>): Promise<Record<string, unknown>> {
    const candidate = typeof context.provider === 'string' ? context.provider.trim().toLowerCase() : '';
    const provider = Object.hasOwn(providerLabels, candidate) ? candidate as keyof typeof providerLabels : 'claude';
    const resolveModel = async () => (await models.resolveSessionModel(provider, {
      sessionId: context.sessionId,
      requestedModel: typeof context.model === 'string' ? context.model : undefined,
    })).model;
    let data: Record<string, unknown>;
    if (command === '/help') {
      data = {
        content: '# Claude Code Commands\n\n## Built-in Commands\n\n' + builtInCommands.map(item => `### ${item.name}\n${item.description}\n`).join('\n')
          + '\n## Custom Commands\n\nProject: `.claude/commands/`\nUser: `~/.claude/commands/`\n\nUse `$ARGUMENTS` for all arguments or `$1`, `$2`, etc. for positional arguments. File references (`@filename`) and bash instructions (`!command`) are passed to the chat provider in the selected workspace.\n',
        format: 'markdown', commands: builtInCommands.map(({ name, description, namespace }) => ({ name, description, namespace })),
      };
    } else if (command === '/config') {
      data = { message: 'Opening settings...' };
    } else if (command === '/memory') {
      if (!root) data = { error: 'No project selected', message: 'Please select a project to access its CLAUDE.md file' };
      else {
        const memoryPath = path.join(root, 'CLAUDE.md');
        let exists = false;
        try { const stats = await safePath(root, memoryPath, checked); exists = !stats.isDirectory(); }
        catch (error) { if (errorCode(error) !== 'ENOENT') throw error; }
        data = { path: memoryPath, exists, message: exists ? `Opening CLAUDE.md at ${memoryPath}` : `CLAUDE.md not found at ${memoryPath}. Create it to store project-specific instructions.` };
      }
    } else if (command === '/models') {
      const catalog = await checked(() => models.getProviderModels(provider));
      const model = await checked(resolveModel);
      const availableModels = catalog.OPTIONS.map(option => option.value);
      data = {
        current: { provider, providerLabel: providerLabels[provider], model },
        available: { [provider]: availableModels }, availableModels,
        availableOptions: catalog.OPTIONS.map(({ value, label, description, recordId, isCustom }) => ({ value, label, description, recordId, isCustom })),
        defaultModel: catalog.DEFAULT, message: `Current model: ${model}`,
      };
    } else if (command === '/cost') {
      const usage = record(context.tokenUsage);
      const breakdown = record(usage.breakdown);
      const directInput = usage.inputTokens ?? usage.input ?? usage.cumulativeInputTokens ?? breakdown.input ?? usage.promptTokens;
      const input = directInput == null
        ? (Number(usage.input_tokens ?? 0) || 0) + (Number(usage.cacheReadTokens ?? usage.cache_read_input_tokens ?? usage.cacheReadInputTokens ?? 0) || 0)
          + (Number(usage.cacheCreationTokens ?? usage.cache_creation_input_tokens ?? usage.cacheCreationInputTokens ?? 0) || 0)
        : Number(directInput) || 0;
      const output = Number(usage.outputTokens ?? usage.output ?? usage.output_tokens ?? usage.cumulativeOutputTokens ?? breakdown.output ?? usage.completionTokens ?? 0) || 0;
      data = {
        tokenUsage: { used: Math.max(Number(usage.used ?? usage.totalUsed ?? usage.total_tokens ?? 0) || 0, input + output), total: Number(usage.total ?? usage.contextWindow ?? 0) || 0 },
        ...(input + output > 0 ? { tokenBreakdown: { input, output } } : {}), provider, model: await checked(resolveModel),
      };
    } else {
      let info: Record<string, unknown> = {};
      try { info = record(JSON.parse(await checked(dependencies.readPackage))); }
      catch (error) { if (error instanceof AppError) throw error; }
      const uptime = runtime.uptime();
      const minutes = Math.floor(uptime / 60);
      const hours = Math.floor(minutes / 60);
      const memory = runtime.memoryUsage();
      data = {
        version: info.version ?? 'unknown', packageName: info.name ?? 'claude-code-ui',
        uptime: hours > 0 ? `${hours}h ${minutes % 60}m` : `${minutes}m`, uptimeSeconds: Math.floor(uptime),
        model: await checked(resolveModel), provider, nodeVersion: runtime.version, platform: runtime.platform, pid: runtime.pid,
        memoryUsage: { rssMb: Math.round(memory.rss / 1024 / 1024), heapUsedMb: Math.round(memory.heapUsed / 1024 / 1024), heapTotalMb: Math.round(memory.heapTotal / 1024 / 1024) },
      };
    }
    return { type: 'builtin', action: command.slice(1), command, data };
  }

  return {
    list(context: CommandContext) {
      return inContext(context, async (root, checked) => {
        const custom = root ? await scan(root, 'project', checked) : [];
        custom.push(...await scan(path.resolve(dependencies.homeDirectory()), 'user', checked));
        custom.sort((left, right) => left.name.localeCompare(right.name));
        return { builtIn: builtInCommands, custom, count: builtInCommands.length + custom.length };
      });
    },
    execute(input: { commandName: string; commandPath?: string; args: string[]; context: CommandContext }) {
      return inContext(input.context, async (root, checked) => {
        if (builtInCommands.some(command => command.name === input.commandName)) return builtin(input.commandName, input.context, root, checked);
        if (!input.commandPath) throw new AppError('Command path is required for custom commands', { code: 'COMMAND_PATH_REQUIRED', statusCode: 400 });
        const candidate = path.resolve(input.commandPath);
        const userRoot = path.resolve(dependencies.homeDirectory());
        const ownerRoot = root && under(path.join(root, '.claude', 'commands'), candidate) ? root
          : under(path.join(userRoot, '.claude', 'commands'), candidate) ? userRoot : undefined;
        if (!ownerRoot || !candidate.endsWith('.md')) throw denied();
        const stats = await safePath(ownerRoot, candidate, checked);
        if ((stats.mode & 0o170000) !== 0o100000) throw denied();
        const text = await checked(() => files.readTextFile(candidate));
        await safePath(ownerRoot, candidate, checked);
        const { data: metadata, content } = parseFrontMatter(text);
        // Leave provider file/bash instructions literal. They run only after
        // the composer confirms and chat revalidates this workspace selector.
        const processed = content.replace(/\$ARGUMENTS\b|\$(\d+)\b/g, (placeholder, index: string | undefined) =>
          placeholder === '$ARGUMENTS' ? input.args.join(' ') : input.args[Number(index) - 1] ?? placeholder);
        return { type: 'custom', command: input.commandName, content: processed, metadata, hasFileIncludes: processed.includes('@'), hasBashCommands: processed.includes('!') };
      });
    },
  };
}
