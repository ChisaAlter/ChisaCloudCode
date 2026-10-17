import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { api } from '@/shared/api';
import type { PendingPermissionRequest, PermissionMode,
  ProjectSession,
  LLMProvider,
  Project,
  CustomProviderModelInput,
  ProviderModelActions,
  ProviderModelOption,
  ServerEvent,
  ProviderModelsDefinition } from '@/shared/types';
import { DEFAULT_EFFORT_VALUE } from '@/shared/constants';
import { readSelectedProvider, writeSelectedProvider } from '@/shared/selectedProvider';

const FALLBACK_PROVIDER_EFFORT_VALUES: Partial<Record<LLMProvider, readonly string[]>> = {
  // Superset used only before the model catalog loads; `ultracode` belongs to the
  // xhigh-capable models alone, but listing it here keeps a stored ultracode
  // selection from being reset during catalog hydration.
  claude: ['low', 'medium', 'high', 'xhigh', 'max', 'ultracode'],
  // Superset used only before the model catalog loads. Per-model metadata
  // narrows this once available; including the GPT-5.6 tiers here prevents a
  // valid Max/Ultra selection from being reset during catalog hydration.
  codex: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
  opencode: ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
};

const toProviderEffortOptions = (
  values: readonly string[],
): NonNullable<ProviderModelOption['effort']>['values'] => values.map((value) => ({ value }));

const FALLBACK_DEFAULT_MODEL: Record<LLMProvider, string> = {
  claude: 'default',
  cursor: 'gpt-5.3-codex',
  codex: 'gpt-5.4',
  opencode: 'anthropic/claude-sonnet-4-5',
};

const PROVIDERS: LLMProvider[] = ['claude', 'cursor', 'codex', 'opencode'];

/** localStorage key holding the user's default model for one provider. */
const providerModelStorageKey = (provider: LLMProvider): string => `${provider}-model`;

/**
 * Fallback permission-mode matrix used only until the backend capability
 * matrix (`GET /api/providers/capabilities`) has loaded. The backend is the
 * source of truth; this mirror exists so the composer renders sensibly on
 * first paint and when the capabilities request fails.
 */
const FALLBACK_PERMISSION_MODES: Record<LLMProvider, PermissionMode[]> = {
  claude: ['default', 'auto', 'acceptEdits', 'bypassPermissions', 'plan'],
  cursor: ['default', 'acceptEdits', 'bypassPermissions', 'plan'],
  codex: ['default', 'acceptEdits', 'bypassPermissions'],
  opencode: ['default', 'acceptEdits', 'bypassPermissions', 'plan'],
};

type ProviderCapabilities = {
  provider: LLMProvider;
  permissionModes: string[];
  defaultPermissionMode: string;
  supportsImages: boolean;
  supportsFiles: boolean;
  supportsAbort: boolean;
  supportsPermissionRequests: boolean;
  supportsTokenUsage: boolean;
  supportsEffort?: boolean;
  supportsMessageEditing?: boolean;
  supportsSessionForking?: boolean;
};

type ProviderCapabilitiesApiResponse = {
  success?: boolean;
  data?: {
    providers?: ProviderCapabilities[];
  };
};

type UseChatProviderStateArgs = {
  selectedSession: ProjectSession | null;
  selectedProject: Project | null;
  subscribe?: (listener: (event: ServerEvent) => void) => () => void;
};

type ProviderModelsApiResponse = {
  success?: boolean;
  data?: {
    models?: ProviderModelsDefinition;
  };
};

type ProviderModelMutationApiResponse = {
  success?: boolean;
  data?: {
    model?: ProviderModelOption;
    models?: ProviderModelsDefinition;
  };
  error?: {
    message?: string;
  };
};

type SessionSelectionApiResponse = {
  success?: boolean;
  data?: {
    provider?: LLMProvider;
    sessionId?: string | null;
    model?: string | null;
    resolvedModel?: string | null;
    effort?: string | null;
    /**
     * `session` and `provider` are real answers for this session; `default`
     * means the backend had nothing recorded and returned the catalog default,
     * which the composer replaces with the user's per-provider selection.
     */
    source?: 'session' | 'provider' | 'default';
  };
};

type SessionProviderSelection = {
  provider: LLMProvider;
  sessionId: string;
  model: string | null;
  resolvedModel?: string | null;
  effort: string | null;
  status: 'loading' | 'ready' | 'error';
  error?: string;
};

const getSessionSelectionKey = (provider: LLMProvider, sessionId: string): string => (
  `${provider}:${sessionId}`
);

export function useChatProviderState({ selectedSession, selectedProject: _selectedProject, subscribe }: UseChatProviderStateArgs) {
  const [permissionMode, setPermissionMode] = useState<PermissionMode>('default');
  const [pendingPermissionRequests, setPendingPermissionRequests] = useState<PendingPermissionRequest[]>([]);
  // The provider the composer sends under. Held here rather than read from
  // storage per render because switching it has to reset the model menu, the
  // permission mode and the session in one commit.
  const [provider, setProvider] = useState<LLMProvider>(readSelectedProvider);
  // Every provider's chosen model, not just the active one: switching provider
  // must restore the model that provider was last used with, and the catalogue
  // that validates them arrives asynchronously per provider.
  const [providerModels, setProviderModels] = useState<Record<LLMProvider, string>>(() => {
    return PROVIDERS.reduce<Record<LLMProvider, string>>((acc, targetProvider) => {
      acc[targetProvider] = localStorage.getItem(providerModelStorageKey(targetProvider))
        || FALLBACK_DEFAULT_MODEL[targetProvider];
      return acc;
    }, {} as Record<LLMProvider, string>);
  });
  const [providerEfforts, setProviderEfforts] = useState<Partial<Record<LLMProvider, string>>>(() => {
    return PROVIDERS.reduce<Partial<Record<LLMProvider, string>>>((acc, targetProvider) => {
      acc[targetProvider] = localStorage.getItem(`${targetProvider}-effort`) || DEFAULT_EFFORT_VALUE;
      return acc;
    }, {});
  });

  /**
   * Backend-owned capability matrix keyed by provider. Drives the permission
   * mode picker (and is the extension point for future per-provider UI
   * differences) so the frontend stays free of hardcoded provider branching.
   * Null until `/api/providers/capabilities` resolves; the static fallback
   * map covers that window.
   */
  const [providerCapabilities, setProviderCapabilities] = useState<
    Partial<Record<LLMProvider, ProviderCapabilities>> | null
  >(null);

  const [providerModelCatalog, setProviderModelCatalog] = useState<
    Partial<Record<LLMProvider, ProviderModelsDefinition>>
  >({});
  // One slow provider must not keep the active provider's model menu loading.
  const [modelCatalogLoading, setModelCatalogLoading] = useState<Partial<Record<LLMProvider, boolean>>>({});
  // Failed reads retain the previous catalog and expose a retry in the same menu.
  const [modelCatalogErrors, setModelCatalogErrors] = useState<Partial<Record<LLMProvider, boolean>>>({});

  const providerModelsRequestIdRef = useRef<Partial<Record<LLMProvider, number>>>({});
  const modelCatalogControllersRef = useRef<Partial<Record<LLMProvider, AbortController>>>({});
  const sessionSelectionLoadRequestIdRef = useRef(0);
  const liveResolvedModelRef = useRef<{ key: string; model: string } | null>(null);
  const sessionModelMutationIdRef = useRef(0);
  const sessionEffortMutationIdRef = useRef(0);
  const providerModelsRef = useRef(providerModels);
  providerModelsRef.current = providerModels;

  const setStoredProviderModel = useCallback((targetProvider: LLMProvider, model: string) => {
    providerModelsRef.current = { ...providerModelsRef.current, [targetProvider]: model };
    setProviderModels((previous) => (
      previous[targetProvider] === model
        ? previous
        : { ...previous, [targetProvider]: model }
    ));
    localStorage.setItem(providerModelStorageKey(targetProvider), model);
  }, []);

  const setStoredProviderEffort = useCallback((targetProvider: LLMProvider, effort: string) => {
    setProviderEfforts((previous) => (
      previous[targetProvider] === effort
        ? previous
        : { ...previous, [targetProvider]: effort }
    ));
    localStorage.setItem(`${targetProvider}-effort`, effort);
  }, []);

  const loadProviderModels = useCallback(async (targetProvider: LLMProvider) => {
    const requestId = (providerModelsRequestIdRef.current[targetProvider] ?? 0) + 1;
    providerModelsRequestIdRef.current[targetProvider] = requestId;
    modelCatalogControllersRef.current[targetProvider]?.abort();
    const controller = new AbortController();
    modelCatalogControllersRef.current[targetProvider] = controller;
    setModelCatalogLoading((current) => ({ ...current, [targetProvider]: true }));
    setModelCatalogErrors((current) => ({ ...current, [targetProvider]: false }));
    // Catalog reads must not wait for the native bridge's multi-minute workspace timeout.
    const timeout = setTimeout(() => controller.abort(), 15_000);

    try {
      const response = await api.providers.models(targetProvider, { signal: controller.signal });
      const body = (await response.json()) as ProviderModelsApiResponse;
      if (!response.ok || !body.success || !body.data?.models) throw new Error('Unable to load model catalog');
      if (providerModelsRequestIdRef.current[targetProvider] !== requestId) return;
      setProviderModelCatalog((current) => ({ ...current, [targetProvider]: body.data!.models! }));
    } catch (error) {
      if (providerModelsRequestIdRef.current[targetProvider] !== requestId) return;
      setModelCatalogErrors((current) => ({ ...current, [targetProvider]: true }));
      console.error(`Error loading ${targetProvider} models:`, error);
    } finally {
      clearTimeout(timeout);
      if (providerModelsRequestIdRef.current[targetProvider] === requestId) {
        setModelCatalogLoading((current) => ({ ...current, [targetProvider]: false }));
        delete modelCatalogControllersRef.current[targetProvider];
      }
    }
  }, []);

  useEffect(() => {
    PROVIDERS.forEach((targetProvider) => { void loadProviderModels(targetProvider); });
    return () => {
      for (const targetProvider of PROVIDERS) {
        providerModelsRequestIdRef.current[targetProvider] = (providerModelsRequestIdRef.current[targetProvider] ?? 0) + 1;
        modelCatalogControllersRef.current[targetProvider]?.abort();
      }
    };
  }, [loadProviderModels]);

  const reloadProviderModels = useCallback(() => { void loadProviderModels(provider); }, [loadProviderModels, provider]);

  useEffect(() => {
    let cancelled = false;

    const loadCapabilities = async () => {
      try {
        const response = await api.providers.capabilities();
        const body = (await response.json()) as ProviderCapabilitiesApiResponse;
        if (cancelled || !body.success || !Array.isArray(body.data?.providers)) {
          return;
        }

        const byProvider: Partial<Record<LLMProvider, ProviderCapabilities>> = {};
        for (const capabilities of body.data.providers) {
          byProvider[capabilities.provider] = capabilities;
        }
        setProviderCapabilities(byProvider);
      } catch (error) {
        console.error('Error loading provider capabilities:', error);
      }
    };

    void loadCapabilities();
    return () => {
      cancelled = true;
    };
  }, []);

  const getPermissionModesForProvider = useCallback((targetProvider: LLMProvider): PermissionMode[] => {
    const capabilityModes = providerCapabilities?.[targetProvider]?.permissionModes;
    if (capabilityModes && capabilityModes.length > 0) {
      return capabilityModes as PermissionMode[];
    }
    return FALLBACK_PERMISSION_MODES[targetProvider] ?? ['default'];
  }, [providerCapabilities]);

  const getDefaultPermissionModeForProvider = useCallback((targetProvider: LLMProvider): PermissionMode => {
    const modes = getPermissionModesForProvider(targetProvider);
    const capabilityDefault = providerCapabilities?.[targetProvider]?.defaultPermissionMode as PermissionMode | undefined;
    if (capabilityDefault && modes.includes(capabilityDefault)) {
      return capabilityDefault;
    }
    return modes[0] ?? 'default';
  }, [getPermissionModesForProvider, providerCapabilities]);

  const getSupportsEffortForProvider = useCallback((targetProvider: LLMProvider): boolean => {
    const capabilitySupport = providerCapabilities?.[targetProvider]?.supportsEffort;
    if (typeof capabilitySupport === 'boolean') {
      return capabilitySupport;
    }
    return Boolean(FALLBACK_PROVIDER_EFFORT_VALUES[targetProvider]?.length);
  }, [providerCapabilities]);

  const pickStoredOrCurrent = (
    storageKey: string,
    current: string,
    def: ProviderModelsDefinition,
  ): string => {
    const stored = localStorage.getItem(storageKey);
    if (stored && def.OPTIONS.some((o) => o.value === stored)) {
      return stored;
    }
    if (current && def.OPTIONS.some((o) => o.value === current)) {
      return current;
    }
    return def.DEFAULT;
  };

  const getModelOption = useCallback((
    targetProvider: LLMProvider,
    model: string,
  ): ProviderModelOption | null => {
    const definition = providerModelCatalog[targetProvider];
    if (!definition) {
      return null;
    }

    return definition.OPTIONS.find((option) => option.value === model) ?? null;
  }, [providerModelCatalog]);

  const getEffortOptionsForModel = useCallback((
    targetProvider: LLMProvider,
    model: string,
  ): NonNullable<ProviderModelOption['effort']>['values'] => {
    if (!getSupportsEffortForProvider(targetProvider)) {
      return [];
    }

    const option = getModelOption(targetProvider, model);
    if (option) {
      return option.effort?.values ?? [];
    }

    return toProviderEffortOptions(FALLBACK_PROVIDER_EFFORT_VALUES[targetProvider] ?? []);
  }, [getModelOption, getSupportsEffortForProvider]);

  const getAllowedEffortValues = useCallback((
    targetProvider: LLMProvider,
    model: string,
  ): string[] => (
    getEffortOptionsForModel(targetProvider, model).map((value) => value.value)
  ), [getEffortOptionsForModel]);

  const reconcileStoredEffort = useCallback((
    targetProvider: LLMProvider,
    model: string,
    currentEffort: string,
  ): string => {
    const allowedValues = getAllowedEffortValues(targetProvider, model);
    if (allowedValues.length === 0) {
      return DEFAULT_EFFORT_VALUE;
    }

    if (currentEffort === DEFAULT_EFFORT_VALUE || !currentEffort) {
      return DEFAULT_EFFORT_VALUE;
    }

    if (allowedValues.includes(currentEffort)) {
      return currentEffort;
    }

    return DEFAULT_EFFORT_VALUE;
  }, [getAllowedEffortValues]);

  // One reconciliation pass over every provider, mirroring the effort effect
  // below. This was four copy-pasted eleven-line effects, one per provider.
  useEffect(() => {
    const reconciledModels: Partial<Record<LLMProvider, string>> = {};

    for (const targetProvider of PROVIDERS) {
      const catalog = providerModelCatalog[targetProvider];
      if (!catalog) {
        continue;
      }

      const storageKey = providerModelStorageKey(targetProvider);
      const currentModel = providerModels[targetProvider];
      const nextModel = pickStoredOrCurrent(storageKey, currentModel, catalog);

      if (nextModel !== currentModel) {
        reconciledModels[targetProvider] = nextModel;
      }
      if (localStorage.getItem(storageKey) !== nextModel) {
        localStorage.setItem(storageKey, nextModel);
      }
    }

    if (Object.keys(reconciledModels).length > 0) {
      setProviderModels((previous) => ({ ...previous, ...reconciledModels }));
    }
  }, [providerModelCatalog, providerModels]);

  useEffect(() => {
    const nextEfforts: Partial<Record<LLMProvider, string>> = {};
    let hasUpdates = false;

    for (const targetProvider of PROVIDERS) {
      const currentEffort = providerEfforts[targetProvider] ?? DEFAULT_EFFORT_VALUE;
      const nextEffort = reconcileStoredEffort(targetProvider, providerModels[targetProvider], currentEffort);
      if (nextEffort === currentEffort) {
        continue;
      }

      nextEfforts[targetProvider] = nextEffort;
      localStorage.setItem(`${targetProvider}-effort`, nextEffort);
      hasUpdates = true;
    }

    if (hasUpdates) {
      setProviderEfforts((previous) => ({ ...previous, ...nextEfforts }));
    }
  }, [providerEfforts, providerModels, reconcileStoredEffort]);

  useEffect(() => {
    const validModes = getPermissionModesForProvider(provider);
    const sessionSavedMode = selectedSession?.id
      ? (localStorage.getItem(`permissionMode-${selectedSession.id}`) as PermissionMode | null)
      : null;
    // Fall back to the last mode picked for this provider: a brand-new chat
    // only receives its session id after the first send, so without this the
    // mode chosen beforehand would snap back to the default as soon as the
    // session id appears.
    const providerSavedMode = localStorage.getItem(`permissionMode-last-${provider}`) as PermissionMode | null;
    const savedMode = [sessionSavedMode, providerSavedMode].find(
      (mode): mode is PermissionMode => Boolean(mode && validModes.includes(mode)),
    );
    setPermissionMode(savedMode ?? getDefaultPermissionModeForProvider(provider));
  }, [selectedSession?.id, provider, getDefaultPermissionModeForProvider, getPermissionModesForProvider]);

  useEffect(() => {
    if (!selectedSession?.__provider || selectedSession.__provider === provider) {
      return;
    }

    setProvider(selectedSession.__provider);
    writeSelectedProvider(selectedSession.__provider);
  }, [provider, selectedSession]);

  // Permission prompts belong to a session, not to the transient provider
  // selection that is synchronized after navigation.
  useEffect(() => {
    setPendingPermissionRequests((previous) =>
      previous.filter((request) => !request.sessionId || request.sessionId === selectedSession?.id),
    );
  }, [selectedSession?.id]);

  const selectPermissionMode = useCallback((nextMode: PermissionMode) => {
    setPermissionMode(nextMode);

    // Persist per provider as well as per session: a brand-new chat has no
    // session id yet, and the per-provider key keeps the choice sticky when
    // the real id arrives (and for future sessions of this provider).
    localStorage.setItem(`permissionMode-last-${provider}`, nextMode);
    if (selectedSession?.id) {
      localStorage.setItem(`permissionMode-${selectedSession.id}`, nextMode);
    }
  }, [provider, selectedSession?.id]);

  const cyclePermissionMode = useCallback(() => {
    const modes = getPermissionModesForProvider(provider);

    const currentIndex = modes.indexOf(permissionMode);
    const nextIndex = (currentIndex + 1) % modes.length;
    selectPermissionMode(modes[nextIndex]);
  }, [permissionMode, provider, getPermissionModesForProvider, selectPermissionMode]);

  const availablePermissionModes = useMemo(
    () => getPermissionModesForProvider(provider),
    [getPermissionModesForProvider, provider],
  );

  /**
   * Both default to false until the matrix loads, so an affordance is never
   * offered and then withdrawn — and never offered at all for a provider whose
   * runtime would reject it.
   */
  const supportsMessageEditing = Boolean(providerCapabilities?.[provider]?.supportsMessageEditing);
  const supportsSessionForking = Boolean(providerCapabilities?.[provider]?.supportsSessionForking);

  const resolvePermissionModeForProvider = useCallback((
    targetProvider: LLMProvider,
    requestedMode: PermissionMode | string,
  ): PermissionMode => {
    const validModes = getPermissionModesForProvider(targetProvider);
    return validModes.includes(requestedMode as PermissionMode)
      ? requestedMode as PermissionMode
      : getDefaultPermissionModeForProvider(targetProvider);
  }, [getDefaultPermissionModeForProvider, getPermissionModesForProvider]);

  /** Model and reasoning effort recorded for the open session by the backend. */
  const [sessionSelection, setSessionSelection] = useState<SessionProviderSelection | null>(null);
  // Explicit retries reload only the selected session without replacing its draft.
  const [sessionSelectionReload, setSessionSelectionReload] = useState(0);
  const selectedSessionId = selectedSession?.id?.trim() || null;
  const selectedSessionProvider = selectedSession?.__provider ?? provider;
  const selectedSessionKey = selectedSessionId
    ? getSessionSelectionKey(selectedSessionProvider, selectedSessionId)
    : null;
  const selectedSessionKeyRef = useRef<string | null>(selectedSessionKey);
  selectedSessionKeyRef.current = selectedSessionKey;

  const activeSessionSelection = sessionSelection
    && selectedSessionId
    && sessionSelection.sessionId === selectedSessionId
    && sessionSelection.provider === selectedSessionProvider
    ? sessionSelection
    : null;
  const sessionModel = activeSessionSelection?.model ?? null;
  const sessionOptionsReady = !selectedSessionKey || activeSessionSelection?.status === 'ready';
  const sessionOptionsError = activeSessionSelection?.status === 'error'
    ? activeSessionSelection.error ?? 'Unable to load this session’s model and reasoning effort.'
    : null;
  const reloadSessionOptions = useCallback(() => {
    setSessionSelection((current) => current ? { ...current, status: 'loading', error: undefined } : current);
    setSessionSelectionReload((revision) => revision + 1);
  }, []);

  useEffect(() => {
    const requestId = sessionSelectionLoadRequestIdRef.current + 1;
    sessionSelectionLoadRequestIdRef.current = requestId;
    liveResolvedModelRef.current = null;

    if (!selectedSessionId) {
      setSessionSelection(null);
      return;
    }

    let cancelled = false;
    const targetProvider = selectedSessionProvider;
    const targetSessionKey = getSessionSelectionKey(targetProvider, selectedSessionId);
    setSessionSelection((current) => ({
      provider: targetProvider,
      sessionId: selectedSessionId,
      model: current?.provider === targetProvider && current.sessionId === selectedSessionId ? current.model : null,
      effort: current?.provider === targetProvider && current.sessionId === selectedSessionId ? current.effort : null,
      resolvedModel: current?.provider === targetProvider && current.sessionId === selectedSessionId ? current.resolvedModel : null,
      status: 'loading',
    }));

    const loadSessionSelection = async () => {
      try {
        const response = await api.providers.sessionActiveModel(targetProvider, selectedSessionId);
        const body = (await response.json()) as SessionSelectionApiResponse;
        if (
          cancelled
          || sessionSelectionLoadRequestIdRef.current !== requestId
          || selectedSessionKeyRef.current !== targetSessionKey
        ) {
          return;
        }
        if (!response.ok || !body.success || !body.data) {
          throw new Error('Unable to load this session’s model and reasoning effort.');
        }

        const resolvedModel = body.data?.model?.trim();
        const resolvedEffort = body.data?.effort?.trim() || null;
        setSessionSelection({
          provider: targetProvider,
          sessionId: selectedSessionId,
          model: body.success && resolvedModel && body.data?.source !== 'default' ? resolvedModel : null,
          resolvedModel: liveResolvedModelRef.current?.key === targetSessionKey
            ? liveResolvedModelRef.current.model
            : body.success ? body.data?.resolvedModel?.trim() || null : null,
          effort: body.success ? resolvedEffort : null,
          status: 'ready',
        });
      } catch (error) {
        if (
          !cancelled
          && sessionSelectionLoadRequestIdRef.current === requestId
          && selectedSessionKeyRef.current === targetSessionKey
        ) {
          console.error('Error loading the session model and reasoning effort:', error);
          setSessionSelection((current) => ({
            provider: targetProvider,
            sessionId: selectedSessionId,
            model: current?.provider === targetProvider && current.sessionId === selectedSessionId ? current.model : null,
            resolvedModel: liveResolvedModelRef.current?.key === targetSessionKey
              ? liveResolvedModelRef.current.model : null,
            effort: current?.provider === targetProvider && current.sessionId === selectedSessionId ? current.effort : null,
            status: 'error',
            error: error instanceof Error ? error.message : 'Unable to load this session’s model and reasoning effort.',
          }));
        }
      }
    };

    void loadSessionSelection();
    return () => {
      cancelled = true;
    };
  }, [selectedSessionId, selectedSessionProvider, sessionSelectionReload]);

  useEffect(() => subscribe?.((event) => {
    if (event.kind !== 'status' || event.text !== 'model_resolved'
      || event.provider !== selectedSessionProvider || event.sessionId !== selectedSessionId
      || typeof event.model !== 'string' || !event.model.trim()) return;
    liveResolvedModelRef.current = {
      key: getSessionSelectionKey(selectedSessionProvider, selectedSessionId!),
      model: event.model.trim(),
    };
    setSessionSelection((current) => ({
      provider: selectedSessionProvider,
      sessionId: selectedSessionId!,
      model: current?.sessionId === selectedSessionId && current.provider === selectedSessionProvider
        ? current.model : null,
      effort: current?.sessionId === selectedSessionId && current.provider === selectedSessionProvider
        ? current.effort : null,
      resolvedModel: event.model as string,
      status: current?.sessionId === selectedSessionId && current.provider === selectedSessionProvider
        ? current.status : 'loading',
      error: current?.sessionId === selectedSessionId && current.provider === selectedSessionProvider
        ? current.error : undefined,
    }));
  }), [subscribe, selectedSessionId, selectedSessionProvider]);

  /**
   * Applies a model choice.
   *
   * The pick always becomes the per-provider default so the next new chat
   * inherits it, and — when a session is open — is also recorded against that
   * session so reopening it later restores this model.
   * Queue-control restores supply an optional validity predicate; ordinary picks use the original entry point.
   */
  const selectProviderModel = useCallback(async (
    targetProvider: LLMProvider,
    model: string,
    sessionId?: string | null,
    isCurrent: () => boolean = () => true,
  ) => {
    const normalizedSessionId = typeof sessionId === 'string' ? sessionId.trim() : '';
    const targetSessionKey = getSessionSelectionKey(targetProvider, normalizedSessionId);
    const selection = { scope: normalizedSessionId ? 'session' as const : 'default' as const, model };
    if (!isCurrent()) return selection;
    if (normalizedSessionId && selectedSessionKeyRef.current === targetSessionKey
      && (sessionSelection?.provider !== targetProvider
      || sessionSelection.sessionId !== normalizedSessionId || sessionSelection.status !== 'ready')) {
      throw new Error('Wait for this session’s model and reasoning effort to load before changing them.');
    }
    setStoredProviderModel(targetProvider, model);
    if (!normalizedSessionId) {
      return { scope: 'default' as const, model };
    }

    // A pending GET represents the state before this click and must not win
    // if it resolves after the mutation.
    if (selectedSessionKeyRef.current === targetSessionKey) sessionSelectionLoadRequestIdRef.current += 1;
    const mutationId = sessionModelMutationIdRef.current + 1;
    sessionModelMutationIdRef.current = mutationId;

    try {
      const response = await api.providers.setSessionActiveModel(targetProvider, normalizedSessionId, model);
      if (!isCurrent()) return selection;
      const body = (await response.json()) as SessionSelectionApiResponse;
      if (!isCurrent()) return selection;
      if (!response.ok || !body.success) {
        throw new Error('Unable to change the active model for this session.');
      }

      const storedModel = body.data?.model?.trim() || model;
      if (
        sessionModelMutationIdRef.current === mutationId
        && selectedSessionKeyRef.current === targetSessionKey
      ) {
        // A queued-controls restore can be superseded without changing the selected session id.
        setSessionSelection((current) => isCurrent() && current?.provider === targetProvider && current.sessionId === normalizedSessionId ? {
          ...current,
          model: storedModel,
        } : current);
      }
      return { scope: 'session' as const, model: storedModel };
    } catch (error) {
      if (!isCurrent()) return selection;
      throw error;
    }
  }, [sessionSelection, setStoredProviderModel]);

  /**
   * Applies an effort choice optimistically and persists it for the open
   * session. Mutation counters keep slower earlier requests from overwriting
   * the latest click; a queued restore also checks its caller's editor validity at each state write.
   */
  const selectProviderEffort = useCallback(async (
    targetProvider: LLMProvider,
    effort: string,
    sessionId?: string | null,
    isCurrent: () => boolean = () => true,
  ) => {
    const normalizedSessionId = typeof sessionId === 'string' ? sessionId.trim() : '';
    const targetSessionKey = getSessionSelectionKey(targetProvider, normalizedSessionId);
    const selection = { scope: normalizedSessionId ? 'session' as const : 'default' as const, effort };
    if (!isCurrent()) return selection;
    if (normalizedSessionId && selectedSessionKeyRef.current === targetSessionKey
      && (sessionSelection?.provider !== targetProvider
      || sessionSelection.sessionId !== normalizedSessionId || sessionSelection.status !== 'ready')) {
      throw new Error('Wait for this session’s model and reasoning effort to load before changing them.');
    }
    setStoredProviderEffort(targetProvider, effort);
    if (!normalizedSessionId) {
      return { scope: 'default' as const, effort };
    }

    if (selectedSessionKeyRef.current === targetSessionKey) sessionSelectionLoadRequestIdRef.current += 1;
    const mutationId = sessionEffortMutationIdRef.current + 1;
    sessionEffortMutationIdRef.current = mutationId;
    const previousSelection = sessionSelection?.provider === targetProvider
      && sessionSelection.sessionId === normalizedSessionId
      ? sessionSelection
      : null;

    setSessionSelection((current) => isCurrent() && current?.provider === targetProvider && current.sessionId === normalizedSessionId ? {
      ...current,
      effort,
    } : current);

    try {
      const response = await api.providers.setSessionActiveEffort(
        targetProvider,
        normalizedSessionId,
        effort,
      );
      if (!isCurrent()) return selection;
      const body = (await response.json()) as SessionSelectionApiResponse;
      if (!isCurrent()) return selection;
      if (!response.ok || !body.success) {
        throw new Error('Unable to change the reasoning effort for this session.');
      }

      const storedEffort = body.data?.effort?.trim() || effort;
      if (
        sessionEffortMutationIdRef.current === mutationId
        && selectedSessionKeyRef.current === targetSessionKey
      ) {
        setSessionSelection((current) => isCurrent() && current?.provider === targetProvider && current.sessionId === normalizedSessionId ? {
          ...current,
          effort: storedEffort,
        } : current);
      }

      return { scope: 'session' as const, effort: storedEffort };
    } catch (error) {
      if (!isCurrent()) return selection;
      if (
        sessionEffortMutationIdRef.current === mutationId
        && selectedSessionKeyRef.current === targetSessionKey
      ) {
        setSessionSelection((current) => (
          isCurrent() && current?.provider === targetProvider
          && current.sessionId === normalizedSessionId
          && current.effort === effort
            ? { ...current, effort: previousSelection?.effort ?? null }
            : current
        ));
      }
      throw error;
    }
  }, [sessionSelection, setStoredProviderEffort]);

  // The open session's model wins over the per-provider default, so switching
  // sessions shows (and sends) what each session actually runs with.
  const currentProviderModel = sessionModel ?? providerModels[provider];
  const currentProviderEffortOptions = useMemo(() => {
    return getEffortOptionsForModel(provider, currentProviderModel);
  }, [currentProviderModel, getEffortOptionsForModel, provider]);
  const currentProviderEffort = useMemo(() => {
    return reconcileStoredEffort(
      provider,
      currentProviderModel,
      activeSessionSelection ? activeSessionSelection.effort ?? DEFAULT_EFFORT_VALUE
        : providerEfforts[provider] ?? DEFAULT_EFFORT_VALUE,
    );
  }, [activeSessionSelection, currentProviderModel, provider, providerEfforts, reconcileStoredEffort]);
  const currentProviderModelOptions = useMemo(
    () => providerModelCatalog[provider]?.OPTIONS ?? [],
    [provider, providerModelCatalog],
  );

  const applyProviderCatalog = useCallback((
    targetProvider: LLMProvider,
    models: ProviderModelsDefinition,
  ) => {
    setProviderModelCatalog((previous) => ({
      ...previous,
      [targetProvider]: models,
    }));
  }, []);

  const readModelMutationResponse = useCallback(async (
    response: Response,
  ): Promise<Required<Pick<NonNullable<ProviderModelMutationApiResponse['data']>, 'model' | 'models'>>> => {
    const body = (await response.json()) as ProviderModelMutationApiResponse;
    if (!response.ok || !body.success || !body.data?.model || !body.data.models) {
      throw new Error(body.error?.message || 'Unable to save this model.');
    }

    return {
      model: body.data.model,
      models: body.data.models,
    };
  }, []);

  const createCustomModel = useCallback(async (
    targetProvider: LLMProvider,
    input: CustomProviderModelInput,
  ) => {
    const response = await api.providers.createModel(targetProvider, input);
    const result = await readModelMutationResponse(response);
    applyProviderCatalog(targetProvider, result.models);
  }, [applyProviderCatalog, readModelMutationResponse]);

  const updateCustomModel = useCallback(async (
    targetProvider: LLMProvider,
    existing: ProviderModelOption,
    input: CustomProviderModelInput,
  ) => {
    if (!existing.recordId) {
      throw new Error('This model cannot be edited.');
    }
    const targetSessionKey = selectedSessionKeyRef.current;

    const response = await api.providers.updateModel(targetProvider, existing.recordId, input);
    const result = await readModelMutationResponse(response);
    applyProviderCatalog(targetProvider, result.models);

    if (providerModelsRef.current[targetProvider] === existing.value) {
      setStoredProviderModel(targetProvider, result.model.value);
    }
    if (selectedSessionKeyRef.current === targetSessionKey) {
      setSessionSelection((current) => current?.provider === targetProvider
        && getSessionSelectionKey(current.provider, current.sessionId) === targetSessionKey
        && current.model === existing.value ? {
        ...current,
        model: result.model.value,
      } : current);
    }
  }, [
    applyProviderCatalog,
    readModelMutationResponse,
    setStoredProviderModel,
  ]);

  const removeCustomModel = useCallback(async (
    targetProvider: LLMProvider,
    existing: ProviderModelOption,
  ) => {
    if (!existing.recordId) {
      throw new Error('This model cannot be deleted.');
    }
    const targetSessionKey = selectedSessionKeyRef.current;

    const response = await api.providers.deleteModel(targetProvider, existing.recordId);
    const result = await readModelMutationResponse(response);
    applyProviderCatalog(targetProvider, result.models);

    if (providerModelsRef.current[targetProvider] === existing.value) {
      setStoredProviderModel(targetProvider, result.models.DEFAULT);
    }
    if (selectedSessionKeyRef.current === targetSessionKey) {
      setSessionSelection((current) => current?.provider === targetProvider
        && getSessionSelectionKey(current.provider, current.sessionId) === targetSessionKey
        && current.model === existing.value ? {
        ...current,
        model: result.models.DEFAULT,
      } : current);
    }
  }, [
    applyProviderCatalog,
    readModelMutationResponse,
    setStoredProviderModel,
  ]);

  const providerModelActions = useMemo<ProviderModelActions>(() => ({
    create: createCustomModel,
    update: updateCustomModel,
    remove: removeCustomModel,
  }), [createCustomModel, removeCustomModel, updateCustomModel]);

  return {
    provider,
    setProvider,
    providerModels,
    setStoredProviderModel,
    currentProviderEffort,
    currentProviderEffortOptions,
    currentProviderModel,
    sessionOptionsReady,
    sessionOptionsError,
    reloadSessionOptions,
    currentResolvedModel: activeSessionSelection?.resolvedModel ?? null,
    currentProviderModelOptions,
    permissionMode,
    pendingPermissionRequests,
    setPendingPermissionRequests,
    availablePermissionModes,
    selectPermissionMode,
    cyclePermissionMode,
    providerModelCatalog,
    providerModelsLoading: modelCatalogLoading[provider] ?? true,
    providerModelsError: modelCatalogErrors[provider] ?? false,
    reloadProviderModels,
    providerModelActions,
    selectProviderModel,
    selectProviderEffort,
    resolvePermissionModeForProvider,
    supportsMessageEditing,
    supportsSessionForking,
  };
}
