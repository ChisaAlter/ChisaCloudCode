import type { CreateTaskRequest } from "../../shared/contracts.js";
import type {
  DailyRecurrenceDefinition,
  MonthlyRecurrenceDefinition,
  OneTimeRecurrenceDefinition,
  RecurrenceDefinition,
  ScheduleType,
  WeekdayName,
  WeekdaysRecurrenceDefinition,
  WeeklyRecurrenceDefinition,
  WorkspaceTask
} from "../../shared/model.js";
import { formatRecurrenceSummary, nextOccurrenceForRecurrence, validateRecurrenceDefinition } from "../../server/recurrence.js";

export interface TaskFormHandlers {
  onSubmit(request: Omit<CreateTaskRequest, "workspacePath">): void;
  onCancelEdit(): void;
}

const WEEKDAYS: WeekdayName[] = [
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday"
];

function titleCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function recurrenceFields(task: WorkspaceTask | null): string {
  const recurrence = task?.recurrence;
  const scheduleType = recurrence?.scheduleType ?? "daily";
  const timezone = recurrence?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const localTime =
    recurrence &&
    "localTime" in recurrence &&
    typeof recurrence.localTime === "string"
      ? recurrence.localTime
      : "09:00";
  const runAt = recurrence?.scheduleType === "one_time" ? recurrence.runAt : "";
  const weekdays = recurrence?.scheduleType === "weekdays" ? recurrence.weekdays : ["monday", "tuesday", "wednesday", "thursday", "friday"];
  const dayOfWeek = recurrence?.scheduleType === "weekly" ? recurrence.dayOfWeek : "monday";
  const dayOfMonth = recurrence?.scheduleType === "monthly" ? recurrence.dayOfMonth : 1;

  return `
    <div class="wsp-field">
      <label for="wsp-schedule-type">Schedule Type</label>
      <select id="wsp-schedule-type" name="scheduleType">
        <option value="one_time"${scheduleType === "one_time" ? " selected" : ""}>One-time</option>
        <option value="daily"${scheduleType === "daily" ? " selected" : ""}>Daily</option>
        <option value="weekdays"${scheduleType === "weekdays" ? " selected" : ""}>Selected weekdays</option>
        <option value="weekly"${scheduleType === "weekly" ? " selected" : ""}>Weekly</option>
        <option value="monthly"${scheduleType === "monthly" ? " selected" : ""}>Monthly</option>
      </select>
      <p>Choose when this prompt should run in the current workspace.</p>
    </div>
    <div class="wsp-field">
      <label for="wsp-timezone">Timezone</label>
      <input id="wsp-timezone" name="timezone" value="${timezone}" placeholder="Europe/Paris">
      <p>IANA timezone used to compute the next run.</p>
    </div>
    <div class="wsp-field" data-schedule-scope="timed">
      <label for="wsp-local-time">Local Time</label>
      <input id="wsp-local-time" name="localTime" value="${localTime}" placeholder="09:00" inputmode="numeric">
      <p>24-hour local time for recurring schedules.</p>
    </div>
    <div class="wsp-field" data-schedule-scope="one_time">
      <label for="wsp-run-at">Run At</label>
      <input id="wsp-run-at" name="runAt" value="${runAt}" placeholder="2026-04-26T09:00:00.000Z">
      <p>Absolute ISO timestamp for a single execution.</p>
    </div>
    <div class="wsp-field wsp-field-span-2" data-schedule-scope="weekdays">
      <label>Weekdays</label>
      <div class="wsp-checkbox-group">
        ${WEEKDAYS.map((weekday) => `
          <label class="wsp-checkbox">
            <input type="checkbox" name="weekday" value="${weekday}"${weekdays.includes(weekday) ? " checked" : ""}>
            <span>${titleCase(weekday.slice(0, 3))}</span>
          </label>
        `).join("")}
      </div>
      <p>Only the checked days will trigger this prompt.</p>
    </div>
    <div class="wsp-field" data-schedule-scope="weekly">
      <label for="wsp-day-of-week">Day Of Week</label>
      <select id="wsp-day-of-week" name="dayOfWeek">
        ${WEEKDAYS.map((weekday) => `
          <option value="${weekday}"${dayOfWeek === weekday ? " selected" : ""}>${titleCase(weekday)}</option>
        `).join("")}
      </select>
      <p>The run happens every week on this weekday.</p>
    </div>
    <div class="wsp-field" data-schedule-scope="monthly">
      <label for="wsp-day-of-month">Day Of Month</label>
      <input id="wsp-day-of-month" name="dayOfMonth" value="${dayOfMonth}" type="number" min="1" max="31">
      <p>If the day does not exist in a month, it clamps to the last day.</p>
    </div>
  `;
}

function buildRecurrence(formData: FormData): RecurrenceDefinition {
  const scheduleType = String(formData.get("scheduleType") ?? "daily") as ScheduleType;
  const timezone = String(formData.get("timezone") ?? "").trim();
  const localTime = String(formData.get("localTime") ?? "").trim();

  switch (scheduleType) {
    case "one_time":
      return {
        scheduleType,
        timezone,
        runAt: String(formData.get("runAt") ?? "").trim()
      } satisfies OneTimeRecurrenceDefinition;
    case "daily":
      return { scheduleType, timezone, localTime } satisfies DailyRecurrenceDefinition;
    case "weekdays":
      return {
        scheduleType,
        timezone,
        localTime,
        weekdays: formData.getAll("weekday")
          .map((entry) => String(entry).trim())
          .filter(Boolean) as WeekdayName[]
      } satisfies WeekdaysRecurrenceDefinition;
    case "weekly":
      return {
        scheduleType,
        timezone,
        localTime,
        dayOfWeek: String(formData.get("dayOfWeek") ?? "").trim() as WeekdayName
      } satisfies WeeklyRecurrenceDefinition;
    case "monthly":
      return {
        scheduleType,
        timezone,
        localTime,
        dayOfMonth: Number(formData.get("dayOfMonth") ?? 1),
        monthlyOverflowPolicy: "clamp_to_last_day"
      } satisfies MonthlyRecurrenceDefinition;
    default:
      throw new Error("Unsupported schedule type");
  }
}

function summarizeDraft(recurrence: RecurrenceDefinition): string {
  const nextRunAt = nextOccurrenceForRecurrence(recurrence);
  return `${formatRecurrenceSummary(recurrence)}${nextRunAt ? ` | Next run: ${nextRunAt}` : " | Next run: unavailable"}`;
}

export function renderTaskForm(task: WorkspaceTask | null, handlers: TaskFormHandlers): HTMLElement {
  const section = document.createElement("section");
  section.className = "task-form";
  section.innerHTML = `
    <div class="wsp-section-heading">
      <h2>${task ? "Edit Schedule" : "Create Schedule"}</h2>
      <p>${task ? "Update the prompt or cadence, then save the schedule." : "Define the prompt, cadence, and timezone for this workspace."}</p>
    </div>
    <form class="wsp-form">
      <div class="wsp-panel">
        <div class="wsp-panel-title">Prompt</div>
        <div class="wsp-field">
          <label for="wsp-name">Name</label>
          <input id="wsp-name" name="name" value="${task?.name ?? ""}" required placeholder="Morning summary">
          <p>Short label shown in the schedule list.</p>
        </div>
        <div class="wsp-field">
          <label for="wsp-prompt">Prompt</label>
          <textarea id="wsp-prompt" name="prompt" rows="6" required placeholder="Summarize the workspace and highlight blockers.">${task?.prompt ?? ""}</textarea>
          <p>The exact prompt sent when the job runs.</p>
        </div>
      </div>

      <div class="wsp-panel">
        <div class="wsp-panel-title">Timing</div>
        <div class="wsp-form-grid">
          ${recurrenceFields(task)}
        </div>
      </div>

      <div class="wsp-panel">
        <div class="wsp-panel-title">Validation</div>
        <p class="wsp-feedback" data-testid="task-form-feedback" role="alert"></p>
        <div class="wsp-preview" data-testid="task-form-preview"></div>
        <p class="wsp-preview-note">Saving creates or updates the job immediately in this workspace.</p>
      </div>

      <div class="wsp-form-actions">
        <button type="submit">${task ? "Save Schedule" : "Create Schedule"}</button>
        ${task ? '<button type="button" data-testid="cancel-edit" class="wsp-secondary-button">Cancel</button>' : ""}
      </div>
    </form>
  `;

  const form = section.querySelector("form");
  if (!form) {
    throw new Error("Task form failed to render");
  }

  const feedback = section.querySelector<HTMLElement>('[data-testid="task-form-feedback"]');
  const preview = section.querySelector<HTMLElement>('[data-testid="task-form-preview"]');
  const cancel = section.querySelector<HTMLButtonElement>('[data-testid="cancel-edit"]');

  if (!feedback || !preview) {
    throw new Error("Task form feedback elements failed to render");
  }

  const syncVisibility = (): void => {
    const scheduleType = String(new FormData(form).get("scheduleType") ?? "daily") as ScheduleType;
    const toggle = (scope: string, visible: boolean): void => {
      form.querySelectorAll<HTMLElement>(`[data-schedule-scope="${scope}"]`).forEach((node) => {
        node.hidden = !visible;
      });
    };

    toggle("timed", scheduleType !== "one_time");
    toggle("one_time", scheduleType === "one_time");
    toggle("weekdays", scheduleType === "weekdays");
    toggle("weekly", scheduleType === "weekly");
    toggle("monthly", scheduleType === "monthly");
  };

  const refreshPreview = (): RecurrenceDefinition | null => {
    syncVisibility();
    feedback.textContent = "";
    const formData = new FormData(form);
    const name = String(formData.get("name") ?? "").trim();
    const prompt = String(formData.get("prompt") ?? "").trim();

    if (!name || !prompt) {
      preview.textContent = "Complete the name and prompt to preview this schedule.";
      return null;
    }

    try {
      const recurrence = buildRecurrence(formData);
      validateRecurrenceDefinition(recurrence);
      preview.textContent = summarizeDraft(recurrence);
      return recurrence;
    } catch (error) {
      preview.textContent = "Preview unavailable.";
      feedback.textContent = error instanceof Error ? error.message : "Invalid schedule.";
      return null;
    }
  };

  form.addEventListener("input", () => {
    refreshPreview();
  });

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const formData = new FormData(form);
    const name = String(formData.get("name") ?? "").trim();
    const prompt = String(formData.get("prompt") ?? "").trim();

    if (!name || !prompt) {
      feedback.textContent = "Name and prompt are required.";
      return;
    }

    const recurrence = refreshPreview();
    if (!recurrence) {
      return;
    }

    handlers.onSubmit({ name, prompt, recurrence });
  });

  cancel?.addEventListener("click", () => handlers.onCancelEdit());
  refreshPreview();

  return section;
}
