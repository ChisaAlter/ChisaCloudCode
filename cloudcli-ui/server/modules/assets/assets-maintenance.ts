import { constants, promises as fs } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { createImageAssetService } from './services/image-assets.service.js';

/** Offline operations use explicit administrator manifests; no HTTP endpoint exposes them. */
export async function runAssetMaintenance(args: string[]) {
  const [command, ...rest] = args;
  const options = new Map<string, string>();
  for (let index = 0; index < rest.length; index += 2) {
    if (!['--assets-dir', '--manifest', '--audit', '--writers-stopped'].includes(rest[index]) || !rest[index + 1]
      || options.has(rest[index])) throw new Error('Invalid or repeated maintenance option');
    options.set(rest[index], rest[index + 1]);
  }
  if (!['inventory', 'migrate', 'cleanup', 'recover'].includes(command ?? '')) {
    throw new Error('Usage: assets-maintenance inventory|migrate|cleanup|recover --assets-dir ROOT [--manifest FILE --audit NEW_FILE --writers-stopped true]');
  }
  const assetsDir = options.get('--assets-dir');
  if (!assetsDir || !path.isAbsolute(assetsDir)) throw new Error('An absolute assets directory is required');
  const service = createImageAssetService({ assetsDir });
  if (command === 'inventory') return service.reconciliationInventory();

  if (options.get('--writers-stopped') !== 'true') throw new Error('Stop application writers and pass --writers-stopped true');
  const manifestPath = options.get('--manifest');
  const auditPath = options.get('--audit');
  if (!manifestPath || !auditPath || !path.isAbsolute(manifestPath) || !path.isAbsolute(auditPath)) {
    throw new Error('Absolute manifest and new audit file paths are required');
  }
  const canonicalRoot = await fs.realpath(assetsDir);
  const auditDestination = path.join(await fs.realpath(path.dirname(auditPath)), path.basename(auditPath));
  const auditRelative = path.relative(canonicalRoot, auditDestination);
  if (!auditRelative || (!auditRelative.startsWith(`..${path.sep}`) && auditRelative !== '..' && !path.isAbsolute(auditRelative))) {
    throw new Error('The audit file must be outside the asset store');
  }
  const manifestInfo = await fs.lstat(manifestPath);
  if (!manifestInfo.isFile() || manifestInfo.isSymbolicLink() || manifestInfo.nlink !== 1 || manifestInfo.size > 1024 * 1024) {
    throw new Error('The manifest must be a regular file no larger than 1 MiB');
  }
  const manifestHandle = await fs.open(manifestPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  let manifest: unknown;
  try {
    const opened = await manifestHandle.stat();
    if (opened.dev !== manifestInfo.dev || opened.ino !== manifestInfo.ino || opened.nlink !== 1 || opened.size !== manifestInfo.size) {
      throw new Error('The manifest changed while opening');
    }
    const buffer = Buffer.alloc(opened.size + 1);
    let length = 0;
    while (length < buffer.length) {
      const result = await manifestHandle.read(buffer, length, buffer.length - length, length);
      if (!result.bytesRead) break;
      length += result.bytesRead;
    }
    const after = await manifestHandle.stat();
    if (length !== opened.size || after.size !== opened.size || after.nlink !== 1
      || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs) throw new Error('The manifest changed while reading');
    manifest = JSON.parse(buffer.subarray(0, length).toString('utf8'));
  } finally { await manifestHandle.close(); }
  if (!Array.isArray(manifest) || manifest.length > 10_000) throw new Error('The manifest must be an array with at most 10,000 entries');

  const audit = await fs.open(auditPath, 'wx', 0o600);
  const results: Array<{ index: number; state: 'completed' | 'rejected'; result?: unknown; error?: string }> = [];
  const recordAudit = async (record: unknown) => {
    await audit.writeFile(`${JSON.stringify({ at: new Date().toISOString(), ...record as object })}\n`);
    await audit.sync();
  };
  try {
    await recordAudit({ phase: 'start', command, assetsDir: path.resolve(assetsDir), entries: manifest.length });
    for (let index = 0; index < manifest.length; index += 1) {
      const entry: unknown = manifest[index];
      // Durable intent precedes mutation, making a crash between mutation and result reconcilable.
      await recordAudit({ phase: 'intent', index, entry });
      let outcome: (typeof results)[number];
      try {
        if (!entry || typeof entry !== 'object') throw new Error('Invalid manifest entry');
        const input = entry as Record<string, unknown>;
        let result: unknown;
        if (command === 'migrate') {
          if (typeof input.filename !== 'string' || typeof input.ownerUserId !== 'number' || typeof input.expectedSha256 !== 'string'
            || typeof input.evidence !== 'string' || (input.originalName !== undefined && typeof input.originalName !== 'string')
            || (input.allowInline !== undefined && typeof input.allowInline !== 'boolean')) throw new Error('Invalid migration entry');
          result = await service.migrateLegacyAsset({ filename: input.filename, ownerUserId: input.ownerUserId,
            expectedSha256: input.expectedSha256, evidence: input.evidence,
            originalName: input.originalName as string | undefined, allowInline: input.allowInline as boolean | undefined });
        } else if (command === 'recover') {
          if ((input.area !== 'assets' && input.area !== 'metadata') || typeof input.filename !== 'string'
            || typeof input.temporary !== 'string' || typeof input.expectedSha256 !== 'string') throw new Error('Invalid publication recovery entry');
          result = await service.completeOfflinePublication({ area: input.area, filename: input.filename,
            temporary: input.temporary, expectedSha256: input.expectedSha256, writersStopped: true });
        } else {
          if ((input.area !== 'assets' && input.area !== 'staging') || typeof input.filename !== 'string'
            || typeof input.expectedSha256 !== 'string') throw new Error('Invalid cleanup entry');
          result = await service.removeOfflineOrphan({ area: input.area, filename: input.filename,
            expectedSha256: input.expectedSha256, writersStopped: true });
        }
        outcome = { index, state: 'completed', result };
      } catch (error) {
        outcome = { index, state: 'rejected', error: error instanceof Error ? error.message : 'Operation failed' };
      }
      // An audit write failure stops the run. Do not relabel a successful mutation as rejected.
      // Its durable intent remains available for reconciliation.
      await recordAudit({ phase: 'result', ...outcome });
      results.push(outcome);
    }
    return { command, results, auditPath };
  } finally { await audit.close(); }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  runAssetMaintenance(process.argv.slice(2)).then(result => {
    console.log(JSON.stringify(result, null, 2));
    if ('results' in result && result.results.some(item => item.state === 'rejected')) process.exitCode = 1;
  }).catch(error => { console.error(error instanceof Error ? error.message : 'Maintenance failed'); process.exitCode = 1; });
}
