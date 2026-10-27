import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import pty, { type IPty } from 'node-pty';
import { WebSocket, type RawData } from 'ws';

import { assertSshProjectOwner, resolveSshProjectTarget } from '@/modules/workspace-bridge/index.js';
import { AppError, parseIncomingJsonObject } from '@/shared/index.js';
import type { AuthenticatedWebSocketRequest, WorkspaceDescriptor } from '@/shared/index.js';

import { createSshCommandConsole } from './ssh-shell-process.service.js';

type WorkspaceAdmission = Awaited<ReturnType<typeof import('@/modules/workspace-bridge/index.js').admitWorkspaceExecution>>;
type WorkspaceProcess = Awaited<ReturnType<WorkspaceAdmission['spawnProcess']>>;
type TerminalExit = { exitCode: number | null; signal?: string | number | null; error?: unknown };
type TerminalProcess = {
  transport: 'pty' | 'pipe';
  onData(listener: (data: string) => void): void;
  onExit(listener: (event: TerminalExit) => void): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void | Promise<void>;
};

type ShellIncomingMessage = {
  type?: string;
  data?: string;
  cols?: number;
  rows?: number;
  projectPath?: string;
  projectId?: string;
  workspaceId?: string;
  generation?: string;
  sessionId?: string;
  hasSession?: boolean;
  provider?: string;
  initialCommand?: string;
  isPlainShell?: boolean;
  forceRestart?: boolean;
  bypassPermissions?: boolean;
};

type ShellSessionEntry = {
  key: string;
  process: TerminalProcess;
  ws: WebSocket | null;
  buffer: string[];
  timeoutId: NodeJS.Timeout | null;
  descriptor?: WorkspaceDescriptor;
  projectPath: string;
  sessionId: string | null;
  urlDetectionBuffer: string;
  announcedAuthUrls: Set<string>;
  stopping: boolean;
  exited: boolean;
  cleanupError?: unknown;
  stop?: Promise<void>;
  completion: Promise<void>;
};

const shellSessions = new Map<string, ShellSessionEntry>();
// Serializes the whole asynchronous init for a terminal identity, including
// reconnect and restart. A second socket may never spawn while the first owns
// an admission that has not yet appeared in shellSessions.
const pendingInitializations = new Map<string, Promise<void>>();
const PTY_SESSION_TIMEOUT = 30 * 60 * 1000;
const SHELL_URL_PARSE_BUFFER_LIMIT = 32768;
const ANSI_ESCAPE_SEQUENCE_REGEX = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1B\\))/g;
const TRAILING_URL_PUNCTUATION_REGEX = /[)\]}>.,;:!?]+$/;

function stripAnsiSequences(value: string): string {
  return value.replace(ANSI_ESCAPE_SEQUENCE_REGEX, '');
}

function normalizeDetectedUrl(url: string): string | null {
  const cleanedUrl = url.trim().replace(TRAILING_URL_PUNCTUATION_REGEX, '');
  if (!cleanedUrl) {
    return null;
  }

  try {
    const parsedUrl = new URL(cleanedUrl);
    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
      return null;
    }
    return parsedUrl.toString();
  } catch {
    return null;
  }
}

function extractUrlsFromText(value: string): string[] {
  const directMatches = value.match(/https?:\/\/[^\s<>"'`\\\x1b\x07]+/gi) ?? [];

  // Terminal width can split a URL across lines, so valid URL characters on
  // immediately following lines are joined before the URL is validated.
  const wrappedMatches: string[] = [];
  const urlContinuationPattern = /^[A-Za-z0-9\-._~:/?#\[\]@!$&'()*+,;=%]+$/;
  const lines = value.split(/\r?\n/);
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex].trim();
    const startMatch = line.match(/https?:\/\/[^\s<>"'`\\\x1b\x07]+/i);
    if (!startMatch) {
      continue;
    }

    let combinedUrl = startMatch[0];
    let continuationIndex = lineIndex + 1;
    while (continuationIndex < lines.length) {
      const continuation = lines[continuationIndex].trim();
      if (!continuation || !urlContinuationPattern.test(continuation)) {
        break;
      }
      combinedUrl += continuation;
      continuationIndex += 1;
    }

    wrappedMatches.push(combinedUrl);
  }

  return Array.from(new Set([...directMatches, ...wrappedMatches]));
}

function shouldAutoOpenUrlFromOutput(value: string): boolean {
  const normalizedOutput = value.toLowerCase();
  return (
    normalizedOutput.includes("browser didn't open") ||
    normalizedOutput.includes('open this url') ||
    normalizedOutput.includes('continue in your browser') ||
    normalizedOutput.includes('press enter to open') ||
    normalizedOutput.includes('open_url:')
  );
}

type ShellWebSocketDependencies = {
  resolveProviderSessionId: (
    sessionId: string,
    provider: string,
  ) => string | null | undefined;
  spawnPty?: typeof pty.spawn;
  resolveSelectedWorkspace?: typeof import('@/modules/workspaces/index.js').resolveSelectedWorkspace;
  isWorkspaceBound?: typeof import('@/modules/workspace-bridge/index.js').isWorkspaceBound;
  admitWorkspaceExecution?: typeof import('@/modules/workspace-bridge/index.js').admitWorkspaceExecution;
  sessionTimeoutMs?: number;
};

/**
 * Reads a string field from untyped payloads and falls back when absent.
 */
function readString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

/**
 * Reads a boolean field from untyped payloads and falls back when absent.
 */
function readBoolean(value: unknown, fallback = false): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

/**
 * Reads a finite number field from untyped payloads and falls back when absent.
 */
function readNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/**
 * Parses incoming websocket shell messages and keeps processing safe when
 * malformed payloads are received.
 */
function parseShellMessage(rawMessage: RawData): ShellIncomingMessage | null {
  const payload = parseIncomingJsonObject(rawMessage);
  if (!payload) {
    return null;
  }

  return payload as ShellIncomingMessage;
}

const SAFE_SESSION_ID_PATTERN = /^[a-zA-Z0-9_.\-:]+$/;

function resolveResumeSessionId(
  message: ShellIncomingMessage,
  dependencies: ShellWebSocketDependencies
): string {
  const hasSession = readBoolean(message.hasSession);
  const sessionId = readString(message.sessionId);
  const provider = readString(message.provider, 'claude');

  if (!hasSession || !sessionId) {
    return '';
  }

  let resumeSessionId: string | null | undefined;
  try {
    resumeSessionId = dependencies.resolveProviderSessionId(sessionId, provider);
  } catch (error) {
    console.error('Failed to resolve provider session ID:', error);
    resumeSessionId = undefined;
  }

  const resolvedSessionId = resumeSessionId === undefined ? sessionId : resumeSessionId;
  if (!resolvedSessionId || !SAFE_SESSION_ID_PATTERN.test(resolvedSessionId)) {
    return '';
  }

  return resolvedSessionId;
}

/**
 * Resolves provider command line for plain shell and agent-backed shell modes.
 */
function buildShellCommand(
  message: ShellIncomingMessage,
  dependencies: ShellWebSocketDependencies,
  platform: NodeJS.Platform = os.platform(),
): string {
  const hasSession = readBoolean(message.hasSession);
  const initialCommand = readString(message.initialCommand);
  const provider = readString(message.provider, 'claude');
  const resumeSessionId = resolveResumeSessionId(message, dependencies);
  const isPlainShell =
    readBoolean(message.isPlainShell) ||
    (!!initialCommand && !hasSession) ||
    provider === 'plain-shell';

  if (isPlainShell) {
    return initialCommand;
  }

  if (provider === 'cursor') {
    if (resumeSessionId) {
      return `cursor-agent --resume="${resumeSessionId}"`;
    }
    return 'cursor-agent';
  }

  if (provider === 'codex') {
    if (resumeSessionId) {
      if (platform === 'win32') {
        return `codex resume "${resumeSessionId}"; if ($LASTEXITCODE -ne 0) { codex }`;
      }
      return `codex resume "${resumeSessionId}" || codex`;
    }
    return 'codex';
  }

  if (provider === 'opencode') {
    if (resumeSessionId) {
      return `opencode --session "${resumeSessionId}"`;
    }
    return initialCommand || 'opencode';
  }

  // Launching with the flag is what unlocks "bypass permissions" in the CLI's
  // shift+tab permission-mode cycle; it cannot be enabled from inside a
  // session started without it.
  const bypassFlag = readBoolean(message.bypassPermissions)
    ? ' --dangerously-skip-permissions'
    : '';
  const command = initialCommand || `claude${bypassFlag}`;
  if (resumeSessionId) {
    if (platform === 'win32') {
      return `claude --resume "${resumeSessionId}"${bypassFlag}; if ($LASTEXITCODE -ne 0) { claude${bypassFlag} }`;
    }
    return `claude --resume "${resumeSessionId}"${bypassFlag} || claude${bypassFlag}`;
  }
  return command;
}

function readEnvValue(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const resolvedKey = Object.keys(env).find((envKey) => envKey.toLowerCase() === key.toLowerCase());
  return resolvedKey ? env[resolvedKey] : undefined;
}

function getPathEnvKey(env: NodeJS.ProcessEnv): string {
  return Object.keys(env).find((key) => key.toLowerCase() === 'path') || 'PATH';
}

function prioritizeUserNpmGlobalBin(env: NodeJS.ProcessEnv): { key: string; value: string | undefined } {
  const pathKey = getPathEnvKey(env);
  const currentPath = env[pathKey];
  if (!currentPath) {
    return { key: pathKey, value: currentPath };
  }

  const delimiter = path.delimiter;
  const pathEntries = currentPath.split(delimiter).filter(Boolean);
  const npmPrefix = readEnvValue(env, 'npm_config_prefix');
  const appData = readEnvValue(env, 'APPDATA');
  const candidates = [
    npmPrefix || '',
    npmPrefix ? path.join(npmPrefix, 'bin') : '',
    appData ? path.join(appData, 'npm') : '',
    path.join(os.homedir(), 'AppData', 'Roaming', 'npm'),
    path.join(os.homedir(), '.npm-global', 'bin'),
  ].filter(Boolean);

  const normalizedPathEntries = pathEntries.map((entry) => os.platform() === 'win32' ? entry.toLowerCase() : entry);
  const preferredEntries = candidates.filter((candidate, index) => {
    const normalizedCandidate = os.platform() === 'win32' ? candidate.toLowerCase() : candidate;
    return (
      candidates.indexOf(candidate) === index &&
      normalizedPathEntries.includes(normalizedCandidate)
    );
  });

  if (preferredEntries.length === 0) {
    return { key: pathKey, value: currentPath };
  }

  const normalizedPreferredEntries = preferredEntries.map((entry) =>
    os.platform() === 'win32' ? entry.toLowerCase() : entry
  );

  const value = [
    ...preferredEntries,
    ...pathEntries.filter((entry) => {
      const normalizedEntry = os.platform() === 'win32' ? entry.toLowerCase() : entry;
      return !normalizedPreferredEntries.includes(normalizedEntry);
    }),
  ].join(delimiter);

  return { key: pathKey, value };
}

function sendFrame(ws: WebSocket | null, frame: Record<string, unknown>): void {
  if (ws?.readyState !== WebSocket.OPEN) return;
  // A transport failure must never interrupt the exact process's cleanup.
  try { ws.send(JSON.stringify(frame)); }
  catch (error) { console.error('[ERROR] Shell frame delivery failed:', error); }
}

function sendError(ws: WebSocket | null, error: unknown): void {
  const failure = error as { message?: string; code?: string; statusCode?: number } | null;
  sendFrame(ws, { type: 'error', message: failure?.message ?? String(error),
    ...(failure?.code ? { code: failure.code } : {}), ...(failure?.statusCode ? { statusCode: failure.statusCode } : {}) });
}

function asPtyProcess(process: IPty): TerminalProcess {
  return { transport: 'pty', onData(listener) { process.onData(listener); }, onExit(listener) { process.onExit(listener); },
    write(data) { process.write(data); }, resize(cols, rows) { process.resize(cols, rows); }, kill() { process.kill(); } };
}

/** Pipes have no terminal line discipline: provide basic editing and echo.
 * Ctrl+C closes this exact container; resize and job control are unavailable. */
function asPipeProcess(child: WorkspaceProcess): TerminalProcess {
  const listeners = new Set<(data: string) => void>();
  let line = '';
  let previousWasCarriageReturn = false;
  let escapeSequence = '';
  const emit = (data: string) => listeners.forEach(listener => listener(data));
  const receive = (chunk: Buffer | string) => emit(String(chunk).replace(/(?<!\r)\n/g, '\r\n'));
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', receive);
  child.stderr.on('data', receive);
  // EPIPE can arrive while completion reports actual exit/cleanup separately.
  child.stdin.on('error', () => {});
  return {
    transport: 'pipe',
    onData(listener) { listeners.add(listener); },
    onExit(listener) {
      void child.completion.then(result => listener({ exitCode: result.code, signal: result.signal }),
        error => listener({ exitCode: null, error }));
    },
    write(data) {
      for (const character of data) {
        if (escapeSequence) {
          escapeSequence += character;
          if (escapeSequence.length > 32 || /^[\x1b](?:\[[0-?]*[ -/]*[@-~]|O.)$/.test(escapeSequence)
            || (escapeSequence.length === 2 && !['[', 'O'].includes(character))) escapeSequence = '';
          continue;
        }
        if (character === '\x1b') { escapeSequence = character; continue; }
        if (character === '\x03') { line = ''; emit('^C\r\n'); void child.close().catch(() => {}); }
        else if (character === '\x04') {
          if (line) { child.stdin.write(line); line = ''; } else child.stdin.end();
        } else if (character === '\x7f' || character === '\b') {
          if (line) { line = Array.from(line).slice(0, -1).join(''); emit('\b \b'); }
        } else if (character === '\x15') { emit('\b \b'.repeat(Array.from(line).length)); line = ''; }
        else if (character === '\r' || character === '\n') {
          if (character !== '\n' || !previousWasCarriageReturn) { child.stdin.write(line + '\n'); line = ''; emit('\r\n'); }
        } else if (character >= ' ' || character === '\t') { line += character; emit(character); }
        previousWasCarriageReturn = character === '\r';
      }
    },
    resize() {},
    kill() { return child.close(); },
  };
}

function emitSessionOutput(session: ShellSessionEntry, chunk: string): void {
  if (session.exited || shellSessions.get(session.key) !== session) return;
  session.buffer.push(chunk);
  if (session.buffer.length > 5000) session.buffer.shift();
  const cleanChunk = stripAnsiSequences(chunk);
  session.urlDetectionBuffer = `${session.urlDetectionBuffer}${cleanChunk}`.slice(-SHELL_URL_PARSE_BUFFER_LIMIT);
  if (session.ws?.readyState !== WebSocket.OPEN) return;
  const emitAuthUrl = (detectedUrl: string, autoOpen = false) => {
    const url = normalizeDetectedUrl(detectedUrl);
    if (!url || session.announcedAuthUrls.has(url)) return;
    session.announcedAuthUrls.add(url);
    sendFrame(session.ws, { type: 'auth_url', url, autoOpen });
  };
  const urls = Array.from(new Set(extractUrlsFromText(session.urlDetectionBuffer)
    .map(normalizeDetectedUrl).filter((url): url is string => Boolean(url))))
    .filter((url, _, candidates) => !candidates.some(other => other !== url && other.startsWith(url)));
  urls.forEach(url => emitAuthUrl(url));
  if (shouldAutoOpenUrlFromOutput(cleanChunk) && urls.length) {
    emitAuthUrl(urls.reduce((longest, current) => current.length > longest.length ? current : longest), true);
  }
  sendFrame(session.ws, { type: 'output',
    data: chunk.replace(/OPEN_URL:\s*(https?:\/\/[^\s\x1b\x07]+)/g, '[INFO] Opening in browser: $1') });
}

function startRetainedSession(input: {
  key: string; process: TerminalProcess; ws: WebSocket | null; projectPath: string; sessionId: string | null;
  descriptor?: WorkspaceDescriptor; admission?: WorkspaceAdmission;
}): ShellSessionEntry {
  let settle: () => void = () => {};
  const completion = new Promise<void>(resolve => { settle = resolve; });
  const session: ShellSessionEntry = { ...input, buffer: [], timeoutId: null, urlDetectionBuffer: '',
    announcedAuthUrls: new Set(), stopping: false, exited: false, completion };
  shellSessions.set(input.key, session);
  input.process.onData(chunk => emitSessionOutput(session, chunk));
  input.process.onExit(event => {
    if (session.exited) return;
    session.exited = true;
    session.stopping = true;
    if (session.timeoutId) { clearTimeout(session.timeoutId); session.timeoutId = null; }
    const finish = (cleanupError?: unknown) => {
      const failedCleanup = cleanupError ?? (event.error && typeof event.error === 'object'
        && 'workspaceCleanupError' in event.error ? event.error : undefined);
      // Retain a tombstone when container removal was not confirmed.
      if (failedCleanup) session.cleanupError = failedCleanup;
      else if (shellSessions.get(input.key) === session) shellSessions.delete(input.key);
      if (event.error || cleanupError) sendError(session.ws, cleanupError ?? event.error);
      sendFrame(session.ws, { type: 'output',
        data: `\r\n\x1b[33mProcess exited with code ${event.exitCode ?? 'unknown'}${event.signal ? ` (${event.signal})` : ''}\x1b[0m\r\n` });
      settle();
    };
    // The exact admission lives through real process exit and Docker removal.
    if (input.admission) void input.admission.close().then(() => finish(), finish);
    else finish();
  });
  return session;
}

function stopSession(session: ShellSessionEntry): Promise<void> {
  if (session.stop) return session.stop;
  session.stopping = true;
  if (session.timeoutId) { clearTimeout(session.timeoutId); session.timeoutId = null; }
  session.stop = (async () => {
    if (!session.exited) {
      try { await session.process.kill(); } catch (error) { sendError(session.ws, error); }
    }
    // A successful kill request is not proof of exit.
    await session.completion;
    if (session.cleanupError) throw session.cleanupError;
  })();
  return session.stop;
}

function detachSession(session: ShellSessionEntry, ws: WebSocket, timeoutMs: number): void {
  if (session.ws !== ws || session.exited) return;
  session.ws = null;
  if (session.timeoutId) clearTimeout(session.timeoutId);
  session.timeoutId = setTimeout(() => {
    if (shellSessions.get(session.key) !== session || session.ws !== null) return;
    void stopSession(session).catch(error => console.error('[ERROR] Shell cleanup failed:', error));
  }, timeoutMs);
  session.timeoutId.unref();
}

function sendReady(ws: WebSocket, session: ShellSessionEntry): void {
  if (!session.descriptor) return;
  const { projectId, workspaceId, generation, sessionId } = session.descriptor;
  sendFrame(ws, { type: 'ready', projectId, workspaceId, generation, ...(sessionId ? { sessionId } : {}),
    transport: session.process.transport, resizeSupported: session.process.transport === 'pty' });
}

function sameWorkspace(left: WorkspaceDescriptor, right: WorkspaceDescriptor): boolean {
  return left.workspaceId === right.workspaceId && left.generation === right.generation
    && left.projectId === right.projectId && left.sessionId === right.sessionId
    && left.rootPath === right.rootPath && left.sourceRoot === right.sourceRoot
    && left.effectiveMode === right.effectiveMode && left.kind === right.kind;
}

/** The gateway binds each terminal to a server-resolved workspace generation.
 * Only an explicitly injected legacy PTY test double may use path-based init. */
export function handleShellConnection(
  ws: WebSocket, dependencies: ShellWebSocketDependencies, request?: AuthenticatedWebSocketRequest,
): void {
  console.log('[INFO] Shell websocket connected');
  const legacyTest = Boolean(dependencies.spawnPty && !dependencies.resolveSelectedWorkspace
    && !dependencies.isWorkspaceBound && !dependencies.admitWorkspaceExecution);
  const ownerId = request?.user?.id ?? request?.user?.userId ?? request?.user?.username ?? 'authenticated';
  const timeoutMs = dependencies.sessionTimeoutMs ?? PTY_SESSION_TIMEOUT;
  let activeSession: ShellSessionEntry | null = null;
  let connectionKey: string | null = null;
  let initializing = false;
  let disconnected = false;
  ws.on('message', async (rawMessage) => {
    try {
      const data = parseShellMessage(rawMessage);
      if (!data?.type) throw new AppError('Invalid websocket payload', { code: 'INVALID_REQUEST', statusCode: 400 });
      if (data.type !== 'init') {
        // Delayed input from a replaced socket cannot control its successor.
        if (!activeSession || activeSession.ws !== ws || activeSession.stopping || activeSession.exited) return;
        if (data.type === 'input') activeSession.process.write(readString(data.data));
        if (data.type === 'resize') activeSession.process.resize(readNumber(data.cols, 80), readNumber(data.rows, 24));
        return;
      }
      if (initializing) throw new AppError('Shell initialization is already pending', { code: 'SHELL_INITIALIZING', statusCode: 409 });
      initializing = true;
      try {
        const requestedSessionId = readString(data.sessionId) || null;
        if (requestedSessionId && !SAFE_SESSION_ID_PATTERN.test(requestedSessionId)) {
          throw new AppError('Invalid session ID', { code: 'INVALID_REQUEST', statusCode: 400 });
        }
        let descriptor: WorkspaceDescriptor | undefined;
        let resolveSelected: ShellWebSocketDependencies['resolveSelectedWorkspace'];
        let isBound = false;
        let checkBound: ShellWebSocketDependencies['isWorkspaceBound'];
        if (!legacyTest) {
          const projectId = readString(data.projectId);
          const workspaceId = readString(data.workspaceId);
          const generation = readString(data.generation);
          if (!projectId.trim() || !workspaceId.trim() || !generation.trim()) {
            throw new AppError('projectId, workspaceId and generation are required', { code: 'WORKSPACE_SELECTOR_REQUIRED', statusCode: 400 });
          }
          resolveSelected = dependencies.resolveSelectedWorkspace ?? (await import('@/modules/workspaces/index.js')).resolveSelectedWorkspace;
          descriptor = resolveSelected(projectId, { workspaceId, generation, ...(requestedSessionId ? { sessionId: requestedSessionId } : {}) });
          if (!descriptor.capabilities.shell) throw new AppError('Shell is unavailable for this workspace', { code: 'WORKSPACE_SHELL_UNAVAILABLE', statusCode: 409 });
          checkBound = dependencies.isWorkspaceBound ?? (await import('@/modules/workspace-bridge/index.js')).isWorkspaceBound;
          isBound = checkBound(descriptor.sourceRoot);
        }
        const projectPath = descriptor?.rootPath ?? path.resolve(readString(data.projectPath, process.cwd()));
        const sessionId = descriptor?.sessionId ?? requestedSessionId;
        const hasSession = readBoolean(data.hasSession);
        const provider = readString(data.provider, 'claude');
        const initialCommand = readString(data.initialCommand);
        const isPlainShell = readBoolean(data.isPlainShell) || (!!initialCommand && !hasSession) || provider === 'plain-shell';
        // A full digest prevents commands with a common prefix sharing a process.
        const commandIdentity = createHash('sha256').update(JSON.stringify({ provider, isPlainShell, initialCommand,
          hasSession, bypassPermissions: readBoolean(data.bypassPermissions) })).digest('hex');
        const key = JSON.stringify(descriptor
          ? [String(ownerId), descriptor.projectId, descriptor.workspaceId, descriptor.generation, descriptor.sessionId ?? null, commandIdentity]
          : ['injected-legacy', projectPath, sessionId, commandIdentity]);
        if (connectionKey && connectionKey !== key) {
          throw new AppError('A shell connection cannot change its workspace or command', { code: 'SHELL_WORKSPACE_MISMATCH', statusCode: 409 });
        }
        connectionKey = key;
        while (pendingInitializations.has(key)) await pendingInitializations.get(key);
        let releaseInitialization: () => void = () => {};
        const pending = new Promise<void>(resolve => { releaseInitialization = resolve; });
        pendingInitializations.set(key, pending);
        try {
          if (disconnected || ws.readyState !== WebSocket.OPEN) return;
          const validateWorkspace = () => {
            if (!descriptor || !resolveSelected) return;
            const latest = resolveSelected(descriptor.projectId, { workspaceId: descriptor.workspaceId,
              generation: descriptor.generation, ...(descriptor.sessionId ? { sessionId: descriptor.sessionId } : {}) });
            if (!sameWorkspace(descriptor, latest) || !latest.capabilities.shell
              || checkBound?.(latest.sourceRoot) !== isBound) {
              throw new AppError('The selected workspace changed; resolve it again', { code: 'WORKSPACE_GENERATION_CHANGED', statusCode: 409 });
            }
          };
          validateWorkspace();
          const existing = shellSessions.get(key);
          const restart = readBoolean(data.forceRestart) || (!!initialCommand
            && (initialCommand.includes('setup-token') || initialCommand.includes('cursor-agent login') || initialCommand.includes('auth login')));
          if (existing) {
            if (descriptor && (!existing.descriptor || !sameWorkspace(existing.descriptor, descriptor))) {
              throw new AppError('The retained shell belongs to a different workspace', { code: 'SHELL_WORKSPACE_MISMATCH', statusCode: 409 });
            }
            if (existing.cleanupError) throw existing.cleanupError;
            if (existing.stopping && !restart) throw new AppError('The previous shell is still stopping', { code: 'WORKSPACE_BUSY', statusCode: 409 });
            if (restart) {
              await stopSession(existing);
              if (disconnected) return;
              validateWorkspace();
            } else {
              activeSession = existing;
              if (existing.timeoutId) { clearTimeout(existing.timeoutId); existing.timeoutId = null; }
              existing.ws = ws;
              sendReady(ws, existing);
              sendFrame(ws, { type: 'output', data: '\x1b[36m[Reconnected to existing session]\x1b[0m\r\n' });
              existing.buffer.forEach(chunk => sendFrame(ws, { type: 'output', data: chunk }));
              return;
            }
          }
          if (descriptor?.sourceMode !== 'ssh') {
            try { if (!fs.statSync(projectPath).isDirectory()) throw new Error('Not a directory'); }
            catch { throw new Error('Invalid project path'); }
          }
          const selectedMessage = { ...data, ...(sessionId ? { sessionId } : {}) };
          const shellCommand = buildShellCommand(selectedMessage, dependencies, isBound ? 'linux' : os.platform());
          let terminal: TerminalProcess;
          let admission: WorkspaceAdmission | undefined;
          try {
            if (descriptor?.sourceMode === 'ssh') {
              const ssh = resolveSshProjectTarget(descriptor.sourceRoot);
              if (!ssh) throw new AppError('SSH 工作区不可用。', { code: 'SSH_WORKSPACE_NOT_FOUND', statusCode: 404 });
              assertSshProjectOwner(ssh, ownerId);
              if (!isPlainShell) throw new AppError('SSH 终端仅提供 Windows 命令控制台，Claude Code 保留在 VPS 聊天中运行。', { code: 'WORKSPACE_PROVIDER_UNSUPPORTED', statusCode: 409 });
              terminal = createSshCommandConsole(descriptor, initialCommand);
            } else if (isBound && descriptor) {
              const admit = dependencies.admitWorkspaceExecution ?? (await import('@/modules/workspace-bridge/index.js')).admitWorkspaceExecution;
              admission = await admit({ cwd: descriptor.rootPath, sessionId: descriptor.sessionId,
                workspaceMode: descriptor.effectiveMode, directExecution: true, expectedWorkspace: descriptor });
              validateWorkspace();
              if (!admission.bound || path.resolve(admission.cwd) !== path.resolve(descriptor.rootPath)
                || path.resolve(admission.executionRoot) !== path.resolve(descriptor.rootPath)) {
                throw new AppError('Shell admission changed the selected workspace', { code: 'SHELL_WORKSPACE_MISMATCH', statusCode: 409 });
              }
              if (disconnected) {
                const unusedAdmission = admission;
                admission = undefined;
                await unusedAdmission.close();
                return;
              }
              const child = await admission.spawnProcess({ command: 'bash',
                args: shellCommand ? ['-c', shellCommand] : ['--noprofile', '--norc', '-i'], cwd: descriptor.rootPath,
                env: { TERM: 'dumb', COLORTERM: 'truecolor', FORCE_COLOR: '1',
                  COLUMNS: String(readNumber(data.cols, 80)), LINES: String(readNumber(data.rows, 24)) } });
              terminal = asPipeProcess(child);
            } else {
              const prioritizedPath = prioritizeUserNpmGlobalBin(process.env);
              const windows = os.platform() === 'win32';
              const shell = windows ? 'powershell.exe' : 'bash';
              const shellArgs = shellCommand ? [windows ? '-Command' : '-c', shellCommand]
                : windows ? ['-NoLogo', '-NoExit'] : ['-i'];
              terminal = asPtyProcess((dependencies.spawnPty ?? pty.spawn)(shell, shellArgs, {
                name: 'xterm-256color', cols: readNumber(data.cols, 80), rows: readNumber(data.rows, 24), cwd: projectPath,
                env: { ...process.env, [prioritizedPath.key]: prioritizedPath.value,
                  TERM: 'xterm-256color', COLORTERM: 'truecolor', FORCE_COLOR: '3' } }));
            }
          } catch (error) {
            if (admission) await admission.close();
            throw error;
          }
          const session = startRetainedSession({ key, process: terminal, ws, projectPath, sessionId, descriptor, admission });
          activeSession = session;
          if (disconnected || ws.readyState !== WebSocket.OPEN) {
            session.ws = null;
            await stopSession(session);
            return;
          }
          try { validateWorkspace(); }
          catch (error) { await stopSession(session); throw error; }
          sendReady(ws, session);
          const resumeSessionId = resolveResumeSessionId(selectedMessage, dependencies);
          const providerName = provider === 'cursor' ? 'Cursor' : provider === 'codex' ? 'Codex' : provider === 'opencode' ? 'OpenCode' : 'Claude';
          const sshConsole = descriptor?.sourceMode === 'ssh';
          let welcome = sshConsole ? `Windows SSH 命令控制台：${descriptor?.displayPath || '项目目录'}`
            : isPlainShell ? `Starting terminal in: ${projectPath}`
              : hasSession && resumeSessionId ? `Resuming ${providerName} session ${resumeSessionId} in: ${projectPath}`
                : `Starting new ${providerName} session in: ${projectPath}`;
          if (terminal.transport === 'pipe' && !sshConsole) welcome += '\r\n[Container pipe shell: no TTY, resize, or job control; Ctrl+C closes this shell. Provider CLIs require installation and authentication inside the container.]';
          sendFrame(ws, { type: 'output', data: `\x1b[36m${welcome}\x1b[0m\r\n` });
        } finally {
          if (pendingInitializations.get(key) === pending) pendingInitializations.delete(key);
          releaseInitialization();
        }
      } finally { initializing = false; }
    } catch (error) { sendError(ws, error); }
  });
  ws.on('close', () => { disconnected = true; if (activeSession) detachSession(activeSession, ws, timeoutMs); });
  ws.on('error', error => console.error('[ERROR] Shell WebSocket error:', error));
}
