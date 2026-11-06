import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';

import type { getWorkspaceBrokerAdmission } from '@/modules/workspace-runtime/index.js';
import { AppError } from '@/shared/index.js';

function unavailable() { return new AppError('This execution requires an exact operator-enrolled workspace profile', { code: 'WORKSPACE_BROKER_PROFILE_UNAVAILABLE', statusCode: 503 }); }
function canonical(source: string) {
  if (!path.isAbsolute(source) || path.resolve(source) !== source || realpathSync(source) !== source) throw unavailable();
  const stats = lstatSync(source);
  if (stats.isSymbolicLink() || (!stats.isDirectory() && !stats.isFile())) throw unavailable();
  return source;
}
function mounts(value: Array<{ source: string; target: string; writable: boolean }>) {
  if (!Array.isArray(value) || value.length > 256) throw unavailable();
  const targets = new Set<string>();
  return value.map(entry => {
    if (!entry || typeof entry.source !== 'string' || typeof entry.target !== 'string' || typeof entry.writable !== 'boolean' ||
      !path.posix.isAbsolute(entry.target) || path.posix.resolve(entry.target) !== entry.target || /[\0\r\n,]/.test(entry.source + entry.target) || targets.has(entry.target)) throw unavailable();
    targets.add(entry.target);
    return { source: canonical(entry.source), target: entry.target, writable: entry.writable };
  }).sort((a,b) => a.target.localeCompare(b.target));
}
function gitMounts(args: string[]) {
  const result: Array<{ source: string; target: string; writable: boolean }> = [];
  for (let index = 0; index < args.length; index += 2) {
    const match = /^(.+):([^:]+):(ro|rw)$/.exec(args[index + 1] ?? '');
    if (args[index] !== '--volume' || !match) throw unavailable();
    result.push({ source: match[1], target: match[2], writable: match[3] === 'rw' });
  }
  return mounts(result);
}

/** The bridge stream launcher selects an immutable operator profile. Paths in the
 * old provider/Git caller shape are exact selectors only; none is sent to broker
 * as a mount request, and an unregistered set never acquires a fallback profile. */
export function selectWorkspaceBrokerProfile(admission: Awaited<ReturnType<typeof getWorkspaceBrokerAdmission>>, input: {
  purpose: 'provider' | 'shell' | 'worker'; readOnly: boolean;
  runtimeMounts?: Array<{ source: string; target: string; writable: boolean }>; gitMounts?: string[];
  environment: Record<string,string>;
}) {
  try {
    const filename = process.env.CHISA_WORKSPACE_BROKER_PROFILE_CONFIG;
    if (!filename || canonical(filename) !== filename) throw unavailable();
    // This is operator policy, not another API registration channel. In Linux the
    // file and every parent are root-owned, immutable to API/worker identities.
    if (process.platform !== 'win32') {
      for (let current = filename;; current = path.dirname(current)) {
        const stats = lstatSync(current);
        if (stats.uid !== 0 || (stats.mode & 0o022) !== 0) throw unavailable();
        if (path.dirname(current) === current) break;
      }
    }
    const fd = openSync(filename,constants.O_RDONLY | constants.O_NOFOLLOW);
    let value: { version?: number; profiles?: Array<{ workspaceId: string; generation: string; root: string; profileId: string;
      purpose: string; readOnly: boolean; runtimeMounts: Array<{ source: string; target: string; writable: boolean }>;
      gitMounts: Array<{ source: string; target: string; writable: boolean }>; environment?: Record<string,string> }> };
    try {
      const before = fstatSync(fd);
      if (!before.isFile() || before.nlink !== 1 || before.size > 1024 * 1024) throw unavailable();
      value = JSON.parse(readFileSync(fd,'utf8'));
      const after = fstatSync(fd); const named = lstatSync(filename);
      if (before.dev !== named.dev || before.ino !== named.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw unavailable();
    } finally { closeSync(fd); }
    if (value.version !== 1 || !Array.isArray(value.profiles) || value.profiles.length > 1024) throw unavailable();
    const requestedRuntime = JSON.stringify(mounts(input.runtimeMounts ?? []));
    const requestedGit = JSON.stringify(gitMounts(input.gitMounts ?? []));
    const candidates = value.profiles.filter(profile => profile.workspaceId === admission.workspaceId && profile.generation === admission.generation && profile.root === admission.root && profile.purpose === input.purpose && profile.readOnly === input.readOnly &&
      JSON.stringify(mounts(profile.runtimeMounts)) === requestedRuntime && JSON.stringify(mounts(profile.gitMounts)) === requestedGit);
    if (candidates.length !== 1 || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(candidates[0].profileId)) throw unavailable();
    const selected = candidates[0];
    const environment = { ...input.environment };
    for (const key of ['HOME','PATH','TMPDIR']) {
      if (environment[key] === undefined) continue;
      if (selected.environment?.[key] !== environment[key]) throw unavailable();
      // These values come from the broker's operator profile, never API env.
      delete environment[key];
    }
    return { profileId: selected.profileId, environment };
  } catch (error) { if (error instanceof AppError) throw error; throw unavailable(); }
}
