import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Dispatch, KeyboardEvent, RefObject, SetStateAction } from 'react';

import { useWorkspaceApi, useWorkspaceScope } from '@/shared/context/WorkspaceScopeContext';
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
  isActive?: boolean;
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

// Equivalent refresh results keep the highlighted completion stable.
const haveSameFiles = (left: MentionableFile[], right: MentionableFile[]) =>
  left.length === right.length && left.every((file, index) => file.path === right[index].path && file.relativePath === right[index].relativePath);

export function useFileMentions({ isActive = true, selectedProject, input, setInput, textareaRef }: UseFileMentionsOptions) {
  // Files retain their workspace identity while the dropdown refreshes, never leaking across generations.
  const [projectFiles, setProjectFiles] = useState<{ projectId: string; files: MentionableFile[] } | null>(null);
  const [fileMentions, setFileMentions] = useState<string[]>([]);
  const [filteredFiles, setFilteredFiles] = useState<MentionableFile[]>([]);
  const [showFileDropdown, setShowFileDropdown] = useState(false);
  const [selectedFileIndex, setSelectedFileIndex] = useState(-1);
  const [cursorPosition, setCursorPosition] = useState(0);
  const [atSymbolPosition, setAtSymbolPosition] = useState(-1);
  const fileRequestRef = useRef<{ projectId: string; controller: AbortController } | null>(null);
  const projectId = selectedProject?.projectId;
  const api = useWorkspaceApi();
  const workspace = useWorkspaceScope();
  const scopeKey = JSON.stringify([projectId, workspace?.workspaceId, workspace?.generation, workspace === null]);
  const fileList = useMemo(() => projectFiles?.projectId === scopeKey ? projectFiles.files : [], [projectFiles, scopeKey]);
  const textBeforeCursor = input.slice(0, cursorPosition);
  const lastAtIndex = textBeforeCursor.lastIndexOf('@');
  const textAfterAt = textBeforeCursor.slice(lastAtIndex + 1);
  const mentionQuery = lastAtIndex !== -1 && !textAfterAt.includes(' ') ? textAfterAt : null;
  const mentionKey = mentionQuery === null ? null : `${scopeKey}:${lastAtIndex}`;
  // A hidden chat keeps its existing query; closing and reopening @ starts one new refresh.
  const openedQueryRef = useRef<string | null>(null);
  const filteredQueryRef = useRef<string | null>(null);

  useEffect(() => () => {
    fileRequestRef.current?.controller.abort();
    fileRequestRef.current = null;
  }, [scopeKey]);

  // Open once per @ query, reusing a scan already in flight; keystrokes never restart it.
  useEffect(() => {
    if (mentionKey === null) { openedQueryRef.current = null; return; }
    if (!isActive || !projectId || workspace === null || workspace?.capabilities.read === false || openedQueryRef.current === mentionKey) return;
    openedQueryRef.current = mentionKey;
    if (fileRequestRef.current?.projectId === scopeKey) return;
    const controller = new AbortController();
    fileRequestRef.current = { projectId: scopeKey, controller };
    const load = async () => {
      try {
        const response = await api.getFiles(projectId, { signal: controller.signal });
        if (!response.ok) return;
        const files = flattenFileTree(await response.json() as ProjectFileNode[]);
        if (controller.signal.aborted) return;
        setProjectFiles(previous => previous?.projectId === scopeKey && haveSameFiles(previous.files, files) ? previous : { projectId: scopeKey, files });
      } catch (error) {
        if (!controller.signal.aborted) console.error('Error fetching files:', error);
      } finally {
        if (fileRequestRef.current?.controller === controller) fileRequestRef.current = null;
      }
    };
    void load();
  }, [api, isActive, mentionKey, mentionQuery, projectId, scopeKey, workspace === null, workspace?.capabilities.read]);

  useEffect(() => {
    if (!isActive || mentionQuery === null) {
      setShowFileDropdown(false);
      setAtSymbolPosition(-1);
      setFilteredFiles([]);
      return;
    }

    setAtSymbolPosition(lastAtIndex);
    setShowFileDropdown(true);
    const filterKey = `${mentionKey}:${mentionQuery}`;
    if (filteredQueryRef.current !== filterKey) setSelectedFileIndex(-1);
    filteredQueryRef.current = filterKey;

    const matchingFiles = fileList
      .filter(
        (file) =>
          file.name.toLowerCase().includes(mentionQuery.toLowerCase()) ||
          file.path.toLowerCase().includes(mentionQuery.toLowerCase()),
      )
      .slice(0, 10);

    setFilteredFiles(matchingFiles);
  }, [isActive, mentionQuery, mentionKey, lastAtIndex, fileList]);

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
      if (!showFileDropdown) {
        return false;
      }

      if (event.key === 'Escape') {
        event.preventDefault();
        // The caret is still inside the `@` query, so a refetch landing after
        // this would re-open the dropdown (or first show it, when nothing
        // matched yet) and take the next Enter. Drop it; re-opening the
        // dropdown fetches again.
        fileRequestRef.current?.controller.abort();
        fileRequestRef.current = null;
        openedQueryRef.current = null;
        setShowFileDropdown(false);
        return true;
      }

      if (filteredFiles.length === 0) {
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
