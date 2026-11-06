import { lstatSync, realpathSync } from 'node:fs';
import path from 'node:path';

import { AppError } from '@/shared/index.js';
import type { ProviderTrustedSlot } from '@/shared/index.js';

const CODE = '/runtime/provider-code';
function unavailable(): never { throw new AppError('Provider executable code must be prepared by the independent slot supervisor', { code: 'WORKSPACE_PROVIDER_RUNTIME_UNAVAILABLE',statusCode: 503 }); }
function exactSource(source: string) {
  if (!path.isAbsolute(source) || path.resolve(source) !== source || realpathSync(source) !== source || lstatSync(source).isSymbolicLink()) unavailable();
  return source;
}

/** Container composition selects an already installed read-only operator code
 * mount. The API no longer copies packages or executable code beneath HOME. */
export function prepareProviderCodeCache(slot?: ProviderTrustedSlot) {
  if (!slot) unavailable();
  const matches = slot.mounts.filter(mount => mount.target === CODE && !mount.writable);
  if (matches.length !== 1 || !lstatSync(exactSource(matches[0].source)).isDirectory()) unavailable();
  return matches[0];
}

/** Container composition maps its trusted model executable to the fixed CLI in
 * the selected slot; arbitrary host executables cannot create cache entries. */
export function stageProviderCli(executable: string | undefined,slot?: ProviderTrustedSlot) {
  if (!slot || !slot.cli || !slot.cli.startsWith(CODE + '/') || path.posix.resolve(slot.cli) !== slot.cli || (executable !== undefined && executable !== slot.executableSource)) unavailable();
  const matches = slot.mounts.filter(mount => !mount.writable && (slot.cli === mount.target || slot.cli!.startsWith(mount.target + '/')));
  if (!matches.length) unavailable();
  const mount = matches.sort((a,b) => b.target.length - a.target.length)[0];exactSource(mount.source);
  const source = slot.cli === mount.target ? mount.source : path.join(mount.source,path.posix.relative(mount.target,slot.cli));
  if (!lstatSync(exactSource(source)).isFile()) unavailable();
  return { mount,executable: slot.cli };
}
