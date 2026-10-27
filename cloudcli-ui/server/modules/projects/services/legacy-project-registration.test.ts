import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, test } from 'node:test';

import {
  LEGACY_PROJECT_PATH_LIMIT,
  registerExistingProjectPaths,
  type LegacyProjectRegistrationDependencies,
} from './legacy-project-registration.service.js';
import type { CreateProjectPathResult } from '../../../shared/types.js';

const root = path.resolve('/opt/chisacloudcode/workspaces');

function fakeDependencies(overrides: Partial<LegacyProjectRegistrationDependencies> = {}) {
  const persisted: { projectPath: string; customName: string | null }[] = [];
  const existing = new Set<string>();
  let counter = 0;
  const dependencies: LegacyProjectRegistrationDependencies = {
    workspaceRoot: root,
    validatePath: async (candidate: string) => {
      const resolved = path.resolve(candidate);
      if (resolved !== root && !resolved.startsWith(root + path.sep)) {
        return { valid: false, error: 'outside workspace root' };
      }
      return { valid: true, resolvedPath: resolved };
    },
    isExistingDirectory: async (candidate: string) => existing.has(candidate),
    persistProjectPath: (projectPath: string, customName: string | null): CreateProjectPathResult => {
      persisted.push({ projectPath, customName });
      counter += 1;
      return {
        outcome: 'created',
        project: { project_id: `project-${counter}`, project_path: projectPath } as CreateProjectPathResult['project'],
      };
    },
    ...overrides,
  };
  return { dependencies, persisted, existing };
}

describe('legacy project registration', () => {
  test('registers an existing workspace path without touching its name or files', async () => {
    const { dependencies, persisted, existing } = fakeDependencies();
    const projectPath = path.join(root, 'local', 'legacy-project');
    existing.add(projectPath);

    const { results } = await registerExistingProjectPaths([projectPath], dependencies);

    assert.deepEqual(results, [{ path: projectPath, outcome: 'registered', projectId: 'project-1' }]);
    assert.deepEqual(persisted, [{ projectPath, customName: null }]);
  });

  test('repeated import is idempotent and keeps the existing project identity', async () => {
    const projectPath = path.join(root, 'local', 'legacy-project');
    const { dependencies, existing } = fakeDependencies({
      persistProjectPath: (projectPath_) =>
        ({
          outcome: 'active_conflict',
          project: { project_id: 'stable-project', project_path: projectPath_ },
        }) as CreateProjectPathResult,
    });
    existing.add(projectPath);

    const first = await registerExistingProjectPaths([projectPath], dependencies);
    const second = await registerExistingProjectPaths([projectPath], dependencies);

    assert.equal(first.results[0].outcome, 'existing');
    assert.equal(second.results[0].outcome, 'existing');
    assert.equal(first.results[0].projectId, 'stable-project');
    assert.equal(second.results[0].projectId, 'stable-project');
  });

  test('an archived row is reactivated rather than duplicated', async () => {
    const projectPath = path.join(root, 'local', 'archived-project');
    const { dependencies, existing } = fakeDependencies({
      persistProjectPath: (projectPath_) =>
        ({
          outcome: 'reactivated_archived',
          project: { project_id: 'archived-project-id', project_path: projectPath_ },
        }) as CreateProjectPathResult,
    });
    existing.add(projectPath);

    const { results } = await registerExistingProjectPaths([projectPath], dependencies);

    assert.deepEqual(results, [
      { path: projectPath, outcome: 'reactivated_archived', projectId: 'archived-project-id' },
    ]);
  });

  test('a missing directory is reported and never created or registered', async () => {
    const { dependencies, persisted } = fakeDependencies();
    const projectPath = path.join(root, 'local', 'not-mounted');

    const { results } = await registerExistingProjectPaths([projectPath], dependencies);

    assert.equal(results.length, 1);
    assert.equal(results[0].outcome, 'rejected');
    assert.equal(results[0].reason, 'path does not exist as a directory');
    assert.deepEqual(persisted, []);
  });

  test('a path outside the account workspace is rejected before persistence', async () => {
    const { dependencies, persisted, existing } = fakeDependencies();
    const foreign = path.resolve('/srv/other-account/project');
    existing.add(foreign);

    const { results } = await registerExistingProjectPaths([foreign], dependencies);

    assert.equal(results[0].outcome, 'rejected');
    assert.equal(results[0].reason, 'path is not inside the account workspace');
    assert.deepEqual(persisted, []);
  });

  test('the workspace root itself and relative or duplicate paths are rejected', async () => {
    const projectPath = path.join(root, 'local', 'dupe');
    const { dependencies, persisted, existing } = fakeDependencies();
    existing.add(projectPath);

    const { results } = await registerExistingProjectPaths(
      [root, 'relative/path', projectPath, projectPath, 42],
      dependencies,
    );

    assert.equal(results[0].reason, 'the workspace root itself is not a project');
    assert.equal(results[1].reason, 'path must be absolute');
    assert.equal(results[2].outcome, 'registered');
    assert.equal(results[3].reason, 'duplicate path in request');
    assert.equal(results[4].reason, 'path must be a string');
    assert.equal(persisted.length, 1);
  });

  test('the batch is bounded', async () => {
    const { dependencies } = fakeDependencies();
    const many = Array.from({ length: LEGACY_PROJECT_PATH_LIMIT + 25 }, (_, index) => `relative-${index}`);

    const { results } = await registerExistingProjectPaths(many, dependencies);

    assert.equal(results.length, LEGACY_PROJECT_PATH_LIMIT);
  });

  test('a non-array payload produces no work', async () => {
    const { dependencies, persisted } = fakeDependencies();

    assert.deepEqual(await registerExistingProjectPaths(undefined, dependencies), { results: [] });
    assert.deepEqual(await registerExistingProjectPaths('nope', dependencies), { results: [] });
    assert.deepEqual(persisted, []);
  });
});
