export type PriorityLevel = 'high' | 'medium' | 'low';

export interface IssuePriority {
  number: number;
  priority: PriorityLevel;
  score: number;
  reason: string;
}

const HIGH_PATTERNS = ['p0', 'critical', 'blocker', 'urgent', 'security', 'vulnerability', 'crash', 'data-loss', 'high-priority', 'priority:high', 'priority-high', 'high'];
const MEDIUM_PATTERNS = ['p1', 'medium-priority', 'priority:medium', 'priority-medium', 'important', 'medium'];
const LOW_PATTERNS = ['p2', 'p3', 'low-priority', 'priority:low', 'priority-low', 'nice-to-have', 'minor', 'low'];

export function detectPriorityFromLabels(labels: Array<{ name: string }>): PriorityLevel | null {
  const names = labels.map(l => l.name.toLowerCase());
  if (names.some(n => HIGH_PATTERNS.some(p => n === p || n.includes(p)))) return 'high';
  if (names.some(n => MEDIUM_PATTERNS.some(p => n === p || n.includes(p)))) return 'medium';
  if (names.some(n => LOW_PATTERNS.some(p => n === p || n.includes(p)))) return 'low';
  return null;
}

export type SortOption = 'number' | 'updated' | 'created' | 'comments' | 'title' | 'priority';

const PRIORITY_ORDER: Record<string, number> = { high: 0, medium: 1, low: 2, unknown: 3 };

export function getEffectivePriority(
  issue: { number: number; labels: Array<{ name: string }> },
  priorityMap: Map<number, IssuePriority>
): PriorityLevel | null {
  return priorityMap.get(issue.number)?.priority ?? detectPriorityFromLabels(issue.labels);
}

export function sortIssues<T extends {
  number: number;
  title: string;
  comments: number;
  created_at: string;
  updated_at: string;
  labels: Array<{ name: string }>;
}>(
  issues: T[],
  sortBy: SortOption,
  sortDir: 'asc' | 'desc',
  priorityMap: Map<number, IssuePriority>
): T[] {
  return [...issues].sort((a, b) => {
    let cmp = 0;
    switch (sortBy) {
      case 'number': cmp = b.number - a.number; break;
      case 'updated': cmp = Date.parse(b.updated_at) - Date.parse(a.updated_at); break;
      case 'created': cmp = Date.parse(b.created_at) - Date.parse(a.created_at); break;
      case 'comments': cmp = b.comments - a.comments; break;
      case 'title': cmp = a.title.localeCompare(b.title); break;
      case 'priority': {
        const pa = getEffectivePriority(a, priorityMap) ?? 'unknown';
        const pb = getEffectivePriority(b, priorityMap) ?? 'unknown';
        cmp = (PRIORITY_ORDER[pa] ?? 3) - (PRIORITY_ORDER[pb] ?? 3);
        break;
      }
    }
    return sortDir === 'asc' ? -cmp : cmp;
  });
}
