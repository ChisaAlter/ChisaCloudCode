import { constants, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { AssetError, readStoredAttachmentAsset } from '@/modules/assets/index.js';
import { getGlobalImageAssetsDir, normalizeAttachmentDescriptors } from '@/shared/index.js';
import type { PreparedImageAttachment, ProviderRuntimeContext, ProviderRuntimeWriter, VerifiedImageAttachment } from '@/shared/index.js';

const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const IMAGE_EXTENSIONS: Record<string, string> = {
  'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp',
};
type SnapshotAccess = {
  userId: ProviderRuntimeWriter['userId'];
  assertActive?: () => void;
  signal?: AbortSignal;
  readWorkspaceImage?: ProviderRuntimeContext['readWorkspaceImage'];
};
type AttachmentDependencies = {
  assetsRoot: string;
  stagingParent: string;
  readStoredAsset: typeof readStoredAttachmentAsset;
};

function assertCurrent(access: SnapshotAccess) {
  access.signal?.throwIfAborted();
  access.assertActive?.();
}

function copySnapshot(value: VerifiedImageAttachment, requireImage: boolean): VerifiedImageAttachment {
  if (!(value.bytes instanceof Uint8Array) || value.bytes.byteLength === 0
    || value.bytes.byteLength > MAX_ATTACHMENT_BYTES || value.size !== value.bytes.byteLength
    || (requireImage && !Object.hasOwn(IMAGE_EXTENSIONS, value.mimeType))) {
    throw new AssetError(400, 'A verified attachment snapshot is required');
  }
  // The boundary owns this copy; later mutations of a transport/reader buffer
  // cannot alter the bytes passed into conversion or private file staging.
  return { path: value.path, name: value.name, mimeType: value.mimeType,
    size: value.bytes.byteLength, bytes: Buffer.from(value.bytes) };
}

/** Claude/Codex adapters and their focused tests consume snapshots through this owner-aware boundary. */
export function createProviderAttachmentsService(overrides: Partial<AttachmentDependencies> = {}) {
  const dependencies: AttachmentDependencies = { assetsRoot: getGlobalImageAssetsDir(), stagingParent: os.tmpdir(),
    readStoredAsset: readStoredAttachmentAsset, ...overrides };
  const assetsRoot = path.resolve(dependencies.assetsRoot);

  async function readSnapshots(input: unknown, access: SnapshotAccess, requireImage: boolean): Promise<VerifiedImageAttachment[]> {
    const snapshots: VerifiedImageAttachment[] = [];
    for (const descriptor of normalizeAttachmentDescriptors(input)) {
      assertCurrent(access);
      const resolved = path.resolve(descriptor.path);
      const isUpload = path.isAbsolute(descriptor.path) && path.dirname(resolved) === assetsRoot;
      let snapshot: VerifiedImageAttachment;
      if (isUpload) {
        // files mode returns original verified bytes, not a preview or a path
        // to reopen. Name, MIME and length come only from server metadata.
        const stored = await dependencies.readStoredAsset(path.basename(resolved), access.userId, 'files');
        snapshot = { ...stored.attachment, mimeType: stored.attachment.mimeType,
          size: stored.bytes.length, bytes: stored.bytes };
      } else if (requireImage && access.readWorkspaceImage) {
        // Only trusted admission composition may provide this capability. A
        // cwd, client mime, or caller-provided bytes never grants host reads.
        snapshot = await access.readWorkspaceImage(descriptor.path);
      } else {
        throw new AssetError(404, 'Attachment is not available in this run');
      }
      assertCurrent(access);
      snapshots.push(copySnapshot(snapshot, requireImage));
    }
    return snapshots;
  }

  async function stage(snapshots: readonly VerifiedImageAttachment[]) {
    const attachments: PreparedImageAttachment[] = [];
    if (!snapshots.length) return { attachments, dispose: async () => {} };
    const directory = await fs.mkdtemp(path.join(dependencies.stagingParent, 'chisa-provider-attachments-'));
    let disposed = false;
    const dispose = async () => {
      if (disposed) return;
      await fs.rm(directory, { recursive: true, force: true, maxRetries: 2 });
      disposed = true;
    };
    try {
      await fs.chmod(directory, 0o700);
      for (const [index, value] of snapshots.entries()) {
        const snapshot = copySnapshot(value, false);
        const filename = path.join(directory, `attachment-${index}${IMAGE_EXTENSIONS[snapshot.mimeType] ?? '.bin'}`);
        const handle = await fs.open(filename, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
        try {
          await handle.writeFile(snapshot.bytes);
          await handle.chmod(0o400);
        } finally { await handle.close(); }
        attachments.push(Object.freeze({ path: filename, name: snapshot.name,
          mimeType: snapshot.mimeType, size: snapshot.size }));
      }
      return { attachments, dispose };
    } catch (error) {
      await dispose();
      throw error;
    }
  }

  return {
    readImages: (input: unknown, access: SnapshotAccess) => readSnapshots(input, access, true),
    readFiles: (input: unknown, access: SnapshotAccess) => readSnapshots(input, access, false),
    stage,
  };
}

/** Provider adapters share the production owned-upload reader; tests use the isolated factory. */
export const providerAttachmentsService = createProviderAttachmentsService();
