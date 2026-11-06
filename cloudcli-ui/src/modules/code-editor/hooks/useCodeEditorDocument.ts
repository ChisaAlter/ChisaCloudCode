import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { SetStateAction } from 'react';

import { readApiJson } from '@/shared/api';
import { useEditorWorkspaceApi, useEditorWorkspaceSaveFile } from '@/shared/context/WorkspaceScopeContext';
import type { CodeEditorFile } from '@/shared/types';
import { isBinaryFile } from '@/modules/code-editor/utils/binaryFile';
import { getPreviewKind } from '@/modules/code-editor/utils/previewableFile';

type UseCodeEditorDocumentParams = {
  file: CodeEditorFile;
  projectPath?: string;
};

const getErrorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);

// CodeMirror normalizes to LF, so loading a CRLF file must not itself mark it dirty.
const normalizeLineEndings = (text: string) => text.replace(/\r\n?/g, '\n');

/** CodeEditor keeps document reads, dirty tracking and explicit saves independent of layout changes. */
export const useCodeEditorDocument = ({ file, projectPath }: UseCodeEditorDocumentParams) => {
  const api = useEditorWorkspaceApi(file);
  const saveFile = useEditorWorkspaceSaveFile(file);
  // The current editor buffer remains editable while its earlier snapshot is saving.
  const [content, setContentState] = useState('');
  // Compare with the exact snapshot last loaded or saved to guard discarding edits.
  const [savedContent, setSavedContent] = useState('');
  // Loading hides the previous document until the current scoped read finishes.
  const [loading, setLoading] = useState(true);
  // The active explicit save controls the toolbar spinner.
  const [saving, setSaving] = useState(false);
  // A short-lived tick confirms that the current buffer reached disk.
  const [saveSuccess, setSaveSuccess] = useState(false);
  // Failed writes leave the editable buffer intact and explain the failure.
  const [saveError, setSaveError] = useState<string | null>(null);
  // Non-previewable binary files must never be saved as text.
  const [isBinary, setIsBinary] = useState(false);
  const previewKind = getPreviewKind(file.name);
  const fileProjectId = file.projectId ?? projectPath;
  const filePath = file.path;
  const fileName = file.name;
  const fileDiffNewString = file.diffInfo?.new_string;
  const fileDiffOldString = file.diffInfo?.old_string;
  // Async reads, saves and success timers belong to one exact editor document.
  const scope = JSON.stringify([fileProjectId, filePath, fileDiffNewString, fileDiffOldString, file.workspace?.workspaceId, file.workspace?.generation, file.workspace === null]);
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  const revisionRef = useRef(0);
  const readyRef = useRef<string | null>(null);
  const saveControllerRef = useRef<AbortController | null>(null);
  const successTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const contentRef = useRef(content);
  const hashRef = useRef<string | undefined>(undefined);
  const activeSaveContent = useRef<string | null>(null);
  const requestedSave = useRef(false);
  const setContent = useCallback((value: SetStateAction<string>) => {
    const next = typeof value === 'function' ? value(contentRef.current) : value;
    contentRef.current = next;
    setContentState(next);
    setSaveSuccess(false);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const revision = ++revisionRef.current;
    const current = () => !controller.signal.aborted && revisionRef.current === revision && scopeRef.current === scope;
    // Every load path resets the buffer and baseline together, including errors.
    const applyLoadedContent = (text: string) => {
      setContent(text);
      setSavedContent(text);
    };
    readyRef.current = null;
    requestedSave.current = false;
    hashRef.current = undefined;
    applyLoadedContent('');
    setSaving(false);
    setSaveError(null);
    setSaveSuccess(false);

    const loadFileContent = async () => {
      try {
        setLoading(true);
        setIsBinary(false);
        // Preview media and binaries have no editable text buffer.
        if (getPreviewKind(fileName)) return;
        if (isBinaryFile(fileName)) {
          setIsBinary(true);
          return;
        }
        if (!fileProjectId) throw new Error('Missing project identifier');

        // Even a supplied diff snapshot needs the disk hash for compare-and-save.
        const response = await api.readFile(fileProjectId, filePath, { signal: controller.signal });
        const data = await readApiJson<{ content: string; hash?: string }>(response);
        if (!current()) return;
        const hasDiffSnapshot = fileDiffNewString !== undefined && fileDiffOldString !== undefined;
        applyLoadedContent(hasDiffSnapshot ? fileDiffNewString : data.content);
        if (!hasDiffSnapshot || data.content === fileDiffOldString || data.content === fileDiffNewString) {
          hashRef.current = data.hash;
        }
        readyRef.current = scope;
      } catch (error) {
        if (!current()) return;
        console.error('Error loading file:', error);
        applyLoadedContent(`// Error loading file: ${getErrorMessage(error)}\n// File: ${fileName}\n// Path: ${filePath}`);
      } finally {
        if (current()) setLoading(false);
      }
    };

    void loadFileContent();
    return () => {
      controller.abort();
      saveControllerRef.current?.abort();
      saveControllerRef.current = null;
      activeSaveContent.current = null;
      requestedSave.current = false;
      if (successTimerRef.current) clearTimeout(successTimerRef.current);
    };
  }, [api, fileName, filePath, fileProjectId, fileDiffNewString, fileDiffOldString, scope, setContent]);

  const handleSave = useCallback(async () => {
    if (previewKind || isBinaryFile(fileName) || loading || readyRef.current !== scope || scopeRef.current !== scope) return;
    if (saveControllerRef.current) {
      // A second explicit save requests the newer buffer, not a duplicate write.
      if (contentRef.current !== activeSaveContent.current) requestedSave.current = true;
      return;
    }
    const controller = new AbortController();
    saveControllerRef.current = controller;
    const revision = revisionRef.current;
    const current = () => !controller.signal.aborted && revisionRef.current === revision && scopeRef.current === scope;
    setSaving(true);
    setSaveError(null);
    setSaveSuccess(false);
    try {
      if (!fileProjectId) throw new Error('Missing project identifier');
      do {
        requestedSave.current = false;
        const submittedContent = contentRef.current;
        activeSaveContent.current = submittedContent;
        const response = await saveFile(fileProjectId, filePath, submittedContent, hashRef.current, { signal: controller.signal });
        const saved = await readApiJson<{ hash?: string }>(response);
        if (!current()) return;
        hashRef.current = saved.hash;
        // Edits made during the write remain dirty against the submitted snapshot.
        setSavedContent(submittedContent);
        const latestSaved = contentRef.current === submittedContent;
        setSaveSuccess(latestSaved);
        if (successTimerRef.current) clearTimeout(successTimerRef.current);
        if (latestSaved) successTimerRef.current = setTimeout(() => {
          if (current()) setSaveSuccess(false);
        }, 2000);
      } while (requestedSave.current && current() && contentRef.current !== activeSaveContent.current);
    } catch (error) {
      if (!current()) return;
      console.error('Error saving file:', error);
      setSaveError(getErrorMessage(error));
    } finally {
      if (current()) setSaving(false);
      if (saveControllerRef.current === controller) {
        saveControllerRef.current = null;
        activeSaveContent.current = null;
        requestedSave.current = false;
      }
    }
  }, [saveFile, filePath, fileProjectId, previewKind, fileName, loading, scope]);

  const handleDownload = useCallback(() => {
    const blob = new Blob([content], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = file.name;
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    URL.revokeObjectURL(url);
  }, [content, file.name]);

  const normalizedSavedContent = useMemo(() => normalizeLineEndings(savedContent), [savedContent]);
  const hasUnsavedChanges = useMemo(
    () => !loading && !previewKind && !isBinary && content !== savedContent
      && normalizeLineEndings(content) !== normalizedSavedContent,
    [content, isBinary, loading, normalizedSavedContent, previewKind, savedContent],
  );

  return {
    content, setContent, loading, saving, saveSuccess, saveError, isBinary,
    previewKind, fileProjectId, hasUnsavedChanges, handleSave, handleDownload,
  };
};
