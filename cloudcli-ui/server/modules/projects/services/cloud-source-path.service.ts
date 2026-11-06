import path from 'node:path';

import { AppError, WORKSPACES_ROOT } from '@/shared/index.js';

/** Project creation and Git import reject SSH metadata destinations before making any cloud source changes. */
export function assertCloudProjectSourcePath(candidate: string): void {
  const reserved = path.resolve(WORKSPACES_ROOT, '.chisa-ssh-projects');
  const relative = path.relative(reserved, path.resolve(candidate));
  if (relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`))) {
    throw new AppError('SSH metadata anchors cannot be registered as cloud project sources', { code: 'SSH_ANCHOR_RESERVED', statusCode: 400 });
  }
}
