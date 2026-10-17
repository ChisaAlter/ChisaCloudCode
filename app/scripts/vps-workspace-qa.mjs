import assert from 'node:assert/strict';
import { bridgeFileSystem, runWorkspaceCommand, workspaceQuery } from '/tmp/chisa-vps-backend-qa/server/modules/workspace-bridge/workspace-bridge.service.js';

const [root, phase] = process.argv.slice(2);
const fs = bridgeFileSystem({});
if (phase === 'busy') {
  await assert.rejects(runWorkspaceCommand(root, 'pwd', []), error => error.code === 'WORKSPACE_BUSY');
  console.log(JSON.stringify({ phase, blocked: true }));
} else if (phase === 'files') {
  const command = await runWorkspaceCommand(root, 'bash', ['-c', 'pwd && uname -sr && grep -Ei "microsoft|drvfs|9p" /proc/self/mountinfo || true']);
  assert.equal(command.exitCode, 0);
  assert.match(command.stdout, /^\/workspace\nLinux /);
  assert.doesNotMatch(command.stdout, /microsoft|drvfs|WSL|9p/i);
  assert.equal(await fs.readTextFile(root + '/build/asset.txt'), 'tracked asset');
  await assert.rejects(fs.readTextFile(root + '/build/generated.bin'), error => error.code === 'ENOENT');
  await assert.rejects(fs.readTextFile(root + '/node_modules/excluded.txt'), error => error.code === 'ENOENT');
  await assert.rejects(fs.readTextFile(root + '/.chisa-bridge.json'));
  const entries = [];
  for await (const entry of fs.openDirectory(root)) entries.push(entry.name);
  assert.ok(!entries.includes('.chisa-bridge.json'));
  const snapshot = await fs.readTextSnapshot(root + '/state.txt');
  assert.equal(snapshot.content, 'local seed');
  await fs.writeTextSnapshot(root + '/state.txt', 'server edit', snapshot.hash);
  await assert.rejects(fs.writeTextSnapshot(root + '/state.txt', 'stale overwrite', snapshot.hash), error => error.code === 'CONTENT_CONFLICT');
  let result = await runWorkspaceCommand(root, 'git', ['add', 'state.txt']);
  assert.equal(result.exitCode, 0);
  result = await runWorkspaceCommand(root, 'git', ['-c', 'user.name=Chisa QA', '-c', 'user.email=qa@localhost', 'commit', '-m', 'VPS QA edit']);
  assert.equal(result.exitCode, 0, result.stderr);
  console.log(JSON.stringify({ phase, kernel: command.stdout.trim(), files: entries, casProtected: true, gitCommitted: true }));
} else if (phase === 'cloud') {
  let sessionId;
  const reports = [];
  async function turn(prompt, resume) {
    const answers = [];
    for await (const message of workspaceQuery({ prompt, options: {
      cwd: root, model: 'claude-haiku-4-5', maxTurns: 6, maxBudgetUsd: 0.15,
      permissionMode: 'default', systemPrompt: { type: 'preset', preset: 'claude_code' },
      env: { ...process.env }, ...(resume ? { resume } : {}),
    } })) {
      if (message.type === 'system' && message.subtype === 'init') sessionId = message.session_id;
      if (message.type === 'assistant') for (const block of message.message.content) if (block.type === 'text') answers.push(block.text);
      if (message.type === 'result') {
        assert.equal(message.is_error, false, JSON.stringify(message));
        reports.push({ subtype: message.subtype, cost: message.total_cost_usd, answer: answers.join('\n') });
      }
    }
    return answers.join('\n');
  }
  const first = await turn('Use the workspace tools to execute pwd and uname -sr and inspect /proc/self/mountinfo for microsoft, drvfs or 9p. State the actual runtime environment. Then create /workspace/claude-proof.txt containing exactly VPS Claude proof. Do not change other files.');
  assert.match(first, /Linux|VPS|server/i);
  assert.equal(await fs.readTextFile(root + '/claude-proof.txt'), 'VPS Claude proof');
  await turn('/compact Preserve the environment diagnosis and command evidence.', sessionId);
  const after = await turn('Re-run pwd and uname -sr using the workspace tool. Are both Claude Code and project tools executing on the VPS? Answer briefly using actual evidence.', sessionId);
  assert.match(after, /VPS|server/i);
  assert.doesNotMatch(after, /running (?:on|in) (?:Windows|WSL)/i);
  console.log(JSON.stringify({ phase, sessionId, reports }));
} else throw new Error('Unknown QA phase');
