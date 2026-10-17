import React from 'react';
import type { GithubIssue } from './types';
import { STATUS_LABELS } from './types';
import type { PriorityLevel } from './priorityUtils';
import { extractImages } from './imageUtils';

interface Props {
  issue: GithubIssue;
  priority: PriorityLevel | null;
  priorityReason?: string;
  columnId: string;
  onClick: () => void;
}

const PRIORITY_COLORS: Record<PriorityLevel, string> = {
  high: '#ef4444',
  medium: '#f59e0b',
  low: '#6b7280',
};

function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m || !m[1]) return null;
  const n = parseInt(m[1], 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

function labelTextColor(hex: string): string {
  const rgb = hexToRgb(hex);
  if (!rgb) return '#000000';
  const lum = 0.299 * rgb.r + 0.587 * rgb.g + 0.114 * rgb.b;
  return lum > 140 ? '#000000' : '#ffffff';
}

export const GithubIssueCard: React.FC<Props> = ({ issue, priority, priorityReason, columnId, onClick }) => {
  const visibleLabels = issue.labels.filter(l => !STATUS_LABELS.includes(l.name));
  const images = issue.body ? extractImages(issue.body) : [];
  const previewImages = images.slice(0, 3);
  const [dragging, setDragging] = React.useState(false);

  const handleDragStart = (e: React.DragEvent) => {
    e.dataTransfer.setData('text/plain', JSON.stringify({ issueNumber: issue.number, fromColumnId: columnId }));
    e.dataTransfer.effectAllowed = 'move';
    setDragging(true);
  };

  return (
    <div
      className={`cgi-card${dragging ? ' cgi-card--dragging' : ''}`}
      onClick={onClick}
      role="button"
      tabIndex={0}
      draggable
      onDragStart={handleDragStart}
      onDragEnd={() => setDragging(false)}
      onKeyDown={e => e.key === 'Enter' && onClick()}
    >
      {previewImages.length > 0 && (
        <div className="cgi-card-thumbs">
          {previewImages.map((img, i) => (
            <img
              key={i}
              src={img.url}
              alt={img.alt || 'image'}
              className="cgi-card-thumb"
              loading="lazy"
            />
          ))}
          {images.length > 3 && (
            <span className="cgi-card-thumb-more">+{images.length - 3}</span>
          )}
        </div>
      )}
      <div className="cgi-card-title-row">
        {priority && (
          <span
            className="cgi-priority-dot"
            style={{ background: PRIORITY_COLORS[priority] }}
            title={priorityReason ? `${priority}: ${priorityReason}` : priority}
          />
        )}
        <div className="cgi-card-title">{issue.title}</div>
      </div>
      <div className="cgi-card-meta">
        <span className="cgi-card-number">#{issue.number}</span>
        {issue.assignees.map(a => (
          <img
            key={a.login}
            src={a.avatar_url}
            alt={a.login}
            title={a.login}
            className="cgi-avatar"
          />
        ))}
        {issue.comments > 0 && (
          <span className="cgi-card-comments">
            <svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor">
              <path d="M1 2.75C1 1.784 1.784 1 2.75 1h10.5c.966 0 1.75.784 1.75 1.75v7.5A1.75 1.75 0 0 1 13.25 12H9.06l-2.573 2.573A1.458 1.458 0 0 1 4 13.543V12H2.75A1.75 1.75 0 0 1 1 10.25Zm1.75-.25a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h2a.75.75 0 0 1 .75.75v2.19l2.72-2.72a.749.749 0 0 1 .53-.22h4.5a.25.25 0 0 0 .25-.25v-7.5a.25.25 0 0 0-.25-.25Z" />
            </svg>
            {issue.comments}
          </span>
        )}
      </div>
      {visibleLabels.length > 0 && (
        <div className="cgi-card-labels">
          {visibleLabels.map(l => {
            const bg = `#${l.color}`;
            const color = labelTextColor(l.color);
            return (
              <span
                key={l.id}
                className="cgi-label-chip"
                style={{ background: bg, color }}
              >
                {l.name}
              </span>
            );
          })}
        </div>
      )}
    </div>
  );
};
