import path from 'path';
import { promises as fs } from 'fs';

const PLAN_FILE = '.GitHubBoard/plan.json';
// Reserved (non-numeric) key holding the manual phase ordering — a list of
// milestone titles. Never collides with issue-number keys, so it rides along
// in the same file without a separate store.
const PHASE_ORDER_KEY = '__phaseOrder__';

export interface PlanEntry {
  order: number;
  phase?: string;
}

export interface PlanStore {
  [issueNumber: string]: PlanEntry;
}

/** Read the raw JSON object (issue map + reserved keys). {} on missing/corrupt. */
async function readRaw(projectPath: string): Promise<Record<string, unknown>> {
  if (!projectPath) return {};
  const filePath = path.join(projectPath, PLAN_FILE);
  try {
    const content = await fs.readFile(filePath, 'utf8');
    const parsed = JSON.parse(content) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed as Record<string, unknown>;
  } catch {
    return {};
  }
}

async function writeRaw(projectPath: string, obj: Record<string, unknown>): Promise<void> {
  if (!projectPath) throw new Error('projectPath required');
  const dir = path.join(projectPath, '.GitHubBoard');
  await fs.mkdir(dir, { recursive: true });
  const filePath = path.join(projectPath, PLAN_FILE);
  await fs.writeFile(filePath, JSON.stringify(obj, null, 2), 'utf8');
}

/** Read the order store (issue entries only). Returns {} if missing or corrupt. */
export async function readPlan(projectPath: string): Promise<PlanStore> {
  const raw = await readRaw(projectPath);
  const store: PlanStore = {};
  for (const [k, v] of Object.entries(raw)) {
    if (k === PHASE_ORDER_KEY) continue;
    if (v && typeof v === 'object' && typeof (v as PlanEntry).order === 'number') {
      store[k] = v as PlanEntry;
    }
  }
  return store;
}

/** Read the manual phase order — list of milestone titles, top-first. */
export async function readPhaseOrder(projectPath: string): Promise<string[]> {
  const raw = await readRaw(projectPath);
  const v = raw[PHASE_ORDER_KEY];
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

/** Persist the manual phase order (preserves the issue map). */
export async function setPhaseOrder(projectPath: string, titles: string[]): Promise<void> {
  const raw = await readRaw(projectPath);
  raw[PHASE_ORDER_KEY] = titles;
  await writeRaw(projectPath, raw);
}

/**
 * Persist a new order for one phase: the given issue numbers get order 0..n-1
 * and (optionally) their phase tag updated. Other issues + reserved keys untouched.
 */
export async function setOrder(
  projectPath: string,
  phase: string | null,
  issueNumbers: number[]
): Promise<PlanStore> {
  const raw = await readRaw(projectPath);
  issueNumbers.forEach((num, idx) => {
    const key = String(num);
    const existing = raw[key] as PlanEntry | undefined;
    raw[key] = { order: idx, phase: phase ?? existing?.phase };
  });
  await writeRaw(projectPath, raw);
  return readPlan(projectPath);
}
