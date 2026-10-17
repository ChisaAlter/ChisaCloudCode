import React, { useState, useRef, useEffect } from 'react';
import type { GithubIssue } from './types';
import type { IssuePriority, PriorityLevel } from './priorityUtils';

interface Props {
  issues: GithubIssue[];
  onApply: (priorities: IssuePriority[]) => void;
  onClose: () => void;
}

function buildPrompt(issues: GithubIssue[]): string {
  const open = issues.filter(i => i.state !== 'closed').slice(0, 50);
  const list = open.map(i =>
    `#${i.number}: ${i.title}\nLabels: ${i.labels.map(l => l.name).join(', ') || 'none'}\nComments: ${i.comments}\nCreated: ${i.created_at.split('T')[0]}\nDescription: ${(i.body ?? '').slice(0, 300)}`
  ).join('\n\n---\n\n');

  return `You are a software project manager. Analyze these GitHub issues and assign each a priority level.

Issues:
${list}

Prioritization criteria:
- high: security vulnerabilities, crashes, data loss, critical bugs blocking users
- medium: regular bugs affecting users, important features, performance problems
- low: minor issues, nice-to-have features, documentation, minor enhancements

Return ONLY valid JSON, no explanation or markdown:
{"priorities":[{"number":<issue_number>,"priority":"high"|"medium"|"low","reason":"<one brief sentence>"}]}`;
}

function parseResponse(raw: string): IssuePriority[] | null {
  try {
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    const data = JSON.parse(jsonMatch[0]) as { priorities?: Array<{ number: number; priority: string; reason: string }> };
    const valid: IssuePriority[] = (data.priorities ?? [])
      .filter(p => p.number && ['high','medium','low'].includes(p.priority))
      .map(p => ({
        number: p.number,
        priority: p.priority as PriorityLevel,
        score: p.priority === 'high' ? 80 : p.priority === 'medium' ? 50 : 20,
        reason: p.reason ?? '',
      }));
    return valid.length > 0 ? valid : null;
  } catch {
    return null;
  }
}

export const SubscriptionPriorityModal: React.FC<Props> = ({ issues, onApply, onClose }) => {
  const [step, setStep] = useState<'prompt' | 'paste'>('prompt');
  const [pasteText, setPasteText] = useState('');
  const [parseError, setParseError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const prompt = buildPrompt(issues);
  const promptRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const handleCopy = () => {
    navigator.clipboard.writeText(prompt).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  const handleApply = () => {
    setParseError(null);
    const parsed = parseResponse(pasteText);
    if (!parsed) {
      setParseError('Could not parse JSON. Make sure you pasted the full response from Claude.');
      return;
    }
    onApply(parsed);
  };

  return (
    <div
      style={{ position: 'fixed', inset: 0, zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,0.6)', padding: 16 }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div style={{ background: 'var(--cgi-modal-bg)', border: '1px solid var(--cgi-border)', borderRadius: 12, padding: 24, width: 580, maxWidth: '96vw', maxHeight: '85vh', overflow: 'auto', boxShadow: '0 20px 60px rgba(0,0,0,0.45)', display: 'flex', flexDirection: 'column', gap: 16 }}>
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 600, fontSize: 15 }}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M12 2l2.4 7.4H22l-6.2 4.5 2.4 7.4L12 17l-6.2 4.3 2.4-7.4L2 9.4h7.6z"/>
            </svg>
            AI Prioritize — Claude Subscription
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--cgi-text)', opacity: 0.5, fontSize: 20, lineHeight: 1, padding: '2px 4px' }}>×</button>
        </div>

        {/* Steps */}
        <div style={{ display: 'flex', gap: 0, borderRadius: 8, overflow: 'hidden', border: '1px solid var(--cgi-border)' }}>
          {(['prompt', 'paste'] as const).map((s, i) => (
            <button
              key={s}
              onClick={() => setStep(s)}
              style={{
                flex: 1, padding: '8px 0', border: 'none', fontSize: 12, fontWeight: 600,
                background: step === s ? 'var(--cgi-accent)' : 'var(--cgi-btn-bg)',
                color: step === s ? '#fff' : 'var(--cgi-text)',
                cursor: 'pointer', borderRight: i === 0 ? '1px solid var(--cgi-border)' : 'none',
              }}
            >
              {i + 1}. {s === 'prompt' ? 'Copy Prompt' : 'Paste Response'}
            </button>
          ))}
        </div>

        {step === 'prompt' && (
          <>
            <div style={{ fontSize: 13, opacity: 0.75, lineHeight: 1.5 }}>
              Copy the prompt below and paste it into <strong>Claude.ai</strong> or any Claude chat window.
              Then come back and click <em>Paste Response</em>.
            </div>
            <div style={{ position: 'relative' }}>
              <textarea
                ref={promptRef}
                readOnly
                value={prompt}
                style={{
                  width: '100%', minHeight: 240, padding: '10px 12px', boxSizing: 'border-box',
                  background: 'var(--cgi-code-bg)', border: '1px solid var(--cgi-border)', borderRadius: 8,
                  color: 'var(--cgi-text)', fontSize: 11, fontFamily: 'monospace', lineHeight: 1.5,
                  resize: 'vertical', outline: 'none',
                }}
                onClick={() => promptRef.current?.select()}
              />
            </div>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button onClick={onClose} className="cgi-btn" style={{ opacity: 0.7 }}>Cancel</button>
              <button onClick={handleCopy} className="cgi-btn" style={{ background: copied ? '#22c55e' : 'var(--cgi-accent)', color: '#fff', border: 'none', fontWeight: 600, minWidth: 120 }}>
                {copied ? '✓ Copied!' : '⎘ Copy Prompt'}
              </button>
              <button onClick={() => setStep('paste')} className="cgi-btn" style={{ fontWeight: 600 }}>
                Next →
              </button>
            </div>
          </>
        )}

        {step === 'paste' && (
          <>
            <div style={{ fontSize: 13, opacity: 0.75, lineHeight: 1.5 }}>
              Paste Claude's JSON response below. It should start with <code style={{ background: 'var(--cgi-code-bg)', padding: '1px 5px', borderRadius: 4 }}>{`{"priorities":[`}</code>
            </div>
            <textarea
              value={pasteText}
              onChange={e => { setPasteText(e.target.value); setParseError(null); }}
              placeholder={`Paste Claude's response here...\n\nExpected format:\n{"priorities":[{"number":1,"priority":"high","reason":"..."},...]}`}
              style={{
                width: '100%', minHeight: 200, padding: '10px 12px', boxSizing: 'border-box',
                background: 'var(--cgi-input-bg)', border: `1px solid ${parseError ? '#ef4444' : 'var(--cgi-border)'}`,
                borderRadius: 8, color: 'var(--cgi-text)', fontSize: 12, fontFamily: 'monospace',
                lineHeight: 1.5, resize: 'vertical', outline: 'none',
              }}
            />
            {parseError && (
              <div style={{ background: 'rgba(239,68,68,0.12)', border: '1px solid rgba(239,68,68,0.3)', borderRadius: 6, padding: '8px 12px', fontSize: 12, color: '#ef4444' }}>
                {parseError}
              </div>
            )}
            <div style={{ display: 'flex', gap: 10, justifyContent: 'space-between' }}>
              <button onClick={() => setStep('prompt')} className="cgi-btn" style={{ opacity: 0.7 }}>← Back</button>
              <div style={{ display: 'flex', gap: 8 }}>
                <button onClick={onClose} className="cgi-btn" style={{ opacity: 0.7 }}>Cancel</button>
                <button
                  onClick={handleApply}
                  disabled={!pasteText.trim()}
                  className="cgi-btn"
                  style={{ background: 'var(--cgi-accent)', color: '#fff', border: 'none', fontWeight: 600 }}
                >
                  Apply Priorities
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
};
