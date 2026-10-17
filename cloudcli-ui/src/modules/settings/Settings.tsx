import { useEffect, useMemo, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { ProviderLoginModal } from '@/modules/provider-auth';
import { Button } from '@/shared/ui';
import SettingsSidebar from '@/modules/settings/SettingsSidebar';
import AgentsSettingsTab from '@/modules/settings/tabs/agents-settings/AgentsSettingsTab';
import AppearanceSettingsTab from '@/modules/settings/tabs/AppearanceSettingsTab';
import CredentialsSettingsTab from '@/modules/settings/tabs/api-settings/CredentialsSettingsTab';
import VoiceSettingsTab from '@/modules/settings/tabs/VoiceSettingsTab';
import GitSettingsTab from '@/modules/settings/tabs/git-settings/GitSettingsTab';
import BrowserUseSettingsTab from '@/modules/settings/tabs/browser-use-settings/BrowserUseSettingsTab';
import NotificationsSettingsTab from '@/modules/settings/tabs/NotificationsSettingsTab';
import TasksSettingsTab from '@/modules/settings/tabs/tasks-settings/TasksSettingsTab';
import { PluginSettingsTab } from '@/modules/plugins';
import AboutTab from '@/modules/settings/tabs/AboutTab';
import ChisaSettingsTab from '@/modules/settings/tabs/chisa-settings/ChisaSettingsTab';
import { useSettingsController } from '@/modules/settings/hooks/useSettingsController';
import { useWebPush } from '@/modules/settings/hooks/useWebPush';
import type { AgentSettingsProject } from '@/shared/types';

type SettingsProps = {
  isOpen: boolean;
  onClose: () => void;
  projects?: AgentSettingsProject[];
  initialTab?: string;
};

type DesktopNotificationsState = {
  enabled: boolean;
  supported: boolean;
  connectedCount?: number;
  targetCount?: number;
  lastError?: string | null;
};

/** Exported as the settings module's public entry point and rendered by the sidebar module as its settings dialog. */
function Settings({ isOpen, onClose, projects = [], initialTab = 'agents' }: SettingsProps) {
  const { t } = useTranslation('settings');
  const dialogRef = useRef<HTMLDivElement>(null);
  const desktopNotificationsBridge = useMemo(() => (
    typeof window === 'undefined'
      ? null
      : ((window as any).cloudcliDesktopNotifications || null)
  ), []);
  const [desktopNotificationsState, setDesktopNotificationsState] = useState<DesktopNotificationsState | null>(null);
  const {
    activeTab,
    setActiveTab,
    saveStatus,
    projectSortOrder,
    setProjectSortOrder,
    codeEditorSettings,
    updateCodeEditorSetting,
    claudePermissions,
    setClaudePermissions,
    notificationPreferences,
    setNotificationPreferences,
    cursorPermissions,
    setCursorPermissions,
    codexPermissionMode,
    setCodexPermissionMode,
    providerAuthStatus,
    openLoginForProvider,
    showLoginModal,
    setShowLoginModal,
    loginProvider,
    handleLoginComplete,
  } = useSettingsController({
    isOpen,
    initialTab
  });

  const {
    permission: pushPermission,
    isSubscribed: isPushSubscribed,
    isLoading: isPushLoading,
    subscribe: pushSubscribe,
    unsubscribe: pushUnsubscribe,
  } = useWebPush();

  const handleEnablePush = async () => {
    await pushSubscribe();
    // Server sets webPush: true in preferences on subscribe; sync local state
    setNotificationPreferences({
      ...notificationPreferences,
      channels: { ...notificationPreferences.channels, webPush: true },
    });
  };

  const handleDisablePush = async () => {
    await pushUnsubscribe();
    // Server sets webPush: false in preferences on unsubscribe; sync local state
    setNotificationPreferences({
      ...notificationPreferences,
      channels: { ...notificationPreferences.channels, webPush: false },
    });
  };

  useEffect(() => {
    if (!desktopNotificationsBridge) return undefined;
    let mounted = true;
    desktopNotificationsBridge.getState().then((state: any) => {
      if (mounted) {
        setDesktopNotificationsState(state?.desktopNotifications || null);
      }
    }).catch(() => {});
    const unsubscribe = desktopNotificationsBridge.onStateUpdated?.((state: any) => {
      if (mounted) {
        setDesktopNotificationsState(state?.desktopNotifications || null);
      }
    });
    return () => {
      mounted = false;
      unsubscribe?.();
    };
  }, [desktopNotificationsBridge]);

  const handleEnableDesktopNotifications = async () => {
    if (!desktopNotificationsBridge) return;
    const state = await desktopNotificationsBridge.update({ enabled: true });
    setDesktopNotificationsState(state?.desktopNotifications || null);
    setNotificationPreferences({
      ...notificationPreferences,
      channels: { ...notificationPreferences.channels, desktop: true },
    });
  };

  const handleDisableDesktopNotifications = async () => {
    if (!desktopNotificationsBridge) return;
    const state = await desktopNotificationsBridge.update({ enabled: false });
    setDesktopNotificationsState(state?.desktopNotifications || null);
    setNotificationPreferences({
      ...notificationPreferences,
      channels: { ...notificationPreferences.channels, desktop: false },
    });
  };

  useEffect(() => {
    if (!isOpen) return;
    // The menu trigger hands keyboard focus to this standalone settings panel.
    const previousFocus = document.activeElement as HTMLElement | null;
    const focusFrame = requestAnimationFrame(() => dialogRef.current?.querySelector<HTMLElement>('button, input, select, textarea, [tabindex="0"]')?.focus());
    return () => { cancelAnimationFrame(focusFrame); previousFocus?.focus(); };
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      // Keep an open provider login dialog in place instead of closing its settings parent.
      if (event.key === 'Escape' && !showLoginModal) onClose();
    };
    document.addEventListener('keydown', closeOnEscape);
    return () => document.removeEventListener('keydown', closeOnEscape);
  }, [isOpen, onClose, showLoginModal]);

  if (!isOpen) {
    return null;
  }

  const isAuthenticated = Boolean(loginProvider && providerAuthStatus[loginProvider].authenticated);

  return (
    <div className="modal-backdrop fixed inset-0 z-[9999] flex items-center justify-center bg-background/80 backdrop-blur-sm md:p-4" onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-label={t('title')} className="flex h-full w-full flex-col overflow-hidden border border-border bg-background shadow-2xl md:h-[90vh] md:max-w-4xl md:rounded-xl" onKeyDown={(event) => {
        if (event.key !== 'Tab' || showLoginModal) return;
        const controls = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex="0"]') ?? []);
        const first = controls[0];
        const last = controls[controls.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }}>
        {/* Header */}
        <div className="flex flex-shrink-0 items-center justify-between border-b border-border px-4 py-3 md:px-5">
          <h2 className="text-base font-semibold text-foreground">{t('title')}</h2>
          <div className="flex items-center gap-2">
            {saveStatus === 'success' && (
              <span className="animate-in fade-in text-xs text-muted-foreground">{t('saveStatus.success')}</span>
            )}
            <Button
              variant="ghost"
              size="sm"
              onClick={onClose}
              aria-label={t('close', { defaultValue: '关闭设置' })}
              className="h-10 w-10 touch-manipulation p-0 text-muted-foreground hover:text-foreground active:bg-accent/50"
            >
              <X className="h-5 w-5" />
            </Button>
          </div>
        </div>

        {/* Body: sidebar + content */}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col md:flex-row">
          <SettingsSidebar activeTab={activeTab} onChange={setActiveTab} />

          {/* Content */}
          <main className="min-w-0 flex-1 overflow-y-auto overflow-x-hidden">
            <div key={activeTab} className="settings-content-enter min-w-0 space-y-6 overflow-x-hidden p-4 pb-safe-area-inset-bottom md:space-y-8 md:p-6">
              {activeTab === 'appearance' && (
                <AppearanceSettingsTab
                  projectSortOrder={projectSortOrder}
                  onProjectSortOrderChange={setProjectSortOrder}
                  codeEditorSettings={codeEditorSettings}
                  onCodeEditorWordWrapChange={(value) => updateCodeEditorSetting('wordWrap', value)}
                  onCodeEditorShowMinimapChange={(value) => updateCodeEditorSetting('showMinimap', value)}
                  onCodeEditorLineNumbersChange={(value) => updateCodeEditorSetting('lineNumbers', value)}
                  onCodeEditorFontSizeChange={(value) => updateCodeEditorSetting('fontSize', value)}
                />
              )}

              {activeTab === 'git' && <GitSettingsTab />}

              {activeTab === 'agents' && (
                <AgentsSettingsTab
                  providerAuthStatus={providerAuthStatus}
                  onProviderLogin={openLoginForProvider}
                  claudePermissions={claudePermissions}
                  onClaudePermissionsChange={setClaudePermissions}
                  cursorPermissions={cursorPermissions}
                  onCursorPermissionsChange={setCursorPermissions}
                  codexPermissionMode={codexPermissionMode}
                  onCodexPermissionModeChange={setCodexPermissionMode}
                  projects={projects}
                />
              )}

              {activeTab === 'tasks' && <TasksSettingsTab />}

              {activeTab === 'browser' && <BrowserUseSettingsTab />}

              {activeTab === 'notifications' && (
                <NotificationsSettingsTab
                  notificationPreferences={notificationPreferences}
                  onNotificationPreferencesChange={setNotificationPreferences}
                  pushPermission={pushPermission}
                  isPushSubscribed={isPushSubscribed}
                  isPushLoading={isPushLoading}
                  onEnablePush={handleEnablePush}
                  onDisablePush={handleDisablePush}
                  isDesktop={Boolean(desktopNotificationsBridge)}
                  desktopNotifications={desktopNotificationsState}
                  onEnableDesktopNotifications={handleEnableDesktopNotifications}
                  onDisableDesktopNotifications={handleDisableDesktopNotifications}
                />
              )}

              {activeTab === 'chisa' && <ChisaSettingsTab />}

              {activeTab === 'api' && <CredentialsSettingsTab />}

              {activeTab === 'voice' && <VoiceSettingsTab />}

              {activeTab === 'plugins' && <PluginSettingsTab />}

              {activeTab === 'about' && <AboutTab />}
            </div>
          </main>
        </div>
      </div>

      <ProviderLoginModal
        key={loginProvider || 'claude'}
        isOpen={showLoginModal}
        onClose={() => setShowLoginModal(false)}
        provider={loginProvider || 'claude'}
        onComplete={handleLoginComplete}
        isAuthenticated={isAuthenticated}
      />

    </div>
  );
}

export default Settings;
