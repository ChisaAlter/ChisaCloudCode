import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { AppError, WORKSPACES_ROOT } from '@/shared/index.js';

const invalid = () => new AppError('Preview broker inventory is unavailable', { code: 'PREVIEW_RECOVERY_REQUIRED', statusCode: 503 });

/** Runtime preview service persists broker operation selectors before any daemon side
 * effect; entries survive API restarts independently from the legacy guard witness. */
export async function createWorkspacePreviewInventory(userId: string) {
  const accountRoot = await realpath(WORKSPACES_ROOT);
  const owner = createHash('sha256').update(accountRoot + '\0' + userId).digest('hex').slice(0,20);
  const directory = path.join(await realpath(os.homedir()),'.chisa-workspace-runtime','broker-previews');
  if (!userId || /[\0\r\n]/.test(userId) || directory === accountRoot || directory.startsWith(accountRoot + path.sep)) throw invalid();
  await mkdir(directory,{ recursive: true,mode: 0o700 });
  const metadata = await lstat(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || await realpath(directory) !== directory ||
    (process.platform !== 'win32' && (metadata.mode & 0o077) !== 0) || (typeof process.getuid === 'function' && metadata.uid !== process.getuid())) throw invalid();
  const filename = (id: string) => {
    if (!new RegExp('^chisa-account-preview-' + owner + '-[a-f0-9]{16}$').test(id)) throw invalid();
    return path.join(directory,id + '.json');
  };
  type Entry = { version: 1; userId: string; accountRoot: string; root: string; previewId: string; bindingEpoch: string; port: number;
    workspaceId: string; generation: string; leaseId: string; legacyReservationId?: string; sessionId?: string; profileId: string; resourceId?: string; base?: string };
  const validate = async (entry: Entry) => {
    if (entry.version !== 1 || entry.userId !== userId || entry.accountRoot !== accountRoot || !entry.root.startsWith(accountRoot + path.sep) || await realpath(entry.root) !== entry.root ||
      ![entry.workspaceId,entry.generation,entry.leaseId,entry.profileId,entry.bindingEpoch,...(entry.legacyReservationId !== undefined ? [entry.legacyReservationId] : []),...(entry.sessionId !== undefined ? [entry.sessionId] : [])].every(value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value)) ||
      !Number.isInteger(entry.port) || entry.port < 1024 || entry.port > 65535 || (entry.resourceId !== undefined && !/^[a-f0-9]{64}$/.test(entry.resourceId)) || (entry.base !== undefined && !/^\/api\/workspace-runtime\/preview\/[a-f0-9]{64}\/$/.test(entry.base))) throw invalid();
    filename(entry.previewId); return entry;
  };
  const read = async (id: string) => {
    let handle;
    try { handle = await open(filename(id),constants.O_RDONLY | constants.O_NOFOLLOW); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
    try {
      const file = await handle.stat();
      if (!file.isFile() || file.nlink !== 1 || file.size > 16384 || (process.platform !== 'win32' && (file.mode & 0o077) !== 0) || (typeof process.getuid === 'function' && file.uid !== process.getuid())) throw invalid();
      return await validate(JSON.parse(await handle.readFile('utf8')) as Entry);
    } finally { await handle.close(); }
  };
  return {
    async put(input: Entry) {
      const entry = await validate(input); const target = filename(entry.previewId);
      const handle = await open(target,constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,0o600);
      try { await handle.writeFile(JSON.stringify(entry) + '\n'); await handle.sync(); } finally { await handle.close(); }
      if (process.platform === 'linux') { const parent = await open(directory,constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); try { await parent.sync(); } finally { await parent.close(); } }
    },
    read,
    async list() { const files = await readdir(directory); const entries = []; for (const name of files) if (new RegExp('^chisa-account-preview-' + owner + '-[a-f0-9]{16}\\.json$').test(name)) { const entry = await read(name.slice(0,-5)); if (entry) entries.push(entry); } return entries; },
    async remove(id: string) {
      const entry = await read(id); if (!entry) return;
      await unlink(filename(id));
      if (process.platform === 'linux') { const parent = await open(directory,constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); try { await parent.sync(); } finally { await parent.close(); } }
    },
  };
}
