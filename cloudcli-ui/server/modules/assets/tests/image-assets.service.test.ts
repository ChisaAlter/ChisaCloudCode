import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import sharp from 'sharp';

import { AssetError, createImageAssetService } from '../services/image-assets.service.js';

async function fixture(run: (service: ReturnType<typeof createImageAssetService>, root: string) => Promise<void>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'w02-assets-'));
  const service = createImageAssetService({ assetsDir: root });
  try { await service.inventory(); await run(service, root); }
  finally { await fs.rm(root, { recursive: true, force: true }); }
}

async function staged(root: string, bytes: Buffer | string, name = 'document.html', mimetype = 'text/html') {
  const target = path.join(root, '.staging', `${randomUUID()}.upload`);
  await fs.writeFile(target, bytes);
  return { path: target, originalname: name, mimetype };
}

async function raster(format: 'png' | 'jpeg' | 'webp' | 'gif' = 'png') {
  return sharp({ create: { width: 3, height: 2, channels: 4, background: '#cc4422' } }).toFormat(format).toBuffer();
}

const hash = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const isStatus = (status: number) => (error: unknown) => error instanceof AssetError && error.statusCode === status;

for (const format of ['png', 'jpeg', 'gif', 'webp'] as const) {
  test(`fully decoded ${format} has server MIME, digest and owner; metadata is private`, () => fixture(async (service, root) => {
    const [record] = await service.saveUploads([await staged(root, await raster(format), 'forged.html', 'text/html')], 7, 'files');
    assert.equal(record.mimeType, `image/${format}`);
    const filename = path.basename(record.path);
    const asset = await service.openStoredAsset(filename, '7', 'images');
    assert.equal(asset.contentType, `image/${format}`);
    assert.match(asset.contentDisposition, /^inline;/);
    assert.equal((await sharp(asset.bytes).metadata()).format, format);
    const metas = (await fs.readdir(path.join(root, '.metadata'))).filter(name => name.endsWith('.json'));
    assert.equal(metas.length, 1);
    const metadata = JSON.parse(await fs.readFile(path.join(root, '.metadata', metas[0]), 'utf8'));
    assert.equal(metadata.ownerUserId, 7);
    assert.equal(metadata.kind, 'image');
    assert.equal(metadata.validationVersion, 1);
    assert.equal(metadata.sha256, hash(asset.bytes));
    assert.equal(metadata.size, asset.bytes.length);
    assert.match(metadata.storageId, /^[a-f0-9-]+$/);
    if (process.platform !== 'win32') assert.equal((await fs.stat(path.join(root, '.metadata', metas[0]))).mode & 0o077, 0);
    await assert.rejects(service.openStoredAsset(filename, 8, 'images'), isStatus(404));
    await assert.rejects(service.openStoredAsset(filename, undefined, 'images'), isStatus(401));
    assert.deepEqual(await fs.readdir(path.join(root, '.staging')), []);
  }));
}

test('HTML, SVG, PDF and unknown files are always safe downloads on both routes', () => fixture(async (service, root) => {
  for (const [name, mime, data] of [['evil.html', 'image/png', '<script>window.marker=1</script>'],
    ['evil.svg', 'image/svg+xml', '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>'],
    ['report.pdf', 'application/pdf', '%PDF-1.7'], ['unknown.zzz', 'application/x-evil', 'unknown']]) {
    const [record] = await service.saveUploads([await staged(root, data, name, mime)], 1, 'files');
    assert.equal(record.mimeType, 'application/octet-stream');
    for (const mode of ['images', 'files'] as const) {
      const result = await service.openStoredAsset(path.basename(record.path), 1, mode);
      assert.equal(result.contentType, 'application/octet-stream');
      assert.match(result.contentDisposition, /^attachment;/);
      assert.equal(result.bytes.toString(), data);
    }
  }
}));

test('image endpoint rejects renamed HTML but accepts SVG only as a download', () => fixture(async (service, root) => {
  await assert.rejects(service.saveUploads([await staged(root, '<script>x()</script>', 'image.png', 'image/png')], 1, 'images'), isStatus(415));
  const [svg] = await service.saveUploads([await staged(root, '<svg/>', 'picture.svg', 'image/svg+xml')], 1, 'images');
  assert.equal((await service.openStoredAsset(path.basename(svg.path), 1, 'images')).contentType, 'application/octet-stream');
}));

test('full decode rejects truncated raster and aggregate pixel excess', () => fixture(async (service, root) => {
  const png = await raster();
  await assert.rejects(service.saveUploads([await staged(root, png.subarray(0, 40), 'image.png', 'image/png')], 1, 'images'), isStatus(415));
  const huge = await sharp({ create: { width: 5000, height: 5000, channels: 3, background: '#ffffff' } }).png().toBuffer();
  await assert.rejects(service.saveUploads([await staged(root, huge, 'large.png', 'image/png')], 1, 'images'),
    (error: unknown) => error instanceof AssetError && [413, 415].includes(error.statusCode));
  assert.deepEqual(await service.inventory(), []);
  assert.deepEqual(await fs.readdir(path.join(root, '.staging')), []);
}));

test('re-encoding strips executable appended data', () => fixture(async (service, root) => {
  const marker = '<script>localStorage.w02=1</script>';
  const [record] = await service.saveUploads([await staged(root, Buffer.concat([await raster(), Buffer.from(marker)]), 'x.png', 'image/png')], 1, 'images');
  const asset = await service.openStoredAsset(path.basename(record.path), 1, 'images');
  assert.equal(asset.bytes.includes(Buffer.from(marker)), false);
}));

test('descriptors use persistent metadata; another owner, traversal and unknown files cannot be admitted', () => fixture(async (service, root) => {
  const [record] = await service.saveUploads([await staged(root, 'hello', 'notes.txt', 'text/plain')], 1, 'files');
  assert.deepEqual(await service.authorizeAttachmentPaths([{ ...record, name: 'evil', mimeType: 'text/html', size: 0 }], 1), [record]);
  assert.deepEqual(await service.authorizeAttachmentPaths([], 1), []);
  await assert.rejects(service.authorizeAttachmentPaths([], null), isStatus(401));
  for (const user of [0, -1, 1.5, 'owner-1', {}, null]) await assert.rejects(service.authorizeAttachmentPaths([record], user), isStatus(401));
  await assert.rejects(service.authorizeAttachmentPaths([record], 2), isStatus(404));
  await assert.rejects(service.authorizeAttachmentPaths(['../secrets'], 1), isStatus(404));
  await fs.writeFile(path.join(root, 'legacy.png'), await raster());
  await assert.rejects(service.authorizeAttachmentPaths(['legacy.png'], 1), isStatus(404));
}));

test('stored bytes, stale validation versions and metadata omissions fail closed', () => fixture(async (service, root) => {
  const [record] = await service.saveUploads([await staged(root, await raster(), 'image.png', 'image/png')], 1, 'images');
  const filename = path.basename(record.path);
  const metadataPath = path.join(root, '.metadata', `${hash(filename)}.json`);
  const metadata = JSON.parse(await fs.readFile(metadataPath, 'utf8'));
  for (const changed of [{ ...metadata, kind: undefined }, { ...metadata, validatedMime: undefined },
    { ...metadata, validationVersion: 0 }, { ...metadata, ownerUserId: 2 }, { ...metadata, validatedMime: 'text/html' }]) {
    await fs.writeFile(metadataPath, JSON.stringify(changed));
    await assert.rejects(service.openStoredAsset(filename, 1, 'images'), isStatus(404));
  }
  await fs.writeFile(metadataPath, JSON.stringify(metadata));
  await fs.writeFile(record.path, '<script>changed</script>');
  await assert.rejects(service.openStoredAsset(filename, 1, 'images'), isStatus(404));
}));

test('served snapshot is unchanged when pathname is replaced after authorization', () => fixture(async (service, root) => {
  const [record] = await service.saveUploads([await staged(root, 'trusted')], 1, 'files');
  const result = await service.openStoredAsset(path.basename(record.path), 1, 'files');
  await fs.writeFile(record.path, 'mutated');
  const chunks: Buffer[] = [];
  for await (const chunk of result.stream) chunks.push(chunk as Buffer);
  assert.equal(Buffer.concat(chunks).toString(), 'trusted');
  await assert.rejects(service.openStoredAsset(path.basename(record.path), 1, 'files'), isStatus(404));
}));

test('hardlinked content or metadata cannot be read or overwritten by migration', () => fixture(async (service, root) => {
  const [record] = await service.saveUploads([await staged(root, 'trusted')], 1, 'files');
  const filename = path.basename(record.path);
  await fs.link(record.path, path.join(root, 'alias'));
  await assert.rejects(service.openStoredAsset(filename, 1, 'files'), isStatus(404));
  await fs.unlink(path.join(root, 'alias'));
  const metadataPath = path.join(root, '.metadata', `${hash(filename)}.json`);
  await fs.link(metadataPath, path.join(root, 'metadata-alias'));
  await assert.rejects(service.openStoredAsset(filename, 1, 'files'), isStatus(404));
  await assert.rejects(service.migrateLegacyAsset({ filename, ownerUserId: 2, expectedSha256: hash('trusted'), evidence: 'test-owner-proof' }), isStatus(409));
  assert.equal(JSON.parse(await fs.readFile(metadataPath, 'utf8')).ownerUserId, 1);
}));

test('legacy mapping requires explicit owner, digest and evidence and preserves original paths/bytes', () => fixture(async (service, root) => {
  const bytes = Buffer.concat([await raster(), Buffer.from('<script>legacy()</script>')]);
  await fs.writeFile(path.join(root, 'legacy.png'), bytes);
  await assert.rejects(service.openStoredAsset('legacy.png', 1, 'images'), isStatus(404));
  assert.equal((await service.inventory())[0].state, 'quarantined');
  await assert.rejects(service.migrateLegacyAsset({ filename: 'legacy.png', ownerUserId: 1, expectedSha256: hash('bad'), evidence: 'proof' }), isStatus(409));
  await assert.rejects(service.migrateLegacyAsset({ filename: 'legacy.png', ownerUserId: 1, expectedSha256: hash(bytes), evidence: '' }), isStatus(400));
  const input = { filename: 'legacy.png', ownerUserId: 1, expectedSha256: hash(bytes), evidence: 'admin confirmed source record 17', allowInline: true };
  const migration = await service.migrateLegacyAsset(input);
  assert.equal(migration.migrated, true);
  assert.equal(migration.attachment.path, path.join(root, 'legacy.png').replace(/\\/g, '/'));
  assert.deepEqual(await fs.readFile(path.join(root, 'legacy.png')), bytes);
  const preview = await service.openStoredAsset('legacy.png', 1, 'images');
  assert.equal(preview.contentType, 'image/png');
  assert.equal(preview.bytes.includes(Buffer.from('<script>')), false);
  assert.deepEqual((await service.openStoredAsset('legacy.png', 1, 'files')).bytes, bytes);
  assert.equal((await service.migrateLegacyAsset(input)).migrated, false);
  await assert.rejects(service.migrateLegacyAsset({ ...input, ownerUserId: 2 }), isStatus(409));
  await assert.rejects(service.openStoredAsset('legacy.png', 2, 'images'), isStatus(404));
}));

test('migration without preview preserves binary data and defaults to safe download', () => fixture(async (service, root) => {
  const bytes = await raster();
  await fs.writeFile(path.join(root, 'old.png'), bytes);
  await service.migrateLegacyAsset({ filename: 'old.png', ownerUserId: 1, expectedSha256: hash(bytes), evidence: 'explicit mapping' });
  assert.equal((await service.openStoredAsset('old.png', 1, 'images')).contentType, 'application/octet-stream');
}));

test('download filenames are safely encoded and internal control names are not addressable', () => fixture(async (service, root) => {
  const [record] = await service.saveUploads([await staged(root, 'x', '报告"\r\nInjected.txt')], 1, 'files');
  const asset = await service.openStoredAsset(path.basename(record.path), 1, 'images');
  assert.doesNotMatch(asset.contentDisposition, /[\r\n]/);
  assert.match(asset.contentDisposition, /filename\*=UTF-8''%E6%8A%A5/);
  for (const invalid of ['../file', '..', '.metadata', 'a/b', 'a\\b', '%2fsecret', 'CON', 'name.', 'x\u0000']) {
    await assert.rejects(service.openStoredAsset(invalid, 1, 'files'), isStatus(400));
  }
}));

test('abort before validation removes staged bytes without publishing an asset', () => fixture(async (service, root) => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(service.saveUploads([await staged(root, 'cancelled')], 1, 'files', controller.signal), isStatus(400));
  assert.deepEqual(await service.inventory(), []);
  assert.deepEqual(await fs.readdir(path.join(root, '.staging')), []);
}));

test('abort during either data or metadata publication rolls back the owned objects', async t => {
  const originalLink = fs.link;
  for (const abortAt of [1, 2]) {
    await fixture(async (service, root) => {
      const controller = new AbortController();
      let publications = 0;
      const link = t.mock.method(fs, 'link', async (...args: Parameters<typeof fs.link>) => {
        await originalLink(...args);
        publications += 1;
        if (publications === abortAt) controller.abort();
      });
      try {
        await assert.rejects(service.saveUploads([await staged(root, 'cancelled')], 1, 'files', controller.signal), isStatus(400));
        assert.deepEqual(await service.inventory(), []);
        assert.deepEqual(await fs.readdir(path.join(root, '.metadata')), []);
        assert.deepEqual(await fs.readdir(path.join(root, '.staging')), []);
      } finally { link.mock.restore(); }
    });
  }
});

test('multi-file validation failure removes published records and every temporary upload', () => fixture(async (service, root) => {
  const files = [await staged(root, await raster(), 'one.png', 'image/png'), await staged(root, 'not an image', 'bad.png', 'image/png')];
  await assert.rejects(service.saveUploads(files, 1, 'images'), isStatus(415));
  assert.deepEqual(await service.inventory(), []);
  assert.deepEqual(await fs.readdir(path.join(root, '.metadata')), []);
  assert.deepEqual(await fs.readdir(path.join(root, '.staging')), []);
}));
