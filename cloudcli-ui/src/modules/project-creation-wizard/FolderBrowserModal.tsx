import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Eye, EyeOff, FolderOpen, FolderPlus, Loader2, Plus, X } from 'lucide-react';

import { Button, Input } from '@/shared/ui';
import { getAuthSessionVersion } from '@/shared/authToken';
import { getServerConnectionVersion } from '@/shared/chisa';
import { browseFilesystemFolders, createFolderInFilesystem } from '@/modules/project-creation-wizard/utils/workspaceApi';
import { getParentPath, joinFolderPath } from '@/modules/project-creation-wizard/utils/pathUtils';
import type { FolderSuggestion } from '@/shared/types';

type FolderBrowserModalProps = {
  isOpen: boolean;
  autoAdvanceOnSelect: boolean;
  onClose: () => void;
  onFolderSelected: (folderPath: string, advanceToConfirm: boolean) => void;
};

/** Opened by WorkspacePathField so the user can browse the filesystem and pick or create the workspace folder. */
export default function FolderBrowserModal({
  isOpen,
  autoAdvanceOnSelect,
  onClose,
  onFolderSelected,
}: FolderBrowserModalProps) {
  const { t } = useTranslation();
  // Only a successfully loaded directory may be selected or used as a creation parent.
  const [currentPath, setCurrentPath] = useState('');
  // Display only entries returned for the current directory request.
  const [folders, setFolders] = useState<FolderSuggestion[]>([]);
  // Hide directory actions until the pending listing has settled.
  const [loadingFolders, setLoadingFolders] = useState(false);
  // Let the user reveal hidden directory entries.
  const [showHiddenFolders, setShowHiddenFolders] = useState(false);
  // Keep the folder-name editor open while the user supplies a name.
  const [showNewFolderInput, setShowNewFolderInput] = useState(false);
  // Retain the draft folder name through a failed creation request.
  const [newFolderName, setNewFolderName] = useState('');
  // Lock navigation and selection until folder creation has settled.
  const [creatingFolder, setCreatingFolder] = useState(false);
  // Keep directory and creation failures visible until the next request.
  const [error, setError] = useState<string | null>(null);

  const requestRef = useRef(0);
  const createPendingRef = useRef(false);
  // Keep locale changes from reopening the browser at the home directory.
  const loadFoldersRef = useRef<(pathToLoad: string) => Promise<void>>();

  const loadFolders = useCallback(async (pathToLoad: string) => {
    const request = ++requestRef.current;
    const auth = getAuthSessionVersion();
    const server = getServerConnectionVersion();
    const current = () => request === requestRef.current && auth === getAuthSessionVersion() && server === getServerConnectionVersion();
    setCurrentPath('');
    setFolders([]);
    setLoadingFolders(true);
    setError(null);

    try {
      const result = await browseFilesystemFolders(pathToLoad);
      if (!current()) return;
      setCurrentPath(result.path);
      setFolders(result.suggestions);
    } catch (loadError) {
      if (current()) setError(loadError instanceof Error ? loadError.message : t('folderBrowser.loadFailed'));
    } finally {
      if (current()) setLoadingFolders(false);
    }
  }, [t]);

  useEffect(() => {
    loadFoldersRef.current = loadFolders;
  }, [loadFolders]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }
    createPendingRef.current = false;
    setCreatingFolder(false);
    setShowNewFolderInput(false);
    setNewFolderName('');
    void loadFoldersRef.current?.('~');
    return () => { ++requestRef.current; };
  }, [isOpen]);

  const visibleFolders = useMemo(
    () =>
      folders
        .filter((folder) => showHiddenFolders || !folder.name.startsWith('.'))
        .sort((firstFolder, secondFolder) =>
          firstFolder.name.toLowerCase().localeCompare(secondFolder.name.toLowerCase()),
        ),
    [folders, showHiddenFolders],
  );

  const resetNewFolderState = () => {
    setShowNewFolderInput(false);
    setNewFolderName('');
  };

  const handleClose = () => {
    ++requestRef.current;
    setError(null);
    resetNewFolderState();
    onClose();
  };

  const handleCreateFolder = useCallback(async () => {
    if (!newFolderName.trim() || !currentPath || loadingFolders || createPendingRef.current) {
      return;
    }

    const request = requestRef.current;
    const auth = getAuthSessionVersion();
    const server = getServerConnectionVersion();
    const current = () => request === requestRef.current && auth === getAuthSessionVersion() && server === getServerConnectionVersion();
    createPendingRef.current = true;
    setCreatingFolder(true);
    setError(null);

    try {
      const folderPath = joinFolderPath(currentPath, newFolderName);
      const createdPath = await createFolderInFilesystem(folderPath);
      if (!current()) return;
      resetNewFolderState();
      // The follow-up listing owns its own request generation.
      createPendingRef.current = false;
      setCreatingFolder(false);
      await loadFolders(createdPath);
    } catch (createError) {
      if (current()) setError(createError instanceof Error ? createError.message : t('folderBrowser.createFailed'));
    } finally {
      if (current()) { createPendingRef.current = false; setCreatingFolder(false); }
    }
  }, [currentPath, loadingFolders, loadFolders, newFolderName, t]);

  const parentPath = currentPath ? getParentPath(currentPath) : null;

  if (!isOpen) {
    return null;
  }

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm">
      <div className="flex max-h-[80vh] w-full max-w-2xl flex-col rounded-lg border border-gray-200 bg-white shadow-xl dark:border-gray-700 dark:bg-gray-800">
        <div className="flex items-center justify-between border-b border-gray-200 p-4 dark:border-gray-700">
          <div className="flex items-center gap-3">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-blue-100 dark:bg-blue-900/50">
              <FolderOpen className="h-4 w-4 text-blue-600 dark:text-blue-400" />
            </div>
            <h3 className="text-lg font-semibold text-gray-900 dark:text-white">{t('folderBrowser.title')}</h3>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={() => setShowHiddenFolders((previous) => !previous)}
              className={`rounded-md p-2 transition-colors ${
                showHiddenFolders
                  ? 'bg-blue-50 text-blue-600 dark:bg-blue-900/30 dark:text-blue-400'
                  : 'text-gray-400 hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-gray-700 dark:hover:text-gray-300'
              }`}
              title={showHiddenFolders ? t('folderBrowser.hideHidden') : t('folderBrowser.showHidden')}
            >
              {showHiddenFolders ? <Eye className="h-5 w-5" /> : <EyeOff className="h-5 w-5" />}
            </button>
            <button
              onClick={() => setShowNewFolderInput((previous) => !previous)}
              className={`rounded-md p-2 transition-colors ${
                showNewFolderInput
                  ? 'bg-blue-50 text-blue-600 dark:bg-blue-900/30 dark:text-blue-400'
                  : 'text-gray-400 hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-gray-700 dark:hover:text-gray-300'
              }`}
              title={t('folderBrowser.createNew')}
              disabled={!currentPath || loadingFolders || creatingFolder}
            >
              <Plus className="h-5 w-5" />
            </button>
            <button
              onClick={handleClose}
              className="rounded-md p-2 text-gray-400 hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-gray-700 dark:hover:text-gray-300"
            >
              <X className="h-5 w-5" />
            </button>
          </div>
        </div>

        {showNewFolderInput && (
          <div className="border-b border-gray-200 bg-blue-50 px-4 py-3 dark:border-gray-700 dark:bg-blue-900/20">
            <div className="flex items-center gap-2">
              <Input
                type="text"
                value={newFolderName}
                onChange={(event) => setNewFolderName(event.target.value)}
                placeholder={t('folderBrowser.newFolderPlaceholder')}
                className="flex-1"
                disabled={loadingFolders || creatingFolder || !currentPath}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    handleCreateFolder();
                  }
                  if (event.key === 'Escape') {
                    resetNewFolderState();
                  }
                }}
                autoFocus
              />
              <Button
                size="sm"
                onClick={handleCreateFolder}
                disabled={!newFolderName.trim() || creatingFolder || loadingFolders || !currentPath}
              >
                {creatingFolder ? <Loader2 className="h-4 w-4 animate-spin" /> : t('folderBrowser.create')}
              </Button>
              <Button size="sm" variant="ghost" onClick={resetNewFolderState}>
                {t('common:cancel')}
              </Button>
            </div>
          </div>
        )}

        {error && (
          <div className="px-4 pt-3">
            <p role="alert" className="text-sm text-red-600 dark:text-red-400">{error}</p>
          </div>
        )}

        <div className="flex-1 overflow-y-auto p-4">
          {loadingFolders ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-6 w-6 animate-spin text-gray-400" />
            </div>
          ) : (
            <div className="space-y-1">
              {parentPath && (
                <button
                  onClick={() => loadFolders(parentPath)}
                  disabled={creatingFolder}
                  className="flex w-full items-center gap-3 rounded-lg px-4 py-3 text-left hover:bg-gray-100 dark:hover:bg-gray-700"
                >
                  <FolderOpen className="h-5 w-5 text-gray-400" />
                  <span className="font-medium text-gray-700 dark:text-gray-300">..</span>
                </button>
              )}

              {error && !currentPath ? null : visibleFolders.length === 0 ? (
                <div className="py-8 text-center text-gray-500 dark:text-gray-400">
                  {t('folderBrowser.noSubfolders')}
                </div>
              ) : (
                visibleFolders.map((folder) => (
                  <div key={folder.path} className="flex items-center gap-2">
                    <button
                      onClick={() => loadFolders(folder.path)}
                      disabled={creatingFolder}
                      className="flex flex-1 items-center gap-3 rounded-lg px-4 py-3 text-left hover:bg-gray-100 dark:hover:bg-gray-700"
                    >
                      <FolderPlus className="h-5 w-5 text-blue-500" />
                      <span className="font-medium text-gray-900 dark:text-white">
                        {folder.name}
                      </span>
                    </button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => onFolderSelected(folder.path, autoAdvanceOnSelect)}
                      disabled={creatingFolder}
                      className="px-3 text-xs"
                    >
                      {t('folderBrowser.select')}
                    </Button>
                  </div>
                ))
              )}
            </div>
          )}
        </div>

        <div className="border-t border-gray-200 dark:border-gray-700">
          <div className="flex items-center gap-2 bg-gray-50 px-4 py-3 dark:bg-gray-900/50">
            <span className="text-sm text-gray-600 dark:text-gray-400">{t('folderBrowser.pathLabel')}</span>
            <code className="flex-1 truncate font-mono text-sm text-gray-900 dark:text-white">
              {currentPath || '-'}
            </code>
          </div>
          <div className="flex items-center justify-end gap-2 p-4">
            <Button variant="outline" onClick={handleClose}>
              {t('common:cancel')}
            </Button>
            <Button
              variant="outline"
              onClick={() => onFolderSelected(currentPath, autoAdvanceOnSelect)}
              disabled={!currentPath || loadingFolders || creatingFolder}
            >
              {t('folderBrowser.useThisFolder')}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
