import { assertWorkspaceDescriptor, readSshWorkspaceJobOutput, resolveSshProjectTarget, runSshWorkspaceCommand } from '@/modules/workspace-bridge/index.js';
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
  const normalizeNewlines = (text: string) => text.replace(/(?<!\r)\n/g, '\r\n');
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
    const signal = controller.signal;
    pending = (async () => {
      let stopPolling: (() => void) | undefined;
      let pollLoop: Promise<void> | undefined;
      let stdoutOffset = 0;
      let stderrOffset = 0;
      const stdoutDecoder = new TextDecoder('utf-8');
      const stderrDecoder = new TextDecoder('utf-8');
      try {
        assertWorkspaceDescriptor(descriptor);
        const target = resolveSshProjectTarget(descriptor.rootPath);
        if (!target) throw new AppError('SSH 项目目标已失效。', { code: 'WORKSPACE_GENERATION_CHANGED', statusCode: 409 });
        const startPolling = (jobId: string) => {
          if (typeof readSshWorkspaceJobOutput !== 'function' || pollLoop) return;
          let active = true;
          let wake: (() => void) | undefined;
          stopPolling = () => { active = false; wake?.(); };
          const drainStream = async (stream: 'stdout' | 'stderr') => {
            const offset = stream === 'stdout' ? stdoutOffset : stderrOffset;
            const chunkResult = await readSshWorkspaceJobOutput(target, { jobId, stream, offset, maxBytes: 65536 }, signal);
            if (typeof chunkResult?.chunk === 'string' && chunkResult.chunk.length > 0) {
              const bytes = Buffer.from(chunkResult.chunk, 'base64');
              if (bytes.length > 0) {
                if (stream === 'stdout') {
                  stdoutOffset += bytes.length;
                  const decoded = stdoutDecoder.decode(bytes, { stream: true });
                  if (decoded) emit(normalizeNewlines(decoded));
                } else {
                  stderrOffset += bytes.length;
                  const decoded = stderrDecoder.decode(bytes, { stream: true });
                  if (decoded) emit(normalizeNewlines(decoded));
                }
              }
            }
          };
          pollLoop = (async () => {
            while (active && !signal.aborted) {
              try {
                await drainStream('stdout');
                if (!active || signal.aborted) break;
                await drainStream('stderr');
              } catch {
                // Degrade silently to completion-time output if the helper does not support job_output or is transiently busy.
                active = false;
                break;
              }
              if (!active || signal.aborted) break;
              await new Promise<void>(resolve => {
                const timer = setTimeout(() => { wake = undefined; resolve(); }, 150);
                wake = () => { clearTimeout(timer); wake = undefined; resolve(); };
              });
            }
          })();
        };
        const result = await runSshWorkspaceCommand(descriptor, command, signal, { onJobCreated: startPolling });
        stopPolling?.();
        await pollLoop;
        const flushedStdout = stdoutDecoder.decode();
        if (flushedStdout) emit(normalizeNewlines(flushedStdout));
        const flushedStderr = stderrDecoder.decode();
        if (flushedStderr) emit(normalizeNewlines(flushedStderr));
        if (result.stdout) {
          if (stdoutOffset === 0) emit(normalizeNewlines(result.stdout));
          else {
            const fullBytes = Buffer.from(result.stdout, 'utf8');
            if (fullBytes.length > stdoutOffset) emit(normalizeNewlines(fullBytes.subarray(stdoutOffset).toString('utf8')));
          }
        }
        if (result.stderr) {
          if (stderrOffset === 0) emit(normalizeNewlines(result.stderr));
          else {
            const fullBytes = Buffer.from(result.stderr, 'utf8');
            if (fullBytes.length > stderrOffset) emit(normalizeNewlines(fullBytes.subarray(stderrOffset).toString('utf8')));
          }
        }
        emit(`\r\n[exit ${result.exitCode ?? 'unknown'}${result.truncated ? ', output truncated' : ''}]\r\n`);
      } catch (error) {
        stopPolling?.();
        await pollLoop;
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
