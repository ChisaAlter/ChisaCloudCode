import type { ThemeColors, Task } from '../types.ts';
import { escHtml, ago, statusColor, priorityColor, MONO } from './styles.ts';
import {
  NON_TERMINAL_STATUSES,
  WORKFLOW_MODE_DISPLAY,
  isTerminal,
  isWorkflowMode,
} from '../vocabulary.ts';

interface TaskDetailOptions {
  task: Task;
  contextPreviews: Map<string, string>;
  colors: ThemeColors;
  onBack: () => void;
  onApprove: (taskId: string) => void;
  onStart: (taskId: string, mode: 'review' | 'auto') => void;
  onCancel: (taskId: string) => void;
  onPark: (taskId: string) => void;
  onUnpark: (taskId: string) => void;
  onAmend: (taskId: string) => void;
  onSetStatus: (taskId: string, status: string) => void;
  /**
   * Set when a headless launch log exists for this task. This is the affordance that
   * answers "did that run finish and hand off?" from where the operator already is,
   * rather than requiring them to scroll to the runs section and match ids by eye.
   */
  onOpenRun?: () => void;
}

export function renderTaskDetail(container: HTMLElement, opts: TaskDetailOptions): void {
  const { task, contextPreviews, colors: c, onBack, onApprove, onStart, onCancel, onPark, onUnpark, onAmend, onSetStatus } = opts;
  const isParked = task.status === 'parked';

  const sc = statusColor(task.status, c);
  const priority = task.payload.priority ?? 'normal';
  const pc = priorityColor(priority, c);
  // Absent on tasks queued before task-queue-mcp wrote the field. Rendered as unknown
  // rather than as the queue's default — this panel reports what the record says.
  const mode = task.workflow_mode;
  const modeDisplay = isWorkflowMode(mode) ? WORKFLOW_MODE_DISPLAY[mode] : null;

  const wrapper = document.createElement('div');
  wrapper.className = 'tq-up';
  const { onOpenRun } = opts;

  // Back button
  const backBtn = document.createElement('button');
  backBtn.textContent = '\u2190 Back';
  Object.assign(backBtn.style, {
    background: 'transparent', color: c.muted, border: 'none',
    cursor: 'pointer', fontSize: '12px', fontFamily: MONO,
    padding: '4px 0', marginBottom: '12px',
  });
  backBtn.addEventListener('click', onBack);
  wrapper.appendChild(backBtn);

  // Header
  const header = document.createElement('div');
  header.style.cssText = `margin-bottom:16px;`;
  header.innerHTML = `
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:8px">
      <span style="color:${c.muted};font-size:12px">${escHtml(task.id)}</span>
      <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${sc}"></span>
      <span style="color:${sc};font-size:13px;font-weight:600">${escHtml(task.status)}</span>
    </div>
    <div style="font-size:15px;font-weight:600;margin-bottom:8px">${escHtml(task.summary)}</div>
  `;
  wrapper.appendChild(header);

  if (onOpenRun) {
    const runLink = document.createElement('button');
    runLink.textContent = 'view run output \u2192';
    runLink.style.cssText = `background:transparent;color:${c.accent};border:1px solid ${c.border};`
      + `border-radius:3px;padding:3px 10px;font-size:11px;font-family:${MONO};cursor:pointer;`
      + 'margin-bottom:12px;';
    runLink.addEventListener('click', onOpenRun);
    wrapper.appendChild(runLink);
  }

  // Metadata grid
  const meta = document.createElement('div');
  meta.style.cssText = `display:grid;grid-template-columns:120px 1fr;gap:4px 12px;font-size:12px;margin-bottom:16px;padding:12px;background:${c.surface};border:1px solid ${c.border};border-radius:4px;`;
  meta.innerHTML = `
    <span style="color:${c.muted}">Source</span><span>${escHtml(task.source_agent)}</span>
    <span style="color:${c.muted}">Target</span><span>${escHtml(task.target_agent)}</span>
    <span style="color:${c.muted}">Type</span><span>${escHtml(task.task_type)}</span>
    <span style="color:${c.muted}">Priority</span><span style="color:${pc}">${escHtml(priority)}</span>
    <span style="color:${c.muted}">Risk</span><span>${escHtml(task.risk_level)}</span>
    <span style="color:${c.muted}">Approval</span><span>${task.requires_approval ? 'required' : 'auto'}</span>
    <span style="color:${c.muted}">Mode</span><span>${
      modeDisplay
        ? `<span style="color:${c[modeDisplay.tone]}">${escHtml(mode as string)}</span>`
          + ` <span style="color:${c.muted};font-size:11px">— ${escHtml(modeDisplay.hint)}</span>`
        : `<span style="color:${c.muted}">${mode ? escHtml(mode) + ' (not a known mode)' : 'not recorded'}</span>`
    }</span>
    <span style="color:${c.muted}">Created</span><span>${ago(task.created)} <span style="color:${c.muted}">(${new Date(task.created).toLocaleString()})</span></span>
    <span style="color:${c.muted}">TTL</span><span>${task.ttl_days}d</span>
  `;
  wrapper.appendChild(meta);

  // Action buttons
  const actions = document.createElement('div');
  actions.style.cssText = 'display:flex;gap:8px;margin-bottom:16px;';

  if (task.status === 'approved') {
    actions.appendChild(makeActionButton('Start (Review)', c.accent, c, () => onStart(task.id, 'review')));
    actions.appendChild(makeActionButton('Start (Auto)', c.warn, c, () => onStart(task.id, 'auto')));
  }
  if (task.status === 'pending-approval' || task.status === 'submitted') {
    actions.appendChild(makeActionButton('Approve', c.ok, c, () => onApprove(task.id)));
  }
  // Lifecycle controls: cancel, park/unpark, and amend — all non-terminal only. Parking a
  // terminal task is meaningless, and amendments to a finished task have no reader.
  if (!isTerminal(task.status)) {
    actions.appendChild(makeActionButton('Cancel', c.error, c, () => onCancel(task.id)));
    actions.appendChild(
      isParked
        ? makeActionButton('Unpark', c.ok, c, () => onUnpark(task.id))
        : makeActionButton('Park', c.muted, c, () => onPark(task.id)),
    );
    actions.appendChild(makeActionButton('Amend', c.accent, c, () => onAmend(task.id)));
  }
  if (actions.childElementCount > 0) wrapper.appendChild(actions);

  // Parked banner — say plainly what parked means, so the status isn't just a colour.
  if (isParked) {
    const banner = document.createElement('div');
    banner.style.cssText = `padding:8px 12px;margin-bottom:16px;font-size:12px;background:${c.surface};border:1px dashed ${c.muted};border-radius:4px;color:${c.muted};`;
    banner.textContent = task.parked_from
      ? `Parked — nothing will pick this up until you unpark it. Unparking returns it to "${task.parked_from}".`
      : 'Parked — nothing will pick this up until you unpark it.';
    wrapper.appendChild(banner);
  }

  // Routing-failed banner. The status is written by the dispatcher when it cannot route a
  // task, and it backs off exponentially before retrying; after the retry budget the task
  // is dead-lettered. None of that is guessable from the word, and this is the status most
  // likely to want a human — say what it means and what happens next.
  if (task.status === 'routing-failed') {
    const policy = task.retry_policy ?? {};
    const attempts = typeof policy.retry_count === 'number' ? policy.retry_count : null;
    // An unparseable timestamp says so, rather than rendering the string "Invalid Date" at
    // an operator. Same rule as the launch-log birthtime handling: a date we cannot read is
    // reported as unknown, never dressed up as a real one.
    const nextAt = policy.next_retry_at ? new Date(policy.next_retry_at) : null;
    const next = nextAt && !Number.isNaN(nextAt.getTime()) ? nextAt.toLocaleString() : null;
    const nextUnreadable = !!policy.next_retry_at && next === null;
    const banner = document.createElement('div');
    banner.style.cssText = `padding:8px 12px;margin-bottom:16px;font-size:12px;background:${c.surface};border:1px solid ${c.error};border-left-width:3px;border-radius:4px;color:${c.text};`;
    banner.textContent =
      'Routing failed — the dispatcher could not hand this to its agent and is backing off. '
      + (attempts !== null ? `${attempts} retr${attempts === 1 ? 'y' : 'ies'} used. ` : '')
      + (next
        ? `Next attempt ${next}. `
        : nextUnreadable
          ? 'Its next-attempt time is unreadable. '
          : 'It will be retried on the next dispatcher pass. ')
      + 'When the retry budget runs out it is dead-lettered — see the dead-letters section.';
    wrapper.appendChild(banner);
  }

  // Status-change control — advance a task an agent missed (audited operator override).
  if (!isTerminal(task.status)) {
    const statusRow = document.createElement('div');
    statusRow.style.cssText = `display:flex;align-items:center;gap:8px;margin-bottom:16px;`;

    const label = document.createElement('span');
    label.style.cssText = `color:${c.muted};font-size:12px`;
    label.textContent = 'Set status';

    const select = document.createElement('select');
    select.style.cssText = `background:${c.surface};color:${c.text};border:1px solid ${c.border};border-radius:4px;padding:4px 8px;font-family:${MONO};font-size:12px;`;
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = 'advance to…';
    select.appendChild(placeholder);
    // Every non-terminal status, including `routing-failed`. Setting it by hand is not a
    // dead end: the dispatcher's routing-failed pass picks up any such task whose retry
    // window has passed, and a record with no `next_retry_at` is eligible immediately — so
    // this reads as "re-route now, skipping re-approval", which is a thing an operator
    // wants. The MCP accepts any non-terminal -> non-terminal move on the override path.
    for (const s of NON_TERMINAL_STATUSES) {
      if (s === task.status) continue;
      const opt = document.createElement('option');
      opt.value = s;
      opt.textContent = s;
      select.appendChild(opt);
    }
    select.addEventListener('change', () => {
      if (select.value) onSetStatus(task.id, select.value);
    });

    statusRow.appendChild(label);
    statusRow.appendChild(select);
    wrapper.appendChild(statusRow);
  }

  // Description
  if (task.payload.description) {
    const desc = document.createElement('div');
    desc.style.cssText = `margin-bottom:16px;`;
    desc.innerHTML = `
      <div style="color:${c.accent};font-size:12px;font-weight:600;margin-bottom:6px;text-transform:uppercase;letter-spacing:0.5px">Description</div>
      <pre style="white-space:pre-wrap;word-break:break-word;font-size:12px;line-height:1.5;padding:12px;background:${c.surface};border:1px solid ${c.border};border-radius:4px;margin:0;font-family:${MONO}">${escHtml(task.payload.description)}</pre>
    `;
    wrapper.appendChild(desc);
  }

  // Amendments — corrections that arrived after the task was queued. Rendered directly
  // below the description and visually distinct, because the whole point is that a reader
  // who only takes in the description would act on stale instructions.
  const amendments = task.payload.amendments ?? [];
  if (amendments.length > 0) {
    const amendBlock = document.createElement('div');
    amendBlock.style.cssText = 'margin-bottom:16px;';
    amendBlock.innerHTML = `<div style="color:${c.warn};font-size:12px;font-weight:600;margin-bottom:6px;text-transform:uppercase;letter-spacing:0.5px">Amendments (${amendments.length}) — read these, the description above is unchanged</div>`;

    for (const a of amendments) {
      const block = document.createElement('div');
      block.style.cssText = `margin-bottom:8px;padding:12px;background:${c.surface};border:1px solid ${c.warn};border-left-width:3px;border-radius:4px;`;
      block.innerHTML = `
        <div style="color:${c.muted};font-size:11px;margin-bottom:6px">
          ${escHtml(a.actor)} · ${ago(a.timestamp)}${a.reason ? ` · ${escHtml(a.reason)}` : ''}
        </div>
        <pre style="white-space:pre-wrap;word-break:break-word;font-size:12px;line-height:1.5;margin:0;font-family:${MONO}">${escHtml(a.text)}</pre>
      `;
      amendBlock.appendChild(block);
    }
    wrapper.appendChild(amendBlock);
  }

  // Context ref previews
  if (task.payload.context_refs && task.payload.context_refs.length > 0) {
    const refs = document.createElement('div');
    refs.style.cssText = 'margin-bottom:16px;';
    refs.innerHTML = `<div style="color:${c.accent};font-size:12px;font-weight:600;margin-bottom:6px;text-transform:uppercase;letter-spacing:0.5px">Context References</div>`;

    for (const ref of task.payload.context_refs) {
      const preview = contextPreviews.get(ref);
      const refBlock = document.createElement('div');
      refBlock.style.cssText = `margin-bottom:8px;`;
      refBlock.innerHTML = `
        <div style="color:${c.muted};font-size:11px;margin-bottom:4px">${escHtml(ref)}</div>
        ${preview
          ? `<pre style="white-space:pre-wrap;word-break:break-word;font-size:11px;line-height:1.4;padding:8px;background:${c.surface};border:1px solid ${c.border};border-radius:4px;margin:0;max-height:200px;overflow-y:auto;font-family:${MONO}">${escHtml(preview)}</pre>`
          : `<div style="color:${c.muted};font-size:11px;font-style:italic;padding:8px">Preview unavailable</div>`
        }
      `;
      refs.appendChild(refBlock);
    }
    wrapper.appendChild(refs);
  }

  // History timeline
  if (task.history.length > 0) {
    const hist = document.createElement('div');
    hist.innerHTML = `<div style="color:${c.accent};font-size:12px;font-weight:600;margin-bottom:6px;text-transform:uppercase;letter-spacing:0.5px">History</div>`;

    for (const entry of task.history) {
      // Non-status actions (amend) carry the same `status` as the task had at the time,
      // which would read as a redundant transition. Label the action instead.
      const label = entry.action ? entry.action : entry.status;
      const ec = entry.action ? c.warn : statusColor(entry.status, c);
      const line = document.createElement('div');
      line.style.cssText = `display:flex;gap:10px;align-items:flex-start;padding:4px 0;font-size:12px;border-left:2px solid ${c.border};padding-left:12px;margin-left:4px;`;
      line.innerHTML = `
        <span style="color:${c.muted};min-width:55px;font-size:11px">${ago(entry.timestamp)}</span>
        <span style="color:${ec};min-width:90px">${escHtml(label)}</span>
        <span style="color:${c.muted};min-width:70px">${escHtml(entry.actor)}</span>
        <span style="flex:1;color:${c.text}">${escHtml(entry.note || '')}</span>
      `;
      hist.appendChild(line);
    }
    wrapper.appendChild(hist);
  }

  // Result (if completed)
  if (task.result.output) {
    const result = document.createElement('div');
    result.style.cssText = 'margin-top:16px;';
    result.innerHTML = `
      <div style="color:${c.accent};font-size:12px;font-weight:600;margin-bottom:6px;text-transform:uppercase;letter-spacing:0.5px">Result</div>
      <pre style="white-space:pre-wrap;word-break:break-word;font-size:12px;line-height:1.5;padding:12px;background:${c.surface};border:1px solid ${c.border};border-radius:4px;margin:0;font-family:${MONO}">${escHtml(task.result.output)}</pre>
      ${task.result.completed_by ? `<div style="color:${c.muted};font-size:11px;margin-top:4px">Completed by ${escHtml(task.result.completed_by)} ${task.result.completed_at ? ago(task.result.completed_at) : ''}</div>` : ''}
    `;
    wrapper.appendChild(result);
  }

  container.appendChild(wrapper);
}

function makeActionButton(label: string, color: string, c: ThemeColors, onClick: () => void): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.textContent = label;
  Object.assign(btn.style, {
    background: 'transparent', color, border: `1px solid ${color}`, borderRadius: '4px',
    padding: '6px 16px', fontSize: '12px', cursor: 'pointer', fontFamily: MONO,
    transition: 'background 0.15s',
  });
  btn.addEventListener('mouseenter', () => { btn.style.background = c.dim; });
  btn.addEventListener('mouseleave', () => { btn.style.background = 'transparent'; });
  btn.addEventListener('click', onClick);
  return btn;
}
