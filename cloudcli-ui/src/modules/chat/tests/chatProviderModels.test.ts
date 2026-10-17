import assert from 'node:assert/strict';

import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import { resetUserPreferences, writeUserPreference } from '@/shared/userSettings';
import type { ProjectSession } from '@/shared/types';

/**
 * The four per-provider default models used to be four useState slots with four
 * copy-pasted reconciliation effects and a four-branch setter. They are now one
 * Record with one loop. These tests pin the behaviour that has to survive that:
 * each provider keeps its own model, under its own storage key, and choosing a
 * model persists it.
 */

const okJson = (data: unknown) => Promise.resolve({
  ok: true,
  json: async () => data,
});

const sessionRequests = vi.hoisted(() => ({ read: vi.fn(), model: vi.fn(), effort: vi.fn() }));

vi.mock('@/shared/api', () => ({
  api: {
    // The preference store PATCHes through api.user; it is stubbed rather than
    // exercised here, which keeps these tests about the model record.
    user: {
      preferences: () => okJson({ success: true, preferences: {} }),
      savePreferences: () => okJson({ success: true, preferences: {} }),
    },
    providers: {
      models: () => okJson({ success: true, data: null }),
      capabilities: () => okJson({ success: true, data: null }),
      sessionActiveModel: sessionRequests.read,
      setSessionActiveModel: sessionRequests.model,
      setSessionActiveEffort: sessionRequests.effort,
      createModel: () => okJson({ success: true, data: null }),
      updateModel: () => okJson({ success: true, data: null }),
      removeModel: () => okJson({ success: true, data: null }),
    },
  },
}));

const renderProviderState = async (selectedSession: ProjectSession | null = null) => {
  const { useChatProviderState } = await import(
    '@/modules/chat/hooks/useChatProviderState'
  );
  return renderHook(() =>
    useChatProviderState({ selectedSession, selectedProject: null }),
  );
};

beforeEach(() => {
  localStorage.clear();
  // The preference store is a module-level singleton, so its in-memory copy
  // outlives localStorage.clear() and would leak one test's writes into the next.
  resetUserPreferences();
  sessionRequests.read.mockReset().mockImplementation(() => okJson({ success: true, data: null }));
  sessionRequests.model.mockReset().mockImplementation(() => okJson({ success: true, data: null }));
  sessionRequests.effort.mockReset().mockImplementation(() => okJson({ success: true, data: null }));
});

afterEach(() => {
  vi.resetModules();
});

test('each provider gets its own model from its own storage key', async () => {
  localStorage.setItem('claude-model', 'claude-stored');
  localStorage.setItem('cursor-model', 'cursor-stored');
  localStorage.setItem('codex-model', 'codex-stored');
  localStorage.setItem('opencode-model', 'opencode-stored');

  const { result } = await renderProviderState();

  await waitFor(() => {
    assert.equal(result.current.providerModels.claude, 'claude-stored');
  });
  assert.equal(result.current.providerModels.cursor, 'cursor-stored');
  assert.equal(result.current.providerModels.codex, 'codex-stored');
  assert.equal(result.current.providerModels.opencode, 'opencode-stored');
});

test('a provider with no stored model falls back to its own default, not another provider’s', async () => {
  const { result } = await renderProviderState();

  await waitFor(() => {
    assert.ok(result.current.providerModels.claude);
  });

  const models = result.current.providerModels;
  assert.equal(
    new Set(Object.values(models)).size,
    Object.keys(models).length,
    'each provider must have a distinct default model',
  );
});

test('choosing a model persists it under that provider’s key only', async () => {
  const { result } = await renderProviderState();
  await waitFor(() => {
    assert.ok(result.current.providerModels.codex);
  });
  const claudeBefore = result.current.providerModels.claude;

  act(() => {
    result.current.setStoredProviderModel('codex', 'codex-chosen');
  });

  assert.equal(result.current.providerModels.codex, 'codex-chosen');
  assert.equal(localStorage.getItem('codex-model'), 'codex-chosen');
  assert.equal(
    result.current.providerModels.claude,
    claudeBefore,
    'setting one provider must not disturb another',
  );
  assert.equal(localStorage.getItem('claude-model'), null);
});

test('setting the same model twice keeps the record identity stable', async () => {
  const { result } = await renderProviderState();
  await waitFor(() => {
    assert.ok(result.current.providerModels.claude);
  });

  act(() => {
    result.current.setStoredProviderModel('claude', 'pinned');
  });
  const afterFirst = result.current.providerModels;

  act(() => {
    result.current.setStoredProviderModel('claude', 'pinned');
  });

  assert.equal(
    result.current.providerModels,
    afterFirst,
    'a no-op write must not allocate a new record and wake consumers',
  );
});

test('the active provider’s model is what currentProviderModel reports', async () => {
  // The provider selection is a stored preference; the per-provider model is
  // still a plain localStorage key.
  writeUserPreference('selectedProvider', 'codex');
  localStorage.setItem('codex-model', 'codex-active');

  const { result } = await renderProviderState();

  await waitFor(() => {
    assert.equal(result.current.provider, 'codex');
  });
  assert.equal(result.current.currentProviderModel, 'codex-active');
});

test.each([false, true])('an older effort selector preserves the newly restored model through its API completion or rollback: %s', async failEffort => {
  sessionRequests.read.mockImplementation(() => okJson({ success: true, data: {
    provider: 'claude', sessionId: 'restored-session', source: 'session', model: 'old-model', effort: 'medium',
  } }));
  const { result } = await renderProviderState({ id: 'restored-session', provider: 'claude' } as ProjectSession);
  await waitFor(() => assert.equal(result.current.currentProviderModel, 'old-model'));
  const originalSelectors = result.current;
  await act(async () => { await originalSelectors.selectProviderModel('claude', 'saved-model', 'restored-session'); });
  assert.equal(result.current.currentProviderModel, 'saved-model');
  let finishEffort!: (value: { ok: boolean; json: () => Promise<unknown> }) => void;
  sessionRequests.effort.mockImplementation(() => new Promise(resolve => { finishEffort = resolve; }));
  let updating!: Promise<unknown>;
  await act(async () => { updating = originalSelectors.selectProviderEffort('claude', 'high', 'restored-session'); });
  assert.equal(result.current.currentProviderModel, 'saved-model', 'the optimistic effort write must retain the model restored by the newer state');
  await act(async () => {
    finishEffort({ ok: !failEffort, json: async () => ({ success: !failEffort, data: { effort: 'high' } }) });
    if (failEffort) await assert.rejects(updating, /Unable to change the reasoning effort/);
    else await updating;
  });
  assert.equal(result.current.currentProviderModel, 'saved-model');
  assert.equal(result.current.currentProviderEffort, failEffort ? 'medium' : 'high');
});
