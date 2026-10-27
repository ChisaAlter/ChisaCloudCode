import { useCallback, useId, useMemo, useState } from 'react';
import { ChevronDown, Plus, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import type { LLMProvider, ProviderModelActions, ProviderModelOption, ProviderModelsDefinition } from '@/shared/types';
import { DEFAULT_EFFORT_VALUE } from '@/shared/constants';
import { Button, Command, CommandEmpty, CommandInput, CommandList, Dialog, DialogContent, DialogTitle, DialogTrigger, LLMProviderLogo } from '@/shared/ui';
import ModelGroupList from '@/modules/chat/composer/ModelGroupList';
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

/** Used privately by chat's ChatInterface for the new conversation's single model and reasoning entry. */
export default function ComposerModelPicker({
  provider, model, effort, effortOptions, providerModelCatalog, providerModelActions,
  modelsLoading, sshProject, onSelectModel, onSelectEffort,
}: ComposerModelPickerProps) {
  const { t } = useTranslation('chat');
  const reasoningId = useId();
  // The catalog and library are separate dialogs so each retains its existing keyboard behavior.
  const [dialogOpen, setDialogOpen] = useState(false);
  // Returning from library management reopens the model catalog.
  const [modelLibraryOpen, setModelLibraryOpen] = useState(false);
  // Searching expands matching provider branches and resets when the picker closes.
  const [modelSearch, setModelSearch] = useState('');
  // A failed mutation remains visible until the user retries or closes the picker.
  const [error, setError] = useState<string | null>(null);
  // Serialize selections while an asynchronous model or effort change is being saved.
  const [saving, setSaving] = useState(false);

  const setPickerOpen = useCallback((open: boolean) => {
    setDialogOpen(open);
    if (!open) {
      setModelSearch('');
      setError(null);
    }
  }, []);

  const visibleProviderGroups = useMemo(() => {
    const tokens = modelSearch.toLowerCase().split(/\s+/).filter(Boolean);
    return PROVIDERS.filter((entry) => !sshProject || entry.id === 'claude').map((entry) => ({
      key: entry.id,
      provider: entry.id,
      name: entry.name,
      // Include exact IDs as well as labels; cmdk's fuzzy matching can surface unrelated models.
      models: (providerModelCatalog[entry.id]?.OPTIONS ?? []).filter((option) => {
        const value = `${entry.name} ${entry.id} ${option.label} ${option.value} ${option.description ?? ''}`.toLowerCase();
        return tokens.every((token) => value.includes(token));
      }).map((option) => ({
        ...option,
        // ModelGroupList uses description in cmdk's identity; distinguish equal labels by exact ID.
        description: `${option.description ?? ''} ${option.value}`,
      })),
    })).filter((group) => group.models.length > 0 || tokens.length === 0);
  }, [modelSearch, providerModelCatalog, sshProject]);

  const selectedModel = providerModelCatalog[provider]?.OPTIONS.find((option) => option.value === model);
  const modelLabel = selectedModel?.label || (model === 'hiroute' ? 'HiRoute' : model);
  const defaultEffortLabel = t('composer.effortDefault', { defaultValue: 'Default' });
  const acceptedEffortOptions = effortOptions.filter((option) => option.value !== DEFAULT_EFFORT_VALUE);
  const selectedEffort = acceptedEffortOptions.find((option) => option.value === effort);
  const effectiveEffort = selectedEffort ? effort : DEFAULT_EFFORT_VALUE;
  const ariaLabel = t('composer.modelMenu', { defaultValue: 'Select model and reasoning effort' });

  const handleModelSelect = async (providerId: LLMProvider, modelValue: string) => {
    if (saving || (sshProject && providerId !== 'claude')) return;
    setSaving(true);
    setError(null);
    try {
      await onSelectModel(providerId, modelValue);
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : t('misc.modelSaveFailed', { defaultValue: 'Unable to change the model.' }));
    } finally {
      setSaving(false);
    }
  };

  const handleEffortSelect = async (value: string) => {
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      await onSelectEffort(value);
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : t('composer.effortSaveFailed', { defaultValue: 'Unable to change reasoning effort.' }));
    } finally {
      setSaving(false);
    }
  };

  const closeModelLibrary = () => {
    setModelLibraryOpen(false);
    setPickerOpen(true);
  };

  return (
    <>
      <Dialog open={dialogOpen} onOpenChange={setPickerOpen}>
        <DialogTrigger asChild>
          <button type="button" className="composer-model-picker-trigger flex h-8 min-w-0 max-w-40 items-center gap-1.5 rounded-lg px-2 text-xs text-foreground transition-colors hover:bg-muted/60 sm:max-w-64"
            aria-haspopup="dialog" aria-expanded={dialogOpen} aria-label={ariaLabel} title={modelLabel}>
            <LLMProviderLogo provider={provider} className="h-3.5 w-3.5 shrink-0" />
            <span className="truncate">{modelLabel || t('composer.model', { defaultValue: 'Model' })}</span>
            {acceptedEffortOptions.length > 0 && effectiveEffort !== DEFAULT_EFFORT_VALUE && (
              <span className="hidden shrink-0 capitalize text-muted-foreground sm:inline">{effectiveEffort}</span>
            )}
            <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" aria-hidden />
          </button>
        </DialogTrigger>
        <DialogContent className="composer-model-picker-dialog flex max-h-[min(90dvh,42rem)] w-[calc(100vw-1rem)] max-w-md flex-col overflow-hidden p-0" aria-label={ariaLabel}>
          <DialogTitle>{ariaLabel}</DialogTitle>
          <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border/60 px-4 py-3">
            <div className="min-w-0">
              <p className="text-sm font-semibold text-foreground">{t('providerSelection.chooseModel', { defaultValue: 'Choose a model' })}</p>
              <p className="mt-0.5 text-xs text-muted-foreground">{t('providerSelection.chooseModelDescription', { defaultValue: 'Built-in and custom models in one list' })}</p>
            </div>
            <Button type="button" variant="ghost" size="sm" disabled={saving} onClick={() => { setPickerOpen(false); setModelLibraryOpen(true); }} className="h-8 shrink-0 px-2 text-xs">
              <Plus className="h-3.5 w-3.5" aria-hidden />
              {t('providerSelection.addModel', { defaultValue: 'Add model' })}
            </Button>
            <Button type="button" variant="ghost" size="icon" onClick={() => setPickerOpen(false)} aria-label={t('composer.closeModelPicker', { defaultValue: 'Close model picker' })} className="h-8 w-8 shrink-0">
              <X className="h-4 w-4" aria-hidden />
            </Button>
          </div>
          <Command label={t('providerSelection.searchModels', { defaultValue: 'Search models...' })} shouldFilter={false} className="min-h-0 flex-1">
            <CommandInput value={modelSearch} onValueChange={setModelSearch} aria-label={t('providerSelection.searchModels', { defaultValue: 'Search models...' })} placeholder={t('providerSelection.searchModels', { defaultValue: 'Search models...' })} />
            <CommandList className="max-h-[350px] min-h-0" aria-busy={saving || modelsLoading}>
              <CommandEmpty>{t('providerSelection.noModelsFound', { defaultValue: 'No models found.' })}</CommandEmpty>
              <div className={saving ? 'pointer-events-none opacity-60' : undefined} aria-disabled={saving}>
                <ModelGroupList groups={visibleProviderGroups} provider={provider} currentModel={model} loading={modelsLoading} searching={modelSearch.trim().length > 0} onSelect={handleModelSelect} loadingLabel={t('providerSelection.loadingModels', { defaultValue: 'Loading models…' })} />
              </div>
            </CommandList>
          </Command>
          <div className="composer-model-picker-reasoning shrink-0 border-t border-border/60 px-4 py-3">
            <div className="flex items-center justify-between gap-3">
              <label htmlFor={reasoningId} className="text-sm font-medium">{t('composer.reasoning', { defaultValue: 'Reasoning' })}</label>
              <select id={reasoningId} value={effectiveEffort} disabled={saving || acceptedEffortOptions.length === 0} onChange={(event) => void handleEffortSelect(event.target.value)} className="max-w-[65%] rounded-md border border-border bg-background px-2 py-1.5 text-sm capitalize text-foreground">
                <option value={DEFAULT_EFFORT_VALUE}>{defaultEffortLabel}</option>
                {acceptedEffortOptions.map((option) => <option key={option.value} value={option.value}>{option.value}</option>)}
              </select>
            </div>
            <p className="mt-1.5 text-xs text-muted-foreground">{acceptedEffortOptions.length === 0
              ? t('composer.noReasoningOptions', { defaultValue: 'This model uses its default reasoning settings.' })
              : selectedEffort?.description || t('composer.reasoningDescription', { defaultValue: 'Choose the reasoning effort for your next message.' })}</p>
          </div>
          {saving && <p role="status" className="px-4 pb-3 text-xs text-muted-foreground">{t('composer.savingModel', { defaultValue: 'Saving selection…' })}</p>}
          {error && <p role="alert" className="composer-model-picker-error px-4 pb-3 text-sm text-destructive">{error}</p>}
        </DialogContent>
      </Dialog>
      <Dialog open={modelLibraryOpen} onOpenChange={(open) => { if (open) setModelLibraryOpen(true); else closeModelLibrary(); }}>
        <DialogContent className="composer-model-library-dialog flex h-[min(90dvh,46rem)] w-[calc(100vw-1rem)] max-w-4xl flex-col overflow-hidden rounded-3xl p-4 sm:p-5">
          <DialogTitle>{t('providerSelection.manageModels', { defaultValue: 'Manage models' })}</DialogTitle>
          <ModelLibraryPanel initialProvider={provider} providerModelCatalog={providerModelCatalog} actions={providerModelActions} onDone={closeModelLibrary} />
        </DialogContent>
      </Dialog>
    </>
  );
}
