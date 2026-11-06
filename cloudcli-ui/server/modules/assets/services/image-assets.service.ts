import { createHash, randomUUID } from 'node:crypto';
import { constants, createWriteStream, promises as fs } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import type { StorageEngine } from 'multer';

import { getGlobalImageAssetsDir, normalizeAttachmentDescriptors } from '@/shared/index.js';

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_PIXELS = 20_000_000;
const MAX_DIMENSION = 16_384;
const MAX_FRAMES = 100;
const VALIDATION_VERSION = 1;
const HASH = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const RASTER_MIMES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
let activeDecoders = 0;

// Private persistence schema. No request field can supply or overwrite this record.
type AssetMetadata = {
  schemaVersion: 1;
  validationVersion: 1;
  storageId: string;
  filename: string;
  ownerUserId: number;
  kind: 'image' | 'attachment';
  validatedMime: string;
  originalName: string;
  size: number;
  sha256: string;
  createdAt: string;
  preview?: { filename: string; size: number; sha256: string };
  migration?: { sourceSha256: string; evidence: string; at: string };
};

/** Assets routes and integration callers use this bounded, non-sensitive error. */
export class AssetError extends Error {
  constructor(public readonly statusCode: number, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'AssetError';
  }
}

function requireOwner(value: unknown): number {
  const owner = typeof value === 'string' && /^[0-9]+$/.test(value) ? Number(value) : value;
  if (typeof owner !== 'number' || !Number.isSafeInteger(owner) || owner <= 0) {
    throw new AssetError(401, 'Authentication is required');
  }
  return owner;
}

function safeFilename(filename: unknown): filename is string {
  return typeof filename === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,199}$/.test(filename)
    && !filename.includes('..') && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(filename)
    && !filename.endsWith('.');
}

function digest(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function displayName(value: string): string {
  const basename = path.posix.basename(path.win32.basename(value));
  return Buffer.from(basename, 'utf8').toString('utf8')
    .replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, '_').slice(0, 180) || 'attachment';
}

function disposition(name: string, inline: boolean): string {
  const clean = displayName(name);
  const ascii = clean.replace(/[^a-zA-Z0-9._ -]/g, '_');
  const encoded = encodeURIComponent(Buffer.from(clean, 'utf8').toString('utf8'))
    .replace(/[!'()*]/g, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${inline ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

// This is only a decoder allowlist gate, never the image validation decision.
function rasterFormat(bytes: Buffer): 'png' | 'jpeg' | 'gif' | 'webp' | null {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'png';
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'jpeg';
  if (/^GIF8[79]a$/.test(bytes.subarray(0, 6).toString('ascii'))) return 'gif';
  if (bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') return 'webp';
  return null;
}

async function normalizeRaster(bytes: Buffer) {
  const format = rasterFormat(bytes);
  if (!format) return null;
  if (bytes.length > MAX_FILE_BYTES) throw new AssetError(413, 'Image file is too large');
  if (activeDecoders >= 2) throw new AssetError(503, 'Image validation is busy; try again');
  activeDecoders += 1;
  try {
    const { default: sharp } = await import('sharp').catch(() => {
      throw new AssetError(503, 'Image validation is unavailable; try again');
    });
    const decoder = sharp(bytes, {
      animated: true, failOn: 'warning', limitInputPixels: MAX_PIXELS,
      sequentialRead: true, unlimited: false, ignoreIcc: true,
    }).timeout({ seconds: 5 });
    const metadata = await decoder.metadata();
    const frames = metadata.pages ?? 1;
    const width = metadata.width ?? 0;
    const height = metadata.pageHeight ?? metadata.height ?? 0;
    if (metadata.format !== format || !width || !height || width > MAX_DIMENSION || height > MAX_DIMENSION
      || frames > MAX_FRAMES || width * height * frames > MAX_PIXELS) {
      throw new AssetError(413, 'Image dimensions or frame count exceed the validation limit');
    }
    // A full decode and fresh encode drops executable trailing bytes and metadata.
    // All animation frames are decoded within the aggregate pixel/frame limits.
    const normalized = await decoder.toFormat(format).toBuffer();
    if (normalized.length > MAX_FILE_BYTES) throw new AssetError(413, 'Normalized image is too large');
    return { bytes: normalized, mimeType: `image/${format}`, extension: format === 'jpeg' ? 'jpg' : format };
  } catch (error) {
    if (error instanceof AssetError) throw error;
    throw new AssetError(415, 'Invalid or unsupported raster image', { cause: error });
  } finally {
    activeDecoders -= 1;
  }
}

function validMetadata(value: unknown, filename: string): value is AssetMetadata {
  if (!value || typeof value !== 'object') return false;
  const record = value as AssetMetadata;
  if (record.schemaVersion !== 1 || record.validationVersion !== VALIDATION_VERSION || record.filename !== filename
    || !UUID.test(record.storageId) || !Number.isSafeInteger(record.ownerUserId) || record.ownerUserId <= 0
    || !Number.isSafeInteger(record.size) || record.size < 0 || record.size > MAX_FILE_BYTES
    || !HASH.test(record.sha256) || typeof record.originalName !== 'string' || record.originalName.length > 200
    || typeof record.createdAt !== 'string' || !Number.isFinite(Date.parse(record.createdAt))) return false;
  if (record.kind === 'image' ? !RASTER_MIMES.has(record.validatedMime)
    : record.kind !== 'attachment' || record.validatedMime !== 'application/octet-stream') return false;
  if (record.preview && (record.kind !== 'image' || !UUID.test(record.preview.filename.replace(/\.preview$/, ''))
    || !record.preview.filename.endsWith('.preview') || !Number.isSafeInteger(record.preview.size)
    || record.preview.size <= 0 || record.preview.size > MAX_FILE_BYTES || !HASH.test(record.preview.sha256))) return false;
  if (record.migration && (!HASH.test(record.migration.sourceSha256) || typeof record.migration.evidence !== 'string'
    || !record.migration.evidence.trim() || record.migration.evidence.length > 500
    || typeof record.migration.at !== 'string' || !Number.isFinite(Date.parse(record.migration.at)))) return false;
  return true;
}

/** Routes use the default store; the migration command and provider/slot integration tests inject an isolated owner-verified store root through the assets public barrel. */
export function createImageAssetService(options: { assetsDir?: string } = {}) {
  const root = path.resolve(options.assetsDir ?? getGlobalImageAssetsDir());
  const metadataDir = path.join(root, '.metadata');
  const stagingDir = path.join(root, '.staging');
  let initialized: Promise<void> | undefined;

  async function checkDirectory(directory: string, privateDirectory: boolean) {
    const info = await fs.lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Unsafe asset storage directory');
    if (privateDirectory && process.platform !== 'win32' && (info.mode & 0o077) !== 0) {
      throw new Error('Asset control directories must be private');
    }
    if (path.dirname(directory) === root && path.dirname(await fs.realpath(directory)) !== await fs.realpath(root)) {
      throw new Error('Asset control directory escaped the store');
    }
  }

  async function ready() {
    initialized ??= (async () => {
      await fs.mkdir(root, { recursive: true, mode: 0o700 });
      await checkDirectory(root, false);
      if (process.platform !== 'win32') {
        const info = await fs.lstat(root);
        if (typeof process.getuid === 'function' && info.uid !== process.getuid()) throw new Error('Asset store has an unexpected owner');
        await fs.chmod(root, 0o700);
      }
      for (const directory of [metadataDir, stagingDir]) {
        await fs.mkdir(directory, { recursive: true, mode: 0o700 });
        await checkDirectory(directory, true);
      }
    })().catch(error => { initialized = undefined; throw error; });
    await initialized;
    await checkDirectory(root, false);
    await checkDirectory(metadataDir, true);
    await checkDirectory(stagingDir, true);
  }

  function metadataPath(filename: string) {
    return path.join(metadataDir, `${digest(Buffer.from(filename))}.json`);
  }

  async function syncDirectory(directory: string) {
    if (process.platform === 'win32') return;
    const handle = await fs.open(directory, constants.O_RDONLY);
    try { await handle.sync(); } finally { await handle.close(); }
  }

  async function readBoundedFile(directory: string, filename: string, limit: number, expectedLinks = 1): Promise<Buffer> {
    const target = path.join(directory, filename);
    const before = await fs.lstat(target);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== expectedLinks || before.size > limit) {
      throw new Error('Unsafe asset file');
    }
    if (path.dirname(await fs.realpath(target)) !== await fs.realpath(directory)) throw new Error('Asset escaped the store');
    const handle = await fs.open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.nlink !== expectedLinks || opened.dev !== before.dev || opened.ino !== before.ino
        || opened.size !== before.size || opened.size > limit) throw new Error('Asset changed while opening');
      const bytes = Buffer.alloc(opened.size + 1);
      let length = 0;
      while (length < bytes.length) {
        const result = await handle.read(bytes, length, bytes.length - length, length);
        if (!result.bytesRead) break;
        length += result.bytesRead;
      }
      const after = await handle.stat();
      if (length !== opened.size || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs
        || after.ctimeMs !== opened.ctimeMs || after.nlink !== expectedLinks) throw new Error('Asset changed while reading');
      // The same immutable byte snapshot is hashed and served. No path is reopened.
      return bytes.subarray(0, length);
    } finally { await handle.close(); }
  }

  async function writeAtomic(target: string, bytes: Buffer) {
    const temporary = path.join(stagingDir, `${randomUUID()}.commit`);
    let linked = false;
    try {
      const handle = await fs.open(temporary, 'wx', 0o600);
      try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
      // link() is an exclusive, atomic publication: an existing name is never replaced.
      await fs.link(temporary, target);
      linked = true;
    } finally {
      await fs.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
      if (linked) await syncDirectory(path.dirname(target));
    }
  }

  async function readMetadata(filename: string): Promise<AssetMetadata | null> {
    try {
      const bytes = await readBoundedFile(metadataDir, path.basename(metadataPath(filename)), 16_384);
      const record: unknown = JSON.parse(bytes.toString('utf8'));
      return validMetadata(record, filename) ? record : null;
    } catch { return null; }
  }

  async function readAuthorized(filename: string, ownerUserId: unknown) {
    const owner = requireOwner(ownerUserId);
    if (!safeFilename(filename)) throw new AssetError(400, 'Invalid asset filename');
    await ready();
    const metadata = await readMetadata(filename);
    // Missing, legacy, corrupt and another owner's records intentionally share one response.
    if (!metadata || metadata.ownerUserId !== owner) throw new AssetError(404, 'Asset not found');
    try {
      const bytes = await readBoundedFile(root, filename, MAX_FILE_BYTES);
      if (bytes.length !== metadata.size || digest(bytes) !== metadata.sha256) throw new Error('Asset integrity mismatch');
      return { metadata, bytes };
    } catch { throw new AssetError(404, 'Asset not found'); }
  }

  function descriptor(metadata: AssetMetadata) {
    return { name: metadata.originalName, path: path.join(root, metadata.filename).replace(/\\/g, '/'),
      size: metadata.size, mimeType: metadata.validatedMime };
  }

  async function removeStagedFile(filePath: string) {
    if (path.dirname(filePath) !== stagingDir || !/^[a-f0-9-]+\.upload$/.test(path.basename(filePath))) {
      throw new Error('Invalid staged upload path');
    }
    await fs.unlink(filePath).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }

  const uploadStorage: StorageEngine = {
    _handleFile(request, file, callback) {
      void (async () => {
        await ready();
        if (request.aborted) throw new AssetError(400, 'Upload aborted');
        const filename = `${randomUUID()}.upload`;
        const target = path.join(stagingDir, filename);
        const output = createWriteStream(target, { flags: 'wx', mode: 0o600 });
        const abort = () => { output.destroy(new Error('Upload aborted')); };
        request.once('aborted', abort);
        try {
          await pipeline(file.stream, output);
          callback(null, { destination: stagingDir, filename, path: target, size: output.bytesWritten });
        } catch (error) {
          await removeStagedFile(target);
          callback(error instanceof Error ? error : new Error('Upload failed'));
        } finally { request.removeListener('aborted', abort); }
      })().catch(error => callback(error instanceof Error ? error : new Error('Upload failed')));
    },
    _removeFile(_request, file, callback) {
      removeStagedFile(file.path).then(() => callback(null)).catch(callback);
    },
  };

  async function saveUploads(
    files: Array<Pick<Express.Multer.File, 'path' | 'originalname' | 'mimetype'>>,
    ownerUserId: unknown,
    mode: 'images' | 'files',
    signal?: AbortSignal,
  ) {
    const published: string[] = [];
    const records: ReturnType<typeof descriptor>[] = [];
    const checkAbort = () => { if (signal?.aborted) throw new AssetError(400, 'Upload aborted'); };
    try {
      const owner = requireOwner(ownerUserId);
      await ready();
      if (!files.length || files.length > (mode === 'images' ? 5 : 10)) throw new AssetError(400, 'Invalid file count');
      checkAbort();
      for (const file of files) {
        if (path.dirname(file.path) !== stagingDir || !/^[a-f0-9-]+\.upload$/.test(path.basename(file.path))) {
          throw new AssetError(400, 'Invalid staged upload');
        }
        const original = await readBoundedFile(stagingDir, path.basename(file.path), mode === 'images' ? MAX_IMAGE_BYTES : MAX_FILE_BYTES);
        checkAbort();
        const raster = await normalizeRaster(original);
        checkAbort();
        // SVG remains storable for existing clients, always as inert download data.
        if (mode === 'images' && !raster && file.mimetype !== 'image/svg+xml') {
          throw new AssetError(415, 'Only validated raster images or downloadable SVG files are accepted');
        }
        const bytes = raster?.bytes ?? original;
        const storageId = randomUUID();
        const extension = raster?.extension ?? (/^\.[a-z0-9]{1,12}$/i.test(path.extname(file.originalname))
          ? path.extname(file.originalname).slice(1).toLowerCase() : 'bin');
        const filename = `${storageId}.${extension}`;
        const metadata: AssetMetadata = {
          schemaVersion: 1, validationVersion: VALIDATION_VERSION, storageId, filename, ownerUserId: owner,
          kind: raster ? 'image' : 'attachment', validatedMime: raster?.mimeType ?? 'application/octet-stream',
          originalName: displayName(file.originalname), size: bytes.length, sha256: digest(bytes), createdAt: new Date().toISOString(),
        };
        const target = path.join(root, filename);
        await writeAtomic(target, bytes);
        published.push(target);
        checkAbort();
        await writeAtomic(metadataPath(filename), Buffer.from(JSON.stringify(metadata)));
        published.push(metadataPath(filename));
        checkAbort();
        records.push(descriptor(metadata));
      }
      return records;
    } catch (error) {
      // This invocation only removes objects it exclusively created; crash orphans stay quarantined.
      for (const target of published.reverse()) await fs.unlink(target).catch(() => undefined);
      throw error;
    } finally {
      await Promise.all(files.map(file => removeStagedFile(file.path)));
    }
  }

  async function openStoredAsset(filename: string, ownerUserId: unknown, mode: 'images' | 'files') {
    const { metadata, bytes } = await readAuthorized(filename, ownerUserId);
    const inline = mode === 'images' && metadata.kind === 'image';
    let body = bytes;
    if (inline && metadata.preview) {
      try {
        body = await readBoundedFile(metadataDir, metadata.preview.filename, MAX_FILE_BYTES);
        if (body.length !== metadata.preview.size || digest(body) !== metadata.preview.sha256) throw new Error('Invalid preview');
      } catch { throw new AssetError(404, 'Asset not found'); }
    }
    return { contentType: inline ? metadata.validatedMime : 'application/octet-stream',
      contentDisposition: disposition(metadata.originalName, inline),
      size: body.length, stream: Readable.from([body]), bytes: body, attachment: descriptor(metadata) };
  }

  async function authorizeAttachmentPaths(attachments: unknown, ownerUserId: unknown) {
    requireOwner(ownerUserId);
    const records: ReturnType<typeof descriptor>[] = [];
    for (const attachment of normalizeAttachmentDescriptors(attachments)) {
      const candidate = path.resolve(root, attachment.path);
      if (path.dirname(candidate) !== root) throw new AssetError(404, 'Asset not found');
      const { metadata } = await readAuthorized(path.basename(candidate), ownerUserId);
      records.push(descriptor(metadata));
    }
    return records;
  }

  async function inventory() {
    await ready();
    const results: Array<{ filename: string; state: string; size?: number; sha256?: string; ownerUserId?: number }> = [];
    for (const entry of await fs.readdir(root, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      if (!safeFilename(entry.name)) { results.push({ filename: entry.name, state: 'unsafe-name' }); continue; }
      try {
        const bytes = await readBoundedFile(root, entry.name, MAX_FILE_BYTES);
        const metadata = await readMetadata(entry.name);
        const sha256 = digest(bytes);
        results.push({ filename: entry.name, state: !metadata ? 'quarantined'
          : metadata.sha256 === sha256 && metadata.size === bytes.length ? 'registered' : 'integrity-failed',
        size: bytes.length, sha256, ...(metadata ? { ownerUserId: metadata.ownerUserId } : {}) });
      } catch { results.push({ filename: entry.name, state: 'unreadable' }); }
    }
    return results;
  }

  async function migrateLegacyAsset(input: {
    filename: string; ownerUserId: number; expectedSha256: string; evidence: string; originalName?: string; allowInline?: boolean;
  }) {
    const owner = requireOwner(input.ownerUserId);
    if (!safeFilename(input.filename) || !HASH.test(input.expectedSha256) || typeof input.evidence !== 'string'
      || !input.evidence.trim() || input.evidence.length > 500) throw new AssetError(400, 'Explicit filename, digest and ownership evidence are required');
    await ready();
    const existing = await readMetadata(input.filename);
    if (existing) {
      if (existing.ownerUserId !== owner || existing.migration?.sourceSha256 !== input.expectedSha256) {
        throw new AssetError(409, 'Asset already has an ownership record');
      }
      await readAuthorized(input.filename, owner);
      return { attachment: descriptor(existing), migrated: false };
    }
    const bytes = await readBoundedFile(root, input.filename, MAX_FILE_BYTES);
    if (digest(bytes) !== input.expectedSha256) throw new AssetError(409, 'Legacy asset digest does not match the manifest');
    const raster = input.allowInline ? await normalizeRaster(bytes) : null;
    const previewName = raster ? `${randomUUID()}.preview` : undefined;
    const createdAt = new Date().toISOString();
    const metadata: AssetMetadata = {
      schemaVersion: 1, validationVersion: VALIDATION_VERSION, storageId: randomUUID(), filename: input.filename,
      ownerUserId: owner, kind: raster ? 'image' : 'attachment', validatedMime: raster?.mimeType ?? 'application/octet-stream',
      originalName: displayName(input.originalName ?? input.filename), size: bytes.length, sha256: digest(bytes), createdAt,
      migration: { sourceSha256: input.expectedSha256, evidence: input.evidence.trim(), at: createdAt },
      ...(raster && previewName ? { preview: { filename: previewName, size: raster.bytes.length, sha256: digest(raster.bytes) } } : {}),
    };
    try {
      if (raster && previewName) await writeAtomic(path.join(metadataDir, previewName), raster.bytes);
      await writeAtomic(metadataPath(input.filename), Buffer.from(JSON.stringify(metadata)));
    } catch (error) {
      if (previewName) await fs.unlink(path.join(metadataDir, previewName)).catch(() => undefined);
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new AssetError(409, 'Asset already has an ownership record');
      throw error;
    }
    return { attachment: descriptor(metadata), migrated: true };
  }

  async function reconciliationInventory() {
    const assets = await inventory();
    const temporary: Array<{ area: 'staging'; filename: string; state: string; size?: number; sha256?: string }> = [];
    for (const entry of await fs.readdir(stagingDir, { withFileTypes: true })) {
      if (!/^[a-f0-9-]+\.(upload|commit)$/.test(entry.name)) continue;
      try {
        const info = await fs.lstat(path.join(stagingDir, entry.name));
        const links = entry.name.endsWith('.commit') && info.nlink === 2 ? 2 : 1;
        const bytes = await readBoundedFile(stagingDir, entry.name, MAX_FILE_BYTES, links);
        temporary.push({ area: 'staging', filename: entry.name, state: links === 2 ? 'interrupted-publication' : 'temporary', size: bytes.length, sha256: digest(bytes) });
      } catch { temporary.push({ area: 'staging', filename: entry.name, state: 'unreadable' }); }
    }
    const controls: Array<{ area: 'metadata'; filename: string; state: string; size?: number; sha256?: string }> = [];
    for (const entry of await fs.readdir(metadataDir, { withFileTypes: true })) {
      try {
        const bytes = await readBoundedFile(metadataDir, entry.name, entry.name.endsWith('.json') ? 16_384 : MAX_FILE_BYTES);
        let state = 'preview';
        if (entry.name.endsWith('.json')) {
          const metadata: unknown = JSON.parse(bytes.toString('utf8'));
          state = metadata && typeof metadata === 'object' && 'filename' in metadata
            && typeof metadata.filename === 'string' && validMetadata(metadata, metadata.filename)
            && path.basename(metadataPath(metadata.filename)) === entry.name ? 'metadata' : 'invalid-metadata';
        } else if (!/^[a-f0-9-]+\.preview$/.test(entry.name)) state = 'unknown-control-object';
        controls.push({ area: 'metadata', filename: entry.name, state, size: bytes.length, sha256: digest(bytes) });
      } catch { controls.push({ area: 'metadata', filename: entry.name, state: 'unreadable' }); }
    }
    return { assets, temporary, controls };
  }

  // Offline maintenance only: the caller must stop application writers first.
  // Exact hashes and explicit records are required; age alone never permits removal.
  async function removeOfflineOrphan(input: { area: 'assets' | 'staging'; filename: string; expectedSha256: string; writersStopped: true }) {
    if (input.writersStopped !== true || !HASH.test(input.expectedSha256)
      || (input.area === 'assets' ? !safeFilename(input.filename)
        : input.area !== 'staging' || !/^[a-f0-9-]+\.(upload|commit)$/.test(input.filename))) {
      throw new AssetError(400, 'An exact offline reconciliation manifest is required');
    }
    await ready();
    if (input.area === 'assets') {
      // A corrupt, linked or partial metadata object still protects the underlying file.
      const present = await fs.lstat(metadataPath(input.filename)).then(() => true).catch(error => {
        if (error.code === 'ENOENT') return false;
        throw error;
      });
      if (present) throw new AssetError(409, 'A metadata record protects this asset');
    }
    const directory = input.area === 'assets' ? root : stagingDir;
    const bytes = await readBoundedFile(directory, input.filename, MAX_FILE_BYTES);
    if (digest(bytes) !== input.expectedSha256) throw new AssetError(409, 'Orphan digest does not match the manifest');
    await fs.unlink(path.join(directory, input.filename));
    await syncDirectory(directory);
    return { removed: true, area: input.area, filename: input.filename, sha256: input.expectedSha256 };
  }

  // A crash after link publication but before temporary unlink leaves two links.
  // Only the exact same-inode pair can complete that publication; arbitrary hardlinks remain denied.
  async function completeOfflinePublication(input: { temporary: string; area: 'assets' | 'metadata'; filename: string; expectedSha256: string; writersStopped: true }) {
    if (input.writersStopped !== true || !HASH.test(input.expectedSha256) || !UUID.test(input.temporary.replace(/\.commit$/, ''))
      || !input.temporary.endsWith('.commit') || (input.area === 'assets' ? !safeFilename(input.filename)
        : input.area !== 'metadata' || !(/^([a-f0-9]{64})\.json$/.test(input.filename)
          || (input.filename.endsWith('.preview') && UUID.test(input.filename.replace(/\.preview$/, '')))))) {
      throw new AssetError(400, 'An exact offline publication manifest is required');
    }
    await ready();
    const directory = input.area === 'assets' ? root : metadataDir;
    const temporary = path.join(stagingDir, input.temporary);
    const destination = path.join(directory, input.filename);
    const sourceInfo = await fs.lstat(temporary);
    const targetInfo = await fs.lstat(destination);
    if (!sourceInfo.isFile() || sourceInfo.isSymbolicLink() || !targetInfo.isFile() || targetInfo.isSymbolicLink()
      || sourceInfo.nlink !== 2 || targetInfo.nlink !== 2 || sourceInfo.dev !== targetInfo.dev || sourceInfo.ino !== targetInfo.ino) {
      throw new AssetError(409, 'Publication paths must reference the same two-link inode');
    }
    const limit = input.area === 'metadata' && input.filename.endsWith('.json') ? 16_384 : MAX_FILE_BYTES;
    const source = await readBoundedFile(stagingDir, input.temporary, limit, 2);
    const target = await readBoundedFile(directory, input.filename, limit, 2);
    if (digest(source) !== input.expectedSha256 || digest(target) !== input.expectedSha256) {
      throw new AssetError(409, 'Publication digest does not match the manifest');
    }
    if (input.area === 'metadata' && input.filename.endsWith('.json')) {
      const metadata: unknown = JSON.parse(target.toString('utf8'));
      if (!metadata || typeof metadata !== 'object' || !('filename' in metadata) || typeof metadata.filename !== 'string'
        || !validMetadata(metadata, metadata.filename) || path.basename(metadataPath(metadata.filename)) !== input.filename) {
        throw new AssetError(409, 'Publication metadata is invalid');
      }
    }
    await fs.unlink(temporary);
    await syncDirectory(stagingDir);
    await syncDirectory(directory);
    return { recovered: true, area: input.area, filename: input.filename, sha256: input.expectedSha256 };
  }

  return { uploadStorage, saveUploads, openStoredAsset, authorizeAttachmentPaths, inventory, migrateLegacyAsset,
    reconciliationInventory, removeOfflineOrphan, completeOfflinePublication };
}

/** Assets routes and the public provider authorization adapters share this store. */
export const imageAssetService = createImageAssetService();

/** Chat/provider admission must pass the authenticated owner, never request-supplied identity. */
export const authorizeStoredAttachmentPaths = imageAssetService.authorizeAttachmentPaths;

/** Provider file consumers can use verified bytes without reopening a mutable filesystem path. */
export const readStoredAttachmentAsset = imageAssetService.openStoredAsset;
