/**
 * Filesystem path authorization.
 *
 * Extracted from server.ts's previewFile() for the same reason control-api.ts and
 * ws-guard.ts were: server.ts calls server.listen() at import time, so a test that
 * imports it boots a real listener. Unlike those two this is not a pure function —
 * it must touch the filesystem, because resolving symlinks is the whole point.
 *
 * There is exactly one copy of this check. previewFile() and the headless-run log
 * reader both call it. A second, subtly different implementation is precisely how
 * the realpath property gets lost.
 */

import fs from 'node:fs';
import path from 'node:path';

/**
 * Resolve `filePath` and return it only if it lands inside one of `allowedPrefixes`.
 * Returns null for anything that does not exist, cannot be resolved, or escapes.
 *
 * realpath BEFORE the prefix compare: path.resolve normalises `..` but follows no
 * symlinks, so a symlink sitting inside an allowed prefix and pointing at
 * ~/.secrets would pass a resolve-only check.
 *
 * The trailing path.sep on the prefix is load-bearing — without it `/comms-other`
 * matches the `/comms` prefix.
 */
export function resolveAllowedPath(filePath: string, allowedPrefixes: string[]): string | null {
  let resolved: string;
  try {
    resolved = fs.realpathSync(path.resolve(filePath));
  } catch {
    return null;
  }
  if (!allowedPrefixes.some(p => resolved.startsWith(p + path.sep))) return null;
  return resolved;
}
