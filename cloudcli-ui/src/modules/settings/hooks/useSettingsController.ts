import { useCallback, useEffect, useRef, useState } from 'react';

import { useTheme } from '@/shared/context/ThemeContext';
import { api } from '@/shared/api';
import { getAuthSessionSnapshot, isCurrentAuthSession } from '@/shared/authToken';
import { setNotificationSoundEnabled } from '@/shared/utils';
import {
  readCodeEditorSettings,
  writeCodeEditorSettings,
} from '@/shared/codeEditorSettings';
import {
  readUserPreference,
  writeUserPreferences,
} from '@/shared/userSettings';
import { useProviderAuthStatus } from '@/modules/provider-auth';
import type { AgentProvider, ClaudePermissionsState, CodeEditorSettingsState, CodexPermissionMode, CursorPermissionsState, NotificationPreferencesState, ProjectSortOrder, SettingsMainTab } from '@/shared/types';

const DEFAULT_CURSOR_PERMISSIONS: CursorPermissionsState = {
  allowedCommands: [],
  disallowedCommands: [],
  skipPermissions: false,
};

type ThemeContextValue = {
  isDarkMode: boolean;
  toggleDarkMode: () => void;
};

type UseSettingsControllerArgs = {
  isOpen: boolean;
  initialTab: string;
};

type ClaudeSettingsStorage = {
  allowedTools?: string[];
  disallowedTools?: string[];
  skipPermissions?: boolean;
  projectSortOrder?: ProjectSortOrder;
};

type CursorSettingsStorage = {
  allowedCommands?: string[];
  disallowedCommands?: string[];
  skipPermissions?: boolean;
};

type CodexSettingsStorage = {
  permissionMode?: CodexPermissionMode;
};

type NotificationPreferencesResponse = {
  success?: boolean;
  preferences?: NotificationPreferencesState;
};

type ActiveLoginProvider = AgentProvider | '';

const KNOWN_MAIN_TABS: SettingsMainTab[] = ['agents', 'models', 'appearance', 'git', 'api', 'voice', 'tasks', 'browser', 'notifications', 'plugins', 'chisa', 'about'];

const normalizeMainTab = (tab: string): SettingsMainTab => {
  // Keep backwards compatibility with older callers that still pass "tools".
  if (tab === 'tools') {
    return 'agents';
  }

  return KNOWN_MAIN_TABS.includes(tab as SettingsMainTab) ? (tab as SettingsMainTab) : 'agents';
};

const toCodexPermissionMode = (value: unknown): CodexPermissionMode => {
  if (value === 'acceptEdits' || value === 'bypassPermissions') {
    return value;
  }

  return 'default';
};

const toResponseJson = async <T>(response: Response): Promise<T> => response.json() as Promise<T>;

const createEmptyClaudePermissions = (): ClaudePermissionsState => ({
  allowedTools: [],
  disallowedTools: [],
  skipPermissions: false,
});

const createEmptyCursorPermissions = (): CursorPermissionsState => ({
  ...DEFAULT_CURSOR_PERMISSIONS,
});

const createDefaultNotificationPreferences = (): NotificationPreferencesState => ({
  channels: {
    inApp: true,
    webPush: false,
    desktop: false,
    sound: true,
  },
  events: {
    actionRequired: true,
    stop: true,
    error: true,
  },
});

const normalizeNotificationPreferences = (
  preferences?: Partial<NotificationPreferencesState> | null,
): NotificationPreferencesState => {
  const defaults = createDefaultNotificationPreferences();

  return {
    channels: {
      inApp: preferences?.channels?.inApp ?? defaults.channels.inApp,
      webPush: preferences?.channels?.webPush ?? defaults.channels.webPush,
      desktop: preferences?.channels?.desktop ?? defaults.channels.desktop,
      sound: preferences?.channels?.sound ?? defaults.channels.sound,
    },
    events: {
      actionRequired: preferences?.events?.actionRequired ?? defaults.events.actionRequired,
      stop: preferences?.events?.stop ?? defaults.events.stop,
      error: preferences?.events?.error ?? defaults.events.error,
    },
  };
};

export function useSettingsController({ isOpen, initialTab }: UseSettingsControllerArgs) {
  const { isDarkMode, toggleDarkMode } = useTheme() as ThemeContextValue;
  const closeTimerRef = useRef<number | null>(null);

  const [activeTab, setActiveTab] = useState<SettingsMainTab>(() => normalizeMainTab(initialTab));
  // Notification writes use a separate endpoint and cannot borrow the preference outbox's success.
  const [saveStatus, setSaveStatus] = useState<'saving' | 'success' | 'error' | null>(null);
  // Only explicit control edits advance this counter; loading a stored object must never schedule a save.
  const [editRevision, setEditRevision] = useState(0);
  const dirtyPreferenceKeys = useRef(new Set<'claudePermissions' | 'cursorPermissions' | 'codexPermissions' | 'projectSortOrder'>());
  // Notification writes have their own revision and serialized request lane, so an old ACK cannot confirm a newer edit.
  const notificationsDirty = useRef(false);
  const notificationRevision = useRef(0);
  const notificationLoadRevision = useRef(0);
  const notificationFlight = useRef<Promise<void> | null>(null);
  const mounted = useRef(true);
  // A still-mounted dialog cannot adopt another login's identity during a delayed save or control callback.
  const accountSession = useRef(getAuthSessionSnapshot());
  const [projectSortOrder, setProjectSortOrderState] = useState<ProjectSortOrder>('name');
  const [codeEditorSettings, setCodeEditorSettings] = useState<CodeEditorSettingsState>(() => (
    readCodeEditorSettings()
  ));

  const [claudePermissions, setClaudePermissionsState] = useState<ClaudePermissionsState>(() => (
    createEmptyClaudePermissions()
  ));
  const [cursorPermissions, setCursorPermissionsState] = useState<CursorPermissionsState>(() => (
    createEmptyCursorPermissions()
  ));
  const [notificationPreferences, setNotificationPreferencesState] = useState<NotificationPreferencesState>(() => (
    createDefaultNotificationPreferences()
  ));
  // This synchronous mirror captures successive edits even before React commits their render.
  const latestNotificationPreferences = useRef(notificationPreferences);
  const [codexPermissionMode, setCodexPermissionModeState] = useState<CodexPermissionMode>('default');

  const [showLoginModal, setShowLoginModal] = useState(false);
  const [loginProvider, setLoginProvider] = useState<ActiveLoginProvider>('');
  const {
    providerAuthStatus,
    checkProviderAuthStatus,
    refreshProviderAuthStatuses,
  } = useProviderAuthStatus();

  const markPreferenceEdit = useCallback((key: 'claudePermissions' | 'cursorPermissions' | 'codexPermissions' | 'projectSortOrder') => {
    if (!isCurrentAuthSession(accountSession.current)) return;
    dirtyPreferenceKeys.current.add(key);
    setEditRevision(value => value + 1);
  }, []);
  const setProjectSortOrder = useCallback((value: ProjectSortOrder | ((previous: ProjectSortOrder) => ProjectSortOrder)) => {
    setProjectSortOrderState(value); markPreferenceEdit('projectSortOrder');
  }, [markPreferenceEdit]);
  const setClaudePermissions = useCallback((value: ClaudePermissionsState | ((previous: ClaudePermissionsState) => ClaudePermissionsState)) => {
    setClaudePermissionsState(value); markPreferenceEdit('claudePermissions');
  }, [markPreferenceEdit]);
  const setCursorPermissions = useCallback((value: CursorPermissionsState | ((previous: CursorPermissionsState) => CursorPermissionsState)) => {
    setCursorPermissionsState(value); markPreferenceEdit('cursorPermissions');
  }, [markPreferenceEdit]);
  const setCodexPermissionMode = useCallback((value: CodexPermissionMode | ((previous: CodexPermissionMode) => CodexPermissionMode)) => {
    setCodexPermissionModeState(value); markPreferenceEdit('codexPermissions');
  }, [markPreferenceEdit]);
  const setNotificationPreferences = useCallback((value: NotificationPreferencesState | ((previous: NotificationPreferencesState) => NotificationPreferencesState)) => {
    if (!mounted.current || !isCurrentAuthSession(accountSession.current)) return;
    const next = typeof value === 'function' ? value(latestNotificationPreferences.current) : value;
    latestNotificationPreferences.current = next;
    notificationRevision.current++;
    notificationsDirty.current = true;
    setNotificationPreferencesState(next);
    setSaveStatus('saving');
    setEditRevision(revision => revision + 1);
  }, []);

  const loadSettings = useCallback(async () => {
    const expected = accountSession.current;
    if (!isCurrentAuthSession(expected)) return;
    const loadRevision = ++notificationLoadRevision.current;
    const editAtLoad = notificationRevision.current;
    const mayPublishNotifications = () => mounted.current && isCurrentAuthSession(expected)
      && notificationLoadRevision.current === loadRevision && notificationRevision.current === editAtLoad
      && !notificationsDirty.current && !notificationFlight.current;
    const publishNotifications = (value: NotificationPreferencesState) => {
      if (!mayPublishNotifications()) return;
      latestNotificationPreferences.current = value;
      setNotificationPreferencesState(value);
    };
    try {
      const savedClaudeSettings = readUserPreference<ClaudeSettingsStorage>('claudePermissions', {});
      setClaudePermissionsState({
        allowedTools: savedClaudeSettings.allowedTools || [],
        disallowedTools: savedClaudeSettings.disallowedTools || [],
        skipPermissions: Boolean(savedClaudeSettings.skipPermissions),
      });
      setProjectSortOrderState(readUserPreference<ProjectSortOrder>('projectSortOrder', 'name') === 'date' ? 'date' : 'name');

      const savedCursorSettings = readUserPreference<CursorSettingsStorage>('cursorPermissions', {});
      setCursorPermissionsState({
        allowedCommands: savedCursorSettings.allowedCommands || [],
        disallowedCommands: savedCursorSettings.disallowedCommands || [],
        skipPermissions: Boolean(savedCursorSettings.skipPermissions),
      });

      const savedCodexSettings = readUserPreference<CodexSettingsStorage>('codexPermissions', {});
      setCodexPermissionModeState(toCodexPermissionMode(savedCodexSettings.permissionMode));

      try {
        const notificationResponse = await api.settings.notificationPreferences({ expectedSession: expected });
        if (!mayPublishNotifications()) { await notificationResponse.body?.cancel().catch(() => {}); return; }
        if (notificationResponse.ok) {
          const notificationData = await toResponseJson<NotificationPreferencesResponse>(notificationResponse);
          publishNotifications(notificationData.success && notificationData.preferences
            ? normalizeNotificationPreferences(notificationData.preferences) : createDefaultNotificationPreferences());
        } else {
          publishNotifications(createDefaultNotificationPreferences());
        }
      } catch {
        publishNotifications(createDefaultNotificationPreferences());
      }

    } catch (error) {
      if (!mounted.current || !isCurrentAuthSession(expected)) return;
      console.error('Error loading settings:', error);
      setClaudePermissionsState(createEmptyClaudePermissions());
      setCursorPermissionsState(createEmptyCursorPermissions());
      publishNotifications(createDefaultNotificationPreferences());
      setCodexPermissionModeState('default');
      setProjectSortOrderState('name');
    }
  }, []);

  const openLoginForProvider = useCallback((provider: AgentProvider) => {
    setLoginProvider(provider);
    setShowLoginModal(true);
  }, []);

  const handleLoginComplete = useCallback((exitCode: number) => {
    if (!loginProvider) {
      return;
    }

    void (async () => {
      await checkProviderAuthStatus(loginProvider);
      if (!mounted.current || !isCurrentAuthSession(accountSession.current)) return;
      if (exitCode !== 0) {
        console.warn(`Login process exited with code ${exitCode}; provider authentication was refreshed.`);
      }
      // Provider authentication has its own visible state and cannot acknowledge notification preference writes.
    })();
  }, [checkProviderAuthStatus, loginProvider]);

  const flushNotifications = useCallback((): Promise<void> => {
    if (notificationFlight.current) return notificationFlight.current;
    if (!notificationsDirty.current || !mounted.current || !isCurrentAuthSession(accountSession.current)) return Promise.resolve();
    const expected = accountSession.current;
    const operation = (async () => {
      setSaveStatus('saving');
      while (notificationsDirty.current && mounted.current && isCurrentAuthSession(expected)) {
        const revision = notificationRevision.current;
        const value = latestNotificationPreferences.current;
        try {
          const response = await api.settings.saveNotificationPreferences(value, {
            expectedSession: expected, signal: AbortSignal.timeout(15000),
          });
          if (!mounted.current || !isCurrentAuthSession(expected)) { await response.body?.cancel().catch(() => {}); return; }
          if (!response.ok) throw new Error('Failed to save notification preferences');
          const payload = await toResponseJson<NotificationPreferencesResponse>(response);
          if (!mounted.current || !isCurrentAuthSession(expected)) return;
          if (payload.success !== true) throw new Error('Notification preferences were not acknowledged');
          if (revision === notificationRevision.current) notificationsDirty.current = false;
          // A newer edit is dispatched only after its predecessor settles, never in a competing PUT.
        } catch (error) {
          if (!mounted.current || !isCurrentAuthSession(expected)) return;
          if (revision !== notificationRevision.current) continue;
          console.error('Error saving notification preferences:', error);
          setSaveStatus('error');
          return;
        }
      }
      if (mounted.current && isCurrentAuthSession(expected) && !notificationsDirty.current) setSaveStatus('success');
    })();
    notificationFlight.current = operation;
    void operation.finally(() => { if (notificationFlight.current === operation) notificationFlight.current = null; });
    return operation;
  }, []);

  const saveSettings = useCallback(async () => {
    if (!mounted.current || !isCurrentAuthSession(accountSession.current)) return;
    try {
      // One call so the whole dialog's state reaches the server as a single
      // merge-patch rather than four racing requests.
      const values = {
        claudePermissions: {
          allowedTools: claudePermissions.allowedTools,
          disallowedTools: claudePermissions.disallowedTools,
          skipPermissions: claudePermissions.skipPermissions,
        },
        projectSortOrder,
        cursorPermissions: {
          allowedCommands: cursorPermissions.allowedCommands,
          disallowedCommands: cursorPermissions.disallowedCommands,
          skipPermissions: cursorPermissions.skipPermissions,
        },
        codexPermissions: {
          permissionMode: codexPermissionMode,
        },
      };
      const edited = [...dirtyPreferenceKeys.current];
      if (edited.length) {
        writeUserPreferences(Object.fromEntries(edited.map(key => [key, values[key]])));
        for (const key of edited) dirtyPreferenceKeys.current.delete(key);
      }

      await flushNotifications();
    } catch (error) {
      console.error('Error saving settings:', error);
      setSaveStatus('error');
    }
  }, [
    claudePermissions.allowedTools,
    claudePermissions.disallowedTools,
    claudePermissions.skipPermissions,
    codexPermissionMode,
    cursorPermissions.allowedCommands,
    cursorPermissions.disallowedCommands,
    cursorPermissions.skipPermissions,
    flushNotifications,
    projectSortOrder,
  ]);

  // Persist on the user's edit rather than in an effect keyed on the settings
  // object. The effect form also ran on mount, so merely opening this dialog
  // rewrote all four keys — which reset the editor's font size for anyone who
  // had never changed it.
  //
  // The other three keys are merged from storage rather than from the rendered
  // state, so two edits landing in one React batch cannot write the second one
  // on top of a pre-first-edit snapshot. Storage is the newest value because
  // this is the only writer that can be behind — the editor's own wordWrap
  // mirror in useCodeEditorSettings only ever writes back what it just read.
  const updateCodeEditorSetting = useCallback(
    <K extends keyof CodeEditorSettingsState>(key: K, value: CodeEditorSettingsState[K]) => {
      if (!isCurrentAuthSession(accountSession.current)) return;
      const next = { ...readCodeEditorSettings(), [key]: value };
      setCodeEditorSettings(next);
      writeCodeEditorSettings(next);
    },
    [],
  );

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    setActiveTab(normalizeMainTab(initialTab));
    void loadSettings();
    void refreshProviderAuthStatuses();
  }, [initialTab, isOpen, loadSettings, refreshProviderAuthStatuses]);

  useEffect(() => {
    setNotificationSoundEnabled(notificationPreferences.channels.sound);
  }, [notificationPreferences.channels.sound]);

  // Auto-save permissions and sort order with debounce
  const autoSaveTimerRef = useRef<number | null>(null);

  useEffect(() => {
    if (dirtyPreferenceKeys.current.size === 0 && !notificationsDirty.current) return;

    if (autoSaveTimerRef.current !== null) {
      window.clearTimeout(autoSaveTimerRef.current);
    }

    autoSaveTimerRef.current = window.setTimeout(() => {
      saveSettings();
    }, 500);

    return () => {
      if (autoSaveTimerRef.current !== null) {
        window.clearTimeout(autoSaveTimerRef.current);
      }
    };
  }, [saveSettings, editRevision]);

  // Clear save status after 2 seconds
  useEffect(() => {
    if (saveStatus !== 'success') {
      return;
    }

    const timer = window.setTimeout(() => setSaveStatus(null), 2000);
    return () => window.clearTimeout(timer);
  }, [saveStatus]);

  useEffect(() => {
    mounted.current = true;
    const loadRevision = notificationLoadRevision;
    return () => {
      mounted.current = false;
      loadRevision.current++;
      if (closeTimerRef.current !== null) {
        window.clearTimeout(closeTimerRef.current);
        closeTimerRef.current = null;
      }
      if (autoSaveTimerRef.current !== null) {
        window.clearTimeout(autoSaveTimerRef.current);
        autoSaveTimerRef.current = null;
      }
    };
  }, []);

  return {
    activeTab,
    setActiveTab,
    isDarkMode,
    toggleDarkMode,
    saveStatus,
    projectSortOrder,
    setProjectSortOrder,
    codeEditorSettings,
    updateCodeEditorSetting,
    claudePermissions,
    setClaudePermissions,
    cursorPermissions,
    setCursorPermissions,
    notificationPreferences,
    setNotificationPreferences,
    codexPermissionMode,
    setCodexPermissionMode,
    retrySettings: saveSettings,
    providerAuthStatus,
    openLoginForProvider,
    showLoginModal,
    setShowLoginModal,
    loginProvider,
    handleLoginComplete,
  };
}
