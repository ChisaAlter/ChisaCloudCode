/**
 * Claude Usage plugin — module entry point.
 * Live plan-limit gauges + 30-day token/cost history.
 */

import type { PluginAPI, PluginContext } from './types.js';

// ── Response shapes (mirror server.ts output; do not import server code) ─

interface TokenCounts { input: number; output: number; cacheCreate: number; cacheRead: number }
interface LiveLimit { kind: string; label: string; percent: number; severity: string; resetsAt: string | null; model: string | null }
interface LiveData { plan: string | null; tier: string | null; limits: LiveLimit[] }
interface HistoryData {
  daily: { date: string; tokens: TokenCounts; cost: number }[];
  byModel: { model: string; tokens: TokenCounts; cost: number | null }[];
  byProject: { project: string; tokens: TokenCounts; cost: number | null }[];
  totals: { tokens: TokenCounts; cost: number; sessions: number; messages: number };
}

// ── Theme (matches starter conventions) ─────────────────────────────────

const MONO = "'JetBrains Mono', 'Fira Code', ui-monospace, monospace";

interface ThemeColors { bg: string; surface: string; border: string; text: string; muted: string; accent: string; ok: string; warn: string; bad: string }

function themeColors(dark: boolean): ThemeColors {
  return dark
    ? { bg: '#08080f', surface: '#0e0e1a', border: '#1a1a2c', text: '#e2e0f0', muted: '#52507a', accent: '#fbbf24', ok: '#10b981', warn: '#f59e0b', bad: '#f43f5e' }
    : { bg: '#fafaf9', surface: '#ffffff', border: '#e8e6f0', text: '#0f0e1a', muted: '#9490b0', accent: '#d97706', ok: '#059669', warn: '#d97706', bad: '#e11d48' };
}

function sevColor(c: ThemeColors, severity: string, percent: number): string {
  if (percent >= 90 || (severity !== 'normal' && severity !== 'warning')) return c.bad;
  if (percent >= 70 || severity === 'warning') return c.warn;
  return c.ok;
}

// ── Formatting helpers ──────────────────────────────────────────────────

function fmtTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}K`;
  if (n < 1_000_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  return `${(n / 1_000_000_000).toFixed(2)}B`;
}

function fmtCost(n: number | null): string {
  return n === null ? '—' : `$${n.toFixed(2)}`;
}

function totalOf(t: TokenCounts): number {
  return t.input + t.output + t.cacheCreate + t.cacheRead;
}

function resetsIn(iso: string | null): string {
  if (!iso) return '';
  const ms = Date.parse(iso) - Date.now();
  if (!Number.isFinite(ms)) return '';
  if (ms <= 0) return 'resetting…';
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  if (h >= 48) return `resets in ${Math.floor(h / 24)}d ${h % 24}h`;
  return h > 0 ? `resets in ${h}h ${m}m` : `resets in ${m}m`;
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch] as string));
}

// ── Section renderers ───────────────────────────────────────────────────

function card(c: ThemeColors, title: string, body: string): string {
  return `
    <div style="background:${c.surface};border:1px solid ${c.border};border-radius:3px;padding:18px;margin-bottom:12px">
      <div style="font-size:0.62rem;color:${c.muted};letter-spacing:0.12em;text-transform:uppercase;margin-bottom:14px">${title}</div>
      ${body}
    </div>`;
}

function errorNote(c: ThemeColors, msg: string): string {
  return `<div style="font-size:0.75rem;color:${c.warn};opacity:0.9">⚠ ${esc(msg)}</div>`;
}

function renderLive(c: ThemeColors, live: LiveData | null, error: string | null): string {
  const badge = live?.plan
    ? `<span style="font-size:0.62rem;border:1px solid ${c.border};border-radius:3px;padding:2px 8px;color:${c.muted}">${esc(live.plan)}${live.tier ? ` · ${esc(live.tier.replace(/^default_claude_/, ''))}` : ''}</span>`
    : '';
  let body: string;
  if (error) {
    body = errorNote(c, error);
  } else if (!live || live.limits.length === 0) {
    body = `<div style="font-size:0.75rem;color:${c.muted}">No limit data available.</div>`;
  } else {
    body = live.limits.map((l) => {
      const color = sevColor(c, l.severity, l.percent);
      const pct = Math.max(0, Math.min(100, l.percent));
      return `
        <div style="margin-bottom:14px">
          <div style="display:flex;justify-content:space-between;font-size:0.72rem;margin-bottom:5px">
            <span>${esc(l.label)}</span>
            <span style="color:${c.muted}">${l.percent}% · ${resetsIn(l.resetsAt)}</span>
          </div>
          <div style="height:6px;background:${c.border};border-radius:3px;overflow:hidden">
            <div style="height:100%;width:${pct}%;background:${color};border-radius:3px;transition:width 0.4s"></div>
          </div>
        </div>`;
    }).join('');
  }
  return card(c, `plan limits ${badge}`, body);
}

function renderChart(c: ThemeColors, daily: HistoryData['daily']): string {
  const max = Math.max(1, ...daily.map((d) => totalOf(d.tokens)));
  const bars = daily.map((d, i) => {
    const h = Math.round((totalOf(d.tokens) / max) * 100);
    const label = `${d.date}: ${fmtTokens(totalOf(d.tokens))} tokens · ${fmtCost(d.cost)}`;
    return `<div title="${label}" style="flex:1;display:flex;align-items:flex-end;height:90px">
      <div style="width:100%;height:${Math.max(h, totalOf(d.tokens) > 0 ? 3 : 0)}%;background:${c.accent};opacity:${0.45 + 0.55 * (i / daily.length)};border-radius:1px"></div>
    </div>`;
  }).join('');
  return `<div style="display:flex;gap:2px;align-items:flex-end">${bars}</div>
    <div style="display:flex;justify-content:space-between;font-size:0.62rem;color:${c.muted};margin-top:6px">
      <span>${daily[0]?.date ?? ''}</span><span>${daily[daily.length - 1]?.date ?? ''}</span>
    </div>`;
}

function renderTable(c: ThemeColors, rows: [string, TokenCounts, number | null][]): string {
  if (rows.length === 0) return `<div style="font-size:0.75rem;color:${c.muted}">No data.</div>`;
  return rows.map(([name, tokens, cost]) => `
    <div style="display:flex;justify-content:space-between;gap:8px;padding:4px 0;border-bottom:1px solid ${c.border};font-size:0.72rem">
      <div style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;opacity:0.8" title="${esc(name)}">${esc(name)}</div>
      <div style="flex-shrink:0;color:${c.muted}">${fmtTokens(totalOf(tokens))}</div>
      <div style="flex-shrink:0;width:70px;text-align:right;color:${c.accent}">${fmtCost(cost)}</div>
    </div>`).join('');
}

function renderHistory(c: ThemeColors, history: HistoryData | null, error: string | null): string {
  if (error) return card(c, 'usage history (30 days)', errorNote(c, error));
  if (!history) return card(c, 'usage history (30 days)', `<div style="font-size:0.75rem;color:${c.muted}">Loading…</div>`);
  if (history.totals.messages === 0) {
    return card(c, 'usage history (30 days)', `<div style="font-size:0.75rem;color:${c.muted}">No Claude Code activity found in the last 30 days.</div>`);
  }
  const t = history.totals;
  const stats: [string, string][] = [
    ['total tokens', fmtTokens(totalOf(t.tokens))],
    ['output tokens', fmtTokens(t.tokens.output)],
    ['est. cost', fmtCost(t.cost)],
    ['sessions', String(t.sessions)],
  ];
  const statCards = `
    <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:16px">
      ${stats.map(([label, val]) => `
        <div style="background:${c.surface};border:1px solid ${c.border};border-radius:3px;padding:14px">
          <div style="font-size:1.35rem;font-weight:700;letter-spacing:-0.03em">${val}</div>
          <div style="font-size:0.62rem;color:${c.muted};margin-top:4px;letter-spacing:0.1em;text-transform:uppercase">${label}</div>
        </div>`).join('')}
    </div>`;
  return `
    ${statCards}
    ${card(c, 'daily tokens (30 days)', renderChart(c, history.daily))}
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
      ${card(c, 'by model', renderTable(c, history.byModel.map((m) => [m.model, m.tokens, m.cost])))}
      ${card(c, 'by project', renderTable(c, history.byProject.slice(0, 10).map((p) => [p.project, p.tokens, p.cost])))}
    </div>`;
}

// ── Mount / Unmount ─────────────────────────────────────────────────────

interface State {
  live: LiveData | null;
  liveError: string | null;
  history: HistoryData | null;
  historyError: string | null;
}

export function mount(container: HTMLElement, api: PluginAPI): void {
  const root = document.createElement('div');
  Object.assign(root.style, {
    height: '100%', overflowY: 'auto', boxSizing: 'border-box',
    padding: '24px', fontFamily: MONO,
  });
  container.appendChild(root);

  const state: State = { live: null, liveError: null, history: null, historyError: null };

  function render(ctx: PluginContext): void {
    const c = themeColors(ctx.theme === 'dark');
    root.style.background = c.bg;
    root.style.color = c.text;
    root.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:20px">
        <div style="font-size:1.3rem;font-weight:700;letter-spacing:-0.02em">Claude Usage<span style="color:${c.accent}">▌</span></div>
        <button id="cu-refresh" style="padding:5px 12px;background:transparent;border:1px solid ${c.border};color:${c.muted};font-family:${MONO};font-size:0.7rem;border-radius:3px;cursor:pointer">↻ refresh</button>
      </div>
      ${renderLive(c, state.live, state.liveError)}
      ${renderHistory(c, state.history, state.historyError)}
    `;
    root.querySelector('#cu-refresh')?.addEventListener('click', () => void load(true));
  }

  async function loadLive(): Promise<void> {
    try {
      state.live = (await api.rpc('GET', 'live')) as LiveData;
      state.liveError = null;
    } catch (err) {
      state.live = null;
      state.liveError = (err as Error).message || 'Live usage unavailable.';
    }
  }

  async function loadHistory(): Promise<void> {
    try {
      state.history = (await api.rpc('GET', 'history?days=30')) as HistoryData;
      state.historyError = null;
    } catch (err) {
      state.history = null;
      state.historyError = (err as Error).message || 'History unavailable.';
    }
  }

  async function load(refreshHistory: boolean): Promise<void> {
    // Sections load and fail independently.
    await Promise.all([loadLive(), refreshHistory || !state.history ? loadHistory() : Promise.resolve()]);
    render(api.context);
  }

  render(api.context);
  void load(true);

  // Opening the account popup or pressing refresh requests the VPS cache.
  const unsubscribe = api.onContextChange((ctx) => render(ctx));

  (container as any)._cuCleanup = () => {
    unsubscribe();
  };
}

export function unmount(container: HTMLElement): void {
  (container as any)._cuCleanup?.();
  delete (container as any)._cuCleanup;
  container.innerHTML = '';
}
