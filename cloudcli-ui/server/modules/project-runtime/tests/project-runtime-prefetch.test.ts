import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';
import test from 'node:test';

import { createProjectContentResolver } from '../project-runtime-content.service.js';

const digest = (value: string) => createHash('sha256').update(value).digest('hex');
function fixture(prefetch: boolean, files: Record<string, string>, signal?: AbortSignal) {
  const reads: string[] = [];
  let active = 0, maximum = 0;
  const enter = async () => { active++; maximum = Math.max(maximum, active); await setTimeout(5); active--; };
  const resolver = createProjectContentResolver({ prefetch, signal, assertCurrent() {},
    async read(relative) {
      reads.push(relative);
      await enter();
      const content = files[relative];
      return content === undefined ? null : { content, hash: digest(content) };
    },
    async list(relative) {
      await enter();
      const entries = new Map<string, boolean>();
      for (const key of Object.keys(files)) {
        if (!key.startsWith(relative + '/')) continue;
        const parts = key.slice(relative.length + 1).split('/');
        entries.set(parts[0], Boolean(entries.get(parts[0])) || parts.length > 1);
      }
      return [...entries].map(([name, directory]) => ({ name, directory }));
    },
  });
  return { resolver, reads, maximum: () => maximum };
}

test('remote prefetch overlaps at most four inspections and preserves serial parse/source ordering', async () => {
  const files = {
    'CLAUDE.md': 'Root instructions\n@.claude/CLAUDE.md',
    '.claude/CLAUDE.md': 'Imported instructions',
    'CLAUDE.local.md': 'Local instructions',
    '.claude/settings.json': '{"env":{"FIRST":"one"}}',
    '.claude/settings.local.json': '{"env":{"FIRST":"two"}}',
    '.claude/rules/global.md': 'Global rule',
    '.claude/skills/a/SKILL.md': '---\nname: a\ndescription: First\n---\nFirst skill',
    '.claude/skills/b/SKILL.md': '---\nname: b\ndescription: Second\n---\nSecond skill',
  };
  const serial = fixture(false, files);
  const parallel = fixture(true, files);
  assert.deepEqual(await parallel.resolver.resolve(), await serial.resolver.resolve());
  assert.equal(parallel.reads.filter(relative => relative === '.claude/CLAUDE.md').length, 1, 'prefetched import must not duplicate reads');
  assert.ok(parallel.maximum() > 1);
  assert.ok(parallel.maximum() <= 4);
});

test('prefetch keeps parse failures deterministic and never leaves speculative rejection unhandled', async () => {
  const resolver = createProjectContentResolver({ prefetch: true, assertCurrent() {},
    async read(relative) {
      if (relative === '.claude/settings.local.json') throw new Error('later I/O failure');
      return relative === 'CLAUDE.md' ? { content: '@../outside.md', hash: digest('unsafe') } : null;
    },
    async list() { throw new Error('speculative listing failure'); },
  });
  await assert.rejects(resolver.resolve(), { code: 'PROJECT_RUNTIME_PATH_INVALID' });
  await setTimeout(10);
});

test('prefetch abort prevents queued remote inspections and content cannot escape its original lifetime', async () => {
  const controller = new AbortController();
  let started = 0;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const resolver = createProjectContentResolver({ prefetch: true, signal: controller.signal, assertCurrent() {},
    async read() { started++; await gate; return null; },
    async list() { started++; await gate; return []; },
  });
  const result = resolver.resolve();
  await setTimeout(0);
  assert.equal(started, 4);
  controller.abort(new Error('caller canceled'));
  release();
  await assert.rejects(result, /caller canceled/);
  await setTimeout(0);
  assert.equal(started, 4);
});
