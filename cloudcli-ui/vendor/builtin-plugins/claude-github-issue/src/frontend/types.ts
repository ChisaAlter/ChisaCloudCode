export interface GithubIssue {
  id: number;
  number: number;
  title: string;
  body: string | null;
  state: 'open' | 'closed';
  labels: Array<{ id: number; name: string; color: string }>;
  assignees: Array<{ login: string; avatar_url: string }>;
  created_at: string;
  updated_at: string;
  html_url: string;
  columnId?: string;
  user: { login: string; avatar_url: string };
  comments: number;
  milestone?: { number: number; title: string } | null;
}

export interface GithubColumn {
  id: string;
  name: string;
  labels: string[];
  color?: string;
}

export interface GithubComment {
  id: number;
  body: string;
  user: { login: string; avatar_url: string };
  created_at: string;
}

export interface IssuesData {
  issues: GithubIssue[];
  columns: GithubColumn[];
}

export interface PluginAPI {
  context: {
    theme: 'dark' | 'light';
    project: { name: string; path: string } | null;
    session: { id: string; title: string } | null;
  };
  rpc(method: string, path: string, body?: unknown): Promise<unknown>;
  onContextChange(cb: () => void): () => void;
}

// Column definitions with display metadata
export interface ColumnDef {
  id: string;
  title: string;
  state: 'open' | 'closed';
  labels: string[];
  accentColor: string;
  bgColor: string;
}

export const STATUS_LABELS = ['in-progress', 'review', 'blocked', 'deferred', 'cancelled'];

export const COLUMNS: ColumnDef[] = [
  { id: 'todo',        title: 'To Do',       state: 'open',   labels: [],              accentColor: '#64748b', bgColor: 'rgba(100,116,139,0.1)' },
  { id: 'in-progress', title: 'In Progress', state: 'open',   labels: ['in-progress'], accentColor: '#0ea5e9', bgColor: 'rgba(14,165,233,0.08)' },
  { id: 'review',      title: 'In Review',   state: 'open',   labels: ['review'],      accentColor: '#8b5cf6', bgColor: 'rgba(139,92,246,0.08)' },
  { id: 'blocked',     title: 'Blocked',     state: 'open',   labels: ['blocked'],     accentColor: '#ef4444', bgColor: 'rgba(239,68,68,0.08)' },
  { id: 'done',        title: 'Done',        state: 'closed', labels: [],              accentColor: '#10b981', bgColor: 'rgba(16,185,129,0.08)' },
];

function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m || !m[1]) return null;
  const n = parseInt(m[1], 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

// Recolor the status columns from their defining label's real GitHub color, so the
// board matches the Plan-tab label tints and the label chips (single color source).
// Columns with no defining label (To Do, Done) keep their built-in defaults.
export function resolveColumns(issues: GithubIssue[]): ColumnDef[] {
  const labelColors = new Map<string, string>();
  for (const issue of issues) {
    for (const l of issue.labels) {
      const key = l.name.toLowerCase();
      if (!labelColors.has(key) && /^[0-9a-f]{6}$/i.test(l.color)) labelColors.set(key, l.color);
    }
  }
  return COLUMNS.map(col => {
    const key = col.labels[0]?.toLowerCase();
    const hex = key ? labelColors.get(key) : undefined;
    if (!hex) return col;
    const rgb = hexToRgb(hex);
    return {
      ...col,
      accentColor: `#${hex}`,
      bgColor: rgb ? `rgba(${rgb.r},${rgb.g},${rgb.b},0.08)` : col.bgColor,
    };
  });
}

export function issueToColumnId(issue: GithubIssue): string {
  if (issue.state === 'closed') return 'done';
  const labelNames = issue.labels.map(l => l.name);
  for (const col of COLUMNS) {
    if (col.labels.length > 0 && col.labels.some(l => labelNames.includes(l))) {
      return col.id;
    }
  }
  return 'todo';
}

export interface PlanPhase {
  title: string;
  milestoneNumber: number | null;
  total: number;
  closed: number;
  issues: GithubIssue[];
}

export interface PlanData {
  phases: PlanPhase[];
}

// Compute the FINAL label set client-side (we already hold the issue's labels) and
// send it as an explicit `labels` array. This lets the backend PATCH in a single
// GitHub call — no extra getIssue round-trip to read current labels first.
export function columnChangePatch(issue: GithubIssue, toId: string): {
  state: string;
  labels: string[];
} | null {
  const toCol = COLUMNS.find(c => c.id === toId);
  if (!toCol) return null;

  const remove = new Set(STATUS_LABELS.filter(l => !toCol.labels.includes(l)));
  const current = issue.labels.map(l => l.name);
  const labels = [...new Set([...current.filter(n => !remove.has(n)), ...toCol.labels])];
  return { state: toCol.state, labels };
}
