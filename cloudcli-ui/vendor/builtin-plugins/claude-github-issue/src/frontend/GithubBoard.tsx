import React from 'react';
import type { GithubIssue } from './types';
import { resolveColumns, issueToColumnId } from './types';
import type { IssuePriority } from './priorityUtils';
import { GithubKanbanColumn } from './GithubKanbanColumn';

interface Props {
  issues: GithubIssue[];
  priorityMap: Map<number, IssuePriority>;
  collapsedColumns: Set<string>;
  onToggleColumn: (id: string) => void;
  onMoveIssue: (issueNumber: number, newColumnId: string) => void;
  onOpenIssue: (issue: GithubIssue) => void;
}

// Collapsed columns as 52px vertical strips eat too much width on phones, so
// below this breakpoint they move out of the grid into a pill bar above it.
const MOBILE_MAX_WIDTH = 640;

function useIsMobile(): boolean {
  const query = `(max-width: ${MOBILE_MAX_WIDTH}px)`;
  const [isMobile, setIsMobile] = React.useState(
    () => typeof window !== 'undefined' && window.matchMedia(query).matches
  );
  React.useEffect(() => {
    if (typeof window === 'undefined') return;
    const mql = window.matchMedia(query);
    const handler = (e: MediaQueryListEvent) => setIsMobile(e.matches);
    setIsMobile(mql.matches);
    mql.addEventListener('change', handler);
    return () => mql.removeEventListener('change', handler);
  }, [query]);
  return isMobile;
}

export const GithubBoard: React.FC<Props> = ({
  issues,
  priorityMap,
  collapsedColumns,
  onToggleColumn,
  onMoveIssue,
  onOpenIssue,
}) => {
  const isMobile = useIsMobile();

  // Column colors derived from the issues' real GitHub label colors.
  const columns = React.useMemo(() => resolveColumns(issues), [issues]);

  const issuesByColumn = React.useMemo(() => {
    const map = new Map<string, GithubIssue[]>();
    for (const col of columns) map.set(col.id, []);
    for (const issue of issues) {
      const colId = issueToColumnId(issue);
      const arr = map.get(colId);
      if (arr) arr.push(issue);
    }
    return map;
  }, [issues, columns]);

  // On mobile collapsed columns are pulled out of the grid entirely.
  const gridColumns = isMobile ? columns.filter(c => !collapsedColumns.has(c.id)) : columns;
  const collapsedChips = isMobile ? columns.filter(c => collapsedColumns.has(c.id)) : [];

  const gridTemplate = gridColumns.map(col =>
    collapsedColumns.has(col.id) ? '52px' : 'minmax(0, 1fr)'
  ).join(' ');

  return (
    <div className="cgi-board-wrap">
      {collapsedChips.length > 0 && (
        <div className="cgi-collapsed-bar">
          {collapsedChips.map(col => (
            <button
              key={col.id}
              className="cgi-collapsed-chip"
              style={{ color: col.accentColor, borderColor: `${col.accentColor}55`, background: col.bgColor }}
              onClick={() => onToggleColumn(col.id)}
              title={`Expand ${col.title}`}
            >
              <span className="cgi-collapsed-chip-dot" style={{ background: col.accentColor }} />
              {col.title}
              <span className="cgi-collapsed-chip-count">{(issuesByColumn.get(col.id) ?? []).length}</span>
            </button>
          ))}
        </div>
      )}
      <div className="cgi-board" style={{ gridTemplateColumns: gridTemplate }}>
        {gridColumns.map(col => (
          <GithubKanbanColumn
            key={col.id}
            column={col}
            issues={issuesByColumn.get(col.id) ?? []}
            priorityMap={priorityMap}
            collapsed={collapsedColumns.has(col.id)}
            onToggle={() => onToggleColumn(col.id)}
            onOpenIssue={onOpenIssue}
            onMoveIssue={onMoveIssue}
          />
        ))}
      </div>
    </div>
  );
};
