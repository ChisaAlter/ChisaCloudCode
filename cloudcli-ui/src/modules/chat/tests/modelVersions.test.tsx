import React from 'react';
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import ComposerModelMenu from '@/modules/chat/composer/ComposerModelMenu';
import { useChatProviderState } from '@/modules/chat/hooks/useChatProviderState';
import { useChatRealtimeHandlers } from '@/modules/chat/hooks/useChatRealtimeHandlers';
import type { ProjectSession, ServerEvent } from '@/shared/types';

const mocks = vi.hoisted(() => ({ read: vi.fn(), write: vi.fn() }));
const ok = (data: unknown) => Promise.resolve({ ok: true, json: async () => ({ success: true, data }) });
vi.mock('@/shared/api', () => ({ api: { providers: {
  models: () => ok(null), capabilities: () => ok(null),
  sessionActiveModel: (...args: unknown[]) => mocks.read(...args),
  setSessionActiveModel: (...args: unknown[]) => mocks.write(...args),
} } }));
vi.mock('@/shared/selectedProvider', () => ({ readSelectedProvider: () => 'claude', writeSelectedProvider: vi.fn() }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({
  t: (key: string, options?: { defaultValue?: string; model?: string }) =>
    (options?.defaultValue || key).replace('{{model}}', options?.model || ''),
}) }));

const options = [
  { value: 'opus[1m]', label: 'Opus (auto, 1M context)' },
  { value: 'claude-opus-5', label: 'Opus 5' },
  { value: 'claude-opus-4-8', label: 'Opus 4.8' },
];
const session = { id: 'app-session', __provider: 'claude' } as ProjectSession;
beforeEach(() => {
  localStorage.clear();
  mocks.read.mockImplementation(() => ok({ model: 'opus[1m]', resolvedModel: 'claude-opus-4-8', source: 'session' }));
  mocks.write.mockImplementation((_provider: string, _id: string, model: string) => ok({ model, source: 'session' }));
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

test('the selector shows the observed version while fixed choices send their exact ID', () => {
  const onSelectModel = vi.fn();
  render(<ComposerModelMenu model="opus[1m]" resolvedModel="claude-opus-4-8" modelOptions={options}
    onSelectModel={onSelectModel} effort="default" effortOptions={[]} onSelectEffort={vi.fn()} modelsLoading={false} />);
  expect(screen.getByRole('button', { name: 'Select model and reasoning effort' }).textContent).toContain('Opus (auto, 1M context)');
  fireEvent.click(screen.getByRole('button'));
  expect(screen.getByText('Last used: Opus 4.8')).toBeTruthy();
  fireEvent.click(screen.getByRole('menuitemradio', { name: /Opus 5/ }));
  expect(onSelectModel).toHaveBeenCalledWith('claude-opus-5');
});

test('session readback and streamed versions never replace the next-turn selection', async () => {
  let listener: (event: ServerEvent) => void = () => {};
  const subscribe = (fn: typeof listener) => { listener = fn; return () => {}; };
  const { result } = renderHook(() => useChatProviderState({ selectedSession: session, selectedProject: null, subscribe }));
  await waitFor(() => expect(result.current.currentResolvedModel).toBe('claude-opus-4-8'));
  expect(result.current.currentProviderModel).toBe('opus[1m]');
  act(() => listener({ kind: 'status', text: 'model_resolved', provider: 'claude', sessionId: 'other', model: 'claude-sonnet-5' }));
  expect(result.current.currentResolvedModel).toBe('claude-opus-4-8');
  await act(async () => { await result.current.selectProviderModel('claude', 'claude-opus-5', session.id); });
  expect(mocks.write).toHaveBeenCalledWith('claude', session.id, 'claude-opus-5');
  expect(result.current.currentProviderModel).toBe('claude-opus-5');
  expect(result.current.currentResolvedModel).toBe('claude-opus-4-8');
  act(() => listener({ kind: 'status', text: 'model_resolved', provider: 'claude', sessionId: session.id, model: 'claude-opus-5' }));
  expect(result.current.currentResolvedModel).toBe('claude-opus-5');
  expect(result.current.currentProviderModel).toBe('claude-opus-5');
});

test('a delayed session read keeps the streamed version and restores the saved alias', async () => {
  let finish!: (value: unknown) => void;
  mocks.read.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
  let listener: (event: ServerEvent) => void = () => {};
  const subscribe = (fn: typeof listener) => { listener = fn; return () => {}; };
  const { result } = renderHook(() => useChatProviderState({ selectedSession: session, selectedProject: null, subscribe }));
  act(() => listener({ kind: 'status', text: 'model_resolved', provider: 'claude', sessionId: session.id, model: 'claude-opus-5' }));
  await act(async () => { finish(await ok({ model: 'opus[1m]', source: 'session', resolvedModel: 'claude-opus-4-8' })); });
  expect(result.current.currentProviderModel).toBe('opus[1m]');
  expect(result.current.currentResolvedModel).toBe('claude-opus-5');
});

test('a failed initial read does not erase a newer streamed version', async () => {
  let fail!: (reason: Error) => void;
  mocks.read.mockImplementation(() => new Promise((_resolve, reject) => { fail = reject; }));
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  let listener: (event: ServerEvent) => void = () => {};
  const subscribe = (fn: typeof listener) => { listener = fn; return () => {}; };
  const { result } = renderHook(() => useChatProviderState({ selectedSession: session, selectedProject: null, subscribe }));
  act(() => listener({ kind: 'status', text: 'model_resolved', provider: 'claude', sessionId: session.id, model: 'claude-opus-5' }));
  await act(async () => { fail(new Error('session read failed')); });
  expect(result.current.currentResolvedModel).toBe('claude-opus-5');
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
    lastSeqRef: { current: new Map() }, cursorRunIdRef: { current: new Map() }, statusCheckSentAtRef: { current: new Map() },
    onSessionProcessing, requestLatestMessages: vi.fn(), sessionStore: {} as Parameters<typeof useChatRealtimeHandlers>[0]['sessionStore'],
  }));
  act(() => listener({ kind: 'status', text: 'model_resolved', provider: 'claude', sessionId: session.id, model: 'claude-opus-5' }));
  expect(onSessionProcessing).not.toHaveBeenCalled();
  expect(setTokenBudget).not.toHaveBeenCalled();
  act(() => listener({ kind: 'status', text: 'workspace_finalizing', sessionId: session.id, canInterrupt: false }));
  expect(onSessionProcessing).toHaveBeenCalledWith(session.id, { statusText: 'workspace_finalizing', canInterrupt: false });
});
