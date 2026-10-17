import React, { useState, useEffect } from 'react';
import { usePluginAPI } from './PluginContext';

interface Props {
  projectPath: string;
  onClose: () => void;
  onSaved: () => void;
  onManualPrioritize?: () => void;
}

interface ConfigState {
  token: string;
  owner: string;
  repo: string;
  anthropicKey: string;
}

export const SettingsModal: React.FC<Props> = ({ projectPath, onClose, onSaved, onManualPrioritize }) => {
  const api = usePluginAPI();
  const [form, setForm] = useState<ConfigState>({ token: '', owner: '', repo: '', anthropicKey: '' });
  const [showAnthropicKey, setShowAnthropicKey] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [showToken, setShowToken] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api.rpc('GET', `/config?path=${encodeURIComponent(projectPath)}`)
      .then(res => {
        if (cancelled) return;
        const d = res as { configured?: boolean; owner?: string; repo?: string; hasToken?: boolean; hasAnthropicKey?: boolean };
        if (d.configured) {
          setForm(f => ({
            ...f,
            owner: d.owner ?? '',
            repo: d.repo ?? '',
            // secrets not returned — leave blank, user must re-enter to change
          }));
        }
      })
      .catch(() => { /* ignore — just show empty form */ })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [api, projectPath]);

  const handleSave = async () => {
    setError(null);
    if (!form.owner.trim() || !form.repo.trim()) {
      setError('Owner and repository name are required.');
      return;
    }
    if (!form.token.trim()) {
      setError('GitHub token is required. You can find it at github.com → Settings → Developer settings → Personal access tokens.');
      return;
    }
    setSaving(true);
    try {
      await api.rpc('PUT', `/config?path=${encodeURIComponent(projectPath)}`, {
        token: form.token.trim(),
        owner: form.owner.trim(),
        repo: form.repo.trim(),
        enabled: true,
        anthropicKey: form.anthropicKey.trim() || undefined,
      });
      setSuccess(true);
      setTimeout(() => {
        onSaved();
        onClose();
      }, 600);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save configuration.');
    } finally {
      setSaving(false);
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
  };

  const labelStyle: React.CSSProperties = {
    display: 'block',
    fontSize: 11,
    fontWeight: 600,
    opacity: 0.65,
    marginBottom: 5,
    textTransform: 'uppercase',
    letterSpacing: '0.05em',
  };

  return (
    <div
      style={{ position: 'fixed', inset: 0, zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,0.55)' }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div style={{ background: 'var(--cgi-surface)', borderRadius: 10, padding: 24, width: 420, maxWidth: '90vw', boxShadow: '0 20px 60px rgba(0,0,0,0.4)', display: 'flex', flexDirection: 'column', gap: 18 }}>
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 600, fontSize: 15 }}>
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
              <path d="M8 0c4.42 0 8 3.58 8 8a8.013 8.013 0 0 1-5.45 7.59c-.4.08-.55-.17-.55-.38 0-.27.01-1.13.01-2.2 0-.75-.25-1.23-.54-1.48 1.78-.2 3.65-.88 3.65-3.95 0-.88-.31-1.59-.82-2.15.08-.2.36-1.02-.08-2.12 0 0-.67-.22-2.2.82-.64-.18-1.32-.27-2-.27-.68 0-1.36.09-2 .27-1.53-1.03-2.2-.82-2.2-.82-.44 1.1-.16 1.92-.08 2.12-.51.56-.82 1.28-.82 2.15 0 3.06 1.86 3.75 3.64 3.95-.23.2-.44.55-.51 1.07-.46.21-1.61.55-2.33-.66-.15-.24-.6-.83-1.23-.82-.67.01-.27.38.01.53.34.19.73.9.82 1.13.16.45.68 1.31 2.69.94 0 .67.01 1.3.01 1.49 0 .21-.15.45-.55.38A7.995 7.995 0 0 1 0 8c0-4.42 3.58-8 8-8Z" />
            </svg>
            GitHub Issues Board — Settings
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--cgi-text)', opacity: 0.5, fontSize: 18, lineHeight: 1, padding: '2px 6px' }}>×</button>
        </div>

        {loading ? (
          <div style={{ textAlign: 'center', padding: '20px 0', opacity: 0.5 }}>Loading current settings…</div>
        ) : (
          <>
            {/* Token */}
            <div>
              <label style={labelStyle}>GitHub Personal Access Token</label>
              <div style={{ position: 'relative' }}>
                <input
                  type={showToken ? 'text' : 'password'}
                  value={form.token}
                  onChange={e => setForm(f => ({ ...f, token: e.target.value }))}
                  placeholder="ghp_xxxxxxxxxxxxxxxxxxxx"
                  style={{ ...inputStyle, paddingRight: 38 }}
                  autoComplete="off"
                />
                <button
                  onClick={() => setShowToken(v => !v)}
                  style={{ position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', color: 'var(--cgi-text)', opacity: 0.45, fontSize: 12 }}
                  title={showToken ? 'Hide token' : 'Show token'}
                >
                  {showToken ? 'hide' : 'show'}
                </button>
              </div>
              <div style={{ fontSize: 11, opacity: 0.5, marginTop: 4 }}>
                Generate at github.com → Settings → Developer settings → Personal access tokens. Requires <code>repo</code> scope.
              </div>
            </div>

            {/* Owner */}
            <div>
              <label style={labelStyle}>Repository Owner (username or org)</label>
              <input
                type="text"
                value={form.owner}
                onChange={e => setForm(f => ({ ...f, owner: e.target.value }))}
                placeholder="your-github-username"
                style={inputStyle}
                autoComplete="off"
              />
            </div>

            {/* Repo */}
            <div>
              <label style={labelStyle}>Repository Name</label>
              <input
                type="text"
                value={form.repo}
                onChange={e => setForm(f => ({ ...f, repo: e.target.value }))}
                placeholder="your-repository-name"
                style={inputStyle}
                autoComplete="off"
              />
            </div>

            {/* Anthropic Key (optional) */}
            <div>
              <label style={labelStyle}>Anthropic API Key <span style={{ opacity: 0.5, fontWeight: 400, textTransform: 'none', fontSize: 11 }}>(optional — enables real AI prioritization)</span></label>
              <div style={{ position: 'relative' }}>
                <input
                  type={showAnthropicKey ? 'text' : 'password'}
                  value={form.anthropicKey}
                  onChange={e => setForm(f => ({ ...f, anthropicKey: e.target.value }))}
                  placeholder="sk-ant-api03-…"
                  style={{ ...inputStyle, paddingRight: 38 }}
                  autoComplete="off"
                />
                <button
                  onClick={() => setShowAnthropicKey(v => !v)}
                  style={{ position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', color: 'var(--cgi-text)', opacity: 0.45, fontSize: 12 }}
                  title={showAnthropicKey ? 'Hide key' : 'Show key'}
                >
                  {showAnthropicKey ? 'hide' : 'show'}
                </button>
              </div>
              <div style={{ fontSize: 11, opacity: 0.5, marginTop: 4, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                <span>Without a key, AI Prioritize uses smart heuristics. With a key, it uses Claude Haiku for deeper AI analysis.</span>
                {onManualPrioritize && (
                  <button
                    onClick={onManualPrioritize}
                    style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--cgi-accent)', fontSize: 11, fontWeight: 600, padding: '2px 6px', borderRadius: 4, whiteSpace: 'nowrap', flexShrink: 0 }}
                    title="Use Claude.ai subscription: generate a prompt, paste back the response"
                  >
                    Use claude.ai →
                  </button>
                )}
              </div>
            </div>

            {/* Error */}
            {error && (
              <div style={{ background: 'rgba(239,68,68,0.12)', border: '1px solid rgba(239,68,68,0.3)', borderRadius: 6, padding: '8px 12px', fontSize: 12, color: '#ef4444' }}>
                {error}
              </div>
            )}

            {/* Skill docs link */}
            <div style={{ borderTop: '1px solid var(--cgi-border)', paddingTop: 14, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
              <div style={{ fontSize: 12, opacity: 0.6 }}>
                Use <code style={{ background: 'var(--cgi-code-bg)', padding: '1px 5px', borderRadius: 4 }}>/github-task</code> skill in Claude chat to manage issues via AI
              </div>
              <a
                href="https://github.com/szmidtpiotr/claude-github-issue/blob/main/skill/SKILL.md"
                target="_blank"
                rel="noopener noreferrer"
                className="cgi-btn"
                style={{ textDecoration: 'none', flexShrink: 0, fontSize: 11, gap: 4 }}
              >
                <svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor">
                  <path d="M8 0c4.42 0 8 3.58 8 8a8.013 8.013 0 0 1-5.45 7.59c-.4.08-.55-.17-.55-.38 0-.27.01-1.13.01-2.2 0-.75-.25-1.23-.54-1.48 1.78-.2 3.65-.88 3.65-3.95 0-.88-.31-1.59-.82-2.15.08-.2.36-1.02-.08-2.12 0 0-.67-.22-2.2.82-.64-.18-1.32-.27-2-.27-.68 0-1.36.09-2 .27-1.53-1.03-2.2-.82-2.2-.82-.44 1.1-.16 1.92-.08 2.12-.51.56-.82 1.28-.82 2.15 0 3.06 1.86 3.75 3.64 3.95-.23.2-.44.55-.51 1.07-.46.21-1.61.55-2.33-.66-.15-.24-.6-.83-1.23-.82-.67.01-.27.38.01.53.34.19.73.9.82 1.13.16.45.68 1.31 2.69.94 0 .67.01 1.3.01 1.49 0 .21-.15.45-.55.38A7.995 7.995 0 0 1 0 8c0-4.42 3.58-8 8-8Z"/>
                </svg>
                View SKILL.md
              </a>
            </div>

            {/* Buttons */}
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button onClick={onClose} className="cgi-btn" style={{ opacity: 0.7 }}>Cancel</button>
              <button
                onClick={handleSave}
                disabled={saving || success}
                className="cgi-btn"
                style={{ background: success ? '#22c55e' : 'var(--cgi-accent)', color: '#fff', border: 'none', fontWeight: 600 }}
              >
                {success ? '✓ Saved!' : saving ? 'Saving…' : 'Save'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
};
