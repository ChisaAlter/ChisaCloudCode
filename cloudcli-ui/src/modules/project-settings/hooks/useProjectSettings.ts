import { useCallback, useEffect, useRef, useState } from 'react';

import { api } from '@/shared/api';
import type { ProjectSettingsView } from '@/shared/types';

type ProjectSettingsResponse = {
  success?: boolean;
  data?: ProjectSettingsView;
  error?: string;
};

/**
 * Loads one project's explicit defaults. A missing project id, a changed
 * project, or a response that arrives after the selection moved on is treated
 * as "no settings", never as the previous project's values.
 */
export function useProjectSettings(projectId: string | null | undefined) {
  const [view, setView] = useState<ProjectSettingsView | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestRef = useRef(0);

  const refresh = useCallback(async () => {
    const requestId = ++requestRef.current;
    if (!projectId) {
      setView(null);
      setError(null);
      setIsLoading(false);
      return;
    }

    setIsLoading(true);
    setError(null);
    try {
      const response = await api.projectSettings(projectId);
      const payload = (await response.json()) as ProjectSettingsResponse;
      if (requestRef.current !== requestId) {
        return;
      }
      if (!response.ok || !payload.data) {
        throw new Error(payload.error || `Failed to load project settings (${response.status})`);
      }
      setView(payload.data);
    } catch (loadError) {
      if (requestRef.current !== requestId) {
        return;
      }
      setView(null);
      setError(loadError instanceof Error ? loadError.message : 'Failed to load project settings');
    } finally {
      if (requestRef.current === requestId) {
        setIsLoading(false);
      }
    }
  }, [projectId]);

  useEffect(() => {
    setView(null);
    setError(null);
    void refresh();
    return () => {
      requestRef.current += 1;
    };
  }, [refresh]);

  return { view, isLoading, error, refresh, setView };
}
