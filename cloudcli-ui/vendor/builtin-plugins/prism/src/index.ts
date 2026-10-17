/**
 * PRISM plugin module entry point.
 *
 * Renders post-session health diagnostics for the selected project (or an
 * all-projects overview when none is selected). Data comes from the plugin
 * backend, which shells out to the locally installed `prism` CLI.
 */

import type { PluginAPI, PluginContext } from './types.js';

// ── Types (mirror the backend response) ────────────────────────────────

interface Dimension {
  grade: string;
  score: number;
}

interface Issue {
  severity: string;
  category: string;
  description: string;
}

interface Report {
  project: string;
  display_name: string;
  session_count: number;
  overall_grade: string;
  overall_score: number;
  dimensions: Record<string, Dimension>;
  top_issues: Issue[];
}

interface Health {
  installed: boolean;
  version: string | null;
}

interface ReportCache {
  projectPath: string | null;
  reports: Report[];
}

// ── Constants ──────────────────────────────────────────────────────────

const MONO = "'JetBrains Mono', 'Fira Code', ui-monospace, monospace";

const DIMENSIONS: [string, string][] = [
  ['token_efficiency', 'token efficiency'],
  ['tool_health', 'tool health'],
  ['context_hygiene', 'context hygiene'],
  ['claude_md_adherence', 'claude.md adherence'],
  ['session_continuity', 'session continuity'],
];

// ── Theme helpers ──────────────────────────────────────────────────────

interface ThemeColors {
  bg: string;
  surface: string;
  border: string;
  text: string;
  muted: string;
  accent: string;
  dim: string;
}

function themeColors(dark: boolean): ThemeColors {
  return dark
    ? {
        bg: '#08080f',
        surface: '#0e0e1a',
        border: '#1a1a2c',
        text: '#e2e0f0',
        muted: '#52507a',
        accent: '#fbbf24',
        dim: 'rgba(251,191,36,0.1)',
      }
    : {
        bg: '#fafaf9',
        surface: '#ffffff',
        border: '#e8e6f0',
        text: '#0f0e1a',
        muted: '#9490b0',
        accent: '#d97706',
        dim: 'rgba(217,119,6,0.08)',
      };
}

function gradeColor(grade: string, c: ThemeColors): string {
  switch (grade.charAt(0)) {
    case 'A': return '#10b981';
    case 'B': return '#22d3ee';
    case 'C': return '#f59e0b';
    case 'D': return '#fb923c';
    case 'F': return '#f43f5e';
    default: return c.muted; // N/A
  }
}

function severityColor(severity: string, c: ThemeColors): string {
  switch (severity.toLowerCase()) {
    case 'high': return '#f43f5e';
    case 'medium': return '#f59e0b';
    default: return c.muted;
  }
}

// ── Utility helpers ────────────────────────────────────────────────────

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function ensureAssets(): void {
  if (document.getElementById('prism-styles')) return;

  const s = document.createElement('style');
  s.id = 'prism-styles';
  s.textContent = `
    @keyframes prism-grow   { from { width: 0 } }
    @keyframes prism-fadeup { from { opacity:0; transform:translateY(6px) } to { opacity:1; transform:translateY(0) } }
    @keyframes prism-pulse  { 0%,100% { opacity:.3 } 50% { opacity:.6 } }
    .prism-bar  { animation: prism-grow   0.75s cubic-bezier(.16,1,.3,1) both }
    .prism-up   { animation: prism-fadeup 0.4s  ease both }
    .prism-skel { animation: prism-pulse  1.6s  ease infinite }
  `;
  document.head.appendChild(s);
}

function skeletonRows(c: ThemeColors, widths: number[]): string {
  return widths
    .map(
      (w, i) => `
    <div class="prism-skel" style="
      height:10px;width:${w}%;background:${c.muted};border-radius:2px;
      margin-bottom:8px;animation-delay:${i * 0.1}s
    "></div>`,
    )
    .join('');
}

function gradeChip(grade: string, c: ThemeColors): string {
  const color = gradeColor(grade, c);
  return `
    <span style="
      display:inline-block;min-width:30px;text-align:center;
      padding:2px 7px;border:1px solid ${color};border-radius:3px;
      color:${color};font-size:0.7rem;font-weight:700;letter-spacing:0.04em;
    ">${esc(grade)}</span>`;
}

function scoreBar(score: number, grade: string, c: ThemeColors, delay: number): string {
  const width = Math.max(0, Math.min(100, Math.round(score)));
  return `
    <div style="flex:1;height:4px;background:${c.border};border-radius:1px;overflow:hidden">
      <div class="prism-bar" style="
        height:100%;width:${width}%;background:${gradeColor(grade, c)};
        animation-delay:${delay}s;border-radius:1px;
      "></div>
    </div>`;
}

// ── Mount / Unmount ────────────────────────────────────────────────────

export function mount(container: HTMLElement, api: PluginAPI): void {
  ensureAssets();
  let cache: ReportCache | null = null;
  let health: Health | null = null;

  const root = document.createElement('div');
  Object.assign(root.style, {
    height: '100%',
    overflowY: 'auto',
    boxSizing: 'border-box',
    padding: '24px',
    fontFamily: MONO,
  });
  container.appendChild(root);

  function renderNotInstalled(ctx: PluginContext): void {
    const c = themeColors(ctx.theme === 'dark');
    root.style.background = c.bg;
    root.style.color = c.text;
    root.innerHTML = `
      <div class="prism-up" style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:60%;gap:16px">
        <pre style="font-size:0.75rem;color:${c.muted};opacity:0.6;line-height:1.6;text-align:center">$ prism
command not found</pre>
        <div style="font-size:0.72rem;color:${c.muted};letter-spacing:0.1em;text-transform:uppercase">prism is not installed</div>
        <div style="
          background:${c.surface};border:1px solid ${c.border};border-radius:3px;
          padding:12px 18px;font-size:0.78rem;color:${c.text};
        ">pip install prism-cc</div>
        <a href="https://github.com/jakeefr/prism" target="_blank" rel="noreferrer" style="
          font-size:0.7rem;color:${c.accent};text-decoration:none;
        ">github.com/jakeefr/prism →</a>
      </div>`;
  }

  function renderError(ctx: PluginContext, message: string): void {
    const c = themeColors(ctx.theme === 'dark');
    root.style.background = c.bg;
    root.innerHTML = `
      <div style="padding:24px;font-size:0.78rem;color:${c.accent};opacity:0.8;font-family:${MONO}">
        ✗ ${esc(message)}
      </div>`;
  }

  function renderLoading(ctx: PluginContext): void {
    const c = themeColors(ctx.theme === 'dark');
    root.style.background = c.bg;
    root.style.color = c.text;
    const title = ctx.project ? esc(ctx.project.name) : 'all projects';
    const subtitle = ctx.project ? esc(ctx.project.path) : 'session health overview';
    root.innerHTML = `
      <div style="margin-bottom:24px">
        <div style="font-size:1.3rem;font-weight:700">${title}<span style="color:${c.accent}">▌</span></div>
        <div style="font-size:0.7rem;color:${c.muted};margin-top:4px">${subtitle}</div>
      </div>
      <div style="background:${c.surface};border:1px solid ${c.border};border-radius:3px;padding:18px;margin-bottom:12px">
        ${skeletonRows(c, [30, 70, 55, 62, 48, 40])}
      </div>
      <div style="background:${c.surface};border:1px solid ${c.border};border-radius:3px;padding:18px">
        ${skeletonRows(c, [80, 65, 50])}
      </div>`;
  }

  function header(ctx: PluginContext, c: ThemeColors, title: string, subtitle: string): string {
    return `
      <div class="prism-up" style="display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:24px">
        <div style="min-width:0;flex:1">
          <div style="font-size:1.3rem;font-weight:700;letter-spacing:-0.02em;word-break:break-all">
            ${title}<span style="color:${c.accent}">▌</span>
          </div>
          <div style="font-size:0.7rem;color:${c.muted};margin-top:4px;word-break:break-all">${subtitle}</div>
        </div>
        <button id="prism-refresh" style="
          flex-shrink:0;margin-left:16px;padding:5px 12px;
          background:transparent;border:1px solid ${c.border};
          color:${c.muted};font-family:${MONO};font-size:0.7rem;
          border-radius:3px;cursor:pointer;letter-spacing:0.05em;
          transition:all 0.15s;
        " onmouseover="this.style.borderColor='${c.accent}';this.style.color='${c.accent}'"
           onmouseout="this.style.borderColor='${c.border}';this.style.color='${c.muted}'">
          ↻ refresh
        </button>
      </div>`;
  }

  function renderReport(ctx: PluginContext, report: Report): void {
    const c = themeColors(ctx.theme === 'dark');
    root.style.background = c.bg;
    root.style.color = c.text;
    const overallColor = gradeColor(report.overall_grade, c);

    root.innerHTML = `
      ${header(ctx, c, esc(ctx.project?.name ?? report.display_name), esc(ctx.project?.path ?? report.display_name))}

      <div class="prism-up" style="
        display:flex;align-items:center;gap:20px;
        background:${c.surface};border:1px solid ${c.border};
        border-radius:3px;padding:20px;margin-bottom:12px;
      ">
        <div style="
          font-size:2.6rem;font-weight:700;letter-spacing:-0.04em;line-height:1;
          color:${overallColor};min-width:74px;text-align:center;
        ">${esc(report.overall_grade)}</div>
        <div style="flex:1">
          <div style="display:flex;justify-content:space-between;font-size:0.68rem;color:${c.muted};margin-bottom:8px">
            <span style="letter-spacing:0.1em;text-transform:uppercase">overall health</span>
            <span>${Number(report.overall_score).toFixed(1)} / 100 · ${Number(report.session_count)} session${report.session_count === 1 ? '' : 's'}${health?.version ? ` · prism v${esc(health.version)}` : ''}</span>
          </div>
          ${scoreBar(report.overall_score, report.overall_grade, c, 0.1)}
        </div>
      </div>

      <div class="prism-up" style="
        background:${c.surface};border:1px solid ${c.border};
        border-radius:3px;padding:18px;margin-bottom:12px;animation-delay:0.08s
      ">
        <div style="font-size:0.62rem;color:${c.muted};letter-spacing:0.12em;text-transform:uppercase;margin-bottom:14px">dimensions</div>
        ${DIMENSIONS.map(([key, label], i) => {
          const dim = report.dimensions[key];
          if (!dim) return '';
          return `
          <div class="prism-up" style="display:flex;align-items:center;gap:12px;margin-bottom:9px;animation-delay:${0.12 + i * 0.04}s">
            <div style="width:160px;font-size:0.68rem;color:${c.muted};flex-shrink:0">${label}</div>
            ${scoreBar(dim.score, dim.grade, c, 0.15 + i * 0.04)}
            <div style="width:42px;font-size:0.68rem;color:${c.muted};text-align:right;flex-shrink:0">${Number(dim.score).toFixed(0)}</div>
            ${gradeChip(dim.grade, c)}
          </div>`;
        }).join('')}
      </div>

      <div class="prism-up" style="
        background:${c.surface};border:1px solid ${c.border};
        border-radius:3px;padding:18px;animation-delay:0.16s
      ">
        <div style="font-size:0.62rem;color:${c.muted};letter-spacing:0.12em;text-transform:uppercase;margin-bottom:12px">top issues</div>
        ${
          report.top_issues.length === 0
            ? `<div style="font-size:0.72rem;color:${c.muted}">none found</div>`
            : report.top_issues
                .map(
                  (issue, i) => `
            <div class="prism-up" style="
              display:flex;gap:10px;align-items:baseline;
              padding:6px 0;border-bottom:1px solid ${c.border};font-size:0.7rem;
              animation-delay:${0.2 + i * 0.04}s;
            ">
              <span style="
                flex-shrink:0;font-size:0.6rem;font-weight:700;letter-spacing:0.08em;
                text-transform:uppercase;color:${severityColor(issue.severity, c)};
              ">${esc(issue.severity)}</span>
              <span style="flex-shrink:0;color:${c.muted}">${esc(issue.category)}</span>
              <span style="opacity:0.85">${esc(issue.description)}</span>
            </div>`,
                )
                .join('')
        }
      </div>
    `;

    root.querySelector('#prism-refresh')?.addEventListener('click', () => {
      cache = null;
      load(api.context);
    });
  }

  function renderOverview(ctx: PluginContext, reports: Report[]): void {
    const c = themeColors(ctx.theme === 'dark');
    root.style.background = c.bg;
    root.style.color = c.text;
    const sorted = [...reports].sort((a, b) => a.overall_score - b.overall_score);

    root.innerHTML = `
      ${header(ctx, c, 'all projects', 'session health overview · select a project for the full report')}

      <div class="prism-up" style="
        background:${c.surface};border:1px solid ${c.border};
        border-radius:3px;padding:18px;animation-delay:0.06s
      ">
        <div style="font-size:0.62rem;color:${c.muted};letter-spacing:0.12em;text-transform:uppercase;margin-bottom:14px">
          ${sorted.length} project${sorted.length === 1 ? '' : 's'} · worst first
        </div>
        ${
          sorted.length === 0
            ? `<div style="font-size:0.72rem;color:${c.muted}">no projects with session data found</div>`
            : sorted
                .map(
                  (r, i) => `
          <div class="prism-up" style="display:flex;align-items:center;gap:12px;margin-bottom:9px;animation-delay:${0.1 + i * 0.03}s">
            <div style="
              flex:1;min-width:0;font-size:0.7rem;overflow:hidden;
              text-overflow:ellipsis;white-space:nowrap;opacity:0.85;
            " title="${esc(r.display_name)}">${esc(r.display_name)}</div>
            <div style="width:70px;font-size:0.66rem;color:${c.muted};text-align:right;flex-shrink:0">
              ${Number(r.session_count)} sess
            </div>
            <div style="width:120px;flex-shrink:0;display:flex">
              ${scoreBar(r.overall_score, r.overall_grade, c, 0.12 + i * 0.03)}
            </div>
            <div style="width:42px;font-size:0.68rem;color:${c.muted};text-align:right;flex-shrink:0">${Number(r.overall_score).toFixed(0)}</div>
            ${gradeChip(r.overall_grade, c)}
          </div>`,
                )
                .join('')
        }
      </div>
    `;

    root.querySelector('#prism-refresh')?.addEventListener('click', () => {
      cache = null;
      load(api.context);
    });
  }

  function renderNoData(ctx: PluginContext): void {
    const c = themeColors(ctx.theme === 'dark');
    root.style.background = c.bg;
    root.style.color = c.text;
    root.innerHTML = `
      ${header(ctx, c, esc(ctx.project?.name ?? 'project'), esc(ctx.project?.path ?? ''))}
      <div class="prism-up" style="
        background:${c.surface};border:1px solid ${c.border};
        border-radius:3px;padding:28px 24px;text-align:center;animation-delay:0.06s
      ">
        <div style="font-size:0.62rem;color:${c.muted};letter-spacing:0.12em;text-transform:uppercase;margin-bottom:10px">no session data</div>
        <div style="font-size:0.74rem;color:${c.text};opacity:0.85;line-height:1.7">
          PRISM has no recorded Claude Code sessions for this project yet.<br>
          Run a session here, then hit refresh.
        </div>
      </div>`;
    root.querySelector('#prism-refresh')?.addEventListener('click', () => {
      cache = null;
      load(api.context);
    });
  }

  function renderFromCache(ctx: PluginContext): void {
    if (!cache) return;
    if (cache.projectPath) {
      if (cache.reports[0]) renderReport(ctx, cache.reports[0]);
      else renderNoData(ctx);
    } else {
      renderOverview(ctx, cache.reports);
    }
  }

  async function load(ctx: PluginContext): Promise<void> {
    renderLoading(ctx);
    try {
      if (!health) {
        health = (await api.rpc('GET', 'health')) as Health;
      }
      if (!health.installed) {
        renderNotInstalled(ctx);
        return;
      }
      const projectPath = ctx.project?.path ?? null;
      const query = projectPath ? `report?path=${encodeURIComponent(projectPath)}` : 'report';
      const { reports } = (await api.rpc('GET', query)) as { reports: Report[] };
      cache = { projectPath, reports };
      renderFromCache(ctx);
    } catch (err) {
      renderError(ctx, (err as Error).message);
    }
  }

  load(api.context);

  const unsubscribe = api.onContextChange((ctx) => {
    const projectPath = ctx.project?.path ?? null;
    if (cache && cache.projectPath === projectPath) renderFromCache(ctx);
    else load(ctx);
  });

  (container as any)._prismUnsubscribe = unsubscribe;
}

export function unmount(container: HTMLElement): void {
  if (typeof (container as any)._prismUnsubscribe === 'function') {
    (container as any)._prismUnsubscribe();
    delete (container as any)._prismUnsubscribe;
  }
  container.innerHTML = '';
}
