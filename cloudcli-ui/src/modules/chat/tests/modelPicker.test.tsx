import { useState } from 'react';
import type { ComponentProps } from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import ComposerModelPicker from '@/modules/chat/composer/ComposerModelPicker';
import ProviderSelectionEmptyState from '@/modules/chat/transcript/ProviderSelectionEmptyState';
import type { LLMProvider, ProviderModelsDefinition } from '@/shared/types';

vi.mock('react-i18next', () => ({ useTranslation: () => ({
  t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue || key,
}) }));
vi.mock('@/modules/task-master', () => ({ NextTaskBanner: () => <div>Next task</div> }));
vi.mock('@/modules/project-settings', () => ({ ProjectDefaultsSummary: () => <div>Project defaults</div> }));
vi.mock('@/shared/context/WorkspaceScopeContext', () => ({ useWorkspaceExecutionScope: () => ({ projectId: 'project' }) }));

const catalog: Partial<Record<LLMProvider, ProviderModelsDefinition>> = {
  claude: { DEFAULT: 'opus[1m]', OPTIONS: [
    { value: 'opus[1m]', label: 'Opus auto', effort: { values: [{ value: 'high', description: 'More reasoning' }] } },
    { value: 'claude-opus-5-exact', label: 'Opus fixed' },
    { value: 'custom-model', label: 'Custom Claude', isCustom: true, recordId: 1 },
  ] },
  codex: { DEFAULT: 'gpt-5.4-exact', OPTIONS: [
    { value: 'gpt-5.4-exact', label: 'GPT 5.4', effort: { values: [{ value: 'low' }, { value: 'high' }] } },
  ] },
};
const actions = { create: vi.fn(async () => {}), update: vi.fn(async () => {}), remove: vi.fn(async () => {}) };
const defaults: ComponentProps<typeof ComposerModelPicker> = {
  provider: 'claude', model: 'opus[1m]', effort: 'high', effortOptions: [{ value: 'high', description: 'More reasoning' }],
  providerModelCatalog: catalog, providerModelActions: actions, modelsLoading: false, sshProject: false,
  onSelectModel: vi.fn(), onSelectEffort: vi.fn(),
};
const openPicker = () => fireEvent.click(screen.getByRole('button', { name: 'Select model and reasoning effort' }));

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => { vi.clearAllMocks(); vi.unstubAllGlobals(); });

test('one composer entry opens the cloud catalog, exact-ID search and reasoning together', async () => {
  const onSelectModel = vi.fn();
  const onSelectEffort = vi.fn();
  render(<ComposerModelPicker {...defaults} onSelectModel={onSelectModel} onSelectEffort={onSelectEffort} />);
  expect(screen.getAllByRole('button')).toHaveLength(1);
  openPicker();
  expect(screen.getByRole('option', { name: 'Default' })).toBeTruthy();
  expect(screen.getByRole('option', { name: 'high' })).toBeTruthy();
  expect(screen.queryByRole('option', { name: 'low' })).toBeNull();
  fireEvent.change(screen.getByLabelText('Reasoning'), { target: { value: 'default' } });
  await waitFor(() => expect(onSelectEffort).toHaveBeenCalledWith('default'));
  const search = screen.getByRole('combobox', { name: 'Search models...' });
  fireEvent.change(search, { target: { value: 'gpt-5.4-exact' } });
  await waitFor(() => expect(screen.queryByRole('option', { name: /Opus auto/ })).toBeNull());
  fireEvent.click(screen.getByRole('option', { name: /GPT 5.4/ }));
  await waitFor(() => expect(onSelectModel).toHaveBeenCalledWith('codex', 'gpt-5.4-exact'));
  expect(screen.getByRole('dialog')).toBeTruthy();
});

test('changing provider refreshes the same dialog reasoning values and keeps exact fixed model IDs', async () => {
  const selected = vi.fn();
  function Picker() {
    // Exercise the owner updating provider/model props after a catalog selection.
    const [choice, setChoice] = useState({ provider: 'claude' as LLMProvider, model: 'opus[1m]' });
    const option = catalog[choice.provider]?.OPTIONS.find((entry) => entry.value === choice.model);
    return <ComposerModelPicker {...defaults} {...choice} effort="default" effortOptions={option?.effort?.values ?? []}
      onSelectModel={(provider, model) => { selected(provider, model); setChoice({ provider, model }); }} />;
  }
  render(<Picker />);
  openPicker();
  fireEvent.click(screen.getByRole('option', { name: /GPT 5.4/ }));
  await waitFor(() => expect(screen.getByRole('option', { name: 'low' })).toBeTruthy());
  expect(selected).toHaveBeenCalledWith('codex', 'gpt-5.4-exact');
  fireEvent.click(screen.getByRole('option', { name: /Opus fixed/ }));
  await waitFor(() => expect(selected).toHaveBeenCalledWith('claude', 'claude-opus-5-exact'));
  expect((screen.getByLabelText('Reasoning') as HTMLSelectElement).disabled).toBe(true);
});

test('SSH offers only Claude models and no-match searches can be cleared', async () => {
  render(<ComposerModelPicker {...defaults} sshProject />);
  openPicker();
  expect(screen.queryByText('GPT 5.4')).toBeNull();
  expect(screen.getByText('Opus fixed')).toBeTruthy();
  const search = screen.getByRole('combobox', { name: 'Search models...' });
  fireEvent.change(search, { target: { value: 'no-such-model' } });
  await waitFor(() => expect(screen.getByText('No models found.')).toBeTruthy());
  expect(screen.queryByRole('option', { name: /Opus fixed/ })).toBeNull();
  fireEvent.change(search, { target: { value: '' } });
  await waitFor(() => expect(screen.getByText('Opus fixed')).toBeTruthy());
});

test('library management is reachable from the same entry and returns to the picker', async () => {
  render(<ComposerModelPicker {...defaults} />);
  openPicker();
  fireEvent.click(screen.getByRole('button', { name: 'Add model' }));
  expect(screen.getByText('Model library')).toBeTruthy();
  expect(screen.getByText('Custom Claude')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Back to models' }));
  expect(screen.getByLabelText('Reasoning')).toBeTruthy();
});

test('an empty catalog keeps the entry and default reasoning available with a visible empty state', async () => {
  render(<ComposerModelPicker {...defaults} model="saved-model" providerModelCatalog={{}} effortOptions={[]} />);
  expect(screen.getByRole('button').textContent).toContain('saved-model');
  openPicker();
  await waitFor(() => expect(screen.getByText('No models found.')).toBeTruthy());
  const reasoning = screen.getByLabelText('Reasoning') as HTMLSelectElement;
  expect(reasoning.value).toBe('default');
  expect(reasoning.disabled).toBe(true);
  expect(screen.getByRole('button', { name: 'Add model' })).toBeTruthy();
});

test('closing and reopening clears search instead of retaining a hidden catalog', async () => {
  render(<ComposerModelPicker {...defaults} />);
  openPicker();
  fireEvent.change(screen.getByRole('combobox', { name: 'Search models...' }), { target: { value: 'no-such-model' } });
  await waitFor(() => expect(screen.getByText('No models found.')).toBeTruthy());
  fireEvent.click(screen.getByRole('button', { name: 'Close model picker' }));
  openPicker();
  expect((screen.getByRole('combobox', { name: 'Search models...' }) as HTMLInputElement).value).toBe('');
  expect(screen.getByRole('option', { name: /GPT 5.4/ })).toBeTruthy();
});

test('async selection failures remain visible in the open model dialog', async () => {
  render(<ComposerModelPicker {...defaults} onSelectModel={vi.fn(async () => { throw new Error('Model save failed'); })}
    onSelectEffort={vi.fn(async () => { throw new Error('Effort save failed'); })} />);
  openPicker();
  fireEvent.click(screen.getByRole('option', { name: /Opus fixed/ }));
  await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('Model save failed'));
  expect(screen.getByRole('dialog')).toBeTruthy();
  fireEvent.change(screen.getByLabelText('Reasoning'), { target: { value: 'default' } });
  await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('Effort save failed'));
});

test('the welcome keeps project/task context without a second model entry and preserves continuation', () => {
  const props: ComponentProps<typeof ProviderSelectionEmptyState> = {
    selectedSession: null, currentSessionId: null, provider: 'claude', setProvider: vi.fn(), textareaRef: { current: null },
    providerModels: { claude: 'opus[1m]', codex: '', cursor: '', opencode: '' }, setProviderModel: vi.fn(),
    providerModelCatalog: catalog, providerModelActions: actions, providerModelsLoading: false,
    tasksEnabled: true, isTaskMasterInstalled: true, setInput: vi.fn(),
  };
  const { container, rerender } = render(<ProviderSelectionEmptyState {...props} />);
  expect(screen.getByText('Project defaults')).toBeTruthy();
  expect(screen.getByText('Next task')).toBeTruthy();
  expect(within(container).queryByRole('button')).toBeNull();
  rerender(<ProviderSelectionEmptyState {...props} selectedSession={{ id: 'existing' } as NonNullable<typeof props.selectedSession>} />);
  expect(screen.getByText('session.continue.title')).toBeTruthy();
  expect(screen.queryByText('Project defaults')).toBeNull();
  expect(screen.getByText('Next task')).toBeTruthy();
});
