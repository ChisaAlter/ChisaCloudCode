// Express router mounted at /api/assets by server/index.ts for uploading and
// serving chat attachments stored in the global ~/.cloudcli/assets folder.
export { default as assetsRoutes } from './assets.routes.js';

// Chat/provider admission uses persisted ownership and trusted descriptors. File readers
// use readStoredAttachmentAsset's verified byte snapshot instead of reopening the path.
export { AssetError, createImageAssetService, authorizeStoredAttachmentPaths, readStoredAttachmentAsset } from './services/image-assets.service.js';
