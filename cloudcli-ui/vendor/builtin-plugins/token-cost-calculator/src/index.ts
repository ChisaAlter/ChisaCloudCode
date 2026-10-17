/**
 * Token Cost Calculator — frontend entry point.
 *
 * Four modes:
 *  - Manual:       enter token counts by hand (with quick-add buttons)
 *  - Auto-detect:  reads token usage from one active Claude session transcript
 *  - Project:      sums ALL sessions under one project folder
 *  - All-time:     sums ALL sessions across every project since install
 *
 * All modes share the same price model & cost breakdown.
 */

import type { PluginAPI, PluginContext } from './types.js';

// ── Types ──────────────────────────────────────────────────────────────

interface ModelPreset {
  name: string;
  provider: string;
  inputPrice: number;
  outputPrice: number;
  cachedInputPrice: number;
}

interface CostBreakdown {
  inputCost: number;
  outputCost: number;
  cachedInputCost: number;
  total: number;
}

interface SessionUsage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  turnCount: number;
  sessionId: string;
  projectPath: string;
  model: string;
  error?: string;
}

interface SessionSummary {
  sessionId: string;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  turnCount: number;
  model: string;
}

interface ProjectUsage {
  projectPath: string;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  turnCount: number;
  sessionCount: number;
  sessions: SessionSummary[];
  error?: string;
}

interface AllUsage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  turnCount: number;
  sessionCount: number;
  projectCount: number;
  projects: {
    projectPath: string;
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens: number;
    turnCount: number;
    sessionCount: number;
  }[];
  error?: string;
}

interface DailyUsage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  turnCount: number;
  sessionCount: number;
  days: {
    date: string;
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens: number;
    turnCount: number;
    sessionCount: number;
  }[];
  error?: string;
}

type Mode = 'manual' | 'auto' | 'project' | 'all' | 'daily';

// ── Constants ──────────────────────────────────────────────────────────

const MONO = "'JetBrains Mono', 'Fira Code', ui-monospace, monospace";
const STORAGE_KEY = 'tcc-state';
const AUTO_REFRESH_MS = 30_000;

const BAR_PALETTE = [
  '#6366f1', '#22d3ee', '#f59e0b', '#10b981',
  '#f43f5e', '#a78bfa', '#fb923c', '#34d399',
  '#60a5fa', '#e879f9', '#facc15', '#4ade80',
];

// ── Persistent state ───────────────────────────────────────────────────

interface StoredState {
  mode: Mode;
  inputPrice: number;
  outputPrice: number;
  cachedInputPrice: number;
  // Manual tokens
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
}

function loadState(): StoredState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const s = JSON.parse(raw);
      if (!['manual', 'auto', 'project', 'all', 'daily'].includes(s.mode)) s.mode = 'manual';
      return s;
    }
  } catch { /* ignore */ }
  return {
    mode: 'manual',
    inputPrice: 3.0,
    outputPrice: 15.0,
    cachedInputPrice: 0.3,
    inputTokens: 1_000_000,
    outputTokens: 100_000,
    cachedInputTokens: 0,
  };
}

function saveState(s: StoredState): void {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(s)); } catch { /* ignore */ }
}

// ── Theme helpers ──────────────────────────────────────────────────────

interface ThemeColors {
  bg: string;
  surface: string;
  border: string;
  text: string;
  muted: string;
  accent: string;
  accentDim: string;
  green: string;
  greenDim: string;
  inputBg: string;
  warn: string;
}

function themeColors(dark: boolean): ThemeColors {
  return dark
    ? {
        bg: '#08080f',
        surface: '#0e0e1a',
        border: '#1a1a2c',
        text: '#e2e0f0',
        muted: '#52507a',
        accent: '#6366f1',
        accentDim: 'rgba(99,102,241,0.12)',
        green: '#10b981',
        greenDim: 'rgba(16,185,129,0.12)',
        inputBg: '#0a0a14',
        warn: '#f59e0b',
      }
    : {
        bg: '#fafaf9',
        surface: '#ffffff',
        border: '#e8e6f0',
        text: '#0f0e1a',
        muted: '#9490b0',
        accent: '#4f46e5',
        accentDim: 'rgba(79,70,229,0.08)',
        green: '#059669',
        greenDim: 'rgba(5,150,105,0.08)',
        inputBg: '#f9f9fd',
        warn: '#d97706',
      };
}

// ── Utility ────────────────────────────────────────────────────────────

function fmtUSD(n: number): string {
  if (n < 0.001) return '$0.000';
  if (n < 1) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(3)}`;
}

function fmtTokens(n: number): string {
  return n.toLocaleString();
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

function ago(ms: number): string {
  const s = Math.floor((Date.now() - ms) / 1000);
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  return `${Math.floor(s / 60)}m ago`;
}

// ── Cost calculation ───────────────────────────────────────────────────

function calculate(
  prices: { inputPrice: number; outputPrice: number; cachedInputPrice: number },
  tokens: { inputTokens: number; outputTokens: number; cachedInputTokens: number },
): CostBreakdown {
  const inputCost = (tokens.inputTokens / 1_000_000) * prices.inputPrice;
  const outputCost = (tokens.outputTokens / 1_000_000) * prices.outputPrice;
  const cachedInputCost = (tokens.cachedInputTokens / 1_000_000) * prices.cachedInputPrice;
  const total = inputCost + outputCost + cachedInputCost;
  return {
    inputCost: Math.round(inputCost * 10000) / 10000,
    outputCost: Math.round(outputCost * 10000) / 10000,
    cachedInputCost: Math.round(cachedInputCost * 10000) / 10000,
    total: Math.round(total * 10000) / 10000,
  };
}

// ── Mount / Unmount ────────────────────────────────────────────────────

export function mount(container: HTMLElement, api: PluginAPI): void {
  ensureAssets();

  let presets: ModelPreset[] = [];
  const state = loadState();

  // Data-fetch state
  let sessionUsage: SessionUsage | null = null;
  let projectUsage: ProjectUsage | null = null;
  let allUsageVal: AllUsage | null = null;
  let dailyUsage: DailyUsage | null = null;
  let selectedDate = new Date().toISOString().slice(0, 10); // YYYY-MM-DD, default today
  let lastFetch = 0;
  let fetchError = '';
  let refreshTimer: ReturnType<typeof setTimeout> | null = null;
  let manualSessionId = '';
  let manualProjectPath = '';

  const root = document.createElement('div');
  Object.assign(root.style, {
    height: '100%',
    overflowY: 'auto',
    boxSizing: 'border-box',
    padding: '24px',
    fontFamily: MONO,
  });
  container.appendChild(root);

  // ── Render ───────────────────────────────────────────────────

  function render(ctx: PluginContext): void {
    const c = themeColors(ctx.theme === 'dark');
    root.style.background = c.bg;
    root.style.color = c.text;

    const m = state.mode;
    const isManual = m === 'manual';
    const isAuto = m === 'auto';
    const isProject = m === 'project';
    const isAll = m === 'all';
    const isDaily = m === 'daily';

    // Determine active token data
    const tokens = isManual
      ? { inputTokens: state.inputTokens, outputTokens: state.outputTokens, cachedInputTokens: state.cachedInputTokens }
      : isAuto && sessionUsage
        ? { inputTokens: sessionUsage.inputTokens, outputTokens: sessionUsage.outputTokens, cachedInputTokens: sessionUsage.cachedInputTokens }
        : isProject && projectUsage
          ? { inputTokens: projectUsage.inputTokens, outputTokens: projectUsage.outputTokens, cachedInputTokens: projectUsage.cachedInputTokens }
          : isAll && allUsageVal
            ? { inputTokens: allUsageVal.inputTokens, outputTokens: allUsageVal.outputTokens, cachedInputTokens: allUsageVal.cachedInputTokens }
            : isDaily && dailyUsage
              ? (() => {
                  const day = dailyUsage.days.find(d => d.date === selectedDate);
                  return day ? { inputTokens: day.inputTokens, outputTokens: day.outputTokens, cachedInputTokens: day.cachedInputTokens } : { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 };
                })()
              : { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 };

    const costs = calculate(
      { inputPrice: state.inputPrice, outputPrice: state.outputPrice, cachedInputPrice: state.cachedInputPrice },
      tokens,
    );

    const hasSession = !!(ctx.session?.id && ctx.project?.path);

    // ── Build mode button HTML ──────────────────────────────────

    const modeBtn = (id: string, label: string, active: boolean) => `
      <button id="${id}" style="
        padding:5px 14px;font-family:${MONO};font-size:0.7rem;border-radius:3px;cursor:pointer;
        border:1px solid ${active ? c.accent : c.border};
        background:${active ? c.accentDim : 'transparent'};
        color:${active ? c.accent : c.muted};
        transition:all 0.15s;
      ">${label}</button>`;

    // ── Status badge ─────────────────────────────────────────────

    let statusBadge = '';
    if (isAuto) {
      statusBadge = hasSession
        ? `<span style="font-size:0.62rem;color:${c.green}">● monitoring session</span>`
        : `<span style="font-size:0.62rem;color:${c.warn}">⚠ no session context</span>`;
    } else if (isProject && projectUsage) {
      statusBadge = `<span style="font-size:0.62rem;color:${c.green}">${projectUsage.sessionCount} sessions · ${projectUsage.turnCount} turns</span>`;
    } else if (isAll && allUsageVal) {
      statusBadge = `<span style="font-size:0.62rem;color:${c.green}">${allUsageVal.projectCount} projects · ${allUsageVal.sessionCount} sessions</span>`;
    } else if (isDaily && dailyUsage) {
      const dayData = dailyUsage.days.find(d => d.date === selectedDate);
      statusBadge = `<span style="font-size:0.62rem;color:${c.green}">${dailyUsage.days.length} days total${dayData ? ` · ${dayData.sessionCount}s · ${dayData.turnCount}t today` : ''}</span>`;
    }

    // ── Token display label ──────────────────────────────────────

    const tokenLabel = isManual ? 'Token Usage'
      : isAuto ? 'Token Usage (from session)'
      : isProject ? `Token Usage (${projectUsage?.sessionCount || 0} sessions)`
      : isAll ? `Token Usage (${allUsageVal?.projectCount || 0} projects, ${allUsageVal?.sessionCount || 0} sessions)`
      : `Token Usage — ${selectedDate}`;

    // prettier-ignore
    root.innerHTML = `
      <!-- Header -->
      <div class="tcc-header" style="margin-bottom:20px;display:flex;align-items:flex-start;justify-content:space-between">
        <div style="min-width:0;flex:1">
          <div style="font-size:1.3rem;font-weight:700;letter-spacing:-0.02em">
            Token Cost Calculator<span style="color:${c.accent}">▌</span>
          </div>
          <div style="font-size:0.7rem;color:${c.muted};margin-top:4px">Calculate API costs from token usage</div>
        </div>
      </div>

      <!-- ── Mode switch ── -->
      <div class="tcc-section" style="background:${c.surface};border:1px solid ${c.border};border-radius:3px;padding:10px 18px;margin-bottom:12px">
        <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">
          <span style="font-size:0.62rem;color:${c.muted};letter-spacing:0.12em;text-transform:uppercase;margin-right:4px">Mode</span>
          ${modeBtn('tcc-mode-manual', 'Manual', isManual)}
          ${modeBtn('tcc-mode-auto', 'Auto-detect', isAuto)}
          ${modeBtn('tcc-mode-project', 'Project', isProject)}
          ${modeBtn('tcc-mode-all', 'All-time', isAll)}
          ${modeBtn('tcc-mode-daily', 'Daily', isDaily)}
          ${statusBadge}
        </div>
      </div>

      <!-- ── Project path input (Auto without session, or Project mode) ── -->
      ${((isAuto && !hasSession) || isProject) ? `
      <div class="tcc-section" style="background:${c.surface};border:1px solid ${c.border};border-radius:3px;padding:14px 18px;margin-bottom:12px">
        <div style="font-size:0.62rem;color:${c.muted};letter-spacing:0.12em;text-transform:uppercase;margin-bottom:10px">
          ${isProject ? 'Project Path' : 'Session Config'}
          <span style="text-transform:none;letter-spacing:0;color:${c.warn};margin-left:6px">(enter path manually)</span>
        </div>
        <div style="display:${isAuto ? 'grid' : 'flex'};grid-template-columns:1fr 1fr;gap:10px;align-items:flex-end">
          <div style="flex:1">
            <label for="tcc-manual-project" style="display:block;font-size:0.6rem;color:${c.muted};margin-bottom:3px">Project Path</label>
            <input id="tcc-manual-project" type="text" value="${manualProjectPath}" placeholder="C:\\Users\\...\\my-project"
              style="width:100%;padding:6px 10px;background:${c.inputBg};border:1px solid ${c.border};
              color:${c.text};font-family:${MONO};font-size:0.7rem;border-radius:3px;
              outline:none;box-sizing:border-box;transition:border-color 0.15s"
              onfocus="this.style.borderColor='${c.accent}'" onblur="this.style.borderColor='${c.border}'">
          </div>
          ${isAuto ? `
          <div>
            <label for="tcc-manual-session" style="display:block;font-size:0.6rem;color:${c.muted};margin-bottom:3px">Session ID</label>
            <input id="tcc-manual-session" type="text" value="${manualSessionId}" placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
              style="width:100%;padding:6px 10px;background:${c.inputBg};border:1px solid ${c.border};
              color:${c.text};font-family:${MONO};font-size:0.7rem;border-radius:3px;
              outline:none;box-sizing:border-box;transition:border-color 0.15s"
              onfocus="this.style.borderColor='${c.accent}'" onblur="this.style.borderColor='${c.border}'">
          </div>` : ''}
          <button id="${isAuto ? 'tcc-connect-session' : 'tcc-fetch-project'}" style="
            padding:6px 14px;background:${c.accent};border:1px solid ${c.accent};
            color:#fff;font-family:${MONO};font-size:0.68rem;
            border-radius:3px;cursor:pointer;transition:all 0.15s;
            ${isAuto ? '' : 'white-space:nowrap;margin-left:10px;'}
          ">${isAuto ? 'Connect' : 'Fetch'}</button>
        </div>
        ${fetchError ? `<div style="font-size:0.62rem;color:${c.warn};margin-top:8px">⚠ ${fetchError}</div>` : ''}
      </div>
      ` : ''}

      <!-- ── Session info (auto mode with session) ── -->
      ${isAuto && hasSession ? `
      <div class="tcc-section" style="background:${c.surface};border:1px solid ${c.border};border-radius:3px;padding:14px 18px;margin-bottom:12px">
        <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px">
          <div>
            <div style="font-size:0.7rem;color:${c.text};font-weight:600">
              ${ctx.session?.title || 'Session'} ${sessionUsage?.turnCount ? `· ${sessionUsage.turnCount} turns` : ''}
            </div>
            <div style="font-size:0.62rem;color:${c.muted};margin-top:2px">
              ${ctx.session?.id || '—'} ${sessionUsage?.model ? `· model: ${sessionUsage.model}` : ''}
            </div>
            ${fetchError ? `<div style="font-size:0.62rem;color:${c.warn};margin-top:2px">⚠ ${fetchError}</div>` : ''}
          </div>
          <button id="tcc-refresh" style="
            padding:4px 12px;background:${c.accentDim};border:1px solid ${c.border};
            color:${c.accent};font-family:${MONO};font-size:0.68rem;
            border-radius:3px;cursor:pointer;transition:all 0.15s;
          ">↻ refresh ${lastFetch ? `· ${ago(lastFetch)}` : ''}</button>
        </div>
      </div>
      ` : ''}

      <!-- ── All-time summary info ── -->
      ${isAll && allUsageVal ? `
      <div class="tcc-section" style="background:${c.surface};border:1px solid ${c.border};border-radius:3px;padding:14px 18px;margin-bottom:12px">
        <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px">
          <div>
            <div style="font-size:0.7rem;color:${c.text};font-weight:600">
              ${allUsageVal.projectCount} projects · ${allUsageVal.sessionCount} sessions · ${allUsageVal.turnCount} turns
            </div>
            <div style="font-size:0.62rem;color:${c.muted};margin-top:2px">
              All Claude Code usage since install
            </div>
            ${fetchError ? `<div style="font-size:0.62rem;color:${c.warn};margin-top:2px">⚠ ${fetchError}</div>` : ''}
          </div>
          <button id="tcc-refresh" style="
            padding:4px 12px;background:${c.accentDim};border:1px solid ${c.border};
            color:${c.accent};font-family:${MONO};font-size:0.68rem;
            border-radius:3px;cursor:pointer;transition:all 0.15s;
          ">↻ refresh ${lastFetch ? `· ${ago(lastFetch)}` : ''}</button>
        </div>
      </div>
      ` : ''}

      <!-- ── Daily day navigator ── -->
      ${isDaily && dailyUsage ? `
      <div class="tcc-section" style="background:${c.surface};border:1px solid ${c.border};border-radius:3px;padding:14px 18px;margin-bottom:12px">
        <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px">
          <div style="display:flex;align-items:center;gap:8px">
            <button id="tcc-day-prev" ${dailyUsage.days.findIndex(d => d.date === selectedDate) <= 0 ? 'disabled' : ''} style="
              padding:4px 8px;background:transparent;border:1px solid ${c.border};
              color:${c.text};font-family:${MONO};font-size:0.7rem;cursor:pointer;
              border-radius:3px;transition:all 0.15s;
              opacity:${dailyUsage.days.findIndex(d => d.date === selectedDate) <= 0 ? '0.3' : '1'};
            ">◀</button>
            <span style="font-size:0.85rem;font-weight:600;color:${c.accent};min-width:90px;text-align:center">
              ${selectedDate}
            </span>
            <button id="tcc-day-next" ${dailyUsage.days.findIndex(d => d.date === selectedDate) >= dailyUsage.days.length - 1 ? 'disabled' : ''} style="
              padding:4px 8px;background:transparent;border:1px solid ${c.border};
              color:${c.text};font-family:${MONO};font-size:0.7rem;cursor:pointer;
              border-radius:3px;transition:all 0.15s;
              opacity:${dailyUsage.days.findIndex(d => d.date === selectedDate) >= dailyUsage.days.length - 1 ? '0.3' : '1'};
            ">▶</button>
            <button id="tcc-day-today" ${!dailyUsage.days.some(d => d.date === new Date().toISOString().slice(0, 10)) || selectedDate === new Date().toISOString().slice(0, 10) ? 'disabled' : ''} style="
              padding:4px 8px;background:transparent;border:1px solid ${c.accent};
              color:${c.accent};font-family:${MONO};font-size:0.62rem;cursor:pointer;
              border-radius:3px;transition:all 0.15s;
              opacity:${!dailyUsage.days.some(d => d.date === new Date().toISOString().slice(0, 10)) || selectedDate === new Date().toISOString().slice(0, 10) ? '0.3' : '1'};
            ">● today</button>
          </div>
          <div style="display:flex;align-items:center;gap:8px">
            <span style="font-size:0.62rem;color:${c.muted}">${dailyUsage.days[0]?.date || '—'} ~ ${dailyUsage.days[dailyUsage.days.length - 1]?.date || '—'}</span>
            <button id="tcc-refresh" style="
              padding:4px 12px;background:${c.accentDim};border:1px solid ${c.border};
              color:${c.accent};font-family:${MONO};font-size:0.68rem;
              border-radius:3px;cursor:pointer;transition:all 0.15s;
            ">↻ ${lastFetch ? ago(lastFetch) : 'refresh'}</button>
          </div>
        </div>
        ${fetchError ? `<div style="font-size:0.62rem;color:${c.warn};margin-top:8px">⚠ ${fetchError}</div>` : ''}
      </div>
      ` : ''}

      <!-- ── Model Preset Selector ── -->
      <div class="tcc-section" style="background:${c.surface};border:1px solid ${c.border};border-radius:3px;padding:18px;margin-bottom:12px">
        <div style="font-size:0.62rem;color:${c.muted};letter-spacing:0.12em;text-transform:uppercase;margin-bottom:14px">Model Preset</div>
        <select id="tcc-preset" style="
          width:100%;padding:8px 12px;background:${c.inputBg};border:1px solid ${c.border};
          color:${c.text};font-family:${MONO};font-size:0.78rem;border-radius:3px;
          cursor:pointer;outline:none;
        ">
          <option value="">-- Custom --</option>
          ${presets.map((p) => `<option value="${p.name}">${p.name} (${p.provider})</option>`).join('')}
        </select>
      </div>

      <!-- ── Price Inputs ── -->
      <div class="tcc-section" style="background:${c.surface};border:1px solid ${c.border};border-radius:3px;padding:18px;margin-bottom:12px">
        <div style="font-size:0.62rem;color:${c.muted};letter-spacing:0.12em;text-transform:uppercase;margin-bottom:14px">Price per 1M Tokens (USD)</div>
        <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px">
          ${priceField('tcc-input-price', 'Input Price', state.inputPrice, c)}
          ${priceField('tcc-output-price', 'Output Price', state.outputPrice, c)}
          ${priceField('tcc-cached-price', 'Cache Input Price', state.cachedInputPrice, c)}
        </div>
      </div>

      <!-- ── Token Usage ── -->
      <div class="tcc-section" style="background:${c.surface};border:1px solid ${c.border};border-radius:3px;padding:18px;margin-bottom:12px">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px">
          <div style="font-size:0.62rem;color:${c.muted};letter-spacing:0.12em;text-transform:uppercase">${tokenLabel}</div>
          ${!isManual ? `<div style="font-size:0.62rem;color:${c.muted}">${fmtTokens(tokens.inputTokens + tokens.outputTokens + tokens.cachedInputTokens)} total</div>` : ''}
        </div>
        <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px">
          ${tokenField('tcc-input-tokens', 'Input Tokens', tokens.inputTokens, !isManual, c)}
          ${tokenField('tcc-output-tokens', 'Output Tokens', tokens.outputTokens, !isManual, c)}
          ${tokenField('tcc-cached-tokens', 'Cached Input Tokens', tokens.cachedInputTokens, !isManual, c)}
        </div>
      </div>

      <!-- ── Quick-add buttons (manual only) ── -->
      ${isManual ? `
      <div class="tcc-section" style="background:${c.surface};border:1px solid ${c.border};border-radius:3px;padding:18px;margin-bottom:12px">
        <div style="font-size:0.62rem;color:${c.muted};letter-spacing:0.12em;text-transform:uppercase;margin-bottom:14px">Quick Add Tokens</div>
        <div style="display:flex;flex-wrap:wrap;gap:6px">
          ${[1000, 10_000, 100_000, 1_000_000, 10_000_000].map((n) =>
            `<button class="tcc-quick-btn" data-tokens="${n}" style="
              padding:4px 10px;background:${c.accentDim};border:1px solid ${c.border};
              color:${c.accent};font-family:${MONO};font-size:0.68rem;
              border-radius:3px;cursor:pointer;transition:all 0.15s;
            ">+${n >= 1_000_000 ? n / 1_000_000 + 'M' : n >= 1000 ? n / 1000 + 'K' : n}</button>`
          ).join('')}
          <span style="font-size:0.62rem;color:${c.muted};display:flex;align-items:center;margin-left:6px">→ active field</span>
        </div>
      </div>
      ` : ''}

      <!-- ── Per-session breakdown (Project mode) ── -->
      ${isProject && projectUsage && projectUsage.sessions.length > 0 ? `
      <div class="tcc-section" style="background:${c.surface};border:1px solid ${c.border};border-radius:3px;padding:18px;margin-bottom:12px">
        <div style="font-size:0.62rem;color:${c.muted};letter-spacing:0.12em;text-transform:uppercase;margin-bottom:12px">Per-Session Breakdown</div>
        <div style="max-height:260px;overflow-y:auto">
          ${projectUsage.sessions.map((s, i) => `
            <div style="display:flex;justify-content:space-between;align-items:baseline;padding:5px 0;border-bottom:1px solid ${c.border};font-size:0.68rem;gap:8px">
              <div style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;color:${c.text};opacity:0.75" title="${s.sessionId}">
                ${s.sessionId.slice(0, 8)}... ${s.turnCount}t · ${s.model}
              </div>
              <div style="flex-shrink:0;color:${c.muted}">
                <span style="color:${c.accent}">${fmtTokens(s.inputTokens)}</span> in
                · ${fmtTokens(s.outputTokens)} out
                ${s.cachedInputTokens > 0 ? `· ${fmtTokens(s.cachedInputTokens)} cache` : ''}
              </div>
            </div>
          `).join('')}
        </div>
      </div>
      ` : ''}

      <!-- ── Per-project breakdown (All-time mode) ── -->
      ${isAll && allUsageVal && allUsageVal.projects.length > 0 ? `
      <div class="tcc-section" style="background:${c.surface};border:1px solid ${c.border};border-radius:3px;padding:18px;margin-bottom:12px">
        <div style="font-size:0.62rem;color:${c.muted};letter-spacing:0.12em;text-transform:uppercase;margin-bottom:12px">Per-Project Breakdown</div>
        <div style="max-height:300px;overflow-y:auto">
          ${allUsageVal!.projects.map((p, i) => {
            const pTotal = p.inputTokens + p.outputTokens + p.cachedInputTokens;
            const maxTotal = allUsageVal!.projects[0] ? allUsageVal!.projects[0].inputTokens + allUsageVal!.projects[0].outputTokens + allUsageVal!.projects[0].cachedInputTokens : 1;
            const barW = Math.round((pTotal / Math.max(1, maxTotal)) * 100);
            return `
            <div style="margin-bottom:8px">
              <div style="display:flex;justify-content:space-between;align-items:baseline;font-size:0.68rem;margin-bottom:3px">
                <div style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;color:${c.text};opacity:0.8" title="${p.projectPath}">
                  <span style="display:inline-block;width:6px;height:6px;border-radius:50%;background:${BAR_PALETTE[i % BAR_PALETTE.length]};margin-right:6px;vertical-align:middle"></span>${p.projectPath.split(/[\\/]/).pop() || p.projectPath}
                </div>
                <div style="flex-shrink:0;color:${c.muted};margin-left:8px">
                  ${fmtTokens(pTotal)} tok · ${p.sessionCount} sessions · ${p.turnCount}t
                </div>
              </div>
              <div style="height:3px;background:${c.border};border-radius:1px;overflow:hidden">
                <div style="height:100%;width:${barW}%;background:${BAR_PALETTE[i % BAR_PALETTE.length]};border-radius:1px"></div>
              </div>
            </div>`;
          }).join('')}
        </div>
      </div>
      ` : ''}

      <!-- ── Per-day breakdown (Daily mode) ── -->
      ${isDaily && dailyUsage && dailyUsage.days.length > 0 ? `
      <div class="tcc-section" style="background:${c.surface};border:1px solid ${c.border};border-radius:3px;padding:18px;margin-bottom:12px">
        <div style="font-size:0.62rem;color:${c.muted};letter-spacing:0.12em;text-transform:uppercase;margin-bottom:12px">Per-Day Breakdown</div>
        <div style="max-height:300px;overflow-y:auto">
          ${dailyUsage!.days.map((d, i) => {
            const dTotal = d.inputTokens + d.outputTokens + d.cachedInputTokens;
            const maxTotal = dailyUsage!.days.reduce((max, x) => Math.max(max, x.inputTokens + x.outputTokens + x.cachedInputTokens), 1);
            const barW = Math.round((dTotal / Math.max(1, maxTotal)) * 100);
            const isSelected = d.date === selectedDate;
            return `
            <div data-tcc-day="${d.date}" style="margin-bottom:8px;cursor:pointer;padding:4px 6px;border-radius:3px;
              background:${isSelected ? c.accentDim : 'transparent'};
              border:1px solid ${isSelected ? c.accent : 'transparent'};
              transition:background 0.15s;
            ">
              <div style="display:flex;justify-content:space-between;align-items:baseline;font-size:0.68rem;margin-bottom:3px">
                <div style="color:${isSelected ? c.accent : c.text};opacity:${isSelected ? 1 : 0.8};font-weight:${isSelected ? 600 : 400}">
                  <span style="display:inline-block;width:6px;height:6px;border-radius:50%;background:${BAR_PALETTE[i % BAR_PALETTE.length]};margin-right:6px;vertical-align:middle"></span>${d.date}${isSelected ? ' ◀' : ''}
                </div>
                <div style="flex-shrink:0;color:${c.muted};margin-left:8px">
                  ${fmtTokens(dTotal)} tok · ${d.sessionCount} sessions · ${d.turnCount}t
                </div>
              </div>
              <div style="height:3px;background:${c.border};border-radius:1px;overflow-hidden">
                <div style="height:100%;width:${barW}%;background:${BAR_PALETTE[i % BAR_PALETTE.length]};border-radius:1px"></div>
              </div>
            </div>`;
          }).join('')}
        </div>
      </div>
      ` : ''}

      <!-- ── Cost Breakdown ── -->
      <div class="tcc-section" style="background:${c.surface};border:1px solid ${c.border};border-radius:3px;padding:18px">
        <div style="font-size:0.62rem;color:${c.muted};letter-spacing:0.12em;text-transform:uppercase;margin-bottom:16px">Cost Breakdown${isDaily ? ` — ${selectedDate}` : ''}</div>

        <div style="display:flex;flex-direction:column;gap:10px">
          ${costRow('Input', costs.inputCost, tokens.inputTokens, c)}
          ${costRow('Output', costs.outputCost, tokens.outputTokens, c)}
          ${costRow('Cached input', costs.cachedInputCost, tokens.cachedInputTokens, c)}
        </div>

        <div style="margin-top:14px;padding-top:14px;border-top:2px solid ${c.border}">
          <div style="display:flex;justify-content:space-between;align-items:baseline">
            <div style="font-size:0.75rem;font-weight:700;color:${c.text}">Total Cost</div>
            <div id="tcc-total" style="font-size:1.5rem;font-weight:700;color:${c.green};letter-spacing:-0.03em">${fmtUSD(costs.total)}</div>
          </div>
          <div style="font-size:0.62rem;color:${c.muted};margin-top:4px;text-align:right">
            ${fmtTokens(tokens.inputTokens + tokens.outputTokens + tokens.cachedInputTokens)} total tokens
          </div>
        </div>
      </div>
    `;

    // ── Event bindings ──

    bindModeButtons(ctx);
    bindPreset(ctx);
    bindPriceInputs(ctx);
    if (isManual) bindTokenInputs(ctx);
    if (isManual) bindQuickButtons();
    if (isAuto && hasSession) bindRefreshButton(ctx);
    if (isProject) bindFetchProject();
    if (isAll) {
      bindRefreshButton(ctx);
    }
    if (isDaily && dailyUsage) {
      bindRefreshButton(ctx);
      bindDayNavigator();
    }
    if (isAuto && !hasSession) bindConnectSession(ctx);
  }

  // ── Mode toggle ────────────────────────────────────────────────

  function switchMode(mode: Mode, ctx: PluginContext): void {
    if (state.mode === mode) return;
    state.mode = mode;
    stopAutoRefresh();
    saveState(state);
    sessionUsage = null;
    projectUsage = null;
    allUsageVal = null;
    dailyUsage = null;
    selectedDate = new Date().toISOString().slice(0, 10);
    fetchError = '';

    if (mode === 'auto') {
      if (ctx.session?.id && ctx.project?.path) {
        manualSessionId = '';
        manualProjectPath = '';
        fetchSessionUsage(ctx);
        startAutoRefresh(ctx);
      }
    } else if (mode === 'project') {
      if (!manualProjectPath && ctx.project?.path) manualProjectPath = ctx.project.path;
      if (manualProjectPath) fetchProjectUsage();
    } else if (mode === 'all') {
      fetchAllUsage();
    } else if (mode === 'daily') {
      fetchDailyUsage();
    }
    render(ctx);
  }

  function bindModeButtons(ctx: PluginContext): void {
    root.querySelector('#tcc-mode-manual')?.addEventListener('click', () => switchMode('manual', ctx));
    root.querySelector('#tcc-mode-auto')?.addEventListener('click', () => switchMode('auto', ctx));
    root.querySelector('#tcc-mode-project')?.addEventListener('click', () => switchMode('project', ctx));
    root.querySelector('#tcc-mode-all')?.addEventListener('click', () => switchMode('all', ctx));
    root.querySelector('#tcc-mode-daily')?.addEventListener('click', () => switchMode('daily', ctx));
  }

  function bindConnectSession(ctx: PluginContext): void {
    root.querySelector('#tcc-connect-session')?.addEventListener('click', () => {
      const projEl = root.querySelector('#tcc-manual-project') as HTMLInputElement | null;
      const sessEl = root.querySelector('#tcc-manual-session') as HTMLInputElement | null;
      if (projEl) manualProjectPath = projEl.value.trim();
      if (sessEl) manualSessionId = sessEl.value.trim();

      if (!manualProjectPath || !manualSessionId) {
        fetchError = 'Please enter both Project Path and Session ID';
        render(ctx);
        return;
      }
      fetchError = '';
      sessionUsage = null;
      const syntheticCtx: PluginContext = {
        ...ctx,
        project: { name: manualProjectPath.split(/[\\/]/).pop() || manualProjectPath, path: manualProjectPath },
        session: { id: manualSessionId, title: 'Manual Session' },
      };
      fetchSessionUsage(syntheticCtx);
      startAutoRefresh(ctx);
    });
  }

  function bindFetchProject(): void {
    root.querySelector('#tcc-fetch-project')?.addEventListener('click', () => {
      const projEl = root.querySelector('#tcc-manual-project') as HTMLInputElement | null;
      if (projEl) manualProjectPath = projEl.value.trim();
      if (!manualProjectPath) {
        fetchError = 'Please enter a Project Path';
        render(api.context);
        return;
      }
      fetchProjectUsage();
    });
  }

  // ── Preset ─────────────────────────────────────────────────────

  function bindPreset(ctx: PluginContext): void {
    root.querySelector('#tcc-preset')?.addEventListener('change', (e) => {
      const name = (e.target as HTMLSelectElement).value;
      const preset = presets.find((p) => p.name === name);
      if (preset) {
        state.inputPrice = preset.inputPrice;
        state.outputPrice = preset.outputPrice;
        state.cachedInputPrice = preset.cachedInputPrice;
        saveState(state);
        render(ctx);
      }
    });
  }

  // ── Price inputs (commit on blur/enter only, no re-render per keystroke)

  function bindPriceInputs(ctx: PluginContext): void {
    bindPriceNum('#tcc-input-price', (v) => { state.inputPrice = v; });
    bindPriceNum('#tcc-output-price', (v) => { state.outputPrice = v; });
    bindPriceNum('#tcc-cached-price', (v) => { state.cachedInputPrice = v; });
  }

  function bindPriceNum(sel: string, setter: (v: number) => void): void {
    const el = root.querySelector(sel) as HTMLInputElement | null;
    if (!el) return;
    // Update state silently on each keystroke (no render, avoids losing focus)
    el.addEventListener('input', () => {
      const v = parseFloat(el.value);
      if (!isNaN(v) && v >= 0) setter(clamp(v, 0, 999));
    });
    // Commit on blur or Enter — save + recalculate once
    el.addEventListener('change', () => {
      saveState(state);
      render(api.context);
    });
  }

  // ── Manual token inputs (commit on blur/enter only)

  function bindTokenInputs(ctx: PluginContext): void {
    bindTokenNum('#tcc-input-tokens', (v) => { state.inputTokens = v; });
    bindTokenNum('#tcc-output-tokens', (v) => { state.outputTokens = v; });
    bindTokenNum('#tcc-cached-tokens', (v) => { state.cachedInputTokens = v; });
  }

  function bindTokenNum(sel: string, setter: (v: number) => void): void {
    const el = root.querySelector(sel) as HTMLInputElement | null;
    if (!el) return;
    // Update state silently on keystroke
    el.addEventListener('input', () => {
      const raw = el.value.replace(/[^0-9]/g, '');
      const v = parseInt(raw, 10);
      if (!isNaN(v) && v >= 0) setter(v);
    });
    // Commit + reformat on blur/Enter
    el.addEventListener('change', () => {
      saveState(state);
      render(api.context);
    });
    el.addEventListener('blur', () => {
      const v = parseInt(el.value.replace(/[^0-9]/g, ''), 10);
      if (!isNaN(v)) el.value = fmtTokens(v);
    });
  }

  // ── Quick-add buttons ──────────────────────────────────────────

  let activeField: 'input' | 'output' | 'cached' = 'input';

  function bindQuickButtons(): void {
    root.querySelectorAll('input[data-tcc-field]').forEach((inp) => {
      inp.addEventListener('focus', () => {
        activeField = (inp as HTMLInputElement).dataset.tccField as 'input' | 'output' | 'cached';
      });
    });

    root.querySelectorAll('.tcc-quick-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const n = parseInt((btn as HTMLElement).dataset.tokens || '0', 10);
        if (activeField === 'input') state.inputTokens += n;
        else if (activeField === 'output') state.outputTokens += n;
        else state.cachedInputTokens += n;
        saveState(state);
        render(api.context);
      });
    });
  }

  // ── Data fetch helpers ─────────────────────────────────────────

  function getActiveCtx(ctx: PluginContext): PluginContext {
    if (ctx.session?.id && ctx.project?.path) return ctx;
    if (manualProjectPath && manualSessionId) {
      return {
        ...ctx,
        project: { name: manualProjectPath.split(/[\\/]/).pop() || manualProjectPath, path: manualProjectPath },
        session: { id: manualSessionId, title: 'Manual Session' },
      };
    }
    return ctx;
  }

  function bindRefreshButton(ctx: PluginContext): void {
    root.querySelector('#tcc-refresh')?.addEventListener('click', () => {
      if (state.mode === 'auto') fetchSessionUsage(getActiveCtx(ctx));
      else if (state.mode === 'project') fetchProjectUsage();
      else if (state.mode === 'all') fetchAllUsage();
      else if (state.mode === 'daily') fetchDailyUsage();
    });
  }

  function bindDayNavigator(): void {
    root.querySelector('#tcc-day-prev')?.addEventListener('click', () => {
      if (!dailyUsage) return;
      const idx = dailyUsage.days.findIndex(d => d.date === selectedDate);
      if (idx > 0) { selectedDate = dailyUsage.days[idx - 1].date; render(api.context); }
    });
    root.querySelector('#tcc-day-next')?.addEventListener('click', () => {
      if (!dailyUsage) return;
      const idx = dailyUsage.days.findIndex(d => d.date === selectedDate);
      if (idx < dailyUsage.days.length - 1) { selectedDate = dailyUsage.days[idx + 1].date; render(api.context); }
    });
    root.querySelector('#tcc-day-today')?.addEventListener('click', () => {
      if (!dailyUsage) return;
      const today = new Date().toISOString().slice(0, 10);
      if (dailyUsage.days.some(d => d.date === today)) { selectedDate = today; render(api.context); }
    });
    // Click on a day row in the per-day breakdown
    root.querySelectorAll('[data-tcc-day]').forEach(el => {
      el.addEventListener('click', () => {
        const date = (el as HTMLElement).dataset.tccDay;
        if (date) { selectedDate = date; render(api.context); }
      });
    });
  }

  async function fetchSessionUsage(ctx: PluginContext): Promise<void> {
    if (!ctx.project?.path || !ctx.session?.id) return;
    try {
      const data = await api.rpc('GET', `session-usage?projectPath=${encodeURIComponent(ctx.project.path)}&sessionId=${encodeURIComponent(ctx.session.id)}`);
      sessionUsage = data as SessionUsage;
      fetchError = sessionUsage.error || '';
      lastFetch = Date.now();
    } catch (err) {
      fetchError = (err as Error).message || 'fetch failed';
    }
    render(ctx);
  }

  async function fetchProjectUsage(): Promise<void> {
    if (!manualProjectPath) return;
    try {
      const data = await api.rpc('GET', `project-usage?projectPath=${encodeURIComponent(manualProjectPath)}`);
      projectUsage = data as ProjectUsage;
      fetchError = projectUsage.error || '';
      lastFetch = Date.now();
    } catch (err) {
      fetchError = (err as Error).message || 'fetch failed';
    }
    render(api.context);
  }

  async function fetchAllUsage(): Promise<void> {
    try {
      const data = await api.rpc('GET', 'all-usage');
      allUsageVal = data as AllUsage;
      fetchError = allUsageVal.error || '';
      lastFetch = Date.now();
    } catch (err) {
      fetchError = (err as Error).message || 'fetch failed';
    }
    render(api.context);
  }

  async function fetchDailyUsage(): Promise<void> {
    try {
      const data = await api.rpc('GET', 'daily-usage');
      dailyUsage = data as DailyUsage;
      fetchError = dailyUsage.error || '';
      lastFetch = Date.now();
    } catch (err) {
      fetchError = (err as Error).message || 'fetch failed';
    }
    render(api.context);
  }

  function startAutoRefresh(ctx: PluginContext): void {
    stopAutoRefresh();
    refreshTimer = setInterval(() => {
      if (state.mode === 'auto') fetchSessionUsage(getActiveCtx(ctx));
    }, AUTO_REFRESH_MS);
  }

  function stopAutoRefresh(): void {
    if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
  }

  // ── Input binding helpers ──────────────────────────────────────

  function bindNum(sel: string, cb: (v: number) => void): void {
    const el = root.querySelector(sel) as HTMLInputElement | null;
    if (!el) return;
    el.addEventListener('input', () => {
      const v = parseFloat(el.value);
      if (!isNaN(v) && v >= 0) cb(clamp(v, 0, 999));
    });
  }

  function bindInt(sel: string, cb: (v: number) => void): void {
    const el = root.querySelector(sel) as HTMLInputElement | null;
    if (!el) return;
    el.addEventListener('input', () => {
      const raw = el.value.replace(/[^0-9]/g, '');
      const v = parseInt(raw, 10);
      if (!isNaN(v) && v >= 0) cb(v);
    });
    el.addEventListener('blur', () => {
      const v = parseInt(el.value.replace(/[^0-9]/g, ''), 10);
      if (!isNaN(v)) el.value = fmtTokens(v);
    });
  }

  // ── Init ───────────────────────────────────────────────────────

  render(api.context);

  // Load presets from server
  api.rpc('GET', 'presets').then((data) => {
    presets = data as ModelPreset[];
    render(api.context);
  }).catch(() => { /* server unavailable */ });

  // Init auto-fetch for current mode
  if (state.mode === 'auto') {
    const activeCtx = getActiveCtx(api.context);
    if (activeCtx.session?.id && activeCtx.project?.path) {
      fetchSessionUsage(activeCtx);
      startAutoRefresh(api.context);
    }
  } else if (state.mode === 'project') {
    if (!manualProjectPath && api.context.project?.path) manualProjectPath = api.context.project.path;
    if (manualProjectPath) fetchProjectUsage();
  } else if (state.mode === 'all') {
    fetchAllUsage();
  } else if (state.mode === 'daily') {
    fetchDailyUsage();
  }

  // Theme / context change
  const unsub = api.onContextChange((ctx) => {
    // Auto-fill project path from sidebar selection for Project/Auto modes
    if (ctx.project?.path) {
      manualProjectPath = ctx.project.path;
      manualSessionId = ctx.session?.id || '';
    }

    if (state.mode === 'auto' && ctx.session?.id && ctx.project?.path) {
      sessionUsage = null;
      fetchError = '';
      fetchSessionUsage(ctx);
      startAutoRefresh(ctx);
    }
    render(ctx);
  });

  (container as any)._tccUnsubscribe = unsub;
  (container as any)._tccStopRefresh = stopAutoRefresh;
}

export function unmount(container: HTMLElement): void {
  if (typeof (container as any)._tccUnsubscribe === 'function') {
    (container as any)._tccUnsubscribe();
    delete (container as any)._tccUnsubscribe;
  }
  if (typeof (container as any)._tccStopRefresh === 'function') {
    (container as any)._tccStopRefresh();
    delete (container as any)._tccStopRefresh;
  }
  container.innerHTML = '';
}

// ── HTML template helpers ──────────────────────────────────────────────

function priceField(id: string, label: string, value: number, c: ThemeColors): string {
  return `
    <div>
      <label for="${id}" style="display:block;font-size:0.65rem;color:${c.muted};margin-bottom:4px">${label}</label>
      <div style="position:relative">
        <span style="position:absolute;left:10px;top:50%;transform:translateY(-50%);color:${c.muted};font-size:0.72rem">$</span>
        <input id="${id}" type="number" value="${value}" step="0.001" min="0" max="999"
          style="width:100%;padding:8px 10px 8px 22px;background:${c.inputBg};border:1px solid ${c.border};
          color:${c.text};font-family:${MONO};font-size:0.78rem;border-radius:3px;
          outline:none;box-sizing:border-box;transition:border-color 0.15s"
          onfocus="this.style.borderColor='${c.accent}'" onblur="this.style.borderColor='${c.border}'">
        <span style="position:absolute;right:10px;top:50%;transform:translateY(-50%);color:${c.muted};font-size:0.6rem">/1M</span>
      </div>
    </div>`;
}

function tokenField(id: string, label: string, value: number, readOnly: boolean, c: ThemeColors): string {
  const ro = readOnly ? 'readonly' : '';
  const opacity = readOnly ? 'opacity:0.85;cursor:default;' : '';
  return `
    <div>
      <label for="${id}" style="display:block;font-size:0.65rem;color:${c.muted};margin-bottom:4px">${label}</label>
      <input id="${id}" type="text" data-tcc-field="${id.includes('output') ? 'output' : id.includes('cached') ? 'cached' : 'input'}"
        value="${fmtTokens(value)}" ${ro}
        style="width:100%;padding:8px 10px;background:${c.inputBg};border:1px solid ${c.border};
        color:${c.text};font-family:${MONO};font-size:0.78rem;border-radius:3px;
        outline:none;box-sizing:border-box;transition:border-color 0.15s;${opacity}"
        onfocus="this.style.borderColor='${c.accent}'" onblur="this.style.borderColor='${c.border}'">
    </div>`;
}

function costRow(label: string, cost: number, tokens: number, c: ThemeColors): string {
  return `
    <div style="display:flex;justify-content:space-between;align-items:center;padding:6px 0;border-bottom:1px solid ${c.border}">
      <div>
        <div style="font-size:0.7rem;color:${c.text};opacity:0.8">${label}</div>
        <div style="font-size:0.6rem;color:${c.muted};margin-top:2px">${fmtTokens(tokens)} tokens</div>
      </div>
      <div style="font-size:0.85rem;font-weight:600;color:${c.text}">${fmtUSD(cost)}</div>
    </div>`;
}

// ── Font & style injection ─────────────────────────────────────────────

function ensureAssets(): void {
  if (document.getElementById('tcc-styles')) return;

  const s = document.createElement('style');
  s.id = 'tcc-styles';
  s.textContent = `
    @keyframes tcc-fadein { from { opacity: 0; transform: translateY(4px) } to { opacity: 1; transform: translateY(0) } }
    .tcc-section { animation: tcc-fadein 0.25s ease both; }
    .tcc-section:nth-child(2) { animation-delay: 0.03s; }
    .tcc-section:nth-child(3) { animation-delay: 0.06s; }
    .tcc-section:nth-child(4) { animation-delay: 0.09s; }
    .tcc-section:nth-child(5) { animation-delay: 0.12s; }
    .tcc-section:nth-child(6) { animation-delay: 0.15s; }
    .tcc-section:nth-child(7) { animation-delay: 0.18s; }
    .tcc-section:nth-child(8) { animation-delay: 0.21s; }
  `;
  document.head.appendChild(s);
}
