import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { LLMProvider, ProviderModelActions, ProviderModelOption, ProviderModelsDefinition } from '@/shared/types';
import { Dialog, DialogContent, DialogTitle } from '@/shared/ui';
import ComposerModelSelector from '@/modules/chat/composer/ComposerModelSelector';
import ModelLibraryPanel from '@/modules/chat/modals/ModelLibraryPanel';

const PROVIDERS: { id: LLMProvider; name: string }[] = [
  { id: 'claude', name: 'Anthropic' },
  { id: 'codex', name: 'OpenAI' },
];

type ComposerModelPickerProps = {
  provider: LLMProvider;
  model: string;
  effort: string;
  effortOptions: NonNullable<ProviderModelOption['effort']>['values'];
  providerModelCatalog: Partial<Record<LLMProvider, ProviderModelsDefinition>>;
  providerModelActions: ProviderModelActions;
  modelsLoading: boolean;
  sshProject: boolean;
  onSelectModel: (provider: LLMProvider, model: string) => void | Promise<unknown>;
  onSelectEffort: (effort: string) => void | Promise<unknown>;
};

/** Used by chat's ChatInterface for cross-provider new chats, with the same anchored selector as existing sessions. */
export default function ComposerModelPicker({
  provider, model, effort, effortOptions, providerModelCatalog, providerModelActions,
  modelsLoading, sshProject, onSelectModel, onSelectEffort,
}: ComposerModelPickerProps) {
  const { t } = useTranslation('chat');
  // Restores the catalog when model-library editing finishes.
  const [pickerOpen, setPickerOpen] = useState(false);
  // Model management remains a separate dialog with its own keyboard and focus scope.
  const [modelLibraryOpen, setModelLibraryOpen] = useState(false);
  const groups = useMemo(() => PROVIDERS.filter(entry => !sshProject || entry.id === 'claude')
    .map(entry => ({ key: entry.id, provider: entry.id, name: entry.name, models: providerModelCatalog[entry.id]?.OPTIONS ?? [] })), [providerModelCatalog, sshProject]);
  const customOnlyProviders = groups.filter(group => providerModelCatalog[group.provider]?.CUSTOM_MODELS_ONLY && group.models.some(option => option.isCustom)).map(group => group.name);
  const catalogNote = customOnlyProviders.length > 0
    ? t('providerSelection.chooseModelDescriptionCustomOnly', { providers: customOnlyProviders })
    : t('providerSelection.chooseModelDescription', { defaultValue: 'Built-in and custom models in one list' });
  return <>
    <ComposerModelSelector groups={groups} provider={provider} model={model} effort={effort} effortOptions={effortOptions}
      modelsLoading={modelsLoading} open={pickerOpen} onOpenChange={setPickerOpen} catalogNote={catalogNote}
      onSelectModel={(target, value) => { if (!sshProject || target === 'claude') return onSelectModel(target, value); }}
      onSelectEffort={onSelectEffort} onManageModels={() => setModelLibraryOpen(true)} />
    <Dialog open={modelLibraryOpen} onOpenChange={open => { setModelLibraryOpen(open); if (!open) setPickerOpen(true); }}>
      <DialogContent className="composer-model-library-dialog flex h-[min(90dvh,46rem)] w-[calc(100vw-1rem)] max-w-4xl flex-col overflow-hidden rounded-2xl p-4 sm:p-5">
        <DialogTitle>{t('providerSelection.manageModels', { defaultValue: 'Manage models' })}</DialogTitle>
        <ModelLibraryPanel initialProvider={provider} providerModelCatalog={providerModelCatalog} actions={providerModelActions}
          onDone={() => { setModelLibraryOpen(false); setPickerOpen(true); }} />
      </DialogContent>
    </Dialog>
  </>;
}
