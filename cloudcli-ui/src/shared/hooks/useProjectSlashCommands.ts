import { useEffect, useState } from 'react';

import { api } from '@/shared/api';
import { getAuthSessionVersion } from '@/shared/authToken';
import { getServerConnectionVersion } from '@/shared/chisa';
import { useWorkspaceScope } from '@/shared/context/WorkspaceScopeContext';
import type { LLMProvider, Project, SlashCommand } from '@/shared/types';

type ProviderSkill = {
  name: string;
  description?: string;
  command: string;
  scope: string;
  sourcePath?: string;
  pluginName?: string;
  pluginId?: string;
};

type ProviderSkillsResponse = {
  success?: boolean;
  data?: {
    skills?: ProviderSkill[];
  };
};

type UseProjectSlashCommandsOptions = {
  // False while the consumer is not showing the list: the fetch is skipped
  // (and the previous list kept) until it becomes true again.
  enabled?: boolean;
};

type UseProjectSlashCommandsResult = {
  commands: SlashCommand[];
  isLoading: boolean;
  error: boolean;
};

const dedupeProviderSkills = (skills: ProviderSkill[]): ProviderSkill[] => {
  const seenCommands = new Set<string>();

  return skills.filter((skill) => {
    // Multiple physical Claude plugin folders can expose the same invocation.
    // The slash menu should show each executable command only once.
    const key = skill.command;
    if (seenCommands.has(key)) {
      return false;
    }

    seenCommands.add(key);
    return true;
  });
};

const mapSkillToSlashCommand = (skill: ProviderSkill): SlashCommand => ({
  name: skill.command,
  description: skill.description,
  namespace: 'skill',
  path: skill.sourcePath,
  type: 'skill',
  metadata: {
    type: skill.scope,
    scope: skill.scope,
    sourcePath: skill.sourcePath,
    pluginName: skill.pluginName,
    pluginId: skill.pluginId,
    skillName: skill.name,
  },
});

/**
 * Used by the chat module (composer `/` menu) and the quick-settings-panel
 * module (Commands tab) to load the slash commands — built-in, provider skills
 * and custom — available to a project. Both surfaces must offer the same list,
 * so the fetch and mapping live here; ordering and filtering stay with the
 * consumer. Returns the list in built-in → skills → custom order. A consumer
 * that only shows the list sometimes passes `enabled: false` meanwhile so
 * project switches do not cost a second round-trip; re-enabling refetches.
 */
export function useProjectSlashCommands(
  selectedProject: Project | null,
  provider: LLMProvider,
  { enabled = true }: UseProjectSlashCommandsOptions = {},
): UseProjectSlashCommandsResult {
  // The fetched list, kept in state because it arrives asynchronously after
  // the project or provider changes and every consumer derives its view from it.
  const [commands, setCommands] = useState<SlashCommand[]>([]);
  // Distinguishes "no commands yet" from "no commands at all" so a list can
  // show a loading state instead of an empty one while the request is in flight.
  const [isLoading, setIsLoading] = useState(false);
  // Set when the request failed so a list can explain the emptiness; cleared
  // on the next successful fetch.
  const [error, setError] = useState(false);

  const workspace = useWorkspaceScope();
  const projectId = selectedProject?.projectId;
  const workspaceProjectId = workspace?.projectId;
  const workspaceId = workspace?.workspaceId;
  const generation = workspace?.generation;
  const sessionId = workspace?.kind === 'session' ? workspace.sessionId : undefined;
  const workspacePath = workspace?.rootPath || selectedProject?.fullPath || selectedProject?.path || '';
  const hasWorkspace = workspace !== undefined && workspace !== null;
  const canDiscover = Boolean(selectedProject) && workspace !== null && workspace?.capabilities.read !== false;
  const authVersion = getAuthSessionVersion();
  const serverVersion = getServerConnectionVersion();

  useEffect(() => {
    if (!enabled) {
      return undefined;
    }

    const controller = new AbortController();
    const current = () => !controller.signal.aborted && authVersion === getAuthSessionVersion() && serverVersion === getServerConnectionVersion();
    const selector = hasWorkspace && workspaceProjectId && workspaceId && generation
      ? { projectId: workspaceProjectId, workspaceId, generation, ...(sessionId ? { sessionId } : {}) }
      : undefined;
    setCommands([]);

    const fetchCommands = async () => {
      if (!canDiscover || !projectId) {
        setCommands([]);
        setIsLoading(false);
        setError(false);
        return;
      }

      setIsLoading(true);
      setError(false);

      try {
        const response = await api.commands.list(workspacePath || undefined, selector, { signal: controller.signal });
        if (!current()) return;

        if (!response.ok) {
          throw new Error('Failed to fetch commands');
        }

        const data = await response.json();
        if (!current()) return;
        const skillsResponse = await api.providers.skills(provider, selector ?? { workspacePath }, { signal: controller.signal });
        const skillsData = skillsResponse.ok
          ? ((await skillsResponse.json()) as ProviderSkillsResponse)
          : null;
        if (!current()) return;
        const skillCommands = dedupeProviderSkills(skillsData?.data?.skills || [])
          .map(mapSkillToSlashCommand);
        const allCommands: SlashCommand[] = [
          ...((data.builtIn || []) as SlashCommand[]).map((command) => ({
            ...command,
            type: 'built-in',
          })),
          ...skillCommands,
          ...((data.custom || []) as SlashCommand[]).map((command) => ({
            ...command,
            type: 'custom',
          })),
        ];

        if (current()) {
          setCommands(allCommands);
          setIsLoading(false);
        }
      } catch (fetchError) {
        if (!current()) return;
        console.error('Error fetching slash commands:', fetchError);
        if (current()) {
          setCommands([]);
          setError(true);
          setIsLoading(false);
        }
      }
    };

    fetchCommands();
    return () => {
      controller.abort();
    };
  }, [enabled, authVersion, canDiscover, generation, hasWorkspace, projectId, provider, serverVersion, sessionId, workspaceId, workspacePath, workspaceProjectId]);

  return { commands, isLoading, error };
}
