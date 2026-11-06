#!/usr/bin/env node
/** Reproducible quality gate: default is inventory only; no application server or installation is started. */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, writeFileSync } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isMainThread, threadId } from 'node:worker_threads';

const SCRIPT = fileURLToPath(import.meta.url);
const SERVICE = path.resolve(path.dirname(SCRIPT), '..');
const CHANNELS = ['client', 'server', 'go', 'runner', 'typecheck', 'lint', 'build'];
const EXCLUDED = new Set(['node_modules', 'vendor', '__pycache__', '.git', 'archive', 'archives', 'archived', 'snapshot', 'snapshots', 'diagnostics', 'build', 'dist', 'dist-server', 'dist-server.next', 'dist-server.old', 'coverage', 'tmp', 'temp', '.tmp', '.cache', '.vite']);
const slash = value => value.replaceAll('\\', '/');
const sha = value => createHash('sha256').update(value).digest('hex');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const errorText = error => error instanceof Error ? `${error.name}: ${error.message}` : String(error);

// The same module is a Node preload. Each process/worker reports its own real OS/resource samples, never an invented tree peak.
if (process.env.CHISA_VERIFY_RESOURCE_DIRECTORY) {
  const directory = process.env.CHISA_VERIFY_RESOURCE_DIRECTORY;
  mkdirSync(directory, { recursive: true });
  const filename = path.join(directory, `${process.pid}-${threadId}.json`);
  let heapPeak = 0;
  let rssPeak = 0;
  const sample = final => {
    try {
      const memory = process.memoryUsage(); const usage = process.resourceUsage();
      heapPeak = Math.max(heapPeak, memory.heapUsed); rssPeak = Math.max(rssPeak, memory.rss);
      writeFileSync(filename, JSON.stringify({ pid: process.pid, threadId, isMainThread, channel: process.env.CHISA_VERIFY_CHANNEL,
        executable: process.execPath, nodeVersion: process.version, observedAt: new Date().toISOString(), final,
        rssSamplePeakBytes: rssPeak, heapUsedSamplePeakBytes: heapPeak, maxRssBytes: usage.maxRSS > 0 ? usage.maxRSS * 1024 : null,
        cpuUserMicros: usage.userCPUTime, cpuSystemMicros: usage.systemCPUTime,
        method: 'process.memoryUsage sampled each second; process.resourceUsage maxRSS is OS high-water for this process (KiB converted to bytes); worker samples share process RSS' }));
    } catch { /* A telemetry failure is recorded by the parent as unavailable; it cannot change a test result. */ }
  };
  sample(false); const timer = setInterval(() => sample(false), 1000); timer.unref();
  process.once('exit', () => sample(true));
}

/** Node's built-in reporter provides machine-readable real counts and file events without parsing human console output. */
export default async function* nodeReporter(events) {
  for await (const event of events) {
    if (['test:pass', 'test:fail', 'test:summary', 'test:enqueue', 'test:dequeue', 'test:complete', 'test:diagnostic', 'test:stdout', 'test:stderr'].includes(event.type)) {
      yield JSON.stringify(event, (_key, value) => value instanceof Error ? { name: value.name, message: value.message, stack: value.stack, code: value.code, failureType: value.failureType } : value) + '\n';
    }
  }
}

async function walk(directory, root, excluded, shallow = false) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name); const relative = slash(path.relative(root, absolute));
    if (entry.isSymbolicLink()) { excluded.push({ path: relative, reason: 'symlink is not traversed' }); continue; }
    if (entry.isDirectory()) {
      if (EXCLUDED.has(entry.name.toLowerCase()) || entry.name.startsWith('.')) excluded.push({ path: relative, reason: 'non-active source directory' });
      else if (!shallow) files.push(...await walk(absolute, root, excluded));
    } else if (entry.isFile()) files.push(absolute);
  }
  return files;
}
async function hashFile(absolute, root) {
  const content = await readFile(absolute);
  return { path: slash(path.relative(root, absolute)), bytes: content.length, sha256: sha(content) };
}
async function optionalFile(filename) {
  try { return await readFile(filename, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

/** Discovery is confined to active roots; Go intentionally lists only app/*.go and never app/build or snapshots. */
export async function discover(serviceRoot = SERVICE) {
  serviceRoot = path.resolve(serviceRoot); const root = path.dirname(serviceRoot); const excluded = [];
  const source = [];
  for (const relative of ['src', 'server', 'shared', 'scripts']) {
    const absolute = path.join(serviceRoot, relative); if (existsSync(absolute)) source.push(...await walk(absolute, root, excluded));
  }
  const goRoot = path.join(root, 'app');
  const goSources = existsSync(goRoot) ? (await walk(goRoot, root, excluded, true)).filter(name => /\.(?:go|mod|sum)$/.test(name)) : [];
  source.push(...goSources);
  // These reviewed runtime/build inputs live outside the ordinary feature roots.
  // List exact roots: never recurse through archived app builds or audit snapshots.
  for (const absolute of [
    path.join(serviceRoot, 'vendor/builtin-plugins'),
    path.join(serviceRoot, 'vendor/eslint-plugin-import-x'),
    path.join(goRoot, 'scripts'), path.join(goRoot, 'installer'),
    path.join(root, 'ops'),
  ]) {
    if (existsSync(absolute)) source.push(...await walk(absolute, root, excluded));
  }
  for (const name of ['resources/service.json', 'resources/ssh-workspace.ps1', 'resources/icon.png', 'package.json', 'package-lock.json', 'mygo.config.ts']) {
    const absolute = path.join(goRoot, name); if (existsSync(absolute)) source.push(absolute);
  }
  for (const name of ['LICENSE', 'README.md', 'package.json', 'package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock', 'tsconfig.json', 'server/tsconfig.json', 'vitest.config.ts', 'vitest.setup.ts', 'vite.config.js', '.oxlintrc.json', '.oxlintrc.jsonc', 'vendor/eslint-plugin-import-x-4.17.1-chisa.1.tgz']) {
    const absolute = path.join(serviceRoot, name); if (existsSync(absolute)) source.push(absolute);
  }
  const unique = [...new Set(source)].sort(); const records = [];
  for (const file of unique) records.push(await hashFile(file, root));
  const tests = { client: [], server: [], go: [], runner: [] };
  for (const item of records) {
    const relative = slash(path.relative(serviceRoot, path.join(root, item.path)));
    if (relative.startsWith('src/') && /\.test\.(?:ts|tsx)$/.test(relative)) tests.client.push(item);
    if (relative.startsWith('server/') && /\.test\.(?:ts|js)$/.test(relative)) tests.server.push(item);
    if (relative.startsWith('scripts/tests/') && /\.test\.mjs$/.test(relative)) tests.runner.push(item);
    if (path.dirname(path.join(root, item.path)) === goRoot && /_test\.go$/.test(item.path)) {
      const text = await readFile(path.join(root, item.path), 'utf8');
      tests.go.push({ ...item, buildConstraint: text.match(/^\/\/go:build (.+)$/m)?.[1] ?? null });
    }
  }
  const config = await optionalFile(path.join(serviceRoot, 'vitest.config.ts'));
  const configurationErrors = config && (!config.includes('src/**/*.test.ts') || !config.includes('src/**/*.test.tsx'))
    ? ['Vitest include changed; review discovery instead of silently claiming complete coverage.'] : [];
  const packageData = JSON.parse(await readFile(path.join(serviceRoot, 'package.json'), 'utf8'));
  const dependencies = records.filter(item => /(?:^|\/)(?:package(?:-lock)?\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|go\.mod|go\.sum)$/.test(item.path));
  return { schemaVersion: 1, createdAt: new Date().toISOString(), serviceRoot, projectRoot: root,
    discovery: { client: ['src/**/*.test.ts', 'src/**/*.test.tsx'], server: ['server/**/*.test.ts', 'server/**/*.test.js'],
      go: 'app/*_test.go; go test . only; actual platform/compiler file list checked by go list', runner: 'scripts/tests/**/*.test.mjs',
      excluded, configurationErrors }, tests, source: records, sourceDigest: sha(records.map(item => item.path + ':' + item.sha256).join('\n')),
    dependencies, dependencyDigest: sha(dependencies.map(item => item.path + ':' + item.sha256).join('\n')),
    packageScripts: packageData.scripts ?? {} };
}

function chunks(items, size) { return Array.from({ length: Math.ceil(items.length / size) }, (_value, index) => items.slice(index * size, (index + 1) * size)); }
function npmCommand(service) {
  const candidates = [process.env.npm_execpath, path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js')];
  for (const part of (process.env.PATH ?? '').split(path.delimiter)) candidates.push(path.join(part, 'node_modules/npm/bin/npm-cli.js'));
  const cli = candidates.find(candidate => candidate && existsSync(candidate));
  return cli ? { command: process.execPath, prefix: [cli], cwd: service }
    : process.platform === 'win32' ? { command: process.env.ComSpec || 'cmd.exe', prefix: ['/d', '/s', '/c', 'npm.cmd'], cwd: service }
      : { command: 'npm', prefix: [], cwd: service };
}

export function createPlan(manifest, options = {}) {
  const selected = options.channels ?? CHANNELS; const batchSize = options.batchSize ?? 24; const heapMiB = options.heapMiB ?? 2048;
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 64) throw new Error('batch-size must be 1..64');
  if (!Number.isInteger(heapMiB) || heapMiB < 256 || heapMiB > 8192) throw new Error('heap-mib must be 256..8192');
  for (const name of selected) if (!CHANNELS.includes(name)) throw new Error('Unknown channel: ' + name);
  if (manifest.discovery.configurationErrors.length) throw new Error(manifest.discovery.configurationErrors.join('; '));
  for (const name of selected) if (Object.hasOwn(manifest.tests, name) && !manifest.tests[name].length) throw new Error('Selected test channel has no active test files: ' + name);
  const service = manifest.serviceRoot; const node = process.execPath; const jobs = [];
  const add = (channel, id, args, files = [], extra = {}) => jobs.push({ channel, id, command: node, args, cwd: service, files: files.map(item => item.path), heapMiB, ...extra });
  if (selected.includes('client')) for (const [index, files] of chunks(manifest.tests.client, batchSize).entries()) {
    add('client', `client-${index + 1}`, ['node_modules/vitest/vitest.mjs', 'run', ...files.map(item => slash(path.relative(service, path.join(manifest.projectRoot, item.path)))),
      '--maxWorkers=1', '--no-file-parallelism', '--logHeapUsage', '--reporter=json', '--outputFile=__REPORT__'], files, { format: 'vitest' });
  }
  if (selected.includes('server')) for (const [index, files] of chunks(manifest.tests.server, batchSize).entries()) {
    add('server', `server-${index + 1}`, ['node_modules/tsx/dist/cli.mjs', '--tsconfig', 'server/tsconfig.json', '--experimental-test-module-mocks', '--test', '--test-concurrency=1', '--test-timeout=120000', '--test-reporter=' + pathToFileURL(SCRIPT).href,
      ...files.map(item => slash(path.relative(service, path.join(manifest.projectRoot, item.path))))], files, { format: 'node' });
  }
  if (selected.includes('go')) {
    jobs.push({ channel: 'go', id: 'go-inventory', command: options.go ?? process.env.CHISA_VERIFY_GO ?? 'go', args: ['list', '-json', '.'], cwd: path.join(manifest.projectRoot, 'app'), files: [], format: 'go-inventory', heapMiB: null });
    jobs.push({ channel: 'go', id: 'go-tests', command: options.go ?? process.env.CHISA_VERIFY_GO ?? 'go', args: ['test', '-json', '-count=1', '-p=1', '-timeout=15m', '.'], cwd: path.join(manifest.projectRoot, 'app'), files: manifest.tests.go.map(item => item.path), format: 'go', heapMiB: null });
  }
  if (selected.includes('runner')) add('runner', 'runner-self-tests', ['--test', '--test-concurrency=1', '--test-reporter=' + pathToFileURL(SCRIPT).href,
    ...manifest.tests.runner.map(item => slash(path.relative(service, path.join(manifest.projectRoot, item.path))))], manifest.tests.runner, { format: 'node' });
  const npm = npmCommand(service);
  for (const channel of ['typecheck', 'lint', 'build']) if (selected.includes(channel)) {
    if (!manifest.packageScripts[channel]) throw new Error('Missing package script: ' + channel);
    jobs.push({ channel, id: channel, command: npm.command, args: [...npm.prefix, 'run', channel], cwd: service, files: [], heapMiB, format: 'command' });
  }
  const planned = checkCoverage(manifest, jobs.flatMap(job => job.files), selected.filter(channel => Object.hasOwn(manifest.tests, channel)));
  if (!planned.complete) throw new Error('Plan omits or duplicates active tests: ' + JSON.stringify(planned));
  return { schemaVersion: 1, selected, heapMiB, batchSize, concurrency: { jobs: 1, vitestWorkers: 1, vitestFileParallelism: false, nodeTestConcurrency: 1, goPackages: 1 }, jobs, plannedCoverage: planned };
}

export function checkCoverage(manifest, observed, selected = Object.keys(manifest.tests)) {
  const expected = new Set(selected.flatMap(channel => (manifest.tests[channel] ?? []).map(item => item.path)));
  const counts = new Map(); for (const file of observed) counts.set(file, (counts.get(file) ?? 0) + 1);
  const missing = [...expected].filter(file => !counts.has(file)); const unexpected = [...counts.keys()].filter(file => !expected.has(file));
  const duplicate = [...counts].filter(([_file, count]) => count > 1).map(([file, count]) => ({ file, count }));
  return { expected: expected.size, observed: counts.size, missing, unexpected, duplicate, complete: !missing.length && !unexpected.length && !duplicate.length };
}

function decodeJsonLines(text) {
  const values = []; const errors = [];
  for (const line of text.split(/\r?\n/).filter(line => line.trim())) {
    try { values.push(JSON.parse(line)); } catch { errors.push(line.slice(0, 250)); }
  }
  return { values, errors };
}
const blankCounts = () => ({ tests: 0, pass: 0, fail: 0, skip: 0, todo: 0, cancelled: 0 });
export function parseReport(format, text) {
  if (format === 'vitest') {
    const report = JSON.parse(text); const results = report.testResults ?? [];
    return { counts: { tests: report.numTotalTests ?? 0, pass: report.numPassedTests ?? 0, fail: report.numFailedTests ?? 0,
      skip: report.numPendingTests ?? 0, todo: report.numTodoTests ?? 0, cancelled: 0 }, files: results.map(item => item.name),
      failures: results.filter(item => item.status === 'failed').map(item => ({ file: item.name, message: item.message,
        assertions: (item.assertionResults ?? []).filter(assertion => assertion.status === 'failed').map(assertion => ({ name: assertion.fullName, messages: assertion.failureMessages })) })),
      durationMs: results.reduce((sum, item) => sum + Math.max(0, (item.endTime ?? 0) - (item.startTime ?? 0)), 0), parseErrors: [], successful: report.success === true };
  }
  const decoded = decodeJsonLines(text);
  if (format === 'node') {
    const summaries = decoded.values.filter(item => item.type === 'test:summary');
    const summary = summaries.findLast(item => !item.data.file) ?? summaries.at(-1);
    if (!summary?.data.counts) throw new Error('Node reporter did not finish with test:summary');
    const counts = summary.data.counts;
    return { counts: { tests: counts.tests ?? 0, pass: counts.passed ?? 0, fail: counts.failed ?? 0, skip: counts.skipped ?? 0,
      todo: counts.todo ?? 0, cancelled: counts.cancelled ?? 0 },
      files: [...new Set(decoded.values.filter(item => ['test:complete', 'test:summary'].includes(item.type)).map(item => item.data?.entryFile ?? item.data?.file).filter(file => file && /(?:\.test\.(?:ts|js|mjs)|_test\.go)$/.test(file)))],
      failures: decoded.values.filter(item => item.type === 'test:fail').map(item => ({ name: item.data.name, file: item.data.file, error: item.data.details?.error })),
      durationMs: summary.data.duration_ms ?? null, parseErrors: decoded.errors, successful: summary.data.success === true };
  }
  if (format === 'go') {
    const terminal = decoded.values.filter(item => item.Test && ['pass', 'fail', 'skip'].includes(item.Action));
    const counts = blankCounts(); counts.tests = terminal.length;
    for (const item of terminal) counts[item.Action]++;
    const packageEnd = decoded.values.filter(item => !item.Test && ['pass', 'fail', 'skip'].includes(item.Action));
    return { counts, files: [], failures: decoded.values.filter(item => item.Action === 'fail'),
      durationMs: packageEnd.reduce((sum, item) => sum + (item.Elapsed ?? 0) * 1000, 0), parseErrors: decoded.errors,
      successful: packageEnd.length > 0 && packageEnd.every(item => item.Action !== 'fail'), packages: packageEnd };
  }
  if (format === 'go-inventory') { const inventory = JSON.parse(text); return { inventory, counts: null, files: [], successful: !inventory.Error, parseErrors: [] }; }
  return { counts: null, files: [], successful: true, parseErrors: [] };
}

async function stopTree(child) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32') {
    await new Promise(resolve => {
      const killer = spawn('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true });
      killer.once('error', () => { child.kill(); resolve(); }); killer.once('exit', resolve);
    });
  } else { try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill('SIGTERM'); } await wait(250); try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ } }
}

/** Children write stdout/stderr to regular files, avoiding pipe privileges and retaining evidence even on test failures. */
export async function runCommand(job, options = {}) {
  const directory = options.directory; if (!directory) throw new Error('A result directory is required');
  await mkdir(directory, { recursive: true }); const stdoutPath = path.join(directory, job.id + '.stdout.log');
  const stderrPath = path.join(directory, job.id + '.stderr.log'); const reportPath = path.join(directory, job.id + '.report.json');
  const resourceDirectory = path.join(directory, 'resources', job.id);
  const out = openSync(stdoutPath, 'w'); const err = openSync(stderrPath, 'w'); const start = performance.now();
  let timedOut = false; let cancelled = false; let launchError = null; let child;
  const heap = job.heapMiB ? `--max-old-space-size=${job.heapMiB}` : '';
  const inherited = (process.env.NODE_OPTIONS ?? '').replace(/--max[-_]old[-_]space[-_]size(?:=|\s+)\d+/g, '').replace(/--import(?:=|\s+)"?[\S]*remediation-verify\.mjs"?/g, '').trim();
  const env = { ...process.env, ...job.env, NODE_OPTIONS: [inherited, heap, `--import=${JSON.stringify(pathToFileURL(SCRIPT).href)}`].filter(Boolean).join(' '),
    CHISA_VERIFY_RESOURCE_DIRECTORY: resourceDirectory, CHISA_VERIFY_CHANNEL: job.id };
  // A self-test may launch a real independent Node runner; never inherit the parent's internal test-worker marker.
  delete env.NODE_TEST_CONTEXT;
  const args = job.args.map(arg => arg.replaceAll('__REPORT__', reportPath));
  let timer;
  const requestStop = reason => { if (reason === 'timeout') timedOut = true; else cancelled = true; if (child) void stopTree(child); };
  const onAbort = () => requestStop('cancelled');
  let exit = { code: null, signal: null };
  try {
    if (options.signal?.aborted) cancelled = true;
    else {
      child = spawn(job.command, args, { cwd: job.cwd, env, stdio: ['ignore', out, err], windowsHide: true, detached: process.platform !== 'win32' });
      options.signal?.addEventListener('abort', onAbort, { once: true });
      timer = setTimeout(() => requestStop('timeout'), options.timeoutMs ?? 900_000);
      exit = await new Promise(resolve => {
        child.once('error', error => { launchError = errorText(error); resolve({ code: null, signal: null }); });
        child.once('close', (code, signal) => resolve({ code, signal }));
      });
    }
  } catch (error) { launchError = errorText(error); }
  finally { clearTimeout(timer); options.signal?.removeEventListener('abort', onAbort); closeSync(out); closeSync(err); }
  let parsed = null; let parseError = null;
  try { parsed = parseReport(job.format, await readFile(job.format === 'vitest' ? reportPath : stdoutPath, 'utf8')); } catch (error) { parseError = errorText(error); }
  const resources = [];
  if (existsSync(resourceDirectory)) for (const entry of await readdir(resourceDirectory)) {
    try { resources.push(JSON.parse(await readFile(path.join(resourceDirectory, entry), 'utf8'))); } catch { /* retain missing resource warning below */ }
  }
  return { id: job.id, channel: job.channel, command: job.command, args, cwd: job.cwd, files: job.files,
    startedAt: new Date(Date.now() - (performance.now() - start)).toISOString(), durationMs: Math.round(performance.now() - start),
    exitCode: exit.code, signal: exit.signal, timedOut, cancelled, launchError, parseError,
    success: exit.code === 0 && !timedOut && !cancelled && !launchError && !parseError && parsed?.successful !== false && !(parsed?.parseErrors.length),
    report: parsed, stdoutPath, stderrPath, reportPath: job.format === 'vitest' ? reportPath : null,
    memory: { nodeProcesses: resources, sampledNodeProcessPeakRssBytes: resources.length ? Math.max(...resources.map(item => item.maxRssBytes ?? item.rssSamplePeakBytes)) : null,
      processTreePeakBytes: null, limitation: 'Per-node-process OS high-water/samples only; no aggregate process-tree peak. Non-Node children including Go have no measured resource usage here; killed children may lack final samples.' } };
}

function normalizeFile(file, manifest, cwd) {
  return slash(path.relative(manifest.projectRoot, path.isAbsolute(file) ? file : path.resolve(cwd, file)));
}
export function coverageFromResults(manifest, plan, results) {
  const selected = plan.selected.filter(channel => Object.hasOwn(manifest.tests, channel)); const observed = [];
  const go = results.find(item => item.id === 'go-inventory')?.report?.inventory;
  const excludedByGo = [];
  for (const result of results) {
    if (['client', 'server', 'runner'].includes(result.channel)) observed.push(...(result.report?.files ?? []).map(file => normalizeFile(file, manifest, result.cwd)));
    if (result.id === 'go-tests' && result.report?.packages?.length && go) {
      const included = new Set([...(go.TestGoFiles ?? []), ...(go.XTestGoFiles ?? [])]);
      for (const item of manifest.tests.go) {
        if (included.has(path.basename(item.path))) observed.push(item.path);
        else if ((go.IgnoredGoFiles ?? []).includes(path.basename(item.path))) { excludedByGo.push(item.path); observed.push(item.path); }
      }
    }
  }
  return { ...checkCoverage(manifest, observed, selected), goPlatformExcluded: excludedByGo,
    goEvidence: 'Go file coverage is compiler go list TestGoFiles/XTestGoFiles and explicit IgnoredGoFiles constraints, plus observed package completion; per-test execution comes from go test JSON.' };
}

async function versions(service, directory, go) {
  const tools = { node: { version: process.version, executable: process.execPath }, platform: process.platform, architecture: process.arch, packages: {} };
  for (const name of ['vitest', 'tsx', 'typescript', 'oxlint', 'vite', 'npm']) {
    const value = await optionalFile(path.join(service, 'node_modules', name, 'package.json'));
    tools.packages[name] = value ? JSON.parse(value).version : null;
  }
  const npm = npmCommand(service);
  const npmResult = await runCommand({ id: 'npm-version', channel: 'inventory', command: npm.command, args: [...npm.prefix, '--version'], cwd: service,
    files: [], heapMiB: 256, format: 'command' }, { directory, timeoutMs: 10_000 });
  tools.npm = { command: npm.command, arguments: [...npm.prefix, '--version'], version: (await readFile(npmResult.stdoutPath, 'utf8')).trim() || null, exitCode: npmResult.exitCode, error: npmResult.launchError };
  const result = await runCommand({ id: 'go-version', channel: 'inventory', command: go, args: ['version'], cwd: path.dirname(service),
    env: { GOTOOLCHAIN: 'local' }, files: [], heapMiB: null, format: 'command' }, { directory, timeoutMs: 10_000 });
  tools.go = { command: go, version: (await readFile(result.stdoutPath, 'utf8')).trim() || null, exitCode: result.exitCode, error: result.launchError,
    note: 'Inventory probe disables Go auto-download via GOTOOLCHAIN=local; the actual Go gate uses the selected environment/toolchain.' };
  return tools;
}

export async function executePlan(manifest, plan, options) {
  const results = [];
  for (const job of plan.jobs) {
    if (options.signal?.aborted) break;
    options.onJob?.(job);
    results.push(await runCommand(job, options));
  }
  const coverage = coverageFromResults(manifest, plan, results);
  const totals = blankCounts();
  for (const result of results) if (result.report?.counts) for (const key of Object.keys(totals)) totals[key] += result.report.counts[key] ?? 0;
  const firstFailure = results.find(result => !result.success);
  const channels = {};
  for (const name of plan.selected) {
    const grouped = results.filter(item => item.channel === name); const counts = blankCounts();
    for (const item of grouped) if (item.report?.counts) for (const key of Object.keys(counts)) counts[key] += item.report.counts[key] ?? 0;
    channels[name] = { status: !grouped.length ? 'not-run' : grouped.every(item => item.success) ? 'passed' : 'failed',
      counts: grouped.some(item => item.report?.counts) ? counts : null, durationMs: grouped.reduce((sum, item) => sum + item.durationMs, 0),
      maxObservedNodeProcessRssBytes: grouped.some(item => item.memory.sampledNodeProcessPeakRssBytes !== null) ? Math.max(...grouped.map(item => item.memory.sampledNodeProcessPeakRssBytes ?? 0)) : null };
  }
  return { results, totals, channels, coverage, success: !options.signal?.aborted && !firstFailure && results.length === plan.jobs.length && coverage.complete,
    exitCode: options.signal?.aborted ? 130 : firstFailure ? firstFailure.timedOut ? 124 : firstFailure.cancelled ? 130 : firstFailure.exitCode || 1 : coverage.complete ? 0 : 1 };
}

export function parseArguments(args) {
  const value = { run: false, channels: [...CHANNELS], batchSize: 24, heapMiB: 2048, timeoutMs: 900_000, serviceRoot: SERVICE };
  const take = index => { const result = args[index + 1]; if (!result || result.startsWith('--')) throw new Error('Missing value for ' + args[index]); return result; };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--run') value.run = true;
    else if (arg === '--dry-run') value.run = false;
    else if (arg === '--help') value.help = true;
    else if (['--channels', '--batch-size', '--heap-mib', '--timeout-ms', '--output', '--service-root', '--go'].includes(arg)) {
      const next = take(index++);
      if (arg === '--channels') value.channels = [...new Set(next.split(',').filter(Boolean))];
      else if (arg === '--batch-size') value.batchSize = Number(next);
      else if (arg === '--heap-mib') value.heapMiB = Number(next);
      else if (arg === '--timeout-ms') value.timeoutMs = Number(next);
      else if (arg === '--output') value.output = path.resolve(next);
      else if (arg === '--service-root') value.serviceRoot = path.resolve(next);
      else value.go = next;
    } else throw new Error('Unknown argument: ' + arg);
  }
  if (!Number.isInteger(value.timeoutMs) || value.timeoutMs < 50 || value.timeoutMs > 3_600_000) throw new Error('timeout-ms must be 50..3600000');
  return value;
}

export async function main(args = process.argv.slice(2)) {
  const options = parseArguments(args);
  if (options.help) {
    console.log('node scripts/remediation-verify.mjs [--dry-run | --run] [--channels client,server,go,runner,typecheck,lint,build] [--batch-size 24] [--heap-mib 2048] [--timeout-ms 900000] [--output DIR] [--go PATH]\nDefault: dry-run. No dependency installation or application server. Go tests only ../app root package.');
    return 0;
  }
  const started = performance.now(); const manifest = await discover(options.serviceRoot); const plan = createPlan(manifest, options);
  const directory = options.output ?? path.join(manifest.projectRoot, 'docs', 'remediation', '2026-10-31', 'W15-runner', new Date().toISOString().replaceAll(/[:.]/g, '-'));
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'manifest.json'), JSON.stringify({ ...manifest, plan }, null, 2));
  const tools = await versions(manifest.serviceRoot, directory, options.go ?? process.env.CHISA_VERIFY_GO ?? 'go');
  let execution = null; const controller = new AbortController(); const onInterrupt = () => controller.abort();
  process.once('SIGINT', onInterrupt); process.once('SIGTERM', onInterrupt);
  try {
    if (options.run) execution = await executePlan(manifest, plan, { directory, timeoutMs: options.timeoutMs, signal: controller.signal,
      onJob: job => console.log(`[${job.channel}] ${job.id}: ${job.files.length} manifest files`) });
  } finally { process.removeListener('SIGINT', onInterrupt); process.removeListener('SIGTERM', onInterrupt); }
  const after = await discover(options.serviceRoot);
  const sourceStable = manifest.sourceDigest === after.sourceDigest;
  const changedSource = after.source.filter(item => manifest.source.find(before => before.path === item.path)?.sha256 !== item.sha256).map(item => item.path);
  changedSource.push(...manifest.source.filter(item => !after.source.some(next => next.path === item.path)).map(item => item.path));
  const usage = process.resourceUsage();
  const summary = { schemaVersion: 1, mode: options.run ? 'run' : 'dry-run', status: !options.run ? 'not-run' : execution.success && sourceStable ? 'passed' : 'failed',
    createdAt: new Date().toISOString(), durationMs: Math.round(performance.now() - started), tools,
    source: { before: manifest.sourceDigest, after: after.sourceDigest, stable: sourceStable, changed: changedSource, dependencyDigest: manifest.dependencyDigest },
    limits: { heapMiBPerNodeProcess: plan.heapMiB, ...plan.concurrency, timeoutMsPerJob: options.timeoutMs },
    tests: execution?.totals ?? null, channels: execution?.channels ?? null, coverage: execution?.coverage ?? null, plannedCoverage: plan.plannedCoverage,
    results: execution?.results ?? [], runnerMemory: { rssBytes: process.memoryUsage().rss, maxRssBytes: usage.maxRSS > 0 ? usage.maxRSS * 1024 : null },
    exitCode: execution ? !sourceStable && execution.exitCode === 0 ? 1 : execution.exitCode : 0 };
  await writeFile(path.join(directory, 'summary.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify({ status: summary.status, tests: summary.tests, sourceStable, exitCode: summary.exitCode,
    discovered: Object.fromEntries(Object.entries(manifest.tests).map(([channel, files]) => [channel, files.length])), directory }));
  return summary.exitCode;
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT) {
  main().then(code => { process.exitCode = code; }, error => { console.error(errorText(error)); process.exitCode = 1; });
}
