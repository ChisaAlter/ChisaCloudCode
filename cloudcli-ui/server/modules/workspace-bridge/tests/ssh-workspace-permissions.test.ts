import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

import type { Options } from '@anthropic-ai/claude-agent-sdk';

import type { SshProjectTarget } from '@/shared/index.js';

let captured: Options | undefined;
mock.module('@anthropic-ai/claude-agent-sdk', { namedExports: {
  tool: (name: string, description: string, schema: unknown, handler: unknown) => ({ name, description, schema, handler }),
  createSdkMcpServer: (server: unknown) => server,
  query: (input: { options: Options }) => {
    captured = input.options;
    return Object.assign((async function* () { yield { type: 'result', subtype: 'success' }; })(), { close() {} });
  },
} });
const { sshWorkspaceQuery } = await import('../ssh-workspace-query.service.js');
const target: SshProjectTarget = { projectId: 'project', ownerId: 'owner', connectionId: 'desktop', connectionLabel: 'Desktop',
  rootPath: 'C:\\Project', rootIdentity: 'root-id', generation: 'generation', workspaceId: 'workspace', anchorPath: '/metadata/project',
  phase: 'idle', activeRunId: null, pendingJobId: null };
const context: Parameters<NonNullable<Options['canUseTool']>>[2] = { signal: new AbortController().signal, toolUseID: 'decision', requestId: 'ssh-workspace-permission-request' };
const command = 'mcp__workspace__run_command';
const write = 'mcp__workspace__write_file';

async function optionsFor(options: Options = {}): Promise<Options> {
  captured = undefined;
  let closed = 0;
  const admission = { assertCurrent() {}, close: async () => { closed++; }, execute: async () => ({ ok: true }) };
  const stream = sshWorkspaceQuery({ prompt: 'fixture', options }, target, (async () => admission) as never);
  for await (const _message of stream) { /* Inspect final SDK options after real adapter mapping. */ }
  assert.equal(closed, 1);
  const actual = captured as Options | undefined;
  assert.ok(actual);
  return actual;
}

test('default SSH mode does not auto-approve Windows writes or shell commands', async () => {
  const decisions: string[] = [];
  const mapped = await optionsFor({ canUseTool: async (name, input) => {
    decisions.push(name);
    return { behavior: 'deny', message: 'user declined ' + input.command };
  } });
  assert.equal(mapped.allowedTools!.includes(command), false);
  assert.equal(mapped.allowedTools!.includes(write), false);
  assert.ok(mapped.allowedTools!.includes('mcp__workspace__read_file'));
  const commandDecision = await mapped.canUseTool!(command, { command: 'npm.cmd test' }, context);
  assert.ok(commandDecision, 'Windows command approval returns an explicit decision');
  assert.equal(commandDecision.behavior, 'deny');
  const writeDecision = await mapped.canUseTool!(write, { path: '/workspace/file' }, context);
  assert.ok(writeDecision, 'Windows write approval returns an explicit decision');
  assert.equal(writeDecision.behavior, 'deny');
  assert.deepEqual(decisions, [command, write]);
});

test('SSH approval forwards the exact Windows command and preserves the explicit decision', async () => {
  const mapped = await optionsFor({ canUseTool: async (name, input) => {
    assert.equal(name, command);
    assert.equal(input.command, 'npm.cmd test');
    return { behavior: 'allow', updatedInput: { ...input, timeoutSeconds: 30 } };
  } });
  const decision = await mapped.canUseTool!(command, { command: 'npm.cmd test' }, context);
  assert.ok(decision, 'the explicit approval must not become an out-of-band null response');
  assert.deepEqual(decision, { behavior: 'allow', updatedInput: { command: 'npm.cmd test', timeoutSeconds: 30 } });
});

test('acceptEdits grants file writes but still requires Windows command approval', async () => {
  const mapped = await optionsFor({ permissionMode: 'acceptEdits' });
  assert.ok(mapped.allowedTools!.includes(write));
  assert.equal(mapped.allowedTools!.includes(command), false);
  const commandDecision = await mapped.canUseTool!(command, { command: 'anything' }, context);
  assert.ok(commandDecision, 'acceptEdits still returns an explicit command denial');
  assert.equal(commandDecision.behavior, 'deny');
  const writeDecision = await mapped.canUseTool!(write, { content: 'edit' }, context);
  assert.ok(writeDecision, 'acceptEdits returns an explicit file write decision');
  assert.equal(writeDecision.behavior, 'allow');
});

test('explicit deny rules override read defaults, edit mode, and saved allow rules', async () => {
  const mapped = await optionsFor({ permissionMode: 'acceptEdits', allowedTools: ['Bash', 'Write', 'Read'], disallowedTools: ['Bash', 'Write', 'Read'] });
  for (const name of [command, write, 'mcp__workspace__read_file', 'mcp__workspace__read_image']) {
    assert.equal(mapped.allowedTools!.includes(name), false);
    assert.ok(mapped.disallowedTools!.includes(name));
    const decision = await mapped.canUseTool!(name, {}, context);
    assert.ok(decision, 'explicit deny returns a permission decision for ' + name);
    assert.equal(decision.behavior, 'deny');
  }
});

test('plan exposes no mutation tools and shell-specific saved rules are not PowerShell grants', async () => {
  const plan = await optionsFor({ permissionMode: 'plan', allowedTools: ['Bash', 'Write'] });
  assert.equal(plan.allowedTools!.includes(command), false);
  const planDecision = await plan.canUseTool!(command, { command: 'echo unsafe' }, context);
  assert.ok(planDecision, 'plan mode returns an explicit command denial');
  assert.equal(planDecision.behavior, 'deny');
  const mapped = await optionsFor({ allowedTools: ['Bash(git:*)'] });
  assert.equal(mapped.allowedTools!.includes(command), false);
  const commandDecision = await mapped.canUseTool!(command, { command: 'git status; Remove-Item x' }, context);
  assert.ok(commandDecision, 'shell-specific saved rules retain an explicit Windows command decision');
  assert.equal(commandDecision.behavior, 'deny');
});
