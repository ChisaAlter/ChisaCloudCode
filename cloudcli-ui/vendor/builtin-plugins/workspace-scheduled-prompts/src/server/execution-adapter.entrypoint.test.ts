import assert from 'node:assert/strict';
import test from 'node:test';

import { LocalExecutionAdapter } from './execution-adapter.js';
import type { ExecutionProfile, WorkspaceTask } from '../shared/model.js';

test('scheduled child receives app attribution and task metadata without mutating host environment', async () => {
  const previous = process.env.CLAUDE_CODE_ENTRYPOINT;
  const task: WorkspaceTask = {
    id: 'fixture-task', workspaceKey: 'fixture', workspacePath: process.cwd(), name: 'fixture-name', prompt: 'fixture-prompt',
    recurrence: { scheduleType: 'one_time', timezone: 'UTC', runAt: '2026-10-28T00:00:00Z' },
    recurrenceSummary: 'once', enabled: true, nextRunAt: null, lastRunStatus: null, createdAt: '', updatedAt: '',
  };
  // A local Node child proves the actual spawn environment without running Claude or a model.
  const source = 'process.stdout.write(JSON.stringify({entrypoint:process.env.CLAUDE_CODE_ENTRYPOINT,prompt:process.env.SCHEDULED_PROMPT,id:process.env.SCHEDULED_TASK_ID}));process.stdin.resume();';
  const profile: ExecutionProfile = { workspaceKey: 'fixture', command: process.execPath, args: ['-e', source],
    timeoutMs: 5000, mode: 'local_command', lastValidatedAt: null, validationStatus: 'ready' };
  try {
    for (const inherited of [undefined, '', 'sdk-cli', 'sdk-ts', 'cli', 'other-client']) {
      if (inherited === undefined) delete process.env.CLAUDE_CODE_ENTRYPOINT;
      else process.env.CLAUDE_CODE_ENTRYPOINT = inherited;
      const result = await new LocalExecutionAdapter().execute(task, profile, '2026-10-28T00:00:00Z');
      assert.equal(result.status, 'succeeded', result.failureReason ?? result.outcomeSummary);
      const output = JSON.parse(result.outcomeSummary.split('stdout: ')[1]!);
      assert.deepEqual(output, { entrypoint: 'chisacloudcode', prompt: task.prompt, id: task.id });
      assert.equal(process.env.CLAUDE_CODE_ENTRYPOINT, inherited);
    }
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_CODE_ENTRYPOINT;
    else process.env.CLAUDE_CODE_ENTRYPOINT = previous;
  }
});
