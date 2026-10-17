import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import type { IssuesData, GithubIssue } from './types';
import { columnChangePatch, resolveColumns, COLUMNS } from './types';
import { usePluginAPI } from './PluginContext';
import type { IssuePriority, PriorityLevel, SortOption } from './priorityUtils';
import { detectPriorityFromLabels, getEffectivePriority, sortIssues } from './priorityUtils';
import { GithubBoard } from './GithubBoard';
import { GithubIssueModal } from './GithubIssueModal';
import { NewIssueModal } from './NewIssueModal';
import { SubscriptionPriorityModal } from './SubscriptionPriorityModal';
import { ConfigBanner } from './ConfigBanner';
import { SettingsModal } from './SettingsModal';
import { PlanView } from './PlanView';

const POLL_INTERVAL_MS = 30_000;
const STORAGE_KEY = 'cgi-collapsed-columns';
const TAB_KEY = 'cgi-active-tab';
const SORT_LABELS: Record<SortOption, string> = {
  number: 'Number',
  updated: 'Updated',
  created: 'Created',
  comments: 'Comments',
  title: 'Title',
  priority: 'Priority',
};
const SORT_OPTIONS: SortOption[] = ['number', 'updated', 'created', 'comments', 'title', 'priority'];
const PRIORITY_PILL_COLORS: Record<string, string> = {
  high: '#ef4444',
  medium: '#f59e0b',
  low: '#6b7280',
};

function loadCollapsed(): Set<string> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? new Set(JSON.parse(raw)) : new Set();
  } catch {
    return new Set();
  }
}

function saveCollapsed(set: Set<string>): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...set]));
  } catch {}
}

export const App: React.FC = () => {
  const api = usePluginAPI();
  const [data, setData] = useState<IssuesData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notConfigured, setNotConfigured] = useState(false);
  const [collapsedColumns, setCollapsedColumns] = useState<Set<string>>(loadCollapsed);
  const [selectedIssue, setSelectedIssue] = useState<GithubIssue | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [showNewIssue, setShowNewIssue] = useState(false);
  const [activeTab, setActiveTab] = useState<'board' | 'plan'>(() => {
    try { return (localStorage.getItem(TAB_KEY) as 'board' | 'plan') || 'board'; } catch { return 'board'; }
  });
  const switchTab = (tab: 'board' | 'plan') => {
    setActiveTab(tab);
    try { localStorage.setItem(TAB_KEY, tab); } catch {}
  };

  // Filter/sort state
  const [searchText, setSearchText] = useState('');
  const [activePriority, setActivePriority] = useState<'all' | PriorityLevel>('all');
  const [sortBy, setSortBy] = useState<SortOption>('number');
  const [sortDir, setSortDir] = useState<'desc' | 'asc'>('desc');
  const [showSortMenu, setShowSortMenu] = useState(false);

  // AI priorities (number → IssuePriority)
  const [priorityMap, setPriorityMap] = useState<Map<number, IssuePriority>>(new Map());
  const [aiPrioritizing, setAiPrioritizing] = useState(false);
  const [aiUsed, setAiUsed] = useState(false);
  const [showSubscriptionModal, setShowSubscriptionModal] = useState(false);
  const [hasAnthropicKey, setHasAnthropicKey] = useState(false);

  const theme = api.context.theme;
  const project = api.context.project;
  const fetchRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sortMenuRef = useRef<HTMLDivElement | null>(null);

  const fetchIssues = useCallback(async () => {
    if (!project?.path) {
      setNotConfigured(false);
      setData(null);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await api.rpc('GET', `/issues?path=${encodeURIComponent(project.path)}`);
      const d = res as { issues?: GithubIssue[]; columns?: IssuesData['columns']; error?: string; notConfigured?: boolean };
      if (d.notConfigured || d.error?.includes('not configured')) {
        setNotConfigured(true);
        setData(null);
      } else if (d.error) {
        setError(d.error);
      } else {
        setNotConfigured(false);
        setData({ issues: d.issues ?? [], columns: d.columns ?? [] });
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Failed to load issues';
      if (msg.includes('not configured') || msg.includes('GitHub not configured')) {
        setNotConfigured(true);
        setData(null);
      } else {
        setError(msg);
      }
    } finally {
      setLoading(false);
    }
  }, [api, project?.path]);

  useEffect(() => {
    fetchIssues();
    const unsubscribe = api.onContextChange(() => { fetchIssues(); });
    return unsubscribe;
  }, [fetchIssues, api]);

  // Check if Anthropic key is configured
  useEffect(() => {
    if (!project?.path) return;
    api.rpc('GET', `/config?path=${encodeURIComponent(project.path)}`)
      .then(res => {
        const d = res as { hasAnthropicKey?: boolean };
        setHasAnthropicKey(Boolean(d.hasAnthropicKey));
      })
      .catch(() => {});
  }, [api, project?.path]);

  useEffect(() => {
    const schedule = () => {
      fetchRef.current = setTimeout(() => { fetchIssues().then(schedule); }, POLL_INTERVAL_MS);
    };
    schedule();
    return () => { if (fetchRef.current !== null) clearTimeout(fetchRef.current); };
  }, [fetchIssues]);

  // Close sort menu on outside click
  useEffect(() => {
    if (!showSortMenu) return;
    const handler = (e: MouseEvent) => {
      if (sortMenuRef.current && !sortMenuRef.current.contains(e.target as Node)) {
        setShowSortMenu(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showSortMenu]);

  const handleSubscriptionPriorities = (priorities: IssuePriority[]) => {
    const newMap = new Map<number, IssuePriority>();
    for (const p of priorities) newMap.set(p.number, p);
    setPriorityMap(newMap);
    setAiUsed(true);
    setSortBy('priority');
    setShowSubscriptionModal(false);
  };

  const handleAIPrioritize = async () => {
    if (!data || aiPrioritizing || !project?.path) return;
    setAiPrioritizing(true);
    try {
      const issuesForAI = data.issues
        .filter(i => i.state !== 'closed')
        .map(i => ({
          number: i.number,
          title: i.title,
          body: i.body,
          labels: i.labels,
          comments: i.comments,
          created_at: i.created_at,
          updated_at: i.updated_at,
          state: i.state,
        }));
      const res = await api.rpc(
        'POST',
        `/ai-prioritize?path=${encodeURIComponent(project.path)}`,
        { issues: issuesForAI }
      ) as { priorities: IssuePriority[]; usingAI: boolean };
      const newMap = new Map<number, IssuePriority>();
      for (const p of res.priorities ?? []) newMap.set(p.number, p);
      setPriorityMap(newMap);
      setAiUsed(res.usingAI);
      // Auto-sort by priority after analysis
      setSortBy('priority');
    } catch (e) {
      console.error('[cgi] AI prioritize failed:', e);
    } finally {
      setAiPrioritizing(false);
    }
  };

  const handleToggleColumn = (id: string) => {
    setCollapsedColumns(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      saveCollapsed(next);
      return next;
    });
  };

  const handleMoveIssue = async (issueNumber: number, newColumnId: string) => {
    if (!project?.path || !data) return;
    const issue = data.issues.find(i => i.number === issueNumber);
    if (!issue) return;
    const patch = columnChangePatch(issue, newColumnId);
    if (!patch) return;
    try {
      const res = await api.rpc('PATCH', `/issues/${issueNumber}?path=${encodeURIComponent(project.path)}`, patch);
      const d = res as { ok: boolean; issue: GithubIssue };
      if (d.ok && d.issue) {
        setData(prev => prev ? { ...prev, issues: prev.issues.map(i => i.number === issueNumber ? d.issue : i) } : prev);
      }
    } catch {}
  };

  const handleIssueUpdated = (updated: GithubIssue) => {
    setData(prev => prev ? { ...prev, issues: prev.issues.map(i => i.number === updated.number ? updated : i) } : prev);
    setSelectedIssue(updated);
  };

  const handleIssueCreated = (issue: GithubIssue) => {
    setData(prev => prev ? { ...prev, issues: [issue, ...prev.issues] } : prev);
    setShowNewIssue(false);
    setSelectedIssue(issue);
  };

  // Filtered + sorted issues
  const processedIssues = useMemo(() => {
    if (!data) return [];
    let issues = data.issues;

    if (searchText.trim()) {
      const q = searchText.toLowerCase();
      issues = issues.filter(i =>
        i.title.toLowerCase().includes(q) ||
        String(i.number).includes(q) ||
        (i.body?.toLowerCase().includes(q) ?? false)
      );
    }

    if (activePriority !== 'all') {
      issues = issues.filter(i => {
        const p = getEffectivePriority(i, priorityMap) ?? detectPriorityFromLabels(i.labels);
        return p === activePriority;
      });
    }

    return sortIssues(issues, sortBy, sortDir, priorityMap);
  }, [data, searchText, activePriority, sortBy, sortDir, priorityMap]);

  // Status-column colors from real GitHub label colors (shared by board + modal pills).
  const resolvedColumns = useMemo(() => data ? resolveColumns(data.issues) : COLUMNS, [data]);

  const totalCount = data?.issues.length ?? 0;
  const filteredCount = processedIssues.length;
  const isFiltered = filteredCount !== totalCount;
  const projectPath = project?.path ?? '';
  const repoInfo = (data as unknown as { owner?: string; repo?: string }) ?? {};

  return (
    <div className={`cgi-root cgi-${theme}`} style={{ background: 'var(--cgi-bg)', color: 'var(--cgi-text)' }}>
      {/* Toolbar row 1 */}
      <div className="cgi-toolbar" style={{ background: 'var(--cgi-surface)' }}>
        <div className="cgi-toolbar-title">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
            <path d="M8 0c4.42 0 8 3.58 8 8a8.013 8.013 0 0 1-5.45 7.59c-.4.08-.55-.17-.55-.38 0-.27.01-1.13.01-2.2 0-.75-.25-1.23-.54-1.48 1.78-.2 3.65-.88 3.65-3.95 0-.88-.31-1.59-.82-2.15.08-.2.36-1.02-.08-2.12 0 0-.67-.22-2.2.82-.64-.18-1.32-.27-2-.27-.68 0-1.36.09-2 .27-1.53-1.03-2.2-.82-2.2-.82-.44 1.1-.16 1.92-.08 2.12-.51.56-.82 1.28-.82 2.15 0 3.06 1.86 3.75 3.64 3.95-.23.2-.44.55-.51 1.07-.46.21-1.61.55-2.33-.66-.15-.24-.6-.83-1.23-.82-.67.01-.27.38.01.53.34.19.73.9.82 1.13.16.45.68 1.31 2.69.94 0 .67.01 1.3.01 1.49 0 .21-.15.45-.55.38A7.995 7.995 0 0 1 0 8c0-4.42 3.58-8 8-8Z" />
          </svg>
          GitHub Issues Board
          {repoInfo.owner && repoInfo.repo && (
            <span style={{ fontWeight: 400, opacity: 0.6, fontSize: 12 }}>
              {repoInfo.owner}/{repoInfo.repo}
            </span>
          )}
          {data && (
            <span style={{ fontSize: 11, opacity: 0.45 }}>
              {isFiltered ? `${filteredCount}/${totalCount}` : `${totalCount}`}
            </span>
          )}
        </div>
        <div className="cgi-tabs">
          <button
            className={`cgi-tab${activeTab === 'board' ? ' active' : ''}`}
            onClick={() => switchTab('board')}
          >Issues Board</button>
          <button
            className={`cgi-tab${activeTab === 'plan' ? ' active' : ''}`}
            onClick={() => switchTab('plan')}
          >Plan</button>
        </div>
        <div className="cgi-toolbar-actions">
          {project && !notConfigured && (
            <button
              className="cgi-btn cgi-btn-new-issue"
              onClick={() => setShowNewIssue(true)}
              title="Create a new issue"
            >
              <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
                <path d="M7.75 2a.75.75 0 0 1 .75.75V7h4.25a.75.75 0 0 1 0 1.5H8.5v4.25a.75.75 0 0 1-1.5 0V8.5H2.75a.75.75 0 0 1 0-1.5H7V2.75A.75.75 0 0 1 7.75 2Z"/>
              </svg>
              New Issue
            </button>
          )}
          {data && project && (
            <button
              className={`cgi-btn cgi-btn-ai${aiPrioritizing ? ' cgi-btn-ai-loading' : ''}`}
              onClick={handleAIPrioritize}
              disabled={aiPrioritizing}
              title={hasAnthropicKey ? 'AI Prioritize — using Anthropic Claude API' : 'AI Prioritize — using smart heuristics (add Anthropic API key in ⚙ settings for real AI)'}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M12 2l2.4 7.4H22l-6.2 4.5 2.4 7.4L12 17l-6.2 4.3 2.4-7.4L2 9.4h7.6z"/>
              </svg>
              {aiPrioritizing ? 'Analyzing…' : aiUsed ? 'Re-prioritize' : 'AI Prioritize'}
            </button>
          )}
          <button className="cgi-btn" onClick={fetchIssues} disabled={loading} title="Refresh issues">
            {loading ? '↻ Refreshing…' : '↻ Refresh'}
          </button>
          {project && (
            <button className="cgi-btn" onClick={() => setShowSettings(true)} title="Settings" style={{ padding: '4px 8px' }}>
              ⚙
            </button>
          )}
        </div>
      </div>

      {/* Filter bar — only shown when data is loaded and on board tab */}
      {activeTab === 'board' && data && (
        <div className="cgi-filterbar" style={{ background: 'var(--cgi-surface)', borderBottom: '1px solid var(--cgi-border)' }}>
          {/* Search */}
          <div className="cgi-search-wrap">
            <svg className="cgi-search-icon" width="13" height="13" viewBox="0 0 16 16" fill="currentColor">
              <path d="M10.68 11.74a6 6 0 0 1-7.922-8.982 6 6 0 0 1 8.982 7.922l3.04 3.04a.749.749 0 0 1-.326 1.275.749.749 0 0 1-.734-.215ZM11.5 7a4.499 4.499 0 1 0-8.997 0A4.499 4.499 0 0 0 11.5 7Z"/>
            </svg>
            <input
              type="text"
              className="cgi-search-input"
              placeholder="Search issues…"
              value={searchText}
              onChange={e => setSearchText(e.target.value)}
            />
            {searchText && (
              <button className="cgi-search-clear" onClick={() => setSearchText('')} title="Clear search">✕</button>
            )}
          </div>

          {/* Priority pills */}
          <div className="cgi-priority-pills">
            {(['all', 'high', 'medium', 'low'] as const).map(p => (
              <button
                key={p}
                className={`cgi-priority-pill${activePriority === p ? ' active' : ''}`}
                onClick={() => setActivePriority(p)}
              >
                {p !== 'all' && (
                  <span className="cgi-priority-pill-dot" style={{ background: PRIORITY_PILL_COLORS[p] }} />
                )}
                {p === 'all' ? 'All' : p.charAt(0).toUpperCase() + p.slice(1)}
              </button>
            ))}
          </div>

          {/* Sort controls */}
          <div className="cgi-sort-controls" ref={sortMenuRef}>
            <button
              className="cgi-btn cgi-sort-dir-btn"
              onClick={() => setSortDir(d => d === 'desc' ? 'asc' : 'desc')}
              title={sortDir === 'desc' ? 'Descending — click for ascending' : 'Ascending — click for descending'}
            >
              {sortDir === 'desc' ? '↓' : '↑'}
            </button>
            <div style={{ position: 'relative' }}>
              <button
                className="cgi-btn cgi-sort-select-btn"
                onClick={() => setShowSortMenu(v => !v)}
              >
                Sort: {SORT_LABELS[sortBy]} <span style={{ opacity: 0.5, marginLeft: 2 }}>∨</span>
              </button>
              {showSortMenu && (
                <div className="cgi-sort-menu">
                  {SORT_OPTIONS.map(opt => (
                    <button
                      key={opt}
                      className={`cgi-sort-menu-item${sortBy === opt ? ' active' : ''}`}
                      onClick={() => { setSortBy(opt); setShowSortMenu(false); }}
                    >
                      {SORT_LABELS[opt]}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Main content */}
      {activeTab === 'plan' ? (
        project ? (
          <PlanView
            projectPath={projectPath}
            onOpenIssue={setSelectedIssue}
          />
        ) : (
          <div className="cgi-center"><div style={{ opacity: 0.5 }}>No project open.</div></div>
        )
      ) : !project ? (
        <div className="cgi-center">
          <div style={{ opacity: 0.5 }}>No project open.</div>
          <div style={{ fontSize: 12, opacity: 0.4 }}>Open a project to view its GitHub Issues.</div>
        </div>
      ) : notConfigured ? (
        <ConfigBanner onOpenSettings={() => setShowSettings(true)} />
      ) : loading && !data ? (
        <div className="cgi-center">
          <div className="cgi-spinner" />
          <div>Loading issues…</div>
        </div>
      ) : error ? (
        <div className="cgi-center">
          <div className="cgi-error-text">{error}</div>
          <button className="cgi-btn" onClick={fetchIssues}>Retry</button>
        </div>
      ) : data ? (
        <GithubBoard
          issues={processedIssues}
          priorityMap={priorityMap}
          collapsedColumns={collapsedColumns}
          onToggleColumn={handleToggleColumn}
          onMoveIssue={handleMoveIssue}
          onOpenIssue={setSelectedIssue}
        />
      ) : null}

      {selectedIssue && project && (
        <GithubIssueModal
          issue={selectedIssue}
          projectPath={projectPath}
          columns={resolvedColumns}
          onClose={() => setSelectedIssue(null)}
          onIssueUpdated={handleIssueUpdated}
        />
      )}

      {showSettings && project && (
        <SettingsModal
          projectPath={projectPath}
          onClose={() => setShowSettings(false)}
          onSaved={() => {
            setNotConfigured(false);
            setShowSettings(false);
            void fetchIssues();
          }}
          onManualPrioritize={data ? () => {
            setShowSettings(false);
            setShowSubscriptionModal(true);
          } : undefined}
        />
      )}

      {showSubscriptionModal && data && (
        <SubscriptionPriorityModal
          issues={data.issues}
          onApply={handleSubscriptionPriorities}
          onClose={() => setShowSubscriptionModal(false)}
        />
      )}

      {showNewIssue && project && (
        <NewIssueModal
          projectPath={projectPath}
          onClose={() => setShowNewIssue(false)}
          onCreated={handleIssueCreated}
        />
      )}
    </div>
  );
};
