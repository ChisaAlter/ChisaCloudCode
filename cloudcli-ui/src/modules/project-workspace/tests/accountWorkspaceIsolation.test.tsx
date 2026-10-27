import { useEffect } from 'react';
import type { ReactNode } from 'react';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { useNavigate, useParams } from 'react-router-dom';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import App from '@/App';
import { useProjectsState } from '@/modules/project-workspace/hooks/useProjectsState';
import { Sidebar } from '@/modules/sidebar';
import { clearAuthToken, startAuthSession, storeAuthToken } from '@/shared/authToken';
import type { Project } from '@/shared/types';

const runtime = vi.hoisted(() => ({ user: { id: 1, username: 'a' } as { id: number; username: string } | null, projects: vi.fn(), recent: vi.fn(), details: vi.fn() }));
vi.mock('react-i18next', () => ({ I18nextProvider: ({ children }: { children: ReactNode }) => children, useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/modules/auth', () => ({ AuthProvider: ({ children }: { children: ReactNode }) => children, ProtectedRoute: ({ children }: { children: ReactNode }) => runtime.user ? children : <p>signed out</p>, useAuth: () => ({ user: runtime.user }) }));
vi.mock('@/shared/context/ThemeContext', () => ({ ThemeProvider: ({ children }: { children: ReactNode }) => children }));
vi.mock('@/shared/context/UiPreferencesContext', () => ({ UiPreferencesProvider: ({ children }: { children: ReactNode }) => children, useUiPreferences: () => ({ sidebarVisible: true }), useSetUiPreference: () => vi.fn() }));
vi.mock('@/shared/context/WebSocketContext', () => ({ WebSocketProvider: ({ children }: { children: ReactNode }) => children }));
vi.mock('@/modules/plugins', () => ({ PluginsProvider: ({ children }: { children: ReactNode }) => children }));
vi.mock('@/modules/task-master', () => ({ TaskMasterProvider: ({ children }: { children: ReactNode }) => children, TasksSettingsProvider: ({ children }: { children: ReactNode }) => children, useTaskMaster: () => ({ setCurrentProject: vi.fn(), mcpServerStatus: {} }), useTasksSettings: () => ({ tasksEnabled: false }) }));
vi.mock('@/modules/i18n', () => ({ i18n: {} }));
vi.mock('@/modules/desktop-chrome', () => ({ DesktopChrome: () => null }));
vi.mock('@/shared/ui', () => ({ BlockingOperationDialog: () => null }));
vi.mock('@/modules/command-palette', () => ({ usePaletteOps: () => ({}), usePaletteOpsRegister: () => {} }));
vi.mock('@/shared/hooks/useDeviceSettings', () => ({ useDeviceSettings: () => ({ isMobile: false, isPWA: false }) }));
vi.mock('@/shared/context/SessionProtectionContext', () => ({ useBusySessionIdSet: () => new Set() }));
vi.mock('@/modules/sidebar/SidebarModals', () => ({ default: () => null }));
vi.mock('@/modules/sidebar/SidebarContent', () => ({ default: (props: { recentConversations: Array<{ sessionTitle: string }>; onSearchModeChange: (mode: string) => void }) => <><button onClick={() => props.onSearchModeChange('conversations')}>show recents</button><p data-testid="recents">{props.recentConversations.map(row => row.sessionTitle).join(',')}</p></> }));
vi.mock('@/modules/project-workspace', () => ({ ProjectWorkspaceRoute: () => <Probe /> }));
vi.mock('@/shared/api', () => ({
  // Account route events are not exercised here; keep the real provider mounted with an inert subscription.
  subscribeToProviderConnectionChanges: () => () => {},
  readApiJson: async (response: Response) => response.json(),
  api: {
    projects: () => runtime.projects(), recentConversations: () => runtime.recent(), sessionDetails: () => runtime.details(), projectTaskmaster: async () => ({ ok: false }),
    archivedProjects: async () => Response.json({ data: { projects: [] } }), getArchivedSessions: async () => Response.json({ data: { sessions: [] } }),
    providers: { claudeAccounts: { state: async () => Response.json({ success: true, data: {
      runtime: { id: 'server', label: 'Current server' }, activeId: null, accounts: [], defaultAccount: null,
      route: { kind: 'default', label: 'No selected subscription', accountId: null },
    } }) } },
  },
}));
let state: ReturnType<typeof useProjectsState>;
let mounts = 0;
function Probe() {
  const navigate = useNavigate();
  const { sessionId } = useParams();
  const projects = useProjectsState({ sessionId, navigate, subscribe: () => () => {}, isMobile: false, isSessionProcessing: () => false });
  useEffect(() => { state = projects; }, [projects]);
  useEffect(() => { mounts += 1; }, []);
  return <><p data-testid="selection">{projects.selectedProject?.displayName || 'no project'} / {projects.selectedSession?.summary || 'no session'} / {projects.activeTab}</p><Sidebar {...projects.sidebarSharedProps} /></>;
}
const a: Project = { projectId: 'a-project', fullPath: '/a', displayName: 'A private project', sessions: [{ id: 'a-session', summary: 'A private transcript' }] };
const token = (id: number) => `header.${btoa(JSON.stringify({ userId: id, username: id === 1 ? 'a' : 'b' }))}.signature`;
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
beforeEach(() => {
  mounts = 0; localStorage.clear(); vi.stubGlobal('mygo', undefined); runtime.user = { id: 1, username: 'a' };
  window.history.replaceState(null, '', '/session/a-session');
  startAuthSession(token(1));
  runtime.projects.mockReset().mockImplementation(async () => Response.json([a]));
  runtime.recent.mockReset().mockImplementation(async () => Response.json({ data: { conversations: [{ sessionId: 'a-session', sessionTitle: 'A recent title' }] } }));
  runtime.details.mockReset().mockImplementation(async () => Response.json({ data: { sessionId: 'a-session', summary: 'A private transcript', project: a } }));
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

test('logout and B login replace project, session, recents and tab; late A queries cannot restore metadata', async () => {
  const view = render(<App />);
  await screen.findByText(/A private project \/ A private transcript/);
  document.title = 'A private transcript';
  act(() => { state.setActiveTab('files'); });
  act(() => { screen.getByRole('button', { name: 'show recents' }).click(); });
  await screen.findByText('A recent title');
  const pending = deferred<unknown>();
  const lateProjects = { ok: true, json: () => pending.promise };
  runtime.projects.mockResolvedValueOnce(lateProjects);
  let refresh!: Promise<void>;
  act(() => { refresh = state.refreshProjectsSilently(); });
  await act(async () => { await Promise.resolve(); });
  act(() => { clearAuthToken(); runtime.user = null; });
  view.rerender(<App />);
  expect(screen.getByText('signed out')).toBeDefined();
  runtime.projects.mockImplementation(async () => Response.json([]));
  runtime.recent.mockImplementation(async () => Response.json({ data: { conversations: [] } }));
  act(() => { startAuthSession(token(2)); runtime.user = { id: 2, username: 'b' }; });
  view.rerender(<App />);
  await waitFor(() => expect(state.isLoadingProjects).toBe(false));
  await act(async () => { pending.resolve([a]); await refresh; });
  expect(screen.getByTestId('selection').textContent).toBe('no project / no session / chat');
  expect(screen.queryByText(/A private/)).toBeNull();
  expect(screen.queryByText('A recent title')).toBeNull();
  expect(window.location.pathname).toBe('/');
  expect(document.title).not.toContain('A private');
  expect(state.projects).toEqual([]);
});

test('same-account token refresh retains mounted workspace and current selection', async () => {
  const view = render(<App />);
  await screen.findByText(/A private project \/ A private transcript/);
  const previousMounts = mounts;
  act(() => { state.setActiveTab('files'); storeAuthToken(token(1)); runtime.user = { id: 1, username: 'a' }; });
  view.rerender(<App />);
  expect(mounts).toBe(previousMounts);
  expect(state.activeTab).toBe('files');
  expect(state.selectedProject?.projectId).toBe(a.projectId);
});
