import type { Dispatch, RefObject, SetStateAction } from 'react';
import { Sparkles } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import type { ProjectSession, LLMProvider, ProviderModelActions, ProviderModelsDefinition } from '@/shared/types';
import { NextTaskBanner } from '@/modules/task-master';
import { useWorkspaceExecutionScope } from '@/shared/context/WorkspaceScopeContext';
import { ProjectDefaultsSummary } from '@/modules/project-settings';

// Keep the transcript's existing contract while model interactions live in the composer.
type ProviderSelectionEmptyStateProps = {
  selectedSession: ProjectSession | null;
  currentSessionId: string | null;
  provider: LLMProvider;
  setProvider: (next: LLMProvider) => void;
  textareaRef: RefObject<HTMLTextAreaElement>;
  providerModels: Record<LLMProvider, string>;
  setProviderModel: (provider: LLMProvider, model: string) => void;
  providerModelCatalog: Partial<Record<LLMProvider, ProviderModelsDefinition>>;
  providerModelActions: ProviderModelActions;
  providerModelsLoading: boolean;
  tasksEnabled: boolean;
  isTaskMasterInstalled: boolean | null;
  onShowAllTasks?: (() => void) | null;
  setInput: Dispatch<SetStateAction<string>>;
};

/** Rendered by chat's ChatMessagesPane for the welcome and empty selected-session continuation states. */
export default function ProviderSelectionEmptyState({
  selectedSession, currentSessionId, provider, providerModels, tasksEnabled,
  isTaskMasterInstalled, onShowAllTasks, setInput,
}: ProviderSelectionEmptyStateProps) {
  const { t } = useTranslation('chat');
  const workspace = useWorkspaceExecutionScope();
  const nextTaskPrompt = t('tasks.nextTaskPrompt', { defaultValue: 'Start the next task' });

  if (!selectedSession && !currentSessionId) {
    return (
      <div className="chat-welcome flex h-full items-center justify-center px-4">
        <div className="w-full max-w-[34.25rem]">
          <div className="chat-welcome-heading mb-6 text-center">
            <Sparkles className="chat-welcome-mark mx-auto mb-5 h-9 w-9 text-primary" strokeWidth={1.2} aria-hidden="true" />
            <h2 className="text-3xl font-medium tracking-tight text-foreground sm:text-4xl">
              {t('providerSelection.welcomeTitle', { defaultValue: 'What would you like to build?' })}
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              {t('providerSelection.welcomeDescription', { defaultValue: 'Describe your task below, or choose a model to start a conversation.' })}
            </p>
          </div>
          <ProjectDefaultsSummary projectId={workspace?.projectId ?? null} provider={provider} model={providerModels[provider]} />
          {provider && tasksEnabled && isTaskMasterInstalled && (
            <div className="mt-5">
              <NextTaskBanner onStartTask={() => setInput(nextTaskPrompt)} onShowAllTasks={onShowAllTasks} />
            </div>
          )}
        </div>
      </div>
    );
  }

  if (selectedSession) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="max-w-[34.25rem] px-6 text-center">
          <p className="mb-1.5 text-lg font-semibold text-foreground">{t('session.continue.title')}</p>
          <p className="text-sm leading-relaxed text-muted-foreground">{t('session.continue.description')}</p>
          {tasksEnabled && isTaskMasterInstalled && (
            <div className="mt-5">
              <NextTaskBanner onStartTask={() => setInput(nextTaskPrompt)} onShowAllTasks={onShowAllTasks} />
            </div>
          )}
        </div>
      </div>
    );
  }
  return null;
}
