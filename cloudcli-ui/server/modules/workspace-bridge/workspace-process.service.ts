import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { AppError } from '@/shared/index.js';

function contains(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(root + path.sep);
}

/** The admitted workspace handle uses this stream launcher after pinning its exact execution lease. */
export function spawnWorkspaceProcess(input: {
  command: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
  runtimeMounts?: Array<{ source: string; target: string; writable: boolean }>;
  signal?: AbortSignal;
}, workspace: {
  root: string;
  sourceRoot: string;
  workspacesRoot: string;
  readOnly: boolean;
  network: string;
  name: string;
  gitMounts: string[];
  isolated: boolean;
  remove(): Promise<void>;
  record(pending: boolean): void;
}) {
  const cancellation = new AbortController();
  const signal = input.signal ? AbortSignal.any([input.signal, cancellation.signal]) : cancellation.signal;
  signal.throwIfAborted();
  const cwd = realpathSync(input.cwd ?? workspace.root);
  if (!contains(workspace.root, cwd)) throw new AppError('Provider working directory must stay inside its admitted workspace', { code: 'WORKSPACE_PATH_INVALID', statusCode: 400 });
  if (!input.command || /[\0\r\n]/.test(input.command) || !Array.isArray(input.args) || input.args.some(value => typeof value !== 'string' || value.includes('\0'))) throw new AppError('Invalid admitted process command', { code: 'INVALID_REQUEST', statusCode: 400 });
  const environment = { HOME: '/runtime/provider-state/home', TMPDIR: '/tmp', TZ: 'UTC', ...input.env };
  if (Object.entries(environment).some(([key, value]) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof value !== 'string' || value.includes('\0'))) throw new AppError('Invalid admitted process environment', { code: 'INVALID_REQUEST', statusCode: 400 });
  const runtime: string[] = [];
  const destinations = new Set<string>();
  for (const mount of input.runtimeMounts ?? []) {
    if (!path.isAbsolute(mount.source) || !path.posix.isAbsolute(mount.target) || /[,\r\n\0]/.test(mount.source + mount.target)) throw new AppError('Provider runtime mounts require absolute paths', { code: 'WORKSPACE_RUNTIME_INVALID', statusCode: 400 });
    const source = realpathSync(mount.source);
    const target = path.posix.resolve(mount.target);
    const stats = lstatSync(source);
    const assetRoot = path.join(os.homedir(), '.cloudcli', 'assets');
    const exactAsset = !mount.writable && stats.isFile() && source === target && contains(assetRoot, source) && source !== assetRoot;
    if (source !== path.resolve(mount.source) || path.parse(source).root === source || (!exactAsset && !['/runtime/provider-code', '/runtime/provider-state', '/runtime/provider-assets'].some(prefix => target === prefix || target.startsWith(prefix + '/'))) || target === '/runtime/provider-state' || destinations.has(target)) throw new AppError('Provider runtime mount is not a canonical private path', { code: 'WORKSPACE_RUNTIME_INVALID', statusCode: 400 });
    if ((!exactAsset && contains(workspace.workspacesRoot, source)) || contains(source, workspace.workspacesRoot) || contains(workspace.sourceRoot, source) || contains(workspace.root, source) || source.split(path.sep).some(part => ['.git', '.ssh', '.chisa-workspace-sync'].includes(part)) || /(?:^|\/)\.(?:chisa-bridge|chisa-session)\.json$/.test(source) || /(?:^|\/)[^/]+\.(?:db|sqlite|sqlite3)(?:-(?:wal|shm))?$/.test(source)) throw new AppError('Provider runtime mount overlaps protected host state', { code: 'WORKSPACE_RUNTIME_INVALID', statusCode: 400 });
    if (!stats.isFile() && !stats.isDirectory()) throw new AppError('Provider runtime mount must be a regular file or directory', { code: 'WORKSPACE_RUNTIME_INVALID', statusCode: 400 });
    if (mount.writable && !(target === '/runtime/provider-state/home' || target.startsWith('/runtime/provider-state/home/'))) throw new AppError('Only private provider session state can be writable', { code: 'WORKSPACE_RUNTIME_INVALID', statusCode: 400 });
    destinations.add(target);
    runtime.push('--mount', `type=bind,src=${source},dst=${target}${mount.writable ? '' : ',readonly'}`);
  }
  const args = ['run', '--rm', '--interactive', '--name', workspace.name,
    '--network=' + workspace.network, '--label', 'chisa.workspace-root=' + createHash('sha256').update(workspace.root).digest('hex'), '--user=1000:1000', '--cap-drop=ALL', '--security-opt=no-new-privileges',
    '--pids-limit=256', '--memory=2g', '--hostname=workspace', '--read-only', '--workdir=' + cwd,
    '--tmpfs=/tmp:rw,size=512m', '--tmpfs=/runtime/provider-state/home:rw,size=512m,uid=1000,gid=1000',
    '--mount', `type=bind,src=${workspace.root},dst=${workspace.root}${workspace.readOnly ? ',readonly' : ''}`,
    ...workspace.gitMounts,
    '--mount', `type=bind,src=/dev/null,dst=${path.join(workspace.root, '.chisa-bridge.json')},readonly`,
    ...(workspace.isolated ? ['--mount', `type=bind,src=/dev/null,dst=${path.join(workspace.root, '.chisa-session.json')},readonly`, '--mount', `type=bind,src=${path.join(workspace.root, '.git')},dst=${path.join(workspace.root, '.git')},readonly`] : []),
    ...runtime, ...Object.entries(environment).map(([key, value]) => `--env=${key}=${value}`),
    'localhost/chisa-workspace:3', input.command, ...input.args];
  workspace.record(true);
  let child: ReturnType<typeof spawn>;
  try { child = spawn('docker', args, { stdio: ['pipe', 'pipe', 'pipe'], killSignal: 'SIGKILL', signal }); }
  catch (error) { workspace.record(false); throw error; }
  let processError: Error | undefined;
  child.once('error', error => { processError = error; });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => { child.once('close', (code, killedBy) => resolve({ code, signal: killedBy })); });
  const completion = exited.then(async result => {
    try { await workspace.remove(); workspace.record(false); }
    catch (error) { throw Object.assign(error instanceof Error ? error : new Error(String(error)), { workspaceCleanupError: true }); }
    if (processError && !(cancellation.signal.aborted && !input.signal?.aborted && processError.name === 'AbortError')) throw processError;
    return result;
  });
  void completion.catch(() => {});
  return {
    stdin: child.stdin!, stdout: child.stdout!, stderr: child.stderr!, completion,
    async close() { cancellation.abort(); await completion; },
  };
}
