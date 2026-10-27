import { useProjectContext } from '@/modules/project-settings/hooks/useProjectContext';

const PERMISSION_LABELS: Record<string, string> = {
  default: '逐项确认', acceptEdits: '自动接受编辑', auto: '自动判断', bypassPermissions: '完全放行', plan: '计划模式',
};
const RUN_LABELS = { loading: '正在准备配置', loaded: '配置已准备', failed: '配置准备失败', completed: '该轮已结束' };
const FILE_LABELS = { instruction: '指令', rule: '规则', settings: '设置', skill: '技能', mcp: 'MCP' };
const SKILL_LABELS = { available: '已发现，未激活', activated: '已激活', unsupported: '当前不支持' };
const MCP_LABELS = { selected: '已选择，未确认连接', connected: '运行时已连接', failed: '连接失败', disabled: '已禁用', unsupported: '当前不支持' };

function Row({ label, value }: { label: string; value: string }) {
  return <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 py-1.5">
    <span className="w-24 shrink-0 text-xs text-muted-foreground">{label}</span>
    <span className="min-w-0 flex-1 break-words text-sm text-foreground">{value}</span>
  </div>;
}

/** ProjectSettingsDialog's context tab distinguishes the latest run evidence from configured policy. */
export default function ProjectContextPanel({ projectId }: { projectId: string }) {
  const { view, isLoading, error, refresh } = useProjectContext(projectId);
  if (isLoading && !view) return <p className="mt-5 text-sm text-muted-foreground">正在读取上下文来源…</p>;
  if (!view) return <div className="mt-5 space-y-2">
    <p role={error ? 'alert' : 'status'} className="text-sm text-muted-foreground">{error || '暂无上下文信息。'}</p>
    <button type="button" className="text-xs text-muted-foreground underline-offset-2 hover:underline" onClick={() => void refresh()}>重新读取</button>
  </div>;

  const manifest = view.runtimeManifest;
  const workspaceMode = view.workspace.mode === 'bridged' ? '工作区桥接（workspace 工具）' : '直接运行（项目目录）';
  const defaults = view.defaults;
  const defaultSummary = [
    defaults.provider || 'Provider 继承', defaults.model || '模型继承', defaults.effort ? `effort ${defaults.effort}` : 'effort 继承',
    defaults.permissionMode ? PERMISSION_LABELS[defaults.permissionMode] ?? defaults.permissionMode : '权限继承',
    defaults.workspaceMode === 'isolated' ? '隔离工作区' : defaults.workspaceMode === 'shared' ? '共享工作区' : '执行方式继承',
  ].join(' · ');

  return <div className="mt-4 space-y-4 text-sm">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h3 className="text-sm font-medium">最近一次实际运行</h3>
      <button type="button" className="rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50" disabled={isLoading} onClick={() => void refresh()}>{isLoading ? '正在刷新…' : '刷新运行记录'}</button>
    </div>
    {error && <p role="alert" className="text-xs text-destructive">{error} · 以下保留上次成功读取的记录。</p>}
    <p className="text-xs text-muted-foreground">{view.sourceMode === 'ssh' ? 'Claude 在云端运行；项目文件与工作区工具在 Windows 执行。' : `Claude 在${view.execution.location === 'vps' ? '云端 VPS' : '本机'}运行。`}</p>

    {manifest ? <section aria-label="实际运行清单" className="space-y-3">
      <div><p role="status" className="font-medium">{RUN_LABELS[manifest.status]}</p><p className="mt-1 break-all text-xs text-muted-foreground">运行 {manifest.runId} · 更新于 {manifest.at}</p></div>
      <p className="text-xs text-muted-foreground">{manifest.status === 'completed' ? '以下是该轮运行的历史记录，不代表当前仍在运行或保持连接。' : '“配置已准备”只代表运行参数已组装；不表示模型已读取全部文件。MCP 连接以该轮 SDK 返回的状态为准。'}</p>
      {manifest.error && <p role="alert" className="break-words text-xs text-destructive">{manifest.error}</p>}
      <details className="border-t border-border pt-2">
        <summary className="cursor-pointer text-xs font-medium">本轮标识与文件（{manifest.files.length}）</summary>
        <div className="mt-2 space-y-2">
          <Row label="会话" value={manifest.sessionId || '尚未记录会话编号'} />
          <Row label="配置版本" value={manifest.configRevision} />
          <Row label="工作区" value={`${manifest.workspaceId} · ${manifest.generation}`} />
          <p className="text-xs text-muted-foreground">文件清单记录本轮准备的来源及哈希，不证明模型逐个读取。</p>
          {manifest.files.length ? <ul className="space-y-2">{manifest.files.map((file, index) => <li key={`${file.kind}:${file.path}:${index}`} className="text-xs"><p className="break-all">{FILE_LABELS[file.kind]} · {file.path}</p><p className="break-all text-muted-foreground">哈希：{file.hash || '未记录'}</p></li>)}</ul> : <p className="text-xs text-muted-foreground">本轮未记录文件来源。</p>}
        </div>
      </details>
      <details className="border-t border-border pt-2">
        <summary className="cursor-pointer text-xs font-medium">技能（{manifest.skills.length}）</summary>
        <div className="mt-2 space-y-2">{manifest.skills.length ? manifest.skills.map((skill, index) => <div key={`${skill.name}:${index}`} className="text-xs"><p className="break-words">{skill.name} · {SKILL_LABELS[skill.status]}</p><p className="break-all text-muted-foreground">{skill.path}</p>{skill.reason && <p className="break-words text-muted-foreground">{skill.reason}</p>}</div>) : <p className="text-xs text-muted-foreground">本轮未记录技能发现或激活结果。</p>}</div>
      </details>
      <details className="border-t border-border pt-2">
        <summary className="cursor-pointer text-xs font-medium">MCP（{manifest.mcp.length}）</summary>
        <div className="mt-2 space-y-2">{manifest.mcp.length ? manifest.mcp.map((server, index) => <div key={`${server.name}:${index}`} className="text-xs"><p className="break-words">{server.name} · {manifest.status === 'completed' && server.status === 'connected' ? '该轮曾连接' : MCP_LABELS[server.status]}</p><p className="text-muted-foreground">{server.transport === 'unknown' ? '传输方式未记录' : server.transport} · {server.location === 'local' ? 'Windows 本地' : '云端'}</p>{server.reason && <p className="break-words text-muted-foreground">{server.reason}</p>}</div>) : <p className="text-xs text-muted-foreground">本轮未记录 MCP 选择或连接结果。</p>}</div>
      </details>
      {manifest.warnings.length > 0 && <details className="border-t border-border pt-2"><summary className="cursor-pointer text-xs font-medium">运行提示（{manifest.warnings.length}）</summary><ul className="mt-2 list-disc space-y-1 pl-4 text-xs text-muted-foreground">{manifest.warnings.map((warning, index) => <li key={index} className="break-words">{warning}</li>)}</ul></details>}
    </section> : <div className="space-y-1"><p role="status" className="font-medium">尚无实际运行记录</p><p className="text-xs text-muted-foreground">首次发送消息后会生成该次运行清单；下方仅为配置策略，尚未证明文件已读取、技能已激活或 MCP 已连接。</p></div>}

    <details className="border-t border-border pt-3">
      <summary className="cursor-pointer text-xs font-medium">配置策略</summary>
      <div className="mt-2 space-y-3">
        <p className="text-xs text-muted-foreground">这些配置描述预期来源，不等于本轮运行已经加载或连接。</p>
        <div><Row label="项目" value={view.sourceMode === 'ssh' ? 'SSH 本地项目' : 'VPS 云端项目'} /><Row label="源码位置" value={view.displayPath} /><Row label="工作区" value={workspaceMode} /></div>
        <div><Row label="指令路径" value={view.workspace.instructionPath} /><Row label="读取策略" value={view.instructions.access === 'workspace-tool' ? '工作区工具按需读取' : 'Claude 直接读取'} /><p className="text-xs text-muted-foreground">{view.instructions.note}</p></div>
        <div><Row label="settings 来源" value={view.runtime.settingSources.length ? view.runtime.settingSources.join(' · ') : '原生来源关闭；显式装配项目配置'} /><Row label="Claude 原生自动记忆" value={view.runtime.autoMemory ? '启用' : '关闭'} /><Row label="MCP 策略" value={view.runtime.strictMcpConfig ? 'MCP 显式白名单（工作区、项目上下文及已批准扩展）' : '项目/用户/本地配置'} /><Row label="策略选择 MCP" value={view.runtime.effectiveMcpServers.join(' · ') || '未配置'} /><Row label="项目默认" value={defaultSummary} /></div>
        <ul className="list-disc space-y-1 pl-4 text-xs text-muted-foreground">{view.notes.map((note, index) => <li key={index}>{note}</li>)}</ul>
      </div>
    </details>
  </div>;
}
