import { useCallback, useEffect, useRef, useState } from 'react';
import type { SetStateAction } from 'react';

import { api } from '@/shared/api';
import type { CodeEditorFile } from '@/shared/types';
import { isBinaryFile } from '@/modules/code-editor/utils/binaryFile';
import { getPreviewKind } from '@/modules/code-editor/utils/previewableFile';

type UseCodeEditorDocumentParams = {
  file: CodeEditorFile;
  projectPath?: string;
};

const getErrorMessage = (error: unknown) => {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
};

/** CodeEditor keeps its document and explicit save requests independent of presentation changes. */
export const useCodeEditorDocument = ({ file, projectPath }: UseCodeEditorDocumentParams) => {
  // The current editor buffer remains editable while its earlier snapshot is saving.
  const [content, setContentState] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [isBinary, setIsBinary] = useState(false);
  // Some binaries (images, PDFs, audio, video) can be rendered natively, so the
  // editor shows an inline preview instead of the generic binary placeholder.
  const previewKind = getPreviewKind(file.name);
  // `fileProjectId` is the DB primary key passed down from the editor sidebar;
  // the fallback to `projectPath` preserves older callers that didn't yet
  // propagate the identifier.
  const fileProjectId = file.projectId ?? projectPath;
  const filePath = file.path;
  const fileName = file.name;
  const fileDiffNewString = file.diffInfo?.new_string;
  const fileDiffOldString = file.diffInfo?.old_string;
  // Async reads, saves and success timers belong to one exact editor document.
  const scope = JSON.stringify([fileProjectId, filePath, fileDiffNewString, fileDiffOldString]);
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
    readyRef.current = null;
    requestedSave.current = false;
    hashRef.current = undefined;
    setContent('');
    setSaving(false);
    setSaveError(null);
    setSaveSuccess(false);
    const loadFileContent = async () => {
      try {
        setLoading(true);
        setIsBinary(false);

        // Natively previewable media (image/pdf/audio/video) is rendered by
        // CodeEditorMediaPreview, so there is nothing to read as text here.
        // Clear any buffer left over from a previously opened text file so a
        // stray save can't write stale content over the binary file.
        if (getPreviewKind(file.name)) {
          setContent('');
          setLoading(false);
          return;
        }

        // Check if file is binary by extension
        if (isBinaryFile(file.name)) {
          setContent('');
          setIsBinary(true);
          setLoading(false);
          return;
        }

        // Diff payload may already include full old/new snapshots, so avoid disk read.

        if (!fileProjectId) {
          throw new Error('Missing project identifier');
        }

        const response = await api.readFile(fileProjectId, filePath, { signal: controller.signal });
        if (!response.ok) {
          throw new Error(`Failed to load file: ${response.status} ${response.statusText}`);
        }

        const data = await response.json();
        if (!current()) return;
        const hasDiffSnapshot = fileDiffNewString !== undefined && fileDiffOldString !== undefined;
        setContent(hasDiffSnapshot ? fileDiffNewString : data.content);
        if (!hasDiffSnapshot || data.content === fileDiffOldString || data.content === fileDiffNewString) {
          hashRef.current = data.hash;
        }
        readyRef.current = scope;
      } catch (error) {
        if (!current()) return;
        const message = getErrorMessage(error);
        console.error('Error loading file:', error);
        setContent(`// Error loading file: ${message}\n// File: ${fileName}\n// Path: ${filePath}`);
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
  }, [fileName, filePath, fileProjectId, fileDiffNewString, fileDiffOldString, scope, setContent]);

  const handleSave = useCallback(async () => {
    // Preview-only and binary files have no editable text buffer; never write
    // them back (e.g. via Cmd/Ctrl+S) or we'd corrupt the file on disk.
    if (previewKind || isBinaryFile(fileName) || loading || readyRef.current !== scope || scopeRef.current !== scope) {
      return;
    }
    if (saveControllerRef.current) {
      // A second explicit save requests the newer buffer, not a duplicate of the in-flight write.
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
      if (!fileProjectId) {
        throw new Error('Missing project identifier');
      }

      do {
        requestedSave.current = false;
        const submittedContent = contentRef.current;
        activeSaveContent.current = submittedContent;
        const response = await api.saveFile(fileProjectId, filePath, submittedContent, hashRef.current, { signal: controller.signal });

        if (!response.ok) {
          const contentType = response.headers.get('content-type');
          if (contentType?.includes('application/json')) {
            const errorData = await response.json();
            throw new Error(errorData.error || `Save failed: ${response.status}`);
          }

          const textError = await response.text();
          console.error('Non-JSON error response:', textError);
          throw new Error(`Save failed: ${response.status} ${response.statusText}`);
        }

        const saved = await response.json();
        if (!current()) return;
        hashRef.current = saved.hash;

        const latestSaved = contentRef.current === submittedContent;
        setSaveSuccess(latestSaved);
        if (successTimerRef.current) clearTimeout(successTimerRef.current);
        if (latestSaved) successTimerRef.current = setTimeout(() => {
          if (current()) setSaveSuccess(false);
        }, 2000);
      } while (requestedSave.current && current() && contentRef.current !== activeSaveContent.current);
    } catch (error) {
      if (!current()) return;
      const message = getErrorMessage(error);
      console.error('Error saving file:', error);
      setSaveError(message);
    } finally {
      if (current()) setSaving(false);
      if (saveControllerRef.current === controller) {
        saveControllerRef.current = null;
        activeSaveContent.current = null;
        requestedSave.current = false;
      }
    }
  }, [filePath, fileProjectId, previewKind, fileName, loading, scope]);

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

  return {
    content,
    setContent,
    loading,
    saving,
    saveSuccess,
    saveError,
    isBinary,
    previewKind,
    fileProjectId,
    handleSave,
    handleDownload,
  };
};
