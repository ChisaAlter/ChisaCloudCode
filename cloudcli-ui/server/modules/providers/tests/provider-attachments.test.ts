import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import sharp from 'sharp';

import { AssetError, createImageAssetService } from '@/modules/assets/index.js';
import { buildClaudeUserContent, buildCodexInputItems } from '@/shared/index.js';
import { createProviderAttachmentsService } from '../services/provider-attachments.service.js';

async function fixture(run: (root: string, store: ReturnType<typeof createImageAssetService>, service: ReturnType<typeof createProviderAttachmentsService>) => Promise<void>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'provider-snapshots-'));
  const store = createImageAssetService({ assetsDir: root });
  const service = createProviderAttachmentsService({ assetsRoot: root, stagingParent: root, readStoredAsset: store.openStoredAsset });
  try { await store.inventory(); await run(root, store, service); }
  finally { await fs.rm(root, { recursive: true, force: true }); }
}

async function upload(root: string, store: ReturnType<typeof createImageAssetService>, bytes: Buffer, owner = 7) {
  const source = path.join(root, '.staging', `${randomUUID()}.upload`);
  await fs.writeFile(source, bytes);
  const [record] = await store.saveUploads([{ path: source, originalname: 'picture.png', mimetype: 'image/png' }], owner, 'images');
  return record;
}
const raster = () => sharp({ create: { width: 3, height: 2, channels: 4, background: '#cc4422' } }).png().toBuffer();
const unavailable = (error: unknown) => error instanceof AssetError && error.statusCode === 404;

test('verified original bytes survive path replacement in both Claude and Codex consumers', () => fixture(async (root, store, service) => {
  const bytes = await raster();
  const record = await upload(root, store, bytes);
  const snapshots = await service.readImages([{ ...record, mimeType: 'image/jpeg', name: 'forged.jpg', size: 1 }], { userId: 7 });
  assert.equal(snapshots[0].mimeType, 'image/png');
  assert.equal(snapshots[0].name, 'picture.png');
  assert.deepEqual(Buffer.from(snapshots[0].bytes), bytes);
  await fs.rename(record.path, path.join(root, 'old-original.png'));
  await fs.writeFile(record.path, 'replacement secret');
  const blocks = await buildClaudeUserContent('describe', snapshots);
  const image = blocks.find((block) => block.type === 'image');
  assert.equal(image?.source.data, bytes.toString('base64'));
  const staged = await service.stage(snapshots);
  try {
    const [prepared] = staged.attachments;
    assert.notEqual(prepared.path, record.path);
    assert.deepEqual(buildCodexInputItems('describe', staged.attachments), [{ type: 'text', text: 'describe' }, { type: 'local_image', path: prepared.path }]);
    assert.deepEqual(await fs.readFile(prepared.path), bytes);
    if (process.platform !== 'win32') {
      assert.equal((await fs.stat(path.dirname(prepared.path))).mode & 0o777, 0o700);
      assert.equal((await fs.stat(prepared.path)).mode & 0o777, 0o400);
    }
    await staged.dispose();
    await assert.rejects(fs.stat(prepared.path), { code: 'ENOENT' });
    await staged.dispose();
  } finally { await staged.dispose(); }
  await assert.rejects(service.readImages([record], { userId: 7 }), unavailable);
}));

test('a foreign owned upload cannot fall back to the workspace reader', () => fixture(async (root, store, service) => {
  const record = await upload(root, store, await raster());
  let workspaceReads = 0;
  await assert.rejects(service.readImages([record], { userId: 8, readWorkspaceImage: async () => { workspaceReads += 1; throw new Error('must not read'); } }), unavailable);
  assert.equal(workspaceReads, 0);
}));

test('host paths and caller-supplied byte capabilities are rejected without admission', () => fixture(async (root, _store, service) => {
  const outside = path.join(root, 'project', 'secret.png');
  await fs.mkdir(path.dirname(outside));
  const bytes = await raster();
  await fs.writeFile(outside, bytes);
  await assert.rejects(service.readImages([{ path: outside, mimeType: 'image/png', size: bytes.length, bytes }], { userId: 7 }), unavailable);
  await assert.rejects(service.readImages([{ path: 'project/secret.png' }], { userId: 7 }), unavailable);
  await assert.rejects(service.readFiles([{ path: outside }], { userId: 7, readWorkspaceImage: async () => { throw new Error('image capability cannot authorize files'); } }), unavailable);
}));

test('admitted project-image readers preserve selectors and produce detached snapshots', () => fixture(async (_root, _store, service) => {
  const bytes = await raster();
  const original = Buffer.from(bytes);
  const snapshots = await service.readImages([{ path: 'shot.png', mimeType: 'image/svg+xml' }], { userId: 7,
    readWorkspaceImage: async (selector) => {
      assert.equal(selector, 'shot.png');
      return { path: 'admitted/shot.png', mimeType: 'image/png', size: bytes.length, bytes };
    } });
  bytes.fill(0);
  assert.deepEqual(Buffer.from(snapshots[0].bytes), original);
  assert.equal(snapshots[0].mimeType, 'image/png');
}));

test('revocation while the verified reader awaits rejects before snapshot consumption', () => fixture(async (_root, _store, service) => {
  let active = true;
  const bytes = await raster();
  await assert.rejects(service.readImages([{ path: 'shot.png' }], { userId: 7,
    assertActive: () => { if (!active) throw new Error('login revoked'); },
    readWorkspaceImage: async (selector) => {
      await Promise.resolve();
      active = false;
      return { path: selector, mimeType: 'image/png', size: bytes.length, bytes };
    } }), /login revoked/);
}));

test('non-image owned files stage the verified original bytes with server metadata', () => fixture(async (root, store, service) => {
  const source = path.join(root, '.staging', `${randomUUID()}.upload`);
  const bytes = Buffer.from('%PDF-1.7 test document');
  await fs.writeFile(source, bytes);
  const [record] = await store.saveUploads([{ path: source, originalname: 'report.pdf', mimetype: 'application/pdf' }], 7, 'files');
  const snapshots = await service.readFiles([record], { userId: 7 });
  const staged = await service.stage(snapshots);
  try {
    assert.equal(staged.attachments[0].name, 'report.pdf');
    assert.deepEqual(await fs.readFile(staged.attachments[0].path), bytes);
    await assert.rejects(service.readImages([record], { userId: 7 }), /verified attachment snapshot/);
  } finally { await staged.dispose(); }
}));
