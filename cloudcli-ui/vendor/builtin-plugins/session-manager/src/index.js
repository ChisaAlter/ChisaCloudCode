/**
 * Session Manager Plugin — UI
 * Shows all Claude Code sessions, lets you kill, resume, inspect context, and clean up logs.
 */

// ── Theme ──────────────────────────────────────────────────────────────

function colors(dark) {
  return dark
    ? { bg: '#08080f', surface: '#0e0e1a', border: '#1a1a2c', text: '#e2e0f0',
        muted: '#52507a', accent: '#fbbf24', danger: '#f43f5e', ok: '#10b981',
        warn: '#f59e0b', dim: 'rgba(251,191,36,0.08)', ctx: '#0b0b17' }
    : { bg: '#fafaf9', surface: '#ffffff', border: '#e8e6f0', text: '#0f0e1a',
        muted: '#9490b0', accent: '#d97706', danger: '#e11d48', ok: '#059669',
        warn: '#d97706', dim: 'rgba(217,119,6,0.06)', ctx: '#f5f4f8' };
}

const MONO = "'JetBrains Mono','Fira Code',ui-monospace,monospace";

// ── CSS injection ──────────────────────────────────────────────────────

function injectStyles(dark) {
  const id = 'sm-styles';
  const existing = document.getElementById(id);
  if (existing) existing.remove();

  const c = colors(dark);
  const style = document.createElement('style');
  style.id = id;
  style.textContent = `
    .sm-wrap { font-family: ${MONO}; color: ${c.text}; padding: 16px; background: ${c.bg}; max-height: 100%; overflow-y: auto; }
    .sm-header { display: flex; align-items: center; gap: 8px; margin-bottom: 16px; flex-wrap: wrap; }
    .sm-title { font-size: 14px; font-weight: 700; color: ${c.accent}; letter-spacing: .05em; text-transform: uppercase; }
    .sm-count { font-size: 11px; color: ${c.muted}; }
    .sm-refresh { background: ${c.surface}; border: 1px solid ${c.border}; color: ${c.muted}; padding: 4px 10px; border-radius: 6px; cursor: pointer; font-size: 11px; font-family: ${MONO}; }
    .sm-refresh:hover { color: ${c.text}; border-color: ${c.accent}; }
    .sm-auto { display: flex; align-items: center; gap: 6px; font-size: 11px; color: ${c.muted}; margin-left: auto; }
    .sm-auto input { accent-color: ${c.accent}; cursor: pointer; }
    .sm-table { width: 100%; border-collapse: collapse; font-size: 12px; }
    .sm-table th { text-align: left; padding: 6px 10px; color: ${c.muted}; font-weight: 600; border-bottom: 1px solid ${c.border}; font-size: 11px; text-transform: uppercase; letter-spacing: .05em; }
    .sm-table td { padding: 8px 10px; border-bottom: 1px solid ${c.border}; vertical-align: middle; }
    .sm-row-main { cursor: pointer; }
    .sm-row-main:hover td { background: ${c.dim}; }
    .sm-row-main.sm-expanded td { background: ${c.dim}; }
    .sm-pid { color: ${c.muted}; font-size: 11px; white-space: nowrap; }
    .sm-chevron { display: inline-block; width: 12px; color: ${c.muted}; font-size: 9px; transition: transform .15s; }
    .sm-project { font-weight: 600; color: ${c.text}; }
    .sm-cwd { color: ${c.muted}; font-size: 10px; max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .sm-user { color: ${c.muted}; font-size: 11px; }
    .sm-elapsed { color: ${c.muted}; font-size: 11px; }
    .sm-badge { display: inline-block; padding: 2px 7px; border-radius: 4px; font-size: 10px; font-weight: 700; }
    .sm-badge-stuck { background: rgba(244,63,94,.15); color: ${c.danger}; }
    .sm-badge-ok { background: rgba(16,185,129,.12); color: ${c.ok}; }
    .sm-badge-idle { background: rgba(148,144,176,.1); color: ${c.muted}; }
    .sm-actions { display: flex; gap: 6px; }
    .sm-btn { padding: 4px 10px; border-radius: 5px; font-size: 11px; font-family: ${MONO}; cursor: pointer; border: 1px solid transparent; font-weight: 600; transition: opacity .15s; }
    .sm-btn:hover { opacity: .8; }
    .sm-btn:disabled { opacity: .4; cursor: not-allowed; }
    .sm-kill { background: rgba(244,63,94,.15); border-color: ${c.danger}; color: ${c.danger}; }
    .sm-resume { background: rgba(16,185,129,.12); border-color: ${c.ok}; color: ${c.ok}; }
    .sm-cleanup-btn { background: rgba(148,144,176,.1); border: 1px solid ${c.border}; color: ${c.muted}; padding: 4px 10px; border-radius: 6px; cursor: pointer; font-size: 11px; font-family: ${MONO}; font-weight: 600; }
    .sm-cleanup-btn:hover { border-color: ${c.accent}; color: ${c.accent}; }
    .sm-cleanup-btn:disabled { opacity: .4; cursor: not-allowed; }
    .sm-empty { text-align: center; padding: 40px; color: ${c.muted}; font-size: 12px; }
    .sm-ctx-row td { padding: 0; border-bottom: 1px solid ${c.border}; }
    .sm-ctx-inner { padding: 12px 20px 14px 32px; background: ${c.ctx}; border-top: 1px solid ${c.border}; }
    .sm-ctx-loading { font-size: 11px; color: ${c.muted}; font-style: italic; }
    .sm-ctx-section { margin-bottom: 10px; }
    .sm-ctx-section:last-child { margin-bottom: 0; }
    .sm-ctx-label { font-size: 9px; font-weight: 700; text-transform: uppercase; letter-spacing: .08em; color: ${c.accent}; margin-bottom: 4px; }
    .sm-ctx-body { font-size: 11px; color: ${c.text}; white-space: pre-wrap; word-break: break-word; max-height: 100px; overflow-y: auto; line-height: 1.5; }
    .sm-ctx-none { font-size: 11px; color: ${c.muted}; font-style: italic; }
    .sm-toast { position: fixed; bottom: 20px; right: 20px; background: ${c.surface}; border: 1px solid ${c.border}; color: ${c.text}; padding: 10px 16px; border-radius: 8px; font-size: 12px; font-family: ${MONO}; z-index: 9999; box-shadow: 0 4px 20px rgba(0,0,0,.3); max-width: 360px; }
  `;
  document.head.appendChild(style);
}

// ── Toast ──────────────────────────────────────────────────────────────

function toast(msg, duration = 3500) {
  const el = document.createElement('div');
  el.className = 'sm-toast';
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), duration);
}

// ── Main plugin ────────────────────────────────────────────────────────

export function mount(container, api) {
  let sessions = [];
  let loading = false;
  let autoRefresh = true;
  let intervalId = null;
  let dark = api.context.theme === 'dark';
  let expandedPid = null;
  const contextCache = new Map();

  injectStyles(dark);

  api.onContextChange(ctx => {
    dark = ctx.theme === 'dark';
    injectStyles(dark);
    render();
  });

  // ── Fetch sessions ───────────────────────────────────────────────────

  async function fetchSessions() {
    if (loading) return;
    loading = true;
    renderLoading();
    try {
      sessions = await api.rpc('GET', '/sessions');
    } catch (e) {
      toast('Failed to load sessions: ' + e.message);
    }
    loading = false;
    render();
  }

  // ── Context ──────────────────────────────────────────────────────────

  async function fetchContext(pid) {
    if (contextCache.has(pid) && contextCache.get(pid) !== 'error') return;
    contextCache.set(pid, 'loading');
    render();
    try {
      const ctx = await api.rpc('GET', `/sessions/${pid}/context`);
      contextCache.set(pid, ctx);
    } catch (e) {
      contextCache.set(pid, 'error');
    }
    render();
  }

  function toggleExpand(pid) {
    if (expandedPid === pid) {
      expandedPid = null;
      render();
    } else {
      expandedPid = pid;
      fetchContext(pid);
    }
  }

  // ── Session actions ──────────────────────────────────────────────────

  async function killSession(pid) {
    try {
      await api.rpc('POST', `/sessions/${pid}/kill`);
      toast(`Sent SIGTERM to PID ${pid}`);
      if (expandedPid === pid) expandedPid = null;
      contextCache.delete(pid);
      setTimeout(fetchSessions, 1500);
    } catch (e) {
      toast('Kill failed: ' + e.message);
    }
  }

  async function resumeSession(session) {
    if (!session.sessionId || !session.cwd) {
      toast('No session ID or cwd available to resume');
      return;
    }
    try {
      const r = await api.rpc('POST', '/sessions/resume', {
        sessionId: session.sessionId,
        cwd: session.cwd,
        user: session.user,
      });
      toast(`Resumed session ${session.sessionId.slice(0, 8)}... (PID ${r.pid})`);
      setTimeout(fetchSessions, 1500);
    } catch (e) {
      toast('Resume failed: ' + e.message);
    }
  }

  async function runCleanup() {
    const btn = container.querySelector('#sm-cleanup-btn');
    if (btn) { btn.disabled = true; btn.textContent = 'Cleaning...'; }
    try {
      const r = await api.rpc('POST', '/sessions/cleanup');
      const parts = [];
      if (r.deletedSessions > 0) parts.push(`${r.deletedSessions} orphaned session${r.deletedSessions !== 1 ? 's' : ''} deleted`);
      if (r.compressedLogs > 0) parts.push(`${r.compressedLogs} log${r.compressedLogs !== 1 ? 's' : ''} compressed`);
      if (parts.length === 0) parts.push('nothing to clean up');
      toast('Cleanup: ' + parts.join(', '));
      fetchSessions();
    } catch (e) {
      toast('Cleanup failed: ' + e.message);
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = 'Cleanup'; }
    }
  }

  // ── Render helpers ───────────────────────────────────────────────────

  function renderLoading() {
    if (!container.querySelector('.sm-wrap')) render();
    const tbody = container.querySelector('.sm-tbody');
    if (tbody) {
      tbody.innerHTML = `<tr><td colspan="6" class="sm-empty">Refreshing...</td></tr>`;
    }
  }

  function statusBadge(s) {
    if (s.status === 'stuck') return `<span class="sm-badge sm-badge-stuck">STUCK</span>`;
    if (s.status === 'idle')  return `<span class="sm-badge sm-badge-idle">IDLE</span>`;
    return `<span class="sm-badge sm-badge-ok">ACTIVE</span>`;
  }

  function renderContextRow(s) {
    const ctx = contextCache.get(s.pid);
    let inner = '';

    if (!ctx || ctx === 'loading') {
      inner = `<span class="sm-ctx-loading">${ctx === 'loading' ? 'Loading context...' : ''}</span>`;
    } else if (ctx === 'error') {
      inner = `<span class="sm-ctx-none">Could not load session context</span>`;
    } else {
      const hasAny = ctx.lastPrompt || ctx.awaySummary || ctx.lastAssistant;
      if (!hasAny) {
        inner = `<span class="sm-ctx-none">No context found in session log</span>`;
      } else {
        if (ctx.lastPrompt) {
          inner += `<div class="sm-ctx-section">
            <div class="sm-ctx-label">Last Prompt</div>
            <div class="sm-ctx-body">${escHtml(ctx.lastPrompt)}</div>
          </div>`;
        }
        if (ctx.awaySummary) {
          inner += `<div class="sm-ctx-section">
            <div class="sm-ctx-label">Away Summary</div>
            <div class="sm-ctx-body">${escHtml(ctx.awaySummary)}</div>
          </div>`;
        }
        if (ctx.lastAssistant) {
          inner += `<div class="sm-ctx-section">
            <div class="sm-ctx-label">Last Claude Output</div>
            <div class="sm-ctx-body">${escHtml(ctx.lastAssistant)}</div>
          </div>`;
        }
      }
    }

    return `<tr class="sm-ctx-row"><td colspan="6"><div class="sm-ctx-inner">${inner}</div></td></tr>`;
  }

  function renderRow(s) {
    const isExpanded = expandedPid === s.pid;
    const chevron = `<span class="sm-chevron">${isExpanded ? '\u25BC' : '\u25B6'}</span>`;
    const mainRow = `
      <tr class="sm-row-main${isExpanded ? ' sm-expanded' : ''}" data-pid="${s.pid}">
        <td class="sm-pid">${chevron}${s.pid}</td>
        <td>
          <div class="sm-project">${escHtml(s.project)}</div>
          <div class="sm-cwd" title="${escHtml(s.cwd)}">${escHtml(s.cwd)}</div>
          ${s.sessionId ? `<div class="sm-cwd">${escHtml(s.sessionId.slice(0,8))}...</div>` : ''}
        </td>
        <td class="sm-user">${escHtml(s.user)}</td>
        <td class="sm-elapsed">${escHtml(s.elapsed)}</td>
        <td>${statusBadge(s)}</td>
        <td>
          <div class="sm-actions">
            <button class="sm-btn sm-kill" data-pid="${s.pid}">Kill</button>
            ${s.sessionId ? `<button class="sm-btn sm-resume" data-resume='${JSON.stringify({sessionId: s.sessionId, cwd: s.cwd, user: s.user})}'>Resume</button>` : ''}
          </div>
        </td>
      </tr>`;
    return isExpanded ? mainRow + renderContextRow(s) : mainRow;
  }

  function render() {
    container.innerHTML = `
      <div class="sm-wrap">
        <div class="sm-header">
          <span class="sm-title">Claude Sessions</span>
          <span class="sm-count">${sessions.length} process${sessions.length !== 1 ? 'es' : ''}</span>
          <button class="sm-refresh" id="sm-refresh-btn">Refresh</button>
          <button class="sm-cleanup-btn" id="sm-cleanup-btn">Cleanup</button>
          <label class="sm-auto">
            <input type="checkbox" id="sm-auto-cb" ${autoRefresh ? 'checked' : ''}> Auto (10s)
          </label>
        </div>
        <table class="sm-table">
          <thead>
            <tr>
              <th>PID</th>
              <th>Project</th>
              <th>User</th>
              <th>Uptime</th>
              <th>Status</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody class="sm-tbody">
            ${sessions.length === 0
              ? `<tr><td colspan="6" class="sm-empty">${loading ? 'Loading...' : 'No Claude sessions found'}</td></tr>`
              : sessions.map(renderRow).join('')}
          </tbody>
        </table>
      </div>
    `;

    // Header controls
    container.querySelector('#sm-refresh-btn')?.addEventListener('click', fetchSessions);
    container.querySelector('#sm-cleanup-btn')?.addEventListener('click', runCleanup);
    container.querySelector('#sm-auto-cb')?.addEventListener('change', (e) => {
      autoRefresh = e.target.checked;
      if (autoRefresh) startAuto(); else stopAuto();
    });

    // Row expand on click (ignore clicks on action buttons)
    container.querySelectorAll('.sm-row-main').forEach(row => {
      row.addEventListener('click', (e) => {
        if (e.target.closest('.sm-actions')) return;
        toggleExpand(parseInt(row.dataset.pid, 10));
      });
    });

    // Kill / Resume buttons
    container.querySelectorAll('.sm-kill').forEach(btn => {
      btn.addEventListener('click', () => killSession(parseInt(btn.dataset.pid, 10)));
    });
    container.querySelectorAll('.sm-resume').forEach(btn => {
      btn.addEventListener('click', () => {
        try { resumeSession(JSON.parse(btn.dataset.resume)); }
        catch (e) { toast('Parse error: ' + e.message); }
      });
    });
  }

  function escHtml(s) {
    return String(s || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // ── Auto-refresh ─────────────────────────────────────────────────────

  function startAuto() {
    stopAuto();
    intervalId = setInterval(fetchSessions, 10_000);
  }

  function stopAuto() {
    if (intervalId) { clearInterval(intervalId); intervalId = null; }
  }

  // ── Init ─────────────────────────────────────────────────────────────

  render();
  fetchSessions();
  if (autoRefresh) startAuto();
}

export function unmount(container) {
  container.innerHTML = '';
  const styles = document.getElementById('sm-styles');
  if (styles) styles.remove();
}
