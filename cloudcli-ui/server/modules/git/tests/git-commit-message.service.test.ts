import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { createGitCommitMessageService } from '../git-commit-message.service.js';

const execute = promisify(execFile);

for (const hasCommits of [false, true]) {
  test(`real Git snapshot includes ${hasCommits ? 'tracked edits and untracked content' : 'initial staged changes'} without mutating the repository`, async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'git-ai-snapshot-'));
    const git = (args: string[]) => execute('git', ['--no-optional-locks', ...args], { cwd: root });
    try {
      await git(['init', '-b', 'main']);
      await git(['config', 'core.autocrlf', 'false']);
      await fs.writeFile(path.join(root, 'file.txt'), hasCommits ? 'old value\n' : 'initial value\n');
      await git(['add', '--', 'file.txt']);
      if (hasCommits) {
        await git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'base']);
        await fs.writeFile(path.join(root, 'file.txt'), 'new value\n');
        await fs.writeFile(path.join(root, 'new 中文.txt'), 'new untracked text\n');
      }
      const before = (await git(['status', '--porcelain=v1', '-z'])).stdout;
      const indexBefore = (await git(['ls-files', '--stage'])).stdout;
      let prompt = '';
      const service = createGitCommitMessageService({
        resolveProjectPath: async () => root,
        validateRepository: async () => { assert.equal((await git(['rev-parse', '--is-inside-work-tree'])).stdout.trim(), 'true'); },
        repositoryHasCommits: async () => hasCommits,
        runCommand: (_command, args, options) => execute('git', ['--no-optional-locks', ...args], { cwd: options.cwd }),
        fileSystem: fs as never,
        queryClaude: async (command, options, writer) => {
          prompt = command;
          assert.equal(options.permissionMode, 'plan');
          assert.equal(writer.userId, 'owner');
          writer.send({ kind: 'text', role: 'assistant', content: 'fix: summarize actual snapshot' });
        },
        queryCursor: async () => { assert.fail('unexpected Cursor'); },
      });
      const message = await service.generate({ projectId: 'fixture', files: hasCommits ? ['file.txt', 'new 中文.txt'] : ['file.txt'], provider: 'claude', userId: 'owner' });
      assert.equal(message, 'fix: summarize actual snapshot');
      if (hasCommits) {
        assert.match(prompt, /-old value\n\+new value/);
        assert.match(prompt, /new 中文\.txt \(new file\)/);
        assert.match(prompt, /new untracked text/);
      } else assert.match(prompt, /\+initial value/);
      assert.equal((await git(['status', '--porcelain=v1', '-z'])).stdout, before);
      assert.equal((await git(['ls-files', '--stage'])).stdout, indexBefore);
    } finally {
      assert.equal(path.dirname(root), os.tmpdir());
      await fs.rm(root, { recursive: true, force: true });
    }
  });
}
