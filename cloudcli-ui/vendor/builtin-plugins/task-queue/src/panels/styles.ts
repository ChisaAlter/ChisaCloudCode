import type { ThemeColors } from '../types.ts';
import { STATUS_COLOR } from '../vocabulary.ts';

const MONO = "'JetBrains Mono', 'Fira Code', ui-monospace, monospace";

export { MONO };

export function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Read a CSS custom property off CloudCLI's shared document root. The plugin renders
// inside CloudCLI's DOM, so its theme vars are in scope. Returns '' if unset/unavailable.
function rawVar(name: string): string {
  try {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  } catch {
    return '';
  }
}

// CloudCLI stores colors as bare HSL triplets ("221.2 83.2% 53.3%"), so wrap in hsl().
function hslVar(name: string, fallback: string): string {
  const v = rawVar(name);
  return v ? `hsl(${v})` : fallback;
}

// Follow CloudCLI's palette by reading its CSS vars live. CloudCLI toggles the `.dark`
// class on the same root and re-drives these vars, and the plugin re-invokes themeColors
// on api.onContextChange — so reading the vars auto-reflects the active theme. The `dark`
// param only selects which hardcoded fallback set to use when a var is missing.
export function themeColors(dark: boolean): ThemeColors {
  const fb = dark
    ? {
        bg: '#141414',
        surface: '#1F1F1F',
        border: '#2B2B2B',
        text: '#EEECEA',
        muted: '#999999',
        accent: '#3B82F6',
        dim: 'rgba(59,130,246,0.12)',
      }
    : {
        bg: '#F7F4EF',
        surface: '#FFFFFF',
        border: '#E2DDD3',
        text: '#0D0A07',
        muted: '#767066',
        accent: '#2563EB',
        dim: 'rgba(37,99,235,0.10)',
      };

  const primaryRaw = rawVar('--primary');
  const dim = primaryRaw ? `hsl(${primaryRaw} / 0.12)` : fb.dim;

  return {
    bg: hslVar('--background', fb.bg),
    surface: hslVar('--card', fb.surface),
    border: hslVar('--border', fb.border),
    text: hslVar('--foreground', fb.text),
    muted: hslVar('--muted-foreground', fb.muted),
    accent: hslVar('--primary', fb.accent),
    dim,
    // Status colors stay hardcoded: CloudCLI has no semantic status vars, and its dark
    // --destructive (#7f1d1d) is too low-contrast for status text. Green/amber/red below
    // match CloudCLI's component conventions while staying legible.
    ok: dark ? '#22c55e' : '#16a34a',
    warn: dark ? '#f59e0b' : '#d97706',
    error: dark ? '#ef4444' : '#dc2626',
  };
}

export function injectGlobalStyles(): void {
  if (document.getElementById('tq-styles')) return;

  const s = document.createElement('style');
  s.id = 'tq-styles';
  s.textContent = `
    @keyframes tq-fadeup { from { opacity:0; transform:translateY(6px) } to { opacity:1; transform:translateY(0) } }
    @keyframes tq-pulse  { 0%,100% { opacity:.4 } 50% { opacity:.8 } }
    .tq-up   { animation: tq-fadeup 0.4s ease both }
    .tq-live { animation: tq-pulse 2s ease infinite }
  `;
  document.head.appendChild(s);
}

export function ago(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60000) return 'just now';
  const m = Math.floor(ms / 60000);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

/**
 * Colour for a status. Takes `string`, not `Status` — the callers render whatever the queue
 * YAML says, including a value written by something newer than this build.
 *
 * The mapping itself lives in `vocabulary.ts` as a `Record<Status, …>`, so a status the
 * plugin knows about but has not been given a colour is a compile error. This used to be a
 * `switch` with a `default: return c.muted`, which silently absorbed `routing-failed` and
 * rendered it the same grey as `cancelled` (vikunja#558). The fallback below still exists,
 * but now it only catches statuses this build has genuinely never heard of.
 */
export function statusColor(status: string, c: ThemeColors): string {
  const key = (STATUS_COLOR as Record<string, keyof ThemeColors>)[status];
  return key ? c[key] : c.muted;
}

export function priorityColor(priority: string, c: ThemeColors): string {
  switch (priority) {
    case 'urgent': return c.error;
    case 'high': return c.warn;
    default: return c.muted;
  }
}

export function priorityIcon(priority: string): string {
  switch (priority) {
    case 'urgent': return '!!!';
    case 'high': return '!!';
    default: return '';
  }
}
