/** Codex Usage CloudCLI tab: live plan limits and account token activity. */

import type { PluginAPI, PluginContext } from './types.js';
import type { ActivityData, RateLimitsData, RateWindow } from './usage.js';

type ThemeColors = {
  bg: string;
  surface: string;
  border: string;
  text: string;
  muted: string;
  accent: string;
  ok: string;
  warn: string;
  bad: string;
};

type State = {
  limits: RateLimitsData | null;
  limitsError: string | null;
  activity: ActivityData | null;
  activityError: string | null;
  loading: boolean;
};

const MONO = "'JetBrains Mono', 'Fira Code', ui-monospace, monospace";

function colors(dark: boolean): ThemeColors {
  return dark
    ? { bg: '#080b0a', surface: '#0d1311', border: '#1c2924', text: '#e2eee9', muted: '#71857d', accent: '#10a37f', ok: '#34d399', warn: '#f59e0b', bad: '#fb7185' }
    : { bg: '#f8faf9', surface: '#ffffff', border: '#dfe8e4', text: '#10201a', muted: '#6f827a', accent: '#087f5f', ok: '#059669', warn: '#d97706', bad: '#e11d48' };
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[character] as string));
}

function formatTokens(value: number | null): string {
  if (value === null) return '—';
  if (value < 1_000) return String(value);
  if (value < 1_000_000) return `${(value / 1_000).toFixed(1)}K`;
  if (value < 1_000_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  return `${(value / 1_000_000_000).toFixed(2)}B`;
}

function formatDuration(minutes: number): string {
  if (minutes % 10_080 === 0) return `${minutes / 10_080}w`;
  if (minutes % 1_440 === 0) return `${minutes / 1_440}d`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
}

function resetCountdown(timestamp: string | null): string {
  if (!timestamp) return 'reset unknown';
  const remainingMs = Date.parse(timestamp) - Date.now();
  if (!Number.isFinite(remainingMs)) return 'reset unknown';
  if (remainingMs <= 0) return 'resetting…';
  const totalMinutes = Math.floor(remainingMs / 60_000);
  const days = Math.floor(totalMinutes / 1_440);
  const hours = Math.floor((totalMinutes % 1_440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `resets in ${days}d ${hours}h`;
  if (hours > 0) return `resets in ${hours}h ${minutes}m`;
  return `resets in ${minutes}m`;
}

function severityColor(theme: ThemeColors, percent: number): string {
  if (percent >= 90) return theme.bad;
  if (percent >= 70) return theme.warn;
  return theme.ok;
}

function card(title: string, body: string): string {
  return `<section class="cx-card"><div class="cx-eyebrow">${title}</div>${body}</section>`;
}

function errorNote(message: string): string {
  return `<div class="cx-error">⚠ ${escapeHtml(message)}</div>`;
}

function renderLimits(theme: ThemeColors, data: RateLimitsData | null, error: string | null): string {
  if (error) return card('plan limits', errorNote(error));
  if (!data) return card('plan limits', '<div class="cx-muted">Loading…</div>');
  if (data.limits.length === 0) {
    return card('plan limits', '<div class="cx-muted">No ChatGPT-backed Codex limits were returned.</div>');
  }

  const plan = data.limits.find((limit) => limit.planType)?.planType;
  const badge = plan ? `<span class="cx-badge">${escapeHtml(plan)}</span>` : '';
  const resetCredit = data.resetCreditsAvailable > 0
    ? `<span class="cx-badge cx-badge-accent">${data.resetCreditsAvailable} free reset${data.resetCreditsAvailable === 1 ? '' : 's'} available</span>`
    : '';
  const windows = data.limits.flatMap((limit) => limit.windows.map((window) => ({ limit, window })));
  const body = windows.map(({ limit, window }) => renderWindow(theme, limit.name ?? limit.id, window)).join('');
  return card(`plan limits ${badge} ${resetCredit}`, body);
}

function renderWindow(theme: ThemeColors, limitName: string, window: RateWindow): string {
  const percent = Math.max(0, Math.min(100, window.usedPercent));
  const color = severityColor(theme, percent);
  const label = `${limitName === 'codex' ? 'Codex' : limitName} · ${formatDuration(window.windowDurationMins)}`;
  return `
    <div class="cx-limit">
      <div class="cx-limit-row">
        <span>${escapeHtml(label)}</span>
        <span class="cx-muted">${percent.toFixed(percent % 1 === 0 ? 0 : 1)}% · ${resetCountdown(window.resetsAt)}</span>
      </div>
      <div class="cx-track"><div class="cx-fill" style="width:${percent}%;background:${color}"></div></div>
    </div>`;
}

function renderChart(activity: ActivityData): string {
  const maximum = Math.max(1, ...activity.daily.map((day) => day.tokens));
  const bars = activity.daily.map((day, index) => {
    const height = Math.round((day.tokens / maximum) * 100);
    const opacity = 0.4 + (0.6 * index) / Math.max(activity.daily.length - 1, 1);
    const title = escapeHtml(`${day.date}: ${formatTokens(day.tokens)} tokens`);
    return `<div class="cx-bar-slot" title="${title}"><div class="cx-bar" style="height:${Math.max(height, day.tokens > 0 ? 3 : 0)}%;opacity:${opacity}"></div></div>`;
  }).join('');
  return `
    <div class="cx-chart">${bars}</div>
    <div class="cx-axis"><span>${activity.daily[0]?.date ?? ''}</span><span>${activity.daily.at(-1)?.date ?? ''}</span></div>`;
}

function renderActivity(data: ActivityData | null, error: string | null): string {
  if (error) return card('token activity (30 days)', errorNote(error));
  if (!data) return card('token activity (30 days)', '<div class="cx-muted">Loading…</div>');
  const stats: [string, string][] = [
    ['30-day tokens', formatTokens(data.totalTokens)],
    ['lifetime tokens', formatTokens(data.summary.lifetimeTokens)],
    ['peak day', formatTokens(data.summary.peakDailyTokens)],
    ['current streak', data.summary.currentStreakDays === null ? '—' : `${data.summary.currentStreakDays}d`],
  ];
  return `
    <div class="cx-stats">
      ${stats.map(([label, value]) => `<div class="cx-stat"><div class="cx-stat-value">${value}</div><div class="cx-eyebrow">${label}</div></div>`).join('')}
    </div>
    ${card('daily tokens (30 days)', renderChart(data))}`;
}

function stylesheet(theme: ThemeColors): string {
  return `<style>
    .cx-root{min-height:100%;box-sizing:border-box;padding:24px;background:${theme.bg};color:${theme.text};font-family:${MONO}}
    .cx-header{display:flex;justify-content:space-between;align-items:center;gap:16px;margin-bottom:20px}
    .cx-title{font-size:1.3rem;font-weight:750;letter-spacing:-.03em}.cx-cursor{color:${theme.accent}}
    .cx-refresh{padding:6px 12px;background:transparent;border:1px solid ${theme.border};color:${theme.muted};font:inherit;font-size:.7rem;border-radius:5px;cursor:pointer}.cx-refresh:hover{color:${theme.text};border-color:${theme.muted}}.cx-refresh:disabled{opacity:.55;cursor:wait}
    .cx-card,.cx-stat{background:${theme.surface};border:1px solid ${theme.border};border-radius:6px;padding:18px;margin-bottom:12px}
    .cx-eyebrow{font-size:.62rem;color:${theme.muted};letter-spacing:.11em;text-transform:uppercase;margin-bottom:14px}
    .cx-badge{display:inline-block;border:1px solid ${theme.border};border-radius:4px;padding:2px 7px;margin-left:6px;color:${theme.muted};letter-spacing:normal;text-transform:none}.cx-badge-accent{border-color:${theme.accent};color:${theme.accent}}
    .cx-limit{margin-bottom:15px}.cx-limit:last-child{margin-bottom:0}.cx-limit-row{display:flex;justify-content:space-between;gap:12px;font-size:.72rem;margin-bottom:6px}.cx-muted{font-size:.73rem;color:${theme.muted}}
    .cx-track{height:7px;background:${theme.border};border-radius:4px;overflow:hidden}.cx-fill{height:100%;border-radius:4px;transition:width .35s ease}
    .cx-error{font-size:.74rem;color:${theme.warn};line-height:1.6}.cx-stats{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px}.cx-stat{margin-bottom:12px}.cx-stat-value{font-size:1.3rem;font-weight:750;letter-spacing:-.03em;margin-bottom:5px}.cx-stat .cx-eyebrow{margin:0}
    .cx-chart{height:110px;display:flex;align-items:flex-end;gap:3px}.cx-bar-slot{height:100%;flex:1;display:flex;align-items:flex-end}.cx-bar{width:100%;background:${theme.accent};border-radius:2px 2px 0 0;min-height:0}.cx-axis{display:flex;justify-content:space-between;color:${theme.muted};font-size:.62rem;margin-top:7px}
    .cx-footnote{color:${theme.muted};font-size:.64rem;line-height:1.6;margin-top:14px}
    @media(max-width:720px){.cx-root{padding:16px}.cx-stats{grid-template-columns:repeat(2,minmax(0,1fr))}.cx-limit-row{align-items:flex-start;flex-direction:column;gap:3px}.cx-chart{gap:2px}}
  </style>`;
}

export function mount(container: HTMLElement, api: PluginAPI): void {
  const root = document.createElement('div');
  root.className = 'cx-root';
  container.appendChild(root);
  const state: State = {
    limits: null,
    limitsError: null,
    activity: null,
    activityError: null,
    loading: false,
  };
  let disposed = false;

  function render(context: PluginContext): void {
    if (disposed) return;
    const theme = colors(context.theme === 'dark');
    root.innerHTML = `${stylesheet(theme)}
      <div class="cx-header">
        <div class="cx-title">Codex Usage<span class="cx-cursor">▌</span></div>
        <button class="cx-refresh" type="button" ${state.loading ? 'disabled' : ''}>${state.loading ? 'refreshing…' : '↻ refresh'}</button>
      </div>
      ${renderLimits(theme, state.limits, state.limitsError)}
      ${renderActivity(state.activity, state.activityError)}
      <div class="cx-footnote">Usage is read through the official Codex app-server. This plugin never reads or stores your authentication tokens.</div>`;
    root.querySelector<HTMLButtonElement>('.cx-refresh')?.addEventListener('click', () => void load(true));
  }

  async function loadLimits(): Promise<void> {
    try {
      state.limits = await api.rpc('GET', 'rate-limits') as RateLimitsData;
      state.limitsError = null;
    } catch (error) {
      state.limits = null;
      state.limitsError = error instanceof Error ? error.message : 'Plan limits are unavailable.';
    } finally {
      render(api.context);
    }
  }

  async function loadActivity(): Promise<void> {
    try {
      state.activity = await api.rpc('GET', 'activity?days=30') as ActivityData;
      state.activityError = null;
    } catch (error) {
      state.activity = null;
      state.activityError = error instanceof Error ? error.message : 'Token activity is unavailable.';
    } finally {
      render(api.context);
    }
  }

  async function load(includeActivity: boolean): Promise<void> {
    if (state.loading || disposed) return;
    state.loading = true;
    render(api.context);
    await Promise.all([loadLimits(), includeActivity || !state.activity ? loadActivity() : Promise.resolve()]);
    state.loading = false;
    render(api.context);
  }

  render(api.context);
  void load(true);
  const timer = window.setInterval(() => void load(false), 60_000);
  const unsubscribe = api.onContextChange(render);
  (container as HTMLElement & { _codexUsageCleanup?: () => void })._codexUsageCleanup = () => {
    disposed = true;
    window.clearInterval(timer);
    unsubscribe();
  };
}

export function unmount(container: HTMLElement): void {
  const target = container as HTMLElement & { _codexUsageCleanup?: () => void };
  target._codexUsageCleanup?.();
  delete target._codexUsageCleanup;
  container.innerHTML = '';
}
