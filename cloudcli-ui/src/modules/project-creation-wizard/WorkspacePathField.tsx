import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FolderOpen, Laptop } from 'lucide-react';

import { Button, Input } from '@/shared/ui';
import { usePaletteOps } from '@/modules/command-palette';
import { isDesktop } from '@/shared/chisa';
import { browseFilesystemFolders } from '@/modules/project-creation-wizard/utils/workspaceApi';
import { getSuggestionRootPath } from '@/modules/project-creation-wizard/utils/pathUtils';
import type { FolderSuggestion } from '@/shared/types';
import FolderBrowserModal from '@/modules/project-creation-wizard/FolderBrowserModal';

type WorkspacePathFieldProps = {
  value: string;
  disabled?: boolean;
  onChange: (path: string) => void;
  onAdvanceToConfirm: () => void;
};

/** Rendered by StepConfiguration to enter the workspace path with folder autocompletion and a browse button. */
export default function WorkspacePathField({
  value,
  disabled = false,
  onChange,
  onAdvanceToConfirm,
}: WorkspacePathFieldProps) {
  const { t } = useTranslation();
  const desktopAvailable = isDesktop();
  const paletteOps = usePaletteOps();
  const [pathSuggestions, setPathSuggestions] = useState<FolderSuggestion[]>([]);
  const [showPathDropdown, setShowPathDropdown] = useState(false);
  const [showFolderBrowser, setShowFolderBrowser] = useState(false);
  const [localSelecting, setLocalSelecting] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  const handleSelectLocalFolder = useCallback(async () => {
    setLocalSelecting(true);
    setLocalError(null);
    try {
      const { FrontendBridge, recordLocalSelection } = await import('@/shared/chisa');
      const result = await FrontendBridge.selectLocalFolder();
      if (result.action === 'manage-mappings') {
        paletteOps.openSettings('chisa');
        return;
      }
      if (result.ok && result.serverPath) {
        recordLocalSelection({ localPath: String(result.localPath || ''), serverPath: String(result.serverPath) });
        onChange(String(result.serverPath));
        onAdvanceToConfirm();
      } else if (!result.canceled && result.error) {
        setLocalError(String(result.error));
      }
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : String(error));
    } finally {
      setLocalSelecting(false);
    }
  }, [onAdvanceToConfirm, onChange, paletteOps]);

  useEffect(() => {
    if (value.trim().length <= 2) {
      setPathSuggestions([]);
      setShowPathDropdown(false);
      return;
    }

    // Debounce path lookup to avoid firing a request for every keystroke.
    const timerId = window.setTimeout(async () => {
      try {
        const directoryPath = getSuggestionRootPath(value);
        const result = await browseFilesystemFolders(directoryPath);
        const normalizedInput = value.toLowerCase();

        const matchingSuggestions = result.suggestions
          .filter((suggestion) => {
            const normalizedSuggestion = suggestion.path.toLowerCase();
            return (
              normalizedSuggestion.startsWith(normalizedInput) &&
              normalizedSuggestion !== normalizedInput
            );
          })
          .slice(0, 5);

        setPathSuggestions(matchingSuggestions);
        setShowPathDropdown(matchingSuggestions.length > 0);
      } catch (error) {
        console.error('Failed to load path suggestions:', error);
      }
    }, 200);

    return () => {
      window.clearTimeout(timerId);
    };
  }, [value]);

  const handleSuggestionSelect = useCallback(
    (suggestion: FolderSuggestion) => {
      onChange(suggestion.path);
      setShowPathDropdown(false);
    },
    [onChange],
  );

  const handleFolderSelected = useCallback(
    (selectedPath: string, advanceToConfirm: boolean) => {
      onChange(selectedPath);
      setShowFolderBrowser(false);
      if (advanceToConfirm) {
        onAdvanceToConfirm();
      }
    },
    [onAdvanceToConfirm, onChange],
  );

  return (
    <>
      <div className="relative flex gap-2">
        <div className="relative flex-1">
          <Input
            type="text"
            value={value}
            onChange={(event) => onChange(event.target.value)}
            placeholder="/path/to/project/workspace"
            className="w-full"
            disabled={disabled}
          />

          {showPathDropdown && pathSuggestions.length > 0 && (
            <div className="absolute z-10 mt-1 max-h-60 w-full overflow-y-auto rounded-lg border border-gray-200 bg-white shadow-lg dark:border-gray-700 dark:bg-gray-800">
              {pathSuggestions.map((suggestion) => (
                <button
                  key={suggestion.path}
                  onClick={() => handleSuggestionSelect(suggestion)}
                  className="w-full px-4 py-2 text-left text-sm hover:bg-gray-100 dark:hover:bg-gray-700"
                >
                  <div className="font-medium text-gray-900 dark:text-white">{suggestion.name}</div>
                  <div className="text-xs text-gray-500 dark:text-gray-400">{suggestion.path}</div>
                </button>
              ))}
            </div>
          )}
        </div>

        <Button
          type="button"
          variant="outline"
          onClick={() => setShowFolderBrowser(true)}
          className="px-3"
          title={t('common:misc.browseFolders')}
          disabled={disabled}
        >
          <FolderOpen className="h-4 w-4" />
        </Button>
        {desktopAvailable && (
          <Button type="button" variant="outline" onClick={() => void handleSelectLocalFolder()} className="px-3" title="选择本机文件夹（自动同步并创建项目）" disabled={disabled || localSelecting}>
            <Laptop className="h-4 w-4" />
            {localSelecting ? '…' : '本机'}
          </Button>
        )}
      </div>
      {localError && <p className="mt-1 text-xs text-red-500">本地目录失败：{localError}</p>}

      <FolderBrowserModal
        isOpen={showFolderBrowser}
        autoAdvanceOnSelect={false}
        onClose={() => setShowFolderBrowser(false)}
        onFolderSelected={handleFolderSelected}
      />
    </>
  );
}
