import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';

import FolderBrowserModal from '@/modules/project-creation-wizard/FolderBrowserModal';
import WorkspacePathField from '@/modules/project-creation-wizard/WorkspacePathField';
import { api } from '@/shared/api';
import { getSuggestionRootPath } from '@/modules/project-creation-wizard/utils/pathUtils';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers(); });

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(finish => { resolve = finish; });
  return { promise, resolve };
}

function listing(path: string, name = 'child') {
  return Response.json({ path, suggestions: [{ name, path: `${path}/${name}` }] });
}

test('failed initial directory loads cannot select a guessed home or create a folder', async () => {
  vi.spyOn(api, 'browseFilesystem').mockResolvedValue(Response.json({ error: 'Directory denied' }, { status: 403 }));
  const selected = vi.fn();
  render(<FolderBrowserModal isOpen autoAdvanceOnSelect={false} onClose={vi.fn()} onFolderSelected={selected} />);
  expect((screen.getByRole('button', { name: 'folderBrowser.useThisFolder' }) as HTMLButtonElement).disabled).toBe(true);
  await screen.findByRole('alert');
  fireEvent.click(screen.getByRole('button', { name: 'folderBrowser.useThisFolder' }));
  expect(selected).not.toHaveBeenCalled();
  expect((screen.getByTitle('folderBrowser.createNew') as HTMLButtonElement).disabled).toBe(true);
  expect(screen.queryByText('folderBrowser.noSubfolders')).toBeNull();
});

test('a closed browser request cannot overwrite the directory in its next opening', async () => {
  const old = deferred<Response>();
  vi.spyOn(api, 'browseFilesystem').mockReturnValueOnce(old.promise).mockResolvedValueOnce(listing('/current'));
  const props = { autoAdvanceOnSelect: false, onClose: vi.fn(), onFolderSelected: vi.fn() };
  const view = render(<FolderBrowserModal {...props} isOpen />);
  view.rerender(<FolderBrowserModal {...props} isOpen={false} />);
  view.rerender(<FolderBrowserModal {...props} isOpen />);
  await screen.findByText('/current');
  await act(async () => old.resolve(listing('/obsolete', 'old-child')));
  expect(screen.queryByText('old-child')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'folderBrowser.useThisFolder' }));
  expect(props.onFolderSelected).toHaveBeenCalledWith('/current', false);
});

test('failed navigation cannot retain selectable entries from the prior directory', async () => {
  const next = deferred<Response>();
  vi.spyOn(api, 'browseFilesystem').mockResolvedValueOnce(listing('/home')).mockReturnValueOnce(next.promise);
  const selected = vi.fn();
  render(<FolderBrowserModal isOpen autoAdvanceOnSelect={false} onClose={vi.fn()} onFolderSelected={selected} />);
  fireEvent.click(await screen.findByRole('button', { name: 'child' }));
  expect(screen.queryByRole('button', { name: 'folderBrowser.select' })).toBeNull();
  expect((screen.getByRole('button', { name: 'folderBrowser.useThisFolder' }) as HTMLButtonElement).disabled).toBe(true);
  await act(async () => next.resolve(Response.json({ error: 'Child unavailable' }, { status: 403 })));
  fireEvent.click(screen.getByRole('button', { name: 'folderBrowser.useThisFolder' }));
  expect(selected).not.toHaveBeenCalled();
  expect(screen.getByRole('alert').textContent).toBe('Child unavailable');
});

test('folder creation locks selection and ignores completion after closing', async () => {
  const pending = deferred<Response>();
  const browse = vi.spyOn(api, 'browseFilesystem').mockResolvedValue(listing('/home'));
  const create = vi.spyOn(api, 'createFolder').mockReturnValue(pending.promise);
  const props = { autoAdvanceOnSelect: false, onClose: vi.fn(), onFolderSelected: vi.fn() };
  const view = render(<FolderBrowserModal {...props} isOpen />);
  await screen.findByText('/home');
  fireEvent.click(screen.getByTitle('folderBrowser.createNew'));
  const input = screen.getByPlaceholderText('folderBrowser.newFolderPlaceholder');
  fireEvent.change(input, { target: { value: 'new' } });
  fireEvent.keyDown(input, { key: 'Enter' });
  fireEvent.keyDown(input, { key: 'Enter' });
  expect(create).toHaveBeenCalledExactlyOnceWith('/home/new');
  expect((screen.getByRole('button', { name: 'folderBrowser.useThisFolder' }) as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByRole('button', { name: 'child' }) as HTMLButtonElement).disabled).toBe(true);
  view.rerender(<FolderBrowserModal {...props} isOpen={false} />);
  await act(async () => pending.resolve(Response.json({ path: '/home/new', success: true })));
  expect(browse).toHaveBeenCalledTimes(1);
});

test('a creation error keeps the draft and allows an explicit retry', async () => {
  const browse = vi.spyOn(api, 'browseFilesystem').mockResolvedValue(listing('/home'));
  const create = vi.spyOn(api, 'createFolder')
    .mockResolvedValueOnce(Response.json({ error: 'Folder creation denied' }, { status: 403 }))
    .mockResolvedValueOnce(Response.json({ path: '/home/new', success: true }));
  render(<FolderBrowserModal isOpen autoAdvanceOnSelect={false} onClose={vi.fn()} onFolderSelected={vi.fn()} />);
  await screen.findByText('/home');
  fireEvent.click(screen.getByTitle('folderBrowser.createNew'));
  fireEvent.change(screen.getByPlaceholderText('folderBrowser.newFolderPlaceholder'), { target: { value: 'new' } });
  fireEvent.click(screen.getByRole('button', { name: 'folderBrowser.create' }));
  expect((await screen.findByRole('alert')).textContent).toBe('Folder creation denied');
  expect((screen.getByPlaceholderText('folderBrowser.newFolderPlaceholder') as HTMLInputElement).value).toBe('new');
  expect(browse).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole('button', { name: 'folderBrowser.create' }));
  await act(async () => {});
  expect(create).toHaveBeenCalledTimes(2);
  expect(browse).toHaveBeenLastCalledWith('/home/new');
});

test('a created directory whose listing fails cannot silently select its old parent', async () => {
  vi.spyOn(api, 'browseFilesystem').mockResolvedValueOnce(listing('/home'))
    .mockResolvedValueOnce(Response.json({ error: 'New directory unavailable' }, { status: 403 }));
  vi.spyOn(api, 'createFolder').mockResolvedValue(Response.json({ path: '/home/new', success: true }));
  const selected = vi.fn();
  render(<FolderBrowserModal isOpen autoAdvanceOnSelect={false} onClose={vi.fn()} onFolderSelected={selected} />);
  await screen.findByText('/home');
  fireEvent.click(screen.getByTitle('folderBrowser.createNew'));
  fireEvent.change(screen.getByPlaceholderText('folderBrowser.newFolderPlaceholder'), { target: { value: 'new' } });
  fireEvent.click(screen.getByRole('button', { name: 'folderBrowser.create' }));
  await screen.findByText('New directory unavailable');
  fireEvent.click(screen.getByRole('button', { name: 'folderBrowser.useThisFolder' }));
  expect(selected).not.toHaveBeenCalled();
  expect((screen.getByTitle('folderBrowser.createNew') as HTMLButtonElement).disabled).toBe(true);
});

test('autocomplete discards a delayed response for an old path and clears prior suggestions on failure', async () => {
  vi.useFakeTimers();
  const old = deferred<Response>();
  const current = deferred<Response>();
  const failing = deferred<Response>();
  vi.spyOn(api, 'browseFilesystem').mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise).mockReturnValueOnce(failing.promise);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const props = { onChange: vi.fn(), onAdvanceToConfirm: vi.fn() };
  const view = render(<WorkspacePathField {...props} value="/old/a" />);
  await act(async () => { vi.advanceTimersByTime(200); });
  view.rerender(<WorkspacePathField {...props} value="/current/b" />);
  await act(async () => { vi.advanceTimersByTime(200); });
  await act(async () => current.resolve(listing('/current', 'beta')));
  expect(screen.getByRole('button', { name: 'beta /current/beta' })).toBeDefined();
  await act(async () => old.resolve(listing('/old', 'alpha')));
  expect(screen.queryByText('alpha')).toBeNull();
  expect(screen.getByText('beta')).toBeDefined();
  view.rerender(<WorkspacePathField {...props} value="/denied/c" />);
  expect(screen.queryByText('beta')).toBeNull();
  await act(async () => { vi.advanceTimersByTime(200); failing.resolve(Response.json({ error: 'denied' }, { status: 403 })); });
  expect(screen.queryByText('beta')).toBeNull();
});

test('absolute root paths resolve suggestions against the filesystem root', () => {
  expect(getSuggestionRootPath('/projects')).toBe('/');
  expect(getSuggestionRootPath('C:\\projects')).toBe('C:\\');
});
