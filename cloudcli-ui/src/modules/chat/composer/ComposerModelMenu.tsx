import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { ChevronDown, ChevronRight, RefreshCw } from 'lucide-react';

import type { ProviderModelOption } from '@/shared/types';
import { DEFAULT_EFFORT_VALUE } from '@/shared/constants';
import { useComposerMenuAnchor } from '@/shared/hooks/useComposerMenuAnchor';
import {
  ComposerMenuHeading,
  ComposerMenuItem,
  ComposerMenuSeparator,
  ComposerMenuSurface,
} from '@/shared/ui/ComposerMenu';

type EffortOption = NonNullable<ProviderModelOption['effort']>['values'][number];

type ComposerModelMenuProps = {
  effort: string;
  /** Effort values the active provider/model actually accepts; empty hides the section. */
  effortOptions: EffortOption[];
  onSelectEffort: (effort: string) => void;
  model: string;
  resolvedModel?: string | null;
  /** Model catalog for the active provider; empty hides the section. */
  modelOptions: ProviderModelOption[];
  onSelectModel: (model: string) => void;
  modelsLoading: boolean;
  modelsError?: boolean;
  modelsErrorMessage?: string;
  onReloadModels?: () => void;
};

/**
 * Rendered by chat's ChatComposer as the popover for choosing the active
 * provider's model and reasoning effort for the next turn.
 */
function ComposerModelMenu({
  effort,
  effortOptions,
  onSelectEffort,
  model,
  resolvedModel,
  modelOptions,
  onSelectModel,
  modelsLoading,
  modelsError = false,
  modelsErrorMessage,
  onReloadModels,
}: ComposerModelMenuProps) {
  const { t } = useTranslation('chat');
  const [isOpen, setIsOpen] = useState(false);
  const [isModelSectionOpen, setIsModelSectionOpen] = useState(false);
  const close = useCallback(() => setIsOpen(false), []);
  const { triggerRef, menuRef, anchor, updateAnchor } = useComposerMenuAnchor(isOpen, close);

  // The model list starts collapsed every time the menu opens, the way Codex
  // shows reasoning first and keeps the longer model list one click away.
  useEffect(() => {
    if (!isOpen) {
      setIsModelSectionOpen(false);
    }
  }, [isOpen]);

  const defaultEffortLabel = t('composer.effortDefault', { defaultValue: 'Default' });
  const resolvedEffortOptions = useMemo<EffortOption[]>(
    () => (effortOptions.length > 0 ? [{ value: DEFAULT_EFFORT_VALUE }, ...effortOptions] : []),
    [effortOptions],
  );
  const effortLabel = effort === DEFAULT_EFFORT_VALUE ? defaultEffortLabel : effort;

  const selectedModelOption = useMemo(
    () => modelOptions.find((option) => option.value === model) ?? null,
    [model, modelOptions],
  );
  const modelLabel = selectedModelOption?.label || model;
  const resolvedLabel = resolvedModel
    ? modelOptions.find((option) => option.value === resolvedModel)?.label
      || resolvedModel.replace(/^claude-(opus|sonnet|haiku|fable)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?(\[1m\])?$/i,
        (_, family: string, major: string, minor: string | undefined, context: string | undefined) =>
          `${family[0].toUpperCase()}${family.slice(1)} ${major}${minor ? `.${minor}` : ''}${context ? ' (1M context)' : ''}`)
    : null;

  const hasEffortSection = resolvedEffortOptions.length > 0;
  const hasModelSection = modelOptions.length > 0 || modelsLoading || modelsError || Boolean(onReloadModels);
  if (!hasEffortSection && !hasModelSection) {
    return null;
  }

  const triggerLabel = hasModelSection ? modelLabel : effortLabel;
  const ariaLabel = t('composer.modelMenu', {
    defaultValue: 'Select model and reasoning effort',
  });

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => {
          if (!isOpen && !modelsLoading) onReloadModels?.();
          updateAnchor();
          setIsOpen((current) => !current);
        }}
        className="flex h-8 min-w-0 max-w-28 items-center gap-1 rounded-lg px-2 text-xs text-foreground transition-colors hover:bg-muted/60 sm:max-w-56"
        aria-haspopup="menu"
        aria-expanded={isOpen}
        aria-label={ariaLabel}
        title={resolvedLabel ? `${modelLabel} · ${t('composer.lastUsedModel', { model: resolvedLabel, defaultValue: 'Last used: {{model}}' })}` : modelLabel}
      >
        <span className="truncate">{triggerLabel}</span>
        {hasModelSection && hasEffortSection && effort !== DEFAULT_EFFORT_VALUE && (
          <span className="hidden shrink-0 capitalize text-muted-foreground sm:inline">{effortLabel}</span>
        )}
        <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" aria-hidden />
      </button>

      {isOpen && anchor && createPortal(
        <ComposerMenuSurface anchor={anchor} menuRef={menuRef} ariaLabel={ariaLabel}>
          {resolvedLabel && (
            <p className="px-2.5 py-1.5 text-xs text-muted-foreground" title={resolvedModel || undefined}>
              {t('composer.lastUsedModel', { model: resolvedLabel, defaultValue: 'Last used: {{model}}' })}
            </p>
          )}
          {hasEffortSection && (
            <>
              <ComposerMenuHeading>
                {t('composer.reasoning', { defaultValue: 'Reasoning' })}
              </ComposerMenuHeading>
              {resolvedEffortOptions.map((option) => (
                <ComposerMenuItem
                  key={option.value}
                  label={option.value === DEFAULT_EFFORT_VALUE ? defaultEffortLabel : option.value}
                  description={option.description}
                  isSelected={option.value === effort}
                  onSelect={() => {
                    if (modelsLoading) return;
                    onSelectEffort(option.value);
                    setIsOpen(false);
                  }}
                  className="capitalize"
                />
              ))}
            </>
          )}

          {hasModelSection && (
            <>
              {hasEffortSection && <ComposerMenuSeparator />}
              <ComposerMenuItem
                role="menuitem"
                label={modelLabel}
                isSelected={false}
                onSelect={() => setIsModelSectionOpen((current) => !current)}
                trailing={
                  isModelSectionOpen
                    ? <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
                    : <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
                }
                className="text-muted-foreground"
              />

              {isModelSectionOpen && (
                <>
                  <ComposerMenuHeading>
                    <span className="flex items-center justify-between gap-2">
                      <span>{t('composer.model', { defaultValue: 'Model' })}</span>
                      {onReloadModels && (
                        <button
                          type="button"
                          role="menuitem"
                          onClick={onReloadModels}
                          disabled={modelsLoading}
                          aria-label={t('composer.reloadModels', { defaultValue: 'Reload models' })}
                          title={t('composer.reloadModels', { defaultValue: 'Reload models' })}
                          className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
                        >
                          <RefreshCw className={`h-3.5 w-3.5${modelsLoading ? ' animate-spin' : ''}`} aria-hidden />
                        </button>
                      )}
                    </span>
                  </ComposerMenuHeading>
                  {modelsError && (
                    <p role="alert" className="px-2.5 py-1.5 text-sm text-destructive">
                      {modelsErrorMessage || t('composer.modelsLoadFailed', { defaultValue: 'Could not load models. Reload to try again.' })}
                    </p>
                  )}
                  {modelOptions.length === 0 && modelsLoading && (
                    <p className="px-2.5 py-1.5 text-sm text-muted-foreground">
                      {t('composer.loadingModels', { defaultValue: 'Loading models…' })}
                    </p>
                  )}
                  {modelOptions.map((option) => (
                    <ComposerMenuItem
                      key={option.value}
                      label={option.label || option.value}
                      description={option.value.startsWith('claude-') ? option.value : undefined}
                      isSelected={option.value === model}
                      onSelect={() => {
                        if (modelsLoading) return;
                        onSelectModel(option.value);
                        setIsOpen(false);
                      }}
                    />
                  ))}
                </>
              )}
            </>
          )}
        </ComposerMenuSurface>,
        document.body,
      )}
    </>
  );
}

/** Memoized: the composer re-renders on every keystroke and none of this menu's props change while typing. */
export default memo(ComposerModelMenu);
