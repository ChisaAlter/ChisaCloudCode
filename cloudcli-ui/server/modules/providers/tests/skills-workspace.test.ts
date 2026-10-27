import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test, { after, mock } from 'node:test';

import express, { type NextFunction, type Request, type Response } from 'express';

import { AppError, WORKSPACES_ROOT } from '@/shared/index.js';
import type { ProviderSkill, WorkspaceDescriptor } from '@/shared/index.js';

const previousDatabasePath = process.env.DATABASE_PATH;
await fs.mkdir(WORKSPACES_ROOT, { recursive: true });
const bootstrap = await fs.mkdtemp(path.join(path.resolve(WORKSPACES_ROOT), '.chisa-skills-db-'));
process.env.DATABASE_PATH = path.join(bootstrap, 'auth.db');
await fs.writeFile(process.env.DATABASE_PATH, '');
const { closeConnection, initializeDatabase, getConnection, projectsDb, sessionsDb } = await import('@/modules/database/index.js');
// Selected skills fixtures own explicit cloud markers and no restored account runtime.
const { assertCloudWorkspaceOwner } = await import('@/modules/workspace-runtime/index.js');
mock.module('@/modules/workspace-runtime/index.js', { namedExports: {
  assertCloudWorkspaceOwner,
  ensureCloudWorkspaceBinding() {}, excludeCloudWorkspaceMetadata() {}, getWorkspaceRuntimeIdentity() { return undefined; },
  executeWorkspaceRuntimePreview() { assert.fail('unexpected preview'); }, createWorkspaceRuntimeService() { assert.fail('unexpected restore'); },
} });
const { admitWorkspaceExecution, describeWorkspaceSelection } = await import('@/modules/workspace-bridge/index.js');
const { providerSkillsService } = await import('../services/skills.service.js');
const { providerRegistry } = await import('../provider.registry.js');
const { default: providerRouter } = await import('../provider.routes.js');
await initializeDatabase();
after(async () => {
  closeConnection();
  if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
  else process.env.DATABASE_PATH = previousDatabasePath;
  assert.equal(path.dirname(bootstrap), path.resolve(WORKSPACES_ROOT));
  await fs.rm(bootstrap, { recursive: true, force: true });
});

function selector(descriptor: WorkspaceDescriptor) {
  return {
    projectId: descriptor.projectId,
    workspaceId: descriptor.workspaceId,
    generation: descriptor.generation,
    ...(descriptor.sessionId ? { sessionId: descriptor.sessionId } : {}),
  };
}

async function writeSkill(root: string, name: string): Promise<string> {
  const target = path.join(root, name, 'SKILL.md');
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, `---\nname: ${name}\ndescription: ${name} description\n---\nSkill content.`);
  return target;
}

async function withFixture(run: (fixture: {
  root: string;
  repo: string;
  foreign: string;
  home: string;
  sessionId: string;
  projectId: string;
  current(): ReturnType<typeof selector>;
  bind(epoch?: string, port?: number): Promise<void>;
  materialize(): Promise<WorkspaceDescriptor>;
}) => Promise<void>) {
  const directory = await fs.mkdtemp(path.join(path.resolve(WORKSPACES_ROOT), '.chisa-skills-scope-'));
  const repo = path.join(directory, 'repo');
  const root = path.join(repo, 'packages', 'app');
  const foreign = path.join(directory, 'foreign');
  const home = path.join(directory, 'home');
  for (const target of [root, foreign, home, path.join(repo, '.git')]) await fs.mkdir(target, { recursive: true });
  const sessionId = 'skills-' + randomUUID();
  sessionsDb.createAppSession(sessionId, 'codex', root, 'Skills session');
  projectsDb.createProjectPath(foreign);
  const projectId = projectsDb.getProjectPath(root)!.project_id;
  const current = () => selector(describeWorkspaceSelection({ projectId, sourceRoot: root }).cloudReplica);
  const bind = async (epoch = 'first', _retiredPort = 19081) => {
    await fs.writeFile(path.join(root, '.chisa-bridge.json'), JSON.stringify({ protocol: 3, root, owner: 'cloud-skills-fixture', bindingEpoch: epoch }));
  };
  mock.method(os, 'homedir', () => home);
  try {
    await run({ root, repo, foreign, home, sessionId, projectId, current, bind, materialize: async () => {
      const execution = await admitWorkspaceExecution({ cwd: root, sessionId, workspaceMode: 'isolated' });
      await execution.close();
      const descriptor = describeWorkspaceSelection({ projectId, sourceRoot: root, sessionId }).session;
      assert.ok(descriptor);
      return descriptor;
    } });
  } finally {
    mock.restoreAll();
    sessionsDb.deleteSessionById(sessionId);
    assert.equal(path.dirname(directory), path.resolve(WORKSPACES_ROOT));
    await fs.rm(directory, { recursive: true, force: true });
  }
}

async function withServer(run: (baseUrl: string) => Promise<void>) {
  const app = express().use('/api/providers', providerRouter);
  app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    response.status(error instanceof AppError ? error.statusCode : 500).json({
      error: { code: error instanceof AppError ? error.code : 'INTERNAL_ERROR' },
    });
  });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try { await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/providers/codex/skills`); }
  finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}

for (const provider of ['codex', 'opencode'] as const) {
  test(`${provider} selected listing excludes ancestor and neighboring skills but preserves globals`, async () => {
    await withFixture(async ({ root, repo, foreign, home, current }) => {
      await writeSkill(path.join(root, '.agents', 'skills'), 'selected');
      await writeSkill(path.join(path.dirname(root), '.agents', 'skills'), 'parent');
      await writeSkill(path.join(repo, '.agents', 'skills'), 'ancestor');
      await writeSkill(path.join(foreign, '.agents', 'skills'), 'foreign');
      await writeSkill(path.join(home, '.agents', 'skills'), 'global');
      const skills = await providerSkillsService.listProviderSkills(provider, { ...current(), workspacePath: foreign });
      assert.deepEqual(skills.filter(skill => skill.scope === 'repo' || skill.scope === 'project').map(skill => skill.name), ['selected']);
      assert.ok(skills.some(skill => skill.name === 'global' && skill.scope === 'user'));
      assert.ok(skills.find(skill => skill.name === 'selected')!.sourcePath.startsWith(root + path.sep));
    });
  });
}

test('global listing has no implicit cwd repository while unbound legacy paths remain supported', async () => {
  await withFixture(async ({ root, repo, home }) => {
    await writeSkill(path.join(root, '.agents', 'skills'), 'selected');
    await writeSkill(path.join(repo, '.agents', 'skills'), 'ancestor');
    await writeSkill(path.join(home, '.agents', 'skills'), 'global');
    mock.method(process, 'cwd', () => root);
    const global = await providerSkillsService.listProviderSkills('codex');
    assert.ok(global.every(skill => skill.scope !== 'repo' && skill.scope !== 'project'));
    assert.ok(global.some(skill => skill.name === 'global'));
    const legacy = await providerSkillsService.listProviderSkills('codex', { workspacePath: root });
    assert.ok(legacy.some(skill => skill.name === 'selected'));
    assert.ok(legacy.some(skill => skill.name === 'ancestor'));
  });
});

test('skills HTTP rejects partial, repeated and bound path-only selectors before provider discovery', async () => {
  await withFixture(async ({ root, bind, current }) => {
    await bind();
    const selected = current();
    const discovery = mock.method(providerRegistry.resolveProvider('codex').skills, 'listSkills', async () => []);
    await withServer(async baseUrl => {
      const queries = [
        ['projectId=' + selected.projectId, 'INVALID_WORKSPACE_SELECTOR'],
        [new URLSearchParams({ ...selected, sessionId: ' ' }).toString(), 'INVALID_WORKSPACE_SELECTOR'],
        [new URLSearchParams(selected).toString() + '&workspaceId=duplicate', 'INVALID_WORKSPACE_SELECTOR'],
        ['workspacePath=' + encodeURIComponent(root), 'WORKSPACE_SELECTOR_REQUIRED'],
        [new URLSearchParams({ ...selected, generation: 'stale' }).toString(), 'WORKSPACE_GENERATION_CHANGED'],
      ];
      for (const [query, code] of queries) {
        const response = await fetch(`${baseUrl}?${query}`);
        assert.ok(response.status === 400 || response.status === 409);
        assert.equal((await response.json() as { error: { code: string } }).error.code, code);
      }
      assert.equal(discovery.mock.callCount(), 0);
    });
  });
});

test('skills HTTP derives the root from the selector and discards injected paths', async () => {
  await withFixture(async ({ root, foreign, current }) => {
    await writeSkill(path.join(root, '.agents', 'skills'), 'selected');
    await writeSkill(path.join(foreign, '.agents', 'skills'), 'foreign');
    await withServer(async baseUrl => {
      const response = await fetch(baseUrl + '?' + new URLSearchParams({ ...current(), workspacePath: foreign }));
      assert.equal(response.status, 200);
      const payload = await response.json() as { data: { skills: ProviderSkill[] } };
      assert.deepEqual(payload.data.skills.filter(skill => skill.scope === 'repo').map(skill => skill.name), ['selected']);
    });
  });
});

test('selected discovery does not traverse symlinked skill directories or ancestor source folders', async () => {
  await withFixture(async ({ root, foreign, current }) => {
    const skillsRoot = path.join(root, '.agents', 'skills');
    await writeSkill(skillsRoot, 'selected');
    await writeSkill(path.join(foreign, '.agents', 'skills'), 'secret');
    await fs.symlink(path.join(foreign, '.agents', 'skills', 'secret'), path.join(skillsRoot, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
    const read = mock.method(fs, 'readFile');
    const skills = await providerSkillsService.listProviderSkills('codex', current());
    assert.deepEqual(skills.filter(skill => skill.scope === 'repo').map(skill => skill.name), ['selected']);
    assert.equal(read.mock.calls.some(call => String(call.arguments[0]).includes('escape')), false);
    read.mock.restore();
    const agents = path.join(root, '.agents');
    assert.equal(path.dirname(agents), root);
    await fs.rm(agents, { recursive: true });
    await fs.symlink(path.join(foreign, '.agents'), agents, process.platform === 'win32' ? 'junction' : 'dir');
    assert.equal((await providerSkillsService.listProviderSkills('codex', current())).some(skill => skill.name === 'secret'), false);
  });
});

test('same-root session selectors require exact app ownership and cannot substitute the replica identity', async () => {
  await withFixture(async ({ root, foreign, current, bind, materialize, sessionId }) => {
    await bind();
    const replica = current();
    await assert.rejects(providerSkillsService.listProviderSkills('codex', { ...replica, sessionId }), { code: 'WORKSPACE_SESSION_NOT_READY' });
    const session = await materialize();
    assert.equal(session.rootPath, root);
    assert.notEqual(session.workspaceId, replica.workspaceId);
    const listing = mock.method(providerRegistry.resolveProvider('codex').skills, 'listSkills', async () => []);
    await providerSkillsService.listProviderSkills('codex', selector(session));
    assert.equal(listing.mock.callCount(), 1);
    await assert.rejects(providerSkillsService.listProviderSkills('codex', { ...replica, sessionId }), { code: 'WORKSPACE_SELECTION_MISMATCH' });
    const foreignId = projectsDb.getProjectPath(foreign)!.project_id;
    await assert.rejects(providerSkillsService.listProviderSkills('codex', { ...selector(session), projectId: foreignId }), { code: 'WORKSPACE_SELECTION_MISMATCH' });
    await assert.rejects(providerSkillsService.listProviderSkills('codex', { ...selector(session), sessionId: 'missing' }), { code: 'WORKSPACE_SESSION_NOT_FOUND' });
  });
});

test('epoch and session ownership changes during an awaited discovery reject the complete result', async () => {
  await withFixture(async ({ bind, current, materialize, sessionId, foreign }) => {
    await bind();
    const session = await materialize();
    const listing = mock.method(providerRegistry.resolveProvider('codex').skills, 'listSkills', async () => {
      getConnection().prepare('UPDATE sessions SET project_path = ? WHERE session_id = ?').run(foreign, sessionId);
      return [];
    });
    await assert.rejects(providerSkillsService.listProviderSkills('codex', selector(session)), { code: 'WORKSPACE_SELECTION_MISMATCH' });
    listing.mock.restore();
    const replica = current();
    mock.method(providerRegistry.resolveProvider('codex').skills, 'listSkills', async () => { await bind('replacement'); return []; });
    await assert.rejects(providerSkillsService.listProviderSkills('codex', replica), { code: 'WORKSPACE_GENERATION_CHANGED' });
  });
});

test('generation changes during an actual skill read cannot return stale metadata', async () => {
  await withFixture(async ({ root, current, bind }) => {
    const skillPath = await writeSkill(path.join(root, '.agents', 'skills'), 'selected');
    const selected = current();
    const original = fs.readFile.bind(fs);
    mock.method(fs, 'readFile', (async (...args: Parameters<typeof fs.readFile>) => {
      const content = await original(...args);
      if (String(args[0]) === skillPath) await bind('replaced-during-read');
      return content;
    }) as typeof fs.readFile);
    await assert.rejects(providerSkillsService.listProviderSkills('codex', selected), { code: 'WORKSPACE_GENERATION_CHANGED' });
  });
});

test('retired local skill reads fail explicitly instead of exposing host shadow content', async () => {
  await withFixture(async ({ root, current }) => {
    await writeSkill(path.join(root, '.agents', 'skills'), 'local-shadow');
    const requests: Array<{ op: string; path: string }> = [];
    const directories = new Set(['/workspace', '/workspace/.agents', '/workspace/.agents/skills', '/workspace/.agents/skills/remote']);
    const skillPath = '/workspace/.agents/skills/remote/SKILL.md';
    const server = createServer((incoming, outgoing) => {
      void (async () => {
        const chunks: Buffer[] = [];
        for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
        const request = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { op: string; path: string };
        requests.push(request);
        assert.equal(incoming.url, '/workspace/rpc');
        assert.ok(directories.has(request.path) || request.path === skillPath);
        let result: object;
        if (request.op === 'lstat') result = { size: 10, mtime: 1, mode: 0o644, dir: directories.has(request.path), symlink: false };
        else if (request.op === 'realpath') result = { path: request.path };
        else if (request.op === 'list') result = { entries: [{ name: 'remote', dir: true }] };
        else { assert.equal(request.op, 'read'); result = { b64: Buffer.from('---\nname: remote\ndescription: remote content\n---').toString('base64') }; }
        outgoing.setHeader('Content-Type', 'application/json');
        outgoing.end(JSON.stringify(result));
      })().catch(error => { outgoing.statusCode = 500; outgoing.end(JSON.stringify({ error: String(error) })); });
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    try {
      await fs.writeFile(path.join(root, '.chisa-bridge.json'), JSON.stringify({ protocol: 1, port: (server.address() as AddressInfo).port, token: 'retired-skills-fixture', bindingEpoch: 'retired' }));
      await assert.rejects(providerSkillsService.listProviderSkills('codex', current()), { code: 'LOCAL_WORKSPACE_REMOVED' });
      assert.deepEqual(requests, []);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });
});
