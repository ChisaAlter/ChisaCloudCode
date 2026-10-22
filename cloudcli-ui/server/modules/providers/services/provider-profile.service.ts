import { constants, existsSync, lstatSync, realpathSync } from 'node:fs';
import { chmod, chown, copyFile, link, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';

import { sessionsDb } from '@/modules/database/index.js';
import { managedProviderHome, profileForArtifact, resolveProviderHome } from '@/modules/providers/services/provider-state.service.js';
import { AppError } from '@/shared/index.js';
import type { LLMProvider, ProviderProcessJob } from '@/shared/index.js';

type Provider = Exclude<LLMProvider, 'claude'>;
const HOME = '/runtime/provider-state/home';
const queues = new Map<string, Promise<void>>();
function unavailable(message: string) { return new AppError(message, { code: 'WORKSPACE_PROVIDER_PROFILE_UNAVAILABLE', statusCode: 503 }); }
function canonical(filename: string) {
  const stats = lstatSync(filename);
  if (stats.isSymbolicLink() || realpathSync(filename) !== path.resolve(filename) || (!stats.isFile() && !stats.isDirectory())) throw unavailable('Provider profiles require canonical regular files and directories.');
  return stats;
}
async function directory(filename: string, privateParent = false) {
  let existing = path.resolve(filename);
  while (!existsSync(existing)) { const parent = path.dirname(existing); if (parent === existing) break; existing = parent; }
  canonical(existing); // Reject a persisted symlink before recursive mkdir can follow it.
  await mkdir(filename, { recursive: true, mode: privateParent ? 0o700 : 0o755 });
  canonical(filename);
  if (!privateParent && process.getuid?.() === 0) await chown(filename, 1000, 1000);
}
async function lock(provider: string, signal?: AbortSignal) {
  const prior = queues.get(provider) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  queues.set(provider, prior.then(() => current));
  let cancel!: () => void;
  try {
    await Promise.race([prior, new Promise<never>((_resolve, reject) => {
      cancel = () => reject(signal?.reason ?? Object.assign(new Error('Provider profile preparation was aborted.'), { name: 'AbortError' }));
      signal?.addEventListener('abort', cancel, { once: true }); if (signal?.aborted) cancel();
    })]);
    signal?.throwIfAborted(); return release;
  } catch (error) { release(); throw error; }
  finally { signal?.removeEventListener('abort', cancel); }
}
function nativeId(job: ProviderProcessJob) {
  if (job.kind === 'codex') return job.providerSessionId;
  const index = job.args.indexOf('--session');
  return job.args.find((arg) => arg.startsWith('--resume='))?.slice(9) ?? (index >= 0 ? job.args[index + 1] : null);
}

/** Provider container composition mounts persistent dedicated provider state and fresh read-only credential snapshots; native host profiles are imported read-only and never receive copyback. */
export async function prepareProviderProfile(provider: Provider, sessionId: string, job: ProviderProcessJob, signal?: AbortSignal) {
  const release = await lock(`${provider}:${sessionId}`, signal);
  let credentialRoot = '';
  try {
    const hostHome = os.homedir();
    const home = managedProviderHome(provider, sessionId);
    const parent = path.dirname(home);
    await directory(parent, true);
    await directory(home);
    credentialRoot = path.join(parent, 'credentials-' + randomUUID());
    await directory(credentialRoot);
    const mounts: Array<{ source: string; target: string; writable: boolean }> = [];
    const writableRoots: Array<{ source: string; target: string }> = [];
    const budget = { files: 0, bytes: 0 };
    const copy = async (source: string, target: string, credential: boolean) => {
      signal?.throwIfAborted();
      const stats = canonical(source);
      if (stats.isDirectory()) {
        await directory(target);
        for (const name of await readdir(source)) {
          if (!credential && /-(?:wal|shm|journal)$/.test(name)) continue;
          await copy(path.join(source, name), path.join(target, name), credential);
        }
      } else {
        budget.files += 1; budget.bytes += stats.size;
        if (budget.files > 10_000 || budget.bytes > 256 * 1024 * 1024) throw unavailable('The selected provider import exceeds the bounded profile size.');
        if (!credential && existsSync(target)) return;
        await directory(path.dirname(target));
        if (/\.(?:db|sqlite|sqlite3)$/.test(source) && !credential) {
          const temporary = target + '.' + randomUUID() + '.tmp';
          const database = new Database(path.toNamespacedPath(source), { readonly: true, fileMustExist: true });
          try { await database.backup(path.toNamespacedPath(temporary)); } finally { database.close(); }
          try { await link(temporary, target); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
          await rm(temporary);
        } else {
          try { await copyFile(source, target, constants.COPYFILE_EXCL); }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
        }
        canonical(target);
        await chmod(target, credential ? 0o400 : 0o600);
        if (process.getuid?.() === 0) await chown(target, 1000, 1000);
      }
    };
    const state = async (relative: string) => {
      const source = path.join(home, relative); await directory(source);
      writableRoots.push({ source, target: `${HOME}/${relative.split(path.sep).join('/')}` });
      return source;
    };
    const credential = async (relative: string) => {
      const source = path.join(hostHome, relative); if (!existsSync(source)) return;
      const target = path.join(credentialRoot, relative); await copy(source, target, true);
      mounts.push({ source: target, target: `${HOME}/${relative.split(path.sep).join('/')}`, writable: false });
    };
    const id = nativeId(job);
    if (id && !/^[a-zA-Z0-9_-]{1,200}$/.test(id)) throw unavailable('The provider native session identifier is invalid.');
    if (provider === 'codex') {
      const store = await state('.codex');
      if (id) {
        const row = sessionsDb.getSessionByProviderSessionId(id) ?? sessionsDb.getSessionById(id);
        const importedHome = row?.jsonl_path ? profileForArtifact('codex', row.jsonl_path) : null;
        const source = path.join(importedHome ?? hostHome, '.codex', 'sessions');
        if (row?.jsonl_path?.startsWith(source + path.sep) && row.jsonl_path.endsWith('.jsonl')) {
          const target = path.join(store, 'sessions', path.relative(source, row.jsonl_path));
          if (path.resolve(row.jsonl_path) !== target) await copy(row.jsonl_path, target, false);
          else {
            canonical(target); await directory(path.dirname(target));
            await chmod(target, 0o600);
            if (process.getuid?.() === 0) await chown(target, 1000, 1000);
          }
        }
      }
      for (const name of ['auth.json', 'config.toml', 'skills']) await credential(path.join('.codex', name));
    } else if (provider === 'cursor') {
      const store = await state('.cursor');
      const managedChats = path.join(store, 'chats');
      const alreadyPresent = id && existsSync(managedChats) && (await readdir(managedChats, { withFileTypes: true })).some((entry) => entry.isDirectory() && /^[a-f0-9]{32}$/i.test(entry.name) && existsSync(path.join(managedChats, entry.name, id, 'store.db')));
      if (id && !alreadyPresent) {
        const row = sessionsDb.getSessionByProviderSessionId(id) ?? sessionsDb.getSessionById(id);
        const importedHome = row?.provider_profile_path ? resolveProviderHome('cursor', row.session_id, row.provider_profile_path) : row?.jsonl_path ? profileForArtifact('cursor', row.jsonl_path) : null;
        const chats = path.join(importedHome ?? hostHome, '.cursor', 'chats');
        const entries = existsSync(chats) ? await readdir(chats, { withFileTypes: true }) : [];
        if (entries.length > 10_000) throw unavailable('Cursor native history exceeds the bounded resume lookup.');
        const matches = entries.filter((entry) => entry.isDirectory() && /^[a-f0-9]{32}$/i.test(entry.name)).map((entry) => path.join(chats, entry.name, id)).filter(existsSync);
        if (matches.length > 1) throw unavailable('Cursor native history is ambiguous.');
        if (matches.length) { const target = path.join(store, 'chats', path.relative(chats, matches[0])); if (target !== matches[0]) await copy(matches[0], target, false); }
      }
      for (const name of ['auth.json', 'cli-config.json', 'mcp.json', 'skills']) await credential(path.join('.cursor', name));
      for (const name of ['auth.json', 'config.json']) await credential(path.join('.config', 'cursor', name));
    } else {
      const store = await state(path.join('.local', 'share', 'opencode'));
      const row = id ? sessionsDb.getSessionByProviderSessionId(id) ?? sessionsDb.getSessionById(id) : null;
      const importedHome = row?.provider_profile_path ? resolveProviderHome('opencode', row.session_id, row.provider_profile_path) : hostHome;
      const database = path.join(importedHome, '.local', 'share', 'opencode', 'opencode.db');
      if (id && existsSync(database) && !existsSync(path.join(store, 'opencode.db'))) await copy(database, path.join(store, 'opencode.db'), false);
      await credential(path.join('.local', 'share', 'opencode', 'auth.json'));
      await credential(path.join('.config', 'opencode'));
    }
    // Create nested read-only mount targets before launch. Docker must not
    // manufacture missing credential files inside the persistent writable store.
    for (const mount of mounts) for (const writable of writableRoots) if (mount.target.startsWith(writable.target + '/')) {
      const destination = path.join(writable.source, path.relative(writable.target, mount.target));
      await directory(path.dirname(destination));
      if (!existsSync(destination)) {
        if (canonical(mount.source).isDirectory()) await directory(destination);
        else await writeFile(destination, '', { flag: 'wx', mode: 0o600 });
      }
      canonical(destination);
    }
    mounts.unshift(...writableRoots.map((entry) => ({ ...entry, writable: true })));
    let closed = false;
    return { home, mounts,
      async finish(mode: 'publish' | 'discard' | 'retain') {
        if (closed) return; closed = true;
        try { if (mode !== 'retain') await rm(credentialRoot, { recursive: true, force: true }); }
        finally { release(); }
      },
    };
  } catch (error) {
    try { if (credentialRoot) await rm(credentialRoot, { recursive: true, force: true }); }
    finally { release(); }
    throw error;
  }
}
