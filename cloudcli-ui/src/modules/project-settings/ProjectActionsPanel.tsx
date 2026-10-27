import { useCallback, useEffect, useState } from 'react';

import { api } from '@/shared/api';
import { Button, Input } from '@/shared/ui';
import { useWorkspaceScope } from '@/shared/context/WorkspaceScopeContext';
import type { ProjectAction, ProjectActionKind, ProjectActionRunResult } from '@/shared/types';

const KINDS: Array<{ value: ProjectActionKind; label: string }> = [
  { value: 'run', label: 'Run' },
  { value: 'test', label: 'Test' },
  { value: 'build', label: 'Build' },
  { value: 'custom', label: '自定义' },
];

const EMPTY_DRAFT = { name: '', command: '', kind: 'custom' as ProjectActionKind, cwd: '' };

function kindLabel(kind: ProjectActionKind): string {
  return KINDS.find((item) => item.value === kind)?.label ?? kind;
}

/** Project Run/Test/Build editor rendered by ProjectSettingsDialog's "项目操作" tab. */
export default function ProjectActionsPanel({ projectId }: { projectId: string }) {
  const workspace = useWorkspaceScope();
  const [actions, setActions] = useState<ProjectAction[]>([]);
  const [draft, setDraft] = useState(EMPTY_DRAFT);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [runningId, setRunningId] = useState<string | null>(null);
  const [runResult, setRunResult] = useState<ProjectActionRunResult | null>(null);

  const load = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const response = await api.projectActions(projectId);
      const payload = (await response.json()) as { data?: { actions?: ProjectAction[] }; error?: string };
      if (!response.ok || !payload.data?.actions) {
        throw new Error(payload.error || `读取项目操作失败（${response.status}）`);
      }
      setActions(payload.data.actions);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : '读取项目操作失败');
    } finally {
      setIsLoading(false);
    }
  }, [projectId]);

  useEffect(() => { void load(); }, [load]);

  const resetDraft = () => {
    setDraft(EMPTY_DRAFT);
    setEditingId(null);
  };

  const save = async () => {
    setIsSaving(true);
    setError(null);
    try {
      const body = {
        name: draft.name,
        command: draft.command,
        kind: draft.kind,
        cwd: draft.cwd || null,
        sortOrder: editingId ? actions.find((action) => action.id === editingId)?.sortOrder ?? 0 : actions.length,
      };
      const response = editingId
        ? await api.updateProjectAction(projectId, editingId, body)
        : await api.createProjectAction(projectId, body);
      const payload = (await response.json()) as { data?: { action?: ProjectAction }; error?: string };
      if (!response.ok || !payload.data?.action) {
        throw new Error(payload.error || `保存项目操作失败（${response.status}）`);
      }
      resetDraft();
      await load();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : '保存项目操作失败');
    } finally {
      setIsSaving(false);
    }
  };

  const remove = async (action: ProjectAction) => {
    if (!window.confirm(`删除项目操作“${action.name}”？`)) return;
    setError(null);
    try {
      const response = await api.deleteProjectAction(projectId, action.id);
      if (!response.ok) {
        const payload = (await response.json()) as { error?: string };
        throw new Error(payload.error || `删除失败（${response.status}）`);
      }
      if (editingId === action.id) resetDraft();
      await load();
    } catch (removeError) {
      setError(removeError instanceof Error ? removeError.message : '删除项目操作失败');
    }
  };

  const run = async (action: ProjectAction) => {
    setRunningId(action.id);
    setRunResult(null);
    setError(null);
    try {
      const response = await api.workspaces.runProjectAction({
        projectId,
        actionId: action.id,
        ...(workspace ? {
          workspaceId: workspace.workspaceId,
          generation: workspace.generation,
          ...(workspace.sessionId ? { sessionId: workspace.sessionId } : {}),
        } : {}),
      });
      const payload = (await response.json()) as ProjectActionRunResult & { error?: string };
      if (!response.ok || typeof payload.exitCode !== 'number') {
        throw new Error(payload.error || `运行失败（${response.status}）`);
      }
      setRunResult(payload);
    } catch (runError) {
      setError(runError instanceof Error ? runError.message : '运行项目操作失败');
    } finally {
      setRunningId(null);
    }
  };

  return (
    <div className="mt-4 space-y-4">
      <p className="text-sm text-muted-foreground">
        保存项目命令并直接在当前工作区执行。{workspace?.sourceMode === 'ssh'
          ? 'SSH 项目使用 Windows PowerShell，命令在 Windows 项目目录运行。'
          : 'VPS 项目使用 Linux shell，命令在项目工作区运行。'}
      </p>

      <div className="space-y-2 rounded-lg border border-border/70 p-3">
        <div className="grid gap-2 sm:grid-cols-[1fr_8rem]">
          <label className="space-y-1">
            <span className="text-xs text-muted-foreground">名称</span>
            <Input value={draft.name} onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))} placeholder="例如：运行开发服务器" />
          </label>
          <label className="space-y-1">
            <span className="text-xs text-muted-foreground">类型</span>
            <select
              value={draft.kind}
              onChange={(event) => setDraft((current) => ({ ...current, kind: event.target.value as ProjectActionKind }))}
              className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            >
              {KINDS.map((kind) => <option key={kind.value} value={kind.value}>{kind.label}</option>)}
            </select>
          </label>
        </div>
        <label className="block space-y-1">
          <span className="text-xs text-muted-foreground">命令</span>
          <Input value={draft.command} onChange={(event) => setDraft((current) => ({ ...current, command: event.target.value }))} placeholder={workspace?.sourceMode === 'ssh' ? 'npm test' : 'npm test'} />
        </label>
        <label className="block space-y-1">
          <span className="text-xs text-muted-foreground">工作目录（相对项目根目录，可留空）</span>
          <Input value={draft.cwd} onChange={(event) => setDraft((current) => ({ ...current, cwd: event.target.value }))} placeholder="例如：packages/app" />
        </label>
        <div className="flex justify-end gap-2">
          {editingId && <Button variant="ghost" size="sm" onClick={resetDraft}>取消编辑</Button>}
          <Button size="sm" onClick={() => void save()} disabled={isSaving || !draft.name.trim() || !draft.command.trim()}>
            {isSaving ? '保存中…' : editingId ? '保存修改' : '添加操作'}
          </Button>
        </div>
      </div>

      {error && <p role="alert" className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">{error}</p>}

      {isLoading ? (
        <p className="text-sm text-muted-foreground">正在读取项目操作…</p>
      ) : actions.length === 0 ? (
        <p className="text-sm text-muted-foreground">还没有项目操作。先添加一条 Run / Test / Build 命令。</p>
      ) : (
        <div className="space-y-2">
          {actions.map((action) => (
            <div key={action.id} className="rounded-lg border border-border/70 p-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="rounded bg-muted px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground">{kindLabel(action.kind)}</span>
                <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">{action.name}</span>
                <Button size="sm" onClick={() => void run(action)} disabled={runningId !== null}>{runningId === action.id ? '运行中…' : '运行'}</Button>
                <Button size="sm" variant="outline" onClick={() => { setEditingId(action.id); setDraft({ name: action.name, command: action.command, kind: action.kind, cwd: action.cwd ?? '' }); }} disabled={runningId !== null}>编辑</Button>
                <Button size="sm" variant="ghost" onClick={() => void remove(action)} disabled={runningId !== null}>删除</Button>
              </div>
              <code className="mt-2 block overflow-x-auto rounded bg-muted/40 px-2 py-1 text-xs text-foreground/80">{action.cwd ? `[${action.cwd}] ` : ''}{action.command}</code>
            </div>
          ))}
        </div>
      )}

      {runResult && (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="font-medium text-foreground">最近一次运行</span>
            <span className={runResult.exitCode === 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-destructive'}>
              退出码 {runResult.exitCode}
            </span>
            <span className="text-xs text-muted-foreground">{runResult.durationMs} ms · {runResult.workspaceMode === 'bridged' ? '工作区桥接' : '直接执行'}</span>
          </div>
          <pre className="max-h-60 overflow-auto whitespace-pre-wrap rounded-lg border border-border/70 bg-muted/20 p-3 text-xs text-foreground/85">{runResult.stdout || '(无 stdout)'}{runResult.stderr ? `\n[stderr]\n${runResult.stderr}` : ''}{runResult.truncated ? '\n[输出已截断]' : ''}</pre>
        </div>
      )}
    </div>
  );
}
