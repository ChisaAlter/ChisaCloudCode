import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown, ChevronLeft, ChevronRight, Loader2, Search, Settings2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import type { ComposerModelGroup, LLMProvider, ProviderModelOption } from '@/shared/types';
import { DEFAULT_EFFORT_VALUE } from '@/shared/constants';
import { useComposerMenuAnchor } from '@/shared/hooks/useComposerMenuAnchor';
import { cn } from '@/shared/utils';

type ComposerModelSelectorProps = {
  groups: ComposerModelGroup[];
  provider?: LLMProvider;
  model: string;
  resolvedModel?: string | null;
  effort: string;
  effortOptions: NonNullable<ProviderModelOption['effort']>['values'];
  modelsLoading: boolean;
  onSelectModel: (provider: LLMProvider, model: string) => void | Promise<unknown>;
  onSelectEffort: (effort: string) => void | Promise<unknown>;
  onManageModels?: () => void;
  catalogNote?: string;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
};

type ModelEntry = { provider: LLMProvider; group: string; option: ProviderModelOption };
type Submenu = 'effort' | 'models' | null;

const MENU_ITEM_CLASS = 'flex min-h-8 w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[13px] leading-5 text-popover-foreground outline-none hover:bg-accent/70 focus-visible:bg-accent/70 disabled:pointer-events-none disabled:opacity-50';

function friendlyModelName(value: string): string {
  if (value === 'hiroute') return 'HiRoute';
  return value.replace(/^claude-(opus|sonnet|haiku|fable)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?(\[1m\])?$/i,
    (_, family: string, major: string, minor: string | undefined, context: string | undefined) =>
      `${family[0].toUpperCase()}${family.slice(1)} ${major}${minor ? `.${minor}` : ''}${context ? ' (1M context)' : ''}`);
}

/** Used by chat's existing-session and new-chat controls for a desktop menu with model and effort submenus. */
export default function ComposerModelSelector({
  groups, provider, model, resolvedModel, effort, effortOptions, modelsLoading,
  onSelectModel, onSelectEffort, onManageModels, catalogNote, open, onOpenChange,
}: ComposerModelSelectorProps) {
  const { t } = useTranslation('chat');
  const menuId = useId();
  // The new-chat wrapper can reopen this menu after the separate model library closes.
  const [localOpen, setLocalOpen] = useState(false);
  const isOpen = open ?? localOpen;
  // Only the requested secondary control opens; the primary menu stays short.
  const [submenu, setSubmenu] = useState<Submenu>(null);
  // Search belongs to More models rather than the first-click menu.
  const [search, setSearch] = useState('');
  // A rejected model or effort change stays visible without pretending the saved choice changed.
  const [error, setError] = useState<string | null>(null);
  // Serialize mutations so two choices cannot overwrite each other out of order.
  const [saving, setSaving] = useState(false);
  // Position a desktop flyout beside its parent, or use the same panel on a narrow window.
  const [flyout, setFlyout] = useState<{ left: number; top: number; width: number; maxHeight: number } | null>(null);
  const pendingRef = useRef(false);
  const mountedRef = useRef(false);
  const identityRef = useRef({ provider, model });
  const openFromKeyboardRef = useRef(false);
  const submenuFocusRef = useRef(false);
  const returnToSubmenuRef = useRef<Submenu>(null);
  const effortTriggerRef = useRef<HTMLButtonElement>(null);
  const modelsTriggerRef = useRef<HTMLButtonElement>(null);
  const mainRef = useRef<HTMLDivElement>(null);
  const submenuRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  useEffect(() => { identityRef.current = { provider, model }; }, [provider, model]);
  useEffect(() => { mountedRef.current = true; return () => { mountedRef.current = false; }; }, []);

  const setOpen = useCallback((value: boolean) => {
    if (open === undefined) setLocalOpen(value);
    onOpenChange?.(value);
    setSubmenu(null);
    setSearch('');
    setError(null);
  }, [open, onOpenChange]);
  const close = useCallback(() => setOpen(false), [setOpen]);
  const closeSubmenu = useCallback(() => {
    if (!submenu) return false;
    returnToSubmenuRef.current = submenu;
    setSubmenu(null);
    setSearch('');
    return true;
  }, [submenu]);
  const { triggerRef, menuRef, anchor, updateAnchor } = useComposerMenuAnchor(isOpen, close, 264, closeSubmenu);

  const entries = useMemo<ModelEntry[]>(() => groups.flatMap(group => group.models.map(option => ({ provider: group.provider, group: group.name, option }))), [groups]);
  const selected = entries.find(entry => (!provider || entry.provider === provider) && entry.option.value === model);
  const currentProvider = provider ?? selected?.provider ?? groups[0]?.provider ?? 'claude';
  const modelLabel = selected?.option.label || friendlyModelName(model);
  const defaultLabel = t('composer.effortDefault', { defaultValue: 'Default' });
  const acceptedEfforts = effortOptions.filter((option, index, options) => option.value !== DEFAULT_EFFORT_VALUE
    && options.findIndex(candidate => candidate.value === option.value) === index);
  const effectiveEffort = acceptedEfforts.some(option => option.value === effort) ? effort : DEFAULT_EFFORT_VALUE;
  const effortLabel = effectiveEffort === DEFAULT_EFFORT_VALUE ? defaultLabel : t(`composer.effortLabels.${effectiveEffort}`, { defaultValue: effectiveEffort });
  const allEfforts = [{ value: DEFAULT_EFFORT_VALUE }, ...acceptedEfforts];
  const resolvedLabel = resolvedModel ? entries.find(entry => entry.option.value === resolvedModel)?.option.label || friendlyModelName(resolvedModel) : null;
  const title = resolvedLabel && resolvedLabel !== modelLabel ? `${modelLabel} · ${t('composer.lastUsedModel', { model: resolvedLabel, defaultValue: 'Last used: {{model}}' })}` : modelLabel;
  const ariaLabel = t('composer.modelMenu', { defaultValue: 'Select model and reasoning effort' });
  const moreLabel = t('composer.moreModels', { defaultValue: 'More models' });
  const reasoningLabel = t('composer.effort', { defaultValue: 'Effort' });
  const searchLabel = t('providerSelection.searchModels', { defaultValue: 'Search models...' });

  const primaryModels = useMemo(() => {
    const current = entries.filter(entry => entry.provider === currentProvider);
    if (current.length <= 5) return current;
    const result: ModelEntry[] = [];
    const seen = new Set<string>();
    if (current.every(entry => entry.option.isCustom)) {
      const first = current.slice(0, 5);
      if (selected && !first.includes(selected)) first[first.length - 1] = selected;
      return first;
    }
    for (const entry of current) {
      // The server orders the catalog newest-first. Show the newest named member
      // of each family; old versions and auto aliases remain in More models.
      const family = /^(?:claude-)?(opus|fable|sonnet|haiku)(?:\s|[-\d])/i.exec(entry.option.label)?.[1]?.toLowerCase();
      if (family && !seen.has(family) && !/\bauto\b|\bplan\b|1m context/i.test(entry.option.label)) {
        seen.add(family);
        result.push(entry);
      }
    }
    if (selected && !result.some(entry => entry.option.value === selected.option.value)) result.push(selected);
    if (result.length === 0) return current.slice(0, 5);
    return result.slice(0, 5);
  }, [entries, currentProvider, selected]);
  const hasMoreModels = entries.length > primaryModels.length || groups.length > 1 || Boolean(onManageModels);
  const filteredModels = useMemo(() => {
    const tokens = search.toLowerCase().trim().split(/\s+/).filter(Boolean);
    return entries.filter(entry => tokens.every(token => `${entry.group} ${entry.provider} ${entry.option.label} ${entry.option.value} ${entry.option.description ?? ''}`.toLowerCase().includes(token)));
  }, [entries, search]);

  useLayoutEffect(() => {
    if (!isOpen || !submenu || !anchor) return;
    const parent = mainRef.current?.getBoundingClientRect();
    const source = (submenu === 'effort' ? effortTriggerRef.current : modelsTriggerRef.current)?.getBoundingClientRect();
    if (!parent || !source) return;
    const width = submenu === 'models' ? 288 : 216;
    const leftSpace = parent.left - 6;
    const rightSpace = window.innerWidth - parent.right - 6;
    if (Math.max(leftSpace, rightSpace) < width + 8) { setFlyout(null); return; }
    const height = Math.min(submenu === 'models' ? 378 : allEfforts.length * 32 + 42, window.innerHeight - 16);
    setFlyout({ left: rightSpace >= width + 8 ? parent.right + 6 : parent.left - width - 6,
      top: Math.max(8, Math.min(source.top - 5, window.innerHeight - height - 8)), width, maxHeight: window.innerHeight - 16 });
  }, [anchor, isOpen, submenu, allEfforts.length]);

  useEffect(() => {
    if (!isOpen || !openFromKeyboardRef.current) return;
    const target = mainRef.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]')
      ?? mainRef.current?.querySelector<HTMLButtonElement>('[role="menuitemradio"], [role="menuitem"]');
    target?.focus();
    openFromKeyboardRef.current = false;
  }, [isOpen]);
  useEffect(() => {
    if (!submenu || !submenuFocusRef.current) return;
    if (submenu === 'models') searchRef.current?.focus();
    else (submenuRef.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]')
      ?? submenuRef.current?.querySelector<HTMLButtonElement>('[role="menuitemradio"]'))?.focus();
    submenuFocusRef.current = false;
  }, [submenu, flyout]);
  useEffect(() => {
    if (!submenu && returnToSubmenuRef.current) {
      (returnToSubmenuRef.current === 'effort' ? effortTriggerRef.current : modelsTriggerRef.current)?.focus();
      returnToSubmenuRef.current = null;
    }
  }, [submenu]);

  const openSubmenu = (value: Exclude<Submenu, null>, keyboard = false) => {
    submenuFocusRef.current = keyboard;
    const parent = mainRef.current?.getBoundingClientRect();
    const source = (value === 'effort' ? effortTriggerRef.current : modelsTriggerRef.current)?.getBoundingClientRect();
    const width = value === 'models' ? 288 : 216;
    if (parent && source && Math.max(parent.left - 6, window.innerWidth - parent.right - 6) >= width + 8) {
      const height = Math.min(value === 'models' ? 378 : allEfforts.length * 32 + 42, window.innerHeight - 16);
      setFlyout({ left: window.innerWidth - parent.right - 6 >= width + 8 ? parent.right + 6 : parent.left - width - 6,
        top: Math.max(8, Math.min(source.top - 5, window.innerHeight - height - 8)), width, maxHeight: window.innerHeight - 16 });
    } else setFlyout(null);
    setSearch('');
    setSubmenu(value);
  };
  const persist = async (action: () => void | Promise<unknown>) => {
    if (pendingRef.current) return;
    pendingRef.current = true;
    setSaving(true);
    setError(null);
    const owner = identityRef.current;
    try {
      await action();
      if (mountedRef.current) { close(); triggerRef.current?.focus(); }
    } catch (failure) {
      if (mountedRef.current && identityRef.current === owner) setError(failure instanceof Error ? failure.message : t('composer.selectionSaveFailed', { defaultValue: 'Unable to save the selection.' }));
    } finally {
      pendingRef.current = false;
      if (mountedRef.current) setSaving(false);
    }
  };
  const navigateMenu = (event: KeyboardEvent<HTMLElement>) => {
    const target = event.target as HTMLElement;
    const scope = target.closest<HTMLElement>('[role="menu"]');
    if (!scope || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) || target.tagName === 'INPUT') return;
    const items = Array.from(scope.querySelectorAll<HTMLButtonElement>('[role="menuitem"], [role="menuitemradio"]')).filter(item => !item.disabled);
    if (!items.length) return;
    event.preventDefault();
    const index = items.indexOf(target as HTMLButtonElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1
      : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
    items[next]?.focus();
  };
  const renderModel = (entry: ModelEntry, index?: number) => {
    const checked = entry.provider === currentProvider && entry.option.value === model;
    const duplicate = entries.some(candidate => candidate !== entry && candidate.provider === entry.provider && candidate.option.label === entry.option.label);
    return <button key={`${entry.provider}:${entry.option.value}`} type="button" role="menuitemradio" aria-checked={checked} disabled={saving}
      aria-label={duplicate ? `${entry.option.label} (${entry.option.value})` : entry.option.label}
      data-current={checked ? 'true' : undefined} title={[entry.option.value, entry.option.description].filter(Boolean).join('\n')}
      className={MENU_ITEM_CLASS} onPointerEnter={() => { if (index !== undefined) setSubmenu(null); }} onClick={() => { void persist(() => onSelectModel(entry.provider, entry.option.value)); }}>
      <span className="min-w-0 flex-1 truncate">{entry.option.label || friendlyModelName(entry.option.value)}</span>
      {checked ? <Check className="h-3.5 w-3.5 shrink-0 text-primary" aria-hidden /> : index !== undefined ? <span className="w-3.5 shrink-0 text-center text-[11px] text-muted-foreground/70" aria-hidden>{index + 1}</span> : null}
    </button>;
  };
  const submenuContent = submenu && <div ref={submenuRef} role="menu" aria-label={submenu === 'effort' ? reasoningLabel : moreLabel}
    className={cn('composer-model-submenu flex flex-col rounded-lg bg-popover p-1 text-popover-foreground', flyout ? 'fixed border border-border/70 shadow-lg' : 'min-h-0 flex-1')}
    style={flyout ? { left: flyout.left, top: flyout.top, width: flyout.width, maxHeight: flyout.maxHeight } : undefined}
    onKeyDown={event => { event.stopPropagation(); if (event.key === 'ArrowLeft' || event.key === 'Escape') { event.preventDefault(); closeSubmenu(); } else if (event.key === 'Tab') close(); else navigateMenu(event); }}>
    {flyout ? <p className="px-2.5 py-1 text-[11px] text-muted-foreground">{submenu === 'effort' ? reasoningLabel : moreLabel}</p> :
      <button type="button" className={cn(MENU_ITEM_CLASS, 'mb-0.5 text-xs text-muted-foreground')} onClick={closeSubmenu} aria-label={t('composer.backToModels', { defaultValue: 'Back to models' })}>
        <ChevronLeft className="h-3 w-3" aria-hidden /><span>{submenu === 'effort' ? reasoningLabel : moreLabel}</span>
      </button>}
    {submenu === 'effort' ? <div className="overflow-y-auto">
      {allEfforts.map(option => {
        const label = option.value === DEFAULT_EFFORT_VALUE ? defaultLabel : t(`composer.effortLabels.${option.value}`, { defaultValue: option.value });
        return <button key={option.value} type="button" role="menuitemradio" aria-checked={effectiveEffort === option.value} disabled={saving}
          className={MENU_ITEM_CLASS} title={option.description || label} onClick={() => { void persist(() => onSelectEffort(option.value)); }}>
          <span className="flex-1">{label}</span>{effectiveEffort === option.value && <Check className="h-3.5 w-3.5 text-primary" aria-hidden />}
        </button>;
      })}
    </div> : <>
      <label className="mx-1 mb-1 flex items-center gap-2 border-b border-border/60 px-1.5 py-2 text-muted-foreground">
        <Search className="h-3.5 w-3.5 shrink-0" aria-hidden />
        <input ref={searchRef} type="search" value={search} onChange={event => setSearch(event.target.value)} placeholder={searchLabel} aria-label={searchLabel}
          className="min-w-0 flex-1 bg-transparent text-xs text-foreground outline-none placeholder:text-muted-foreground"
          onKeyDown={event => { if (event.key === 'ArrowDown') { event.preventDefault(); submenuRef.current?.querySelector<HTMLButtonElement>('[role="menuitemradio"]')?.focus(); } }} />
      </label>
      <div className="max-h-64 min-h-0 overflow-y-auto overscroll-contain">
        {groups.map(group => {
          const options = filteredModels.filter(entry => entry.provider === group.provider);
          if (!options.length) return null;
          return <div key={group.key} role="group" aria-label={group.name || undefined}>
            {groups.length > 1 && <p className="px-2.5 pb-1 pt-2 text-[11px] text-muted-foreground">{group.name}</p>}
            {options.map(entry => renderModel(entry))}
          </div>;
        })}
        {filteredModels.length === 0 && <p role="status" className="px-2.5 py-4 text-xs text-muted-foreground">{modelsLoading ? t('providerSelection.loadingModels', { defaultValue: 'Loading models…' }) : t('providerSelection.noModelsFound', { defaultValue: 'No models found.' })}</p>}
      </div>
      {onManageModels && <>
        <div role="separator" className="my-1 h-px shrink-0 bg-border/60" />
        <button type="button" role="menuitem" disabled={saving} className={MENU_ITEM_CLASS} onClick={() => { close(); onManageModels(); }} title={catalogNote}>
          <Settings2 className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />{t('providerSelection.manageModels', { defaultValue: 'Manage models' })}
        </button>
      </>}
    </>}
  </div>;

  return <>
    <button ref={triggerRef} type="button" className="composer-model-picker-trigger flex h-8 min-w-0 max-w-48 items-center gap-1.5 rounded-md px-2 text-xs text-foreground transition-colors hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:max-w-64"
      aria-haspopup="menu" aria-expanded={isOpen} aria-controls={isOpen ? menuId : undefined} aria-label={ariaLabel} title={title}
      onClick={() => { openFromKeyboardRef.current = !isOpen; updateAnchor(); setOpen(!isOpen); }}
      onKeyDown={event => { if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openFromKeyboardRef.current = true; updateAnchor(); setOpen(true); } }}>
      <span className="truncate font-medium">{modelLabel || t('composer.model', { defaultValue: 'Model' })}</span>
      {acceptedEfforts.length > 0 && effectiveEffort !== DEFAULT_EFFORT_VALUE && <span className="shrink-0 text-[11px] text-muted-foreground">{effortLabel}</span>}
      <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" aria-hidden />
    </button>
    {isOpen && anchor && createPortal(<div ref={menuRef} data-escape-layer className="pointer-events-none fixed inset-0 z-[100]">
      <div ref={mainRef} id={menuId} role="menu" aria-label={ariaLabel} tabIndex={-1}
        className="composer-model-panel pointer-events-auto fixed flex w-[264px] flex-col overflow-hidden rounded-lg border border-border/70 bg-popover p-1 text-popover-foreground shadow-lg"
        style={{ right: anchor.right, bottom: anchor.bottom, maxWidth: anchor.maxWidth, maxHeight: Math.min(420, anchor.maxHeight) }}
        onKeyDown={event => {
          if (/^[1-5]$/.test(event.key) && !submenu && event.target instanceof HTMLElement && event.target.tagName !== 'INPUT') {
            const entry = primaryModels[Number(event.key) - 1];
            if (entry) { event.preventDefault(); void persist(() => onSelectModel(entry.provider, entry.option.value)); }
          } else if (event.key === 'Tab') close();
          else navigateMenu(event);
        }}>
        {(!submenu || flyout) && <>
          <p className="px-2.5 pb-1.5 pt-1 text-[11px] text-muted-foreground">{t('composer.modelMenuHeading', { defaultValue: 'Model · this session' })}</p>
          <div className="min-h-0 overflow-y-auto">
            {primaryModels.map((entry, index) => renderModel(entry, index))}
            {primaryModels.length === 0 && <p role="status" className="px-2.5 py-3 text-xs text-muted-foreground">{modelsLoading ? t('providerSelection.loadingModels', { defaultValue: 'Loading models…' }) : t('providerSelection.noModelsFound', { defaultValue: 'No models found.' })}</p>}
          </div>
          {acceptedEfforts.length > 0 && <>
            <div role="separator" className="my-1 h-px shrink-0 bg-border/60" />
            <button ref={effortTriggerRef} type="button" role="menuitem" aria-haspopup="menu" aria-expanded={submenu === 'effort'} className={MENU_ITEM_CLASS}
              onPointerEnter={event => { if (event.pointerType === 'mouse' && window.innerWidth >= 640) openSubmenu('effort'); }}
              onClick={() => openSubmenu('effort', true)} onKeyDown={event => { if (event.key === 'ArrowRight') { event.preventDefault(); openSubmenu('effort', true); } }}>
              <span className="flex-1">{reasoningLabel}</span><span className="text-xs text-muted-foreground">{effortLabel}</span><ChevronRight className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
            </button>
          </>}
          {hasMoreModels && <>
            <div role="separator" className="my-1 h-px shrink-0 bg-border/60" />
            <button ref={modelsTriggerRef} type="button" role="menuitem" aria-haspopup="menu" aria-expanded={submenu === 'models'} className={MENU_ITEM_CLASS}
              onPointerEnter={event => { if (event.pointerType === 'mouse' && window.innerWidth >= 640) openSubmenu('models'); }}
              onClick={() => openSubmenu('models', true)} onKeyDown={event => { if (event.key === 'ArrowRight') { event.preventDefault(); openSubmenu('models', true); } }}>
              <span className="flex-1">{moreLabel}</span><ChevronRight className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
            </button>
          </>}
        </>}
        {submenu && !flyout && submenuContent}
        {saving && <p role="status" className="flex items-center gap-1.5 px-2.5 py-1.5 text-[11px] text-muted-foreground"><Loader2 className="h-3 w-3 animate-spin" aria-hidden />{t('composer.savingModel', { defaultValue: 'Saving selection…' })}</p>}
        {error && <p role="alert" className="px-2.5 py-2 text-xs leading-5 text-destructive">{error}</p>}
      </div>
      {submenu && flyout && <div className="pointer-events-auto">{submenuContent}</div>}
    </div>, document.body)}
  </>;
}
