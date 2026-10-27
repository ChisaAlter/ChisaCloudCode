import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import type { SshProjectTarget, SshWorkspaceProbeResult } from '@/shared/index.js';

import { createSshProject, probeSshProjectDirectory } from '../services/ssh-project-management.service.js';

type Dependencies = Parameters<typeof createSshProject>[1];
const root = 'C:\\开发\\My App';
const successfulProbe: SshWorkspaceProbeResult = { ok: true, protocol: 1, platform: 'win32', helperVersion: '1.0.0',
  username: 'cc-worker', connectionId: 'laptop', connectionLabel: 'Windows Laptop', rootPath: root,
  rootIdentity: 'volume:file', capabilities: { files: true, exec: true, terminal: false } };
function dependencies(overrides: Partial<NonNullable<Dependencies>> = {}): NonNullable<Dependencies> {
  let row = { project_id: 'project-1', project_path: path.resolve('/workspace/.chisa-ssh-projects/project-1'), custom_project_name: 'My App', isArchived: 0, isStarred: 0 };
  return {
    probe: async () => successfulProbe,
    workspaceRoot: path.resolve('/workspace'),
    makeId: () => 'project-1',
    prepareAnchor: async () => {},
    removeEmptyAnchor: async () => {},
    findExisting: () => null,
    getProject: () => row,
    setArchived: (_id, archived) => { row = { ...row, isArchived: archived ? 1 : 0 }; },
    persist: input => {
      row = { ...row, custom_project_name: input.displayName };
      return { ...input, projectId: input.projectId!, generation: 'generation', workspaceId: 'workspace', phase: 'idle', activeRunId: null, pendingJobId: null } as SshProjectTarget;
    },
    ...overrides,
  };
}

test('SSH project verifies the authenticated connection and retains only a VPS metadata anchor', async () => {
  let verified: unknown;
  let persisted: unknown;
  const result = await createSshProject({ ownerId: 'user-1', connectionId: 'laptop', rootPath: 'C:\\alias', customName: '  Local App  ' }, dependencies({
    probe: async input => { verified = input; return { ...successfulProbe, connectionLabel: 'Laptop', rootIdentity: 'physical-root' }; },
    persist: input => { persisted = input; return { ...input, projectId: input.projectId!, generation: 'generation', workspaceId: 'workspace', phase: 'idle', activeRunId: null, pendingJobId: null } as SshProjectTarget; },
    getProject: () => ({ project_id: 'project-1', project_path: path.resolve('/workspace/.chisa-ssh-projects/project-1'), custom_project_name: 'Local App', isArchived: 0, isStarred: 0 }),
  }));
  assert.deepEqual(verified, { connectionId: 'laptop', rootPath: 'C:\\alias', userId: 'user-1' });
  assert.equal(result.project.fullPath, path.resolve('/workspace/.chisa-ssh-projects/project-1'));
  assert.equal(result.project.displayPath, root);
  assert.equal(result.project.sourceMode, 'ssh');
  assert.equal(result.project.displayName, 'Local App');
  assert.equal(result.project.sshConnectionId, 'laptop');
  assert.equal((persisted as SshProjectTarget).rootIdentity, 'physical-root');
});

test('SSH project uses the Windows directory name rather than the VPS anchor for display', async () => {
  const result = await createSshProject({ ownerId: 'user-1', connectionId: 'laptop', rootPath: root }, dependencies());
  assert.equal(result.project.displayName, 'My App');
});

test('missing authentication and failed or incomplete probes never prepare an anchor', async () => {
  let prepared = false;
  const fixture = dependencies({ prepareAnchor: async () => { prepared = true; } });
  await assert.rejects(createSshProject({ ownerId: '', connectionId: 'laptop', rootPath: root }, fixture), { code: 'UNAUTHORIZED' });
  await assert.rejects(createSshProject({ ownerId: 'user-1', connectionId: 'laptop', rootPath: root }, { ...fixture, probe: async () => { throw Object.assign(new Error('offline'), { code: 'SSH_OFFLINE' }); } }), { code: 'SSH_OFFLINE' });
  await assert.rejects(createSshProject({ ownerId: 'user-1', connectionId: 'laptop', rootPath: root }, { ...fixture, probe: async () => ({ ok: true, rootPath: root } as SshWorkspaceProbeResult) }), { code: 'SSH_WORKSPACE_PROBE_INVALID' });
  assert.equal(prepared, false);
});

test('verified active or archived aliases reuse original metadata without preparing or retargeting an anchor', async () => {
  for (const archived of [false, true]) {
    const target: SshProjectTarget = { projectId: 'original', ownerId: 'user-1', connectionId: 'original-connection', connectionLabel: 'Original desktop',
      rootPath: root, rootIdentity: successfulProbe.rootIdentity, generation: 'same-generation', workspaceId: 'same-workspace', anchorPath: '/original-anchor',
      phase: 'recovery', activeRunId: 'original-run', pendingJobId: 'original-job' };
    const unchanged = { ...target };
    let isArchived = archived;
    let probes = 0;
    const fixture = dependencies({
      probe: async () => { probes++; return { ...successfulProbe, rootPath: 'D:\\alias', connectionId: 'alias-connection' }; },
      findExisting: (owner, identity) => { assert.equal(owner, 'user-1'); assert.equal(identity, successfulProbe.rootIdentity); return target; },
      getProject: () => ({ project_id: 'original', project_path: target.anchorPath, custom_project_name: 'Saved name', isArchived: isArchived ? 1 : 0, isStarred: 1 }),
      setArchived: (id, value) => { assert.equal(id, 'original'); isArchived = value; },
      prepareAnchor: async () => assert.fail('existing target allocated an anchor'),
      persist: () => assert.fail('existing target was replaced'),
    });
    const probe = await probeSshProjectDirectory({ ownerId: 'user-1', connectionId: 'alias-connection', rootPath: 'D:\\alias' }, fixture);
    assert.equal(probe.existingProject?.isArchived, archived);
    assert.equal(isArchived, archived, 'probe must not restore an archived project');
    const result = await createSshProject({ ownerId: 'user-1', connectionId: 'alias-connection', rootPath: 'D:\\alias', customName: 'Never rename' }, fixture);
    assert.equal(result.outcome, archived ? 'reactivated_archived' : 'existing');
    assert.equal(result.project.projectId, 'original');
    assert.equal(result.project.displayName, 'Saved name');
    assert.equal(result.project.displayPath, root);
    assert.equal(result.project.sshConnectionId, 'original-connection');
    assert.equal(result.project.isStarred, true);
    assert.equal(result.project.isArchived, false);
    assert.equal(probes, 2, 'explicit create/open must verify again');
    assert.deepEqual(target, unchanged);
  }
});

test('probe hides foreign or mismatched physical roots and never mutates metadata', async () => {
  for (const target of [{ ownerId: 'foreign', rootIdentity: successfulProbe.rootIdentity }, { ownerId: 'user-1', rootIdentity: 'different-root' }]) {
    const result = await probeSshProjectDirectory({ ownerId: 'user-1', connectionId: 'laptop', rootPath: root }, dependencies({
      findExisting: () => target as SshProjectTarget,
      getProject: () => assert.fail('foreign project metadata read'),
      prepareAnchor: async () => assert.fail('probe prepared anchor'),
      setArchived: () => assert.fail('probe restored archive'),
    }));
    assert.equal('existingProject' in result, false);
  }
});

test('duplicate race re-reads the exact owner/root winner and removes only its losing empty anchor', async () => {
  const target: SshProjectTarget = { projectId: 'winner', ownerId: 'user-1', connectionId: 'old', connectionLabel: 'Old desktop', rootPath: root,
    rootIdentity: successfulProbe.rootIdentity, generation: 'old-generation', workspaceId: 'old-workspace', anchorPath: '/winner-anchor', phase: 'running', activeRunId: 'writer', pendingJobId: 'job' };
  let persisted = false;
  let removed = '';
  const result = await createSshProject({ ownerId: 'user-1', connectionId: 'laptop', rootPath: root }, dependencies({
    findExisting: () => persisted ? target : null,
    persist: () => { persisted = true; throw Object.assign(new Error('duplicate root race'), { code: 'SSH_PROJECT_ALREADY_EXISTS' }); },
    getProject: () => ({ project_id: 'winner', project_path: target.anchorPath, custom_project_name: 'Winner', isArchived: 0, isStarred: 0 }),
    removeEmptyAnchor: async anchor => { removed = anchor; },
  }));
  assert.equal(result.outcome, 'existing');
  assert.equal(result.project.projectId, 'winner');
  assert.equal(removed, path.resolve('/workspace/.chisa-ssh-projects/project-1'));
  assert.equal(target.activeRunId, 'writer');
  assert.equal(target.pendingJobId, 'job');
});

test('unrelated persistence conflicts never become duplicate successes even if another target exists', async () => {
  let persisted = false;
  const conflict = Object.assign(new Error('anchor collision'), { code: 'SSH_PROJECT_CONFLICT' });
  await assert.rejects(createSshProject({ ownerId: 'user-1', connectionId: 'laptop', rootPath: root }, dependencies({
    findExisting: () => { if (persisted) assert.fail('unrelated constraint looked up a duplicate'); return null; },
    persist: () => { persisted = true; throw conflict; },
  })), error => error === conflict);
});

test('persistence conflict cleans only the newly prepared empty anchor and preserves the original error', async () => {
  let removed = '';
  const conflict = Object.assign(new Error('duplicate root'), { code: 'SSH_PROJECT_ALREADY_EXISTS' });
  await assert.rejects(createSshProject({ ownerId: 'user-1', connectionId: 'laptop', rootPath: root }, dependencies({
    persist: () => { throw conflict; },
    removeEmptyAnchor: async anchor => { removed = anchor; },
  })), error => error === conflict);
  assert.equal(removed, path.resolve('/workspace/.chisa-ssh-projects/project-1'));
});
