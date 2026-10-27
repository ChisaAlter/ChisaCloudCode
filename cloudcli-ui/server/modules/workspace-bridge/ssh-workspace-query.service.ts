import { spawn } from 'node:child_process';
import { constants, promises as fs } from 'node:fs';
import path from 'node:path';

import { createSdkMcpServer, query as sdkQuery, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

import { prepareProjectRuntime, matchesProjectExtensionPermission } from '@/modules/project-runtime/index.js';
import type { ChatAttachmentDescriptor, ProjectRuntimeLaunchContext, SshProjectTarget, WorkspaceDescriptor } from '@/shared/index.js';
import { AppError, getGlobalImageAssetsDir, normalizeAttachmentDescriptors } from '@/shared/index.js';

import type { admitWorkspaceExecution } from './workspace-bridge.service.js';

type Admission = Awaited<ReturnType<typeof admitWorkspaceExecution>>;

// Availability and approval are separate: SDK allowedTools bypasses canUseTool.
// Keep project inspection automatic, but preserve the caller's write/command
// policy instead of granting every installed MCP tool an implicit approval.
const inspectionTools = new Set(['list_files', 'read_file', 'read_image', 'search_files', 'read_attachment']);
const permissionAliases: Record<string, string[]> = {
  list_files: ['Glob'], read_file: ['Read'], read_image: ['Read'], search_files: ['Grep', 'Glob'],
  read_attachment: ['Read'], write_file: ['Write', 'Edit', 'MultiEdit'], run_command: ['Bash'],
};

function matchesProjectPermission(rule: string, toolName: string): boolean {
  const shortName = toolName.replace(/^mcp__workspace__/, '');
  // Bash command patterns have shell-specific syntax; never reinterpret them
  // as PowerShell approval rules. Exact MCP/whole-tool grants remain explicit.
  return matchesProjectExtensionPermission(rule, toolName) || permissionAliases[shortName]?.includes(rule) === true;
}

function projectTools(admission: Admission, readOnly: boolean, signal: AbortSignal, attachments: ChatAttachmentDescriptor[], context?: Awaited<ReturnType<typeof prepareProjectRuntime>>) {
  const execute = (request: Record<string, unknown>) => admission.execute(request, signal);
  const result = async (request: Record<string, unknown>) => {
    try { return { content: [{ type: 'text' as const, text: JSON.stringify(await execute(request)) }] }; }
    catch (error) { return { isError: true, content: [{ type: 'text' as const, text: error instanceof Error ? error.message : String(error) }] }; }
  };
  const tools = [
    tool('list_files', 'List the selected Windows project. /workspace is a virtual project root, not a Linux mount.', { path: z.string().default('/workspace') }, a => result({ op: 'list', ...a })),
    tool('read_file', 'Read a Windows project file and its SHA256 hash; use this hash when writing. Binary files support base64.', { path: z.string(), encoding: z.enum(['utf8', 'base64']).default('utf8') }, async a => {
      try {
        const r = await execute({ op: 'read', path: a.path });
        return { content: [{ type: 'text' as const, text: JSON.stringify({ content: a.encoding === 'base64' ? r.b64 : new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(r.b64!, 'base64')), encoding: a.encoding, hash: r.hash, ...(context ? { projectRules: await context.rulesForPath(a.path) } : {}) }) }] };
      } catch (error) { return { isError: true, content: [{ type: 'text' as const, text: error instanceof Error ? error.message : String(error) }] }; }
    }),
    tool('read_image', 'Visually inspect a PNG, JPEG, GIF or WebP image in the Windows project. Use relative or /workspace paths.', { path: z.string() }, async a => {
      try {
        const r = await execute({ op: 'read', path: a.path });
        const bytes = Buffer.from(r.b64!, 'base64');
        const mimeType = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ? 'image/png'
          : bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 ? 'image/jpeg'
            : /^(GIF87a|GIF89a)$/.test(bytes.subarray(0, 6).toString('ascii')) ? 'image/gif'
              : bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP' ? 'image/webp' : null;
        if (!mimeType) throw new Error('Only PNG, JPEG, GIF and WebP images are supported.');
        if (bytes.length > 5 * 1024 * 1024) throw new Error('Images are limited to 5 MiB; resize the image first.');
        return { content: [{ type: 'image' as const, data: bytes.toString('base64'), mimeType }] };
      } catch (error) { return { isError: true, content: [{ type: 'text' as const, text: error instanceof Error ? error.message : String(error) }] }; }
    }),
    tool('search_files', 'Search filenames or text inside the Windows project.', { path: z.string().default('/workspace'), query: z.string(), content: z.boolean().default(false) }, a => result({ op: a.content ? 'grep' : 'search', path: a.path, query: a.query })),
    ...(attachments.length ? [tool('read_attachment', 'Read only a file explicitly attached to this turn in the VPS upload store. This does not read or execute any other VPS file.', { path: z.string(), encoding: z.enum(['utf8', 'base64']).default('utf8') }, async a => {
      try {
        admission.assertCurrent(); signal.throwIfAborted();
        const candidate = path.resolve(a.path);
        const descriptor = attachments.find(item => path.resolve(item.path) === candidate);
        const store = path.resolve(getGlobalImageAssetsDir());
        if (!descriptor || path.dirname(candidate) !== store) throw new Error('Attachment was not supplied with this turn.');
        const inspected = await fs.lstat(candidate);
        if (inspected.isSymbolicLink() || !inspected.isFile() || inspected.nlink !== 1) throw new Error('Linked attachments are not supported.');
        const canonicalStore = await fs.realpath(store);
        if (path.dirname(await fs.realpath(candidate)) !== canonicalStore) throw new Error('Attachment is outside the upload store.');
        const handle = await fs.open(candidate, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        try {
          const stats = await handle.stat();
          if (!stats.isFile() || stats.nlink !== 1 || stats.dev !== inspected.dev || stats.ino !== inspected.ino) throw new Error('Attachment changed while opening; attach it again.');
          if (stats.size > 8 * 1024 * 1024) throw new Error('Attachments are limited to 8 MiB.');
          const bytes = Buffer.alloc(8 * 1024 * 1024 + 1);
          let length = 0;
          while (length < bytes.length) {
            signal.throwIfAborted();
            const read = await handle.read(bytes, length, bytes.length - length, length);
            if (!read.bytesRead) break;
            length += read.bytesRead;
          }
          if (length > 8 * 1024 * 1024) throw new Error('Attachment exceeds the size limit.');
          admission.assertCurrent(); signal.throwIfAborted();
          const content = bytes.subarray(0, length);
          return { content: [{ type: 'text' as const, text: JSON.stringify({ content: a.encoding === 'base64' ? content.toString('base64') : new TextDecoder('utf-8', { fatal: true }).decode(content), encoding: a.encoding }) }] };
        } finally { await handle.close(); }
      } catch (error) { return { isError: true, content: [{ type: 'text' as const, text: error instanceof Error ? error.message : String(error) }] }; }
    })] : []),
    ...(!readOnly ? [
      tool('write_file', 'Write a UTF-8 project file. Existing files require the last read hash; new files require null. Conflicting IDE edits are rejected.', { path: z.string(), content: z.string(), expectedHash: z.string().nullable() }, a => result({ op: 'write', path: a.path, b64: Buffer.from(a.content, 'utf8').toString('base64'), expectedHash: a.expectedHash })),
      tool('run_command', 'Execute a Windows PowerShell command in the selected project via SSH. Use Windows commands and installed Windows SDKs. /workspace paths are tool aliases, not literal shell paths. Returns actual stdout, stderr and exit code. This is not a read-only sandbox.', { command: z.string(), path: z.string().default('/workspace'), timeoutSeconds: z.number().int().min(1).max(600).default(60) }, a => result({ op: 'exec', ...a })),
    ] : []),
  ];
  return { server: createSdkMcpServer({ name: 'workspace', version: '1.0.0', tools }), names: ['list_files', 'read_file', 'read_image', 'search_files', ...(attachments.length ? ['read_attachment'] : []), ...(!readOnly ? ['write_file', 'run_command'] : [])] };
}

/** The Claude bridge keeps the SDK/credentials/history on the VPS while its sole project tools execute over the pinned Windows SSH target. */
export function sshWorkspaceQuery(input: Parameters<typeof sdkQuery>[0], target: SshProjectTarget, admit: typeof admitWorkspaceExecution): ReturnType<typeof sdkQuery> {
  const options = { ...input.options } as NonNullable<typeof input.options> & { chisaSessionId?: string; workspaceMode?: string; chisaWorkspaceDescriptor?: unknown; chisaAttachments?: unknown; chisaPrepareLaunch?: (cwd: string) => Promise<void>; chisaProjectRuntime?: ProjectRuntimeLaunchContext };
  const prepareLaunch = options.chisaPrepareLaunch;
  delete options.chisaPrepareLaunch;
  // Consume on the original options too: an internal preparation callback must never be replayed or reach the SDK.
  if (input.options) delete (input.options as typeof options).chisaPrepareLaunch;
  const launch = options.chisaProjectRuntime;
  delete options.chisaProjectRuntime;
  if (input.options) delete (input.options as typeof options).chisaProjectRuntime;
  const sessionId = options.chisaSessionId ?? options.sessionId;
  const expectedWorkspace = options.chisaWorkspaceDescriptor as Parameters<typeof admit>[0]['expectedWorkspace'];
  delete options.chisaSessionId;
  delete options.chisaWorkspaceDescriptor;
  delete options.workspaceMode;
  const attachments = normalizeAttachmentDescriptors(options.chisaAttachments);
  delete options.chisaAttachments;
  let readOnly = options.permissionMode === 'plan';
  let projectContext: Awaited<ReturnType<typeof prepareProjectRuntime>> | undefined;
  const controller = new AbortController();
  const callerSignal = options.abortController?.signal;
  const cancel = () => controller.abort(callerSignal?.reason);
  callerSignal?.addEventListener('abort', cancel, { once: true });
  if (callerSignal?.aborted) cancel();
  let admission: Admission | undefined;
  let active: ReturnType<typeof sdkQuery> | undefined;
  let processExit: Promise<void> | undefined;
  let cleanup: Promise<void> | undefined;
  const customSpawn = options.spawnClaudeCodeProcess;
  options.spawnClaudeCodeProcess = spawnOptions => {
    controller.signal.throwIfAborted();
    admission?.assertCurrent();
    if (customSpawn) {
      const child = customSpawn(spawnOptions);
      processExit = child.exitCode !== null ? Promise.resolve() : new Promise<void>((resolve, reject) => {
        child.once('exit', () => resolve()); child.once('error', reject);
      });
      void processExit.catch(() => {});
      return child;
    }
    const child = spawn(spawnOptions.command, spawnOptions.args, {
      cwd: spawnOptions.cwd, env: spawnOptions.env, signal: spawnOptions.signal,
      windowsHide: true, stdio: ['pipe', 'pipe', options.stderr ? 'pipe' : 'ignore'],
    });
    if (options.stderr) child.stderr?.on('data', (chunk: Buffer) => options.stderr?.(chunk.toString()));
    processExit = child.exitCode !== null ? Promise.resolve() : new Promise<void>(resolve => {
      // A spawn failure also emits close. Wait for the actual teardown rather
      // than abandoning admission on the earlier error event.
      child.once('close', () => resolve());
    });
    void processExit.catch(() => {});
    return child as ReturnType<NonNullable<typeof options.spawnClaudeCodeProcess>>;
  };
  const stream = (async function* () {
    let failure: unknown;
    let cleanupFailure: unknown;
    try {
      controller.signal.throwIfAborted();
      admission = await admit({ cwd: target.anchorPath, sessionId, workspaceMode: 'shared', readOnly,
        signal: controller.signal, expectedWorkspace });
      if (launch) {
        const descriptor: WorkspaceDescriptor = { workspaceId: sessionId ? `${target.workspaceId}:session:${sessionId}` : target.workspaceId, generation: target.generation,
          projectId: target.projectId, kind: sessionId ? 'session' : 'cloudReplica', ...(sessionId ? { sessionId } : {}),
          rootPath: target.anchorPath, sourceRoot: target.anchorPath, sourceMode: 'ssh', displayPath: target.rootPath,
          requestedMode: 'shared', effectiveMode: 'shared', phase: 'running', publicationState: 'integrated',
          capabilities: { read: true, write: !readOnly, git: true, shell: !readOnly, preview: false, integrate: false, cloudExecutionIndependentOfDesktop: false } };
        projectContext = await prepareProjectRuntime({ launch, descriptor, execute: admission.execute,
          assertCurrent: admission.assertCurrent, signal: controller.signal, options });
        readOnly = options.permissionMode === 'plan';
      }
      const tools = projectTools(admission, readOnly, controller.signal, attachments, projectContext);
      options.cwd = target.anchorPath;
      options.tools = ['AskUserQuestion', 'ExitPlanMode', 'TodoWrite'];
      options.mcpServers = { ...projectContext?.mcpServers, ...(projectContext ? { project_context: projectContext.server } : {}), workspace: tools.server };
      options.strictMcpConfig = true;
      const allowedRules = [...(options.allowedTools ?? [])];
      const deniedRules = [...(options.disallowedTools ?? [])];
      const permissionHandler = options.canUseTool;
      const toolNames = tools.names.map(name => `mcp__workspace__${name}`);
      options.allowedTools = [...new Set([...allowedRules.filter(name => !name.startsWith('mcp__workspace__')), ...toolNames.filter(name => {
        if (deniedRules.some(rule => matchesProjectPermission(rule, name)) || projectContext?.askTools.some(rule => matchesProjectPermission(rule, name))) return false;
        const shortName = name.replace(/^mcp__workspace__/, '');
        return inspectionTools.has(shortName) || (options.permissionMode === 'acceptEdits' && shortName === 'write_file')
          || allowedRules.some(rule => matchesProjectPermission(rule, name));
      })])];
      options.disallowedTools = [...new Set([...deniedRules, ...toolNames.filter(name => deniedRules.some(rule => matchesProjectPermission(rule, name)))])];
      options.canUseTool = async (name, toolInput, context) => {
        if (!name.startsWith('mcp__workspace__')) {
          return permissionHandler ? permissionHandler(name, toolInput, context) : { behavior: 'deny', message: 'No permission handler is available for this tool.' };
        }
        if (!toolNames.includes(name)) return { behavior: 'deny', message: 'The selected project does not expose this tool.' };
        if (deniedRules.some(rule => matchesProjectPermission(rule, name))) return { behavior: 'deny', message: 'Tool disallowed by settings' };
        const requiresAsk = projectContext?.askTools.some(rule => matchesProjectPermission(rule, name));
        if (!requiresAsk && (options.allowedTools!.includes(name) || allowedRules.some(rule => matchesProjectPermission(rule, name)))) return { behavior: 'allow', updatedInput: toolInput };
        return permissionHandler ? permissionHandler(name, toolInput, context) : { behavior: 'deny', message: 'Windows writes and commands require an explicit permission decision.' };
      };
      options.settingSources = [];
      options.env = { ...options.env, CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' };
      const previousPrompt = options.systemPrompt;
      const previous = previousPrompt && typeof previousPrompt === 'object' && 'append' in previousPrompt ? previousPrompt.append ?? '' : '';
      options.systemPrompt = { type: 'preset', preset: 'claude_code', append: previous + '\nClaude Code runs on the VPS. Source files, Git, builds and tests are on a Windows computer reached by SSH. Use only the workspace project tools. /workspace is a virtual path for file tools; run_command executes Windows PowerShell in the actual selected directory, so use relative shell paths. Project configuration and instructions are loaded by the cloud project context resolver when enabled; use project_context for skills and scoped rules. Unsupported hooks and settings are reported rather than executed on the VPS. Do not run commands or read project files on the VPS. Use read_attachment only for the explicitly attached VPS files listed in this turn. Use read_image to inspect project screenshots; reference project images with relative or /workspace paths, not Windows absolute/file URLs. ' + (readOnly ? 'This session permits file inspection only; shell commands and writes are unavailable.' : 'Report actual Windows command exit codes and output. Do not retry an interrupted mutation without checking its result.') };
      admission.assertCurrent();
      if (prepareLaunch) await prepareLaunch(options.cwd);
      controller.signal.throwIfAborted();
      admission.assertCurrent();
      active = sdkQuery({ ...input, options });
      for await (const event of active) { projectContext?.observe(event); yield event; }
    } catch (error) { failure = error; }
    finally {
      cleanup = (async () => {
        try {
          active?.close();
          try { await processExit; }
          catch (error) { failure ??= error; }
        } finally {
          // A failed CLI spawn must release its admission too. Remote tools
          // retain their own recovery fence when cleanup is uncertain.
          try { await admission?.close(); }
          finally { projectContext?.close(Boolean(failure || controller.signal.aborted)); }
        }
      })();
      try { await cleanup; }
      catch (error) {
        cleanupFailure = Object.assign(new AppError('SSH 工作区清理尚未确认，请检查原任务。', { code: 'SSH_WORKSPACE_RECOVERY_REQUIRED', statusCode: 409, details: { cause: error instanceof Error ? error.message : String(error) } }), { workspaceCleanupError: true, cause: failure ?? error });
      } finally { callerSignal?.removeEventListener('abort', cancel); }
    }
    if (cleanupFailure) throw cleanupFailure;
    if (failure) throw failure;
  })();
  const wrapped = new Proxy(stream, {
    get(iterator, property) {
      if (property === Symbol.asyncIterator) return () => wrapped;
      if (property === 'next' || property === 'return') return async () => {
        const result = property === 'next' ? await iterator.next() : await iterator.return(undefined);
        if (result.done) { callerSignal?.removeEventListener('abort', cancel); await cleanup; }
        return result;
      };
      if (property === 'interrupt') return async () => { controller.abort(); active?.close(); await iterator.return(undefined); await cleanup; };
      if (property === 'close') return () => { controller.abort(); active?.close(); void iterator.return(undefined).catch(() => {}); };
      const value = Reflect.get(iterator, property);
      return typeof value === 'function' ? value.bind(iterator) : value;
    },
  });
  return wrapped as unknown as ReturnType<typeof sdkQuery>;
}
