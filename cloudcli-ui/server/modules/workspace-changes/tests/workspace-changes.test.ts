import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs, { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test, { mock } from 'node:test';

import { createWorkspaceChangesService } from '../index.js';

type Service = ReturnType<typeof createWorkspaceChangesService>;
type CaptureInput = Parameters<Service['captureBaseline']>[0];
type Fixture = { source: string; execution: string; directory: string; input: CaptureInput; service: Service };

async function git(args: string[], cwd: string, signal?: AbortSignal, input?: Buffer) {
  return new Promise<{ code: number | null; stdout: Buffer; stderr: Buffer }>((resolve, reject) => {
    const child = spawn('git', ['--no-optional-locks', ...args], { cwd, windowsHide: true, signal, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } });
    const output: Buffer[] = []; const errors: Buffer[] = [];
    child.stdout.on('data', chunk => output.push(chunk)); child.stderr.on('data', chunk => errors.push(chunk));
    child.on('error', reject); child.on('close', code => resolve({ code, stdout: Buffer.concat(output), stderr: Buffer.concat(errors) }));
    child.stdin.on('error', () => {}); child.stdin.end(input);
  });
}
async function checked(args: string[], cwd: string) {
  const result = await git(args, cwd);
  assert.equal(result.code, 0, result.stderr.toString());
  return result.stdout.toString();
}
async function fixture(run: (value: Fixture) => Promise<void>, prepare?: (source: string) => Promise<void>) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'chisa-workspace-changes-'));
  const source = path.join(directory, 'source'); const execution = path.join(directory, 'session');
  await mkdir(source);
  try {
    await checked(['init', '-b', 'main'], source);
    await checked(['config', 'core.autocrlf', 'false'], source);
    await writeFile(path.join(source, 'alpha.txt'), 'one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\n');
    await writeFile(path.join(source, 'beta.txt'), 'beta baseline\n');
    await checked(['add', '.'], source);
    await checked(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@localhost', 'commit', '-m', 'base'], source);
    if (prepare) await prepare(source);
    // A complete copy makes a separate test repository with identical initial
    // HEAD/index/worktree state without depending on another feature module.
    await cp(source, execution, { recursive: true });
    const service = createWorkspaceChangesService();
    const input: CaptureInput = { sourceRoot: source, executionRoot: execution, sessionId: 'fixture-session', verifiedSnapshot: true, assertPinned: () => {}, withLock: async operation => operation() };
    await run({ source, execution, directory, input, service });
  } finally {
    assert.equal(path.dirname(source), directory); assert.equal(path.dirname(execution), directory);
    await rm(directory, { recursive: true, force: true });
  }
}

const preview = (value: Fixture) => value.service.preview({ ...value.input, targetRoot: value.source });
async function apply(value: Fixture, result: Awaited<ReturnType<Service['preview']>>, operationId = 'operation-1') {
  return value.service.apply({ ...value.input, targetRoot: value.source, previewId: result.previewId, expectedSourceRevision: result.sourceRevision, expectedTargetRevision: result.targetRevision, operationId });
}
function storedJson<T>(filename: string) { return JSON.parse(readFileSync(filename, 'utf8')) as T; }
function objectFiles(root: string): string[] {
  const result: string[] = [];
  function walk(directory: string) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(filename); else result.push(path.relative(root, filename));
    }
  }
  walk(root); return result.sort();
}

test('legacy sessions report unavailable; verified immutable baseline preserves staged/working/untracked bytes and Git objects', { timeout: 30_000 }, async () => {
  await fixture(async value => {
    assert.deepEqual(await value.service.inspectBaseline(value.input), { available: false, reason: 'BASELINE_UNAVAILABLE' });
    await assert.rejects(preview(value), { code: 'WORKSPACE_BASELINE_UNAVAILABLE' });
    const index = await readFile(path.join(value.execution, '.git', 'index'));
    const objects = objectFiles(path.join(value.execution, '.git', 'objects'));
    const baseline = await value.service.captureBaseline(value.input);
    const state = value.execution + '.chisa-state/changes';
    assert.equal(existsSync(path.join(value.execution, '.chisa-state')), false);
    const manifest = storedJson<{ git: { index: string; stages: { path: string; blob: string }[]; headEntries: { path: string; blob: string }[] }; entries: Record<string, { blob: string }> }>(path.join(state, 'snapshots', baseline.sourceRevision + '.json'));
    assert.deepEqual(await readFile(path.join(state, 'objects', manifest.git.index)), index);
    assert.equal(await readFile(path.join(state, 'objects', manifest.git.stages.find(entry => entry.path === 'alpha.txt')!.blob), 'utf8'), 'staged baseline\n');
    assert.equal(await readFile(path.join(state, 'objects', manifest.entries['alpha.txt']!.blob), 'utf8'), 'working baseline\n');
    assert.equal(await readFile(path.join(state, 'objects', manifest.entries['untracked.txt']!.blob), 'utf8'), 'untracked baseline\n');
    assert.ok(manifest.git.headEntries.every(entry => existsSync(path.join(state, 'objects', entry.blob))));
    assert.deepEqual(objectFiles(path.join(value.execution, '.git', 'objects')), objects);
    assert.deepEqual(await readFile(path.join(value.execution, '.git', 'index')), index);
    await writeFile(path.join(value.execution, 'alpha.txt'), 'later result\n');
    assert.deepEqual(await value.service.captureBaseline(value.input), baseline);
  }, async source => {
    await writeFile(path.join(source, 'alpha.txt'), 'staged baseline\n'); await checked(['add', 'alpha.txt'], source);
    await writeFile(path.join(source, 'alpha.txt'), 'working baseline\n'); await writeFile(path.join(source, 'untracked.txt'), 'untracked baseline\n');
  });
});

test('only B-to-A edits integrate; clean target never receives unrelated dirty baseline and index stays byte-identical', { timeout: 30_000 }, async () => {
  await fixture(async value => {
    await value.service.captureBaseline(value.input);
    await checked(['reset', '--hard', 'HEAD'], value.source);
    await writeFile(path.join(value.execution, 'beta.txt'), 'session delta\n');
    const index = await readFile(path.join(value.source, '.git', 'index'));
    const result = await preview(value);
    assert.deepEqual(result.changes.map(change => change.path), ['beta.txt']); assert.deepEqual(result.conflicts, []);
    assert.equal((await apply(value, result)).status, 'applied');
    assert.match(await readFile(path.join(value.source, 'alpha.txt'), 'utf8'), /^one\n/);
    assert.equal(await readFile(path.join(value.source, 'beta.txt'), 'utf8'), 'session delta\n');
    assert.deepEqual(await readFile(path.join(value.source, '.git', 'index')), index);
    assert.match(await checked(['diff', '--name-only'], value.source), /beta.txt/);
    assert.equal(await checked(['diff', '--cached', '--name-only'], value.source), '');
  }, async source => { await writeFile(path.join(source, 'alpha.txt'), 'existing dirty baseline\n'); });
});

test('nonoverlapping text changes merge; subsequent integration applies only the new session delta', { timeout: 30_000 }, async () => {
  await fixture(async value => {
    await value.service.captureBaseline(value.input);
    const original = await readFile(path.join(value.execution, 'alpha.txt'), 'utf8');
    await writeFile(path.join(value.execution, 'alpha.txt'), original.replace('one\n', 'session one\n'));
    await writeFile(path.join(value.source, 'alpha.txt'), original.replace('nine\n', 'target nine\n'));
    const first = await preview(value);
    assert.deepEqual(first.conflicts, []);
    assert.equal((await apply(value, first)).status, 'applied');
    const expected = original.replace('one\n', 'session one\n').replace('nine\n', 'target nine\n');
    assert.equal(await readFile(path.join(value.source, 'alpha.txt'), 'utf8'), expected);
    const second = await preview(value);
    assert.equal(second.changes.length, 0); assert.equal(second.conflicts.length, 0);
    await writeFile(path.join(value.execution, 'beta.txt'), 'second result\n');
    const third = await preview(value);
    assert.deepEqual(third.changes.map(change => change.path), ['beta.txt']);
    assert.equal((await apply(value, third, 'operation-2')).status, 'applied');
    assert.equal(await readFile(path.join(value.source, 'alpha.txt'), 'utf8'), expected);
    const retry = await apply(value, first);
    assert.equal(retry.status, 'applied');
    if (retry.status === 'applied') assert.equal(retry.replayed, true);
    await assert.rejects(apply(value, third), { code: 'WORKSPACE_CHANGES_OPERATION_REUSED' });
  });
});

for (const fault of ['temporary', 'persistent', 'changed-destination', 'changed-temporary', 'abort'] as const) {
  test(`Windows atomic journal replacement handles ${fault} replacement denial without losing recovery state`, { timeout: 40_000, skip: process.platform !== 'win32' }, async () => {
    await fixture(async value => {
      await value.service.captureBaseline(value.input);
      await writeFile(path.join(value.execution, 'alpha.txt'), 'session result\n');
      const reviewed = await preview(value);
      const operationId = 'windows-rename-' + fault;
      const state = path.join(value.execution + '.chisa-state', 'changes');
      const journal = path.join(state, 'operations', createHash('sha256').update(operationId).digest('hex') + '.json');
      const receipt = path.join(state, 'receipts', path.basename(journal));
      const index = await readFile(path.join(value.source, '.git', 'index'));
      const head = await checked(['rev-parse', 'HEAD'], value.source);
      const controller = new AbortController(); const cancellation = new Error('cancel retry');
      const originalRename = fs.renameSync;
      const tempStats = (filename: string) => {
        const stats = lstatSync(filename);
        return [stats.dev, stats.ino, stats.birthtimeMs, stats.size, stats.mtimeMs, stats.ctimeMs, stats.nlink];
      };
      let attempts = 0; let originalJournal = ''; let externalJournal = ''; let yielded = false; let completedRename = false;
      let temporary = ''; let originalTemp: number[] = []; let started = 0; let lastDenial: Error | undefined;
      let changeCompleted = Promise.resolve();
      const intercepted = mock.method(fs, 'renameSync', (...args: Parameters<typeof fs.renameSync>) => {
        if (String(args[1]) === journal && !completedRename) {
          attempts++;
          if (attempts === 1) {
            started = performance.now(); temporary = String(args[0]); originalTemp = tempStats(temporary);
            originalJournal = readFileSync(journal, 'utf8');
            assert.equal(JSON.parse(originalJournal).phase, 'prepared');
            assert.equal(JSON.parse(readFileSync(temporary, 'utf8')).phase, 'applying');
            changeCompleted = new Promise<void>((resolve, reject) => setImmediate(() => {
              try {
                yielded = true;
                if (fault === 'changed-destination') {
                  externalJournal = originalJournal + '\n';
                  fs.writeFileSync(journal, externalJournal);
                } else if (fault === 'changed-temporary') {
                  // Keep the original inode alive so replacing the path cannot
                  // accidentally reuse its identity on Windows.
                  originalRename(temporary, path.join(value.directory, 'held-temporary'));
                  fs.writeFileSync(temporary, 'external temporary replacement');
                } else if (fault === 'abort') controller.abort(cancellation);
                resolve();
              } catch (error) { reject(error); }
            }));
          } else {
            assert.equal(String(args[0]), temporary, 'retry must reuse the one closed/fsynced temporary');
            assert.deepEqual(tempStats(temporary), originalTemp, 'retry must not rewrite or replace the temporary');
            assert.equal(readFileSync(journal, 'utf8'), originalJournal, 'the existing journal must remain intact while rename is denied');
          }
          // Deny every attempt available in the former 385ms retry window.
          if (fault !== 'temporary' || attempts <= 6) {
            lastDenial = Object.assign(new Error('injected Windows replacement denial'), { code: 'EPERM', syscall: 'rename', path: String(args[0]), dest: String(args[1]) });
            throw lastDenial;
          }
          originalRename(...args); completedRename = true; return;
        }
        originalRename(...args);
      });
      syncBuiltinESMExports();
      try {
        const result = value.service.apply({ ...value.input, targetRoot: value.source, previewId: reviewed.previewId, expectedSourceRevision: reviewed.sourceRevision, expectedTargetRevision: reviewed.targetRevision, operationId, signal: controller.signal });
        if (fault === 'temporary') {
          assert.equal((await result).status, 'applied');
          assert.ok(attempts >= 7);
          assert.ok(performance.now() - started >= 700, 'contention must outlast the old 385ms window');
        } else {
          await assert.rejects(result, (error: unknown) => {
            if (fault === 'persistent') assert.equal(error, lastDenial, 'cleanup must preserve the original rename error');
            else if (fault === 'abort') { assert.equal((error as Error).name, 'AbortError'); assert.equal((error as Error).cause, cancellation); }
            else assert.equal((error as { code: string }).code, 'WORKSPACE_CHANGES_STATE_CORRUPT');
            return true;
          });
          assert.equal(attempts, fault === 'persistent' ? 9 : 1);
          assert.equal(readFileSync(journal, 'utf8'), fault === 'changed-destination' ? externalJournal : originalJournal);
          assert.equal(existsSync(receipt), false);
        }
        await changeCompleted;
      } finally { intercepted.mock.restore(); syncBuiltinESMExports(); }
      assert.equal(yielded, true, 'rename retry must yield to the event loop');
      const remaining = readdirSync(path.dirname(journal)).filter(name => name.startsWith('.write-'));
      assert.deepEqual(remaining, fault === 'changed-temporary' ? [path.basename(temporary)] : []);
      if (fault === 'changed-temporary') assert.equal(readFileSync(temporary, 'utf8'), 'external temporary replacement', 'cleanup must not delete a different file now using the temporary name');
      assert.equal(await readFile(path.join(value.source, 'alpha.txt'), 'utf8'), 'session result\n');
      assert.deepEqual(await readFile(path.join(value.source, '.git', 'index')), index);
      assert.equal(await checked(['rev-parse', 'HEAD'], value.source), head);
      const input = { ...value.input, targetRoot: value.source, operationId };
      assert.equal(value.service.inspectIntegration(input).status, fault === 'temporary' ? 'committed' : 'pending');
      if (fault !== 'temporary') assert.equal((await value.service.recover(input)).status, 'applied');
      assert.equal(value.service.inspectIntegration(input).status, 'committed');
      assert.equal(existsSync(receipt), true);
      assert.equal((await preview(value)).changes.length, 0);
      assert.deepEqual(await readFile(path.join(value.source, '.git', 'index')), index);
      assert.equal(await checked(['rev-parse', 'HEAD'], value.source), head);
    });
  });
}

for (const fault of ['write', 'fsync', 'close'] as const) {
  test(`temporary preparation ${fault} failure closes its handle and preserves recoverable journal state`, { timeout: 40_000 }, async () => {
    await fixture(async value => {
      await value.service.captureBaseline(value.input);
      await writeFile(path.join(value.execution, 'alpha.txt'), 'session result\n');
      const reviewed = await preview(value);
      const operationId = 'temporary-preparation-' + fault;
      const state = path.join(value.execution + '.chisa-state', 'changes');
      const journal = path.join(state, 'operations', createHash('sha256').update(operationId).digest('hex') + '.json');
      const receipt = path.join(state, 'receipts', path.basename(journal));
      const index = await readFile(path.join(value.source, '.git', 'index'));
      const failure = Object.assign(new Error('injected temporary ' + fault + ' failure'), { code: 'EIO' });
      const originalOpen = fs.openSync; const originalWrite = fs.writeFileSync; const originalSync = fs.fsyncSync; const originalClose = fs.closeSync;
      let temporary = ''; let temporaryFd = -1; let closed = false; let closeCalls = 0; let originalJournal = '';
      const opened = mock.method(fs, 'openSync', (...args: Parameters<typeof fs.openSync>) => {
        const fd = originalOpen(...args); const filename = String(args[0]);
        if (!temporary && args[1] === 'wx' && path.dirname(filename) === path.dirname(journal) && path.basename(filename).startsWith('.write-') && existsSync(journal)) {
          temporary = filename; temporaryFd = fd; originalJournal = readFileSync(journal, 'utf8');
        }
        return fd;
      });
      const written = mock.method(fs, 'writeFileSync', (...args: Parameters<typeof fs.writeFileSync>) => {
        if (args[0] === temporaryFd && !closed && fault === 'write') throw failure;
        originalWrite(...args);
      });
      const synced = mock.method(fs, 'fsyncSync', (fd: number) => {
        if (fd === temporaryFd && !closed && fault === 'fsync') throw failure;
        originalSync(fd);
      });
      const closedHandle = mock.method(fs, 'closeSync', (fd: number) => {
        if (fd === temporaryFd && !closed) {
          closeCalls++; originalClose(fd); closed = true;
          if (fault === 'close') throw failure;
          return;
        }
        originalClose(fd);
      });
      syncBuiltinESMExports();
      try {
        await assert.rejects(apply(value, reviewed, operationId), error => { assert.equal(error, failure); return true; });
      } finally {
        opened.mock.restore(); written.mock.restore(); synced.mock.restore(); closedHandle.mock.restore(); syncBuiltinESMExports();
        if (temporaryFd !== -1 && !closed) originalClose(temporaryFd);
      }
      assert.ok(temporary); assert.equal(closed, true); assert.equal(closeCalls, 1);
      assert.equal(existsSync(temporary), false);
      assert.equal(readdirSync(path.dirname(journal)).some(name => name.startsWith('.write-')), false);
      assert.equal(readFileSync(journal, 'utf8'), originalJournal);
      assert.equal(JSON.parse(originalJournal).phase, 'prepared'); assert.equal(existsSync(receipt), false);
      const input = { ...value.input, targetRoot: value.source, operationId };
      assert.equal(value.service.inspectIntegration(input).status, 'pending');
      assert.equal((await value.service.recover(input)).status, 'applied');
      assert.equal(value.service.inspectIntegration(input).status, 'committed');
      assert.equal(existsSync(receipt), true);
      assert.equal(await readFile(path.join(value.source, 'alpha.txt'), 'utf8'), 'session result\n');
      assert.deepEqual(await readFile(path.join(value.source, '.git', 'index')), index);
    });
  });
}

test('preview rejects changed target index, source contents, and target HEAD under caller gate', { timeout: 40_000 }, async () => {
  await fixture(async value => {
    await value.service.captureBaseline(value.input);
    await writeFile(path.join(value.execution, 'beta.txt'), 'result\n');
    let result = await preview(value);
    await writeFile(path.join(value.source, 'alpha.txt'), 'staged externally\n'); await checked(['add', 'alpha.txt'], value.source);
    await assert.rejects(apply(value, result), { code: 'WORKSPACE_CHANGES_STALE' });
    result = await preview(value);
    await writeFile(path.join(value.execution, 'beta.txt'), 'newer result\n');
    await assert.rejects(apply(value, result), { code: 'WORKSPACE_CHANGES_STALE' });
    result = await preview(value);
    await checked(['checkout', '-b', 'other-branch'], value.source);
    await assert.rejects(apply(value, result), { code: 'WORKSPACE_CHANGES_STALE' });
    let inside = false; let checks = 0;
    const gated = { ...value.input, targetRoot: value.source, assertPinned: () => { assert.equal(inside, true); checks++; }, withLock: async <T>(operation: () => Promise<T>) => { assert.equal(inside, false); inside = true; try { return await operation(); } finally { inside = false; } } };
    await value.service.preview(gated); assert.ok(checks > 10);
  });
});

test('text, binary, add/add and delete/modify conflicts preserve both and block all target writes', { timeout: 40_000 }, async () => {
  await fixture(async value => {
    await writeFile(path.join(value.source, 'binary.dat'), Buffer.from([0, 1, 2]));
    await writeFile(path.join(value.execution, 'binary.dat'), Buffer.from([0, 1, 2]));
    await value.service.captureBaseline(value.input);
    await writeFile(path.join(value.execution, 'alpha.txt'), 'session overlap\n');
    await writeFile(path.join(value.source, 'alpha.txt'), 'target overlap\n');
    await writeFile(path.join(value.execution, 'binary.dat'), Buffer.from([0, 3, 2]));
    await writeFile(path.join(value.source, 'binary.dat'), Buffer.from([0, 4, 2]));
    await writeFile(path.join(value.execution, 'new.txt'), 'new source'); await writeFile(path.join(value.source, 'new.txt'), 'new target');
    await rm(path.join(value.execution, 'beta.txt')); await writeFile(path.join(value.source, 'beta.txt'), 'target changed beta\n');
    await writeFile(path.join(value.execution, 'clean-add.txt'), 'must not apply');
    const result = await preview(value);
    assert.deepEqual(result.conflicts.map(conflict => [conflict.path, conflict.reason]), [['alpha.txt', 'text'], ['beta.txt', 'delete/modify'], ['binary.dat', 'binary'], ['new.txt', 'add/add']]);
    assert.equal((await apply(value, result)).status, 'conflict');
    assert.equal(existsSync(path.join(value.source, 'clean-add.txt')), false);
    assert.equal(await readFile(path.join(value.source, 'alpha.txt'), 'utf8'), 'target overlap\n');
    assert.equal(await readFile(path.join(value.execution, 'alpha.txt'), 'utf8'), 'session overlap\n');
    assert.ok(result.conflicts[0]!.mergedBlob);
  });
});

test('split index is reconstructible without refreshing raw index', { timeout: 40_000 }, async () => {
  await fixture(async value => {
    await checked(['update-index', '--split-index'], value.execution);
    const before = await readFile(path.join(value.execution, '.git', 'index'));
    const captured = await value.service.captureBaseline(value.input);
    const state = value.execution + '.chisa-state/changes';
    const manifest = storedJson<{ git: { sharedIndexes: { name: string; blob: string }[] } }>(path.join(state, 'snapshots', captured.sourceRevision + '.json'));
    assert.equal(manifest.git.sharedIndexes.length, 1);
    for (const entry of manifest.git.sharedIndexes) assert.deepEqual(await readFile(path.join(state, 'objects', entry.blob)), await readFile(path.join(value.execution, '.git', entry.name)));
    assert.deepEqual(await readFile(path.join(value.execution, '.git', 'index')), before);
  });
});

test('capture refuses a changing snapshot, foreign index lock and non-external storage', { timeout: 40_000 }, async () => {
  await fixture(async value => {
    let changed = false;
    const service = createWorkspaceChangesService({ runGit: async (args, cwd, signal, input) => {
      if (!changed && args[0] === 'ls-files') { changed = true; await writeFile(path.join(value.execution, 'alpha.txt'), 'raced\n'); }
      return git(args, cwd, signal, input);
    } });
    // Force mutation between scans, rather than before the first scan.
    let reads = 0;
    const racing = createWorkspaceChangesService({ runGit: async (args, cwd, signal, input) => {
      if (args[0] === 'ls-files' && ++reads === 2) await writeFile(path.join(value.execution, 'alpha.txt'), 'late race\n');
      return git(args, cwd, signal, input);
    } });
    await assert.rejects(racing.captureBaseline(value.input), { code: 'WORKSPACE_SNAPSHOT_CHANGED' });
    assert.deepEqual(await value.service.inspectBaseline(value.input), { available: false, reason: 'BASELINE_UNAVAILABLE' });
    await writeFile(path.join(value.execution, '.git', 'index.lock'), 'foreign writer');
    await assert.rejects(service.captureBaseline(value.input), { code: 'WORKSPACE_GIT_OPERATION_IN_PROGRESS' });
    assert.equal(await readFile(path.join(value.execution, '.git', 'index.lock'), 'utf8'), 'foreign writer');
    await assert.rejects(value.service.captureBaseline({ ...value.input, stateRoot: path.join(value.execution, 'state') }), { code: 'WORKSPACE_CHANGES_PATH' });
  });
});

test('journal recovers a deterministic interruption and preserves the target index', { timeout: 40_000 }, async () => {
  await fixture(async value => {
    await value.service.captureBaseline(value.input);
    await writeFile(path.join(value.execution, 'alpha.txt'), 'new alpha\n'); await writeFile(path.join(value.execution, 'beta.txt'), 'new beta\n');
    const result = await preview(value); const index = await readFile(path.join(value.source, '.git', 'index'));
    let crashed = false;
    const crashInput = { ...value.input, targetRoot: value.source, previewId: result.previewId, expectedSourceRevision: result.sourceRevision, expectedTargetRevision: result.targetRevision, operationId: 'crash-operation', assertPinned: () => {
      if (!crashed && existsSync(path.join(value.source, 'alpha.txt')) && readFileSync(path.join(value.source, 'alpha.txt'), 'utf8') === 'new alpha\n') { crashed = true; throw new Error('simulated crash'); }
    } };
    await assert.rejects(value.service.apply(crashInput), /simulated crash/); assert.equal(crashed, true);
    await assert.rejects(preview(value), { code: 'WORKSPACE_CHANGES_RECOVERY_REQUIRED' });
    assert.equal((await value.service.recover({ ...value.input, targetRoot: value.source })).status, 'applied');
    assert.equal(await readFile(path.join(value.source, 'beta.txt'), 'utf8'), 'new beta\n');
    assert.deepEqual(await readFile(path.join(value.source, '.git', 'index')), index);
    assert.equal((await preview(value)).changes.length, 0);
    assert.equal((await value.service.recover({ ...value.input, targetRoot: value.source })).status, 'idle');
  });
});

test('recovery stops on external edits; operation ID cannot move to another target identity', { timeout: 40_000 }, async () => {
  await fixture(async value => {
    await value.service.captureBaseline(value.input);
    await writeFile(path.join(value.execution, 'alpha.txt'), 'new alpha\n'); await writeFile(path.join(value.execution, 'beta.txt'), 'new beta\n');
    const result = await preview(value);
    let crashed = false;
    await assert.rejects(value.service.apply({ ...value.input, targetRoot: value.source, previewId: result.previewId, expectedSourceRevision: result.sourceRevision, expectedTargetRevision: result.targetRevision, operationId: 'stopped', assertPinned: () => {
      if (!crashed && existsSync(path.join(value.source, 'alpha.txt')) && readFileSync(path.join(value.source, 'alpha.txt'), 'utf8') === 'new alpha\n') { crashed = true; throw new Error('stop'); }
    } }), /stop/);
    await writeFile(path.join(value.source, 'alpha.txt'), 'external after crash\n');
    const recovered = await value.service.recover({ ...value.input, targetRoot: value.source });
    assert.equal(recovered.status, 'blocked'); assert.equal(recovered.conflicts[0]!.path, 'alpha.txt');
    assert.equal(await readFile(path.join(value.source, 'alpha.txt'), 'utf8'), 'external after crash\n');
    const other = path.join(value.directory, 'other'); await cp(value.source, other, { recursive: true });
    await assert.rejects(value.service.apply({ ...value.input, targetRoot: other, previewId: result.previewId, expectedSourceRevision: result.sourceRevision, expectedTargetRevision: result.targetRevision, operationId: 'stopped' }), { code: 'WORKSPACE_CHANGES_IDENTITY' });
  });
});

test('safe type transitions and deletions succeed; ignored contents block directory replacement', { timeout: 40_000 }, async () => {
  await fixture(async value => {
    await mkdir(path.join(value.execution, 'folder')); await mkdir(path.join(value.source, 'folder'));
    await writeFile(path.join(value.execution, 'folder', 'child'), 'base'); await writeFile(path.join(value.source, 'folder', 'child'), 'base');
    await value.service.captureBaseline(value.input);
    await rm(path.join(value.execution, 'folder'), { recursive: true }); await writeFile(path.join(value.execution, 'folder'), 'replacement file');
    await rm(path.join(value.execution, 'beta.txt')); await mkdir(path.join(value.execution, 'beta.txt')); await writeFile(path.join(value.execution, 'beta.txt', 'child'), 'new child');
    let result = await preview(value); assert.deepEqual(result.conflicts, []);
    assert.equal((await apply(value, result)).status, 'applied');
    assert.equal(await readFile(path.join(value.source, 'folder'), 'utf8'), 'replacement file');
    assert.equal(await readFile(path.join(value.source, 'beta.txt', 'child'), 'utf8'), 'new child');
    await mkdir(path.join(value.source, 'beta.txt', 'node_modules')); await writeFile(path.join(value.source, 'beta.txt', 'node_modules', 'local'), 'local dependency');
    await rm(path.join(value.execution, 'beta.txt'), { recursive: true }); await writeFile(path.join(value.execution, 'beta.txt'), 'replace blocked');
    result = await preview(value); assert.ok(result.conflicts.some(conflict => conflict.reason === 'directory-not-empty'));
  });
});

test('symlink writes stay within target and parent links are never traversed', { timeout: 30_000, skip: process.platform === 'win32' ? 'Creating symlinks requires Windows developer-mode privilege; Linux CI exercises this fixture' : false }, async () => {
  await fixture(async value => {
    await value.service.captureBaseline(value.input);
    await symlink('../outside', path.join(value.execution, 'unsafe'));
    await symlink('beta.txt', path.join(value.execution, 'safe'));
    let result = await preview(value); assert.ok(result.conflicts.some(conflict => conflict.path === 'unsafe' && conflict.reason === 'unsafe-symlink'));
    await rm(path.join(value.execution, 'unsafe')); result = await preview(value);
    assert.equal((await apply(value, result)).status, 'applied'); assert.equal(lstatSync(path.join(value.source, 'safe')).isSymbolicLink(), true);
    await mkdir(path.join(value.execution, 'nested')); await writeFile(path.join(value.execution, 'nested', 'child'), 'inside');
    const outside = path.join(value.directory, 'outside'); await mkdir(outside); await symlink(outside, path.join(value.source, 'nested'));
    result = await preview(value); assert.ok(result.conflicts.length > 0); assert.equal(existsSync(path.join(outside, 'child')), false);
  });
});

test('non-Git directories have the same durable delta and recovery contract', { timeout: 30_000 }, async () => {
  await fixture(async value => {
    await rm(path.join(value.execution, '.git'), { recursive: true }); await rm(path.join(value.source, '.git'), { recursive: true });
    assert.equal((await value.service.captureBaseline(value.input)).head, null);
    await writeFile(path.join(value.execution, 'beta.txt'), 'plain result');
    const result = await preview(value); assert.equal((await apply(value, result)).status, 'applied');
    assert.equal(await readFile(path.join(value.source, 'beta.txt'), 'utf8'), 'plain result');
  });
});

test('recovery resumes between file displacement and installation', { timeout: 30_000 }, async () => {
  await fixture(async value => {
    await value.service.captureBaseline(value.input);
    await writeFile(path.join(value.execution, 'alpha.txt'), 'replacement\n');
    const result = await preview(value);
    let interrupted = false;
    await assert.rejects(value.service.apply({ ...value.input, targetRoot: value.source, previewId: result.previewId, expectedSourceRevision: result.sourceRevision, expectedTargetRevision: result.targetRevision, operationId: 'displacement', assertPinned: () => {
      if (!interrupted && !existsSync(path.join(value.source, 'alpha.txt'))) { interrupted = true; throw new Error('displaced'); }
    } }), /displaced/);
    assert.equal(interrupted, true);
    assert.equal((await value.service.recover({ ...value.input, targetRoot: value.source })).status, 'applied');
    assert.equal(await readFile(path.join(value.source, 'alpha.txt'), 'utf8'), 'replacement\n');
  });
});

test('recovery skips deleted descendants after parent directory becomes a file', { timeout: 30_000 }, async () => {
  await fixture(async value => {
    for (const root of [value.source, value.execution]) { await mkdir(path.join(root, 'folder')); await writeFile(path.join(root, 'folder', 'child'), 'base'); }
    await value.service.captureBaseline(value.input);
    await rm(path.join(value.execution, 'folder'), { recursive: true }); await writeFile(path.join(value.execution, 'folder'), 'now a file');
    const result = await preview(value);
    let interrupted = false;
    await assert.rejects(value.service.apply({ ...value.input, targetRoot: value.source, previewId: result.previewId, expectedSourceRevision: result.sourceRevision, expectedTargetRevision: result.targetRevision, operationId: 'directory-crash', assertPinned: () => {
      if (!interrupted && existsSync(path.join(value.source, 'folder')) && lstatSync(path.join(value.source, 'folder')).isFile()) { interrupted = true; throw new Error('converted'); }
    } }), /converted/);
    assert.equal((await value.service.recover({ ...value.input, targetRoot: value.source })).status, 'applied');
    assert.equal(await readFile(path.join(value.source, 'folder'), 'utf8'), 'now a file');
  });
});

test('unresolved Git stages retain each side as durable blob content', { timeout: 30_000 }, async () => {
  await fixture(async value => {
    const head = (await checked(['rev-parse', 'HEAD:alpha.txt'], value.execution)).trim();
    const other = (await checked(['rev-parse', 'HEAD:beta.txt'], value.execution)).trim();
    const result = await git(['update-index', '--index-info'], value.execution, undefined, Buffer.from(`0 ${'0'.repeat(40)}\talpha.txt\n100644 ${head} 1\talpha.txt\n100644 ${other} 2\talpha.txt\n100644 ${head} 3\talpha.txt\n`));
    assert.equal(result.code, 0, result.stderr.toString());
    const captured = await value.service.captureBaseline(value.input);
    const state = value.execution + '.chisa-state/changes';
    const snapshot = storedJson<{ git: { stages: { path: string; stage: number; blob: string }[] } }>(path.join(state, 'snapshots', captured.sourceRevision + '.json'));
    const stages = snapshot.git.stages.filter(entry => entry.path === 'alpha.txt');
    assert.deepEqual(stages.map(entry => entry.stage), [1, 2, 3]);
    for (const entry of stages) assert.ok(existsSync(path.join(state, 'objects', entry.blob)));
  });
});

test('Git linked worktree baselines preserve HEAD and private index without writing common objects', { timeout: 30_000 }, async () => {
  await fixture(async value => {
    const linked = path.join(value.directory, 'linked');
    await checked(['worktree', 'add', '-b', 'session-linked', linked, 'HEAD'], value.source);
    await writeFile(path.join(linked, 'alpha.txt'), 'staged linked\n'); await checked(['add', 'alpha.txt'], linked); await writeFile(path.join(linked, 'alpha.txt'), 'working linked\n');
    const objects = objectFiles(path.join(value.source, '.git', 'objects'));
    const captured = await value.service.captureBaseline({ ...value.input, executionRoot: linked });
    assert.equal(captured.available, true);
    assert.deepEqual(objectFiles(path.join(value.source, '.git', 'objects')), objects);
  });
});

test('prototype-shaped filenames remain ordinary content and independent revisions', { timeout: 30_000 }, async () => {
  await fixture(async value => {
    await value.service.captureBaseline(value.input);
    await writeFile(path.join(value.execution, '__proto__'), 'prototype file'); await writeFile(path.join(value.execution, 'constructor'), 'constructor file');
    const result = await preview(value); assert.deepEqual(result.conflicts, []);
    assert.equal((await apply(value, result)).status, 'applied');
    assert.equal(await readFile(path.join(value.source, '__proto__'), 'utf8'), 'prototype file');
  });
});

test('session edits during target validation invalidate apply before the first target write', { timeout: 30_000 }, async () => {
  await fixture(async value => {
    await value.service.captureBaseline(value.input);
    await writeFile(path.join(value.execution, 'beta.txt'), 'previewed result\n');
    const result = await preview(value);
    let changed = false;
    const racing = createWorkspaceChangesService({ runGit: async (args, cwd, signal, input) => {
      if (!changed && cwd === value.source && args[0] === 'ls-files') { changed = true; await writeFile(path.join(value.execution, 'beta.txt'), 'unreviewed newer result\n'); }
      return git(args, cwd, signal, input);
    } });
    await assert.rejects(racing.apply({ ...value.input, targetRoot: value.source, previewId: result.previewId, expectedSourceRevision: result.sourceRevision, expectedTargetRevision: result.targetRevision, operationId: 'capture-race' }), { code: 'WORKSPACE_CHANGES_STALE' });
    assert.equal(await readFile(path.join(value.source, 'beta.txt'), 'utf8'), 'beta baseline\n');
  });
});

test('delta merge does not republish baseline-only dirt even in the same file', { timeout: 30_000 }, async () => {
  await fixture(async value => {
    await value.service.captureBaseline(value.input);
    const working = await readFile(path.join(value.execution, 'alpha.txt'), 'utf8');
    await writeFile(path.join(value.execution, 'alpha.txt'), working.replace('nine\n', 'session nine\n'));
    await checked(['reset', '--hard', 'HEAD'], value.source);
    const clean = await readFile(path.join(value.source, 'alpha.txt'), 'utf8');
    const result = await preview(value); assert.deepEqual(result.conflicts, []);
    assert.equal((await apply(value, result)).status, 'applied');
    assert.equal(await readFile(path.join(value.source, 'alpha.txt'), 'utf8'), clean.replace('nine\n', 'session nine\n'));
  }, async source => {
    const original = await readFile(path.join(source, 'alpha.txt'), 'utf8');
    await writeFile(path.join(source, 'alpha.txt'), original.replace('one\n', 'unrelated dirty one\n'));
  });
});

test('replacing execution root invalidates its old baseline identity', { timeout: 30_000 }, async () => {
  await fixture(async value => {
    await value.service.captureBaseline(value.input);
    await rename(value.execution, value.execution + '-old'); await cp(value.execution + '-old', value.execution, { recursive: true });
    await assert.rejects(value.service.inspectBaseline(value.input), { code: 'WORKSPACE_CHANGES_IDENTITY' });
  });
});

test('integration inspection is synchronous and creates no metadata for absent or idle stores', { timeout: 30_000 }, async () => {
  await fixture(async value => {
    let runs = 0;
    const service = createWorkspaceChangesService({ runGit: async () => { runs++; throw new Error('inspection must not run Git'); } });
    const input = { sessionId: value.input.sessionId, sourceRoot: value.source, executionRoot: value.execution, targetRoot: value.source, assertPinned: () => {} };
    const state = value.execution + '.chisa-state';
    assert.deepEqual(service.inspectIntegration(input), { status: 'idle' });
    assert.deepEqual(service.inspectIntegration({ ...input, operationId: 'missing-operation' }), { status: 'idle' });
    assert.equal(existsSync(state), false);
    await value.service.captureBaseline(value.input);
    const files = objectFiles(state);
    assert.deepEqual(service.inspectIntegration({ ...input, operationId: 'missing-operation' }), { status: 'idle' });
    assert.deepEqual(objectFiles(state), files);
    assert.equal(existsSync(path.join(state, 'changes', 'targets')), false);
    assert.equal(runs, 0);
    assert.throws(() => service.inspectIntegration({ ...input, assertPinned: () => { throw new Error('lost pin'); } }), /lost pin/);
    assert.deepEqual(objectFiles(state), files);
  });
});

test('inspection distinguishes a pending partial write and exact committed receipt, including historical receipts', { timeout: 60_000 }, async () => {
  await fixture(async value => {
    await value.service.captureBaseline(value.input);
    await writeFile(path.join(value.execution, 'alpha.txt'), 'new alpha\n');
    await writeFile(path.join(value.execution, 'beta.txt'), 'new beta\n');
    const reviewed = await preview(value);
    const operationId = 'inspected-operation';
    const input = { ...value.input, targetRoot: value.source, operationId };
    let crashed = false;
    await assert.rejects(value.service.apply({ ...input, previewId: reviewed.previewId, expectedSourceRevision: reviewed.sourceRevision, expectedTargetRevision: reviewed.targetRevision, assertPinned: () => {
      if (!crashed && existsSync(path.join(value.source, 'alpha.txt')) && readFileSync(path.join(value.source, 'alpha.txt'), 'utf8') === 'new alpha\n') { crashed = true; throw new Error('partial write'); }
    } }), /partial write/);
    const files = objectFiles(value.execution + '.chisa-state');
    const pending = value.service.inspectIntegration(input);
    assert.equal(pending.status, 'pending');
    assert.equal(pending.operationId, operationId);
    assert.equal(pending.previewId, reviewed.previewId);
    assert.equal(pending.sourceRevision, reviewed.sourceRevision);
    assert.equal(pending.targetRevision, reviewed.targetRevision);
    assert.equal(pending.active, true);
    assert.equal(pending.receipt, null);
    assert.deepEqual(objectFiles(value.execution + '.chisa-state'), files);
    assert.throws(() => value.service.inspectIntegration({ ...input, operationId: 'foreign-operation' }), { code: 'WORKSPACE_CHANGES_RECOVERY_REQUIRED' });
    await assert.rejects(value.service.recover({ ...input, operationId: 'foreign-operation' }), { code: 'WORKSPACE_CHANGES_RECOVERY_REQUIRED' });
    const recovered = await value.service.recover(input);
    assert.ok(recovered.status === 'applied');
    assert.equal(recovered.operationId, operationId);
    const committed = value.service.inspectIntegration(input);
    assert.equal(committed.status, 'committed');
    assert.equal(committed.active, false);
    assert.equal(committed.receipt?.operationId, operationId);
    assert.equal(value.service.inspectIntegration({ ...input, operationId: undefined }).status, 'idle');
    assert.equal((await value.service.recover({ ...input, operationId: undefined })).status, 'idle');
    assert.equal((await value.service.recover(input)).status, 'applied');
    await writeFile(path.join(value.execution, 'beta.txt'), 'another result\n');
    assert.equal((await apply(value, await preview(value), 'later-operation')).status, 'applied');
    assert.equal(value.service.inspectIntegration(input).status, 'committed');
    const replayed = await value.service.recover(input);
    assert.ok(replayed.status === 'applied');
    assert.equal(replayed.operationId, operationId);
    assert.equal(await readFile(path.join(value.source, 'beta.txt'), 'utf8'), 'another result\n');
  });
});

test('receipt replay completes an interrupted active-pointer removal before reporting committed inspection', { timeout: 45_000 }, async () => {
  await fixture(async value => {
    await value.service.captureBaseline(value.input);
    await writeFile(path.join(value.execution, 'beta.txt'), 'committed bytes\n');
    const reviewed = await preview(value);
    const operationId = 'receipt-before-cleanup';
    assert.equal((await apply(value, reviewed, operationId)).status, 'applied');
    const state = value.execution + '.chisa-state/changes';
    const operationHash = createHash('sha256').update(operationId).digest('hex');
    const journalFile = path.join(state, 'operations', operationHash + '.json');
    const journal = storedJson<Record<string, unknown>>(journalFile);
    const targetState = path.join(state, 'targets', readdirSync(path.join(state, 'targets'))[0]!);
    await writeFile(journalFile, JSON.stringify({ ...journal, phase: 'applied' }));
    await writeFile(path.join(targetState, 'active.json'), JSON.stringify({ operationId }));
    const input = { ...value.input, targetRoot: value.source, operationId };
    const pending = value.service.inspectIntegration(input);
    assert.equal(pending.status, 'pending');
    assert.equal(pending.active, true);
    assert.equal(pending.receipt?.operationId, operationId);
    const replayed = await apply(value, reviewed, operationId);
    assert.ok(replayed.status === 'applied');
    assert.equal(replayed.replayed, true);
    assert.equal(existsSync(path.join(targetState, 'active.json')), false);
    assert.equal(value.service.inspectIntegration(input).status, 'committed');
    assert.equal(storedJson<{ phase: string }>(journalFile).phase, 'committed');
  });
});

test('exact recovery discovers prepared journal without an active pointer and never invents another operation', { timeout: 45_000 }, async () => {
  await fixture(async value => {
    await value.service.captureBaseline(value.input);
    await writeFile(path.join(value.execution, 'beta.txt'), 'prepared result\n');
    const reviewed = await preview(value);
    const operationId = 'prepared-before-pointer';
    const state = value.execution + '.chisa-state/changes';
    const operationHash = createHash('sha256').update(operationId).digest('hex');
    const journalFile = path.join(state, 'operations', operationHash + '.json');
    await assert.rejects(value.service.apply({ ...value.input, targetRoot: value.source, operationId, previewId: reviewed.previewId, expectedSourceRevision: reviewed.sourceRevision, expectedTargetRevision: reviewed.targetRevision, assertPinned: () => {
      if (existsSync(journalFile)) throw new Error('prepared but no writes');
    } }), /prepared but no writes/);
    assert.equal(await readFile(path.join(value.source, 'beta.txt'), 'utf8'), 'beta baseline\n');
    const active = path.join(state, 'targets', readdirSync(path.join(state, 'targets'))[0]!, 'active.json');
    assert.ok(active.startsWith(path.resolve(state) + path.sep));
    await rm(active);
    const input = { ...value.input, targetRoot: value.source, operationId };
    const pending = value.service.inspectIntegration(input);
    assert.equal(pending.status, 'pending');
    assert.equal(pending.active, false);
    assert.equal(pending.phase, 'prepared');
    assert.equal((await value.service.recover({ ...input, operationId: 'missing-operation' })).status, 'idle');
    const recovered = await value.service.recover(input);
    assert.ok(recovered.status === 'applied');
    assert.equal(recovered.operationId, operationId);
    assert.equal(await readFile(path.join(value.source, 'beta.txt'), 'utf8'), 'prepared result\n');
  });
});

test('inspection fails closed on corrupted metadata and replaced roots', { timeout: 45_000 }, async () => {
  await fixture(async value => {
    await value.service.captureBaseline(value.input);
    await writeFile(path.join(value.execution, 'beta.txt'), 'verified result\n');
    const reviewed = await preview(value); const operationId = 'corrupt-inspection';
    await apply(value, reviewed, operationId);
    const state = value.execution + '.chisa-state/changes';
    const receipt = path.join(state, 'receipts', createHash('sha256').update(operationId).digest('hex') + '.json');
    const valid = await readFile(receipt, 'utf8');
    await writeFile(receipt, JSON.stringify({ ...JSON.parse(valid), baselineId: 'wrong-baseline' }));
    const input = { ...value.input, targetRoot: value.source, operationId };
    assert.throws(() => value.service.inspectIntegration(input), { code: 'WORKSPACE_CHANGES_STATE_CORRUPT' });
    await writeFile(receipt, valid);
    assert.equal(value.service.inspectIntegration(input).status, 'committed');
    await rename(value.execution, value.execution + '-old');
    await cp(value.execution + '-old', value.execution, { recursive: true });
    assert.throws(() => value.service.inspectIntegration(input), { code: 'WORKSPACE_CHANGES_IDENTITY' });
  });
});
