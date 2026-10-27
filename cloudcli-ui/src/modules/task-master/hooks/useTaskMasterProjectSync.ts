import { useEffect } from 'react';

import type { Project } from '@/shared/types';
import { useTaskMaster } from '@/modules/task-master/context/TaskMasterContext';

/** Keeps TaskMaster's active project aligned with the workspace selection. */
export function useTaskMasterProjectSync(selectedProject: Project | null) {
  const { currentProject, setCurrentProject } = useTaskMaster();

  useEffect(() => {
    // SSH has no TaskMaster target; null also clears a previously selected cloud project.
    const target = selectedProject?.sourceMode === 'ssh' ? null : selectedProject;
    if ((target?.projectId ?? null) !== (currentProject?.projectId ?? null)) {
      setCurrentProject(target);
    }
  }, [selectedProject, currentProject?.projectId, setCurrentProject]);
}
