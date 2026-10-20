import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { mock } from 'node:test';

import { sessionsDb } from '@/modules/database/index.js';
import { CLAUDE_PREDEFINED_MODELS, extractClaudeEventModel, ClaudeProviderModels } from '@/modules/providers/list/claude/claude-models.provider.js';
import { extractClaudeResolvedModel } from '@/shared/utils.js';

const SESSION_ID = 'session-1';

test('fixed Opus versions have distinct IDs and automatic aliases remain available', () => {
  const options = CLAUDE_PREDEFINED_MODELS.OPTIONS;
  assert.deepEqual(options.slice(0, 4).map(({ value, label }) => ({ value, label })), [
    { value: 'claude-opus-5-5', label: 'Opus 5.5' },
    { value: 'claude-fable-5-1', label: 'Fable 5.1' },
    { value: 'claude-sonnet-5-5', label: 'Sonnet 5.5' },
    { value: 'claude-haiku-5-5', label: 'Haiku 5.5' },
  ]);
  for (const model of ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5']) {
    const effort = options.find((item) => item.value === model)?.effort;
    assert.equal(effort?.default, 'medium');
    assert.deepEqual(effort?.values.map((item) => item.value), ['low', 'medium', 'high', 'xhigh', 'max', 'ultracode']);
  }
  assert.equal(options.find((item) => item.value === 'claude-opus-5')?.label, 'Opus 5');
  assert.equal(options.find((item) => item.value === 'claude-opus-4-8')?.label, 'Opus 4.8');
  assert.match(options.find((item) => item.value === 'opus[1m]')!.label, /auto/);
});

test('Claude curated catalog exposes reserved managed HiRoute selection', async () => {
  const catalog = await new ClaudeProviderModels().getSupportedModels();
  const options = catalog.OPTIONS.filter(option => option.value === 'hiroute');
  assert.equal(options.length, 1);
  assert.equal(options[0].label, 'HiRoute');
  assert.match(options[0].description ?? '', /Claude subscription and saved model connections/);
  assert.equal(catalog.DEFAULT, 'default');
});

test('observed versions exclude aliases, synthesized rows and subagent models', () => {
  assert.equal(extractClaudeResolvedModel({ type: 'assistant', message: { model: 'claude-opus-4-8' } }), 'claude-opus-4-8');
  assert.equal(extractClaudeResolvedModel({ type: 'system', subtype: 'init', model: 'claude-opus-5' }), 'claude-opus-5');
  assert.equal(extractClaudeResolvedModel({ type: 'system', subtype: 'init', model: 'opus' }), null);
  assert.equal(extractClaudeResolvedModel({ type: 'assistant', message: { model: '<synthetic>' } }), null);
  assert.equal(extractClaudeResolvedModel({ type: 'assistant', parent_tool_use_id: 'task', message: { model: 'claude-haiku-4-5' } }), null);
});

test('session readback matches provider IDs and keeps actual version separate from later alias commands', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'model-version-'));
  const jsonl = path.join(directory, 'session.jsonl');
  await writeFile(jsonl, [
    { type: 'assistant', session_id: 'provider-session', message: { model: 'claude-opus-4-8' } },
    { type: 'assistant', session_id: 'provider-session', isSidechain: true, message: { model: 'claude-haiku-4-5' } },
    { type: 'user', session_id: 'provider-session', message: { content: '<model>opus[1m]</model>' } },
  ].map((event) => JSON.stringify(event)).join('\n'));
  const read = mock.method(sessionsDb, 'getSessionById', () => ({ jsonl_path: jsonl, provider_session_id: 'provider-session' }) as ReturnType<typeof sessionsDb.getSessionById>);
  try {
    const actual = await new ClaudeProviderModels().getCurrentActiveModel('app-session');
    assert.deepEqual(actual, { model: 'opus[1m]', resolvedModel: 'claude-opus-4-8' });
  } finally {
    read.mock.restore();
    await rm(directory, { recursive: true, force: true });
  }
});

test('ignores the <synthetic> placeholder Claude Code stamps on synthesized rows', () => {
  assert.equal(
    extractClaudeEventModel(
      { sessionId: SESSION_ID, message: { model: '<synthetic>' } },
      SESSION_ID,
    ),
    null,
  );
  assert.equal(
    extractClaudeEventModel({ sessionId: SESSION_ID, model: '<synthetic>' }, SESSION_ID),
    null,
  );
});

test('still surfaces real model ids from message and event fields', () => {
  assert.equal(
    extractClaudeEventModel(
      { sessionId: SESSION_ID, message: { model: 'claude-sonnet-5' } },
      SESSION_ID,
    ),
    'claude-sonnet-5',
  );
  assert.equal(
    extractClaudeEventModel({ sessionId: SESSION_ID, model: 'opus' }, SESSION_ID),
    'opus',
  );
});

test('skips a placeholder content part so a later real model tag still wins', () => {
  assert.equal(
    extractClaudeEventModel(
      {
        sessionId: SESSION_ID,
        message: {
          content: [
            { text: '<model><synthetic></model>' },
            { text: '<model>claude-sonnet-5</model>' },
          ],
        },
      },
      SESSION_ID,
    ),
    'claude-sonnet-5',
  );
});

test('a placeholder stdout hit does not shadow a real <model> tag in the same text', () => {
  const text = '<local-command-stdout>Set model to <synthetic></local-command-stdout>'
    + '<model>claude-sonnet-5</model>';
  assert.equal(
    extractClaudeEventModel(
      { sessionId: SESSION_ID, message: { content: text } },
      SESSION_ID,
    ),
    'claude-sonnet-5',
  );
  assert.equal(
    extractClaudeEventModel(
      { sessionId: SESSION_ID, message: { content: [{ text }] } },
      SESSION_ID,
    ),
    'claude-sonnet-5',
  );
});

test('falls back to the message model when every content hit is a placeholder', () => {
  assert.equal(
    extractClaudeEventModel(
      {
        sessionId: SESSION_ID,
        message: {
          content: '<model><synthetic></model>',
          model: 'claude-sonnet-5',
        },
      },
      SESSION_ID,
    ),
    'claude-sonnet-5',
  );
});
