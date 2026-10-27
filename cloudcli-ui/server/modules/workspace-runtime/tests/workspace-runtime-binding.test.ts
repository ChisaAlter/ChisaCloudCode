import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { mock } from 'node:test';

type RuntimeIdentity = { userId: string; root: string; owner: string; network: string };
let identity: RuntimeIdentity | undefined;
mock.module('../workspace-runtime.service.js', { namedExports: {
  getWorkspaceRuntimeIdentity: () => identity,
} });
const { ensureCloudWorkspaceBinding } = await import('../workspace-runtime-binding.service.js');

const mismatch = { code: 'WORKSPACE_RUNTIME_MISMATCH', statusCode: 503 };
const recoveryRequired = { code: 'WORKSPACE_RECOVERY_REQUIRED', statusCode: 409 };
const legacyEpoch = 'legacy-epoch-retained-by-sessions';
const markerPath = (root: string) => path.join(root, '.chisa-bridge.json');
const capabilityPath = (root: string) => root + '.chisa-writer-capability.json';
const generationPath = (root: string) => root + '.chisa-generation.json';
const guardPath = (root: string) => root + '.chisa-writer.guard';
function json(file: string, value: unknown): void { writeFileSync(file, JSON.stringify(value), { mode: 0o600 }); }
function read(file: string): Record<string, unknown> { return JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>; }
function legacyMarker(root: string, extra: Record<string, unknown> = {}): void {
  json(markerPath(root), { protocol: 2, port: 18082, token: 'former-desktop-token', bindingEpoch: legacyEpoch, ...extra });
}
function cloudMarker(root: string, extra: Record<string, unknown> = {}): void {
  json(markerPath(root), { protocol: 3, root, owner: identity!.owner, bindingEpoch: legacyEpoch, ...extra });
}
function writerMetadata(root: string, capability: Record<string, unknown> = {}, generation: Record<string, unknown> = {}): void {
  json(capabilityPath(root), { version: 1, root, bindingEpoch: legacyEpoch, protocol: 'chisa-cloud-writer-v1', ...capability });
  json(generationPath(root), { version: 1, root, generation: 'd'.repeat(64), state: 'complete', writer: 'cloud', bindingEpoch: legacyEpoch, updatedAt: '2026-10-24T00:00:00.000Z', ...generation });
  writeFileSync(guardPath(root), '', { mode: 0o600 });
}
function writerSnapshot(root: string): string[] {
  return [capabilityPath(root), generationPath(root), guardPath(root)].map(file => readFileSync(file, 'utf8'));
}
function noWriterMetadata(root: string): void {
  assert.equal(existsSync(capabilityPath(root)), false);
  assert.equal(existsSync(generationPath(root)), false);
  assert.equal(existsSync(guardPath(root)), false);
}
function removeFixture(file: string, parent: string): void {
  const resolved = path.resolve(file);
  assert.ok(resolved.startsWith(parent + path.sep), 'cleanup must remain inside the known temporary fixture');
  rmSync(resolved, { recursive: true, force: true });
}
function runtimeHost(platform: NodeJS.Platform, configuredRoot: string | undefined, run: () => void): void {
  const beforePlatform = process.platform;
  const beforeRoot = process.env.WORKSPACES_ROOT;
  Object.defineProperty(process, 'platform', { value: platform });
  if (configuredRoot === undefined) delete process.env.WORKSPACES_ROOT;
  else process.env.WORKSPACES_ROOT = configuredRoot;
  try { run(); }
  finally {
    Object.defineProperty(process, 'platform', { value: beforePlatform });
    if (beforeRoot === undefined) delete process.env.WORKSPACES_ROOT;
    else process.env.WORKSPACES_ROOT = beforeRoot;
  }
}
function fixture(run: (root: string, account: string, parent: string) => void): void {
  const parent = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'chisa-cloud-binding-')));
  const account = path.join(parent, 'account');
  const root = path.join(account, 'project');
  mkdirSync(root, { recursive: true });
  identity = { userId: '17', root: account, owner: 'a'.repeat(24), network: 'chisa-workspace-network-' + 'a'.repeat(24) };
  try { run(root, account, parent); }
  finally {
    identity = undefined;
    assert.equal(path.dirname(account), parent);
    assert.equal(path.dirname(parent), realpathSync(os.tmpdir()));
    rmSync(parent, { recursive: true, force: true });
  }
}

test('a verified cloud project gets a persistent marker and complete writer metadata without changing project files', () => {
  fixture(root => {
    const source = path.join(root, 'README.md');
    writeFileSync(source, 'existing cloud project\n');
    mkdirSync(path.join(root, '.git'));
    const gitConfig = path.join(root, '.git', 'config');
    writeFileSync(gitConfig, '[core]\n\tbare = false\n');
    ensureCloudWorkspaceBinding(root);
    const marker = read(markerPath(root));
    assert.equal(marker.protocol, 3); assert.equal(marker.root, root); assert.equal(marker.owner, identity!.owner);
    assert.match(String(marker.bindingEpoch), /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/);
    assert.deepEqual(read(capabilityPath(root)), { version: 1, root, bindingEpoch: marker.bindingEpoch, protocol: 'chisa-cloud-writer-v1' });
    const generation = read(generationPath(root));
    assert.equal(generation.version, 1); assert.equal(generation.root, root); assert.equal(generation.bindingEpoch, marker.bindingEpoch);
    assert.equal(generation.state, 'complete'); assert.equal(generation.writer, 'cloud');
    assert.match(String(generation.generation), /^[a-f0-9]{64}$/);
    assert.ok(Number.isFinite(Date.parse(String(generation.updatedAt))));
    assert.equal(readFileSync(guardPath(root), 'utf8'), '');
    const before = writerSnapshot(root);
    const markerBefore = readFileSync(markerPath(root), 'utf8');
    const guardBefore = lstatSync(guardPath(root));
    ensureCloudWorkspaceBinding(root);
    assert.deepEqual(writerSnapshot(root), before, 'later admissions must not create a new generation');
    assert.equal(readFileSync(markerPath(root), 'utf8'), markerBefore);
    assert.equal(lstatSync(guardPath(root)).ino, guardBefore.ino, 'the persistent writer guard must not be replaced');
    assert.equal(readFileSync(source, 'utf8'), 'existing cloud project\n');
    assert.equal(readFileSync(gitConfig, 'utf8'), '[core]\n\tbare = false\n');
    if (process.platform !== 'win32') {
      for (const file of [markerPath(root), capabilityPath(root), generationPath(root), guardPath(root)]) assert.equal(lstatSync(file).mode & 0o077, 0);
    }
  });
});

test('initial binding keeps its metadata out of real Git status and retains user exclude rules', () => {
  fixture(root => {
    execFileSync('git', ['init', '--quiet', root]);
    const exclude = path.join(root, '.git', 'info', 'exclude');
    const userExclude = '# personal excludes\nuser-cache/\n';
    writeFileSync(exclude, userExclude);
    mkdirSync(path.join(root, 'user-cache')); writeFileSync(path.join(root, 'user-cache', 'cached.txt'), 'cache');
    writeFileSync(path.join(root, 'app.ts'), 'export const ready = true;\n');
    ensureCloudWorkspaceBinding(root);
    json(path.join(root, '.chisa-session.json'), { sessionId: 'retained-session' });
    const status = execFileSync('git', ['-C', root, '-c', 'safe.directory=' + root, 'status', '--porcelain=v1', '--untracked-files=all'], { encoding: 'utf8' });
    assert.match(status, /\?\? app\.ts/);
    assert.doesNotMatch(status, /\.chisa-(?:bridge|session)\.json|user-cache/);
    assert.equal(readFileSync(exclude, 'utf8').startsWith(userExclude), true);
    const rules = readFileSync(exclude, 'utf8').split(/\r?\n/);
    assert.equal(rules.filter(rule => rule === '/.chisa-bridge.json').length, 1);
    assert.equal(rules.filter(rule => rule === '/.chisa-session.json').length, 1);
    const before = readFileSync(exclude, 'utf8');
    ensureCloudWorkspaceBinding(root);
    assert.equal(readFileSync(exclude, 'utf8'), before, 'reopening cannot append duplicate exclusion rules');
  });
});

test('Git initialized after binding gets missing excludes on reopen without changing epoch or user rules', () => {
  fixture(root => {
    ensureCloudWorkspaceBinding(root);
    const markerBefore = readFileSync(markerPath(root), 'utf8');
    const writerBefore = writerSnapshot(root);
    execFileSync('git', ['init', '--quiet', root]);
    const exclude = path.join(root, '.git', 'info', 'exclude');
    const userExclude = '# keep my CRLF rules\r\n*.scratch\r\n/.chisa-bridge.json\r\n';
    writeFileSync(exclude, userExclude);
    writeFileSync(path.join(root, 'personal.scratch'), 'ignored');
    writeFileSync(path.join(root, 'app.ts'), 'export const ready = true;\n');
    json(path.join(root, '.chisa-session.json'), { sessionId: 'retained-session' });
    const before = execFileSync('git', ['-C', root, '-c', 'safe.directory=' + root, 'status', '--porcelain=v1', '--untracked-files=all'], { encoding: 'utf8' });
    assert.match(before, /\.chisa-session\.json/);
    ensureCloudWorkspaceBinding(root);
    const after = execFileSync('git', ['-C', root, '-c', 'safe.directory=' + root, 'status', '--porcelain=v1', '--untracked-files=all'], { encoding: 'utf8' });
    assert.match(after, /\?\? app\.ts/);
    assert.doesNotMatch(after, /\.chisa-(?:bridge|session)\.json|personal\.scratch/);
    const retained = readFileSync(exclude, 'utf8');
    assert.equal(retained.startsWith(userExclude), true);
    assert.equal(retained.split(/\r?\n/).filter(rule => rule === '/.chisa-bridge.json').length, 1);
    assert.equal(retained.split(/\r?\n/).filter(rule => rule === '/.chisa-session.json').length, 1);
    assert.equal(readFileSync(markerPath(root), 'utf8'), markerBefore);
    assert.deepEqual(writerSnapshot(root), writerBefore);
  });
});

test('legacy protocol 2 takeover retains its exact epoch and existing session metadata', () => {
  fixture(root => {
    legacyMarker(root);
    const session = path.join(root, '.chisa-session.json');
    json(session, { sourceRoot: root, bindingEpoch: legacyEpoch, sessionId: 'retained-session' });
    const sessionBefore = readFileSync(session, 'utf8');
    ensureCloudWorkspaceBinding(root);
    assert.deepEqual(read(markerPath(root)), { protocol: 3, root, owner: identity!.owner, bindingEpoch: legacyEpoch });
    assert.equal(read(capabilityPath(root)).bindingEpoch, legacyEpoch);
    assert.equal(readFileSync(session, 'utf8'), sessionBefore);
    assert.equal(readdirSync(root).some(name => name.startsWith('.chisa-bridge.json.') && name.endsWith('.tmp')), false);
  });
});

test('legacy writer gate capability and complete generation survive migration byte for byte', () => {
  fixture(root => {
    legacyMarker(root);
    writerMetadata(root, { protocol: 'chisa-writer-gate-v1', engineVersion: '0.18.1-chisa.5' }, { writer: 'mutagen' });
    const before = writerSnapshot(root);
    ensureCloudWorkspaceBinding(root);
    assert.equal(read(markerPath(root)).protocol, 3);
    assert.equal(read(markerPath(root)).bindingEpoch, legacyEpoch);
    assert.deepEqual(writerSnapshot(root), before);
  });
});

test('isolated worktree takeover retains the session binding and does not enroll a source writer gate', () => {
  fixture(root => {
    legacyMarker(root, { execution: 'isolated-worktree', sessionId: 'retained-isolated-session' });
    ensureCloudWorkspaceBinding(root);
    assert.deepEqual(read(markerPath(root)), {
      protocol: 3, root, owner: identity!.owner, bindingEpoch: legacyEpoch,
      execution: 'isolated-worktree', sessionId: 'retained-isolated-session',
    });
    noWriterMetadata(root);
    ensureCloudWorkspaceBinding(root);
    noWriterMetadata(root);
  });
});

test('nested directories inherit an existing project binding without creating another marker or writer state', () => {
  for (const protocol of [2, 3]) fixture(root => {
    if (protocol === 2) legacyMarker(root); else { cloudMarker(root); writerMetadata(root); }
    const markerBefore = readFileSync(markerPath(root), 'utf8');
    const nested = path.join(root, 'src', 'deep'); mkdirSync(nested, { recursive: true });
    ensureCloudWorkspaceBinding(nested);
    assert.equal(existsSync(markerPath(nested)), false);
    noWriterMetadata(nested); noWriterMetadata(path.dirname(nested));
    assert.equal(readFileSync(markerPath(root), 'utf8'), markerBefore);
  });
});

test('an unregistered Windows host directory is untouched even when missing or carrying legacy metadata', () => {
  fixture((root, account) => {
    legacyMarker(root, { protocol: 1 }); identity = undefined;
    const before = readFileSync(markerPath(root), 'utf8');
    runtimeHost('win32', account, () => {
      ensureCloudWorkspaceBinding(root);
      ensureCloudWorkspaceBinding(path.join(root, 'does-not-exist'));
    });
    assert.equal(readFileSync(markerPath(root), 'utf8'), before);
    noWriterMetadata(root);
  });
});

test('Linux cloud admission without a verified runtime rejects rather than falling back to the host filesystem', () => {
  for (const protocol of [0, 2, 3]) fixture((root, account) => {
    if (protocol === 2) legacyMarker(root); else if (protocol === 3) cloudMarker(root);
    const markerBefore = protocol ? readFileSync(markerPath(root), 'utf8') : undefined;
    identity = undefined;
    runtimeHost('linux', account, () => {
      for (const candidate of [root, path.join(root, 'does-not-exist')]) {
        assert.throws(() => ensureCloudWorkspaceBinding(candidate), { code: 'WORKSPACE_RUNTIME_UNAVAILABLE', statusCode: 503 });
      }
    });
    assert.equal(existsSync(markerPath(root)), protocol !== 0);
    if (protocol) assert.equal(readFileSync(markerPath(root), 'utf8'), markerBefore);
    noWriterMetadata(root);
  });
});

test('an unconfigured Linux host leaves unregistered directories untouched', () => {
  fixture(root => {
    legacyMarker(root, { protocol: 1 }); identity = undefined;
    const before = readFileSync(markerPath(root), 'utf8');
    runtimeHost('linux', undefined, () => ensureCloudWorkspaceBinding(root));
    assert.equal(readFileSync(markerPath(root), 'utf8'), before);
    noWriterMetadata(root);
  });
});

test('the account root, a neighboring account path and a directory alias cannot acquire cloud project markers', () => {
  fixture((root, account, parent) => {
    const neighbor = path.join(parent, 'account-neighbor'); mkdirSync(neighbor);
    assert.throws(() => ensureCloudWorkspaceBinding(account), mismatch);
    assert.throws(() => ensureCloudWorkspaceBinding(neighbor), mismatch);
    const alias = path.join(account, 'alias');
    symlinkSync(root, alias, process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => ensureCloudWorkspaceBinding(alias), mismatch);
    assert.equal(existsSync(markerPath(root)), false);
    assert.equal(existsSync(markerPath(account)), false);
    assert.equal(existsSync(markerPath(neighbor)), false);
    noWriterMetadata(root);
  });
});

test('legacy desktop markers, unsupported protocols and empty legacy epochs are retained for explicit recovery', () => {
  for (const marker of [
    { protocol: 1, bindingEpoch: legacyEpoch }, { protocol: 4, bindingEpoch: legacyEpoch },
    { protocol: 2, bindingEpoch: '' }, { protocol: 2, bindingEpoch: 42 }, {},
  ]) fixture(root => {
    json(markerPath(root), marker);
    const before = readFileSync(markerPath(root), 'utf8');
    assert.throws(() => ensureCloudWorkspaceBinding(root), { code: 'LOCAL_WORKSPACE_REMOVED', statusCode: 409 });
    assert.equal(readFileSync(markerPath(root), 'utf8'), before);
    noWriterMetadata(root);
  });
});

test('foreign cloud owners, roots and invalid epochs are rejected before writer state is created', () => {
  for (const change of [{ owner: 'foreign' }, { root: 'foreign' }, { bindingEpoch: '' }, { bindingEpoch: 42 }]) fixture(root => {
    cloudMarker(root, change);
    const before = readFileSync(markerPath(root), 'utf8');
    assert.throws(() => ensureCloudWorkspaceBinding(root), mismatch);
    assert.equal(readFileSync(markerPath(root), 'utf8'), before);
    noWriterMetadata(root);
  });
});

test('lease and integration recovery barriers prevent both new enrollment and legacy takeover without deleting state', () => {
  for (const legacy of [false, true]) for (const barrier of ['lease', 'integration']) fixture(root => {
    if (legacy) legacyMarker(root);
    const markerBefore = legacy ? readFileSync(markerPath(root), 'utf8') : undefined;
    const file = root + (barrier === 'lease' ? '.chisa-lease' : '.chisa-integration.json');
    if (barrier === 'lease') { mkdirSync(file); json(path.join(file, 'owner.json'), { id: 'pending-writer' }); }
    else json(file, { operationId: 'pending-integration' });
    assert.throws(() => ensureCloudWorkspaceBinding(root), recoveryRequired);
    assert.equal(existsSync(file), true);
    assert.equal(existsSync(markerPath(root)), legacy);
    if (legacy) assert.equal(readFileSync(markerPath(root), 'utf8'), markerBefore);
    noWriterMetadata(root);
  });
});

test('dirty, foreign and stale legacy generations cannot be adopted or overwritten', () => {
  for (const change of [{ state: 'dirty' }, { root: 'foreign' }, { bindingEpoch: 'stale-epoch' }]) fixture(root => {
    legacyMarker(root); writerMetadata(root, {}, change);
    const markerBefore = readFileSync(markerPath(root), 'utf8');
    const before = writerSnapshot(root);
    assert.throws(() => ensureCloudWorkspaceBinding(root), recoveryRequired);
    assert.equal(readFileSync(markerPath(root), 'utf8'), markerBefore);
    assert.deepEqual(writerSnapshot(root), before);
  });
});

test('an owned cloud marker with no writer state safely initializes once without replacing the marker', () => {
  fixture(root => {
    cloudMarker(root);
    const before = readFileSync(markerPath(root), 'utf8');
    ensureCloudWorkspaceBinding(root);
    assert.equal(readFileSync(markerPath(root), 'utf8'), before);
    assert.equal(read(capabilityPath(root)).bindingEpoch, legacyEpoch);
    assert.equal(read(generationPath(root)).state, 'complete');
    assert.equal(existsSync(guardPath(root)), true);
  });
});

test('partial writer enrollment fails closed and preserves every surviving file', () => {
  for (const absent of ['capability', 'generation', 'guard']) fixture((root, _account, parent) => {
    cloudMarker(root); writerMetadata(root);
    const files = { capability: capabilityPath(root), generation: generationPath(root), guard: guardPath(root) };
    removeFixture(files[absent as keyof typeof files], parent);
    const survivors = Object.values(files).filter(file => existsSync(file)).map(file => [file, readFileSync(file, 'utf8')] as const);
    assert.throws(() => ensureCloudWorkspaceBinding(root), recoveryRequired);
    assert.equal(existsSync(files[absent as keyof typeof files]), false);
    for (const [file, contents] of survivors) assert.equal(readFileSync(file, 'utf8'), contents);
    assert.equal(read(markerPath(root)).bindingEpoch, legacyEpoch);
  });
});

test('foreign writer capabilities are not replaced during fresh, legacy or cloud admission', () => {
  for (const protocol of [0, 2, 3]) for (const change of [
    { version: 2 }, { root: 'foreign' }, { bindingEpoch: 'foreign' }, { protocol: 'foreign-writer' },
  ]) fixture(root => {
    if (protocol === 2) legacyMarker(root); else if (protocol === 3) cloudMarker(root);
    writerMetadata(root, change);
    // Fresh enrollment has no prior binding; omit its generation epoch so the
    // capability check, rather than legacy-generation validation, rejects it.
    if (protocol === 0) { const generation = read(generationPath(root)); delete generation.bindingEpoch; json(generationPath(root), generation); }
    const before = writerSnapshot(root);
    const markerBefore = protocol ? readFileSync(markerPath(root), 'utf8') : undefined;
    assert.throws(() => ensureCloudWorkspaceBinding(root), mismatch);
    assert.deepEqual(writerSnapshot(root), before);
    assert.equal(existsSync(markerPath(root)), protocol !== 0);
    if (protocol) assert.equal(readFileSync(markerPath(root), 'utf8'), markerBefore);
  });
});

test('an existing cloud capability cannot hide damaged or foreign generation metadata', () => {
  for (const change of [
    { version: 2 }, { root: 'foreign' }, { bindingEpoch: 'foreign' }, { state: 'unknown' },
    { writer: 'foreign' }, { generation: 'short' }, { updatedAt: 'invalid-date' },
  ]) fixture(root => {
    cloudMarker(root); writerMetadata(root, {}, change);
    const before = writerSnapshot(root);
    const markerBefore = readFileSync(markerPath(root), 'utf8');
    assert.throws(() => ensureCloudWorkspaceBinding(root), recoveryRequired);
    assert.deepEqual(writerSnapshot(root), before);
    assert.equal(readFileSync(markerPath(root), 'utf8'), markerBefore);
  });
});

test('a writer guard replaced by a directory or hardlink is rejected without replacing surviving metadata', () => {
  for (const kind of ['directory', 'hardlink']) fixture((root, _account, parent) => {
    cloudMarker(root); writerMetadata(root);
    const before = [readFileSync(capabilityPath(root), 'utf8'), readFileSync(generationPath(root), 'utf8')];
    if (kind === 'directory') { removeFixture(guardPath(root), parent); mkdirSync(guardPath(root)); }
    else linkSync(guardPath(root), path.join(parent, 'retained-guard'));
    const guardBefore = lstatSync(guardPath(root));
    assert.throws(() => ensureCloudWorkspaceBinding(root), recoveryRequired);
    assert.deepEqual([readFileSync(capabilityPath(root), 'utf8'), readFileSync(generationPath(root), 'utf8')], before);
    assert.equal(lstatSync(guardPath(root)).ino, guardBefore.ino);
    assert.equal(lstatSync(guardPath(root)).isDirectory(), kind === 'directory');
  });
});

test('an active cloud generation and lease retain their exact identity on later admissions', () => {
  fixture(root => {
    cloudMarker(root); writerMetadata(root, {}, { state: 'dirty', leaseId: 'active-cloud-writer' });
    const lease = root + '.chisa-lease'; mkdirSync(lease);
    json(path.join(lease, 'owner.json'), { id: 'active-cloud-writer', epoch: legacyEpoch });
    const before = writerSnapshot(root);
    ensureCloudWorkspaceBinding(root);
    assert.deepEqual(writerSnapshot(root), before, 'admission cannot mark an active write complete');
    assert.equal(read(path.join(lease, 'owner.json')).id, 'active-cloud-writer');
  });
});

test('malformed metadata and hardlinked markers cannot be silently replaced', () => {
  for (const value of ['{broken', 'null', '[]', '7', '"text"']) fixture(root => {
    writeFileSync(markerPath(root), value, { mode: 0o600 });
    assert.throws(() => ensureCloudWorkspaceBinding(root));
    assert.equal(readFileSync(markerPath(root), 'utf8'), value);
    noWriterMetadata(root);
  });
  fixture((root, _account, parent) => {
    legacyMarker(root);
    const retained = path.join(parent, 'retained-marker'); linkSync(markerPath(root), retained);
    const before = readFileSync(retained, 'utf8');
    assert.throws(() => ensureCloudWorkspaceBinding(root), mismatch);
    assert.equal(readFileSync(retained, 'utf8'), before);
    assert.equal(readFileSync(markerPath(root), 'utf8'), before);
    noWriterMetadata(root);
  });
});

test('oversized metadata and group-writable markers are rejected before enrollment', () => {
  fixture(root => {
    legacyMarker(root, { padding: 'x'.repeat(65_536) });
    const before = readFileSync(markerPath(root), 'utf8');
    assert.throws(() => ensureCloudWorkspaceBinding(root), mismatch);
    assert.equal(readFileSync(markerPath(root), 'utf8'), before);
    noWriterMetadata(root);
  });
  if (process.platform !== 'win32') fixture(root => {
    legacyMarker(root); chmodSync(markerPath(root), 0o660);
    assert.throws(() => ensureCloudWorkspaceBinding(root), mismatch);
    noWriterMetadata(root);
  });
});
