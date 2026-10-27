import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { mock } from 'node:test';
import { promisify } from 'node:util';

import { stageProviderCli } from '@/modules/providers/services/provider-code-cache.service.js';

const runFile = promisify(execFile);
test('CLI cache retains self-contained node_modules dependencies used by a fixed local executable', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'chisa-cli-cache-'));
  const home = mock.method(os, 'homedir', () => path.join(root, 'home'));
  try {
    const install = path.join(root, 'install');
    await mkdir(path.join(install, 'node_modules', 'fixture-dependency'), { recursive: true });
    await writeFile(path.join(install, 'main.cjs'), "process.stdout.write(require('fixture-dependency'));\n");
    await writeFile(path.join(install, 'node_modules', 'fixture-dependency', 'index.js'), "module.exports='bounded-cli-dependency';\n");
    const staged = stageProviderCli(path.join(install, 'main.cjs'));
    assert.equal(await readFile(path.join(staged.mount.source, 'node_modules', 'fixture-dependency', 'index.js'), 'utf8'), "module.exports='bounded-cli-dependency';\n");
    const output = await runFile(process.execPath, [path.join(staged.mount.source, 'main.cjs')], { env: { ...process.env, NODE_OPTIONS: '' } });
    assert.equal(output.stdout, 'bounded-cli-dependency');
  } finally { home.mock.restore(); await rm(root, { recursive: true, force: true }); }
});

test('CLI cache rejects dependency symlinks instead of following arbitrary host content', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'chisa-cli-cache-link-'));
  const home = mock.method(os, 'homedir', () => path.join(root, 'home'));
  try {
    const install = path.join(root, 'install');
    const outside = path.join(root, 'outside');
    await mkdir(path.join(install, 'node_modules'), { recursive: true }); await mkdir(outside);
    await writeFile(path.join(install, 'main.cjs'), 'process.exit(0);');
    await writeFile(path.join(outside, 'index.js'), 'secret fixture');
    await symlink(outside, path.join(install, 'node_modules', 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => stageProviderCli(path.join(install, 'main.cjs')), { code: 'WORKSPACE_PROVIDER_RUNTIME_UNAVAILABLE' });
  } finally { home.mock.restore(); await rm(root, { recursive: true, force: true }); }
});
