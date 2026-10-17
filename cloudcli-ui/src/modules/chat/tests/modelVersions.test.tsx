import React from 'react';
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import ComposerModelMenu from '@/modules/chat/composer/ComposerModelMenu';
import { useChatProviderState } from '@/modules/chat/hooks/useChatProviderState';
import { useChatRealtimeHandlers } from '@/modules/chat/hooks/useChatRealtimeHandlers';
import type { ProjectSession, ServerEvent } from '@/shared/types';

const mocks = vi.hoisted(() => ({ read: vi.fn(), write: vi.fn(), effort: vi.fn(), update: vi.fn(), remove: vi.fn(), catalog: vi.fn() }));
const ok = (data: unknown) => Promise.resolve({ ok: true, json: async () => ({ success: true, data }) });
vi.mock('@/shared/api', () => ({ api: { providers: {
  models: (...args: unknown[]) => mocks.catalog(...args), capabilities: () => ok(null),
  sessionActiveModel: (...args: unknown[]) => mocks.read(...args),
  setSessionActiveModel: (...args: unknown[]) => mocks.write(...args),
  setSessionActiveEffort: (...args: unknown[]) => mocks.effort(...args),
  updateModel: (...args: unknown[]) => mocks.update(...args),
  deleteModel: (...args: unknown[]) => mocks.remove(...args),
} } }));
vi.mock('@/shared/selectedProvider', () => ({ readSelectedProvider: () => 'claude', writeSelectedProvider: vi.fn() }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({
  t: (key: string, options?: { defaultValue?: string; model?: string }) =>
    (options?.defaultValue || key).replace('{{model}}', options?.model || ''),
}) }));

const options = [
  { value: 'opus[1m]', label: 'Opus (auto, 1M context)' },
  { value: 'claude-opus-5-5', label: 'Opus 5.5' },
  { value: 'claude-opus-4-8', label: 'Opus 4.8' },
];
const session = { id: 'app-session', __provider: 'claude' } as ProjectSession;
beforeEach(() => {
  localStorage.clear();
  mocks.catalog.mockImplementation((provider: string) => ok({ models: {
    OPTIONS: provider === 'claude' ? options : [], DEFAULT: provider === 'claude' ? 'opus[1m]' : 'default',
  } }));
  mocks.read.mockImplementation(() => ok({ model: 'opus[1m]', resolvedModel: 'claude-opus-4-8', source: 'session' }));
  mocks.write.mockImplementation((_provider: string, _id: string, model: string) => ok({ model, source: 'session' }));
  mocks.effort.mockImplementation((_provider: string, _id: string, effort: string) => ok({ effort, source: 'session' }));
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

test('Claude models are usable while another provider catalog is still pending', async () => {
  const normal = mocks.catalog.getMockImplementation()!;
  mocks.catalog.mockImplementation((provider: string, { signal }: { signal: AbortSignal }) => provider === 'opencode'
    ? new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new DOMException('Canceled', 'AbortError'))))
    : normal(provider));
  const { result } = renderHook(() => useChatProviderState({ selectedSession: session, selectedProject: null }));
  await waitFor(() => expect(result.current.providerModelsLoading).toBe(false));
  expect(result.current.currentProviderModelOptions.some((option) => option.value === 'claude-opus-5-5')).toBe(true);
  expect(result.current.providerModelsError).toBe(false);
});

test('a timed-out native catalog read ends loading and can be retried without restarting', async () => {
  vi.useFakeTimers();
  const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
  const normal = mocks.catalog.getMockImplementation()!;
  mocks.catalog.mockImplementation((provider: string, { signal }: { signal: AbortSignal }) => provider === 'claude'
    ? new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new DOMException('Canceled', 'AbortError'))))
    : normal(provider));
  const view = renderHook(() => useChatProviderState({ selectedSession: session, selectedProject: null }));
  try {
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
    expect(view.result.current.providerModelsLoading).toBe(false);
    expect(view.result.current.providerModelsError).toBe(true);
    mocks.catalog.mockImplementation(normal);
    await act(async () => { view.result.current.reloadProviderModels(); });
    expect(view.result.current.providerModelsError).toBe(false);
    expect(view.result.current.currentProviderModelOptions.some((option) => option.value === 'claude-opus-5-5')).toBe(true);
  } finally {
    view.unmount();
    vi.useRealTimers();
    logged.mockRestore();
  }
});

test('an empty failed catalog keeps a visible model menu and a working reload action', () => {
  const reload = vi.fn();
  render(<ComposerModelMenu model="default" modelOptions={[]} onSelectModel={vi.fn()}
    effort="default" effortOptions={[]} onSelectEffort={vi.fn()} modelsLoading={false} modelsError onReloadModels={reload} />);
  fireEvent.click(screen.getByRole('button', { name: 'Select model and reasoning effort' }));
  expect(reload).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole('menuitem', { name: 'default' }));
  expect(screen.getByRole('alert').textContent).toContain('Could not load models');
  fireEvent.click(screen.getByRole('menuitem', { name: 'Reload models' }));
  expect(reload).toHaveBeenCalledTimes(2);
});

test('the selector shows the observed version while fixed choices send their exact ID', () => {
  const onSelectModel = vi.fn();
  render(<ComposerModelMenu model="opus[1m]" resolvedModel="claude-opus-4-8" modelOptions={options}
    onSelectModel={onSelectModel} effort="default" effortOptions={[]} onSelectEffort={vi.fn()} modelsLoading={false} />);
  expect(screen.getByRole('button', { name: 'Select model and reasoning effort' }).textContent).toContain('Opus (auto, 1M context)');
  fireEvent.click(screen.getByRole('button'));
  expect(screen.getByText('Last used: Opus 4.8')).toBeTruthy();
  fireEvent.click(screen.getByRole('menuitem', { name: 'Opus (auto, 1M context)' }));
  fireEvent.click(screen.getByRole('menuitemradio', { name: /Opus 5/ }));
  expect(onSelectModel).toHaveBeenCalledWith('claude-opus-5-5');
});

test('session readback and streamed versions never replace the next-turn selection', async () => {
  let listener: (event: ServerEvent) => void = () => {};
  const subscribe = (fn: typeof listener) => { listener = fn; return () => {}; };
  const { result } = renderHook(() => useChatProviderState({ selectedSession: session, selectedProject: null, subscribe }));
  await waitFor(() => expect(result.current.currentResolvedModel).toBe('claude-opus-4-8'));
  expect(result.current.currentProviderModel).toBe('opus[1m]');
  act(() => listener({ kind: 'status', text: 'model_resolved', provider: 'claude', sessionId: 'other', model: 'claude-sonnet-5' }));
  expect(result.current.currentResolvedModel).toBe('claude-opus-4-8');
  await act(async () => { await result.current.selectProviderModel('claude', 'claude-opus-5-5', session.id); });
  expect(mocks.write).toHaveBeenCalledWith('claude', session.id, 'claude-opus-5-5');
  expect(result.current.currentProviderModel).toBe('claude-opus-5-5');
  expect(result.current.currentResolvedModel).toBe('claude-opus-4-8');
  act(() => listener({ kind: 'status', text: 'model_resolved', provider: 'claude', sessionId: session.id, model: 'claude-opus-5-5' }));
  expect(result.current.currentResolvedModel).toBe('claude-opus-5-5');
  expect(result.current.currentProviderModel).toBe('claude-opus-5-5');
});

test('a delayed session read keeps the streamed version and restores the saved alias', async () => {
  let finish!: (value: unknown) => void;
  mocks.read.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
  let listener: (event: ServerEvent) => void = () => {};
  const subscribe = (fn: typeof listener) => { listener = fn; return () => {}; };
  const { result } = renderHook(() => useChatProviderState({ selectedSession: session, selectedProject: null, subscribe }));
  act(() => listener({ kind: 'status', text: 'model_resolved', provider: 'claude', sessionId: session.id, model: 'claude-opus-5-5' }));
  await act(async () => { finish(await ok({ model: 'opus[1m]', source: 'session', resolvedModel: 'claude-opus-4-8' })); });
  expect(result.current.currentProviderModel).toBe('opus[1m]');
  expect(result.current.currentResolvedModel).toBe('claude-opus-5-5');
});

test('a failed initial read does not erase a newer streamed version', async () => {
  let fail!: (reason: Error) => void;
  mocks.read.mockImplementation(() => new Promise((_resolve, reject) => { fail = reject; }));
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  let listener: (event: ServerEvent) => void = () => {};
  const subscribe = (fn: typeof listener) => { listener = fn; return () => {}; };
  const { result } = renderHook(() => useChatProviderState({ selectedSession: session, selectedProject: null, subscribe }));
  act(() => listener({ kind: 'status', text: 'model_resolved', provider: 'claude', sessionId: session.id, model: 'claude-opus-5-5' }));
  await act(async () => { fail(new Error('session read failed')); });
  expect(result.current.currentResolvedModel).toBe('claude-opus-5-5');
  error.mockRestore();
});

test('model metadata does not replace the runtime processing state or token budget', () => {
  let listener: (event: ServerEvent) => void = () => {};
  const onSessionProcessing = vi.fn();
  const setTokenBudget = vi.fn();
  renderHook(() => useChatRealtimeHandlers({
    isActive: true, subscribe: (fn) => { listener = fn; return () => {}; },
    provider: 'claude', selectedSession: session, currentSessionId: session.id,
    setTokenBudget, pendingPermissionRequests: [], setPendingPermissionRequests: vi.fn(),
    streamBuffersRef: { current: new Map() },
    replayCursorsRef: { current: new Map() }, statusCheckSentAtRef: { current: new Map() },
    onSessionProcessing, requestLatestMessages: vi.fn(), sessionStore: {} as Parameters<typeof useChatRealtimeHandlers>[0]['sessionStore'],
  }));
  act(() => listener({ kind: 'status', text: 'model_resolved', provider: 'claude', sessionId: session.id, model: 'claude-opus-5-5' }));
  expect(onSessionProcessing).not.toHaveBeenCalled();
  expect(setTokenBudget).not.toHaveBeenCalled();
  act(() => listener({ kind: 'status', text: 'workspace_finalizing', sessionId: session.id, canInterrupt: false }));
  expect(onSessionProcessing).toHaveBeenCalledWith(session.id, { statusText: 'workspace_finalizing', canInterrupt: false, runId: undefined, modelStopped: undefined });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test('existing session options stay unready on a failed read and an explicit retry restores them', async () => {
  const read = deferred<Awaited<ReturnType<typeof ok>>>();
  mocks.read.mockReturnValueOnce(read.promise);
  const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
  const { result } = renderHook(() => useChatProviderState({ selectedSession: session, selectedProject: null }));
  expect(result.current.sessionOptionsReady).toBe(false);
  await act(async () => { read.reject(new Error('saved choices unavailable')); });
  expect(result.current.sessionOptionsReady).toBe(false);
  expect(result.current.sessionOptionsError).toContain('saved choices unavailable');
  await expect(result.current.selectProviderModel('claude', 'claude-opus-5-5', session.id)).rejects.toThrow('Wait for this session');
  expect(mocks.write).not.toHaveBeenCalled();
  mocks.read.mockImplementation(() => ok({ model: 'claude-opus-5-5', effort: null, source: 'session' }));
  await act(async () => { result.current.reloadSessionOptions(); });
  await waitFor(() => expect(result.current.sessionOptionsReady).toBe(true));
  expect(result.current.currentProviderModel).toBe('claude-opus-5-5');
  expect(result.current.sessionOptionsError).toBeNull();
  logged.mockRestore();
});

test('navigating to another session immediately revokes option readiness until that session read completes', async () => {
  const second = deferred<Awaited<ReturnType<typeof ok>>>();
  const other = { ...session, id: 'other-session' };
  mocks.read.mockImplementation((_provider: string, id: string) => id === other.id ? second.promise : ok({ model: 'claude-opus-4-8', source: 'session' }));
  const { result, rerender } = renderHook(({ selectedSession }) => useChatProviderState({ selectedSession, selectedProject: null }), { initialProps: { selectedSession: session } });
  await waitFor(() => expect(result.current.sessionOptionsReady).toBe(true));
  rerender({ selectedSession: other });
  expect(result.current.sessionOptionsReady).toBe(false);
  await act(async () => { second.resolve(await ok({ model: 'claude-opus-5-5', source: 'session' })); });
  expect(result.current.sessionOptionsReady).toBe(true);
  expect(result.current.currentProviderModel).toBe('claude-opus-5-5');
});

test.each(['update', 'remove'] as const)('a delayed custom model %s cannot replace another session or a newer provider default', async (operation) => {
  const response = deferred<Awaited<ReturnType<typeof ok>>>();
  mocks[operation].mockReturnValue(response.promise);
  const other = { ...session, id: 'other-session' };
  mocks.read.mockImplementation((_provider: string, id: string) => ok({ model: id === session.id ? 'claude-opus-4-8' : 'claude-opus-5-5', source: 'session' }));
  const { result, rerender } = renderHook(({ selectedSession }) => useChatProviderState({ selectedSession, selectedProject: null }), { initialProps: { selectedSession: session } });
  await waitFor(() => expect(result.current.sessionOptionsReady).toBe(true));
  act(() => result.current.setStoredProviderModel('claude', 'claude-opus-4-8'));
  const existing = { value: 'claude-opus-4-8', label: 'Original', recordId: 7 };
  let mutation!: Promise<void>;
  act(() => { mutation = operation === 'update'
    ? result.current.providerModelActions.update('claude', existing, { model: 'Renamed', id: 'renamed' })
    : result.current.providerModelActions.remove('claude', existing); });
  rerender({ selectedSession: other });
  await waitFor(() => expect(result.current.currentProviderModel).toBe('claude-opus-5-5'));
  act(() => result.current.setStoredProviderModel('claude', 'claude-opus-5-5'));
  await act(async () => {
    response.resolve(await ok({ model: { value: 'renamed', label: 'Renamed' }, models: { OPTIONS: [...options, { value: 'renamed', label: 'Renamed' }], DEFAULT: 'opus[1m]' } }));
    await mutation;
  });
  expect(result.current.currentProviderModel).toBe('claude-opus-5-5');
  expect(result.current.providerModels.claude).toBe('claude-opus-5-5');
  expect(localStorage.getItem('claude-model')).toBe('claude-opus-5-5');
  expect(mocks[operation]).toHaveBeenCalledTimes(1);
  expect(result.current.providerModelCatalog.claude?.OPTIONS.some(option => option.value === 'renamed')).toBe(true);
});

test('a failed effort save rolls back only effort after a successful model change', async () => {
  const response = deferred<Awaited<ReturnType<typeof ok>>>();
  mocks.effort.mockReturnValue(response.promise);
  const { result } = renderHook(() => useChatProviderState({ selectedSession: session, selectedProject: null }));
  await waitFor(() => expect(result.current.sessionOptionsReady).toBe(true));
  let rejected!: Promise<unknown>;
  let failure: unknown;
  act(() => { rejected = result.current.selectProviderEffort('claude', 'high', session.id).catch(error => error); });
  await act(async () => { await result.current.selectProviderModel('claude', 'claude-opus-5-5', session.id); });
  await act(async () => { response.reject(new Error('effort not saved')); failure = await rejected; });
  expect(mocks.effort).toHaveBeenCalledWith('claude', session.id, 'high');
  expect(failure).toMatchObject({ message: 'effort not saved' });
  expect(result.current.currentProviderModel).toBe('claude-opus-5-5');
  expect(result.current.currentResolvedModel).toBe('claude-opus-4-8');
  expect(result.current.currentProviderEffort).toBe('default');
  expect(result.current.sessionOptionsReady).toBe(true);
});

test('new chats with an allocated id keep their original model-choice entry point', async () => {
  const { result } = renderHook(() => useChatProviderState({ selectedSession: null, selectedProject: null }));
  expect(result.current.sessionOptionsReady).toBe(true);
  await act(async () => { await result.current.selectProviderModel('claude', 'claude-opus-5-5', 'newly-allocated'); });
  expect(mocks.write).toHaveBeenCalledWith('claude', 'newly-allocated', 'claude-opus-5-5');
  expect(result.current.currentProviderModel).toBe('claude-opus-5-5');
});

test('a delayed custom rename preserves a newer model choice in the same session', async () => {
  const response = deferred<Awaited<ReturnType<typeof ok>>>();
  mocks.update.mockReturnValue(response.promise);
  const { result } = renderHook(() => useChatProviderState({ selectedSession: session, selectedProject: null }));
  await waitFor(() => expect(result.current.sessionOptionsReady).toBe(true));
  let mutation!: Promise<void>;
  act(() => { mutation = result.current.providerModelActions.update('claude', { value: 'opus[1m]', label: 'Original', recordId: 7 }, { model: 'Renamed', id: 'renamed' }); });
  await act(async () => { await result.current.selectProviderModel('claude', 'claude-opus-5-5', session.id); });
  await act(async () => {
    response.resolve(await ok({ model: { value: 'renamed', label: 'Renamed' }, models: { OPTIONS: [...options, { value: 'renamed', label: 'Renamed' }], DEFAULT: 'opus[1m]' } }));
    await mutation;
  });
  expect(result.current.currentProviderModel).toBe('claude-opus-5-5');
});

test('a known default session effort does not inherit a different provider default', async () => {
  localStorage.setItem('claude-effort', 'high');
  mocks.catalog.mockImplementation((provider: string) => ok({ models: {
    OPTIONS: provider === 'claude' ? options.map(option => ({ ...option, effort: { values: [{ value: 'high' }] } })) : [],
    DEFAULT: provider === 'claude' ? 'opus[1m]' : 'default',
  } }));
  mocks.read.mockImplementation(() => ok({ model: 'opus[1m]', effort: null, source: 'session' }));
  const { result } = renderHook(() => useChatProviderState({ selectedSession: session, selectedProject: null }));
  await waitFor(() => expect(result.current.sessionOptionsReady).toBe(true));
  expect(result.current.currentProviderEffortOptions).toEqual([{ value: 'high' }]);
  expect(result.current.currentProviderEffort).toBe('default');
});
