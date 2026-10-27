import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { api } from '@/shared/api';
import type { PendingPermissionRequest, PermissionMode,
  ProjectSession,
  LLMProvider,
  Project,
  CustomProviderModelInput,
  ProviderModelActions,
  ProviderModelOption,
  ProjectDefaultSettings,
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
};

const getSessionSelectionKey = (provider: LLMProvider, sessionId: string): string => (
  `${provider}:${sessionId}`
);

export function useChatProviderState({ selectedSession, selectedProject, subscribe }: UseChatProviderStateArgs) {
  const sshProject = selectedProject?.sourceMode === 'ssh';
  const [permissionMode, setPermissionMode] = useState<PermissionMode>('default');
  const [pendingPermissionRequests, setPendingPermissionRequests] = useState<PendingPermissionRequest[]>([]);
  // The provider the composer sends under. Held here rather than read from
  // storage per render because switching it has to reset the model menu, the
  // permission mode and the session in one commit.
  const [preferredProvider, setPreferredProvider] = useState<LLMProvider>(readSelectedProvider);
  const provider: LLMProvider = sshProject ? 'claude' : preferredProvider;
  const setProvider = useCallback((next: LLMProvider) => {
    if (!sshProject || next === 'claude') setPreferredProvider(next);
  }, [sshProject]);
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
  // Explicit defaults the selected project applies to a brand-new session.
  // They are read here rather than copied into the account-level provider
  // model/effort stores, so switching projects cannot leak one project's
  // defaults into another.
  const [projectDefaults, setProjectDefaults] = useState<ProjectDefaultSettings | null>(null);
  // A choice made in the composer for the current unsaved session outranks the
  // project default until that session is created or the project changes.
  const [newSessionModelOverride, setNewSessionModelOverride] = useState<string | null>(null);
  const [newSessionEffortOverride, setNewSessionEffortOverride] = useState<string | null>(null);
  const appliedProjectProviderRef = useRef<string | null>(null);
  // Once the user chooses a permission mode for this new session, a project
  // default that resolves later must not overwrite that choice.
  const permissionModeTouchedRef = useRef(false);

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
  const [providerModelsLoading, setProviderModelsLoading] = useState(true);

  const providerModelsRequestIdRef = useRef(0);
  const sessionSelectionLoadRequestIdRef = useRef(0);
  const liveResolvedModelRef = useRef<{ key: string; model: string } | null>(null);
  const sessionModelMutationIdRef = useRef(0);
  const sessionEffortMutationIdRef = useRef(0);

  const setStoredProviderModel = useCallback((targetProvider: LLMProvider, model: string) => {
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

  const loadProviderModels = useCallback(async () => {
    const requestId = providerModelsRequestIdRef.current + 1;
    providerModelsRequestIdRef.current = requestId;
    setProviderModelsLoading(true);

    try {
      const results = await Promise.all(
        PROVIDERS.map(async (p) => {
          const response = await api.providers.models(p);
          const body = (await response.json()) as ProviderModelsApiResponse;
          if (!body.success || !body.data?.models) {
            return null;
          }

          return body.data.models;
        }),
      );

      if (providerModelsRequestIdRef.current !== requestId) {
        return;
      }

      const nextCatalog: Partial<Record<LLMProvider, ProviderModelsDefinition>> = {};

      PROVIDERS.forEach((p, i) => {
        const entry = results[i];
        if (!entry) {
          return;
        }

        nextCatalog[p] = entry;
      });

      setProviderModelCatalog(nextCatalog);
    } catch (error) {
      console.error('Error loading provider models:', error);
    } finally {
      if (providerModelsRequestIdRef.current === requestId) {
        setProviderModelsLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    void loadProviderModels();
  }, [loadProviderModels]);

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

    // HiRoute chooses its execution model; Claude effort is valid only if its catalog advertises it.
    if (targetProvider === 'claude' && model === 'hiroute') {
      return [];
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
    const projectId = selectedProject?.projectId;
    if (!projectId) {
      setProjectDefaults(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const response = await api.projectSettings(projectId);
        const body = (await response.json()) as {
          data?: { settings?: ProjectDefaultSettings };
        };
        if (!cancelled) {
          setProjectDefaults(response.ok ? body.data?.settings ?? null : null);
        }
      } catch {
        if (!cancelled) {
          setProjectDefaults(null);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedProject?.projectId]);

  useEffect(() => {
    setNewSessionModelOverride(null);
    setNewSessionEffortOverride(null);
  }, [selectedProject?.projectId, selectedSession?.id]);

  useEffect(() => {
    // A new chat starts from the project default again, but the session id
    // appearing after the first send must not discard a mode the user just
    // picked.
    permissionModeTouchedRef.current = false;
  }, [selectedProject?.projectId, selectedSession?.id ? null : 'new']);

  useEffect(() => {
    if (selectedSession?.id || !selectedProject?.projectId || !projectDefaults?.provider) {
      return;
    }
    const targetProvider = projectDefaults.provider as LLMProvider;
    if (!PROVIDERS.includes(targetProvider)) {
      return;
    }
    const applicationKey = `${selectedProject.projectId}:${targetProvider}`;
    if (appliedProjectProviderRef.current === applicationKey) {
      return;
    }
    appliedProjectProviderRef.current = applicationKey;
    setPreferredProvider(targetProvider);
  }, [projectDefaults?.provider, selectedProject?.projectId, selectedSession?.id]);

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
    const projectMode = (projectDefaults?.permissionMode ?? null) as PermissionMode | null;
    // Session choice outranks the project default, which outranks the last
    // choice made for this provider on this account. A manual composer pick
    // suppresses the project default until the project or session changes.
    const savedMode = [sessionSavedMode, permissionModeTouchedRef.current ? null : projectMode, providerSavedMode].find(
      (mode): mode is PermissionMode => Boolean(mode && validModes.includes(mode)),
    );
    setPermissionMode(savedMode ?? getDefaultPermissionModeForProvider(provider));
  }, [
    selectedSession?.id,
    provider,
    projectDefaults?.permissionMode,
    getDefaultPermissionModeForProvider,
    getPermissionModesForProvider,
  ]);

  useEffect(() => {
    if (sshProject || !selectedSession?.__provider || selectedSession.__provider === provider) {
      return;
    }

    setProvider(selectedSession.__provider);
    writeSelectedProvider(selectedSession.__provider);
  }, [provider, selectedSession, sshProject, setProvider]);

  // Permission prompts belong to a session, not to the transient provider
  // selection that is synchronized after navigation.
  useEffect(() => {
    setPendingPermissionRequests((previous) =>
      previous.filter((request) => !request.sessionId || request.sessionId === selectedSession?.id),
    );
  }, [selectedSession?.id]);

  const selectPermissionMode = useCallback((nextMode: PermissionMode) => {
    permissionModeTouchedRef.current = true;
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
        });
      } catch (error) {
        if (
          !cancelled
          && sessionSelectionLoadRequestIdRef.current === requestId
          && selectedSessionKeyRef.current === targetSessionKey
        ) {
          console.error('Error loading the session model and reasoning effort:', error);
          setSessionSelection({
            provider: targetProvider,
            sessionId: selectedSessionId,
            model: null,
            resolvedModel: liveResolvedModelRef.current?.key === targetSessionKey
              ? liveResolvedModelRef.current.model : null,
            effort: null,
          });
        }
      }
    };

    void loadSessionSelection();
    return () => {
      cancelled = true;
    };
  }, [selectedSessionId, selectedSessionProvider]);

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
    }));
  }), [subscribe, selectedSessionId, selectedSessionProvider]);

  /**
   * Applies a model choice.
   *
   * Normal model picks also become the default for new chats. HiRoute picks
   * in an existing session stay scoped to that session; reopening it restores
   * the backend's saved choice without changing other chats.
   */
  const selectProviderModel = useCallback(async (
    targetProvider: LLMProvider,
    model: string,
    sessionId?: string | null,
  ) => {
    const normalizedSessionId = typeof sessionId === 'string' ? sessionId.trim() : '';
    if (!normalizedSessionId) {
      setNewSessionModelOverride(model);
    }
    if (!normalizedSessionId || targetProvider !== 'claude' || model !== 'hiroute') {
      setStoredProviderModel(targetProvider, model);
    }

    if (!normalizedSessionId) {
      return { scope: 'default' as const, model };
    }

    // A pending GET represents the state before this click and must not win
    // if it resolves after the mutation.
    sessionSelectionLoadRequestIdRef.current += 1;
    const mutationId = sessionModelMutationIdRef.current + 1;
    sessionModelMutationIdRef.current = mutationId;
    const targetSessionKey = getSessionSelectionKey(targetProvider, normalizedSessionId);

    const response = await api.providers.setSessionActiveModel(
      targetProvider,
      normalizedSessionId,
      model,
    );

    const body = (await response.json()) as SessionSelectionApiResponse;
    if (!response.ok || !body.success) {
      throw new Error('Unable to change the active model for this session.');
    }

    const storedModel = body.data?.model?.trim() || model;
    if (
      sessionModelMutationIdRef.current === mutationId
      && selectedSessionKeyRef.current === targetSessionKey
    ) {
      setSessionSelection((current) => ({
        provider: targetProvider,
        sessionId: normalizedSessionId,
        model: storedModel,
        resolvedModel: current?.sessionId === normalizedSessionId && current.provider === targetProvider
          ? current.resolvedModel : null,
        effort: current?.provider === targetProvider && current.sessionId === normalizedSessionId
          ? current.effort
          : body.data?.effort?.trim() || null,
      }));
    }
    return { scope: 'session' as const, model: storedModel };
  }, [setStoredProviderModel]);

  /**
   * Applies an effort choice optimistically and persists it for the open
   * session. Mutation counters keep slower earlier requests from overwriting
   * the latest click.
   */
  const selectProviderEffort = useCallback(async (
    targetProvider: LLMProvider,
    effort: string,
    sessionId?: string | null,
  ) => {
    setStoredProviderEffort(targetProvider, effort);

    const normalizedSessionId = typeof sessionId === 'string' ? sessionId.trim() : '';
    if (!normalizedSessionId) {
      setNewSessionEffortOverride(effort);
      return { scope: 'default' as const, effort };
    }

    sessionSelectionLoadRequestIdRef.current += 1;
    const mutationId = sessionEffortMutationIdRef.current + 1;
    sessionEffortMutationIdRef.current = mutationId;
    const targetSessionKey = getSessionSelectionKey(targetProvider, normalizedSessionId);
    const previousSelection = sessionSelection?.provider === targetProvider
      && sessionSelection.sessionId === normalizedSessionId
      ? sessionSelection
      : null;

    setSessionSelection({
      provider: targetProvider,
      sessionId: normalizedSessionId,
      model: previousSelection?.model ?? null,
      resolvedModel: previousSelection?.resolvedModel,
      effort,
    });

    try {
      const response = await api.providers.setSessionActiveEffort(
        targetProvider,
        normalizedSessionId,
        effort,
      );
      const body = (await response.json()) as SessionSelectionApiResponse;
      if (!response.ok || !body.success) {
        throw new Error('Unable to change the reasoning effort for this session.');
      }

      const storedEffort = body.data?.effort?.trim() || effort;
      if (
        sessionEffortMutationIdRef.current === mutationId
        && selectedSessionKeyRef.current === targetSessionKey
      ) {
        setSessionSelection((current) => ({
          provider: targetProvider,
          sessionId: normalizedSessionId,
          model: current?.provider === targetProvider && current.sessionId === normalizedSessionId
            ? current.model
            : previousSelection?.model ?? null,
          resolvedModel: current?.resolvedModel,
          effort: storedEffort,
        }));
      }

      return { scope: 'session' as const, effort: storedEffort };
    } catch (error) {
      if (
        sessionEffortMutationIdRef.current === mutationId
        && selectedSessionKeyRef.current === targetSessionKey
      ) {
        setSessionSelection((current) => (
          current?.provider === targetProvider
          && current.sessionId === normalizedSessionId
          && current.effort === effort
            ? previousSelection
            : current
        ));
      }
      throw error;
    }
  }, [sessionSelection, setStoredProviderEffort]);

  // The open session's model wins over the per-provider default, so switching
  // sessions shows (and sends) what each session actually runs with. A new
  // chat uses a composer override first, then the selected project's default.
  const projectDefaultAppliesToProvider = !projectDefaults?.provider || projectDefaults.provider === provider;
  const newSessionProjectModel = selectedSession
    ? null
    : newSessionModelOverride ?? (projectDefaultAppliesToProvider ? projectDefaults?.model ?? null : null);
  const currentProviderModel = sessionModel ?? newSessionProjectModel ?? providerModels[provider];
  const currentProviderEffortOptions = useMemo(() => {
    return getEffortOptionsForModel(provider, currentProviderModel);
  }, [currentProviderModel, getEffortOptionsForModel, provider]);
  const newSessionProjectEffort = selectedSession
    ? null
    : newSessionEffortOverride ?? (projectDefaultAppliesToProvider ? projectDefaults?.effort ?? null : null);
  const currentProviderEffort = useMemo(() => {
    return reconcileStoredEffort(
      provider,
      currentProviderModel,
      activeSessionSelection?.effort
        ?? newSessionProjectEffort
        ?? providerEfforts[provider]
        ?? DEFAULT_EFFORT_VALUE,
    );
  }, [
    activeSessionSelection?.effort,
    currentProviderModel,
    newSessionProjectEffort,
    provider,
    providerEfforts,
    reconcileStoredEffort,
  ]);
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

    const response = await api.providers.updateModel(targetProvider, existing.recordId, input);
    const result = await readModelMutationResponse(response);
    applyProviderCatalog(targetProvider, result.models);

    if (providerModels[targetProvider] === existing.value) {
      setStoredProviderModel(targetProvider, result.model.value);
    }
    if (provider === targetProvider && sessionModel === existing.value) {
      setSessionSelection((current) => current ? {
        ...current,
        model: result.model.value,
      } : current);
    }
  }, [
    applyProviderCatalog,
    provider,
    providerModels,
    readModelMutationResponse,
    sessionModel,
    setStoredProviderModel,
  ]);

  const removeCustomModel = useCallback(async (
    targetProvider: LLMProvider,
    existing: ProviderModelOption,
  ) => {
    if (!existing.recordId) {
      throw new Error('This model cannot be deleted.');
    }

    const response = await api.providers.deleteModel(targetProvider, existing.recordId);
    const result = await readModelMutationResponse(response);
    applyProviderCatalog(targetProvider, result.models);

    if (providerModels[targetProvider] === existing.value) {
      setStoredProviderModel(targetProvider, result.models.DEFAULT);
    }
    if (provider === targetProvider && sessionModel === existing.value) {
      setSessionSelection((current) => current ? {
        ...current,
        model: result.models.DEFAULT,
      } : current);
    }
  }, [
    applyProviderCatalog,
    provider,
    providerModels,
    readModelMutationResponse,
    sessionModel,
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
    currentResolvedModel: activeSessionSelection?.resolvedModel ?? null,
    currentProviderModelOptions,
    permissionMode,
    pendingPermissionRequests,
    setPendingPermissionRequests,
    availablePermissionModes,
    selectPermissionMode,
    cyclePermissionMode,
    providerModelCatalog: sshProject ? { claude: providerModelCatalog.claude } : providerModelCatalog,
    providerModelsLoading,
    providerModelActions,
    selectProviderModel,
    selectProviderEffort,
    resolvePermissionModeForProvider,
    supportsMessageEditing,
    supportsSessionForking,
  };
}
