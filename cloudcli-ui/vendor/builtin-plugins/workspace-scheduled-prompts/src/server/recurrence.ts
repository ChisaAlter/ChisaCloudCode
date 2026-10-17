import { DateTime } from "luxon";
import type {
  MonthlyRecurrenceDefinition,
  RecurrenceDefinition,
  WeekdayName,
  WorkspaceTask
} from "../shared/model.js";

const WEEKDAY_TO_INDEX: Record<WeekdayName, number> = {
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
  sunday: 7
};

function requireValidZone(timezone: string): void {
  const sample = DateTime.now().setZone(timezone);
  if (!sample.isValid) {
    throw new Error(`Invalid timezone: ${timezone}`);
  }
}

function parseLocalTime(localTime: string): { hour: number; minute: number } {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(localTime);
  if (!match) {
    throw new Error("localTime must be formatted as HH:mm");
  }

  return { hour: Number(match[1]), minute: Number(match[2]) };
}

function candidateAt(date: any, localTime: string): any {
  const { hour, minute } = parseLocalTime(localTime);
  return date.set({ hour, minute, second: 0, millisecond: 0 });
}

function lastDayOfMonth(year: number, month: number, timezone: string): number {
  return DateTime.fromObject({ year, month, day: 1 }, { zone: timezone }).endOf("month").day;
}

function resolveMonthlyDay(definition: MonthlyRecurrenceDefinition, year: number, month: number): number {
  const maxDay = lastDayOfMonth(year, month, definition.timezone);
  return Math.min(definition.dayOfMonth, maxDay);
}

export function validateRecurrenceDefinition(recurrence: RecurrenceDefinition): void {
  requireValidZone(recurrence.timezone);

  switch (recurrence.scheduleType) {
    case "one_time": {
      const instant = DateTime.fromISO(recurrence.runAt, { zone: "utc" });
      if (!instant.isValid) {
        throw new Error("runAt must be a valid ISO timestamp");
      }
      return;
    }
    case "daily":
      parseLocalTime(recurrence.localTime);
      return;
    case "weekdays":
      parseLocalTime(recurrence.localTime);
      if (!recurrence.weekdays.length) {
        throw new Error("weekday schedules require at least one weekday");
      }
      for (const weekday of recurrence.weekdays) {
        if (!(weekday in WEEKDAY_TO_INDEX)) {
          throw new Error(`Invalid weekday: ${weekday}`);
        }
      }
      return;
    case "weekly":
      parseLocalTime(recurrence.localTime);
      if (!(recurrence.dayOfWeek in WEEKDAY_TO_INDEX)) {
        throw new Error("weekly schedules require a valid dayOfWeek");
      }
      return;
    case "monthly":
      parseLocalTime(recurrence.localTime);
      if (!Number.isInteger(recurrence.dayOfMonth) || recurrence.dayOfMonth < 1 || recurrence.dayOfMonth > 31) {
        throw new Error("monthly schedules require a dayOfMonth between 1 and 31");
      }
      return;
    default:
      throw new Error("Unsupported schedule type");
  }
}

export function nextOccurrenceForRecurrence(
  recurrence: RecurrenceDefinition,
  afterIso: string = new Date().toISOString()
): string | null {
  validateRecurrenceDefinition(recurrence);
  const afterUtc = DateTime.fromISO(afterIso, { zone: "utc" });
  const zoned = afterUtc.setZone(recurrence.timezone);

  switch (recurrence.scheduleType) {
    case "one_time": {
      const runAt = DateTime.fromISO(recurrence.runAt, { zone: "utc" });
      return runAt > afterUtc ? runAt.toUTC().toISO() : null;
    }
    case "daily": {
      let candidate = candidateAt(zoned, recurrence.localTime);
      if (candidate <= zoned) {
        candidate = candidate.plus({ days: 1 });
      }
      return candidate.toUTC().toISO();
    }
    case "weekdays": {
      const allowed = new Set(recurrence.weekdays.map((weekday) => WEEKDAY_TO_INDEX[weekday]));
      for (let offset = 0; offset <= 14; offset += 1) {
        const day = zoned.plus({ days: offset });
        if (!allowed.has(day.weekday)) {
          continue;
        }
        const candidate = candidateAt(day, recurrence.localTime);
        if (candidate > zoned) {
          return candidate.toUTC().toISO();
        }
      }
      return null;
    }
    case "weekly": {
      const targetWeekday = WEEKDAY_TO_INDEX[recurrence.dayOfWeek];
      for (let offset = 0; offset <= 14; offset += 1) {
        const day = zoned.plus({ days: offset });
        if (day.weekday !== targetWeekday) {
          continue;
        }
        const candidate = candidateAt(day, recurrence.localTime);
        if (candidate > zoned) {
          return candidate.toUTC().toISO();
        }
      }
      return null;
    }
    case "monthly": {
      for (let offset = 0; offset <= 24; offset += 1) {
        const monthDate = zoned.plus({ months: offset }).startOf("month");
        const day = resolveMonthlyDay(recurrence, monthDate.year, monthDate.month);
        const candidate = candidateAt(monthDate.set({ day }), recurrence.localTime);
        if (candidate > zoned) {
          return candidate.toUTC().toISO();
        }
      }
      return null;
    }
    default:
      return null;
  }
}

export function formatRecurrenceSummary(recurrence: RecurrenceDefinition): string {
  switch (recurrence.scheduleType) {
    case "one_time":
      return `One-time at ${DateTime.fromISO(recurrence.runAt, { zone: "utc" })
        .setZone(recurrence.timezone)
        .toFormat("yyyy-LL-dd HH:mm")} (${recurrence.timezone})`;
    case "daily":
      return `Daily at ${recurrence.localTime} (${recurrence.timezone})`;
    case "weekdays":
      return `${recurrence.weekdays.join(", ")} at ${recurrence.localTime} (${recurrence.timezone})`;
    case "weekly":
      return `Every ${recurrence.dayOfWeek} at ${recurrence.localTime} (${recurrence.timezone})`;
    case "monthly":
      return `Monthly on day ${recurrence.dayOfMonth} at ${recurrence.localTime} (${recurrence.timezone})`;
    default:
      return "Unknown recurrence";
  }
}

export function computeTaskNextRun(task: WorkspaceTask, afterIso?: string): string | null {
  if (!task.enabled) {
    return null;
  }
  return nextOccurrenceForRecurrence(task.recurrence, afterIso);
}

export function occurrenceKeyForTask(taskId: string, scheduledFor: string): string {
  return `${taskId}:${scheduledFor}`;
}
