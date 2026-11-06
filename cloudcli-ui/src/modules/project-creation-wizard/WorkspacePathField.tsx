import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FolderOpen } from 'lucide-react';

import { Button, Input } from '@/shared/ui';
import { getAuthSessionVersion } from '@/shared/authToken';
import { getServerConnectionVersion } from '@/shared/chisa';
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
  // Server directory suggestions let the user complete an existing or new cloud path.
  const [pathSuggestions, setPathSuggestions] = useState<FolderSuggestion[]>([]);
  // Keep the suggestion list open only while it is relevant to the current path.
  const [showPathDropdown, setShowPathDropdown] = useState(false);
  // The server folder browser shares the path field's selection and confirmation flow.
  const [showFolderBrowser, setShowFolderBrowser] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const auth = getAuthSessionVersion();
    const server = getServerConnectionVersion();
    const current = () => !cancelled && auth === getAuthSessionVersion() && server === getServerConnectionVersion();
    // An old listing must not stay selectable while a different path is being resolved.
    setPathSuggestions([]);
    setShowPathDropdown(false);
    if (disabled || value.trim().length <= 2) {
      return;
    }

    // Debounce path lookup to avoid firing a request for every keystroke.
    const timerId = window.setTimeout(async () => {
      try {
        const directoryPath = getSuggestionRootPath(value);
        const result = await browseFilesystemFolders(directoryPath);
        if (!current()) return;
        const normalizedInput = value.trim().toLowerCase();

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
        if (current()) console.error('Failed to load path suggestions:', error);
      }
    }, 200);

    return () => {
      cancelled = true;
      window.clearTimeout(timerId);
    };
  }, [disabled, value]);

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

          {!disabled && showPathDropdown && pathSuggestions.length > 0 && (
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
      </div>

      <FolderBrowserModal
        isOpen={showFolderBrowser}
        autoAdvanceOnSelect={false}
        onClose={() => setShowFolderBrowser(false)}
        onFolderSelected={handleFolderSelected}
      />
    </>
  );
}
