import { createHash } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { AppError, WORKSPACES_ROOT, type WorkspaceRuntimePreviewReservation } from '@/shared/index.js';

type PreviewWitness = {
  version: 1; userId: string; accountRoot: string; root: string; previewId: string;
  lease: NonNullable<WorkspaceRuntimePreviewReservation['lease']>;
};
const invalid = () => new AppError('Preview recovery identity is unavailable or changed', { code: 'PREVIEW_RECOVERY_REQUIRED', statusCode: 503 });
const privateEntry = (entry: Stats) => (process.platform !== 'linux' || (entry.mode & 0o077) === 0) &&
  (typeof process.getuid !== 'function' || entry.uid === process.getuid());

async function location(userId: string, previewId?: string, create = false) {
  const accountRoot = await realpath(WORKSPACES_ROOT);
  if (accountRoot !== path.resolve(WORKSPACES_ROOT) || !userId || /[\r\n\0]/.test(userId)) throw invalid();
  const owner = createHash('sha256').update(accountRoot + '\0' + userId).digest('hex').slice(0, 20);
  if (previewId && !new RegExp('^chisa-account-preview-' + owner + '-[a-f0-9]{16}$').test(previewId)) throw invalid();
  const state = path.join(await realpath(os.homedir()), '.chisa-workspace-runtime');
  const directory = path.join(state, 'previews');
  if (state === accountRoot || state.startsWith(accountRoot + path.sep)) throw invalid();
  for (const target of [state, directory]) {
    if (create) await mkdir(target, { mode: 0o700 }).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; });
    const entry = await lstat(target).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT' && !create) return undefined; throw error; });
    if (!entry) return { accountRoot, directory, owner, exists: false };
    if (!entry.isDirectory() || entry.isSymbolicLink() || !privateEntry(entry) || await realpath(target) !== target) throw invalid();
    if (create) await syncDirectory(path.dirname(target));
  }
  return { accountRoot, directory, owner, exists: true };
}

async function syncDirectory(directory: string) {
  if (process.platform !== 'linux') return;
  const descriptor = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await descriptor.sync(); } finally { await descriptor.close(); }
}

async function validate(value: unknown, userId: string, previewId: string, accountRoot: string): Promise<PreviewWitness> {
  if (!value || typeof value !== 'object') throw invalid();
  const witness = value as PreviewWitness;
  const lease = witness.lease;
  if (witness.version !== 1 || witness.userId !== userId || witness.previewId !== previewId || witness.accountRoot !== accountRoot ||
    typeof witness.root !== 'string' || !witness.root.startsWith(accountRoot + path.sep) || await realpath(witness.root) !== witness.root ||
    !lease || lease.owner !== 'claude' || lease.writerGate !== true || typeof lease.id !== 'string' || !lease.id ||
    typeof lease.epoch !== 'string' || !lease.epoch || !Number.isSafeInteger(lease.pid) || lease.pid <= 0 || lease.pid > 2_147_483_647 ||
    typeof lease.processStartTime !== 'string' || !/^\d+$/.test(lease.processStartTime) ||
    typeof lease.bootId !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(lease.bootId)) throw invalid();
  return witness;
}

/** Runtime stop/list reads this private inventory; the bridge independently revalidates it before orphan lease recovery. */
export async function readWorkspaceRuntimePreviewWitness(userId: string, previewId: string) {
  const target = await location(userId, previewId);
  if (!target.exists) return undefined;
  const filename = path.join(target.directory, previewId + '.json');
  const before = await lstat(filename).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; });
  if (!before) return undefined;
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || !privateEntry(before) || before.size > 16_384) throw invalid();
  const descriptor = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const entry = await descriptor.stat();
    if (entry.dev !== before.dev || entry.ino !== before.ino || !entry.isFile() || entry.nlink !== 1 || !privateEntry(entry) || entry.size > 16_384) throw invalid();
    let value: unknown;
    try { value = JSON.parse(await descriptor.readFile('utf8')); } catch { throw invalid(); }
    return await validate(value, userId, previewId, target.accountRoot);
  } finally { await descriptor.close(); }
}

/** Runtime startup persists an exact gate-backed reservation after retain and before Docker can mount the workspace. */
export async function persistWorkspaceRuntimePreviewWitness(userId: string, previewId: string, reservation: WorkspaceRuntimePreviewReservation) {
  if (reservation.lease?.writerGate !== true) return;
  const target = await location(userId, previewId, true);
  const witness = await validate({ version: 1, userId, accountRoot: target.accountRoot, root: reservation.root, previewId, lease: reservation.lease }, userId, previewId, target.accountRoot);
  const filename = path.join(target.directory, previewId + '.json');
  const descriptor = await open(filename, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await descriptor.writeFile(JSON.stringify(witness) + '\n', 'utf8'); await descriptor.sync(); }
  finally { await descriptor.close(); }
  await syncDirectory(target.directory);
}

/** Runtime removal drops only its verified witness after exact reservation cleanup succeeds. */
export async function removeWorkspaceRuntimePreviewWitness(userId: string, previewId: string, root: string) {
  const witness = await readWorkspaceRuntimePreviewWitness(userId, previewId);
  if (!witness) return;
  if (witness.root !== root) throw invalid();
  const target = await location(userId, previewId);
  const filename = path.join(target.directory, previewId + '.json');
  if (path.dirname(filename) !== target.directory) throw invalid();
  await unlink(filename);
  await syncDirectory(target.directory);
}

/** Runtime inventory includes stopped previews whose exact lease cleanup still needs a retry after restart. */
export async function listWorkspaceRuntimePreviewWitnesses(userId: string) {
  const target = await location(userId);
  if (!target.exists) return [];
  const names = (await readdir(target.directory)).filter(name => new RegExp('^chisa-account-preview-' + target.owner + '-[a-f0-9]{16}\\.json$').test(name));
  const entries = await Promise.all(names.map(name => readWorkspaceRuntimePreviewWitness(userId, name.slice(0, -5))));
  return entries.filter((entry): entry is PreviewWitness => entry !== undefined);
}
