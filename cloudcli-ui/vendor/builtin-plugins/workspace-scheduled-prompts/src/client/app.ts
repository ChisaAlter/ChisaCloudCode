import type { CreateTaskRequest, GlobalDashboardActionResponse, UpdateTaskRequest } from "../shared/contracts.js";
import type { GlobalDashboardFilter, GlobalJobRunStatus, WorkspaceTask } from "../shared/model.js";
import type { PluginAPI } from "../types.js";
import { PluginRpcClient } from "./api.js";
import { AppStateStore, DEFAULT_CAPABILITY } from "./state.js";
import { renderExecutionBanner } from "./views/execution-banner.js";
import { renderGlobalDashboard } from "./views/global-dashboard.js";
import { renderRunHistory } from "./views/run-history.js";
import { renderScheduleList } from "./views/schedule-list.js";
import { renderTaskForm } from "./views/task-form.js";

const STYLE_ID = "workspace-scheduled-prompts-styles";
const GLOBAL_REFRESH_INTERVAL_MS = 60_000;

function ensureStyles(): void {
  if (document.getElementById(STYLE_ID)) {
    return;
  }

  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
    .workspace-scheduled-prompts {
      --wsp-bg: #f5f7fa;
      --wsp-panel: #ffffff;
      --wsp-border: #d9e0e7;
      --wsp-text: #1d2935;
      --wsp-muted: #607080;
      --wsp-accent: #1570ef;
      --wsp-accent-soft: #e8f1ff;
      --wsp-success: #1d7a46;
      --wsp-success-soft: #e8f6ee;
      --wsp-danger: #b42318;
      --wsp-danger-soft: #fdecea;
      color: var(--wsp-text);
      background: var(--wsp-bg);
      min-height: 100%;
      box-sizing: border-box;
      padding: 20px;
      font: 13px/1.45 ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }

    .workspace-scheduled-prompts[data-theme="dark"] {
      --wsp-bg: #0f1720;
      --wsp-panel: #15202b;
      --wsp-border: #263241;
      --wsp-text: #dce6ef;
      --wsp-muted: #97a6b5;
      --wsp-accent: #61a4ff;
      --wsp-accent-soft: rgba(97, 164, 255, 0.14);
      --wsp-success: #53c483;
      --wsp-success-soft: rgba(83, 196, 131, 0.14);
      --wsp-danger: #ff7b72;
      --wsp-danger-soft: rgba(255, 123, 114, 0.14);
    }

    .workspace-scheduled-prompts * { box-sizing: border-box; }
    .workspace-scheduled-prompts h1,
    .workspace-scheduled-prompts h2,
    .workspace-scheduled-prompts h3,
    .workspace-scheduled-prompts p { margin: 0; }

    .wsp-shell { display: grid; gap: 16px; }
    .wsp-tabs {
      display: inline-flex;
      gap: 8px;
      padding: 4px;
      border: 1px solid var(--wsp-border);
      border-radius: 12px;
      background: var(--wsp-bg);
    }
    .wsp-tab {
      border: 0;
      background: transparent;
      padding: 8px 12px;
      border-radius: 8px;
      font-weight: 600;
    }
    .wsp-tab[data-active="true"] {
      background: var(--wsp-panel);
      box-shadow: inset 0 0 0 1px var(--wsp-border);
      color: var(--wsp-accent);
    }
    .wsp-tab:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
    .wsp-header {
      display: flex;
      justify-content: space-between;
      gap: 16px;
      align-items: flex-start;
      padding: 16px 18px;
      border: 1px solid var(--wsp-border);
      border-radius: 12px;
      background: var(--wsp-panel);
    }
    .wsp-header h1 { font-size: 18px; font-weight: 650; }
    .wsp-header p { color: var(--wsp-muted); margin-top: 4px; }
    .wsp-workspace-chip {
      max-width: 42%;
      padding: 8px 10px;
      border: 1px solid var(--wsp-border);
      border-radius: 10px;
      background: var(--wsp-bg);
      color: var(--wsp-muted);
      font-size: 12px;
      text-align: right;
      word-break: break-word;
    }

    .wsp-banner {
      padding: 12px 14px;
      border-radius: 10px;
      border: 1px solid var(--wsp-border);
      background: var(--wsp-panel);
    }
    .wsp-banner strong { display: block; margin-bottom: 2px; }
    .wsp-banner-error {
      border-color: var(--wsp-danger);
      background: var(--wsp-danger-soft);
      color: var(--wsp-danger);
    }
    .wsp-banner-success {
      border-color: var(--wsp-success);
      background: var(--wsp-success-soft);
      color: var(--wsp-success);
    }
    .wsp-banner-info {
      background: var(--wsp-accent-soft);
      border-color: var(--wsp-accent);
    }

    .wsp-main {
      display: grid;
      grid-template-columns: minmax(340px, 1.2fr) minmax(320px, 1fr);
      gap: 16px;
      align-items: start;
    }
    .wsp-stack { display: grid; gap: 16px; }
    .wsp-panel,
    .execution-banner,
    .schedule-list,
    .run-history {
      padding: 16px 18px;
      border: 1px solid var(--wsp-border);
      border-radius: 12px;
      background: var(--wsp-panel);
    }

    .wsp-section-heading h2,
    .execution-banner h2,
    .schedule-list h2,
    .run-history h2 { font-size: 15px; font-weight: 650; }
    .wsp-section-heading p,
    .execution-banner p,
    .schedule-list p,
    .run-history p { color: var(--wsp-muted); }

    .wsp-panel-title {
      margin-bottom: 12px;
      font-size: 12px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: var(--wsp-muted);
    }

    .wsp-form { display: grid; gap: 14px; }
    .wsp-form-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 12px;
    }
    .wsp-field,
    .wsp-checkbox-group,
    .wsp-form-actions {
      display: grid;
      gap: 6px;
    }
    .wsp-field-span-2 { grid-column: span 2; }
    .wsp-field label {
      font-weight: 600;
      font-size: 12px;
    }
    .wsp-field p,
    .wsp-preview-note {
      font-size: 12px;
      color: var(--wsp-muted);
    }

    .workspace-scheduled-prompts input,
    .workspace-scheduled-prompts select,
    .workspace-scheduled-prompts textarea,
    .workspace-scheduled-prompts button {
      font: inherit;
    }
    .workspace-scheduled-prompts input,
    .workspace-scheduled-prompts select,
    .workspace-scheduled-prompts textarea {
      width: 100%;
      border: 1px solid var(--wsp-border);
      border-radius: 10px;
      padding: 10px 12px;
      background: var(--wsp-bg);
      color: var(--wsp-text);
      outline: none;
    }
    .workspace-scheduled-prompts input:focus,
    .workspace-scheduled-prompts select:focus,
    .workspace-scheduled-prompts textarea:focus {
      border-color: var(--wsp-accent);
      box-shadow: 0 0 0 3px rgba(21, 112, 239, 0.16);
    }
    .workspace-scheduled-prompts textarea {
      resize: vertical;
      min-height: 120px;
    }

    .wsp-checkbox-group {
      grid-template-columns: repeat(auto-fit, minmax(72px, 1fr));
      gap: 8px;
    }
    .wsp-checkbox {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 10px;
      border: 1px solid var(--wsp-border);
      border-radius: 10px;
      background: var(--wsp-bg);
    }
    .wsp-checkbox input {
      width: auto;
      margin: 0;
    }

    .wsp-preview {
      padding: 12px 14px;
      border-radius: 10px;
      background: var(--wsp-bg);
      border: 1px solid var(--wsp-border);
      color: var(--wsp-text);
      min-height: 44px;
    }
    .wsp-feedback {
      min-height: 18px;
      color: var(--wsp-danger);
      font-weight: 500;
    }
    .wsp-form-actions {
      grid-auto-flow: column;
      justify-content: start;
      align-items: center;
    }
    .workspace-scheduled-prompts button {
      border: 1px solid var(--wsp-border);
      border-radius: 10px;
      padding: 10px 14px;
      background: var(--wsp-panel);
      color: var(--wsp-text);
      cursor: pointer;
    }
    .workspace-scheduled-prompts button[type="submit"] {
      background: var(--wsp-accent);
      border-color: var(--wsp-accent);
      color: #ffffff;
      font-weight: 600;
    }
    .wsp-secondary-button { background: var(--wsp-bg); }

    .execution-banner {
      display: grid;
      gap: 6px;
    }
    .wsp-status-chip {
      display: inline-flex;
      align-items: center;
      width: fit-content;
      padding: 4px 8px;
      border-radius: 999px;
      font-size: 11px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      background: var(--wsp-accent-soft);
      color: var(--wsp-accent);
    }

    .schedule-list ul,
    .run-history ul,
    .wsp-global-job-list {
      list-style: none;
      padding: 0;
      margin: 12px 0 0;
      display: grid;
      gap: 10px;
    }
    .schedule-list li,
    .run-history li {
      border: 1px solid var(--wsp-border);
      border-radius: 10px;
      background: var(--wsp-bg);
      padding: 12px;
    }
    .wsp-task-head,
    .wsp-run-head {
      display: flex;
      justify-content: space-between;
      gap: 12px;
      align-items: flex-start;
      margin-bottom: 6px;
    }
    .wsp-task-meta,
    .wsp-run-meta {
      display: grid;
      gap: 4px;
      color: var(--wsp-muted);
      font-size: 12px;
    }
    .wsp-inline-actions {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-top: 12px;
    }
    .wsp-inline-actions button {
      padding: 7px 10px;
      font-size: 12px;
    }
    .wsp-global-dashboard { display: grid; gap: 14px; }
    .wsp-global-dashboard-head {
      display: flex;
      justify-content: space-between;
      gap: 12px;
      align-items: flex-start;
    }
    .wsp-global-controls {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 10px;
    }
    .wsp-global-controls .wsp-field > span {
      font-weight: 600;
      font-size: 12px;
    }
    .wsp-global-summary {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 10px;
    }
    .wsp-global-card,
    .wsp-global-workspace-pill {
      padding: 12px 14px;
      border: 1px solid var(--wsp-border);
      border-radius: 10px;
      background: var(--wsp-bg);
    }
    .wsp-global-card strong {
      display: block;
      font-size: 18px;
      font-weight: 700;
    }
    .wsp-global-card span {
      color: var(--wsp-muted);
      font-size: 12px;
    }
    .wsp-global-workspaces {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
    }
    .wsp-global-warning-list {
      margin: 8px 0 0;
      padding-left: 18px;
      color: inherit;
    }
    .wsp-global-workspace-pill[data-status="partial"] {
      border-color: var(--wsp-accent);
    }
    .wsp-global-workspace-pill[data-status="unavailable"] {
      border-color: var(--wsp-danger);
      color: var(--wsp-danger);
    }
    .wsp-global-job {
      border: 1px solid var(--wsp-border);
      border-radius: 10px;
      background: var(--wsp-bg);
      padding: 12px;
    }
    .wsp-global-job[data-problem="true"] {
      border-color: var(--wsp-danger);
      box-shadow: inset 0 0 0 1px rgba(180, 35, 24, 0.16);
    }
    .wsp-global-job[data-workspace-availability="partial"] {
      border-color: var(--wsp-accent);
    }
    .wsp-global-job[data-workspace-availability="unavailable"] {
      border-color: var(--wsp-danger);
    }

    @media (max-width: 900px) {
      .wsp-main,
      .wsp-form-grid,
      .wsp-global-controls,
      .wsp-global-summary {
        grid-template-columns: 1fr;
      }
      .wsp-field-span-2,
      .wsp-workspace-chip {
        grid-column: auto;
        max-width: 100%;
      }
      .wsp-header {
        flex-direction: column;
      }
    }
  `;
  document.head.append(style);
}

function normalizeGlobalRunStatus(
  status: WorkspaceTask["lastRunStatus"],
  fallback: GlobalJobRunStatus
): GlobalJobRunStatus {
  switch (status) {
    case "running":
    case "succeeded":
    case "failed":
    case "missed":
      return status;
    default:
      return fallback;
  }
}

function renderBanner(kind: "error" | "success" | "info", title: string, message: string): HTMLElement {
  const banner = document.createElement("div");
  banner.className = `wsp-banner wsp-banner-${kind}`;
  banner.innerHTML = `<strong>${title}</strong><span>${message}</span>`;
  return banner;
}

export class WorkspaceScheduledPromptsApp {
  private readonly rpc: PluginRpcClient;
  private readonly state = new AppStateStore();
  private unsubscribe: (() => void) | null = null;
  private globalRefreshTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly container: HTMLElement, private readonly api: PluginAPI) {
    this.rpc = new PluginRpcClient(api);
  }

  async mount(): Promise<void> {
    ensureStyles();
    this.unsubscribe = this.state.subscribe(() => this.render());
    this.state.patch({
      activeTab: this.api.context.project?.path ? "workspace" : "global"
    });
    await Promise.all([
      this.loadFromContext(this.api.context.project?.path ?? null),
      this.loadGlobalDashboard()
    ]);
    this.startGlobalRefreshTimer();
  }

  unmount(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.globalRefreshTimer) {
      clearInterval(this.globalRefreshTimer);
      this.globalRefreshTimer = null;
    }
    this.container.innerHTML = "";
  }

  private startGlobalRefreshTimer(): void {
    if (this.globalRefreshTimer) {
      return;
    }
    this.globalRefreshTimer = setInterval(() => {
      if (this.state.snapshot.activeTab !== "global") {
        return;
      }
      void this.loadGlobalDashboard(true);
    }, GLOBAL_REFRESH_INTERVAL_MS);
  }

  private async loadGlobalDashboard(silent = false): Promise<boolean> {
    if (!silent) {
      this.state.patch({ globalBusy: true, globalError: null });
    }

    try {
      const snapshot = await this.rpc.loadGlobalDashboard(this.state.snapshot.globalFilters);
      this.state.patch({
        globalSnapshot: snapshot,
        globalBusy: false,
        globalError: null
      });
      return true;
    } catch (error) {
      this.state.patch({
        globalBusy: false,
        globalError: error instanceof Error ? error.message : "Failed to load global dashboard."
      });
      return false;
    }
  }

  private updateGlobalSnapshotFromAction(response: GlobalDashboardActionResponse): void {
    const snapshot = this.state.snapshot.globalSnapshot;
    if (!snapshot) {
      return;
    }

    const jobs = snapshot.jobs.map((job) => {
      if (job.workspaceKey !== response.task.workspaceKey || job.taskId !== response.task.id) {
        return job;
      }

      return {
        ...job,
        name: response.task.name,
        workspacePath: response.task.workspacePath,
        enabled: response.task.enabled,
        nextRunAt: response.task.nextRunAt,
        lastRunStatus: normalizeGlobalRunStatus(response.task.lastRunStatus, job.lastRunStatus),
        lastRunFinishedAt: response.run?.finishedAt ?? job.lastRunFinishedAt
      };
    });

    this.state.patch({
      globalSnapshot: {
        ...snapshot,
        jobs
      }
    });
  }

  private async focusWorkspace(workspacePath: string, taskId: string | null = null): Promise<void> {
    const loaded = await this.loadFromContext(workspacePath);
    await this.loadGlobalDashboard(true);
    if (!loaded) {
      return;
    }

    this.state.patch({
      activeTab: "workspace",
      error: null,
      successMessage: null,
      globalError: null,
      highlightedTaskId: taskId
    });
  }

  private async dispatchGlobalAction(
    action: "run_now" | "pause" | "resume" | "retry",
    workspaceKey: string,
    taskId: string,
    runId?: string
  ): Promise<void> {
    this.state.patch({
      globalPendingActionKey: `${workspaceKey}:${taskId}:${action}`,
      error: null,
      successMessage: null,
      globalError: null
    });

    try {
      let response: GlobalDashboardActionResponse;
      switch (action) {
        case "run_now":
          response = await this.rpc.globalRunNow(workspaceKey, taskId);
          break;
        case "pause":
          response = await this.rpc.globalPauseTask(workspaceKey, taskId);
          break;
        case "resume":
          response = await this.rpc.globalResumeTask(workspaceKey, taskId);
          break;
        case "retry":
          if (!runId) {
            throw new Error("Missing retry target.");
          }
          response = await this.rpc.globalRetryTask(workspaceKey, taskId, { runId });
          break;
      }

      this.updateGlobalSnapshotFromAction(response);
      if (this.state.snapshot.workspacePath === response.task.workspacePath) {
        const refreshed = await this.loadFromContext(response.task.workspacePath);
        if (refreshed) {
          this.state.patch({ highlightedTaskId: response.task.id });
        }
      }
      await this.loadGlobalDashboard(true);
      const messageByAction: Record<typeof action, string> = {
        run_now: `Manual run finished for "${response.task.name}".`,
        pause: `Schedule "${response.task.name}" paused.`,
        resume: `Schedule "${response.task.name}" resumed.`,
        retry: `Retry finished for "${response.task.name}".`
      };
      this.state.patch({
        successMessage: messageByAction[action],
        error: null
      });
    } catch (error) {
      this.state.patch({
        error: error instanceof Error ? error.message : "Failed to perform the global action.",
        successMessage: null
      });
    } finally {
      this.state.patch({ globalPendingActionKey: null });
    }
  }

  private async updateGlobalFilters(
    patch: Partial<GlobalDashboardFilter>
  ): Promise<void> {
    const nextFilters = {
      ...this.state.snapshot.globalFilters,
      ...patch
    };
    this.state.patch({
      globalFilters: nextFilters,
      globalError: null
    });
    await this.loadGlobalDashboard();
  }

  async loadFromContext(workspacePath: string | null): Promise<boolean> {
    if (!workspacePath) {
      this.state.replace({
        activeTab: "global",
        workspacePath: null,
        tasks: [],
        runs: [],
        capability: DEFAULT_CAPABILITY,
        executionProfile: null,
        busy: false,
        error: null,
        successMessage: null,
        editingTaskId: null,
        highlightedTaskId: null,
        globalSnapshot: this.state.snapshot.globalSnapshot,
        globalFilters: this.state.snapshot.globalFilters,
        globalBusy: this.state.snapshot.globalBusy,
        globalError: this.state.snapshot.globalError,
        globalPendingActionKey: this.state.snapshot.globalPendingActionKey
      });
      return true;
    }

    this.state.patch({
      busy: true,
      workspacePath,
      error: null,
      successMessage: null,
      highlightedTaskId: null
    });
    try {
      const payload = await this.rpc.loadWorkspaceState(workspacePath);
      this.state.patch({
        workspacePath,
        tasks: payload.tasks,
        runs: payload.runs,
        capability: payload.capability,
        executionProfile: payload.executionProfile,
        busy: false,
        error: null,
        successMessage: null,
        highlightedTaskId: null
      });
      return true;
    } catch (error) {
      this.state.patch({
        busy: false,
        error: error instanceof Error ? error.message : "Failed to load workspace state.",
        executionProfile: null,
        successMessage: null
      });
      return false;
    }
  }

  private currentEditingTask(): WorkspaceTask | null {
    const { editingTaskId, tasks } = this.state.snapshot;
    return tasks.find((task) => task.id === editingTaskId) ?? null;
  }

  private async reconcileWorkspaceState(
    workspacePath: string,
    successMessage: string,
    highlightedTaskId: string | null
  ): Promise<void> {
    const refreshed = await this.loadFromContext(workspacePath);
    await this.loadGlobalDashboard(true);
    if (!refreshed) {
      return;
    }
    this.state.patch({
      successMessage,
      highlightedTaskId,
      error: null
    });
  }

  private async handleCreateTask(request: Omit<CreateTaskRequest, "workspacePath">): Promise<void> {
    const workspacePath = this.state.snapshot.workspacePath;
    if (!workspacePath) {
      return;
    }

    const response = await this.rpc.createTask({ ...request, workspacePath });
    this.state.upsertTask(response.task);
    this.state.patch({
      editingTaskId: null,
      error: null,
      successMessage: `Schedule "${response.task.name}" created.`,
      highlightedTaskId: response.task.id
    });
    await this.loadGlobalDashboard(true);
  }

  private async handleSaveTask(request: Omit<CreateTaskRequest, "workspacePath">): Promise<void> {
    const workspacePath = this.state.snapshot.workspacePath;
    const editingTaskId = this.state.snapshot.editingTaskId;
    if (!workspacePath) {
      return;
    }

    if (!editingTaskId) {
      await this.handleCreateTask(request);
      return;
    }

    const update: UpdateTaskRequest = {
      workspacePath,
      name: request.name,
      prompt: request.prompt,
      recurrence: request.recurrence
    };
    const response = await this.rpc.updateTask(editingTaskId, update);
    this.state.upsertTask(response.task);
    this.state.patch({
      editingTaskId: null,
      error: null,
      successMessage: `Schedule "${response.task.name}" updated.`,
      highlightedTaskId: response.task.id
    });
    await this.loadGlobalDashboard(true);
  }

  private render(): void {
    const snapshot = this.state.snapshot;
    this.container.innerHTML = "";

    const root = document.createElement("div");
    root.className = "workspace-scheduled-prompts";
    root.dataset.theme = this.api.context.theme;

    const heading = document.createElement("header");
    heading.className = "wsp-header";
    heading.innerHTML = `
      <div>
        <h1>Scheduled Prompt</h1>
        <p>${snapshot.activeTab === "global"
          ? "Monitor scheduled jobs across all known workspaces."
          : "Create, review, and monitor scheduled prompts for the active workspace."}</p>
      </div>
      <div class="wsp-workspace-chip">
        ${snapshot.activeTab === "global" ? "Global overview" : snapshot.workspacePath ?? "No workspace selected"}
      </div>
    `;
    root.append(heading);

    const tabs = document.createElement("div");
    tabs.className = "wsp-tabs";
    const globalTab = document.createElement("button");
    globalTab.type = "button";
    globalTab.className = "wsp-tab";
    globalTab.dataset.active = String(snapshot.activeTab === "global");
    globalTab.textContent = "Global";
    globalTab.addEventListener("click", () => {
      this.state.patch({ activeTab: "global", error: null, successMessage: null });
      void this.loadGlobalDashboard();
    });
    tabs.append(globalTab);

    const workspaceTab = document.createElement("button");
    workspaceTab.type = "button";
    workspaceTab.className = "wsp-tab";
    workspaceTab.dataset.active = String(snapshot.activeTab === "workspace");
    workspaceTab.textContent = "Workspace";
    workspaceTab.disabled = !snapshot.workspacePath;
    workspaceTab.addEventListener("click", () => {
      this.state.patch({ activeTab: "workspace", error: null, successMessage: null });
    });
    tabs.append(workspaceTab);
    root.append(tabs);

    if (snapshot.error) {
      root.append(renderBanner("error", "Action required", snapshot.error));
    }

    if (snapshot.successMessage) {
      const success = renderBanner("success", "Saved", snapshot.successMessage);
      success.setAttribute("role", "status");
      success.setAttribute("aria-live", "polite");
      root.append(success);
    }

    if (snapshot.busy) {
      root.append(renderBanner("info", "Loading", "Refreshing workspace schedules and run history."));
    }

    const main = document.createElement("div");
    main.className = "wsp-main";

    if (snapshot.activeTab === "global") {
      main.style.gridTemplateColumns = "minmax(0, 1fr)";
      main.append(
        renderGlobalDashboard(
          snapshot.globalSnapshot,
          snapshot.globalBusy,
          snapshot.globalError,
          snapshot.globalFilters,
          {
            onRefresh: () => {
              void this.loadGlobalDashboard();
            },
            onSetStatusFilter: (status) => {
              void this.updateGlobalFilters({ status });
            },
            onSetWorkspaceFilter: (workspaceKey) => {
              void this.updateGlobalFilters({ workspaceKey });
            },
            onSetSortBy: (sortBy) => {
              void this.updateGlobalFilters({ sortBy });
            },
            onOpenWorkspace: (workspacePath, taskId) => {
              void this.focusWorkspace(workspacePath, taskId);
            },
            onRunNow: (workspaceKey, taskId) => {
              void this.dispatchGlobalAction("run_now", workspaceKey, taskId);
            },
            onPause: (workspaceKey, taskId) => {
              void this.dispatchGlobalAction("pause", workspaceKey, taskId);
            },
            onResume: (workspaceKey, taskId) => {
              void this.dispatchGlobalAction("resume", workspaceKey, taskId);
            },
            onRetry: (workspaceKey, taskId, runId) => {
              void this.dispatchGlobalAction("retry", workspaceKey, taskId, runId);
            }
          },
          snapshot.globalPendingActionKey
        )
      );
      root.append(main);
      this.container.append(root);
      return;
    }

    const left = document.createElement("div");
    left.className = "wsp-stack";
    left.append(
      renderTaskForm(this.currentEditingTask(), {
        onSubmit: (request) => {
          void this.handleSaveTask(request).catch((error) => {
            this.state.patch({
              error: error instanceof Error ? error.message : "Failed to save task.",
              successMessage: null
            });
          });
        },
        onCancelEdit: () => this.state.patch({ editingTaskId: null, error: null, successMessage: null })
      })
    );

    const right = document.createElement("div");
    right.className = "wsp-stack";
    right.append(
      renderExecutionBanner(snapshot.capability, snapshot.executionProfile, {
        onSave: (request) => {
          const workspacePath = this.state.snapshot.workspacePath;
          if (!workspacePath) {
            return;
          }
          void this.rpc.saveExecutionProfile({ ...request, workspacePath }).then((response) => {
            this.state.patch({
              capability: response.capability,
              executionProfile: response.executionProfile,
              error: null,
              successMessage: "Execution settings saved.",
              highlightedTaskId: null
            });
          }).catch((error) => {
            this.state.patch({
              error: error instanceof Error ? error.message : "Failed to save execution settings.",
              successMessage: null
            });
          });
        }
      })
    );
    right.append(
      renderScheduleList(snapshot.tasks, {
        onEdit: (taskId) => this.state.patch({
          editingTaskId: taskId,
          error: null,
          successMessage: null,
          highlightedTaskId: taskId
        }),
        onDelete: (taskId) => {
          const workspacePath = this.state.snapshot.workspacePath;
          if (!workspacePath) {
            return;
          }
          void this.rpc.deleteTask(taskId, workspacePath).then(() => {
            if (this.state.snapshot.editingTaskId === taskId) {
              this.state.patch({ editingTaskId: null });
            }
            return this.reconcileWorkspaceState(workspacePath, "Schedule deleted.", null);
          }).catch((error) => {
            this.state.patch({
              error: error instanceof Error ? error.message : "Failed to delete task.",
              successMessage: null
            });
          });
        },
        onPause: (taskId) => {
          const workspacePath = this.state.snapshot.workspacePath;
          if (!workspacePath) {
            return;
          }
          void this.rpc.pauseTask(taskId, workspacePath).then((response) => {
            return this.reconcileWorkspaceState(workspacePath, `Schedule "${response.task.name}" paused.`, response.task.id);
          }).catch((error) => {
            this.state.patch({
              error: error instanceof Error ? error.message : "Failed to pause task.",
              successMessage: null
            });
          });
        },
        onResume: (taskId) => {
          const workspacePath = this.state.snapshot.workspacePath;
          if (!workspacePath) {
            return;
          }
          void this.rpc.resumeTask(taskId, workspacePath).then((response) => {
            return this.reconcileWorkspaceState(workspacePath, `Schedule "${response.task.name}" resumed.`, response.task.id);
          }).catch((error) => {
            this.state.patch({
              error: error instanceof Error ? error.message : "Failed to resume task.",
              successMessage: null
            });
          });
        },
        onDuplicate: (taskId) => {
          const workspacePath = this.state.snapshot.workspacePath;
          if (!workspacePath) {
            return;
          }
          void this.rpc.duplicateTask(taskId, workspacePath).then((response) => {
            return this.reconcileWorkspaceState(workspacePath, `Schedule "${response.task.name}" duplicated.`, response.task.id);
          }).catch((error) => {
            this.state.patch({
              error: error instanceof Error ? error.message : "Failed to duplicate task.",
              successMessage: null
            });
          });
        },
        onRunNow: (taskId) => {
          const workspacePath = this.state.snapshot.workspacePath;
          if (!workspacePath) {
            return;
          }
          void this.rpc.runNow(taskId, workspacePath).then((response) => {
            this.state.patch({
              runs: [response.run, ...this.state.snapshot.runs.filter((run) => run.id !== response.run.id)],
              error: null
            });
            return this.reconcileWorkspaceState(workspacePath, "Manual run finished.", taskId);
          }).catch((error) => {
            this.state.patch({
              error: error instanceof Error ? error.message : "Failed to start manual run.",
              successMessage: null
            });
          });
        }
      }, snapshot.highlightedTaskId)
    );
    right.append(renderRunHistory(snapshot.runs, {
      onRetry: (runId) => {
        const workspacePath = this.state.snapshot.workspacePath;
        if (!workspacePath) {
          return;
        }
        void this.rpc.retryRun(runId, workspacePath).then((response) => {
          this.state.patch({
            runs: [response.run, ...this.state.snapshot.runs.filter((run) => run.id !== response.run.id)],
            error: null
          });
          return this.reconcileWorkspaceState(workspacePath, "Retry finished.", null);
        }).catch((error) => {
          this.state.patch({
            error: error instanceof Error ? error.message : "Failed to retry run.",
            successMessage: null
          });
        });
      }
    }));
    main.append(left, right);
    root.append(main);

    this.container.append(root);
  }
}
