import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { runAssetMaintenance } from '../assets-maintenance.js';
import { AssetError, createImageAssetService } from '../services/image-assets.service.js';

async function fixture(run: (root: string, assets: string) => Promise<void>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'w02-maintenance-'));
  const assets = path.join(root, 'assets');
  await fs.mkdir(assets);
  try { await run(root, assets); }
  finally { await fs.rm(root, { recursive: true, force: true }); }
}
const hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');

test('inventory quarantines unknown owner and reports exact staged hashes without deleting files', () => fixture(async (_root, assets) => {
  const service = createImageAssetService({ assetsDir: assets });
  await service.inventory();
  await fs.writeFile(path.join(assets, 'legacy.txt'), 'legacy');
  const temporary = `${randomUUID()}.upload`;
  await fs.writeFile(path.join(assets, '.staging', temporary), 'partial');
  const result = await runAssetMaintenance(['inventory', '--assets-dir', assets]);
  assert.ok('assets' in result);
  assert.equal(result.assets[0].state, 'quarantined');
  assert.equal(result.assets[0].sha256, hash('legacy'));
  assert.equal(result.temporary[0].sha256, hash('partial'));
  assert.equal(await fs.readFile(path.join(assets, 'legacy.txt'), 'utf8'), 'legacy');
}));

test('migration manifest creates an audit intent/result and refuses arbitrary owner overwrite', () => fixture(async (root, assets) => {
  await fs.writeFile(path.join(assets, 'legacy.txt'), 'legacy');
  const manifest = path.join(root, 'mapping.json');
  const entry = { filename: 'legacy.txt', ownerUserId: 1, expectedSha256: hash('legacy'), evidence: 'verified upload log record 21' };
  await fs.writeFile(manifest, JSON.stringify([entry, { ...entry, ownerUserId: 2 }]));
  const audit = path.join(root, 'migration-audit.jsonl');
  const result = await runAssetMaintenance(['migrate', '--assets-dir', assets, '--manifest', manifest, '--audit', audit, '--writers-stopped', 'true']);
  assert.ok('results' in result);
  assert.deepEqual(result.results.map(record => record.state), ['completed', 'rejected']);
  const records = (await fs.readFile(audit, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(records.map(record => record.phase), ['start', 'intent', 'result', 'intent', 'result']);
  assert.equal(records[1].entry.evidence, entry.evidence);
  if (process.platform !== 'win32') assert.equal((await fs.stat(audit)).mode & 0o077, 0);
  const service = createImageAssetService({ assetsDir: assets });
  assert.equal((await service.openStoredAsset('legacy.txt', 1, 'files')).bytes.toString(), 'legacy');
  await assert.rejects(service.openStoredAsset('legacy.txt', 2, 'files'), (error: unknown) => error instanceof AssetError && error.statusCode === 404);
  await assert.rejects(runAssetMaintenance(['migrate', '--assets-dir', assets, '--manifest', manifest, '--audit', audit, '--writers-stopped', 'true']), /EEXIST/);
}));

test('offline cleanup needs explicit digest, protects registered files and does not age-delete unrelated legacy files', () => fixture(async (root, assets) => {
  const service = createImageAssetService({ assetsDir: assets });
  await service.inventory();
  await fs.writeFile(path.join(assets, 'registered.txt'), 'registered');
  await service.migrateLegacyAsset({ filename: 'registered.txt', ownerUserId: 1, expectedSha256: hash('registered'), evidence: 'trusted mapping' });
  await fs.writeFile(path.join(assets, 'orphan.txt'), 'orphan');
  await fs.writeFile(path.join(assets, 'keep.txt'), 'keep');
  const temp = `${randomUUID()}.upload`;
  await fs.writeFile(path.join(assets, '.staging', temp), 'temporary');
  const manifest = path.join(root, 'cleanup.json');
  await fs.writeFile(manifest, JSON.stringify([
    { area: 'assets', filename: 'registered.txt', expectedSha256: hash('registered') },
    { area: 'assets', filename: 'orphan.txt', expectedSha256: hash('wrong') },
    { area: 'assets', filename: 'orphan.txt', expectedSha256: hash('orphan') },
    { area: 'staging', filename: temp, expectedSha256: hash('temporary') },
  ]));
  await assert.rejects(runAssetMaintenance(['cleanup', '--assets-dir', assets, '--manifest', manifest, '--audit', path.join(root, 'no.jsonl')]), /Stop application writers/);
  const result = await runAssetMaintenance(['cleanup', '--assets-dir', assets, '--manifest', manifest, '--audit', path.join(root, 'maintenance.jsonl'), '--writers-stopped', 'true']);
  assert.ok('results' in result);
  assert.deepEqual(result.results.map(record => record.state), ['rejected', 'rejected', 'completed', 'completed']);
  assert.equal(await fs.readFile(path.join(assets, 'registered.txt'), 'utf8'), 'registered');
  assert.equal(await fs.readFile(path.join(assets, 'keep.txt'), 'utf8'), 'keep');
  assert.deepEqual(await fs.readdir(path.join(assets, '.staging')), []);
}));

test('recover finishes only a same-inode two-link publication and preserves the destination bytes', () => fixture(async (root, assets) => {
  const service = createImageAssetService({ assetsDir: assets });
  await service.inventory();
  await fs.writeFile(path.join(assets, 'legacy.txt'), 'legacy');
  await service.migrateLegacyAsset({ filename: 'legacy.txt', ownerUserId: 1, expectedSha256: hash('legacy'), evidence: 'verified mapping' });
  const metadataName = `${hash('legacy.txt')}.json`;
  const metadataPath = path.join(assets, '.metadata', metadataName);
  const originalMetadata = await fs.readFile(metadataPath);
  const dataTemporary = `${randomUUID()}.commit`;
  const metadataTemporary = `${randomUUID()}.commit`;
  await fs.link(path.join(assets, 'legacy.txt'), path.join(assets, '.staging', dataTemporary));
  await fs.link(metadataPath, path.join(assets, '.staging', metadataTemporary));
  await assert.rejects(service.openStoredAsset('legacy.txt', 1, 'files'), (error: unknown) => error instanceof AssetError && error.statusCode === 404);
  const inventory = await service.reconciliationInventory();
  assert.ok(inventory.temporary.every(entry => entry.state === 'interrupted-publication'));
  await fs.writeFile(path.join(assets, 'different.txt'), 'legacy');
  const manifest = path.join(root, 'recovery.json');
  await fs.writeFile(manifest, JSON.stringify([
    { temporary: dataTemporary, area: 'assets', filename: 'different.txt', expectedSha256: hash('legacy') },
    { temporary: dataTemporary, area: 'assets', filename: 'legacy.txt', expectedSha256: hash('wrong') },
    { temporary: dataTemporary, area: 'assets', filename: 'legacy.txt', expectedSha256: hash('legacy') },
    { temporary: metadataTemporary, area: 'metadata', filename: metadataName, expectedSha256: hash(originalMetadata) },
  ]));
  const result = await runAssetMaintenance(['recover', '--assets-dir', assets, '--manifest', manifest, '--audit', path.join(root, 'recovery-audit.jsonl'), '--writers-stopped', 'true']);
  assert.ok('results' in result);
  assert.deepEqual(result.results.map(record => record.state), ['rejected', 'rejected', 'completed', 'completed']);
  assert.equal((await service.openStoredAsset('legacy.txt', 1, 'files')).bytes.toString(), 'legacy');
  assert.deepEqual(await fs.readFile(metadataPath), originalMetadata);
  assert.deepEqual(await fs.readdir(path.join(assets, '.staging')), []);
  assert.equal((await fs.stat(path.join(assets, 'legacy.txt'))).nlink, 1);
  assert.equal((await fs.stat(metadataPath)).nlink, 1);
}));

test('audit failure after mutation stops immediately and leaves its durable intent for reconciliation', async t => fixture(async (root, assets) => {
  const manifest = path.join(root, 'mapping.json');
  const auditPath = path.join(root, 'audit-failure.jsonl');
  await fs.writeFile(path.join(assets, 'first.txt'), 'first');
  await fs.writeFile(path.join(assets, 'second.txt'), 'second');
  await fs.writeFile(manifest, JSON.stringify(['first', 'second'].map(name => ({ filename: `${name}.txt`, ownerUserId: 1, expectedSha256: hash(name), evidence: 'verified mapping' }))));
  const originalOpen = fs.open;
  t.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
    const handle = await originalOpen(...args);
    if (args[0] === auditPath) {
      const originalWrite = handle.writeFile.bind(handle);
      let writes = 0;
      t.mock.method(handle, 'writeFile', async (...writeArgs: Parameters<typeof handle.writeFile>) => {
        writes += 1;
        if (writes === 3) throw new Error('Injected audit disk failure');
        return originalWrite(...writeArgs);
      });
    }
    return handle;
  });
  await assert.rejects(runAssetMaintenance(['migrate', '--assets-dir', assets, '--manifest', manifest, '--audit', auditPath, '--writers-stopped', 'true']), /Injected audit disk failure/);
  const records = (await fs.readFile(auditPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(records.map(record => record.phase), ['start', 'intent']);
  const service = createImageAssetService({ assetsDir: assets });
  assert.equal((await service.openStoredAsset('first.txt', 1, 'files')).bytes.toString(), 'first');
  await assert.rejects(service.openStoredAsset('second.txt', 1, 'files'), (error: unknown) => error instanceof AssetError && error.statusCode === 404);
}));

test('maintenance refuses audit files inside the store before changing data', () => fixture(async (root, assets) => {
  const manifest = path.join(root, 'mapping.json');
  await fs.writeFile(manifest, JSON.stringify([{ filename: 'legacy.txt', ownerUserId: 1, expectedSha256: hash('legacy'), evidence: 'verified mapping' }]));
  await fs.writeFile(path.join(assets, 'legacy.txt'), 'legacy');
  await assert.rejects(runAssetMaintenance(['migrate', '--assets-dir', assets, '--manifest', manifest, '--audit', path.join(assets, 'audit.jsonl'), '--writers-stopped', 'true']), /outside the asset store/);
  assert.deepEqual(await fs.readdir(assets), ['legacy.txt']);
}));

test('control directory links are rejected and ordinary file symlinks never become readable', async t => fixture(async (root, assets) => {
  const target = path.join(root, 'external');
  await fs.mkdir(target);
  const metadata = path.join(assets, '.metadata');
  await fs.symlink(target, metadata, process.platform === 'win32' ? 'junction' : 'dir');
  const unsafe = createImageAssetService({ assetsDir: assets });
  await assert.rejects(unsafe.inventory(), /Unsafe asset storage directory/);
  await fs.unlink(metadata);
  const service = createImageAssetService({ assetsDir: assets });
  await service.inventory();
  const filename = 'legacy.txt';
  await fs.writeFile(path.join(assets, filename), 'safe');
  await service.migrateLegacyAsset({ filename, ownerUserId: 1, expectedSha256: hash('safe'), evidence: 'test mapping' });
  await fs.writeFile(path.join(target, 'payload'), 'safe');
  await fs.unlink(path.join(assets, filename));
  try { await fs.symlink(path.join(target, 'payload'), path.join(assets, filename), 'file'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EPERM' && process.platform === 'win32') {
      t.diagnostic('Windows file symlink creation requires privilege; directory junction rejection was verified.');
      return;
    }
    throw error;
  }
  await assert.rejects(service.openStoredAsset(filename, 1, 'files'), (error: unknown) => error instanceof AssetError && error.statusCode === 404);
}));
