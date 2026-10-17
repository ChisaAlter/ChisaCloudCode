import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Dispatch, KeyboardEvent, RefObject, SetStateAction } from 'react';

import { api } from '@/shared/api';
import { escapeRegExp } from '@/modules/chat/utils/chatFormatting';
import type { Project } from '@/shared/types';

type ProjectFileNode = {
  name: string;
  type: 'file' | 'directory';
  path?: string;
  children?: ProjectFileNode[];
};

export type MentionableFile = {
  name: string;
  path: string;
  relativePath?: string;
};

type UseFileMentionsOptions = {
  isActive: boolean;
  selectedProject: Project | null;
  input: string;
  setInput: Dispatch<SetStateAction<string>>;
  textareaRef: RefObject<HTMLTextAreaElement>;
};

const flattenFileTree = (files: ProjectFileNode[], basePath = ''): MentionableFile[] => {
  let flattened: MentionableFile[] = [];

  files.forEach((file) => {
    const fullPath = basePath ? `${basePath}/${file.name}` : file.name;
    if (file.type === 'directory' && file.children) {
      flattened = flattened.concat(flattenFileTree(file.children, fullPath));
      return;
    }

    if (file.type === 'file') {
      flattened.push({
        name: file.name,
        path: fullPath,
        relativePath: file.path,
      });
    }
  });

  return flattened;
};

export function useFileMentions({ isActive, selectedProject, input, setInput, textareaRef }: UseFileMentionsOptions) {
  // Retain the requested project's files so typing another @ query does not
  // start a second full scan; a different project cannot use this result.
  const [projectFiles, setProjectFiles] = useState<{ projectId: string; files: MentionableFile[] } | null>(null);
  // Native requests cannot cancel their server work. Keep a user's pending
  // completion request across tab/query changes instead of starting it again.
  const fileRequestRef = useRef<{ projectId: string; controller: AbortController } | null>(null);
  const [fileMentions, setFileMentions] = useState<string[]>([]);
  const [filteredFiles, setFilteredFiles] = useState<MentionableFile[]>([]);
  const [showFileDropdown, setShowFileDropdown] = useState(false);
  const [selectedFileIndex, setSelectedFileIndex] = useState(-1);
  const [cursorPosition, setCursorPosition] = useState(0);
  const [atSymbolPosition, setAtSymbolPosition] = useState(-1);

  const projectId = selectedProject?.projectId;
  const fileList = useMemo(
    () => projectFiles && projectFiles.projectId === projectId ? projectFiles.files : [],
    [projectFiles, projectId],
  );
  const textBeforeCursor = input.slice(0, cursorPosition);
  const lastAtIndex = textBeforeCursor.lastIndexOf('@');
  const textAfterAt = textBeforeCursor.slice(lastAtIndex + 1);
  const mentionQuery = lastAtIndex !== -1 && !textAfterAt.includes(' ') ? textAfterAt : null;
  const needsFileList = isActive && mentionQuery !== null;

  useEffect(() => () => {
    fileRequestRef.current?.controller.abort();
    fileRequestRef.current = null;
  }, [projectId]);

  useEffect(() => {
    // Chat stays mounted while Files is visible. Only an active @ completion
    // needs the tree, so mounting or switching projects alone must not scan it.
    if (!projectId || !needsFileList || projectFiles?.projectId === projectId || fileRequestRef.current?.projectId === projectId) {
      return;
    }
    const abortController = new AbortController();
    fileRequestRef.current = { projectId, controller: abortController };

    const fetchProjectFiles = async () => {
      // File list is keyed by DB projectId now; the backend resolves it to
      // the project's path before reading.
      try {
        const response = await api.getFiles(projectId, {
          signal: abortController.signal,
        });
        if (!response.ok) {
          return;
        }

        const files = (await response.json()) as ProjectFileNode[];
        if (!abortController.signal.aborted) {
          setProjectFiles({ projectId, files: flattenFileTree(files) });
        }
      } catch (error) {
        // Ignore aborts from rapid project switches; we only care about the latest request.
        if ((error as { name?: string })?.name === 'AbortError') {
          return;
        }
        console.error('Error fetching files:', error);
      } finally {
        if (fileRequestRef.current?.controller === abortController) {
          fileRequestRef.current = null;
        }
      }
    };

    fetchProjectFiles();
  }, [projectId, needsFileList, projectFiles?.projectId]);

  useEffect(() => {
    if (!isActive || mentionQuery === null) {
      setShowFileDropdown(false);
      setAtSymbolPosition(-1);
      setFilteredFiles([]);
      return;
    }

    setAtSymbolPosition(lastAtIndex);
    setShowFileDropdown(true);
    setSelectedFileIndex(-1);

    const matchingFiles = fileList
      .filter(
        (file) =>
          file.name.toLowerCase().includes(mentionQuery.toLowerCase()) ||
          file.path.toLowerCase().includes(mentionQuery.toLowerCase()),
      )
      .slice(0, 10);

    setFilteredFiles(matchingFiles);
  }, [isActive, mentionQuery, lastAtIndex, fileList]);

  const activeFileMentions = useMemo(() => {
    if (!input || fileMentions.length === 0) {
      return [];
    }
    return fileMentions.filter((path) => input.includes(path));
  }, [fileMentions, input]);

  const sortedFileMentions = useMemo(() => {
    if (activeFileMentions.length === 0) {
      return [];
    }
    const uniqueMentions = Array.from(new Set(activeFileMentions));
    return uniqueMentions.sort((mentionA, mentionB) => mentionB.length - mentionA.length);
  }, [activeFileMentions]);

  const fileMentionRegex = useMemo(() => {
    if (sortedFileMentions.length === 0) {
      return null;
    }
    const pattern = sortedFileMentions.map(escapeRegExp).join('|');
    return new RegExp(`(${pattern})`, 'g');
  }, [sortedFileMentions]);

  const fileMentionSet = useMemo(() => new Set(sortedFileMentions), [sortedFileMentions]);

  const renderInputWithMentions = useCallback(
    (text: string) => {
      if (!text) {
        return '';
      }
      if (!fileMentionRegex) {
        return text;
      }

      const parts = text.split(fileMentionRegex);
      return parts.map((part, index) =>
        fileMentionSet.has(part) ? (
          <span
            key={`mention-${index}`}
            className="-ml-0.5 rounded-md bg-blue-200/70 box-decoration-clone px-0.5 text-transparent dark:bg-blue-300/40"
          >
            {part}
          </span>
        ) : (
          <span key={`text-${index}`}>{part}</span>
        ),
      );
    },
    [fileMentionRegex, fileMentionSet],
  );

  const selectFile = useCallback(
    (file: MentionableFile) => {
      const textBeforeAt = input.slice(0, atSymbolPosition);
      const textAfterAtQuery = input.slice(atSymbolPosition);
      const spaceIndex = textAfterAtQuery.indexOf(' ');
      const textAfterQuery = spaceIndex !== -1 ? textAfterAtQuery.slice(spaceIndex) : '';

      const newInput = `${textBeforeAt}${file.path} ${textAfterQuery}`;
      const newCursorPosition = textBeforeAt.length + file.path.length + 1;

      if (textareaRef.current && !textareaRef.current.matches(':focus')) {
        textareaRef.current.focus();
      }

      setInput(newInput);
      setCursorPosition(newCursorPosition);
      setFileMentions((previousMentions) =>
        previousMentions.includes(file.path) ? previousMentions : [...previousMentions, file.path],
      );

      setShowFileDropdown(false);
      setAtSymbolPosition(-1);

      if (!textareaRef.current) {
        return;
      }

      requestAnimationFrame(() => {
        if (!textareaRef.current) {
          return;
        }
        textareaRef.current.setSelectionRange(newCursorPosition, newCursorPosition);
        if (!textareaRef.current.matches(':focus')) {
          textareaRef.current.focus();
        }
      });
    },
    [input, atSymbolPosition, textareaRef, setInput],
  );

  const handleFileMentionsKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>): boolean => {
      if (!showFileDropdown || filteredFiles.length === 0) {
        return false;
      }

      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setSelectedFileIndex((previousIndex) =>
          previousIndex < filteredFiles.length - 1 ? previousIndex + 1 : 0,
        );
        return true;
      }

      if (event.key === 'ArrowUp') {
        event.preventDefault();
        setSelectedFileIndex((previousIndex) =>
          previousIndex > 0 ? previousIndex - 1 : filteredFiles.length - 1,
        );
        return true;
      }

      if (event.key === 'Tab' || event.key === 'Enter') {
        event.preventDefault();
        if (selectedFileIndex >= 0) {
          selectFile(filteredFiles[selectedFileIndex]);
        } else if (filteredFiles.length > 0) {
          selectFile(filteredFiles[0]);
        }
        return true;
      }

      if (event.key === 'Escape') {
        event.preventDefault();
        setShowFileDropdown(false);
        return true;
      }

      return false;
    },
    [showFileDropdown, filteredFiles, selectedFileIndex, selectFile],
  );

  return {
    showFileDropdown,
    filteredFiles,
    selectedFileIndex,
    renderInputWithMentions,
    selectFile,
    setCursorPosition,
    handleFileMentionsKeyDown,
  };
}
