/**
 * Pure helpers shared by the PRISM plugin backend.
 *
 * Kept free of I/O so they can be unit-tested with node:test against the
 * compiled output in dist/.
 */

// ── Report types (mirror `prism analyze --json` output) ────────────────

export interface PrismDimension {
  grade: string;
  score: number;
  [extra: string]: unknown;
}

export interface PrismIssue {
  severity: string;
  category: string;
  description: string;
}

export interface PrismReport {
  project: string;
  display_name: string;
  session_count: number;
  overall_grade: string;
  overall_score: number;
  dimensions: Record<string, PrismDimension>;
  top_issues: PrismIssue[];
  agentsview_health?: unknown;
}

// ── CLI argument construction ──────────────────────────────────────────

/** Build the argv for `prism analyze --json`, optionally scoped to a project. */
export function buildAnalyzeArgs(projectPath?: string): string[] {
  const args = ['analyze', '--json'];
  if (projectPath) {
    args.push('--project', projectPath);
  }
  return args;
}

// ── Output parsing ─────────────────────────────────────────────────────

/** Extract the version number from `prism --version` output. */
export function parseVersion(stdout: string): string | null {
  const match = stdout.match(/prism\s+v(\S+)/);
  return match ? match[1] : null;
}

/**
 * Parse the JSON array printed by `prism analyze --json`.
 *
 * The CLI prints through a rich console, so we locate the outermost array
 * in case any stray output surrounds it.
 */
export function parseReports(stdout: string): PrismReport[] {
  const start = stdout.indexOf('[');
  const end = stdout.lastIndexOf(']');
  if (start === -1 || end <= start) {
    throw new Error('prism returned no JSON report');
  }
  const parsed: unknown = JSON.parse(stdout.slice(start, end + 1));
  if (!Array.isArray(parsed)) {
    throw new Error('prism returned unexpected JSON');
  }
  return parsed as PrismReport[];
}
