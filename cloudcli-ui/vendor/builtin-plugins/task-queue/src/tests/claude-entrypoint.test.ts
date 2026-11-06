import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { preLaunchEnv } from '../launch-guards.ts';
import { buildLaunchArgv } from '../launch-policy.ts';

test('direct launch stamps app attribution after both parent and agent environment layers', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'chisa-queue-entrypoint-'));
  try {
    mkdirSync(path.join(root, 'fixture'));
    writeFileSync(path.join(root, 'fixture', '.env'), 'CLAUDE_CODE_ENTRYPOINT=sdk-ts\nSCOPED_MCP_BEARER_TOKEN=fixture-scoped\n');
    for (const inherited of [undefined, '', 'sdk-cli', 'sdk-ts', 'cli', 'other-client']) {
      const parent = { CLAUDE_CODE_ENTRYPOINT: inherited, ANTHROPIC_API_KEY: 'fixture-key', PATH: 'fixture-path' };
      const result = preLaunchEnv('fixture', null, parent, { envRoot: root, oauthPath: path.join(root, 'missing') });
      assert.equal(result.ok, true);
      if (!result.ok) throw new Error(result.error);
      assert.equal(result.env.CLAUDE_CODE_ENTRYPOINT, 'chisacloudcode');
      assert.equal(result.env.SCOPED_MCP_BEARER_TOKEN, 'fixture-scoped');
      assert.equal(result.env.ANTHROPIC_API_KEY, 'fixture-key');
      assert.equal(result.env.PATH, 'fixture-path');
      assert.equal(parent.CLAUDE_CODE_ENTRYPOINT, inherited);
    }
    const runAsParent = { CLAUDE_CODE_ENTRYPOINT: 'sdk-cli' };
    const runAs = preLaunchEnv('fixture', 'other-user', runAsParent, { envRoot: root, oauthPath: '' });
    assert.equal(runAs.ok && runAs.env, runAsParent, 'external run-as launcher remains responsible for its own environment');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

for (const mode of ['review', 'auto'] as const) {
  test(`run-as ${mode} preserves the authorized launcher and reports unverified attribution`, () => {
    const prompt = 'literal prompt $(false); "quoted"';
    const result = buildLaunchArgv({ projectDir: '/fixture/project', runAsUser: 'agent-fixture', launcher: '/usr/local/sbin/forge/run-fixture.sh' }, mode, prompt, '/must-not-launch-claude', 'manual-then-auto');
    assert.deepEqual(result.argv, ['sudo', '-n', '-u', 'agent-fixture', '/usr/local/sbin/forge/run-fixture.sh', '--workflow-mode', mode === 'auto' ? 'auto' : 'manual-then-auto', '--', prompt]);
    assert.match(result.note!, /not verified.*CLAUDE_CODE_ENTRYPOINT=chisacloudcode/);
    if (mode === 'review') assert.match(result.note!, /prompt-enforced/);
  });
}
