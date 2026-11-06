import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rename, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { getWorkspaceBrokerAdmission } from '@/modules/workspace-runtime/index.js';

import { selectWorkspaceBrokerProfile } from '../workspace-broker-profile.service.js';

test('operator profile is an exact selector and cannot enroll extra HOME/cache/project mounts',{ skip: process.platform === 'linux' && process.getuid?.() !== 0 },async () => {
  // Windows fixtures verify selectors. Linux deployment additionally requires the
  // fixed configuration and all ancestors owned/protected by operator root.
  const base = await mkdtemp(path.join(os.tmpdir(),'chisa-profile-selector-')); const root = path.join(base,'project'); const code = path.join(base,'code');
  await mkdir(root); await mkdir(code); const policy = path.join(base,'profiles.json');
  const previous = process.env.CHISA_WORKSPACE_BROKER_PROFILE_CONFIG;
  const admission = { workspaceId: 'workspace',generation: 'generation',root } as Awaited<ReturnType<typeof getWorkspaceBrokerAdmission>>;
  const mounts = [{ source: code,target: '/runtime/provider-code',writable: false }];
  const profile = { workspaceId: 'workspace',generation: 'generation',root,profileId: 'codex',purpose: 'provider',readOnly: false,runtimeMounts: mounts,gitMounts: [],environment: { HOME: '/runtime/provider-state/home',PATH: '/runtime/provider-code:/usr/bin' } };
  const request = { purpose: 'provider' as const,readOnly: false,runtimeMounts: mounts,environment: { HOME: profile.environment.HOME,PATH: profile.environment.PATH,OPENAI_API_KEY: 'fixture' } };
  try {
    process.env.CHISA_WORKSPACE_BROKER_PROFILE_CONFIG=policy; await writeFile(policy,JSON.stringify({ version: 1,profiles: [profile] }),{ mode: 0o600 });
    assert.deepEqual(selectWorkspaceBrokerProfile(admission,request),{ profileId: 'codex',environment: { OPENAI_API_KEY: 'fixture' } });
    for (const invalid of [
      { ...request,runtimeMounts: [] },{ ...request,runtimeMounts: [...mounts,{ source: root,target: '/runtime/provider-assets',writable: false }] },
      { ...request,runtimeMounts: [{ ...mounts[0],writable: true }] },{ ...request,environment: { HOME: '/root' } },
      { ...request,readOnly: true },{ ...request,purpose: 'shell' as const },
    ]) assert.throws(() => selectWorkspaceBrokerProfile(admission,invalid),{ code: 'WORKSPACE_BROKER_PROFILE_UNAVAILABLE' });
    await writeFile(policy,JSON.stringify({ version: 1,profiles: [profile,profile] }));
    assert.throws(() => selectWorkspaceBrokerProfile(admission,request),{ code: 'WORKSPACE_BROKER_PROFILE_UNAVAILABLE' });
    await writeFile(policy,JSON.stringify({ version: 1,profiles: [profile] }));
    const alias = path.join(base,'alias'); await symlink(code,alias,process.platform==='win32' ? 'junction' : 'dir');
    assert.throws(() => selectWorkspaceBrokerProfile(admission,{ ...request,runtimeMounts: [{ ...mounts[0],source: alias }] }),{ code: 'WORKSPACE_BROKER_PROFILE_UNAVAILABLE' });
    if (process.platform!=='win32') {
      const retained = policy+'.retained'; await rename(policy,retained); await symlink(retained,policy);
      assert.throws(() => selectWorkspaceBrokerProfile(admission,request),{ code: 'WORKSPACE_BROKER_PROFILE_UNAVAILABLE' });
    }
    delete process.env.CHISA_WORKSPACE_BROKER_PROFILE_CONFIG;
    assert.throws(() => selectWorkspaceBrokerProfile(admission,request),{ code: 'WORKSPACE_BROKER_PROFILE_UNAVAILABLE' });
  } finally {
    if (previous===undefined) delete process.env.CHISA_WORKSPACE_BROKER_PROFILE_CONFIG; else process.env.CHISA_WORKSPACE_BROKER_PROFILE_CONFIG=previous;
    assert.equal(path.dirname(root),base); await rm(base,{ recursive: true,force: true });
  }
});
