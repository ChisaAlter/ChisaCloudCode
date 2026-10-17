import * as fs from 'node:fs/promises';

import spawn from 'cross-spawn';

import { projectsDb } from '@/modules/database/index.js';
import { bridgeGitFileSystem } from '@/modules/workspace-bridge/index.js';

import { createGitRouter } from './git.routes.js';

type GitExternalDependencies = Pick<
  Parameters<typeof createGitRouter>[0],
  'queryClaude' | 'queryCursor'
>;

/** Assembles the Git router with runners from the centralized provider runtime service. */
export function createGitModule(externalDependencies: GitExternalDependencies) {
  return createGitRouter({
    fileSystem: bridgeGitFileSystem({
      access: p => fs.access(p), stat: p => fs.stat(p),
      readFile: p => fs.readFile(p, 'utf8'),
      rm: (p, options) => fs.rm(p, options), unlink: p => fs.unlink(p),
    }),
    spawnProcess: spawn,
    resolveProjectPathById: (projectId) => projectsDb.getProjectPathById(projectId),
    ...externalDependencies,
  });
}
