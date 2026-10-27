import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';

import { ProjectCreationWizard } from '@/modules/project-creation-wizard';
import { api } from '@/shared/api';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

test('folder browsing selects a server directory and keeps local folder selection absent', async () => {
  const browse = vi.spyOn(api, 'browseFilesystem').mockResolvedValue(Response.json({ path: '/cloud', suggestions: [{ path: '/cloud/existing', name: 'existing' }] }));
  const create = vi.spyOn(api, 'createProject').mockResolvedValue(Response.json({ project: { projectId: 'existing', fullPath: '/cloud/existing' } }));
  const opened = vi.fn();
  render(<ProjectCreationWizard onClose={vi.fn()} onProjectCreated={opened} />);
  fireEvent.click(screen.getByTitle('common:misc.browseFolders'));
  await screen.findByText('existing');
  expect(browse).toHaveBeenCalledExactlyOnceWith('~');
  expect(screen.queryByRole('button', { name: '本机' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'folderBrowser.select' }));
  expect((screen.getByPlaceholderText('/path/to/project/workspace') as HTMLInputElement).value).toBe('/cloud/existing');
  fireEvent.click(screen.getByRole('button', { name: 'projectWizard.buttons.next' }));
  fireEvent.click(screen.getByRole('button', { name: 'projectWizard.buttons.createProject' }));
  await waitFor(() => expect(opened).toHaveBeenCalledWith({ projectId: 'existing', fullPath: '/cloud/existing' }));
  expect(create).toHaveBeenCalledExactlyOnceWith({ path: '/cloud/existing' });
});

test('cloud Git import retains server clone progress, credentials and the returned project', async () => {
  const progressUrl = vi.spyOn(api, 'cloneProjectProgressUrl').mockReturnValue('/cloud-clone-progress');
  const credentials = vi.spyOn(api.settings, 'credentials').mockResolvedValue(Response.json({ credentials: [] }));
  const opened = vi.fn();
  const close = vi.fn();
  class CloneEvents {
    static current: CloneEvents;
    onmessage: ((event: { data: string }) => void) | null = null;
    onerror: (() => void) | null = null;
    close = vi.fn();
    constructor(public url: string) { CloneEvents.current = this; }
  }
  vi.stubGlobal('EventSource', CloneEvents);
  render(<ProjectCreationWizard onClose={close} onProjectCreated={opened} />);
  fireEvent.change(screen.getByPlaceholderText('/path/to/project/workspace'), { target: { value: '/cloud/imported' } });
  fireEvent.change(screen.getByPlaceholderText('https://github.com/username/repository'), { target: { value: 'https://github.com/example/project' } });
  await waitFor(() => expect(credentials).toHaveBeenCalledWith('github_token'));
  fireEvent.click(screen.getByRole('button', { name: 'projectWizard.buttons.next' }));
  fireEvent.click(screen.getByRole('button', { name: 'projectWizard.buttons.createProject' }));
  expect(progressUrl).toHaveBeenCalledWith({ path: '/cloud/imported', githubUrl: 'https://github.com/example/project', githubTokenId: '', newGithubToken: null });
  expect(CloneEvents.current.url).toBe('/cloud-clone-progress');
  act(() => CloneEvents.current.onmessage?.({ data: JSON.stringify({ type: 'progress', message: 'Receiving cloud objects 50%' }) }));
  expect(screen.getByText('Receiving cloud objects 50%')).toBeDefined();
  const project = { projectId: 'imported', displayName: 'Imported cloud project', fullPath: '/cloud/imported' };
  await act(async () => CloneEvents.current.onmessage?.({ data: JSON.stringify({ type: 'complete', project }) }));
  expect(opened).toHaveBeenCalledExactlyOnceWith(project);
  expect(close).toHaveBeenCalledOnce();
  expect(CloneEvents.current.close).toHaveBeenCalledOnce();
});
