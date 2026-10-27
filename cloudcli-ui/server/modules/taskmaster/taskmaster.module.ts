import fs from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import os from 'node:os';

import spawn from 'cross-spawn';

import { projectsDb } from '@/modules/database/index.js';
import { resolveSshProjectTarget } from '@/modules/workspace-bridge/index.js';
import { AppError } from '@/shared/index.js';

import { createTaskmasterRouter } from './taskmaster.routes.js';
import { createTaskmasterService } from './taskmaster.service.js';

const taskmasterService = createTaskmasterService({
  readTextFile: (filePath) => fsPromises.readFile(filePath, 'utf8'),
  getHomeDirectory: os.homedir,
});

/** Used by the server entrypoint to mount authenticated TaskMaster endpoints. */
export const taskmasterRoutes = createTaskmasterRouter({
  fileSystem: fs,
  fileSystemPromises: fsPromises,
  spawnProcess: spawn,
  resolveProjectPathById: (projectId) => {
    const root = projectsDb.getProjectPathById(projectId);
    if (root && resolveSshProjectTarget(root)) throw new AppError('SSH 本地项目暂不支持 TaskMaster。', { code: 'SSH_WORKSPACE_UNSUPPORTED', statusCode: 409 });
    return root;
  },
  taskmasterService,
});
