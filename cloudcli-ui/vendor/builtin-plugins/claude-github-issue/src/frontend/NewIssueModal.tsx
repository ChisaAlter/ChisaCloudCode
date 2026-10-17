import React, { useState, useEffect, useRef } from 'react';
import { usePluginAPI } from './PluginContext';
import type { GithubIssue } from './types';

interface Props {
  projectPath: string;
  onClose: () => void;
  onCreated: (issue: GithubIssue) => void;
}

export const NewIssueModal: React.FC<Props> = ({ projectPath, onClose, onCreated }) => {
  const api = usePluginAPI();
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const titleRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    titleRef.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim() || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await api.rpc('POST', `/issues?path=${encodeURIComponent(projectPath)}`, {
        title: title.trim(),
        body: body.trim() || undefined,
      }) as { ok: boolean; issue: GithubIssue };
      if (res.ok && res.issue) {
        onCreated(res.issue);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to create issue');
      setSubmitting(false);
    }
  };

  const inputStyle: React.CSSProperties = {
    width: '100%',
    padding: '8px 10px',
    borderRadius: 6,
    border: '1px solid var(--cgi-border)',
    background: 'var(--cgi-input-bg)',
    color: 'var(--cgi-text)',
    fontSize: 13,
    outline: 'none',
    boxSizing: 'border-box',
    fontFamily: 'inherit',
    transition: 'border-color 0.15s',
  };

  return (
    <div
      style={{ position: 'fixed', inset: 0, zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,0.55)' }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div style={{ background: 'var(--cgi-modal-bg)', border: '1px solid var(--cgi-border)', borderRadius: 12, padding: 24, width: 500, maxWidth: '92vw', boxShadow: '0 20px 60px rgba(0,0,0,0.4)', display: 'flex', flexDirection: 'column', gap: 16 }}>
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 600, fontSize: 15 }}>
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
              <path d="M7.75 2a.75.75 0 0 1 .75.75V7h4.25a.75.75 0 0 1 0 1.5H8.5v4.25a.75.75 0 0 1-1.5 0V8.5H2.75a.75.75 0 0 1 0-1.5H7V2.75A.75.75 0 0 1 7.75 2Z"/>
            </svg>
            New Issue
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--cgi-text)', opacity: 0.5, fontSize: 20, lineHeight: 1, padding: '2px 4px' }}>×</button>
        </div>

        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {/* Title */}
          <div>
            <label style={{ display: 'block', fontSize: 11, fontWeight: 600, opacity: 0.65, marginBottom: 5, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              Title <span style={{ color: '#ef4444' }}>*</span>
            </label>
            <input
              ref={titleRef}
              type="text"
              value={title}
              onChange={e => setTitle(e.target.value)}
              placeholder="Short, descriptive title…"
              style={inputStyle}
              autoComplete="off"
              required
            />
          </div>

          {/* Body */}
          <div>
            <label style={{ display: 'block', fontSize: 11, fontWeight: 600, opacity: 0.65, marginBottom: 5, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              Description <span style={{ opacity: 0.5, fontWeight: 400, textTransform: 'none' }}>(optional)</span>
            </label>
            <textarea
              value={body}
              onChange={e => setBody(e.target.value)}
              placeholder="Describe the issue, steps to reproduce, expected vs actual behavior…"
              style={{ ...inputStyle, minHeight: 100, resize: 'vertical' }}
            />
          </div>

          {error && (
            <div style={{ background: 'rgba(239,68,68,0.12)', border: '1px solid rgba(239,68,68,0.3)', borderRadius: 6, padding: '8px 12px', fontSize: 12, color: '#ef4444' }}>
              {error}
            </div>
          )}

          <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', paddingTop: 2 }}>
            <button type="button" onClick={onClose} className="cgi-btn" style={{ opacity: 0.7 }}>Cancel</button>
            <button
              type="submit"
              disabled={!title.trim() || submitting}
              className="cgi-btn"
              style={{ background: 'var(--cgi-accent)', color: '#fff', border: 'none', fontWeight: 600 }}
            >
              {submitting ? 'Creating…' : 'Create issue'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
