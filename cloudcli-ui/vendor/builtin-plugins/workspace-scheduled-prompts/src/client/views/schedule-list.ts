import type { WorkspaceTask } from "../../shared/model.js";

export interface ScheduleListHandlers {
  onEdit(taskId: string): void;
  onDelete(taskId: string): void;
  onPause(taskId: string): void;
  onResume(taskId: string): void;
  onDuplicate(taskId: string): void;
  onRunNow(taskId: string): void;
}

function confirmDelete(taskName: string): boolean {
  if (typeof globalThis.confirm !== "function") {
    return true;
  }

  return globalThis.confirm(`Delete schedule "${taskName}"?`);
}

export function renderScheduleList(
  tasks: WorkspaceTask[],
  handlers: ScheduleListHandlers,
  highlightedTaskId: string | null = null
): HTMLElement {
  const section = document.createElement("section");
  section.className = "schedule-list";
  section.innerHTML = "<h2>Schedules</h2>";

  if (!tasks.length) {
    const empty = document.createElement("p");
    empty.textContent = "No scheduled prompts yet.";
    section.append(empty);
    return section;
  }

  const list = document.createElement("ul");
  for (const task of tasks) {
    const item = document.createElement("li");
    if (task.id === highlightedTaskId) {
      item.setAttribute("data-highlighted", "true");
      item.style.outline = "2px solid var(--wsp-success)";
      item.style.outlineOffset = "2px";
    }
    item.innerHTML = `
      <div class="wsp-task-head">
        <div>
          <strong>${task.name}</strong>
          <p>${task.recurrenceSummary}</p>
        </div>
        <span class="wsp-status-chip">${task.enabled ? "Enabled" : "Paused"}</span>
      </div>
      <div class="wsp-task-meta">
        <span>Next run: ${task.nextRunAt ?? "Not scheduled"}</span>
        <span>Last status: ${task.lastRunStatus ?? "None yet"}</span>
        ${task.id === highlightedTaskId ? "<span>Saved just now.</span>" : ""}
      </div>
    `;

    const controls = document.createElement("div");
    controls.className = "wsp-inline-actions";
    const edit = document.createElement("button");
    edit.textContent = "Edit";
    edit.addEventListener("click", () => handlers.onEdit(task.id));
    controls.append(edit);

    const toggle = document.createElement("button");
    toggle.textContent = task.enabled ? "Pause" : "Resume";
    toggle.addEventListener("click", () => (task.enabled ? handlers.onPause(task.id) : handlers.onResume(task.id)));
    controls.append(toggle);

    const duplicate = document.createElement("button");
    duplicate.textContent = "Duplicate";
    duplicate.addEventListener("click", () => handlers.onDuplicate(task.id));
    controls.append(duplicate);

    const runNow = document.createElement("button");
    runNow.textContent = "Run Now";
    runNow.addEventListener("click", () => handlers.onRunNow(task.id));
    controls.append(runNow);

    const remove = document.createElement("button");
    remove.textContent = "Delete";
    remove.addEventListener("click", () => {
      if (!confirmDelete(task.name)) {
        return;
      }
      handlers.onDelete(task.id);
    });
    controls.append(remove);

    item.append(controls);
    list.append(item);
  }

  section.append(list);
  return section;
}
