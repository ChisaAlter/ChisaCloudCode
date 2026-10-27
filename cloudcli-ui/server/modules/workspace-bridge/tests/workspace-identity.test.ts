import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import fs, { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test, { mock } from 'node:test';

import { ensureReplicaIdentity, readSessionIdentity, recordSessionIdentity, setSessionPublication } from '../workspace-identity.service.js';

const changed = { code: 'WORKSPACE_IDENTITY_CHANGED', statusCode: 409 };
function json(file: string, value: unknown): void { writeFileSync(file, JSON.stringify(value), { mode: 0o600 }); }
function read(file: string): Record<string, unknown> { return JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>; }
function state(root: string): string { return path.join(root + '.chisa-state', 'replica.json'); }
function session(root: string, id: string): string { return path.join(root + '.chisa-state', 'session-' + createHash('sha256').update(id).digest('hex') + '.json'); }
function input(root: string, id = 'session-1', bindingEpoch = 'epoch-1') { return { sourceRoot: root, executionRoot: root, sessionId: id, bindingEpoch, requestedMode: 'shared' as const, effectiveMode: 'shared' as const }; }
function bind(root: string, bindingEpoch: string): void { json(path.join(root, '.chisa-bridge.json'), { bindingEpoch }); }
function fixture(run: (root: string, parent: string) => void, bound = true): void {
  const parent = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'chisa-identity-')));
  const root = path.join(parent, 'project');
  mkdirSync(root);
  if (bound) bind(root, 'epoch-1');
  try { run(root, parent); }
  finally { assert.equal(path.dirname(root), parent); rmSync(parent, { recursive: true, force: true }); }
}
function unlinkFixture(file: string, root: string): void {
  assert.ok(file.startsWith(path.dirname(root) + path.sep));
  rmSync(file, { recursive: true, force: true });
}

test('replica identity persists independently while multiple shared sessions retain distinct exact generations', () => {
  fixture(root => {
    const replica = ensureReplicaIdentity(root, 'epoch-1');
    assert.deepEqual(ensureReplicaIdentity(root, 'epoch-1'), replica);
    const first = recordSessionIdentity(input(root, 'first'));
    const second = recordSessionIdentity(input(root, 'second'));
    assert.notEqual(first.workspaceId, second.workspaceId);
    assert.notEqual(first.generation, second.generation);
    assert.equal(first.sourceReplicaId, replica.workspaceId);
    assert.equal(second.sourceGeneration, replica.generation);
    assert.deepEqual(recordSessionIdentity(input(root, 'first')), first);
    assert.deepEqual(readSessionIdentity(root, root, 'first', 'epoch-1'), first);
    assert.deepEqual(readSessionIdentity(root, root, 'second', 'epoch-1'), second);
    assert.equal(readSessionIdentity(root, root, 'missing', 'epoch-1'), null);
    assert.equal(existsSync(path.join(root + '.chisa-state', 'identity.lock')), false);
  });
});

test('current binding controls rebind rotation and stale callers cannot rotate it backwards', () => {
  fixture(root => {
    mkdirSync(path.join(root, '.git'));
    const original = ensureReplicaIdentity(root, 'epoch-1');
    const oldSession = recordSessionIdentity(input(root));
    bind(root, 'epoch-2');
    assert.throws(() => ensureReplicaIdentity(root, 'epoch-1'), changed);
    const rebound = ensureReplicaIdentity(root, 'epoch-2');
    assert.equal(rebound.workspaceId, original.workspaceId);
    assert.equal(rebound.repositoryId, original.repositoryId);
    assert.notEqual(rebound.generation, original.generation);
    assert.equal(rebound.bindingEpoch, 'epoch-2');
    assert.throws(() => readSessionIdentity(root, root, oldSession.sessionId, 'epoch-2'), changed);
    assert.throws(() => recordSessionIdentity(input(root, oldSession.sessionId, 'epoch-2')), changed);
    assert.throws(() => setSessionPublication(root, root, oldSession.sessionId, 'epoch-2', oldSession.generation, 'integrated'), changed);
    assert.throws(() => ensureReplicaIdentity(root, 'epoch-1'), changed);
    assert.deepEqual(ensureReplicaIdentity(root, 'epoch-2'), rebound);
    assert.equal(recordSessionIdentity(input(root, 'new-session', 'epoch-2')).sourceGeneration, rebound.generation);
  });
});

test('bridge-less projects use exact unbound sentinel and malformed or dangling markers never downgrade', () => {
  fixture(root => {
    const unbound = ensureReplicaIdentity(root, 'unbound');
    const old = recordSessionIdentity(input(root, 'unbound-session', 'unbound'));
    assert.equal(old.sourceGeneration, unbound.generation);
    assert.throws(() => ensureReplicaIdentity(root, 'epoch-1'), changed);
    bind(root, 'epoch-1');
    assert.throws(() => ensureReplicaIdentity(root, 'unbound'), changed);
    const bound = ensureReplicaIdentity(root, 'epoch-1');
    assert.notEqual(bound.generation, unbound.generation);
    assert.throws(() => readSessionIdentity(root, root, old.sessionId, 'epoch-1'), changed);
    unlinkFixture(path.join(root, '.chisa-bridge.json'), root);
    assert.notEqual(ensureReplicaIdentity(root, 'unbound').generation, bound.generation);
  }, false);
  for (const value of [null, [], {}, { bindingEpoch: '' }, { bindingEpoch: 'unbound' }]) fixture(root => {
    json(path.join(root, '.chisa-bridge.json'), value);
    assert.throws(() => ensureReplicaIdentity(root, 'unbound'), changed);
  }, false);
});

test('first repository initialization rotates generation and repository ID while old sessions stay stale', () => {
  fixture(root => {
    const original = ensureReplicaIdentity(root, 'epoch-1');
    const oldSession = recordSessionIdentity(input(root));
    assert.equal(original.gitStamp, null);
    mkdirSync(path.join(root, '.git'));
    const initialized = ensureReplicaIdentity(root, 'epoch-1');
    assert.equal(initialized.workspaceId, original.workspaceId);
    assert.notEqual(initialized.repositoryId, original.repositoryId);
    assert.notEqual(initialized.generation, original.generation);
    assert.notEqual(initialized.gitStamp, null);
    assert.deepEqual(ensureReplicaIdentity(root, 'epoch-1'), initialized);
    assert.throws(() => recordSessionIdentity(input(root)), changed);
    assert.throws(() => setSessionPublication(root, root, oldSession.sessionId, 'epoch-1', oldSession.generation, 'integrated'), changed);
    assert.equal(recordSessionIdentity(input(root, 'after-init')).sourceRepositoryId, initialized.repositoryId);
  });
});

test('directory replacement, existing repository replacement and repository removal never renew old identities', () => {
  for (const replacement of ['root', 'git', 'remove-git']) fixture((root, parent) => {
    const git = path.join(root, '.git');
    mkdirSync(git);
    const original = ensureReplicaIdentity(root, 'epoch-1');
    if (replacement === 'root') {
      const retired = path.join(parent, 'retired');
      assert.equal(path.dirname(root), parent);
      renameSync(root, retired);
      mkdirSync(root); bind(root, 'epoch-1'); mkdirSync(path.join(root, '.git'));
    } else {
      const retired = path.join(root, '.git-retired');
      assert.equal(path.dirname(git), root);
      renameSync(git, retired);
      if (replacement === 'git') mkdirSync(git);
    }
    assert.throws(() => ensureReplicaIdentity(root, 'epoch-1'), changed);
    assert.equal(read(state(root)).generation, original.generation);
  });
});

test('linked gitdir content and common repository targets participate in repository identity', () => {
  fixture((root, parent) => {
    const firstGit = path.join(parent, 'git-a'); const secondGit = path.join(parent, 'git-b');
    mkdirSync(firstGit); mkdirSync(secondGit);
    const file = path.join(root, '.git');
    writeFileSync(file, 'gitdir: ' + firstGit + '\n', { mode: 0o600 });
    ensureReplicaIdentity(root, 'epoch-1');
    writeFileSync(file, 'gitdir: ' + secondGit + '\n');
    assert.throws(() => ensureReplicaIdentity(root, 'epoch-1'), changed);
  });
  fixture((root, parent) => {
    const git = path.join(parent, 'git'); const commonA = path.join(parent, 'common-a'); const commonB = path.join(parent, 'common-b');
    mkdirSync(git); mkdirSync(commonA); mkdirSync(commonB);
    writeFileSync(path.join(root, '.git'), 'gitdir: ' + git + '\n', { mode: 0o600 });
    writeFileSync(path.join(git, 'commondir'), '../common-a\n', { mode: 0o600 });
    ensureReplicaIdentity(root, 'epoch-1');
    writeFileSync(path.join(git, 'commondir'), '../common-b\n');
    assert.throws(() => ensureReplicaIdentity(root, 'epoch-1'), changed);
  });
});

test('session execution repository, mode and baseline are immutable independently of its source', () => {
  fixture((root, parent) => {
    mkdirSync(path.join(root, '.git'));
    const execution = path.join(parent, 'execution'); mkdirSync(execution); mkdirSync(path.join(execution, '.git'));
    const request = { ...input(root), executionRoot: execution, requestedMode: 'isolated' as const, effectiveMode: 'isolated' as const, baselineId: 'baseline-1' };
    const recorded = recordSessionIdentity(request);
    assert.deepEqual(readSessionIdentity(root, execution, request.sessionId, 'epoch-1'), recorded);
    assert.throws(() => recordSessionIdentity({ ...request, baselineId: 'baseline-2' }), changed);
    assert.throws(() => recordSessionIdentity({ ...request, effectiveMode: 'shared' }), changed);
    const git = path.join(execution, '.git'); assert.equal(path.dirname(git), execution);
    renameSync(git, path.join(execution, '.git-retired')); mkdirSync(git);
    assert.throws(() => readSessionIdentity(root, execution, request.sessionId, 'epoch-1'), changed);
  });
  fixture((root, parent) => {
    const execution = path.join(parent, 'execution'); mkdirSync(execution);
    assert.throws(() => recordSessionIdentity({ ...input(root), executionRoot: execution }), changed);
    assert.throws(() => recordSessionIdentity({ ...input(root), effectiveMode: 'isolated' }), changed);
    assert.equal(recordSessionIdentity({ ...input(root), requestedMode: 'isolated' }).effectiveMode, 'shared');
  });
});

test('publication compares exact session generation, preserves other shared sessions and cannot downgrade integrated state', () => {
  fixture(root => {
    const first = recordSessionIdentity(input(root, 'first')); const second = recordSessionIdentity(input(root, 'second'));
    assert.throws(() => setSessionPublication(root, root, 'first', 'epoch-1', randomUUID(), 'integrated'), changed);
    setSessionPublication(root, root, 'first', 'epoch-1', first.generation, 'conflicted');
    assert.equal(readSessionIdentity(root, root, 'first', 'epoch-1')?.publicationState, 'conflicted');
    setSessionPublication(root, root, 'first', 'epoch-1', first.generation, 'integrated');
    setSessionPublication(root, root, 'first', 'epoch-1', first.generation, 'integrated');
    assert.throws(() => setSessionPublication(root, root, 'first', 'epoch-1', first.generation, 'unpublished'), changed);
    assert.deepEqual(readSessionIdentity(root, root, 'second', 'epoch-1'), second);
    const file = session(root, 'first'); json(file, { ...read(file), generation: randomUUID(), publicationState: 'unpublished' });
    assert.throws(() => setSessionPublication(root, root, 'first', 'epoch-1', first.generation, 'integrated'), changed);
  });
});

test('malformed replica and session records are rejected without replacing their bytes', () => {
  for (const replace of [null, [], {}, { workspaceId: 42 }, { generation: true }, { repositoryId: {} }, { bindingEpoch: null }, { gitStamp: 12 }, { version: 2 }]) fixture(root => {
    ensureReplicaIdentity(root, 'epoch-1');
    const file = state(root);
    json(file, replace && !Array.isArray(replace) && Object.keys(replace).length ? { ...read(file), ...replace } : replace);
    const raw = readFileSync(file, 'utf8');
    assert.throws(() => ensureReplicaIdentity(root, 'epoch-1'), changed);
    assert.equal(readFileSync(file, 'utf8'), raw);
  });
  for (const replace of [null, [], {}, { workspaceId: 1 }, { generation: true }, { publicationState: 'unknown' }, { baselineId: [] }, { sourceRepositoryId: randomUUID() }, { effectiveMode: 'isolated' }, { gitStamp: {} }]) fixture(root => {
    recordSessionIdentity(input(root));
    const file = session(root, 'session-1');
    json(file, replace && !Array.isArray(replace) && Object.keys(replace).length ? { ...read(file), ...replace } : replace);
    const raw = readFileSync(file, 'utf8');
    assert.throws(() => readSessionIdentity(root, root, 'session-1', 'epoch-1'), changed);
    assert.equal(readFileSync(file, 'utf8'), raw);
  });
  fixture(root => {
    ensureReplicaIdentity(root, 'epoch-1'); writeFileSync(state(root), '{invalid-json');
    assert.throws(() => ensureReplicaIdentity(root, 'epoch-1'), changed);
  });
});

test('hardlinked metadata and uncertain update locks fail closed without changing identities', () => {
  for (const target of ['replica', 'session', 'bridge']) fixture((root, parent) => {
    recordSessionIdentity(input(root));
    const file = target === 'replica' ? state(root) : target === 'session' ? session(root, 'session-1') : path.join(root, '.chisa-bridge.json');
    linkSync(file, path.join(parent, 'external-link'));
    assert.throws(() => target === 'session' ? readSessionIdentity(root, root, 'session-1', 'epoch-1') : ensureReplicaIdentity(root, 'epoch-1'), changed);
  });
  fixture(root => {
    const original = ensureReplicaIdentity(root, 'epoch-1');
    const lock = path.join(root + '.chisa-state', 'identity.lock');
    writeFileSync(lock, 'unconfirmed prior writer', { mode: 0o600 });
    assert.throws(() => ensureReplicaIdentity(root, 'epoch-1'), { code: 'WORKSPACE_BUSY' });
    assert.equal(readFileSync(lock, 'utf8'), 'unconfirmed prior writer');
    assert.equal(read(state(root)).generation, original.generation);
    unlinkFixture(lock, root);
    assert.deepEqual(ensureReplicaIdentity(root, 'epoch-1'), original);
  });
});

test('metadata commit compares disk state and rechecks binding after temporary persistence', () => {
  for (const target of ['record', 'binding']) fixture(root => {
    const first = recordSessionIdentity(input(root));
    const file = session(root, first.sessionId);
    const replacementGeneration = randomUUID();
    const originalOpen = fs.openSync; const originalFsync = fs.fsyncSync;
    let temporary: number | undefined;
    let injected = false;
    const opened = mock.method(fs, 'openSync', (...args: Parameters<typeof fs.openSync>) => {
      const fd = originalOpen(...args);
      if (String(args[0]).startsWith(file + '.') && String(args[0]).endsWith('.tmp')) temporary = fd;
      return fd;
    });
    const synced = mock.method(fs, 'fsyncSync', (fd: number) => {
      originalFsync(fd);
      if (fd === temporary && !injected) {
        injected = true;
        if (target === 'record') json(file, { ...read(file), generation: replacementGeneration });
        else bind(root, 'epoch-2');
      }
    });
    syncBuiltinESMExports();
    try { assert.throws(() => setSessionPublication(root, root, first.sessionId, 'epoch-1', first.generation, 'integrated'), changed); }
    finally { opened.mock.restore(); synced.mock.restore(); syncBuiltinESMExports(); }
    assert.equal(injected, true);
    assert.equal(read(file).publicationState, 'unpublished');
    assert.equal(read(file).generation, target === 'record' ? replacementGeneration : first.generation);
  });
});

test('rebind commit cannot replace a newer generation or an epoch changed during persistence', () => {
  for (const target of ['record', 'binding']) fixture(root => {
    const original = ensureReplicaIdentity(root, 'epoch-1');
    bind(root, 'epoch-2');
    const file = state(root);
    const nextGeneration = randomUUID();
    const originalOpen = fs.openSync; const originalFsync = fs.fsyncSync;
    let temporary: number | undefined;
    let injected = false;
    const opened = mock.method(fs, 'openSync', (...args: Parameters<typeof fs.openSync>) => {
      const fd = originalOpen(...args);
      if (String(args[0]).startsWith(file + '.') && String(args[0]).endsWith('.tmp')) temporary = fd;
      return fd;
    });
    const synced = mock.method(fs, 'fsyncSync', (fd: number) => {
      originalFsync(fd);
      if (fd === temporary && !injected) {
        injected = true;
        if (target === 'record') json(file, { ...original, generation: nextGeneration, bindingEpoch: 'epoch-2' });
        else bind(root, 'epoch-3');
      }
    });
    syncBuiltinESMExports();
    try { assert.throws(() => ensureReplicaIdentity(root, 'epoch-2'), changed); }
    finally { opened.mock.restore(); synced.mock.restore(); syncBuiltinESMExports(); }
    assert.equal(injected, true);
    assert.equal(read(file).generation, target === 'record' ? nextGeneration : original.generation);
    assert.equal(read(file).bindingEpoch, target === 'record' ? 'epoch-2' : 'epoch-1');
  });
});

test('changes metadata may precede replica enrollment without impersonating identity remnants', () => {
  fixture(root => {
    const directory = root + '.chisa-state';
    mkdirSync(directory, { mode: 0o700 }); mkdirSync(path.join(directory, 'changes'), { mode: 0o700 });
    const replica = ensureReplicaIdentity(root, 'epoch-1');
    assert.ok(replica.workspaceId);
    assert.equal(existsSync(path.join(directory, 'changes')), true);
  });
});

test('missing replica metadata with recorded sessions requires recovery and does not mint a replacement', () => {
  fixture(root => {
    recordSessionIdentity(input(root));
    unlinkFixture(state(root), root);
    assert.throws(() => ensureReplicaIdentity(root, 'epoch-1'), changed);
    assert.equal(existsSync(state(root)), false);
    assert.equal(existsSync(session(root, 'session-1')), true);
  });
});

test('directory junction aliases and identity storage redirection are rejected', () => {
  fixture((root, parent) => {
    ensureReplicaIdentity(root, 'epoch-1');
    const alias = path.join(parent, 'alias');
    symlinkSync(root, alias, process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => ensureReplicaIdentity(alias, 'epoch-1'), changed);
  });
  fixture((root, parent) => {
    const realStorage = path.join(parent, 'redirect'); mkdirSync(realStorage);
    symlinkSync(realStorage, root + '.chisa-state', process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => ensureReplicaIdentity(root, 'epoch-1'), changed);
  });
});

test('Linux dangling symlinks, Git symlinks and writable metadata cannot impersonate absence', { skip: process.platform !== 'linux' }, () => {
  for (const target of ['bridge', 'replica', 'session', 'git']) fixture((root, parent) => {
    recordSessionIdentity(input(root));
    const file = target === 'bridge' ? path.join(root, '.chisa-bridge.json') : target === 'replica' ? state(root) : target === 'session' ? session(root, 'session-1') : path.join(root, '.git');
    unlinkFixture(file, root); symlinkSync(path.join(parent, 'missing-target'), file);
    assert.throws(() => target === 'session' ? readSessionIdentity(root, root, 'session-1', 'epoch-1') : ensureReplicaIdentity(root, target === 'bridge' ? 'unbound' : 'epoch-1'), changed);
  });
  fixture(root => {
    ensureReplicaIdentity(root, 'epoch-1'); chmodSync(state(root), 0o666);
    assert.throws(() => ensureReplicaIdentity(root, 'epoch-1'), changed);
  });
});
