import React from 'react';
import type { GithubIssue, ColumnDef } from './types';
import type { IssuePriority } from './priorityUtils';
import { GithubIssueCard } from './GithubIssueCard';

interface Props {
  column: ColumnDef;
  issues: GithubIssue[];
  priorityMap: Map<number, IssuePriority>;
  collapsed: boolean;
  onToggle: () => void;
  onOpenIssue: (issue: GithubIssue) => void;
  onMoveIssue: (issueNumber: number, newColumnId: string) => void;
}

export const GithubKanbanColumn: React.FC<Props> = ({ column, issues, priorityMap, collapsed, onToggle, onOpenIssue, onMoveIssue }) => {
  const [isDragOver, setIsDragOver] = React.useState(false);
  const dragCounter = React.useRef(0);

  const handleDragEnter = (e: React.DragEvent) => {
    e.preventDefault();
    dragCounter.current++;
    setIsDragOver(true);
  };

  const handleDragLeave = () => {
    dragCounter.current--;
    if (dragCounter.current === 0) setIsDragOver(false);
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    dragCounter.current = 0;
    setIsDragOver(false);
    try {
      const { issueNumber, fromColumnId } = JSON.parse(e.dataTransfer.getData('text/plain'));
      if (fromColumnId !== column.id) {
        onMoveIssue(issueNumber, column.id);
      }
    } catch {}
  };

  const dragStyle = isDragOver ? {
    boxShadow: `0 0 0 2px ${column.accentColor}`,
    background: `${column.bgColor}`,
  } : {};

  return (
    <div
      className="cgi-column"
      style={{ background: column.bgColor, ...dragStyle }}
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      <div
        className="cgi-column-header"
        style={{ color: column.accentColor, borderBottom: `1px solid ${column.accentColor}30` }}
        onClick={onToggle}
        title={collapsed ? `Expand ${column.title}` : `Collapse ${column.title}`}
      >
        {!collapsed && (
          <>
            <span>{column.title}</span>
            <span className="cgi-column-count">{issues.length}</span>
            <span className="cgi-column-toggle">▲</span>
          </>
        )}
        {collapsed && (
          <span className="cgi-column-toggle" style={{ margin: '0 auto' }}>▼</span>
        )}
      </div>

      {collapsed ? (
        <div
          className="cgi-column-body"
          style={{ alignItems: 'center', cursor: 'pointer' }}
          onClick={onToggle}
        >
          <span className="cgi-column-collapsed-label" style={{ color: column.accentColor }}>
            {column.title} ({issues.length})
          </span>
        </div>
      ) : (
        <div className={`cgi-column-body${isDragOver ? ' cgi-column-body--drag-over' : ''}`}>
          {issues.length === 0 ? (
            <div className={`cgi-column-empty${isDragOver ? ' cgi-column-empty--drag-over' : ''}`} style={{ color: column.accentColor }}>
              {isDragOver ? '↓ Drop here' : 'No issues'}
            </div>
          ) : (
            issues.map(issue => (
              <GithubIssueCard
                key={issue.id}
                issue={issue}
                priority={priorityMap.get(issue.number)?.priority ?? null}
                priorityReason={priorityMap.get(issue.number)?.reason}
                columnId={column.id}
                onClick={() => onOpenIssue(issue)}
              />
            ))
          )}
        </div>
      )}
    </div>
  );
};
