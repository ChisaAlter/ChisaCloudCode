import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import CommandPalette from '@/modules/command-palette/CommandPalette';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/shared/context/ThemeContext', () => ({ useTheme: () => ({ toggleDarkMode: vi.fn() }) }));
vi.mock('@/modules/command-palette/hooks/useSessionsSource', () => ({ useSessionsSource: () => [] }));
vi.mock('@/modules/command-palette/hooks/useSessionMessageSearch', () => ({ useSessionMessageSearch: () => [] }));
vi.mock('@/modules/command-palette/hooks/useFilesSource', () => ({ useFilesSource: () => [] }));
vi.mock('@/modules/command-palette/hooks/useCommitsSource', () => ({ useCommitsSource: () => [] }));
vi.mock('@/modules/command-palette/hooks/useBranchesSource', () => ({ useBranchesSource: () => [] }));
vi.mock('@/modules/command-palette/hooks/useGitActions', () => ({ useGitActions: () => ({}) }));
const scrollDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollIntoView');
beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
});
afterEach(() => {
  cleanup(); vi.unstubAllGlobals();
  if (scrollDescriptor) Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', scrollDescriptor);
  else Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView');
});

test('SSH command navigation hides Tasks while cloud navigation still offers it', () => {
  const props = { selectedProject: { projectId: 'local', displayName: 'Local', fullPath: '/meta/local', sourceMode: 'ssh' as const }, onStartNewChat: vi.fn(), onOpenSettings: vi.fn() };
  const view = render(<MemoryRouter><CommandPalette {...props} /></MemoryRouter>);
  fireEvent.keyDown(document, { key: 'k', ctrlKey: true });
  expect(screen.getByText('commandPalette.navFiles')).toBeDefined();
  expect(screen.queryByText('commandPalette.navTasks')).toBeNull();
  view.rerender(<MemoryRouter><CommandPalette {...props} selectedProject={{ ...props.selectedProject, sourceMode: 'cloud' }} /></MemoryRouter>);
  expect(screen.getByText('commandPalette.navTasks')).toBeDefined();
});
