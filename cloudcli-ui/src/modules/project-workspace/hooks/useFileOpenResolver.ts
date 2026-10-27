import { useCallback, useMemo, useRef } from 'react';

import { api as defaultApi, createWorkspaceApi } from '@/shared/api';
import type { Project, WorkspaceDescriptor } from '@/shared/types';

type FileNode = {
  type: 'file' | 'directory';
  name: string;
  path: string;
  children?: FileNode[];
};

type FlatFile = {
  name: string;
  path: string;
};

// `diffInfo` is intentionally `any` so this resolver can wrap editor handlers
// that expect a concrete diff payload type as well as generic callers.
type OnFileOpen = (filePath: string, diffInfo?: any) => void;

const normalize = (value: string): string => value.replace(/\\/g, '/');

const flatten = (nodes: FileNode[], out: FlatFile[]): void => {
  for (const node of nodes) {
    if (node.type === 'file') {
      out.push({ name: node.name, path: node.path });
    } else if (node.children && node.children.length > 0) {
      flatten(node.children, out);
    }
  }
};

// References inside chat messages are often bare basenames (`foo.ts`) or partial
// paths (`utils/foo.ts`) rather than full paths, so match by path suffix and
// fall back to filename equality.
const findBestMatch = (files: FlatFile[], ref: string): string | null => {
  const target = normalize(ref).replace(/^\.\//, '').replace(/^\/+/, '');
  if (!target) {
    return null;
  }

  const suffixMatch = files.find((file) => {
    const filePath = normalize(file.path);
    return filePath === target || filePath.endsWith(`/${target}`);
  });
  if (suffixMatch) {
    return suffixMatch.path;
  }

  const base = target.split('/').pop() || target;
  return files.find((file) => file.name === base)?.path ?? null;
};

/**
 * Wraps an `onFileOpen` handler so a possibly bare/partial file reference is
 * resolved against the project's file tree (cached per project) before the file
 * is opened in the in-app editor.
 */
export function useFileOpenResolver(
  selectedProject: Project | null | undefined,
  onFileOpen: OnFileOpen,
  workspace?: WorkspaceDescriptor | null,
): OnFileOpen {
  const projectId = selectedProject?.projectId;
  const api = useMemo(() => workspace === undefined ? defaultApi : createWorkspaceApi(workspace), [workspace]);
  const scopeKey = JSON.stringify([projectId, workspace?.workspaceId, workspace?.generation, workspace === null]);
  const scopeRef = useRef(scopeKey);
  scopeRef.current = scopeKey;
  const cacheRef = useRef<{ projectId?: string; files: Promise<FlatFile[]> | null }>({
    projectId: undefined,
    files: null,
  });

  const loadFiles = useCallback((): Promise<FlatFile[]> => {
    if (!projectId) {
      return Promise.resolve([]);
    }
    if (cacheRef.current.projectId === scopeKey && cacheRef.current.files) {
      return cacheRef.current.files;
    }

    const filesPromise = (async () => {
      try {
        const response = await api.getFiles(projectId);
        if (!response.ok) {
          return [];
        }
        const data = await response.json();
        const tree: FileNode[] = Array.isArray(data) ? data : [];
        const flat: FlatFile[] = [];
        flatten(tree, flat);
        return flat;
      } catch {
        return [];
      }
    })();

    cacheRef.current = { projectId: scopeKey, files: filesPromise };
    return filesPromise;
  }, [api, projectId, scopeKey]);

  return useCallback(
    (filePath: string, diffInfo?: any) => {
      if (workspace === null || (workspace && !workspace.capabilities.read)) return;
      const ref = normalize(filePath).trim();
      // An explicit absolute path must not be replaced by a same-named file
      // found in the active project's tree.
      if (ref.startsWith('/') || /^[A-Za-z]:\//.test(ref)) {
        onFileOpen(filePath, diffInfo);
        return;
      }
      void loadFiles().then((files) => {
        if (scopeRef.current !== scopeKey) return;
        const match = findBestMatch(files, ref);
        onFileOpen(match ?? filePath, diffInfo);
      });
    },
    [loadFiles, onFileOpen, scopeKey, workspace],
  );
}
