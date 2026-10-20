import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chown, lchown, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { mock } from 'node:test';

import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';

let selectedCwd: string | undefined;
let closeIterator!: () => void;
mock.module('@anthropic-ai/claude-agent-sdk', { namedExports: {
  createSdkMcpServer, tool,
  query: (input: Parameters<typeof import('@anthropic-ai/claude-agent-sdk').query>[0]) => {
    selectedCwd = input.options?.cwd;
    const held = new Promise<void>(resolve => { closeIterator = resolve; });
    return Object.assign((async function* () { yield { type: 'system', subtype: 'init', session_id: 'fixture' }; await held; })(), { close: () => closeIterator() });
  },
} });

const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), 'chisa-isolated-owner-'));
process.env.WORKSPACES_ROOT = fixtureRoot;
const { workspaceQuery } = await import('@/modules/workspace-bridge/index.js');
const linuxRoot = process.platform === 'linux' && process.getuid?.() === 0;

type CommandResult = { code: number | null; stdout: string; stderr: string };
function command(executable: string, args: string[], cwd: string, asWorkspaceUser = false): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const env: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')));
    Object.assign(env, { HOME: '/nonexistent', XDG_CONFIG_HOME: '/nonexistent', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null', LC_ALL: 'C' });
    const child = spawn(executable, args, { cwd, env, ...(asWorkspaceUser ? { uid: 1000, gid: 1000 } : {}), stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk.toString(); });
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    child.once('error', reject);
    child.once('close', code => resolve({ code, stdout, stderr }));
  });
}
async function git(args: string[], cwd: string, asWorkspaceUser = false): Promise<string> {
  const result = await command('git', args, cwd, asWorkspaceUser);
  assert.equal(result.code, 0, result.stderr);
  return result.stdout;
}
async function ownedTree(root: string): Promise<void> {
  await lchown(root, 1000, 1000);
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const child = path.join(root, entry.name);
    if (entry.isDirectory()) await ownedTree(child);
    else await lchown(child, 1000, 1000);
  }
}

test('root API creates a uid1000 isolated worktree with dirty snapshot and writable metadata', { skip: !linuxRoot, timeout: 15000 }, async () => {
  await chown(fixtureRoot, 1000, 1000);
  const root = await mkdtemp(path.join(fixtureRoot, 'project-'));
  await chown(root, 1000, 1000);
  await git(['init', '-b', 'main'], root, true);
  await writeFile(path.join(root, 'tracked.txt'), 'committed\n');
  await chown(path.join(root, 'tracked.txt'), 1000, 1000);
  await git(['add', 'tracked.txt'], root, true);
  await git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'fixture'], root, true);
  await writeFile(path.join(root, 'tracked.txt'), 'staged\n');
  await git(['add', 'tracked.txt'], root, true);
  await writeFile(path.join(root, 'tracked.txt'), 'dirty working tree\n');
  await mkdir(path.join(root, 'private'), { mode: 0o700 });
  await writeFile(path.join(root, 'private', 'untracked.txt'), 'untracked snapshot\n', { mode: 0o600 });
  await writeFile(path.join(root, '.chisa-bridge.json'), JSON.stringify({ protocol: 2, port: 19081, token: 'fixture', bindingEpoch: 'fixture' }));
  await ownedTree(root);
  const sourceIndex = await readFile(path.join(root, '.git', 'index'));
  const sourceHead = await git(['rev-parse', 'HEAD'], root, true);
  const sourceStatus = await git(['status', '--porcelain=v1', '-z'], root, true);
  const denied = await command('git', ['rev-parse', '--show-toplevel'], root);
  assert.equal(denied.code, 128);
  assert.match(denied.stderr, /dubious ownership/);
  const parent = root + '.chisa-worktrees';
  await mkdir(parent, { mode: 0o700 });
  assert.equal((await stat(parent)).uid, 0, 'also repairs the exact parent left by an older root API');
  const sessionId = 'owned-isolated-session';
  const worktree = path.join(parent, `${sessionId}-${createHash('sha256').update(sessionId).digest('hex').slice(0, 12)}`);
  const query = workspaceQuery({ prompt: 'fixture', options: { cwd: root, chisaSessionId: sessionId, workspaceMode: 'isolated' } as never });
  try {
    await query.next();
    assert.equal(selectedCwd, worktree);
    assert.equal((await stat(parent)).uid, 1000);
    assert.equal((await stat(worktree)).uid, 1000);
    assert.equal((await stat(path.join(root, '.git'))).uid, 1000);
    const worker = await command(process.execPath, ['-e', `const fs=require('node:fs');const marker=JSON.parse(fs.readFileSync('.chisa-bridge.json'));const metadata=JSON.parse(fs.readFileSync('.chisa-session.json'));if(marker.execution!=='isolated-worktree'||metadata.sessionId!=='${sessionId}')throw Error('invalid metadata');if(fs.readFileSync('tracked.txt','utf8')!=='dirty working tree\\n')throw Error('missing dirty snapshot');if(fs.readFileSync('private/untracked.txt','utf8')!=='untracked snapshot\\n')throw Error('missing untracked snapshot');fs.appendFileSync('tracked.txt','worker edit\\n');fs.appendFileSync('private/untracked.txt','worker edit\\n');fs.writeFileSync('worker-created.txt','isolated');`], worktree, true);
    assert.equal(worker.code, 0, worker.stderr);
    assert.equal((await git(['branch', '--show-current'], worktree, true)).trim(), `chisa/session/${path.basename(worktree)}`);
    await git(['status', '--porcelain=v1'], worktree, true);
    assert.deepEqual(await readFile(path.join(root, '.git', 'index')), sourceIndex);
    assert.equal(await git(['rev-parse', 'HEAD'], root, true), sourceHead);
    assert.equal(await git(['status', '--porcelain=v1', '-z'], root, true), sourceStatus);
    assert.equal(await readFile(path.join(root, 'tracked.txt'), 'utf8'), 'dirty working tree\n');
    await assert.rejects(stat(path.join(root, 'worker-created.txt')), { code: 'ENOENT' });
  } finally {
    await query.interrupt();
    await query.next();
    await git(['worktree', 'remove', '--force', worktree], root, true);
    await rm(parent, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test('isolated Git inspection failures do not silently run in the shared source', { timeout: 5000 }, async () => {
  const root = await mkdtemp(path.join(fixtureRoot, 'broken-'));
  await git(['init', '-b', 'main'], root);
  await writeFile(path.join(root, '.git', 'config'), '[broken\n');
  await writeFile(path.join(root, '.chisa-bridge.json'), JSON.stringify({ protocol: 2, port: 19081, token: 'fixture', bindingEpoch: 'fixture' }));
  selectedCwd = undefined;
  const query = workspaceQuery({ prompt: 'fixture', options: { cwd: root, chisaSessionId: 'broken-session' } as never });
  try {
    await assert.rejects(query.next(), { code: 'WORKSPACE_WORKTREE_CREATE_FAILED' });
    assert.equal(selectedCwd, undefined);
    await assert.rejects(stat(root + '.chisa-lease'), { code: 'ENOENT' });
  } finally { await query.return?.(); await rm(root, { recursive: true, force: true }); }
});

test.after(async () => { await rm(fixtureRoot, { recursive: true, force: true }); });
