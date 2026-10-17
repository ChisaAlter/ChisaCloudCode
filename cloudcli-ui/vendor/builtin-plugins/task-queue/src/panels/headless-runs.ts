import type { ThemeColors, HeadlessRun, HeadlessRunDetail } from '../types.ts';
import { escHtml, ago, statusColor, MONO } from './styles.ts';

/**
 * The Headless runs section — a read-only view of agent runs that had no operator
 * watching them.
 *
 * It sits below the task list in the same tab, deliberately: these runs went unnoticed
 * for days precisely because their output lived somewhere nobody opened. A separate tab
 * would reproduce that.
 */
interface HeadlessRunsOptions {
  runs: HeadlessRun[];
  /** Loaded detail for the open run, if any. */
  selectedRun: HeadlessRunDetail | null;
  selectedRunId: string | null;
  agentFilter: string;
  colors: ThemeColors;
  onAgentFilterChange: (agent: string) => void;
  onSelect: (id: string) => void;
  onBack: () => void;
  onCopy: (text: string) => void;
}

/**
 * The outcome column. Three distinct states, never collapsed:
 *
 *   ''                          no run record — this run predates them; nothing is known
 *   'running'                   a record with no `ended`
 *   run.outcome                 'exit 0' | 'exit 137' | 'ended, exit code unknown' | …
 *
 * The middle phrase of the third is the one that must survive review. Rendering an
 * unrecoverable exit code as "ok" is exactly the counter-reporting-success failure the
 * run record was added to expose.
 */
function outcomeText(run: Pick<HeadlessRun, 'has_record' | 'outcome'>): string {
  if (!run.has_record) return 'no run record';
  return run.outcome ?? 'running';
}

function outcomeColor(run: HeadlessRun, c: ThemeColors): string {
  if (!run.has_record) return c.muted;
  if (run.outcome === null) return c.accent;             // still running
  if (run.exit_code === 0) return c.muted;               // ordinary success, not shouted
  if (run.exit_code !== null) return c.warn;             // a real non-zero code
  return c.muted;                                        // honestly unknown
}

function formatDuration(seconds: number | null): string {
  // An unknown duration reads as unknown. Rendering it as 0s would claim the run was
  // instantaneous, which is a different and false statement.
  if (seconds === null) return '—';
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${m}m ${seconds % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

export function renderHeadlessRuns(parent: HTMLElement, opts: HeadlessRunsOptions): void {
  const { runs, colors: c } = opts;
  const visible = opts.agentFilter ? runs.filter(r => r.agent === opts.agentFilter) : runs;

  const section = document.createElement('div');
  section.style.cssText = `margin-top:28px;padding-top:16px;border-top:1px solid ${c.border};`;

  // ── Heading ───────────────────────────────────────────────────────────
  // Visually subordinate to the task list: this is a status surface, not the tab's
  // primary object.
  const head = document.createElement('div');
  head.style.cssText = 'display:flex;align-items:baseline;gap:10px;margin-bottom:4px;';
  head.innerHTML = `
    <span style="font-size:13px;font-weight:600;color:${c.text}">Headless runs</span>
    <span style="color:${c.muted};font-size:11px">${
      opts.agentFilter ? `${visible.length} of ${runs.length}` : `${runs.length} recorded`
    }</span>
  `;
  section.appendChild(head);

  const blurb = document.createElement('div');
  blurb.style.cssText = `color:${c.muted};font-size:11px;margin-bottom:12px;line-height:1.5;`;
  blurb.textContent =
    'Agent sessions launched without an operator watching. Each one wrote its final '
    + 'output to a log; this is that output. Status comes from the task queue, not from '
    + 'the log — a finished run whose task is still open is worth noticing. Outcome comes '
    + 'from the run record, and "exit code unknown" is a real answer: a dispatcher tick '
    + 'does not outlive the session it starts, so there is no code left to read.';
  section.appendChild(blurb);

  if (opts.selectedRunId && opts.selectedRun) {
    renderDetail(section, opts);
  } else if (opts.selectedRunId) {
    const loading = document.createElement('div');
    loading.style.cssText = `color:${c.muted};font-size:12px;padding:16px;`;
    loading.textContent = 'Loading run…';
    section.appendChild(loading);
  } else {
    renderList(section, opts, visible);
  }

  parent.appendChild(section);
}

// ── List ────────────────────────────────────────────────────────────────

function renderList(section: HTMLElement, opts: HeadlessRunsOptions, visible: HeadlessRun[]): void {
  const { runs, colors: c } = opts;

  // Agent options come from ALL runs, not the visible ones — otherwise selecting an
  // agent would empty the list it was chosen from and strand the operator there.
  const agents = [...new Set(runs.map(r => r.agent))].sort();
  if (agents.length > 1 || opts.agentFilter) {
    const bar = document.createElement('div');
    bar.style.cssText = 'display:flex;gap:8px;align-items:center;margin-bottom:10px;';

    const label = document.createElement('span');
    label.style.cssText = `color:${c.muted};font-size:11px;`;
    label.textContent = 'agent';
    bar.appendChild(label);

    const select = document.createElement('select');
    select.style.cssText = `background:${c.surface};color:${c.text};border:1px solid ${c.border};`
      + `border-radius:3px;padding:2px 6px;font-size:11px;font-family:${MONO};`;
    for (const [value, text] of [['', 'all'], ...agents.map(a => [a, a])]) {
      const o = document.createElement('option');
      o.value = value;
      o.textContent = text;
      if (value === opts.agentFilter) o.selected = true;
      select.appendChild(o);
    }
    select.addEventListener('change', () => opts.onAgentFilterChange(select.value));
    bar.appendChild(select);
    section.appendChild(bar);
  }

  if (visible.length === 0) {
    const empty = document.createElement('div');
    empty.style.cssText = `color:${c.muted};font-size:12px;padding:16px;`
      + `background:${c.surface};border:1px solid ${c.border};border-radius:4px;`;
    empty.textContent = opts.agentFilter
      ? `No headless runs recorded for ${opts.agentFilter}.`
      : 'No headless runs recorded.';
    section.appendChild(empty);
    return;
  }

  for (const run of visible) {
    section.appendChild(renderRow(run, opts));
  }
}

function renderRow(run: HeadlessRun, opts: HeadlessRunsOptions): HTMLElement {
  const c = opts.colors;

  const row = document.createElement('div');
  row.style.cssText = `display:flex;align-items:center;gap:10px;padding:7px 10px;`
    + `border:1px solid ${c.border};border-radius:4px;margin-bottom:4px;`
    + `background:${c.surface};cursor:pointer;font-size:11px;`;
  row.addEventListener('mouseenter', () => { row.style.borderColor = c.accent; });
  row.addEventListener('mouseleave', () => { row.style.borderColor = c.border; });
  row.addEventListener('click', () => opts.onSelect(run.id));

  row.innerHTML = `
    <span style="color:${c.accent};font-weight:600;min-width:72px">${escHtml(run.agent)}</span>
    <span style="color:${c.muted};min-width:70px">${escHtml(run.task_id8)}</span>
    <span style="color:${statusColor(run.status, c)};min-width:96px">${escHtml(run.status)}</span>
    <span style="color:${c.muted};min-width:64px">${escHtml(ago(run.started))}</span>
    <span style="color:${c.muted};min-width:56px">${escHtml(formatDuration(run.duration_s))}</span>
    <span style="color:${outcomeColor(run, c)};min-width:150px">${escHtml(outcomeText(run))}</span>
  `;

  // The first line is agent stdout. textContent, never innerHTML.
  const first = document.createElement('span');
  first.style.cssText = `color:${c.text};flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;`;
  first.textContent = run.first_line;
  row.appendChild(first);

  return row;
}

// ── Detail ──────────────────────────────────────────────────────────────

function renderDetail(section: HTMLElement, opts: HeadlessRunsOptions): void {
  const c = opts.colors;
  const run = opts.selectedRun as HeadlessRunDetail;

  const back = document.createElement('button');
  back.textContent = '← all runs';
  back.style.cssText = `background:transparent;color:${c.accent};border:none;cursor:pointer;`
    + `font-size:11px;font-family:${MONO};padding:0;margin-bottom:10px;`;
  back.addEventListener('click', opts.onBack);
  section.appendChild(back);

  const meta = document.createElement('div');
  meta.style.cssText = 'display:flex;gap:10px;align-items:center;margin-bottom:10px;font-size:11px;';
  meta.innerHTML = `
    <span style="color:${c.accent};font-weight:600">${escHtml(run.agent)}</span>
    <span style="color:${c.muted}">${escHtml(run.task_id ?? run.task_id8)}</span>
    <span style="color:${statusColor(run.status, c)}">${escHtml(run.status)}</span>
    <span style="color:${c.muted}">${escHtml(outcomeText(run))}</span>
    ${run.launched_by ? `<span style="color:${c.muted}">via ${escHtml(run.launched_by)}</span>` : ''}
  `;
  section.appendChild(meta);

  // A run whose log this UI may not read still renders — it is a real run the operator
  // asked about. Saying where the output is beats an empty pane or a 404.
  if (!run.log_readable) {
    const note = document.createElement('div');
    note.style.cssText = `color:${c.warn};font-size:11px;margin-bottom:10px;padding:10px;`
      + `background:${c.surface};border:1px solid ${c.border};border-radius:4px;line-height:1.5;`;
    note.textContent = run.log_path
      ? `This run's output is not readable from here. It is at: ${run.log_path}`
      : 'This run left no readable log in the launch directory.';
    section.appendChild(note);
    return;
  }

  // ── Commands ──
  // Omitted entirely when there are none, rather than rendered as an empty header.
  if (run.commands.length > 0) {
    const wrap = document.createElement('div');
    wrap.style.cssText = `margin-bottom:12px;padding:10px;background:${c.dim};`
      + `border:1px solid ${c.border};border-radius:4px;`;

    const title = document.createElement('div');
    title.style.cssText = `color:${c.text};font-size:11px;font-weight:600;margin-bottom:8px;`;
    title.textContent = `Commands (${run.commands.length})`;
    wrap.appendChild(title);

    for (const cmd of run.commands) {
      const line = document.createElement('div');
      line.style.cssText = 'display:flex;gap:8px;align-items:flex-start;margin-bottom:6px;';

      const code = document.createElement('pre');
      code.style.cssText = `flex:1;margin:0;padding:6px 8px;background:${c.surface};`
        + `border:1px solid ${c.border};border-radius:3px;color:${c.text};font-size:11px;`
        + `font-family:${MONO};white-space:pre-wrap;word-break:break-all;`;
      code.textContent = cmd;   // scraped from the log — never innerHTML
      line.appendChild(code);

      const copy = document.createElement('button');
      copy.textContent = 'copy';
      copy.style.cssText = `background:transparent;color:${c.muted};border:1px solid ${c.border};`
        + `border-radius:3px;padding:3px 8px;font-size:10px;cursor:pointer;font-family:${MONO};`;
      copy.addEventListener('click', () => opts.onCopy(cmd));
      line.appendChild(copy);

      wrap.appendChild(line);
    }
    section.appendChild(wrap);
  }

  if (run.truncated) {
    const note = document.createElement('div');
    note.style.cssText = `color:${c.warn};font-size:11px;margin-bottom:6px;`;
    note.textContent = 'Output truncated — showing the first 512 KB of this log.';
    section.appendChild(note);
  }

  const body = document.createElement('pre');
  body.style.cssText = `margin:0;padding:12px;background:${c.surface};border:1px solid ${c.border};`
    + `border-radius:4px;color:${c.text};font-size:11px;font-family:${MONO};`
    + 'white-space:pre-wrap;word-break:break-word;max-height:460px;overflow-y:auto;';
  body.textContent = run.text;   // agent stdout — textContent, never innerHTML
  section.appendChild(body);
}
