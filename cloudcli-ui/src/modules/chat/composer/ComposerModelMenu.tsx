import { memo, useMemo } from 'react';

import type { ProviderModelOption } from '@/shared/types';
import ComposerModelSelector from '@/modules/chat/composer/ComposerModelSelector';

type ComposerModelMenuProps = {
  effort: string;
  effortOptions: NonNullable<ProviderModelOption['effort']>['values'];
  onSelectEffort: (effort: string) => void | Promise<unknown>;
  model: string;
  resolvedModel?: string | null;
  modelOptions: ProviderModelOption[];
  onSelectModel: (model: string) => void | Promise<unknown>;
  modelsLoading: boolean;
};

/** Used by chat's ChatComposer to choose the current session's exact model and reasoning settings. */
function ComposerModelMenu({ effort, effortOptions, onSelectEffort, model, resolvedModel, modelOptions, onSelectModel, modelsLoading }: ComposerModelMenuProps) {
  const groups = useMemo(() => [{ key: 'session', provider: 'claude' as const, name: '', models: modelOptions }], [modelOptions]);
  if (effortOptions.length === 0 && modelOptions.length === 0 && !modelsLoading) return null;
  return <ComposerModelSelector groups={groups} model={model} resolvedModel={resolvedModel}
    effort={effort} effortOptions={effortOptions} modelsLoading={modelsLoading}
    onSelectModel={(_provider, value) => onSelectModel(value)} onSelectEffort={onSelectEffort} />;
}

export default memo(ComposerModelMenu);
