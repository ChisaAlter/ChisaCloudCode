import fs, { promises as fsPromises } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { projectsDb } from '@/modules/database/index.js';
import { providerModelsService } from '@/modules/providers/index.js';
import { assertWorkspaceDescriptor, bridgeFileSystem, isWorkspaceBound, workspaceRequestScope } from '@/modules/workspace-bridge/index.js';
import { resolveSelectedWorkspace } from '@/modules/workspaces/index.js';
import type { FileTreeFileSystem } from '@/shared/index.js';
import { findApplicationRoot, getModuleDirectory } from '@/shared/index.js';

import { createCommandsRouter } from './commands.routes.js';
import { createCommandsService } from './commands.service.js';

const fileSystem: FileTreeFileSystem = {
  access: candidate => fsPromises.access(candidate),
  stat: candidate => fsPromises.stat(candidate),
  lstat: candidate => fsPromises.lstat(candidate),
  openDirectory: async function* (directory) { yield* await fsPromises.opendir(directory); },
  realpath: candidate => fsPromises.realpath(candidate),
  readTextFile: candidate => fsPromises.readFile(candidate, 'utf8'),
  writeTextFile: (candidate, content) => fsPromises.writeFile(candidate, content, 'utf8'),
  makeDirectory: async (candidate, recursive) => { await fsPromises.mkdir(candidate, { recursive }); },
  rename: (source, target) => fsPromises.rename(source, target),
  removeDirectory: candidate => fsPromises.rm(candidate, { recursive: true, force: true }),
  unlink: candidate => fsPromises.unlink(candidate),
  copyFile: (source, target) => fsPromises.copyFile(source, target),
  createReadStream: candidate => fs.createReadStream(candidate),
};
const appRoot = findApplicationRoot(getModuleDirectory(import.meta.url));
const services = createCommandsService({
  files: bridgeFileSystem(fileSystem),
  homeDirectory: os.homedir,
  readPackage: () => fsPromises.readFile(path.join(appRoot, 'package.json'), 'utf8'),
  models: providerModelsService,
  workspace: {
    // Context selectors are parsed explicitly by the route because execute's
    // app session id also permits the catalog's pre-materialization bootstrap.
    resolve: resolveSelectedWorkspace,
    assert: assertWorkspaceDescriptor,
    isBound: isWorkspaceBound,
    projectIdForPath: candidate => projectsDb.getProjectPath(candidate)?.project_id ?? null,
  },
  runtime: {
    uptime: process.uptime,
    memoryUsage: process.memoryUsage,
    version: process.version,
    platform: process.platform,
    pid: process.pid,
  },
});

/** Commands router assembled for the authenticated server mount. */
export const commandsRoutes = createCommandsRouter(services, workspaceRequestScope);
