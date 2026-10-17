import type {
  ExecutionCapability,
  ExecutionProfile,
  GlobalDashboardFilter,
  GlobalDashboardSnapshot,
  ScheduledRun,
  WorkspaceTask
} from "../shared/model.js";

export type AppTab = "workspace" | "global";

export interface AppState {
  activeTab: AppTab;
  workspacePath: string | null;
  tasks: WorkspaceTask[];
  runs: ScheduledRun[];
  capability: ExecutionCapability;
  executionProfile: ExecutionProfile | null;
  error: string | null;
  successMessage: string | null;
  busy: boolean;
  editingTaskId: string | null;
  highlightedTaskId: string | null;
  globalSnapshot: GlobalDashboardSnapshot | null;
  globalFilters: GlobalDashboardFilter;
  globalBusy: boolean;
  globalError: string | null;
  globalPendingActionKey: string | null;
}

export const DEFAULT_CAPABILITY: ExecutionCapability = {
  status: "needs_config",
  message: "Open a workspace to configure scheduled prompts."
};

type Listener = (state: AppState) => void;

export class AppStateStore {
  private state: AppState = {
    activeTab: "workspace",
    workspacePath: null,
    tasks: [],
    runs: [],
    capability: DEFAULT_CAPABILITY,
    executionProfile: null,
    error: null,
    successMessage: null,
    busy: false,
    editingTaskId: null,
    highlightedTaskId: null,
    globalSnapshot: null,
    globalFilters: { sortBy: "urgency" },
    globalBusy: false,
    globalError: null,
    globalPendingActionKey: null
  };

  private readonly listeners = new Set<Listener>();

  get snapshot(): AppState {
    return this.state;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => this.listeners.delete(listener);
  }

  replace(nextState: AppState): void {
    this.state = nextState;
    this.emit();
  }

  patch(partial: Partial<AppState>): void {
    this.state = { ...this.state, ...partial };
    this.emit();
  }

  upsertTask(task: WorkspaceTask): void {
    const tasks = this.state.tasks.some((entry) => entry.id === task.id)
      ? this.state.tasks.map((entry) => (entry.id === task.id ? task : entry))
      : [task, ...this.state.tasks];
    this.patch({ tasks });
  }

  removeTask(taskId: string): void {
    this.patch({ tasks: this.state.tasks.filter((task) => task.id !== taskId) });
  }

  setRuns(runs: ScheduledRun[]): void {
    this.patch({ runs });
  }

  private emit(): void {
    for (const listener of this.listeners) {
      listener(this.state);
    }
  }
}
