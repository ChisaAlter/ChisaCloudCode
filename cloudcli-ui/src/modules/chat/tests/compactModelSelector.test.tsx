import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import ComposerModelMenu from '@/modules/chat/composer/ComposerModelMenu';

vi.mock('react-i18next', () => ({ useTranslation: () => ({
  t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? key,
}) }));

const models = [
  { value: 'claude-opus-5-5', label: 'Opus 5.5', description: 'Pinned: claude-opus-5-5' },
  { value: 'claude-fable-5-1', label: 'Fable 5.1' },
  { value: 'claude-sonnet-5-5', label: 'Sonnet 5.5' },
  { value: 'claude-haiku-5-5', label: 'Haiku 5.5' },
  { value: 'claude-opus-5', label: 'Opus 5' },
  { value: 'claude-sonnet-5', label: 'Sonnet 5' },
  { value: 'opus[1m]', label: 'Opus (auto, 1M context)' },
];
const efforts = ['low', 'medium', 'high', 'xhigh', 'max', 'ultracode'].map(value => ({ value }));
const open = () => fireEvent.click(screen.getByRole('button', { name: 'Select model and reasoning effort' }));
const more = () => fireEvent.click(screen.getByRole('menuitem', { name: 'More models' }));
const defaults = { model: models[0].value, modelOptions: models, modelsLoading: false,
  effort: 'high', effortOptions: efforts, onSelectModel: vi.fn(), onSelectEffort: vi.fn() };
beforeEach(() => { Element.prototype.scrollIntoView = vi.fn(); });
afterEach(() => { vi.clearAllMocks(); });

test('matches the desktop first-click menu: four current models, effort and more models', () => {
  render(<ComposerModelMenu {...defaults} resolvedModel={models[0].value} />);
  open();
  const menu = screen.getByRole('menu', { name: 'Select model and reasoning effort' });
  expect(within(menu).getAllByRole('menuitemradio')).toHaveLength(4);
  expect(screen.getByText('Model · this session')).toBeTruthy();
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(screen.queryByRole('searchbox')).toBeNull();
  expect(screen.queryByRole('radio')).toBeNull();
  expect(screen.queryByText(/Pinned:/)).toBeNull();
  expect(screen.queryByText(/Last used:/)).toBeNull();
  expect(screen.queryByText('Opus 5')).toBeNull();
  expect(screen.getByRole('menuitem', { name: /Effort/ }).getAttribute('aria-haspopup')).toBe('menu');
  expect(screen.getByRole('menuitem', { name: 'More models' })).toBeTruthy();
});

test('More models retains old versions, auto aliases and exact-ID search with an honest empty state', async () => {
  const selected = vi.fn();
  render(<ComposerModelMenu {...defaults} onSelectModel={selected} />);
  open(); more();
  const search = screen.getByRole('searchbox', { name: 'Search models...' });
  expect(screen.getByRole('menu', { name: 'More models' })).toBeTruthy();
  fireEvent.change(search, { target: { value: 'no matches' } });
  expect(screen.getByText('No models found.')).toBeTruthy();
  fireEvent.change(search, { target: { value: 'opus[1m]' } });
  const submenu = screen.getByRole('menu', { name: 'More models' });
  expect(within(submenu).getAllByRole('menuitemradio')).toHaveLength(1);
  fireEvent.click(within(submenu).getByRole('menuitemradio', { name: 'Opus (auto, 1M context)' }));
  await waitFor(() => expect(selected).toHaveBeenCalledWith('opus[1m]'));
  await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
});

test('Effort opens as a separate menu, selects the provider value and closes after saving', async () => {
  const selected = vi.fn();
  render(<ComposerModelMenu {...defaults} onSelectEffort={selected} />);
  open();
  fireEvent.click(screen.getByRole('menuitem', { name: /Effort/ }));
  const submenu = screen.getByRole('menu', { name: 'Effort' });
  expect(within(submenu).getAllByRole('menuitemradio')).toHaveLength(7);
  expect(within(submenu).getByRole('menuitemradio', { name: 'high' }).getAttribute('aria-checked')).toBe('true');
  fireEvent.click(within(submenu).getByRole('menuitemradio', { name: 'xhigh' }));
  await waitFor(() => expect(selected).toHaveBeenCalledWith('xhigh'));
  await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
});

test('failed changes stay visible and block concurrent selections', async () => {
  let reject!: (error: Error) => void;
  const selected = vi.fn(() => new Promise<void>((_resolve, fail) => { reject = fail; }));
  render(<ComposerModelMenu {...defaults} onSelectModel={selected} />);
  open();
  fireEvent.click(screen.getByRole('menuitemradio', { name: 'Sonnet 5.5' }));
  fireEvent.click(screen.getByRole('menuitemradio', { name: 'Haiku 5.5' }));
  expect(selected).toHaveBeenCalledTimes(1);
  await act(async () => { reject(new Error('Not saved')); });
  expect(screen.getByRole('alert').textContent).toBe('Not saved');
  expect(screen.getByRole('menuitemradio', { name: 'Opus 5.5' }).getAttribute('aria-checked')).toBe('true');
});

test('arrows and numeric shortcuts work in the compact model menu', async () => {
  const selected = vi.fn();
  render(<ComposerModelMenu {...defaults} onSelectModel={selected} />);
  const trigger = screen.getByRole('button', { name: 'Select model and reasoning effort' });
  fireEvent.keyDown(trigger, { key: 'ArrowDown' });
  const current = screen.getByRole('menuitemradio', { name: 'Opus 5.5' });
  expect(document.activeElement).toBe(current);
  fireEvent.keyDown(current, { key: 'ArrowDown' });
  expect(document.activeElement).toBe(screen.getByRole('menuitemradio', { name: 'Fable 5.1' }));
  fireEvent.keyDown(document.activeElement!, { key: '3' });
  await waitFor(() => expect(selected).toHaveBeenCalledWith('claude-sonnet-5-5'));
});

test('Escape closes the submenu before closing the model menu and restores focus', async () => {
  render(<ComposerModelMenu {...defaults} />);
  const trigger = screen.getByRole('button', { name: 'Select model and reasoning effort' });
  trigger.focus(); open(); more();
  fireEvent.keyDown(window, { key: 'Escape' });
  expect(screen.queryByRole('menu', { name: 'More models' })).toBeNull();
  expect(screen.getByRole('menu', { name: 'Select model and reasoning effort' })).toBeTruthy();
  expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'More models' }));
  fireEvent.keyDown(window, { key: 'Escape' });
  await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
  expect(document.activeElement).toBe(trigger);
});

test('an older selected version stays visible without replacing any current family', () => {
  render(<ComposerModelMenu {...defaults} model="claude-opus-5" />);
  open();
  expect(screen.getAllByRole('menuitemradio')).toHaveLength(5);
  expect(screen.getByRole('menuitemradio', { name: 'Opus 5' }).getAttribute('aria-checked')).toBe('true');
});
