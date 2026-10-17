import type { ThemeColors, DeadLetter } from '../types.ts';
import { escHtml, ago, MONO } from './styles.ts';
import { groupByReason } from '../dead-letters.ts';

/**
 * The Dead letters section — tasks task-dispatcher gave up routing.
 *
 * COLLAPSED BY DEFAULT, and a section rather than a tab. The healthy count here is zero,
 * so a tab would be permanently empty furniture and an always-expanded block would be a
 * permanent scroll cost. What it must never be is *absent*: seventeen dropped security
 * audits accumulated over three months precisely because no surface in the fleet had a
 * place to put this number. The heading renders whatever the count is, including 0, and
 * turns red the moment it is not.
 *
 * Grouped by failure reason. Seventeen records with one identical `failed_reason` are one
 * bug that fired seventeen times; rendering them as seventeen sibling rows reproduces the
 * reading that let them sit.
 */
interface DeadLettersOptions {
  deadLetters: DeadLetter[];
  /** The API's page limit cut the read, so the count below is a floor. */
  truncated: boolean;
  expanded: boolean;
  colors: ThemeColors;
  onToggle: () => void;
  onRequeue: (taskId: string, summary: string) => void;
}

export function renderDeadLetters(parent: HTMLElement, opts: DeadLettersOptions): void {
  const { deadLetters, colors: c } = opts;
  const count = deadLetters.length;

  const section = document.createElement('div');
  section.style.cssText = `margin-top:28px;padding-top:16px;border-top:1px solid ${c.border};`;

  // ── Heading (always rendered, count and all) ──────────────────────────
  const head = document.createElement('div');
  head.style.cssText = 'display:flex;align-items:baseline;gap:10px;cursor:pointer;';
  head.addEventListener('click', opts.onToggle);

  const caret = document.createElement('span');
  caret.style.cssText = `color:${c.muted};font-size:11px;width:10px;`;
  caret.textContent = opts.expanded ? '▾' : '▸';
  head.appendChild(caret);

  const title = document.createElement('span');
  title.style.cssText = `font-size:13px;font-weight:600;color:${c.text}`;
  title.textContent = 'Dead letters';
  head.appendChild(title);

  const badge = document.createElement('span');
  badge.style.cssText = `font-size:11px;color:${count > 0 ? c.error : c.muted}`;
  badge.textContent = count === 0
    ? 'none'
    : `${count} dropped · ${groupByReason(deadLetters).length} distinct reason${
        groupByReason(deadLetters).length === 1 ? '' : 's'
      }`;
  if (opts.truncated) badge.textContent += ' · truncated, there may be more';
  head.appendChild(badge);

  section.appendChild(head);

  if (!opts.expanded) {
    parent.appendChild(section);
    return;
  }

  const blurb = document.createElement('div');
  blurb.style.cssText = `color:${c.muted};font-size:11px;margin:8px 0 12px;line-height:1.5;`;
  blurb.textContent =
    'Tasks the dispatcher gave up routing after exhausting its retries. Nothing will pick '
    + 'one up and no agent can transition it. Requeue sends it back to the queue at '
    + 'submitted — it does not fix why it was dropped, so if the cause is still live it '
    + 'will come back here.';
  section.appendChild(blurb);

  if (count === 0) {
    const empty = document.createElement('div');
    empty.style.cssText = `color:${c.muted};font-size:12px;padding:16px;`
      + `background:${c.surface};border:1px solid ${c.border};border-radius:4px;`;
    empty.textContent = 'No dead letters. Nothing has been dropped.';
    section.appendChild(empty);
    parent.appendChild(section);
    return;
  }

  for (const group of groupByReason(deadLetters)) {
    section.appendChild(renderGroup(group.reason, group.count, group.letters, opts));
  }

  parent.appendChild(section);
}

function renderGroup(
  reason: string,
  count: number,
  letters: DeadLetter[],
  opts: DeadLettersOptions,
): HTMLElement {
  const c = opts.colors;

  const wrap = document.createElement('div');
  wrap.style.cssText = `margin-bottom:12px;border:1px solid ${c.border};border-radius:4px;`
    + `background:${c.surface};overflow:hidden;`;

  const header = document.createElement('div');
  header.style.cssText = `padding:8px 10px;background:${c.dim};display:flex;gap:10px;`
    + 'align-items:baseline;font-size:11px;';

  const n = document.createElement('span');
  n.style.cssText = `color:${c.error};font-weight:600;min-width:24px;`;
  n.textContent = `${count}×`;
  header.appendChild(n);

  // The reason is dispatcher-authored text. textContent, never innerHTML.
  const why = document.createElement('span');
  why.style.cssText = `color:${c.text};flex:1;word-break:break-word;`;
  why.textContent = reason;
  header.appendChild(why);

  wrap.appendChild(header);

  for (const dl of letters) {
    wrap.appendChild(renderRow(dl, opts));
  }
  return wrap;
}

function renderRow(dl: DeadLetter, opts: DeadLettersOptions): HTMLElement {
  const c = opts.colors;

  const row = document.createElement('div');
  row.style.cssText = `display:flex;align-items:center;gap:10px;padding:7px 10px;`
    + `border-top:1px solid ${c.border};font-size:11px;`;

  row.innerHTML = `
    <span style="color:${c.accent};font-weight:600;min-width:72px">${escHtml(dl.target_agent)}</span>
    <span style="color:${c.muted};min-width:70px">${escHtml(dl.id.slice(0, 8))}</span>
    <span style="color:${c.muted};min-width:56px">${escHtml(dl.task_type)}</span>
    <span style="color:${c.muted};min-width:74px">${escHtml(ageOf(dl))}</span>
    <span style="color:${c.muted};min-width:64px">${escHtml(`${dl.retry_count} retries`)}</span>
  `;

  // Agent-authored text. textContent, never innerHTML.
  const summary = document.createElement('span');
  summary.style.cssText = `color:${c.text};flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;`;
  summary.textContent = dl.summary;
  row.appendChild(summary);

  const requeue = document.createElement('button');
  requeue.textContent = 'requeue';
  requeue.style.cssText = `background:transparent;color:${c.warn};border:1px solid ${c.border};`
    + `border-radius:3px;padding:3px 8px;font-size:10px;cursor:pointer;font-family:${MONO};`;
  requeue.addEventListener('click', () => opts.onRequeue(dl.id, dl.summary));
  row.appendChild(requeue);

  return row;
}

/**
 * How long ago the task DIED, falling back to when it was created.
 *
 * `ago` returns 'just now' for an unparseable date, which on this surface would read as a
 * task that failed seconds ago when in fact its timestamp is missing. An unknown age reads
 * as unknown.
 */
function ageOf(dl: DeadLetter): string {
  const stamp = dl.failed_at || dl.created;
  if (!stamp || Number.isNaN(Date.parse(stamp))) return '—';
  return ago(stamp);
}
