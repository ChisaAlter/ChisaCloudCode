import { assertWorkspaceDescriptor, resolveSshProjectTarget, runSshWorkspaceCommand } from '@/modules/workspace-bridge/index.js';
import { AppError } from '@/shared/index.js';
import type { WorkspaceDescriptor } from '@/shared/index.js';

type Exit = { exitCode: number | null; error?: unknown };

/** Shell websocket uses a bounded command console for Windows SSH. Each line is a separate PowerShell task; it makes no PTY or persistent-shell claim. */
export function createSshCommandConsole(descriptor: WorkspaceDescriptor, initialCommand = '') {
  const outputListeners = new Set<(data: string) => void>();
  const exitListeners = new Set<(event: Exit) => void>();
  let line = '';
  let previousCR = false;
  let escape = '';
  let busy = false;
  let closed = false;
  let pending: Promise<void> | undefined;
  let controller: AbortController | undefined;
  const emit = (data: string) => outputListeners.forEach(listener => listener(data));
  const finish = (error?: unknown) => {
    if (closed) return;
    closed = true;
    for (const listener of exitListeners) listener({ exitCode: error ? null : 0, ...(error ? { error } : {}) });
  };
  const prompt = () => { if (!closed) emit('PS 项目> '); };
  const run = (command: string) => {
    if (closed || busy) return;
    if (!command.trim()) { prompt(); return; }
    if (command.trim().toLowerCase() === 'exit') { finish(); return; }
    busy = true;
    controller = new AbortController();
    pending = (async () => {
      try {
        assertWorkspaceDescriptor(descriptor);
        const target = resolveSshProjectTarget(descriptor.rootPath);
        if (!target) throw new AppError('SSH 项目目标已失效。', { code: 'WORKSPACE_GENERATION_CHANGED', statusCode: 409 });
        const result = await runSshWorkspaceCommand(descriptor, command, controller!.signal);
        if (result.stdout) emit(result.stdout.replace(/(?<!\r)\n/g, '\r\n'));
        if (result.stderr) emit(result.stderr.replace(/(?<!\r)\n/g, '\r\n'));
        emit(`\r\n[exit ${result.exitCode ?? 'unknown'}${result.truncated ? ', output truncated' : ''}]\r\n`);
      } catch (error) {
        emit(`\r\n${error instanceof Error ? error.message : String(error)}\r\n`);
        if ((error as { workspaceCleanupError?: boolean; code?: string }).workspaceCleanupError
          || ['SSH_EXECUTION_UNCONFIRMED', 'SSH_WORKSPACE_RECOVERY_REQUIRED'].includes((error as { code?: string }).code ?? '')) { finish(error); return; }
      } finally { busy = false; controller = undefined; }
      prompt();
    })();
  };
  queueMicrotask(() => {
    emit('Windows SSH 命令控制台：每行独立执行，工作目录固定为项目目录；不支持交互输入或持久变量。Ctrl+C 停止当前任务。\r\n');
    if (initialCommand) { emit(initialCommand + '\r\n'); run(initialCommand); } else prompt();
  });
  return {
    transport: 'pipe' as const,
    onData(listener: (data: string) => void) { outputListeners.add(listener); },
    onExit(listener: (event: Exit) => void) { exitListeners.add(listener); },
    write(data: string) {
      for (const character of data) {
        if (character === '\x03') { line = ''; emit('^C\r\n'); controller?.abort(); if (!busy) prompt(); continue; }
        if (busy || closed) continue;
        if (escape) { escape += character; if (escape.length > 32 || /^[\x1b](?:\[[0-?]*[ -/]*[@-~]|O.)$/.test(escape)) escape = ''; continue; }
        if (character === '\x1b') { escape = character; continue; }
        if (character === '\x04') { finish(); return; }
        if (character === '\x7f' || character === '\b') { if (line) { line = Array.from(line).slice(0, -1).join(''); emit('\b \b'); } }
        else if (character === '\r' || character === '\n') {
          if (!(character === '\n' && previousCR)) { const command = line; line = ''; emit('\r\n'); run(command); }
        } else if ((character >= ' ' || character === '\t') && line.length < 32_768) { line += character; emit(character); }
        previousCR = character === '\r';
      }
    },
    resize() {},
    async kill() { controller?.abort(); await pending; finish(); },
  };
}
