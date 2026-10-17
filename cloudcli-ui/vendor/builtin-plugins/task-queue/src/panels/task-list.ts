import type { ThemeColors, Task } from '../types.ts';
import { escHtml, ago, statusColor, priorityColor, priorityIcon, MONO } from './styles.ts';
import {
  STATUS_ORDER,
  VALID_STATUSES,
  VALID_TASK_TYPES,
  VALID_WORKFLOW_MODES,
  WORKFLOW_MODE_DISPLAY,
  isTerminal,
  isWorkflowMode,
} from '../vocabulary.ts';

/**
 * The list's filter state. `mode` filters on `workflow_mode` — added with #543, because the
 * queue's three modes are the difference between "an operator has to press Start" and "this
 * and everything downstream of it runs unattended", and there was no way to ask which.
 */
export interface TaskFilters {
  agent: string;
  status: string;
  taskType: string;
  mode: string;
}

interface TaskListOptions {
  tasks: Task[];
  colors: ThemeColors;
  onSelect: (taskId: string) => void;
  onApprove: (taskId: string) => void;
  onStart: (taskId: string, mode: 'review' | 'auto') => void;
  onCancel: (taskId: string) => void;
  onPark: (taskId: string) => void;
  onUnpark: (taskId: string) => void;
  onAmend: (taskId: string) => void;
  onSetStatus: (taskId: string, status: string) => void;
  filters: TaskFilters;
  onFilterChange: (filters: TaskFilters) => void;
}

const PRIORITY_ORDER: Record<string, number> = {
  'urgent': 0,
  'high': 1,
  'normal': 2,
};

export function sortTasks(tasks: Task[]): Task[] {
  return [...tasks].sort((a, b) => {
    const pa = PRIORITY_ORDER[a.payload.priority ?? 'normal'] ?? 2;
    const pb = PRIORITY_ORDER[b.payload.priority ?? 'normal'] ?? 2;
    if (pa !== pb) return pa - pb;
    // The `?? 99` is for a status written by something newer than this build, not for one
    // the plugin knows about: STATUS_ORDER is keyed by the vocabulary, so a known status
    // without a position does not compile. `routing-failed` reaching this fallback and
    // sorting below `cancelled` is vikunja#558.
    const sa = STATUS_ORDER[a.status as keyof typeof STATUS_ORDER] ?? 99;
    const sb = STATUS_ORDER[b.status as keyof typeof STATUS_ORDER] ?? 99;
    if (sa !== sb) return sa - sb;
    return new Date(b.created).getTime() - new Date(a.created).getTime();
  });
}

function groupByAgent(tasks: Task[]): Map<string, Task[]> {
  const groups = new Map<string, Task[]>();
  for (const t of tasks) {
    const agent = t.target_agent;
    if (!groups.has(agent)) groups.set(agent, []);
    groups.get(agent)!.push(t);
  }
  return groups;
}

export function renderTaskList(container: HTMLElement, opts: TaskListOptions): void {
  const { tasks, colors: c, filters, onFilterChange, onSelect, onApprove, onStart, onCancel, onPark, onUnpark } = opts;

  // Collect unique values for filters
  const agents = [...new Set(tasks.map(t => t.target_agent))].sort();
  // Union the observed statuses with the known vocabulary, so `parked` is selectable even
  // when nothing is parked yet — otherwise a brand-new status is undiscoverable until the
  // operator has already used it somewhere else.
  const statuses = [...new Set([...tasks.map(t => t.status), ...VALID_STATUSES])].sort();
  const types = [...new Set([...tasks.map(t => t.task_type), ...VALID_TASK_TYPES])].sort();
  // Same union for modes. Not derived from the tasks alone: `manual-then-auto` exists to be
  // asked for, and until one is queued nothing would offer it (vikunja#543).
  const modes = [...new Set([
    ...tasks.map(t => t.workflow_mode).filter((m): m is string => !!m),
    ...VALID_WORKFLOW_MODES,
  ])].sort();

  // Apply filters
  let filtered = tasks;
  if (filters.agent) filtered = filtered.filter(t => t.target_agent === filters.agent);
  if (filters.status) filtered = filtered.filter(t => t.status === filters.status);
  if (filters.taskType) filtered = filtered.filter(t => t.task_type === filters.taskType);
  // A record with no `workflow_mode` matches no mode filter rather than being folded into
  // the queue's default. Older tasks predate the field; claiming they are `semi-auto` would
  // be this plugin inventing a value the queue never wrote.
  if (filters.mode) filtered = filtered.filter(t => t.workflow_mode === filters.mode);

  const sorted = sortTasks(filtered);
  const grouped = groupByAgent(sorted);

  // Filter bar
  const filterBar = document.createElement('div');
  Object.assign(filterBar.style, {
    display: 'flex', gap: '12px', marginBottom: '16px', flexWrap: 'wrap', alignItems: 'center',
  });

  const selectStyle = `background:${c.surface};color:${c.text};border:1px solid ${c.border};border-radius:4px;padding:4px 8px;font-family:${MONO};font-size:12px;`;

  filterBar.innerHTML = `
    <label style="color:${c.muted};font-size:12px">Agent
      <select id="tq-filter-agent" style="${selectStyle}">
        <option value="">all</option>
        ${agents.map(a => `<option value="${escHtml(a)}" ${filters.agent === a ? 'selected' : ''}>${escHtml(a)}</option>`).join('')}
      </select>
    </label>
    <label style="color:${c.muted};font-size:12px">Status
      <select id="tq-filter-status" style="${selectStyle}">
        <option value="">all</option>
        ${statuses.map(s => `<option value="${escHtml(s)}" ${filters.status === s ? 'selected' : ''}>${escHtml(s)}</option>`).join('')}
      </select>
    </label>
    <label style="color:${c.muted};font-size:12px">Type
      <select id="tq-filter-type" style="${selectStyle}">
        <option value="">all</option>
        ${types.map(t => `<option value="${escHtml(t)}" ${filters.taskType === t ? 'selected' : ''}>${escHtml(t)}</option>`).join('')}
      </select>
    </label>
    <label style="color:${c.muted};font-size:12px">Mode
      <select id="tq-filter-mode" style="${selectStyle}">
        <option value="">all</option>
        ${modes.map(m => `<option value="${escHtml(m)}" ${filters.mode === m ? 'selected' : ''}>${escHtml(m)}</option>`).join('')}
      </select>
    </label>
    <span style="color:${c.muted};font-size:11px;margin-left:auto">${filtered.length} of ${tasks.length} tasks</span>
  `;
  container.appendChild(filterBar);

  // Bind filter events
  for (const [id, key] of [
    ['tq-filter-agent', 'agent'],
    ['tq-filter-status', 'status'],
    ['tq-filter-type', 'taskType'],
    ['tq-filter-mode', 'mode'],
  ] as const) {
    const el = filterBar.querySelector(`#${id}`) as HTMLSelectElement;
    el?.addEventListener('change', () => {
      onFilterChange({ ...filters, [key]: el.value });
    });
  }

  // Task table grouped by agent
  if (grouped.size === 0) {
    const empty = document.createElement('div');
    empty.style.cssText = `color:${c.muted};text-align:center;padding:32px;font-size:13px;`;
    empty.textContent = 'No tasks match filters.';
    container.appendChild(empty);
    return;
  }

  for (const [agent, agentTasks] of grouped) {
    const group = document.createElement('div');
    group.className = 'tq-up';
    group.style.marginBottom = '20px';

    const header = document.createElement('div');
    header.style.cssText = `color:${c.accent};font-size:13px;font-weight:600;margin-bottom:8px;text-transform:uppercase;letter-spacing:0.5px;`;
    header.textContent = `${agent} (${agentTasks.length})`;
    group.appendChild(header);

    for (const task of agentTasks) {
      const row = document.createElement('div');
      const sc = statusColor(task.status, c);
      const priority = task.payload.priority ?? 'normal';
      const pIcon = priorityIcon(priority);
      const pColor = priorityColor(priority, c);

      const isParked = task.status === 'parked';

      Object.assign(row.style, {
        display: 'flex', alignItems: 'center', gap: '10px',
        padding: '8px 12px', marginBottom: '2px',
        background: c.surface, border: `1px solid ${c.border}`, borderRadius: '4px',
        cursor: 'pointer', fontSize: '12px', transition: 'border-color 0.15s',
        // Parked rows read as deliberately set aside: muted and dashed, still present.
        ...(isParked ? { opacity: '0.65', borderStyle: 'dashed' } : {}),
      });

      row.addEventListener('mouseenter', () => { row.style.borderColor = c.accent; });
      row.addEventListener('mouseleave', () => { row.style.borderColor = c.border; });
      row.addEventListener('click', () => onSelect(task.id));

      const shortId = task.id.slice(0, 8);

      // Mode marker, shown only when the mode changes what happens without an operator.
      // `semi-auto` is 98% of the queue and is what a reader already assumes; badging it
      // too would make the column noise instead of signal.
      const mode = task.workflow_mode;
      const modeBadge = isWorkflowMode(mode) && mode !== 'semi-auto'
        ? `<span style="color:${c[WORKFLOW_MODE_DISPLAY[mode].tone]};font-size:10px;border:1px solid currentColor;border-radius:3px;padding:0 4px;flex-shrink:0" title="${escHtml(WORKFLOW_MODE_DISPLAY[mode].hint)}">${escHtml(mode)}</span>`
        : '';

      row.innerHTML = `
        <span style="color:${c.muted};min-width:64px;font-size:11px" title="${escHtml(task.id)}">${escHtml(shortId)}</span>
        ${pIcon ? `<span style="color:${pColor};font-size:11px;font-weight:700;min-width:24px">${pIcon}</span>` : '<span style="min-width:24px"></span>'}
        <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${sc};flex-shrink:0" title="${escHtml(task.status)}"></span>
        <span style="color:${sc};min-width:90px;font-size:11px">${escHtml(task.status)}</span>
        <span style="color:${c.muted};min-width:60px;font-size:11px">${escHtml(task.task_type)}</span>
        ${modeBadge}
        <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${escHtml(task.summary)}">${escHtml(task.summary)}</span>
        <span style="color:${c.muted};font-size:11px;min-width:55px;text-align:right">${ago(task.created)}</span>
      `;

      // Action buttons (inline, prevent click propagation)
      const actions = document.createElement('span');
      actions.style.cssText = 'display:flex;gap:4px;flex-shrink:0;';

      if (task.status === 'approved') {
        const reviewBtn = makeButton('Review', c.accent, c, () => onStart(task.id, 'review'));
        const autoBtn = makeButton('Auto', c.warn, c, () => onStart(task.id, 'auto'));
        actions.appendChild(reviewBtn);
        actions.appendChild(autoBtn);
      }

      if (task.status === 'pending-approval' || task.status === 'submitted') {
        const approveBtn = makeButton('Approve', c.ok, c, () => onApprove(task.id));
        actions.appendChild(approveBtn);
      }

      // Lifecycle controls: cancel and park/unpark, non-terminal tasks only. Amend lives
      // in the detail view — it needs the description in front of you to write a useful one.
      if (!isTerminal(task.status)) {
        actions.appendChild(makeButton('Cancel', c.error, c, () => onCancel(task.id)));
        actions.appendChild(
          isParked
            ? makeButton('Unpark', c.ok, c, () => onUnpark(task.id))
            : makeButton('Park', c.muted, c, () => onPark(task.id)),
        );
      }

      row.appendChild(actions);
      group.appendChild(row);
    }

    container.appendChild(group);
  }
}

function makeButton(label: string, color: string, c: ThemeColors, onClick: () => void): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.textContent = label;
  Object.assign(btn.style, {
    background: 'transparent', color, border: `1px solid ${color}`, borderRadius: '3px',
    padding: '2px 8px', fontSize: '11px', cursor: 'pointer', fontFamily: MONO,
  });
  btn.addEventListener('mouseenter', () => { btn.style.background = c.dim; });
  btn.addEventListener('mouseleave', () => { btn.style.background = 'transparent'; });
  btn.addEventListener('click', (e) => { e.stopPropagation(); onClick(); });
  return btn;
}
