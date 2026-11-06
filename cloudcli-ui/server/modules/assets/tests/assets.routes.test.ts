import assert from 'node:assert/strict';
import { once } from 'node:events';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import express from 'express';
import sharp from 'sharp';

import { createAssetsRouter } from '../assets.routes.js';
import { createImageAssetService } from '../services/image-assets.service.js';

async function fixture(run: (base: string, root: string) => Promise<void>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'w02-router-'));
  const app = express();
  // Deliberately small trusted-auth fixture: route tests do not claim JWT implementation coverage.
  app.use((request, _response, next) => {
    const userId = Number(request.headers['x-test-owner']);
    if (userId) (request as express.Request & { user: { id: number } }).user = { id: userId };
    next();
  });
  app.use('/api/assets', createAssetsRouter(createImageAssetService({ assetsDir: root })));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try { await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/assets`, root); }
  finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function upload(base: string, mode: 'images' | 'files', body: string | Buffer, filename: string, type: string, owner = 1) {
  const data = new FormData();
  data.append(mode, new Blob([new Uint8Array(Buffer.from(body))], { type }), filename);
  return fetch(`${base}/${mode}`, { method: 'POST', headers: { 'x-test-owner': String(owner) }, body: data });
}

function assertDownload(response: Response) {
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'application/octet-stream');
  assert.match(response.headers.get('content-disposition')!, /^attachment;/);
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  assert.match(response.headers.get('content-security-policy')!, /sandbox/);
}

test('real multipart HTML upload is never an executable document through either route, queries or encoding', () => fixture(async base => {
  const html = '<!doctype html><script>window.W02_MARKER=localStorage.getItem("w02-sentinel")</script>';
  const response = await upload(base, 'files', html, 'report.html', 'text/html');
  assert.equal(response.status, 200);
  const payload = await response.json() as { files: Array<{ name: string; path: string; mimeType: string }> };
  const [record] = payload.files;
  assert.equal(record.name, 'report.html');
  assert.equal(record.mimeType, 'application/octet-stream');
  const filename = path.basename(record.path);
  const encoded = `%${filename.charCodeAt(0).toString(16)}${filename.slice(1)}`;
  for (const mode of ['files', 'images']) {
    for (const suffix of [filename, `${filename}?token=fixture&download=0`, encoded]) {
      const result = await fetch(`${base}/${mode}/${suffix}`, { headers: { 'x-test-owner': '1' } });
      assertDownload(result);
      assert.equal(await result.text(), html);
    }
  }
}));

test('forged MIME and renamed HTML are rejected by image upload; SVG remains a downloadable attachment', () => fixture(async base => {
  assert.equal((await upload(base, 'images', '<script>marker()</script>', 'fake.png', 'image/png')).status, 415);
  const response = await upload(base, 'images', '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>', 'x.svg', 'image/svg+xml');
  assert.equal(response.status, 200);
  const data = await response.json() as { images: Array<{ path: string }> };
  assertDownload(await fetch(`${base}/images/${path.basename(data.images[0].path)}`, { headers: { 'x-test-owner': '1' } }));
  const generic = await upload(base, 'files', '<html>hello</html>', 'fake.png', 'image/png');
  assert.equal(generic.status, 200);
  const file = await generic.json() as { files: Array<{ path: string }> };
  assertDownload(await fetch(`${base}/images/${path.basename(file.files[0].path)}`, { headers: { 'x-test-owner': '1' } }));
}));

test('normalized raster is inline only on images endpoint and owner checks cover all reads', () => fixture(async base => {
  const png = await sharp({ create: { width: 8, height: 6, channels: 3, background: '#234567' } }).png().toBuffer();
  const response = await upload(base, 'files', png, 'user-name.png', 'image/png');
  const data = await response.json() as { files: Array<{ path: string; name: string; size: number }> };
  assert.equal(response.status, 200);
  const filename = path.basename(data.files[0].path);
  const image = await fetch(`${base}/images/${filename}`, { headers: { 'x-test-owner': '1' } });
  assert.equal(image.status, 200);
  assert.equal(image.headers.get('content-type'), 'image/png');
  assert.match(image.headers.get('content-disposition')!, /^inline;/);
  assert.equal((await sharp(Buffer.from(await image.arrayBuffer())).metadata()).width, 8);
  assertDownload(await fetch(`${base}/files/${filename}`, { headers: { 'x-test-owner': '1' } }));
  for (const mode of ['images', 'files']) {
    assert.equal((await fetch(`${base}/${mode}/${filename}`, { headers: { 'x-test-owner': '2' } })).status, 404);
    assert.equal((await fetch(`${base}/${mode}/${filename}`)).status, 401);
    assert.equal((await fetch(`${base}/${mode}/${filename}?token=fixture`)).status, 401);
  }
}));

test('legacy unknown files and traversal/control-directory encodings are refused', () => fixture(async (base, root) => {
  await fs.writeFile(path.join(root, 'legacy.html'), '<script>legacy()</script>');
  for (const mode of ['images', 'files']) {
    const legacy = await fetch(`${base}/${mode}/legacy.html`, { headers: { 'x-test-owner': '1' } });
    assert.equal(legacy.status, 404);
    for (const name of ['%2e%2e%2fsecret', '%2e%2e%5csecret', '.metadata', '%252e%252e%252fsecret', 'name%00', 'bad%3aname']) {
      const result = await fetch(`${base}/${mode}/${name}`, { headers: { 'x-test-owner': '1' } });
      assert.equal(result.status, 400, name);
    }
  }
  assert.equal(await fs.readFile(path.join(root, 'legacy.html'), 'utf8'), '<script>legacy()</script>');
}));

test('truncated images, byte limits and empty uploads fail without leaving readable records', () => fixture(async (base, root) => {
  const png = await sharp({ create: { width: 8, height: 6, channels: 3, background: '#123456' } }).png().toBuffer();
  assert.equal((await upload(base, 'images', png.subarray(0, 40), 'cut.png', 'image/png')).status, 415);
  assert.equal((await upload(base, 'images', Buffer.alloc(5 * 1024 * 1024 + 1), 'large.png', 'image/png')).status, 413);
  assert.equal((await upload(base, 'files', Buffer.alloc(10 * 1024 * 1024 + 1), 'large.bin', 'application/octet-stream')).status, 413);
  const empty = new FormData();
  assert.equal((await fetch(`${base}/files`, { method: 'POST', headers: { 'x-test-owner': '1' }, body: empty })).status, 400);
  assert.deepEqual((await fs.readdir(root)).filter(name => !name.startsWith('.')), []);
  assert.deepEqual(await fs.readdir(path.join(root, '.metadata')), []);
  assert.deepEqual(await fs.readdir(path.join(root, '.staging')), []);
}));

test('exact multipart file limits succeed while one extra file or unexpected field cleans every staged file', () => fixture(async (base, root) => {
  for (const [mode, limit] of [['images', 5], ['files', 10]] as const) {
    const bytes = mode === 'images' ? await sharp({ create: { width: 2, height: 2, channels: 3, background: '#123456' } }).png().toBuffer() : Buffer.from('file');
    for (const count of [limit, limit + 1]) {
      const data = new FormData();
      for (let index = 0; index < count; index += 1) data.append(mode, new Blob([new Uint8Array(bytes)], { type: mode === 'images' ? 'image/png' : 'text/plain' }), `item-${index}`);
      const response = await fetch(`${base}/${mode}`, { method: 'POST', headers: { 'x-test-owner': '1' }, body: data });
      assert.equal(response.status, count === limit ? 200 : 400);
      if (count === limit) assert.equal(((await response.json()) as Record<string, unknown[]>)[mode].length, limit);
      assert.deepEqual(await fs.readdir(path.join(root, '.staging')), []);
    }
  }
  const data = new FormData();
  data.append('files', new Blob(['file']), 'item.txt');
  data.append('ownerUserId', '2');
  assert.equal((await fetch(`${base}/files`, { method: 'POST', headers: { 'x-test-owner': '1' }, body: data })).status, 400);
  assert.deepEqual(await fs.readdir(path.join(root, '.staging')), []);
  assert.equal((await fs.readdir(root)).filter(name => !name.startsWith('.')).length, 15);
}));

test('unauthenticated uploads are rejected before creating temporary files', () => fixture(async (base, root) => {
  const data = new FormData();
  data.append('files', new Blob(['hello']), 'file.txt');
  assert.equal((await fetch(`${base}/files`, { method: 'POST', body: data })).status, 401);
  assert.deepEqual(await fs.readdir(root), []);
}));

test('aborted multipart upload removes its active staged object', () => fixture(async (base, root) => {
  const boundary = 'w02-aborted-upload';
  const prefix = `--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="partial.html"\r\nContent-Type: text/html\r\n\r\n`;
  const request = http.request(`${base}/files`, { method: 'POST', headers: {
    'x-test-owner': '1', 'content-type': `multipart/form-data; boundary=${boundary}`, 'content-length': '1000000',
  } });
  request.on('error', () => undefined);
  request.write(prefix + '<script>partial</script>');
  // Wait for the real storage callback to open the file, not an arbitrary network delay.
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if ((await fs.readdir(path.join(root, '.staging')).catch(() => [])).length) break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal((await fs.readdir(path.join(root, '.staging'))).length, 1);
  request.destroy();
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (!(await fs.readdir(path.join(root, '.staging'))).length) break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.deepEqual(await fs.readdir(path.join(root, '.staging')), []);
  assert.deepEqual((await fs.readdir(root)).filter(name => !name.startsWith('.')), []);
}));
