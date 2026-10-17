import React, { useState } from 'react';
import { usePluginAPI } from './PluginContext';

interface PlanBootstrapModalProps {
  projectPath: string;
  onClose: () => void;
  onDone: () => void;
}

/**
 * Migration helper: paste a phase→issues mapping, one phase per line:
 *   FAZA L: 12, 14, 18
 * Creates the milestone if missing and assigns those issues to it.
 */
export const PlanBootstrapModal: React.FC<PlanBootstrapModalProps> = ({ projectPath, onClose, onDone }) => {
  const api = usePluginAPI();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const parse = (): Array<{ title: string; issues: number[] }> => {
    const phases: Array<{ title: string; issues: number[] }> = [];
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const colon = trimmed.indexOf(':');
      if (colon === -1) continue;
      const title = trimmed.slice(0, colon).trim();
      const issues = trimmed.slice(colon + 1)
        .split(',')
        .map(s => parseInt(s.replace('#', '').trim(), 10))
        .filter(n => Number.isFinite(n));
      if (title) phases.push({ title, issues });
    }
    return phases;
  };

  const run = async () => {
    const phases = parse();
    if (phases.length === 0) { setError('Enter at least one line like "FAZA L: 12, 14"'); return; }
    setBusy(true);
    setError(null);
    try {
      await api.rpc('POST', `/plan/bootstrap?path=${encodeURIComponent(projectPath)}`, { phases });
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Bootstrap failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="cgi-modal-overlay" onClick={onClose}>
      <div className="cgi-modal cgi-plan-bootstrap" onClick={e => e.stopPropagation()}>
        <h3>Bootstrap phases (milestones)</h3>
        <p style={{ fontSize: 12, opacity: 0.6 }}>
          One phase per line: <code>FAZA L: 12, 14, 18</code>. Creates each milestone if missing and assigns the issues.
        </p>
        <textarea
          className="cgi-plan-bootstrap-text"
          value={text}
          onChange={e => setText(e.target.value)}
          placeholder={'FAZA A: 1, 2, 3\nFAZA L: 12, 14'}
          rows={8}
        />
        {error && <div className="cgi-error-text">{error}</div>}
        <div className="cgi-modal-actions">
          <button className="cgi-btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="cgi-btn cgi-btn-new-issue" onClick={run} disabled={busy}>
            {busy ? 'Running…' : 'Run'}
          </button>
        </div>
      </div>
    </div>
  );
};
