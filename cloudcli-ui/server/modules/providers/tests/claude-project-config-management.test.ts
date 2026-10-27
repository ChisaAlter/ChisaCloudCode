import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { after, mock } from 'node:test';

import { AppError } from '@/shared/index.js';
import type { FileTreeFileSystem, WorkspaceDescriptor } from '@/shared/index.js';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-config-management-'));
const anchor = path.join(root, 'metadata-anchor');
await fs.mkdir(anchor);
const homes = new Map([1, 2, 3].map(id => [id, path.join(root, 'user-' + id)]));
for (const home of homes.values()) await fs.mkdir(home);
const descriptor: WorkspaceDescriptor = { projectId: 'project', workspaceId: 'workspace', generation: 'generation', kind: 'cloudReplica', rootPath: anchor, sourceRoot: anchor, requestedMode: 'shared', effectiveMode: 'shared', phase: 'idle', publicationState: 'integrated', capabilities: { read: true, write: true, git: true, shell: true, preview: false, integrate: false, cloudExecutionIndependentOfDesktop: true } };
const remote = new Map<string, { content: string; hash: string }>();
let leases = 0; let captures = 0; let writing = false; let stale = false; let conflict = false;
const remoteFile = path.join(anchor, '.mcp.json');
const absent = () => Object.assign(new Error('missing'), { code: 'ENOENT' });
const scoped = (candidate: string) => candidate === remoteFile;
mock.module('@/modules/database/index.js', { namedExports: { projectsDb: { getProjectPath: (candidate: string) => candidate === anchor ? { project_id: 'project', project_path: anchor } : null }, userDb: { getActiveUserIds: () => ['1', '2', '3'] } } });
mock.module('@/modules/workspace-runtime/index.js', { namedExports: { assertCloudWorkspaceOwner: (candidate: string, userId: number) => { if (candidate !== anchor || userId !== 1) throw new AppError('Forbidden project.', { code: 'CLOUD_WORKSPACE_OWNER_MISMATCH', statusCode: 403 }); } } });
mock.module('@/modules/workspace-bridge/index.js', { namedExports: {
  resolveSshProjectTarget: () => null, assertSshProjectOwner() {}, isWorkspaceBound: () => true,
  describeWorkspaceSelection: () => ({ cloudReplica: descriptor, session: null }),
  assertWorkspaceDescriptor() { if (stale) throw new AppError('Stale workspace.', { code: 'WORKSPACE_GENERATION_CHANGED', statusCode: 409 }); },
  async withWorkspaceWriteOperation(_candidate: string, operation: () => Promise<unknown>) { assert.equal(writing, false); writing = true; try { return await operation(); } finally { writing = false; } },
  bridgeFileSystem: (base: FileTreeFileSystem) => ({ ...base,
    async lstat(candidate: string) { if (!scoped(candidate)) return base.lstat(candidate); const item = remote.get(candidate); if (!item) throw absent(); return { isSymbolicLink: () => false, isDirectory: () => false, size: item.content.length, mtimeMs: 1 }; },
    async readTextSnapshot(candidate: string) { if (!scoped(candidate)) return { content: await base.readTextFile(candidate) }; const item = remote.get(candidate); if (!item) throw absent(); return { ...item }; },
    async writeTextSnapshot(candidate: string, content: string, expectedHash: string | null) { assert.equal(candidate, remoteFile); assert.equal(writing, true); if (conflict || expectedHash !== (remote.get(candidate)?.hash ?? null)) throw new AppError('Conflict.', { code: 'CONTENT_CONFLICT', statusCode: 409 }); remote.set(candidate, { content, hash: 'hash-' + content.length }); return {}; },
  }),
} });
mock.module('@/modules/workspaces/index.js', { namedExports: { resolveSelectedWorkspace: () => descriptor } });
mock.module('../services/claude-accounts.service.js', { namedExports: { claudeAccountsService: { captureLaunch: (userId: number) => { captures++; leases++; return { configDir: homes.get(userId), release() { leases--; } }; } } } });
mock.module('../services/claude-account-history.service.js', { namedExports: { prepareClaudeAccountHistory: async () => {}, prepareClaudeUserHistory: async (userId: number) => homes.get(userId) } });
mock.module('../services/claude-connections.service.js', { namedExports: { claudeConnectionsService: { getActiveConnection: (userId: number) => userId === 3 ? { id: 'api' } : null } } });
const { ClaudeMcpProvider } = await import('../list/claude/claude-mcp.provider.js');
const { ClaudeSkillsProvider } = await import('../list/claude/claude-skills.provider.js');
const provider = { mcp: new ClaudeMcpProvider(), skills: new ClaudeSkillsProvider() };
mock.module('../provider.registry.js', { namedExports: { providerRegistry: { resolveProvider: () => provider } } });
const { providerMcpService } = await import('../services/mcp.service.js');
const { providerSkillsService } = await import('../services/skills.service.js');
after(async () => { assert.equal(leases, 0); assert.equal(path.dirname(root), os.tmpdir()); await fs.rm(root, { recursive: true, force: true }); });

test('selected account MCP CRUD is isolated and uses runtime .claude.json rather than server home', async () => {
  await providerMcpService.upsertProviderMcpServer('claude', { name: 'one', scope: 'user', transport: 'http', url: 'https://one.example.com/mcp' }, { userId: 1 });
  assert.deepEqual((await providerMcpService.listProviderMcpServersForScope('claude', 'user', { userId: 1 })).map(server => server.name), ['one']);
  assert.deepEqual(await providerMcpService.listProviderMcpServersForScope('claude', 'user', { userId: 2 }), []);
  assert.equal(JSON.parse(await fs.readFile(path.join(homes.get(1)!, '.claude.json'), 'utf8')).mcpServers.one.type, 'http');
  assert.equal(leases, 0);
  await providerMcpService.removeProviderMcpServer('claude', { name: 'one', scope: 'user' }, { userId: 1 });
});

test('API account management does not capture a stale subscription; unauthenticated routes fail before capture', async () => {
  const before = captures;
  await providerMcpService.listProviderMcpServersForScope('claude', 'user', { userId: 3 });
  assert.equal(captures, before);
  await assert.rejects(providerMcpService.listProviderMcpServers('claude', { userId: null }), AppError);
  assert.equal(captures, before);
});

test('project MCP uses pinned bridge snapshots and CAS writes without creating files at metadata anchors', async () => {
  await providerMcpService.upsertProviderMcpServer('claude', { name: 'remote', scope: 'project', workspacePath: anchor, transport: 'sse', url: 'https://remote.example.com/sse' }, { userId: 1 });
  assert.equal(JSON.parse(remote.get(remoteFile)!.content).mcpServers.remote.type, 'sse');
  await assert.rejects(fs.stat(remoteFile), { code: 'ENOENT' });
  const listed = await providerMcpService.listProviderMcpServersForScope('claude', 'project', { userId: 1, workspacePath: anchor });
  assert.deepEqual(listed.map(server => server.name), ['remote']);
  conflict = true;
  try { await assert.rejects(providerMcpService.removeProviderMcpServer('claude', { name: 'remote', scope: 'project', workspacePath: anchor }, { userId: 1 }), { code: 'CONTENT_CONFLICT' }); }
  finally { conflict = false; }
  assert.equal(leases, 0);
});

test('foreign ownership and stale selectors reject before remote config discovery or writes', async () => {
  await assert.rejects(providerMcpService.listProviderMcpServers('claude', { userId: 2, workspacePath: anchor }), { code: 'CLOUD_WORKSPACE_OWNER_MISMATCH' });
  stale = true;
  try { await assert.rejects(providerMcpService.upsertProviderMcpServer('claude', { name: 'blocked', workspacePath: anchor, transport: 'http', url: 'https://example.com' }, { userId: 1 }), { code: 'WORKSPACE_GENERATION_CHANGED' }); }
  finally { stale = false; }
  assert.doesNotMatch(remote.get(remoteFile)!.content, /blocked/);
  assert.equal(leases, 0);
});

test('private global skills cannot follow symlinked account roots into another account', async () => {
  const ownRoot = path.join(homes.get(2)!, 'skills');
  const foreignRoot = path.join(homes.get(1)!, 'foreign-skills');
  await fs.mkdir(foreignRoot);
  await fs.symlink(foreignRoot, ownRoot, process.platform === 'win32' ? 'junction' : 'dir');
  try { await assert.rejects(providerSkillsService.listProviderSkills('claude', { userId: 2 }), { code: 'PROVIDER_SKILL_PATH_DENIED' }); }
  finally { await fs.unlink(ownRoot); }
});

test('selected account global skill CRUD stays private and never follows native plugin registries', async () => {
  const content = '---\nname: private-skill\ndescription: account skill\n---\nPrivate skill body.';
  await providerSkillsService.addProviderSkills('claude', { entries: [{ directoryName: 'private-skill', content }] }, { userId: 1 });
  const selected = await providerSkillsService.listProviderSkills('claude', { userId: 1 });
  assert.ok(selected.some(skill => skill.name === 'private-skill' && skill.sourcePath.startsWith(homes.get(1)!)));
  assert.deepEqual(await providerSkillsService.listProviderSkills('claude', { userId: 2 }), []);
  await fs.writeFile(path.join(homes.get(1)!, 'settings.json'), JSON.stringify({ enabledPlugins: { malicious: true } }));
  await fs.mkdir(path.join(homes.get(1)!, 'plugins'));
  await fs.writeFile(path.join(homes.get(1)!, 'plugins', 'installed_plugins.json'), JSON.stringify({ plugins: { malicious: [{ installPath: 'C:\\untrusted\\plugin' }] } }));
  assert.equal((await providerSkillsService.listProviderSkills('claude', { userId: 1 })).filter(skill => skill.scope === 'plugin').length, 0);
  await providerSkillsService.removeProviderSkill('claude', { directoryName: 'private-skill' }, { userId: 1 });
  assert.deepEqual(await providerSkillsService.listProviderSkills('claude', { userId: 1 }), []);
});
