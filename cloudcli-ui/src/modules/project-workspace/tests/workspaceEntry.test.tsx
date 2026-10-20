import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';

import { i18n } from '@/modules/i18n';
import WorkspaceStateView from '@/modules/project-workspace/WorkspaceStateView';
import WorkspaceTabs from '@/modules/project-workspace/WorkspaceTabs';

const actions = vi.hoisted(() => ({ createProject: vi.fn(), setPreference: vi.fn() }));
vi.mock('@/modules/command-palette', () => ({ usePaletteOps: () => actions }));
vi.mock('@/shared/context/UiPreferencesContext', () => ({ useSetUiPreference: () => actions.setPreference }));
vi.mock('@/modules/plugins', () => ({
  usePlugins: () => ({ plugins: [{ name: 'example', displayName: 'Example tool', enabled: true, icon: 'test' }] }),
  PluginIcon: () => <span />,
}));
afterEach(() => { cleanup(); vi.clearAllMocks(); });

test('desktop tools remain reachable through the menu and return to chat', async () => {
  await i18n.changeLanguage('en');
  const select = vi.fn();
  render(<WorkspaceTabs activeTab="chat" setActiveTab={select} shouldShowTasksTab shouldShowBrowserTab compact />);
  expect(screen.queryByRole('menuitem', { name: 'Files' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Git' }));
  expect(select).toHaveBeenLastCalledWith('git');
  fireEvent.click(screen.getByRole('button', { name: 'Tools' }));
  fireEvent.click(screen.getByRole('menuitem', { name: 'Files' }));
  expect(select).toHaveBeenLastCalledWith('files');
  fireEvent.click(screen.getByRole('button', { name: 'Tools' }));
  fireEvent.click(screen.getByRole('menuitem', { name: 'Example tool' }));
  expect(select).toHaveBeenLastCalledWith('plugin:example');
  fireEvent.click(screen.getByRole('button', { name: 'Chat' }));
  expect(select).toHaveBeenLastCalledWith('chat');
});

test('welcome opens project creation and restores desktop navigation', async () => {
  await i18n.changeLanguage('en');
  const openMenu = vi.fn();
  render(<WorkspaceStateView mode="empty" isMobile={false} onMenuClick={openMenu} />);
  fireEvent.click(screen.getByRole('button', { name: 'Add project' }));
  expect(actions.createProject).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole('button', { name: 'Browse conversations and projects' }));
  expect(actions.setPreference).toHaveBeenCalledWith('sidebarVisible', true);
  expect(openMenu).not.toHaveBeenCalled();
});
