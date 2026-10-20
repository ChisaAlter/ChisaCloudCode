import React from 'react';
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import ComposerModelMenu from '@/modules/chat/composer/ComposerModelMenu';
import { useChatProviderState } from '@/modules/chat/hooks/useChatProviderState';
import type { ProjectSession, ProviderModelOption, ServerEvent } from '@/shared/types';

const mocks = vi.hoisted(() => ({ models: vi.fn(), read: vi.fn(), write: vi.fn() }));
const ok = (data: unknown) => Promise.resolve({ ok: true, json: async () => ({ success: true, data }) });
vi.mock('@/shared/api', () => ({ api: { providers: {
  models: (...args: unknown[]) => mocks.models(...args),
  capabilities: () => ok(null),
  sessionActiveModel: (...args: unknown[]) => mocks.read(...args),
  setSessionActiveModel: (...args: unknown[]) => mocks.write(...args),
} } }));
vi.mock('@/shared/selectedProvider', () => ({ readSelectedProvider: () => 'claude', writeSelectedProvider: vi.fn() }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({
  t: (key: string, options?: { defaultValue?: string; model?: string }) =>
    (options?.defaultValue || key).replace('{{model}}', options?.model || ''),
}) }));

const options: ProviderModelOption[] = [
  { value: 'default', label: 'Default', effort: { values: [{ value: 'high' }] } },
  { value: 'hiroute', label: 'HiRoute', description: 'Automatically route subscription and configured models' },
];
const session = { id: 'hiroute-session', __provider: 'claude' } as ProjectSession;
beforeEach(() => {
  localStorage.clear();
  mocks.models.mockImplementation((provider: string) => ok(provider === 'claude'
    ? { models: { OPTIONS: options, DEFAULT: 'default' } } : null));
  mocks.read.mockImplementation((_provider: string, sessionId: string) => ok({
    model: sessionId === session.id ? 'hiroute' : 'default', source: 'session', resolvedModel: 'claude-sonnet-4-6',
  }));
  mocks.write.mockImplementation((_provider: string, _id: string, model: string) => ok({ model, source: 'session' }));
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

test('HiRoute is selectable from the Claude catalog and displays its routing description', () => {
  const onSelectModel = vi.fn();
  render(<ComposerModelMenu model="default" modelOptions={options} onSelectModel={onSelectModel}
    effort="high" effortOptions={[{ value: 'high' }]} onSelectEffort={vi.fn()} modelsLoading={false} />);
  fireEvent.click(screen.getByRole('button', { name: 'Select model and reasoning effort' }));
  fireEvent.click(screen.getByRole('menuitem', { name: 'Default' }));
  fireEvent.click(screen.getByRole('menuitemradio', { name: /HiRoute/ }));
  expect(onSelectModel).toHaveBeenCalledWith('hiroute');
  expect(screen.queryByRole('menu')).toBeNull();
});

test('HiRoute keeps choices directly reachable without Claude effort and labels the last execution separately', () => {
  const onSelectModel = vi.fn();
  render(<ComposerModelMenu model="hiroute" resolvedModel="claude-sonnet-4-6" modelOptions={options}
    onSelectModel={onSelectModel} effort="high" effortOptions={[]} onSelectEffort={vi.fn()} modelsLoading={false} />);
  const trigger = screen.getByRole('button', { name: 'Select model and reasoning effort' });
  expect(trigger.textContent).toBe('HiRoute');
  expect(trigger.title).toBe('HiRoute · Last used: Sonnet 4.6');
  fireEvent.click(trigger);
  expect(screen.queryByText('Reasoning')).toBeNull();
  expect(screen.getByText('Automatically route subscription and configured models')).toBeTruthy();
  fireEvent.click(screen.getByRole('menuitemradio', { name: 'Default' }));
  expect(onSelectModel).toHaveBeenCalledWith('default');
});

test('a saved HiRoute choice has a friendly label before the model catalog loads', () => {
  render(<ComposerModelMenu model="hiroute" modelOptions={[]} onSelectModel={vi.fn()}
    effort="default" effortOptions={[]} onSelectEffort={vi.fn()} modelsLoading />);
  expect(screen.getByRole('button').textContent).toBe('HiRoute');
  fireEvent.click(screen.getByRole('button'));
  expect(screen.getByText('Loading models…')).toBeTruthy();
});

test('session HiRoute choice survives catalog hydration and resolved-model events without leaking to other sessions', async () => {
  localStorage.setItem('claude-model', 'default');
  localStorage.setItem('claude-effort', 'high');
  let listener: (event: ServerEvent) => void = () => {};
  const subscribe = (fn: typeof listener) => { listener = fn; return () => {}; };
  const { result, rerender } = renderHook(({ selectedSession }) =>
    useChatProviderState({ selectedSession, selectedProject: null, subscribe }), {
    initialProps: { selectedSession: session },
  });
  await waitFor(() => expect(result.current.currentProviderModel).toBe('hiroute'));
  await waitFor(() => expect(result.current.providerModelsLoading).toBe(false));
  expect(result.current.currentProviderEffortOptions).toEqual([]);
  expect(result.current.currentProviderEffort).toBe('default');
  act(() => listener({ kind: 'status', text: 'model_resolved', provider: 'claude', sessionId: session.id, model: 'third-party-model' }));
  expect(result.current.currentResolvedModel).toBe('third-party-model');
  expect(result.current.currentProviderModel).toBe('hiroute');
  await act(async () => { await result.current.selectProviderModel('claude', 'hiroute', session.id); });
  expect(mocks.write).toHaveBeenCalledWith('claude', session.id, 'hiroute');
  expect(localStorage.getItem('claude-model')).toBe('default');
  expect(result.current.currentResolvedModel).toBe('third-party-model');
  rerender({ selectedSession: { id: 'other-session', __provider: 'claude' } as ProjectSession });
  await waitFor(() => expect(result.current.currentProviderModel).toBe('default'));
  rerender({ selectedSession: session });
  await waitFor(() => expect(result.current.currentProviderModel).toBe('hiroute'));
});

test('HiRoute does not inherit Claude effort while its catalog is unavailable', async () => {
  mocks.models.mockImplementation(() => ok(null));
  const { result } = renderHook(() => useChatProviderState({ selectedSession: session, selectedProject: null }));
  await waitFor(() => expect(result.current.currentProviderModel).toBe('hiroute'));
  expect(result.current.currentProviderEffortOptions).toEqual([]);
  expect(result.current.currentProviderEffort).toBe('default');
});
