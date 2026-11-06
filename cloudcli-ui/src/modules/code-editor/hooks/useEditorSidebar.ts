import { useCallback, useEffect, useRef, useState } from 'react';
import type { MouseEvent as ReactMouseEvent } from 'react';
import { useTranslation } from 'react-i18next';

import type { Project, CodeEditorDiffInfo, CodeEditorFile, WorkspaceDescriptor } from '@/shared/types';

type UseEditorSidebarOptions = {
  projects?: Project[];
  selectedProject: Project | null;
  isMobile: boolean;
  initialWidth?: number;
};

export const useEditorSidebar = ({
  projects,
  selectedProject,
  isMobile,
  initialWidth = 600,
}: UseEditorSidebarOptions) => {
  const { t } = useTranslation('codeEditor');
  const [editingFile, setEditingFile] = useState<CodeEditorFile | null>(null);
  const [editorWidth, setEditorWidth] = useState(initialWidth);
  const [editorExpanded, setEditorExpanded] = useState(false);
  const [isResizing, setIsResizing] = useState(false);
  const [hasManualWidth, setHasManualWidth] = useState(false);
  const resizeHandleRef = useRef<HTMLDivElement | null>(null);
  // Whether the open editor's buffer differs from disk, as reported by
  // CodeEditor. A ref rather than state or a dependency: it is only read inside
  // `handleFileOpen`, and keeping it out of that callback's dependency list
  // keeps the callback stable for the memoised chat and tree consumers.
  const hasUnsavedChangesRef = useRef(false);
  // The open file, mirrored for the same reason: `handleFileOpen` has to know
  // which file is on screen without re-creating itself whenever it changes.
  const editingFileRef = useRef<CodeEditorFile | null>(null);

  useEffect(() => {
    editingFileRef.current = editingFile;
  }, [editingFile]);

  const handleUnsavedChangesChange = useCallback((hasUnsavedChanges: boolean) => {
    hasUnsavedChangesRef.current = hasUnsavedChanges;
  }, []);

  // Returns whether the file was opened, i.e. false when the user kept the
  // unsaved buffer, so callers can skip follow-ups such as switching tabs.
  const handleFileOpen = useCallback(
    (filePath: string, diffInfo: CodeEditorDiffInfo | null = null, workspace?: WorkspaceDescriptor | null, line: number | null = null): boolean => {
      if (workspace === null || (workspace && !workspace.capabilities.read)) return false;
      const normalizedPath = filePath.replace(/\\/g, '/');
      const fileName = normalizedPath.split('/').pop() || filePath;
      // Absolute transcript references can belong to another registered project.
      // Explicit workspace identities must never be replaced with a local owner.
      const isAbsolute = normalizedPath.startsWith('/') || /^[A-Za-z]:\//.test(normalizedPath);
      const owner = isAbsolute && workspace === undefined ? projects?.filter(project => {
        const root = (project.fullPath || project.path || '').replace(/\\/g, '/').replace(/\/+$/, '');
        return root && normalizedPath.startsWith(`${root}/`);
      }).sort((a, b) => (b.fullPath || b.path || '').length - (a.fullPath || a.path || '').length)[0] : undefined;
      const projectId = workspace?.projectId ?? owner?.projectId ?? selectedProject?.projectId;
      const openFile = editingFileRef.current;
      // Polls may replace the descriptor object; identity, generation and project
      // decide whether this open will reuse the buffer rather than discard edits.
      const reusesBuffer = openFile !== null && openFile.path === filePath
        && openFile.projectId === projectId
        && openFile.workspace?.workspaceId === workspace?.workspaceId
        && openFile.workspace?.generation === workspace?.generation
        && !openFile.diffInfo && !diffInfo;
      if (openFile && !reusesBuffer && hasUnsavedChangesRef.current
        && !window.confirm(t('unsavedChanges.confirmClose'))) return false;

      const nextFile: CodeEditorFile = {
        name: fileName,
        path: filePath,
        projectId,
        ...(workspace === undefined ? {} : { workspace }),
        diffInfo,
        ...(line == null ? {} : { line }),
      };
      editingFileRef.current = nextFile;
      setEditingFile(nextFile);
      return true;
    },
    [projects, selectedProject?.projectId, t],
  );

  const handleCloseEditor = useCallback(() => {
    setEditingFile(null);
    setEditorExpanded(false);
  }, []);

  const handleToggleEditorExpand = useCallback(() => {
    setEditorExpanded((previous) => !previous);
  }, []);

  const handleResizeStart = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      if (isMobile) {
        return;
      }

      // After first drag interaction, the editor width is user-controlled.
      setHasManualWidth(true);
      setIsResizing(true);
      event.preventDefault();
    },
    [isMobile],
  );

  useEffect(() => {
    if (!isResizing) {
      return undefined;
    }

    // `editorWidth` is read by WorkspaceMain, so every commit re-renders the
    // whole workspace including the chat transcript. A high-polling-rate mouse
    // fires several mousemove events per frame, so the width is coalesced to one
    // commit per frame — the same visual result for a fraction of the renders.
    let pendingWidth: number | null = null;
    let frameHandle: number | null = null;

    const commitPendingWidth = () => {
      frameHandle = null;
      if (pendingWidth !== null) {
        setEditorWidth(pendingWidth);
        pendingWidth = null;
      }
    };

    const handleMouseMove = (event: globalThis.MouseEvent) => {
      // Get the main container (parent of EditorSidebar's parent) that contains both left content and editor
      const editorContainer = resizeHandleRef.current?.parentElement;
      const mainContainer = editorContainer?.parentElement;
      if (!mainContainer) {
        return;
      }

      const containerRect = mainContainer.getBoundingClientRect();
      // Calculate new editor width: distance from mouse to right edge of main container
      const newWidth = containerRect.right - event.clientX;

      const minWidth = 300;
      const maxWidth = containerRect.width * 0.8;

      if (newWidth >= minWidth && newWidth <= maxWidth) {
        pendingWidth = newWidth;
        if (frameHandle === null) {
          frameHandle = requestAnimationFrame(commitPendingWidth);
        }
      }
    };

    const handleMouseUp = () => {
      setIsResizing(false);
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    return () => {
      if (frameHandle !== null) {
        cancelAnimationFrame(frameHandle);
      }
      // Land on the last position the pointer reached rather than the last
      // frame that happened to commit.
      commitPendingWidth();
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
  }, [isResizing]);

  return {
    editingFile,
    editorWidth,
    editorExpanded,
    hasManualWidth,
    resizeHandleRef,
    handleFileOpen,
    handleCloseEditor,
    handleToggleEditorExpand,
    handleResizeStart,
    handleUnsavedChangesChange,
  };
};
