import React, { useState, useEffect, useCallback, useRef } from 'react';
import type { GithubIssue, PlanData, PlanPhase } from './types';
import { usePluginAPI } from './PluginContext';
import { PlanCard } from './PlanCard';
import { PlanBootstrapModal } from './PlanBootstrapModal';

const POLL_INTERVAL_MS = 30_000;

interface PlanViewProps {
  projectPath: string;
  onOpenIssue: (issue: GithubIssue) => void;
}

export const PlanView: React.FC<PlanViewProps> = ({ projectPath, onOpenIssue }) => {
  const api = usePluginAPI();
  const [data, setData] = useState<PlanData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notConfigured, setNotConfigured] = useState(false);
  // Card drag source: phase + visible-index + issue number (number needed for cross-phase move).
  const dragFrom = useRef<{ phase: string; index: number; number: number } | null>(null);
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dataRef = useRef<PlanData | null>(null);
  const [showBootstrap, setShowBootstrap] = useState(false);
  const [dropPhase, setDropPhase] = useState<string | null>(null); // phase highlighted as cross-phase drop target
  const [hideDone, setHideDone] = useState<boolean>(() => {
    try { return localStorage.getItem('cgi-plan-hide-done') !== 'false'; } catch { return true; }
  });
  const hideDoneRef = useRef(hideDone);
  useEffect(() => {
    hideDoneRef.current = hideDone;
    try { localStorage.setItem('cgi-plan-hide-done', String(hideDone)); } catch {}
  }, [hideDone]);

  // Collapsed phases — persisted set of phase keys.
  const [collapsed, setCollapsed] = useState<Set<string>>(() => {
    try {
      const raw = localStorage.getItem('cgi-plan-collapsed');
      return raw ? new Set(JSON.parse(raw) as string[]) : new Set();
    } catch { return new Set(); }
  });
  const toggleCollapse = useCallback((key: string) => {
    setCollapsed(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      try { localStorage.setItem('cgi-plan-collapsed', JSON.stringify([...next])); } catch {}
      return next;
    });
  }, []);

  const fetchPlan = useCallback(async () => {
    if (!projectPath) return;
    setLoading(true);
    setError(null);
    try {
      const res = await api.rpc('GET', `/plan?path=${encodeURIComponent(projectPath)}`) as
        PlanData & { error?: string; notConfigured?: boolean };
      if (res.notConfigured) { setNotConfigured(true); setData(null); }
      else if (res.error) { setError(res.error); }
      else { setNotConfigured(false); setData({ phases: res.phases ?? [] }); }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load plan');
    } finally {
      setLoading(false);
    }
  }, [api, projectPath]);

  useEffect(() => { fetchPlan(); }, [fetchPlan]);
  useEffect(() => { dataRef.current = data; }, [data]);
  useEffect(() => {
    const schedule = () => { pollRef.current = setTimeout(() => { fetchPlan().then(schedule); }, POLL_INTERVAL_MS); };
    schedule();
    return () => { if (pollRef.current) clearTimeout(pollRef.current); };
  }, [fetchPlan]);

  const phaseKey = (p: PlanPhase) => p.milestoneNumber === null ? '__no_phase__' : String(p.milestoneNumber);

  // Compute the new order for one phase from current state, persist optimistically, PUT.
  const applyReorder = useCallback((phaseId: string, mutate: (issues: GithubIssue[]) => GithubIssue[]) => {
    const current = dataRef.current;
    if (!current) return;
    let payload: { phaseTitle: string | null; order: number[] } | null = null;
    const isHidden = (i: GithubIssue) => hideDoneRef.current && i.state === 'closed';
    const phases = current.phases.map(p => {
      if (phaseKey(p) !== phaseId) return p;
      // Reorder operates on the VISIBLE issues (what the user sees/drags); hidden
      // done issues keep their relative order and sink after the visible ones.
      const visible = mutate(p.issues.filter(i => !isHidden(i)));
      const hidden = p.issues.filter(isHidden);
      const issues = [...visible, ...hidden];
      payload = { phaseTitle: p.milestoneNumber === null ? null : p.title, order: issues.map(i => i.number) };
      return { ...p, issues };
    });
    if (!payload) return;
    setData({ phases });
    const body = payload;
    void (async () => {
      try {
        await api.rpc('PUT', `/plan/order?path=${encodeURIComponent(projectPath)}`, {
          phase: body.phaseTitle,
          order: body.order,
        });
      } catch {
        void fetchPlan();
      }
    })();
  }, [api, projectPath, fetchPlan]);

  // Move the card at `from` to `to` (arrow buttons pass adjacent indices).
  const reorder = (phaseId: string, from: number, to: number) => {
    applyReorder(phaseId, issues => {
      if (to < 0 || to >= issues.length) return issues;
      const next = issues.slice();
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      return next;
    });
  };

  // Cross-phase move: assign the issue to the target milestone (or clear it for "No phase").
  const assignToPhase = useCallback((issueNumber: number, milestoneNumber: number | null) => {
    void (async () => {
      try {
        await api.rpc('PUT', `/plan/phase?path=${encodeURIComponent(projectPath)}`, {
          issue: issueNumber, milestone: milestoneNumber,
        });
      } finally {
        void fetchPlan();
      }
    })();
  }, [api, projectPath, fetchPlan]);

  // Native drag drop onto a target card. Same phase → reorder; different phase → reassign milestone.
  const handleDrop = (phaseId: string, toIndex: number) => {
    const src = dragFrom.current;
    dragFrom.current = null;
    setDropPhase(null);
    if (!src) return;
    if (src.phase === phaseId) {
      const to = src.index < toIndex ? toIndex - 1 : toIndex;
      if (src.index === to) return;
      reorder(phaseId, src.index, to);
      return;
    }
    // Cross-phase: phaseId encodes the milestone (or sentinel for "No phase").
    const milestone = phaseId === '__no_phase__' ? null : Number(phaseId);
    assignToPhase(src.number, milestone);
  };

  // Persist a new phase ordering (titles, top-first). "No phase" is always pinned last server-side.
  const reorderPhases = (fromMovableIdx: number, dir: -1 | 1) => {
    const current = dataRef.current;
    if (!current) return;
    const movable = current.phases.filter(p => p.milestoneNumber !== null);
    const noPhase = current.phases.filter(p => p.milestoneNumber === null);
    const to = fromMovableIdx + dir;
    if (to < 0 || to >= movable.length) return;
    const next = movable.slice();
    const [moved] = next.splice(fromMovableIdx, 1);
    next.splice(to, 0, moved);
    setData({ phases: [...next, ...noPhase] });
    const titles = next.map(p => p.title);
    void (async () => {
      try {
        await api.rpc('PUT', `/plan/phase-order?path=${encodeURIComponent(projectPath)}`, { order: titles });
      } catch {
        void fetchPlan();
      }
    })();
  };

  if (notConfigured) return <div className="cgi-center"><div style={{ opacity: 0.5 }}>GitHub not configured. Open the ⚙ settings on the Issues Board tab.</div></div>;
  if (error) return <div className="cgi-center"><div className="cgi-error-text">{error}</div><button className="cgi-btn" onClick={fetchPlan}>Retry</button></div>;
  if (loading && !data) return <div className="cgi-center"><div className="cgi-spinner" /><div>Loading plan…</div></div>;
  if (!data) return null;

  // Index of each milestone phase among the movable (non-"No phase") phases, for the ▲▼ phase arrows.
  const movableCount = data.phases.filter(p => p.milestoneNumber !== null).length;

  return (
    <div className="cgi-plan">
      <div className="cgi-plan-toolbar">
        <button className="cgi-btn" onClick={() => setShowBootstrap(true)}>Bootstrap phases</button>
        <button className="cgi-btn" onClick={fetchPlan} disabled={loading}>{loading ? '↻ Refreshing…' : '↻ Refresh'}</button>
        <label className="cgi-plan-toggle">
          <input type="checkbox" checked={hideDone} onChange={e => setHideDone(e.target.checked)} />
          Hide done
        </label>
      </div>
      {data.phases.length === 0 ? (
        <div className="cgi-center"><div style={{ opacity: 0.5 }}>No issues yet.</div></div>
      ) : (
        data.phases.map((phase, phaseIdx) => {
          const key = phaseKey(phase);
          const pct = phase.total > 0 ? Math.round((phase.closed / phase.total) * 100) : 0;
          const visibleIssues = hideDone ? phase.issues.filter(i => i.state !== 'closed') : phase.issues;
          // Hide a phase whose issues are all done when "Hide done" is on, unless it has none at all.
          if (hideDone && phase.total > 0 && visibleIssues.length === 0) return null;
          const isCollapsed = collapsed.has(key);
          const isMovable = phase.milestoneNumber !== null;
          // Position among movable phases (data.phases keeps milestone phases before "No phase").
          const movableIdx = isMovable ? phaseIdx : -1;
          const isDropTarget = dropPhase === key;
          return (
            <section
              key={key}
              className={`cgi-plan-phase${isDropTarget ? ' drop-target' : ''}`}
              onDragOver={(e) => {
                if (!dragFrom.current || dragFrom.current.phase === key) return;
                e.preventDefault();
                if (dropPhase !== key) setDropPhase(key);
              }}
              onDragLeave={(e) => {
                // Only clear when leaving the section entirely.
                if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropPhase(prev => prev === key ? null : prev);
              }}
              onDrop={() => handleDrop(key, visibleIssues.length)}
            >
              <header className="cgi-plan-phase-head">
                <button
                  className="cgi-plan-collapse"
                  onClick={() => toggleCollapse(key)}
                  title={isCollapsed ? 'Rozwiń fazę' : 'Zwiń fazę'}
                >{isCollapsed ? '▸' : '▾'}</button>
                <span className="cgi-plan-phase-title" onClick={() => toggleCollapse(key)}>{phase.title}</span>
                <span className="cgi-plan-phase-count">{phase.closed}/{phase.total}</span>
                <span className="cgi-plan-progress"><span className="cgi-plan-progress-bar" style={{ width: `${pct}%` }} /></span>
                {isMovable && (
                  <span className="cgi-plan-phase-reorder">
                    <button className="cgi-plan-arrow" disabled={movableIdx === 0} onClick={() => reorderPhases(movableIdx, -1)} title="Faza wyżej">▲</button>
                    <button className="cgi-plan-arrow" disabled={movableIdx === movableCount - 1} onClick={() => reorderPhases(movableIdx, 1)} title="Faza niżej">▼</button>
                  </span>
                )}
              </header>
              {!isCollapsed && (
                <div className="cgi-plan-list">
                  {visibleIssues.map((issue, idx) => (
                    <PlanCard
                      key={issue.number}
                      issue={issue}
                      index={idx}
                      count={visibleIssues.length}
                      onOpen={onOpenIssue}
                      onMoveUp={() => reorder(key, idx, idx - 1)}
                      onMoveDown={() => reorder(key, idx, idx + 1)}
                      onDragStart={() => { dragFrom.current = { phase: key, index: idx, number: issue.number }; }}
                      onDragOver={(e) => e.preventDefault()}
                      onDrop={() => handleDrop(key, idx)}
                    />
                  ))}
                  {visibleIssues.length === 0 && (
                    <div className="cgi-plan-empty">Przeciągnij tu ticket, by przypisać do tej fazy</div>
                  )}
                </div>
              )}
            </section>
          );
        })
      )}
      {showBootstrap && (
        <PlanBootstrapModal
          projectPath={projectPath}
          onClose={() => setShowBootstrap(false)}
          onDone={() => { setShowBootstrap(false); void fetchPlan(); }}
        />
      )}
    </div>
  );
};
