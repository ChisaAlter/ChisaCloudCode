import { MessageSquare, Terminal, Folder, GitBranch, ClipboardCheck, MonitorPlay, PanelsTopLeft, type LucideIcon } from 'lucide-react';
import { Fragment } from 'react';
import type { Dispatch, KeyboardEvent, SetStateAction } from 'react';
import { useTranslation } from 'react-i18next';

import { ActionMenu, Tooltip, PillBar, Pill } from '@/shared/ui';
import type { AppTab } from '@/shared/types';
import { usePlugins,PluginIcon } from '@/modules/plugins';
import { GitWorkspaceButton } from '@/modules/git-panel';

type WorkspaceTabsProps = {
  activeTab: AppTab;
  setActiveTab: Dispatch<SetStateAction<AppTab>>;
  shouldShowTasksTab: boolean;
  shouldShowBrowserTab: boolean;
  compact?: boolean;
  projectId?: string;
  serverPath?: string;
};

type BuiltInTab = {
  kind: 'builtin';
  id: AppTab;
  labelKey: string;
  icon: LucideIcon;
};

type PluginTab = {
  kind: 'plugin';
  id: AppTab;
  label: string;
  pluginName: string;
  iconFile: string;
};

type TabDefinition = BuiltInTab | PluginTab;

const BASE_TABS: BuiltInTab[] = [
  { kind: 'builtin', id: 'chat',  labelKey: 'tabs.chat',  icon: MessageSquare },
  { kind: 'builtin', id: 'shell', labelKey: 'tabs.shell', icon: Terminal },
  { kind: 'builtin', id: 'files', labelKey: 'tabs.files', icon: Folder },
  { kind: 'builtin', id: 'git',   labelKey: 'tabs.git',   icon: GitBranch },
];

const BROWSER_TAB: BuiltInTab = {
  kind: 'builtin',
  id: 'browser',
  labelKey: 'tabs.browser',
  icon: MonitorPlay,
};

const TASKS_TAB: BuiltInTab = {
  kind: 'builtin',
  id: 'tasks',
  labelKey: 'tabs.tasks',
  icon: ClipboardCheck,
};

/** Rendered by WorkspaceHeader to show the built-in workspace tabs plus any enabled plugin tabs. */
export default function WorkspaceTabs({
  activeTab,
  setActiveTab,
  shouldShowTasksTab,
  shouldShowBrowserTab,
  compact = false,
  projectId,
  serverPath,
}: WorkspaceTabsProps) {
  const { t } = useTranslation();
  const { plugins } = usePlugins();

  const builtInTabs: BuiltInTab[] = [
    ...BASE_TABS,
    ...(shouldShowBrowserTab ? [BROWSER_TAB] : []),
    ...(shouldShowTasksTab ? [TASKS_TAB] : []),
  ];

  const pluginTabs: PluginTab[] = plugins
    .filter((p) => p.enabled && p.name !== 'claude-usage')
    .map((p) => ({
      kind: 'plugin',
      id: `plugin:${p.name}` as AppTab,
      label: p.displayName,
      pluginName: p.name,
      iconFile: p.icon,
    }));

  const tabs: TabDefinition[] = [...builtInTabs, ...pluginTabs];

  const handleTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    const tabList = event.currentTarget.closest('[role="tablist"]');
    if (!tabList) return;

    const tabButtons = Array.from(tabList.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
    const currentIndex = tabButtons.indexOf(event.currentTarget);
    let nextIndex: number;

    if (event.key === 'ArrowRight') nextIndex = (currentIndex + 1) % tabButtons.length;
    else if (event.key === 'ArrowLeft') nextIndex = (currentIndex - 1 + tabButtons.length) % tabButtons.length;
    else if (event.key === 'Home') nextIndex = 0;
    else if (event.key === 'End') nextIndex = tabButtons.length - 1;
    else return;

    event.preventDefault();
    tabButtons[nextIndex]?.focus();
    tabButtons[nextIndex]?.click();
  };

  if (compact) {
    const toolTabs = tabs.filter((tab) => tab.id !== 'chat' && tab.id !== 'git');
    const activeTool = toolTabs.find((tab) => tab.id === activeTab);
    const labelFor = (tab: TabDefinition) => tab.kind === 'builtin' ? t(tab.labelKey) : tab.label;

    return (
      <div className="workspace-tools flex shrink-0 items-center gap-1">
        <button
          type="button"
          aria-pressed={activeTab === 'chat'}
          onClick={() => setActiveTab('chat')}
          className="workspace-view-button"
        >
          <MessageSquare className="h-3.5 w-3.5" />
          <span>{t('tabs.chat')}</span>
        </button>
        <GitWorkspaceButton projectId={projectId} serverPath={serverPath} active={activeTab === 'git'} onClick={() => setActiveTab('git')} />
        <ActionMenu
          label={activeTool ? labelFor(activeTool) : t('tabs.tools', { defaultValue: 'Tools' })}
          icon={activeTool?.kind === 'builtin' ? activeTool.icon : PanelsTopLeft}
          variant="ghost"
          portal
          triggerClassName={`workspace-view-button ${activeTool ? 'is-active' : ''}`}
          items={toolTabs.map((tab) => ({
            key: tab.id,
            label: labelFor(tab),
            icon: tab.kind === 'builtin' ? tab.icon : undefined,
            leading: tab.kind === 'plugin' ? (
              <PluginIcon pluginName={tab.pluginName} iconFile={tab.iconFile} className="h-4 w-4" />
            ) : undefined,
            onSelect: () => setActiveTab(tab.id),
          }))}
        />
      </div>
    );
  }

  return (
    <PillBar
      role="tablist"
      aria-label={t('tabs.views', { defaultValue: 'Workspace views' })}
      className="workspace-tabs min-w-max border-0 bg-transparent shadow-none"
    >
      {tabs.map((tab, index) => {
        const isActive = tab.id === activeTab;
        const displayLabel = tab.kind === 'builtin' ? t(tab.labelKey) : tab.label;

        return (
          <Fragment key={`${tab.id}-${index}`}>
            {index === builtInTabs.length && pluginTabs.length > 0 && (
              <span aria-hidden="true" className="mx-1 h-4 w-px shrink-0 bg-border" />
            )}
            <Tooltip content={displayLabel} position="bottom">
              <Pill
                role="tab"
                aria-label={displayLabel}
                aria-selected={isActive}
                tabIndex={isActive ? 0 : -1}
                isActive={isActive}
                onClick={() => setActiveTab(tab.id)}
                onKeyDown={handleTabKeyDown}
                className="h-8 max-w-44 px-2.5 py-[5px]"
              >
                {tab.kind === 'builtin' ? (
                  <tab.icon className="h-3.5 w-3.5 shrink-0" strokeWidth={isActive ? 2.2 : 1.8} />
                ) : (
                  <PluginIcon
                    pluginName={tab.pluginName}
                    iconFile={tab.iconFile}
                    className="flex h-3.5 w-3.5 shrink-0 items-center justify-center [&>svg]:h-full [&>svg]:w-full"
                  />
                )}
                <span className={`${isActive ? 'inline max-w-28' : 'hidden'} truncate sm:max-w-36 lg:inline`}>
                  {displayLabel}
                </span>
              </Pill>
            </Tooltip>
          </Fragment>
        );
      })}
    </PillBar>
  );
}
