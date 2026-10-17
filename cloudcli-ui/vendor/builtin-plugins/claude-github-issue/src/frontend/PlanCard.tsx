import React from 'react';
import type { GithubIssue } from './types';
import { STATUS_LABELS } from './types';
import { detectPriorityFromLabels } from './priorityUtils';

const PRIORITY_COLORS: Record<string, string> = {
  high: '#ef4444', medium: '#f59e0b', low: '#6b7280',
};

function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m || !m[1]) return null;
  const n = parseInt(m[1], 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

// Pick the label that should tint the card: bug first (most actionable), then the
// first non-status label. Status labels (in-progress/review/…) drive column/state,
// not the tint, so they are skipped here.
function primaryLabel(labels: GithubIssue['labels']) {
  const nonStatus = labels.filter(l => !STATUS_LABELS.includes(l.name.toLowerCase()));
  return nonStatus.find(l => l.name.toLowerCase() === 'bug') ?? nonStatus[0] ?? null;
}

interface PlanCardProps {
  issue: GithubIssue;
  index: number;
  count: number;
  onOpen: (issue: GithubIssue) => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onDragStart: () => void;
  onDragOver: (e: React.DragEvent) => void;
  onDrop: () => void;
}

export const PlanCard: React.FC<PlanCardProps> = ({
  issue, index, count, onOpen, onMoveUp, onMoveDown, onDragStart, onDragOver, onDrop,
}) => {
  const priority = detectPriorityFromLabels(issue.labels);
  const isBug = issue.labels.some(l => l.name.toLowerCase() === 'bug');
  const done = issue.state === 'closed';
  // In the board's "In Review" column = the `review` label ONLY (needs-testing can
  // coexist with a To-Do ticket, so it is NOT a done-signal). Mark these distinctly
  // so already-implemented work isn't accidentally picked up for rework.
  const inReview = !done && issue.labels.some(l => l.name.toLowerCase() === 'review');

  // Tint the whole card with the primary label's GitHub color (same colors as the
  // Issues Board chips) — same treatment as the bespoke review-green fill, generalized.
  // `done` (dimmed) and `inReview` (green) keep their semantic styling untouched.
  const tinted = !done && !inReview ? primaryLabel(issue.labels) : null;
  const rgb = tinted ? hexToRgb(tinted.color) : null;
  const tintStyle = rgb
    ? { background: `rgba(${rgb.r},${rgb.g},${rgb.b},0.12)`, borderColor: `rgba(${rgb.r},${rgb.g},${rgb.b},0.5)` }
    : undefined;

  return (
    <div
      className={`cgi-plan-card${done ? ' done' : ''}${inReview ? ' in-review' : ''}`}
      style={tintStyle}
      draggable
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      <span className="cgi-plan-drag" title="Drag to reorder">⠿</span>
      {priority && (
        <span className="cgi-plan-dot" style={{ background: PRIORITY_COLORS[priority] }} />
      )}
      <button className="cgi-plan-card-main" onClick={() => onOpen(issue)}>
        <span className="cgi-plan-num">#{issue.number}</span>
        <span className="cgi-plan-title">{issue.title}</span>
        {inReview && <span className="cgi-plan-review" title="Zrobione — czeka na weryfikację/zamknięcie">✓ w review</span>}
        {isBug && <span className="cgi-plan-bug">bug</span>}
      </button>
      <span className="cgi-plan-reorder">
        <button className="cgi-plan-arrow" disabled={index === 0} onClick={onMoveUp} title="Move up">▲</button>
        <button className="cgi-plan-arrow" disabled={index === count - 1} onClick={onMoveDown} title="Move down">▼</button>
      </span>
    </div>
  );
};
