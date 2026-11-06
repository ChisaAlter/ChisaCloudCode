import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { checkCoverage, coverageFromResults, createPlan, discover, executePlan, main, parseArguments, parseReport, runCommand } from '../remediation-verify.mjs';

const reporter = fileURLToPath(new URL('../remediation-verify.mjs', import.meta.url));
const temporary = await mkdtemp(path.join(os.tmpdir(), 'chisa-verify-selftest-'));
let sequence = 0;
async function fixture() {
  const project = path.join(temporary, 'project-' + sequence++); const service = path.join(project, 'cloudcli-ui');
  const put = async (name, text) => { const filename = path.join(project, name); await mkdir(path.dirname(filename), { recursive: true }); await writeFile(filename, text); return filename; };
  await put('cloudcli-ui/package.json', JSON.stringify({ scripts: { typecheck: 'tsc', lint: 'oxlint', build: 'vite build' } }));
  await put('cloudcli-ui/package-lock.json', '{"lockfileVersion":3}');
  await put('cloudcli-ui/vitest.config.ts', 'export default {test:{include:["src/**/*.test.ts","src/**/*.test.tsx"]}};');
  await put('cloudcli-ui/src/a.test.ts', 'export {};'); await put('cloudcli-ui/src/b.test.tsx', 'export {};');
  await put('cloudcli-ui/server/a.test.ts', 'export {};'); await put('cloudcli-ui/server/b.test.js', 'export {};');
  await put('cloudcli-ui/scripts/tests/remediation-verify.test.mjs', 'export {};');
  await put('cloudcli-ui/src/archive/ignored.test.ts', 'throw Error("not active");');
  await put('cloudcli-ui/server/node_modules/ignored.test.ts', 'throw Error("not active");');
  await put('cloudcli-ui/src/specs/unselected.spec.ts', 'export {};');
  await put('app/go.mod', 'module fixture\n\ngo 1.20\n'); await put('app/current_test.go', 'package fixture\n');
  await put('app/windows_test.go', '//go:build windows\n\npackage fixture\n');
  await put('app/build/archive/bad_test.go', 'panic("not active")'); await put('diagnostics/archive/test_test.go', 'panic("not active")');
  return { project, service, put };
}
function fakeJob(id, args, cwd, format = 'command') { return { id, channel: 'fixture', command: process.execPath, args, cwd, files: [], heapMiB: 256, format }; }
const runOptions = () => ({ directory: path.join(temporary, 'run-' + sequence++), timeoutMs: 5000 });

test('discovery covers exact active client/server/runner patterns and only Go root package', async () => {
  const value = await fixture(); const result = await discover(value.service);
  assert.deepEqual(Object.fromEntries(Object.entries(result.tests).map(([key, files]) => [key, files.length])), { client: 2, server: 2, go: 2, runner: 1 });
  assert.ok(!result.source.some(item => item.path.includes('/build/') || item.path.includes('/node_modules/') || item.path.includes('/archive/')));
  assert.equal(result.tests.go.find(item => item.path.endsWith('windows_test.go')).buildConstraint, 'windows');
  assert.equal(result.sourceDigest.length, 64); assert.equal(result.dependencyDigest.length, 64);
  await value.put('cloudcli-ui/src/a.test.ts', 'export const changed = true;'); assert.notEqual((await discover(value.service)).sourceDigest, result.sourceDigest);
});

test('discovery tracks exact native embeds, operator policy, vendored inputs and new script suites without archived trees', async () => {
  const value = await fixture();
  const inputs = [
    'cloudcli-ui/vendor/builtin-plugins/plugin/src/live.js',
    'cloudcli-ui/vendor/eslint-plugin-import-x/lib/index.js',
    'cloudcli-ui/vendor/eslint-plugin-import-x-4.17.1-chisa.1.tgz',
    'cloudcli-ui/scripts/tests/server-bundle-boundary.test.mjs',
    'cloudcli-ui/LICENSE', 'cloudcli-ui/README.md',
    'app/resources/service.json', 'app/resources/ssh-workspace.ps1',
    'app/scripts/build-installer.mjs', 'app/installer/nsis-3.13-integrity.json',
    'ops/workspace-broker/authority/authority.mjs',
  ];
  for (const input of inputs) await value.put(input, 'fixture input');
  await value.put('cloudcli-ui/vendor/unrelated-cache/unselected.js', 'not an active input');
  await value.put('app/resources/private-user-journal.json', 'not an embed');
  await value.put('ops/archive/unselected.mjs', 'not an active input');
  const before = await discover(value.service);
  for (const input of inputs) assert.ok(before.source.some(item => item.path === input), input);
  assert.equal(before.tests.runner.length, 2);
  assert.equal(createPlan(before, { channels: ['runner'] }).plannedCoverage.complete, true);
  assert.ok(!before.source.some(item => item.path.includes('unrelated-cache') || item.path.includes('private-user-journal') || item.path.includes('ops/archive/')));
  await value.put('app/resources/service.json', 'changed embedded runtime contract');
  assert.notEqual((await discover(value.service)).sourceDigest, before.sourceDigest);
});

test('plans partition every test once and use bounded serial workers and correct backend aliases', async () => {
  const value = await fixture(); const manifest = await discover(value.service); const plan = createPlan(manifest, { batchSize: 1, heapMiB: 512 });
  assert.equal(plan.plannedCoverage.complete, true);
  assert.equal(plan.jobs.filter(job => job.channel === 'client').length, 2);
  assert.ok(plan.jobs.filter(job => job.channel === 'client').every(job => job.args.includes('--maxWorkers=1') && job.args.includes('--no-file-parallelism')));
  assert.ok(plan.jobs.filter(job => job.channel === 'server').every(job => job.args.includes('server/tsconfig.json') && job.args.includes('--experimental-test-module-mocks') && job.args.includes('--test-concurrency=1')));
  assert.deepEqual(plan.jobs.find(job => job.id === 'go-tests').args, ['test', '-json', '-count=1', '-p=1', '-timeout=15m', '.']);
  const incomplete = checkCoverage(manifest, plan.jobs.flatMap(job => job.files).slice(1)); assert.equal(incomplete.complete, false); assert.equal(incomplete.missing.length, 1);
  const duplicated = checkCoverage(manifest, [...plan.jobs.flatMap(job => job.files), manifest.tests.client[0].path]); assert.equal(duplicated.complete, false); assert.equal(duplicated.duplicate.length, 1);
});

test('discovery refuses changed Vitest configuration and unknown channels rather than silently dropping files', async () => {
  const value = await fixture(); await value.put('cloudcli-ui/vitest.config.ts', 'export default {test:{include:["src/**/*.spec.ts"]}}');
  const manifest = await discover(value.service); assert.throws(() => createPlan(manifest), /Vitest include changed/);
  manifest.discovery.configurationErrors = []; assert.throws(() => createPlan(manifest, { channels: ['unknown'] }), /Unknown channel/);
});

test('dry-run is default, writes manifest and never executes package scripts', async () => {
  const value = await fixture(); const output = path.join(temporary, 'dry-run');
  await value.put('cloudcli-ui/package.json', JSON.stringify({ scripts: { typecheck: 'throw', lint: 'throw', build: 'throw' } }));
  const exit = await main(['--service-root', value.service, '--output', output]); assert.equal(exit, 0);
  const result = JSON.parse(await readFile(path.join(output, 'summary.json'), 'utf8'));
  assert.equal(result.mode, 'dry-run'); assert.equal(result.status, 'not-run'); assert.equal(result.tests, null); assert.deepEqual(result.results, []);
  assert.equal(result.plannedCoverage.expected, 7); assert.equal(result.source.stable, true);
});

test('real child failure preserves exit 7 and keeps stdout/stderr evidence', async () => {
  const options = runOptions();
  const result = await runCommand(fakeJob('exit-seven', ['-e', 'console.log("fixture-out");console.error("fixture-err");process.exit(7)'], temporary), options);
  assert.equal(result.exitCode, 7); assert.equal(result.success, false); assert.equal(result.timedOut, false);
  assert.match(await readFile(result.stdoutPath, 'utf8'), /fixture-out/); assert.match(await readFile(result.stderrPath, 'utf8'), /fixture-err/);
  assert.ok(result.memory.nodeProcesses.length > 0); assert.ok(result.memory.sampledNodeProcessPeakRssBytes > 0); assert.equal(result.memory.processTreePeakBytes, null);
});

test('real Node reporter counts pass fail skip todo without interpreting them all as success', async () => {
  const file = path.join(temporary, 'reporter-fixture.test.mjs');
  await writeFile(file, 'import test from "node:test";import assert from "node:assert/strict";test("passes",()=>{});test.skip("skips",()=>{});test.todo("todo");test("fails",()=>assert.fail("expected fake failure"));');
  const result = await runCommand(fakeJob('node-report', ['--test', '--test-concurrency=1', '--test-reporter=' + pathToFileURL(reporter).href, file], temporary, 'node'), runOptions());
  assert.equal(result.exitCode, 1); assert.equal(result.report.counts.pass, 1); assert.equal(result.report.counts.fail, 1); assert.equal(result.report.counts.skip, 1); assert.equal(result.report.counts.todo, 1); assert.equal(result.report.counts.tests, 4);
  assert.ok(result.report.files.includes(file)); assert.equal(result.report.parseErrors.length, 0); assert.equal(result.success, false);
});

test('reporter retains a suite import failure diagnostic before any test cases exist', async () => {
  const file = path.join(temporary, 'import-failure-fixture.test.mjs');
  await writeFile(file, 'console.error("fixture import diagnostic");throw new Error("fixture import rejected");');
  const result = await runCommand(fakeJob('import-failure-report', ['--test', '--test-reporter=' + pathToFileURL(reporter).href, file], temporary, 'node'), runOptions());
  assert.equal(result.exitCode, 1);
  assert.equal(result.success, false);
  const output = await readFile(result.stdoutPath, 'utf8');
  assert.match(output, /test:stderr/);
  assert.match(output, /fixture import diagnostic/);
  assert.match(output, /fixture import rejected/);
  assert.equal(result.report.counts.fail, 1);
});

test('timeout terminates a real hanging process and reports timeout independently of platform kill exit', async () => {
  const result = await runCommand(fakeJob('hang', ['-e', 'setInterval(()=>{},1000)'], temporary), { ...runOptions(), timeoutMs: 250 });
  assert.equal(result.timedOut, true); assert.equal(result.cancelled, false); assert.equal(result.success, false); assert.ok(result.durationMs < 10_000);
});

test('AbortSignal cancels a hanging process and cannot be recorded as pass', async () => {
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 250);
  const result = await runCommand(fakeJob('cancel', ['-e', 'setInterval(()=>{},1000)'], temporary), { ...runOptions(), signal: controller.signal }); clearTimeout(timer);
  assert.equal(result.cancelled, true); assert.equal(result.timedOut, false); assert.equal(result.success, false);
});

test('Node coverage requires completion and cannot count enqueue-only or imported helper tests as executed entries', () => {
  const summary = { type: 'test:summary', data: { success: true, counts: { tests: 1, passed: 1 } } };
  const parsed = parseReport('node', [{ type: 'test:enqueue', data: { file: '/not-run.test.ts' } },
    { type: 'test:complete', data: { file: '/imported-helper.test.ts', entryFile: '/actual-entry.test.ts' } }, summary].map(item => JSON.stringify(item)).join('\n'));
  assert.deepEqual(parsed.files, ['/actual-entry.test.ts']);
});

test('coverage uses observed reporter files and explicit Go compiler exclusions, never planned files as execution proof', async () => {
  const value = await fixture(); const manifest = await discover(value.service); const plan = createPlan(manifest, { channels: ['client', 'go'] });
  const failed = coverageFromResults(manifest, plan, [{ channel: 'client', cwd: value.service, report: { files: [path.join(value.service, 'src/a.test.ts')] } }]);
  assert.equal(failed.complete, false); assert.equal(failed.missing.length, 3);
  const passed = coverageFromResults(manifest, plan, [{ channel: 'client', cwd: value.service, report: { files: manifest.tests.client.map(item => path.join(value.project, item.path)) } },
    { id: 'go-inventory', report: { inventory: { TestGoFiles: ['current_test.go'], IgnoredGoFiles: ['windows_test.go'] } } },
    { id: 'go-tests', report: { packages: [{ Action: 'pass', Package: 'fixture' }] } }]);
  assert.equal(passed.complete, true); assert.deepEqual(passed.goPlatformExcluded, ['app/windows_test.go']);
});

test('unified execution returns actual first nonzero exit and timeout 124 instead of swallowing failures', async () => {
  const value = await fixture(); const manifest = await discover(value.service);
  const plan = { selected: [], jobs: [fakeJob('fake-failure', ['-e', 'process.exit(7)'], temporary)] };
  const failure = await executePlan(manifest, plan, runOptions()); assert.equal(failure.exitCode, 7); assert.equal(failure.success, false);
  const timeout = await executePlan(manifest, { selected: [], jobs: [fakeJob('fake-timeout', ['-e', 'setInterval(()=>{},1000)'], temporary)] }, { ...runOptions(), timeoutMs: 200 });
  assert.equal(timeout.exitCode, 124); assert.equal(timeout.success, false);
});

test('Vitest and Go structured summaries distinguish skips and malformed/missing reports', () => {
  assert.deepEqual(parseReport('vitest', JSON.stringify({ success: true, numTotalTests: 5, numPassedTests: 3, numFailedTests: 0, numPendingTests: 1, numTodoTests: 1, testResults: [] })).counts,
    { tests: 5, pass: 3, fail: 0, skip: 1, todo: 1, cancelled: 0 });
  const go = parseReport('go', [{ Action: 'pass', Test: 'TestOne', Package: 'fixture' }, { Action: 'skip', Test: 'TestSkip', Package: 'fixture' }, { Action: 'pass', Package: 'fixture', Elapsed: 0.5 }].map(item => JSON.stringify(item)).join('\n'));
  assert.equal(go.counts.tests, 2); assert.equal(go.counts.skip, 1); assert.equal(go.durationMs, 500); assert.equal(go.successful, true);
  assert.throws(() => parseReport('node', ''), /test:summary/); assert.throws(() => parseReport('vitest', ''), /JSON/);
});

test('argument validation cannot enable runs implicitly or accept unsupported resource limits', () => {
  assert.equal(parseArguments([]).run, false); assert.equal(parseArguments(['--run']).run, true);
  assert.equal(parseArguments(['--run', '--dry-run']).run, false);
  assert.throws(() => parseArguments(['--timeout-ms', '0']), /timeout/); assert.throws(() => parseArguments(['--unknown']), /Unknown argument/);
});
