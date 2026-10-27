import { useProjectSettings } from '@/modules/project-settings/hooks/useProjectSettings';

const PERMISSION_LABELS: Record<string, string> = {
  default: '逐项确认',
  acceptEdits: '自动接受编辑',
  auto: '自动判断',
  bypassPermissions: '完全放行',
  plan: '计划模式',
};

type ProjectDefaultsSummaryProps = {
  projectId: string | null | undefined;
  provider: string;
  model: string;
};

/**
 * Rendered by the new-chat empty state to show which project defaults the
 * first turn will actually use. It stays silent when the project has
 * no explicit overrides, because then there is nothing project-specific to
 * report beyond the composer's own controls.
 */
export default function ProjectDefaultsSummary({ projectId, provider, model }: ProjectDefaultsSummaryProps) {
  const { view } = useProjectSettings(projectId);
  if (!view) {
    return null;
  }

  const settings = view.settings;
  const hasExplicitDefault = Boolean(
    settings.provider || settings.model || settings.effort || settings.permissionMode || settings.workspaceMode,
  );
  if (!hasExplicitDefault) {
    return null;
  }

  const effectiveProvider = settings.provider || provider;
  const effectiveModel = settings.model || model || '账号默认模型';
  const effectivePermission = settings.permissionMode
    ? PERMISSION_LABELS[settings.permissionMode] ?? settings.permissionMode
    : '输入栏当前权限';
  const effectiveWorkspace = view.sourceMode === 'ssh'
    ? '共享 Windows 目录'
    : settings.workspaceMode === 'isolated'
      ? '隔离会话工作区'
      : settings.workspaceMode === 'shared'
        ? '共享项目工作区'
        : '账号默认执行方式';

  return (
    <div className="mx-auto mb-3 flex max-w-[34.25rem] flex-wrap items-center justify-center gap-x-2 gap-y-1 rounded-lg border border-border/60 bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
      <span className="font-medium text-foreground/80">新会话默认</span>
      <span>{effectiveProvider}</span>
      <span aria-hidden>·</span>
      <span className="max-w-64 truncate" title={effectiveModel}>{effectiveModel}</span>
      <span aria-hidden>·</span>
      <span>{effectivePermission}</span>
      <span aria-hidden>·</span>
      <span>{effectiveWorkspace}</span>
      {(settings.model || settings.permissionMode || settings.workspaceMode) && (
        <span className="w-full text-center text-[11px] text-muted-foreground/80">来自项目默认设置，可在项目标题旁修改</span>
      )}
    </div>
  );
}
