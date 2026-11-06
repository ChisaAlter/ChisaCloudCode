import { constants, type Stats } from 'node:fs';
import { lstat, mkdir, open, realpath } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/** Workspace-broker service uses a private, durable JSON document under two SQLite locks.
 * The lifetime lock is separate from the transactional document so async daemon work
 * cannot allow another broker to dispatch stale records. SQLite releases it on death. */
export async function openWorkspaceBrokerRegistry<T>(directory: string, initial: T) {
  if (!path.isAbsolute(directory) || path.resolve(directory) !== directory) throw new Error('BROKER_REGISTRY_PATH');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (await realpath(directory) !== directory) throw new Error('BROKER_REGISTRY_SYMLINK');
  const folder = await lstat(directory);
  const privateFile = (metadata: Stats) =>
    metadata.isFile() && !metadata.isSymbolicLink() && metadata.nlink === 1 &&
    (process.platform === 'win32' || (metadata.mode & 0o077) === 0) &&
    (typeof process.getuid !== 'function' || metadata.uid === process.getuid());
  if (!folder.isDirectory() || folder.isSymbolicLink() ||
    (process.platform !== 'win32' && (folder.mode & 0o077) !== 0) ||
    (typeof process.getuid === 'function' && folder.uid !== process.getuid())) throw new Error('BROKER_REGISTRY_PERMISSIONS');
  const files = ['registry.sqlite', 'writer-lock.sqlite'];
  const pins: Array<{ file: string; dev: number; ino: number }> = [];
  for (const name of files) {
    const file = path.join(directory, name);
    try {
      const handle = await open(file, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      await handle.sync(); await handle.close();
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    const metadata = await lstat(file);
    if (!privateFile(metadata)) throw new Error('BROKER_REGISTRY_FILE');
    pins.push({ file, dev: metadata.dev, ino: metadata.ino });
    for (const suffix of ['-journal', '-wal', '-shm']) {
      const auxiliary = await lstat(file + suffix).catch(error => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw error;
      });
      if (auxiliary && !privateFile(auxiliary)) throw new Error('BROKER_REGISTRY_AUXILIARY');
    }
  }
  const check = async () => {
    const current = await lstat(directory);
    if (current.dev !== folder.dev || current.ino !== folder.ino || await realpath(directory) !== directory) throw new Error('BROKER_REGISTRY_REPLACED');
    for (const pin of pins) {
      const metadata = await lstat(pin.file);
      if (!privateFile(metadata) || metadata.dev !== pin.dev || metadata.ino !== pin.ino) throw new Error('BROKER_REGISTRY_REPLACED');
    }
  };
  const lifetime = new DatabaseSync(pins[1].file);
  let database: DatabaseSync;
  try {
    lifetime.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA busy_timeout=0; CREATE TABLE IF NOT EXISTS broker_lock (id INTEGER PRIMARY KEY); BEGIN EXCLUSIVE;');
    database = new DatabaseSync(pins[0].file);
    database.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA busy_timeout=0; CREATE TABLE IF NOT EXISTS broker_document (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL);');
    database.prepare('INSERT OR IGNORE INTO broker_document(id,value) VALUES(1,?)').run(JSON.stringify(initial));
  } catch (error) { lifetime.close(); throw error; }
  let closed = false;
  return {
    async read(): Promise<T> {
      if (closed) throw new Error('BROKER_REGISTRY_CLOSED');
      await check();
      const row = database.prepare('SELECT value FROM broker_document WHERE id=1').get() as { value: string };
      if (typeof row?.value !== 'string' || Buffer.byteLength(row.value) > 16 * 1024 * 1024) throw new Error('BROKER_REGISTRY_CORRUPT');
      return JSON.parse(row.value) as T;
    },
    async write(value: T) {
      if (closed) throw new Error('BROKER_REGISTRY_CLOSED');
      await check();
      const serialized = JSON.stringify(value);
      if (Buffer.byteLength(serialized) > 16 * 1024 * 1024) throw new Error('BROKER_REGISTRY_FULL');
      database.exec('BEGIN IMMEDIATE');
      try { database.prepare('UPDATE broker_document SET value=? WHERE id=1').run(serialized); database.exec('COMMIT'); }
      catch (error) { database.exec('ROLLBACK'); throw error; }
    },
    close() {
      if (closed) return;
      closed = true;
      database.close(); lifetime.exec('ROLLBACK'); lifetime.close();
    },
  };
}
