import { useEffect, useRef, useState } from 'react';

import { api } from '@/shared/api';
import { Button, Dialog, DialogContent, DialogTitle, Input } from '@/shared/ui';
import type { ProjectSettingsView, ProjectSourceMode } from '@/shared/types';
import { useProjectSettings } from '@/modules/project-settings/hooks/useProjectSettings';
import ProjectContextPanel from '@/modules/project-settings/ProjectContextPanel';
import ProjectActionsPanel from '@/modules/project-settings/ProjectActionsPanel';
import ProjectMemoryPanel from '@/modules/project-settings/ProjectMemoryPanel';

type ProjectSettingsDialogProps = {
  projectId: string;
  projectName: string;
  sourceMode?: ProjectSourceMode;
  open: boolean;
  onClose: () => void;
};

type FormState = {
  provider: string;
  model: string;
  effort: string;
  permissionMode: string;
  workspaceMode: string;
};

const EMPTY_FORM: FormState = {
  provider: '',
  model: '',
  effort: '',
  permissionMode: '',
  workspaceMode: '',
};

const PROVIDERS = [
  { value: 'claude', label: 'Claude' },
  { value: 'codex', label: 'Codex' },
  { value: 'cursor', label: 'Cursor' },
  { value: 'opencode', label: 'OpenCode' },
];

const PERMISSION_MODES = [
  { value: 'default', label: '逐项确认' },
  { value: 'acceptEdits', label: '自动接受编辑' },
  { value: 'auto', label: '自动判断' },
  { value: 'bypassPermissions', label: '完全放行' },
  { value: 'plan', label: '计划模式' },
];

function formFromView(view: ProjectSettingsView | null): FormState {
  if (!view) {
    return EMPTY_FORM;
  }
  return {
    provider: view.settings.provider ?? '',
    model: view.settings.model ?? '',
    effort: view.settings.effort ?? '',
    permissionMode: view.settings.permissionMode ?? '',
    workspaceMode: view.settings.workspaceMode ?? '',
  };
}

function settingValue(value: string): string | null {
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function SelectField({ label, value, onChange, options, disabled, hint }: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: Array<{ value: string; label: string }>;
  disabled?: boolean;
  hint?: string;
}) {
  return (
    <label className="block space-y-1.5">
      <span className="text-sm font-medium text-foreground">{label}</span>
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        disabled={disabled}
        className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>{option.label}</option>
        ))}
      </select>
      {hint && <span className="block text-xs text-muted-foreground">{hint}</span>}
    </label>
  );
}

/**
 * Rendered by the project workspace header to edit the explicit defaults a new
 * session in this project inherits. Clearing a field restores inheritance.
 */
export default function ProjectSettingsDialog({
  projectId,
  projectName,
  sourceMode,
  open,
  onClose,
}: ProjectSettingsDialogProps) {
  const { view, isLoading, error, refresh, setView } = useProjectSettings(open ? projectId : null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [activeTab, setActiveTab] = useState<'defaults' | 'context' | 'actions' | 'memory'>('defaults');
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const wasOpenRef = useRef(false);
  const isSsh = sourceMode === 'ssh' || view?.sourceMode === 'ssh';

  useEffect(() => {
    if (open && !wasOpenRef.current) {
      setActiveTab('defaults');
    }
    wasOpenRef.current = open;
  }, [open]);

  useEffect(() => {
    if (open) {
      setForm(formFromView(view));
      setSaveError(null);
    }
  }, [open, view]);

  const update = (field: keyof FormState, value: string) => {
    setForm((previous) => ({ ...previous, [field]: value }));
  };

  const save = async () => {
    setIsSaving(true);
    setSaveError(null);
    try {
      const response = await api.saveProjectSettings(projectId, {
        provider: settingValue(form.provider),
        model: settingValue(form.model),
        effort: settingValue(form.effort),
        permissionMode: settingValue(form.permissionMode),
        workspaceMode: settingValue(form.workspaceMode),
      });
      const payload = (await response.json()) as { data?: ProjectSettingsView; error?: string };
      if (!response.ok || !payload.data) {
        throw new Error(payload.error || `保存失败（${response.status}）`);
      }
      setView(payload.data);
    } catch (saveFailure) {
      setSaveError(saveFailure instanceof Error ? saveFailure.message : '保存项目默认值失败');
    } finally {
      setIsSaving(false);
    }
  };

  const clear = async () => {
    setIsSaving(true);
    setSaveError(null);
    try {
      const response = await api.clearProjectSettings(projectId);
      const payload = (await response.json()) as { data?: ProjectSettingsView; error?: string };
      if (!response.ok || !payload.data) {
        throw new Error(payload.error || `恢复继承失败（${response.status}）`);
      }
      setView(payload.data);
      setForm(EMPTY_FORM);
    } catch (clearFailure) {
      setSaveError(clearFailure instanceof Error ? clearFailure.message : '恢复继承失败');
    } finally {
      setIsSaving(false);
    }
  };

  const providerOptions = PROVIDERS.filter((provider) => (
    !isSsh || (view?.constraints.providers ?? ['claude']).includes(provider.value)
  ));
  const effectiveProvider = form.provider || (isSsh ? 'claude' : '账号默认 Provider');
  const effectiveModel = form.model || '账号默认模型';
  const effectivePermission = PERMISSION_MODES.find((mode) => mode.value === form.permissionMode)?.label || '账号默认权限';
  const effectiveWorkspace = isSsh
    ? '共享 Windows 目录'
    : form.workspaceMode === 'isolated'
      ? '隔离会话工作区'
      : form.workspaceMode === 'shared'
        ? '共享项目工作区'
        : '账号默认执行方式';

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent className="max-h-[85vh] max-w-xl overflow-y-auto p-5">
        <DialogTitle>项目默认设置</DialogTitle>
        <p className="mt-1 text-sm text-muted-foreground">
          {projectName} · 查看本项目实际生效的上下文来源，或保存新会话的显式默认值。
        </p>

        <div className="mt-3 flex gap-1 rounded-lg border border-border/70 bg-muted/20 p-1" role="tablist" aria-label="项目设置分类">
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'defaults'}
            onClick={() => setActiveTab('defaults')}
            className={`flex-1 rounded-md px-3 py-1.5 text-sm transition-colors ${activeTab === 'defaults' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}
          >
            默认设置
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'context'}
            onClick={() => setActiveTab('context')}
            className={`flex-1 rounded-md px-3 py-1.5 text-sm transition-colors ${activeTab === 'context' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}
          >
            上下文来源
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'actions'}
            onClick={() => setActiveTab('actions')}
            className={`flex-1 rounded-md px-3 py-1.5 text-sm transition-colors ${activeTab === 'actions' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}
          >
            项目操作
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'memory'}
            onClick={() => setActiveTab('memory')}
            className={`flex-1 rounded-md px-3 py-1.5 text-sm transition-colors ${activeTab === 'memory' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}
          >
            项目记忆
          </button>
        </div>

        {activeTab === 'context' ? (
          <ProjectContextPanel projectId={projectId} />
        ) : activeTab === 'actions' ? (
          <ProjectActionsPanel projectId={projectId} />
        ) : activeTab === 'memory' ? (
          <ProjectMemoryPanel projectId={projectId} />
        ) : isLoading ? (
          <p className="mt-5 text-sm text-muted-foreground">正在读取项目默认设置…</p>
        ) : (
          <div className="mt-5 space-y-4">
            {error && <p role="alert" className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">{error}</p>}

            <div className="rounded-lg border border-border/70 bg-muted/20 p-3">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">新会话将使用</p>
              <p className="mt-1 text-sm text-foreground">
                {effectiveProvider} · {effectiveModel} · {effectivePermission} · {effectiveWorkspace}
              </p>
              {isSsh && (
                <p className="mt-1 text-xs text-muted-foreground">
                  SSH 项目固定使用 VPS Claude Code 和 Windows 共享目录，不能在此改成隔离工作区。
                </p>
              )}
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <SelectField
                label="Provider"
                value={form.provider}
                onChange={(value) => update('provider', value)}
                options={[{ value: '', label: '继承账号默认' }, ...providerOptions]}
                disabled={isSsh && providerOptions.length === 1}
              />
              <SelectField
                label="权限模式"
                value={form.permissionMode}
                onChange={(value) => update('permissionMode', value)}
                options={[{ value: '', label: '继承账号默认' }, ...PERMISSION_MODES]}
              />
            </div>

            <label className="block space-y-1.5">
              <span className="text-sm font-medium text-foreground">模型</span>
              <Input
                value={form.model}
                onChange={(event) => update('model', event.target.value)}
                placeholder="留空继承账号默认，例如 claude-sonnet-4-5"
              />
            </label>

            <label className="block space-y-1.5">
              <span className="text-sm font-medium text-foreground">推理强度（Effort）</span>
              <Input
                value={form.effort}
                onChange={(event) => update('effort', event.target.value)}
                placeholder="留空继承账号默认，例如 low / medium / high"
              />
            </label>

            <SelectField
              label="新会话执行方式"
              value={form.workspaceMode}
              onChange={(value) => update('workspaceMode', value)}
              options={[
                { value: '', label: '继承账号默认' },
                { value: 'isolated', label: '隔离会话工作区（可预览后集成）' },
                { value: 'shared', label: '共享项目工作区' },
              ]}
              disabled={isSsh}
              hint={isSsh ? 'SSH 项目固定共享，已禁用隔离选项。' : '隔离模式需要项目支持 Git 基线；不支持时会回退为共享执行。'}
            />

            {saveError && <p role="alert" className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">{saveError}</p>}

            <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border/60 pt-4">
              <Button variant="ghost" onClick={onClose} disabled={isSaving}>取消</Button>
              <Button variant="outline" onClick={() => void clear()} disabled={isSaving || !view?.updatedAt}>恢复继承</Button>
              <Button onClick={() => void save()} disabled={isSaving}>{isSaving ? '保存中…' : '保存项目默认值'}</Button>
            </div>
            <button type="button" className="text-xs text-muted-foreground underline-offset-2 hover:underline" onClick={() => void refresh()}>
              重新读取
            </button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
