import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import { createProjectContentResolver } from '../project-runtime-content.service.js';

function fixture(initial: Record<string, string> = {}, options: { signal?: AbortSignal; afterRead?: (relative: string) => void; assertCurrent?: () => void } = {}) {
  const files = new Map(Object.entries(initial));
  const reads: string[] = [];
  const lists: string[] = [];
  let checks = 0;
  const resolver = createProjectContentResolver({
    signal: options.signal,
    assertCurrent() { checks++; options.assertCurrent?.(); },
    async read(relative) {
      reads.push(relative);
      options.afterRead?.(relative);
      const content = files.get(relative);
      return content === undefined ? null : { content, hash: createHash('sha256').update(content).digest('hex') };
    },
    async list(relative) {
      lists.push(relative);
      const rows = new Map<string, boolean>();
      for (const file of files.keys()) {
        if (!file.startsWith(relative + '/')) continue;
        const parts = file.slice(relative.length + 1).split('/');
        rows.set(parts[0], (rows.get(parts[0]) ?? false) || parts.length > 1);
      }
      return [...rows].reverse().map(([name, directory]) => ({ name, directory }));
    },
  });
  return { resolver, reads, lists, files, checks: () => checks };
}

const skill = (metadata: string, body = 'Skill instructions.') => `---\n${metadata}\n---\n${body}`;

test('empty project is normal, bounded to fixed config roots and repeatable', async () => {
  const current = fixture();
  const first = await current.resolver.resolve();
  assert.deepEqual(first, { instructions: '', settings: {}, projectSettings: {}, localSettings: {}, sources: [], skills: [], warnings: [] });
  assert.deepEqual(await current.resolver.resolve({ prompt: '/unknown preserved' }), first);
  assert.deepEqual(current.reads, ['CLAUDE.md', '.claude/CLAUDE.md', 'CLAUDE.local.md', '.claude/settings.json', '.claude/settings.local.json']);
  assert.deepEqual(current.lists, ['.claude/rules', '.claude/skills']);
  assert.equal(await current.resolver.rulesForPath('src/index.ts'), '');
  await assert.rejects(current.resolver.activateSkill('missing'), { code: 'PROJECT_RUNTIME_SKILL_NOT_FOUND' });
});

test('root instructions and relative imports have deterministic order, safe in-root parents and one copy', async () => {
  const current = fixture({
    'CLAUDE.md': 'Root start\n@docs/shared.md\n@.claude/CLAUDE.md\nRoot end\n`@no-import.md`\nmail@example.com\n```md\n@also-not-import.md\n```',
    '.claude/CLAUDE.md': 'Project instructions\n@../docs/shared.md',
    'CLAUDE.local.md': 'Local overrides',
    'docs/shared.md': 'Shared import\n@"space name.md"',
    'docs/space name.md': 'Quoted relative import',
  });
  const result = await current.resolver.resolve();
  for (const body of ['Root start', 'Shared import', 'Quoted relative import', 'Project instructions', 'Root end', 'Local overrides']) assert.ok(result.instructions.includes(body));
  assert.equal(result.instructions.match(/Shared import/g)?.length, 1);
  assert.equal(result.instructions.split('\n').filter(line => line === 'Project instructions').length, 1);
  assert.ok(result.instructions.indexOf('Root end') < result.instructions.indexOf('Local overrides'));
  assert.deepEqual(result.sources.map(source => source.path), ['CLAUDE.md', 'docs/shared.md', 'docs/space name.md', '.claude/CLAUDE.md', 'CLAUDE.local.md']);
  assert.ok(result.sources.every(source => source.kind === 'instruction' && /^[a-f0-9]{64}$/.test(source.hash)));
  assert.equal(current.reads.some(relative => relative.includes('no-import') || relative.includes('also-not-import')), false);
});

test('cycle, missing imports and root escapes fail explicitly before external content access', async () => {
  await assert.rejects(fixture({ 'CLAUDE.md': '@a.md', 'a.md': '@CLAUDE.md' }).resolver.resolve(), { code: 'PROJECT_RUNTIME_IMPORT_CYCLE' });
  await assert.rejects(fixture({ 'CLAUDE.md': '@missing.md' }).resolver.resolve(), { code: 'PROJECT_RUNTIME_IMPORT_MISSING' });
  for (const imported of ['../outside.md', '/etc/passwd', 'C:\\secret.md', '\\\\host\\share.md', '~/secret.md']) {
    const current = fixture({ 'CLAUDE.md': '@' + imported });
    await assert.rejects(current.resolver.resolve(), { code: 'PROJECT_RUNTIME_PATH_INVALID' });
    assert.deepEqual(current.reads, ['CLAUDE.md']);
  }
  const current = fixture({ 'CLAUDE.md': '!`echo never-execute`\nExample text' });
  const result = await current.resolver.resolve();
  assert.match(result.instructions, /echo never-execute/);
  assert.match(result.warnings.join('\n'), /never executed/);
});

test('instructions enforce five import edges, aggregate UTF-8 budget and source file cap', async () => {
  const atLimit: Record<string, string> = { 'CLAUDE.md': '@depth1.md' };
  for (let index = 1; index <= 5; index++) atLimit[`depth${index}.md`] = index === 5 ? 'deepest' : `@depth${index + 1}.md`;
  assert.match((await fixture(atLimit).resolver.resolve()).instructions, /deepest/);
  await assert.rejects(fixture({ ...atLimit, 'depth5.md': '@depth6.md', 'depth6.md': 'too deep' }).resolver.resolve(), { code: 'PROJECT_RUNTIME_LIMIT' });
  await assert.rejects(fixture({ 'CLAUDE.md': '汉'.repeat(90_000) }).resolver.resolve(), { code: 'PROJECT_RUNTIME_LIMIT' });
  const many: Record<string, string> = { 'CLAUDE.md': Array.from({ length: 257 }, (_, index) => `@doc${index}.md`).join('\n') };
  for (let index = 0; index < 257; index++) many[`doc${index}.md`] = 'small';
  await assert.rejects(fixture(many).resolver.resolve(), { code: 'PROJECT_RUNTIME_LIMIT' });
});

test('settings merge objects with local precedence and replacement arrays, retaining independent policy layers', async () => {
  const current = fixture({
    '.claude/settings.json': JSON.stringify({ permissions: { allow: ['Read'], deny: ['Bash'] }, env: { FIRST: 'one', SHARED: 'project' }, hooks: { Stop: [] }, numeric: 1 }),
    '.claude/settings.local.json': JSON.stringify({ permissions: { allow: ['Write'] }, env: { SHARED: 'local' }, numeric: null }),
  });
  const result = await current.resolver.resolve();
  assert.deepEqual(result.settings, { permissions: { allow: ['Write'], deny: ['Bash'] }, env: { FIRST: 'one', SHARED: 'local' }, hooks: { Stop: [] }, numeric: null });
  assert.deepEqual((result.projectSettings.permissions as Record<string, unknown>).allow, ['Read']);
  assert.deepEqual(result.localSettings.env, { SHARED: 'local' });
  assert.match(result.warnings.join('\n'), /hooks are unsupported/);
  (result.settings.env as Record<string, unknown>).SHARED = 'caller mutation';
  assert.equal(((await current.resolver.resolve()).settings.env as Record<string, unknown>).SHARED, 'local');
});

test('malformed or unsafe present configuration fails while ENOENT remains normal', async () => {
  for (const content of ['{bad', '[]', 'null', '{"__proto__":{"polluted":true}}', '{"constructor":{}}']) {
    await assert.rejects(fixture({ '.claude/settings.json': content }).resolver.resolve(), { code: 'PROJECT_RUNTIME_CONFIG_INVALID' });
  }
  for (const body of ['---\npaths: [broken\n---\nbody', '---\npaths: x\nbody', '---js\nmodule.exports={bad:true}\n---\nbody', '---\npaths: 3\n---\nbody']) {
    await assert.rejects(fixture({ '.claude/rules/bad.md': body }).resolver.resolve(), { code: 'PROJECT_RUNTIME_CONFIG_INVALID' });
  }
  await assert.rejects(fixture({ '.claude/skills/alias/SKILL.md': skill('description: Alias\nfirst: &shared [one, two]\nsecond: *shared') }).resolver.resolve(), { code: 'PROJECT_RUNTIME_CONFIG_INVALID' });
  const current = createProjectContentResolver({ assertCurrent() {}, async read() { throw Object.assign(new Error('absent'), { code: 'ENOENT' }); }, async list() { throw Object.assign(new Error('absent'), { code: 'ENOENT' }); } });
  assert.equal((await current.resolve()).instructions, '');
});

test('nested rules are stable and scoped paths match only their root-relative targets', async () => {
  const current = fixture({
    '.claude/rules/z-global.md': 'Global rule',
    '.claude/rules/a-typescript.md': skill('paths:\n  - "src/**/*.{ts,tsx}"\n  - "tests/*.test.ts"', 'TypeScript rule'),
    '.claude/rules/nested/api.md': skill('paths: "src/api/**"', 'API rule'),
    '.claude/rules/README.txt': 'Ignored text',
  });
  const result = await current.resolver.resolve();
  assert.match(result.instructions, /Global rule/);
  assert.doesNotMatch(result.instructions, /TypeScript rule|API rule/);
  assert.match(await current.resolver.rulesForPath('/workspace/src/api/index.ts'), /TypeScript rule[\s\S]*API rule/);
  assert.match(await current.resolver.rulesForPath('src/main.tsx'), /TypeScript rule/);
  assert.match(await current.resolver.rulesForPath('tests/main.test.ts'), /TypeScript rule/);
  assert.equal(await current.resolver.rulesForPath('docs/main.ts'), '');
  assert.equal(await current.resolver.rulesForPath('src/main.ts.txt'), '');
  await assert.rejects(current.resolver.rulesForPath('/workspace/../outside'), { code: 'PROJECT_RUNTIME_PATH_INVALID' });
  await assert.rejects(current.resolver.rulesForPath('C:\\outside'), { code: 'PROJECT_RUNTIME_PATH_INVALID' });
  assert.deepEqual(result.sources.filter(source => source.kind === 'rule').map(source => source.path), ['.claude/rules/a-typescript.md', '.claude/rules/nested/api.md', '.claude/rules/z-global.md']);
});

test('rules reject malformed globs, hidden traversal and excessive tree discovery', async () => {
  for (const pattern of ['../outside/**', '/etc/**', 'C:/**', 'src/{a}', 'src/{a,b', 'src/[abc].ts']) {
    await assert.rejects(fixture({ '.claude/rules/rule.md': skill('paths: ' + JSON.stringify(pattern), 'rule') }).resolver.resolve(), { code: 'PROJECT_RUNTIME_CONFIG_INVALID' });
  }
  const many: Record<string, string> = {};
  for (let index = 0; index < 513; index++) many[`.claude/rules/${index}.txt`] = '';
  await assert.rejects(fixture(many).resolver.resolve(), { code: 'PROJECT_RUNTIME_LIMIT' });
  await assert.rejects(fixture({ ['.claude/rules/' + 'nested/'.repeat(9) + 'rule.md']: 'too deep' }).resolver.resolve(), { code: 'PROJECT_RUNTIME_LIMIT' });
});

test('rule matching stays bounded for adversarial wildcards and empty scopes never become global rules', async () => {
  const current = fixture({ '.claude/rules/adversarial.md': skill('paths: ' + JSON.stringify('*a'.repeat(120) + 'b'), 'must never match') });
  await current.resolver.resolve();
  assert.equal(await current.resolver.rulesForPath('a'.repeat(1500)), '');
  await assert.rejects(fixture({ '.claude/rules/empty.md': skill('paths: []', 'must not become global') }).resolver.resolve(), { code: 'PROJECT_RUNTIME_CONFIG_INVALID' });
});

test('cancellation and workspace replacement after a directory await stop discovery immediately', async () => {
  for (const failure of ['abort', 'generation']) {
    const controller = new AbortController();
    let valid = true;
    let lists = 0;
    const current = createProjectContentResolver({ signal: controller.signal,
      assertCurrent() { if (!valid) throw new Error('generation replaced'); },
      async read() { return null; }, async list() {
        lists++;
        if (failure === 'abort') controller.abort(new Error('directory request cancelled')); else valid = false;
        return [{ name: 'subdir', directory: true }];
      } });
    await assert.rejects(current.resolve(), failure === 'abort' ? /directory request cancelled/ : /generation replaced/);
    assert.equal(lists, 1);
  }
});

test('skills expose stable metadata and explicitly activated arguments without reading resource files', async () => {
  const current = fixture({
    '.claude/skills/zebra/SKILL.md': skill('name: zebra\ndescription: Zebra details', 'Zebra body'),
    '.claude/skills/review/SKILL.md': skill('name: review\ndescription: Review changes\nargument-hint: "<branch>"\nallowed-tools: "Read, Bash"', 'All $ARGUMENTS; first $0; second $ARGUMENTS[1]; dir ${CLAUDE_SKILL_DIR}'),
    '.claude/skills/review/references/examples.md': 'resource content must not preload',
  });
  const result = await current.resolver.resolve();
  assert.deepEqual(result.skills.map(item => item.name), ['review', 'zebra']);
  const review = result.skills[0];
  assert.equal(review.description, 'Review changes');
  assert.equal(review.argumentHint, '<branch>');
  assert.deepEqual(review.allowedTools, ['Read', 'Bash']);
  assert.equal(review.userInvocable, true);
  assert.equal(review.disableModelInvocation, false);
  assert.match(result.warnings.join('\n'), /never grants approval/);
  assert.doesNotMatch(result.instructions, /All \$ARGUMENTS|Zebra body/);
  const activated = await current.resolver.activateSkill('review', 'main "feature branch"');
  assert.match(activated.body, /All main "feature branch"; first main; second feature branch/);
  assert.match(activated.body, /\/workspace\/\.claude\/skills\/review/);
  assert.equal(activated.path, '.claude/skills/review/SKILL.md');
  assert.equal(activated.hash, review.hash);
  assert.equal(current.reads.some(relative => relative.endsWith('examples.md')), false);
  assert.equal(current.lists.some(relative => relative.includes('/references')), false);
  assert.match((await current.resolver.resolve({ prompt: '/review main' })).instructions, /All main; first main/);
  assert.equal((await current.resolver.resolve({ prompt: '/unknown argument' })).instructions, result.instructions);
  assert.match((await current.resolver.activateSkill('zebra', 'context')).body, /Arguments: context/);
});

test('skill invocation flags distinguish explicit user invocation and model activation', async () => {
  const current = fixture({
    '.claude/skills/manual/SKILL.md': skill('disable-model-invocation: true', 'Manual body'),
    '.claude/skills/automatic/SKILL.md': skill('user-invocable: false', 'Automatic body'),
  });
  await assert.rejects(current.resolver.activateSkill('manual'), { code: 'PROJECT_RUNTIME_SKILL_UNSUPPORTED' });
  assert.match((await current.resolver.resolve({ prompt: '/manual' })).instructions, /Manual body/);
  await assert.rejects(current.resolver.resolve({ prompt: '/automatic' }), { code: 'PROJECT_RUNTIME_SKILL_UNSUPPORTED' });
  assert.match((await current.resolver.activateSkill('automatic')).body, /Automatic body/);
});

test('unsupported fork, agent, hooks and dynamic execution never activate and explain the rejection', async () => {
  for (const metadata of ['context: fork', 'agent: Explore', 'hooks: {}']) {
    const current = fixture({ '.claude/skills/unsupported/SKILL.md': skill(metadata, 'Do something') });
    const result = await current.resolver.resolve();
    assert.match(result.warnings.join('\n'), /activation is blocked/);
    assert.ok(result.skills[0].unsupported.length);
    await assert.rejects(current.resolver.activateSkill('unsupported'), { code: 'PROJECT_RUNTIME_SKILL_UNSUPPORTED' });
    await assert.rejects(current.resolver.resolve({ prompt: '/unsupported' }), { code: 'PROJECT_RUNTIME_SKILL_UNSUPPORTED' });
  }
  const current = fixture({ '.claude/skills/dynamic/SKILL.md': skill('description: dynamic', '!`whoami`') });
  await assert.rejects(current.resolver.activateSkill('dynamic'), { code: 'PROJECT_RUNTIME_SKILL_UNSUPPORTED' });
  const malformed = fixture({ '.claude/skills/bad/SKILL.md': skill('disable-model-invocation: "yes"') });
  await assert.rejects(malformed.resolver.resolve(), { code: 'PROJECT_RUNTIME_CONFIG_INVALID' });
});

test('skill names are unique, capped at 100, and activation arguments stay bounded', async () => {
  await assert.rejects(fixture({ '.claude/skills/one/SKILL.md': skill('name: duplicate'), '.claude/skills/two/SKILL.md': skill('name: duplicate') }).resolver.resolve(), { code: 'PROJECT_RUNTIME_CONFIG_INVALID' });
  const many: Record<string, string> = {};
  for (let index = 0; index < 101; index++) many[`.claude/skills/s${index}/SKILL.md`] = skill('description: bounded');
  await assert.rejects(fixture(many).resolver.resolve(), { code: 'PROJECT_RUNTIME_LIMIT' });
  const current = fixture({ '.claude/skills/test/SKILL.md': skill('description: test', '$ARGUMENTS') });
  await assert.rejects(current.resolver.activateSkill('test', 'x'.repeat(33 * 1024)), { code: 'PROJECT_RUNTIME_LIMIT' });
  await assert.rejects(current.resolver.activateSkill('test', '"unterminated'), { code: 'PROJECT_RUNTIME_CONFIG_INVALID' });
});

test('skill argument expansion cannot exceed the output budget', async () => {
  const current = fixture({ '.claude/skills/expand/SKILL.md': skill('description: budget', '$ARGUMENTS\n'.repeat(100)) });
  await current.resolver.resolve();
  await assert.rejects(current.resolver.activateSkill('expand', 'x'.repeat(30 * 1024)), { code: 'PROJECT_RUNTIME_LIMIT' });
});

test('every awaited read and cached call rechecks cancellation and the selected workspace identity', async () => {
  const controller = new AbortController();
  const aborted = fixture({ 'CLAUDE.md': 'not returned' }, { signal: controller.signal, afterRead() { controller.abort(new Error('caller disconnected')); } });
  await assert.rejects(aborted.resolver.resolve(), /caller disconnected/);
  assert.deepEqual(aborted.reads, ['CLAUDE.md']);
  let valid = true;
  const current = fixture({ 'CLAUDE.md': 'valid' }, { assertCurrent() { if (!valid) throw new Error('generation changed'); } });
  await current.resolver.resolve();
  assert.ok(current.checks() > current.reads.length + current.lists.length);
  valid = false;
  await assert.rejects(current.resolver.resolve(), /generation changed/);
  await assert.rejects(current.resolver.rulesForPath('src/index.ts'), /generation changed/);
  await assert.rejects(current.resolver.activateSkill('test'), /generation changed/);
});

test('unsafe injected directory entries and malformed read responses are rejected', async () => {
  for (const name of ['../escape', '/absolute', 'C:\\path', 'a/b', '..', '']) {
    const current = createProjectContentResolver({ assertCurrent() {}, async read() { return null; }, async list() { return [{ name, directory: true }]; } });
    await assert.rejects(current.resolve(), { code: 'PROJECT_RUNTIME_PATH_INVALID' });
  }
  const current = createProjectContentResolver({ assertCurrent() {}, async read() { return { content: 'text', hash: '' }; }, async list() { return []; } });
  await assert.rejects(current.resolve(), { code: 'PROJECT_RUNTIME_CONFIG_INVALID' });
});
