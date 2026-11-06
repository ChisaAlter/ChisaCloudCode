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
const actions = { create: vi.fn(async () => {}), update: vi.fn(async () => {}), remove: vi.fn(async () => {}), setCustomModelsOnly: vi.fn(async () => {}) };
const defaults: ComponentProps<typeof ComposerModelPicker> = {
  provider: 'claude', model: 'opus[1m]', effort: 'high', effortOptions: [{ value: 'high', description: 'More reasoning' }],
  providerModelCatalog: catalog, providerModelActions: actions, modelsLoading: false, sshProject: false,
  onSelectModel: vi.fn(), onSelectEffort: vi.fn(),
};
const openPicker = () => fireEvent.click(screen.getByRole('button', { name: 'Select model and reasoning effort' }));
const openMore = () => fireEvent.click(screen.getByRole('menuitem', { name: 'More models' }));
const openEffort = () => fireEvent.click(screen.getByRole('menuitem', { name: /Effort/ }));

beforeEach(() => { localStorage.clear(); Element.prototype.scrollIntoView = vi.fn(); });
afterEach(() => { vi.clearAllMocks(); });

test('one composer entry offers short choices with provider search under More models', async () => {
  const onSelectModel = vi.fn();
  const onSelectEffort = vi.fn();
  render(<ComposerModelPicker {...defaults} onSelectModel={onSelectModel} onSelectEffort={onSelectEffort} />);
  expect(screen.getAllByRole('button')).toHaveLength(1);
  openPicker();
  expect(screen.queryByRole('searchbox')).toBeNull();
  openEffort();
  expect(screen.getByRole('menuitemradio', { name: 'Default' })).toBeTruthy();
  expect(screen.queryByRole('menuitemradio', { name: 'low' })).toBeNull();
  fireEvent.click(screen.getByRole('menuitemradio', { name: 'Default' }));
  await waitFor(() => expect(onSelectEffort).toHaveBeenCalledWith('default'));
  await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
  openPicker(); openMore();
  const search = screen.getByRole('searchbox', { name: 'Search models...' });
  fireEvent.change(search, { target: { value: 'gpt-5.4-exact' } });
  const submenu = screen.getByRole('menu', { name: 'More models' });
  expect(within(submenu).queryByRole('menuitemradio', { name: /Opus auto/ })).toBeNull();
  fireEvent.click(within(submenu).getByRole('menuitemradio', { name: 'GPT 5.4' }));
  await waitFor(() => expect(onSelectModel).toHaveBeenCalledWith('codex', 'gpt-5.4-exact'));
  await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
});

test('provider changes refresh reasoning and preserve exact fixed model IDs', async () => {
  const selected = vi.fn();
  function Picker() {
    // Exercise the owner applying the selected provider/model after a save.
    const [choice, setChoice] = useState({ provider: 'claude' as LLMProvider, model: 'opus[1m]' });
    const option = catalog[choice.provider]?.OPTIONS.find(entry => entry.value === choice.model);
    return <ComposerModelPicker {...defaults} {...choice} effort="default" effortOptions={option?.effort?.values ?? []}
      onSelectModel={(provider, model) => { selected(provider, model); setChoice({ provider, model }); }} />;
  }
  render(<Picker />);
  openPicker(); openMore();
  fireEvent.click(screen.getByRole('menuitemradio', { name: 'GPT 5.4' }));
  await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
  openPicker(); openEffort();
  expect(screen.getByRole('menuitemradio', { name: 'low' })).toBeTruthy();
  expect(selected).toHaveBeenCalledWith('codex', 'gpt-5.4-exact');
  fireEvent.keyDown(window, { key: 'Escape' });
  openMore();
  fireEvent.click(within(screen.getByRole('menu', { name: 'More models' })).getByRole('menuitemradio', { name: 'Opus fixed' }));
  await waitFor(() => expect(selected).toHaveBeenCalledWith('claude', 'claude-opus-5-exact'));
  await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
  openPicker();
  expect(screen.queryByRole('menuitem', { name: /Effort/ })).toBeNull();
});

test('SSH retains only Claude models and no-match searches can be cleared', () => {
  render(<ComposerModelPicker {...defaults} sshProject />);
  openPicker(); openMore();
  expect(screen.queryByText('GPT 5.4')).toBeNull();
  const search = screen.getByRole('searchbox', { name: 'Search models...' });
  fireEvent.change(search, { target: { value: 'no-such-model' } });
  const submenu = screen.getByRole('menu', { name: 'More models' });
  expect(within(submenu).getByText('No models found.')).toBeTruthy();
  expect(within(submenu).queryByRole('menuitemradio')).toBeNull();
  fireEvent.change(search, { target: { value: '' } });
  expect(within(submenu).getByRole('menuitemradio', { name: 'Opus fixed' })).toBeTruthy();
});

test('library management stays under More models and returns to the compact picker', () => {
  render(<ComposerModelPicker {...defaults} />);
  openPicker(); openMore();
  fireEvent.click(screen.getByRole('menuitem', { name: 'Manage models' }));
  expect(screen.getByText('Model library')).toBeTruthy();
  expect(screen.getByText('Custom Claude')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Back to models' }));
  expect(screen.getByRole('menuitem', { name: /Effort/ })).toBeTruthy();
  expect(screen.queryByRole('searchbox')).toBeNull();
});

test('an empty catalog keeps saved model readable and management accessible without unsupported effort', () => {
  render(<ComposerModelPicker {...defaults} model="saved-model" providerModelCatalog={{}} effortOptions={[]} />);
  expect(screen.getByRole('button').textContent).toContain('saved-model');
  openPicker();
  expect(screen.getByText('No models found.')).toBeTruthy();
  expect(screen.queryByRole('menuitem', { name: /Effort/ })).toBeNull();
  openMore();
  expect(screen.getByRole('menuitem', { name: 'Manage models' })).toBeTruthy();
});

test('closing and reopening resets the secondary search', () => {
  render(<ComposerModelPicker {...defaults} />);
  openPicker(); openMore();
  fireEvent.change(screen.getByRole('searchbox', { name: 'Search models...' }), { target: { value: 'no-such-model' } });
  fireEvent.keyDown(window, { key: 'Escape' });
  fireEvent.keyDown(window, { key: 'Escape' });
  openPicker(); openMore();
  expect((screen.getByRole('searchbox', { name: 'Search models...' }) as HTMLInputElement).value).toBe('');
  expect(screen.getByRole('menuitemradio', { name: 'GPT 5.4' })).toBeTruthy();
});

test('async model and effort failures remain visible without closing the menu', async () => {
  render(<ComposerModelPicker {...defaults} onSelectModel={vi.fn(async () => { throw new Error('Model save failed'); })}
    onSelectEffort={vi.fn(async () => { throw new Error('Effort save failed'); })} />);
  openPicker();
  fireEvent.click(screen.getByRole('menuitemradio', { name: 'Opus fixed' }));
  await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('Model save failed'));
  openEffort();
  fireEvent.click(screen.getByRole('menuitemradio', { name: 'Default' }));
  await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('Effort save failed'));
});

test('welcome keeps project/task context without a second model entry', () => {
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
