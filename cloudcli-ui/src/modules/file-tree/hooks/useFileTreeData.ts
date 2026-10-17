import { useCallback, useEffect, useRef, useState } from 'react';

import { api } from '@/shared/api';
import type { Project,FileTreeNode } from '@/shared/types';

type UseFileTreeDataResult = {
  files: FileTreeNode[];
  loading: boolean;
  error: string | null;
  directoryError: string | null;
  loadingDirectoryCount: number;
  loadDirectory: (path: string) => Promise<void>;
  refreshFiles: () => void;
};

const DEFAULT_LOAD_ERROR = 'Unable to load the file tree for this project.';
const MAX_LOADED_NODES = 10_000;
const LOADED_TREE_LIMIT_ERROR = 'The file tree is limited to 10000 loaded entries. Refresh to return to the root before browsing another folder.';

function countNodes(nodes: FileTreeNode[]): number {
  return nodes.reduce((count, node) => count + 1 + countNodes(node.children ?? []), 0);
}

function findDirectory(nodes: FileTreeNode[], path: string): FileTreeNode | undefined {
  for (const node of nodes) {
    if (node.type !== 'directory') continue;
    if (node.path === path) return node;
    const child = findDirectory(node.children ?? [], path);
    if (child) return child;
  }
  return undefined;
}

function attachDirectoryChildren(nodes: FileTreeNode[], path: string, children: FileTreeNode[]): FileTreeNode[] {
  return nodes.map((node) => node.path === path
    ? { ...node, children }
    : node.children ? { ...node, children: attachDirectoryChildren(node.children, path, children) } : node);
}

// The API reports refusals such as FILE_TREE_TOO_LARGE as { error: message }.
// Surfacing that message tells the user why the tree is missing and what to do
// about it, instead of leaving them with an unexplained empty tree.
function readResponseErrorMessage(responseBody: string): string | null {
  try {
    const parsedBody = JSON.parse(responseBody) as unknown;
    const message = typeof parsedBody === 'object' && parsedBody !== null && 'error' in parsedBody
      ? (parsedBody as { error: unknown }).error
      : null;
    return typeof message === 'string' && message.trim() ? message : null;
  } catch {
    return null;
  }
}

export function useFileTreeData(selectedProject: Project | null): UseFileTreeDataResult {
  const [files, setFiles] = useState<FileTreeNode[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  // Folder failures remain visible without hiding the already loaded tree.
  const [directoryError, setDirectoryError] = useState<string | null>(null);
  // The tree remains usable while a requested folder is loading.
  const [loadingDirectoryCount, setLoadingDirectoryCount] = useState(0);
  // Async folder responses merge against the latest accepted tree and budget.
  const filesRef = useRef<FileTreeNode[]>([]);
  // A native request can outlive abort; scope versions reject its old result.
  const scopeVersionRef = useRef(0);
  // Repeated clicks cannot start duplicate requests for the same unloaded folder.
  const directoryRequestsRef = useRef(new Set<string>());
  const abortControllerRef = useRef<AbortController | null>(null);

  const refreshFiles = useCallback(() => {
    setRefreshKey((prev) => prev + 1);
  }, []);

  useEffect(() => {
    // File-tree requests use the DB projectId; the backend resolves it to the
    // project's absolute path through the projects table.
    const projectId = selectedProject?.projectId;
    scopeVersionRef.current++;
    filesRef.current = [];
    directoryRequestsRef.current.clear();
    setFiles([]);
    setDirectoryError(null);
    setLoadingDirectoryCount(0);

    if (!projectId) {
      setFiles([]);
      setLoading(false);
      setError(null);
      return;
    }

    // Abort previous request
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    const abortController = new AbortController();
    abortControllerRef.current = abortController;

    // Track mount state so aborted or late responses do not enqueue stale state updates.
    let isActive = true;

    const fetchFiles = async () => {
      if (isActive) {
        setLoading(true);
        setError(null);
      }
      try {
        const response = await api.getFiles(projectId, { signal: abortController.signal, shallow: true });

        if (!response.ok) {
          const errorText = await response.text();
          console.error('File fetch failed:', response.status, errorText);
          if (isActive) {
            setFiles([]);
            setError(readResponseErrorMessage(errorText) ?? DEFAULT_LOAD_ERROR);
          }
          return;
        }

        const data = (await response.json()) as FileTreeNode[];
        if (isActive) {
          if (countNodes(data) > MAX_LOADED_NODES) {
            setError(LOADED_TREE_LIMIT_ERROR);
            return;
          }
          filesRef.current = data;
          setFiles(data);
        }
      } catch (error) {
        if ((error as { name?: string }).name === 'AbortError') {
          return;
        }

        console.error('Error fetching files:', error);
        if (isActive) {
          setFiles([]);
          setError(DEFAULT_LOAD_ERROR);
        }
      } finally {
        if (isActive) {
          setLoading(false);
        }
      }
    };

    void fetchFiles();

    return () => {
      isActive = false;
      abortController.abort();
    };
  }, [selectedProject?.projectId, refreshKey]);

  const loadDirectory = useCallback(async (path: string) => {
    const projectId = selectedProject?.projectId;
    const directory = findDirectory(filesRef.current, path);
    const abortController = abortControllerRef.current;
    if (!projectId || !directory || directory.children !== undefined || directoryRequestsRef.current.has(path) || !abortController) {
      return;
    }

    const scopeVersion = scopeVersionRef.current;
    directoryRequestsRef.current.add(path);
    setLoadingDirectoryCount(directoryRequestsRef.current.size);
    setDirectoryError(null);
    try {
      const response = await api.getFiles(projectId, { shallow: true, directoryPath: path, signal: abortController.signal });
      if (!response.ok) {
        throw new Error(readResponseErrorMessage(await response.text()) ?? DEFAULT_LOAD_ERROR);
      }
      const children = (await response.json()) as FileTreeNode[];
      if (scopeVersionRef.current !== scopeVersion || abortController.signal.aborted) return;
      const nextFiles = attachDirectoryChildren(filesRef.current, path, children);
      if (countNodes(nextFiles) > MAX_LOADED_NODES) {
        setDirectoryError(LOADED_TREE_LIMIT_ERROR);
        return;
      }
      filesRef.current = nextFiles;
      setFiles(nextFiles);
    } catch (requestError) {
      if (scopeVersionRef.current === scopeVersion && !abortController.signal.aborted) {
        setDirectoryError(`${path}: ${requestError instanceof Error ? requestError.message : DEFAULT_LOAD_ERROR}`);
      }
    } finally {
      if (scopeVersionRef.current === scopeVersion && !abortController.signal.aborted) {
        directoryRequestsRef.current.delete(path);
        setLoadingDirectoryCount(directoryRequestsRef.current.size);
      }
    }
  }, [selectedProject?.projectId]);

  return {
    files,
    loading,
    error,
    directoryError,
    loadingDirectoryCount,
    loadDirectory,
    refreshFiles,
  };
}
