# Claude Usage — CloudCLI Plugin Design

**Date:** 2026-07-16
**Status:** Approved

## Purpose

A CloudCLI UI tab plugin that displays the current usage of Claude Code:

1. **Live plan usage** — how much of the subscription's rate limits are consumed right now (session 5-hour window, weekly, per-model weekly), with reset countdowns.
2. **Historical usage** — tokens and estimated cost over the last 30 days, broken down by day, model, and project, parsed from local session transcripts.

## Data sources (verified on this machine)

| Source | Location | Provides |
|---|---|---|
| OAuth usage endpoint | `https://api.anthropic.com/api/oauth/usage`, Bearer token from `~/.claude/.credentials.json`, header `anthropic-beta: oauth-2025-04-20` | `limits[]` with `kind` (session / weekly_all / weekly_scoped), `percent`, `severity`, `resets_at`, optional model `scope`; plus `extra_usage` credits. Plan (`subscriptionType`) and tier (`rateLimitTier`) come from the credentials file. |
| Session transcripts | `~/.claude/projects/**/*.jsonl` | Per-assistant-message `message.usage` (input / output / cache_creation / cache_read tokens), `message.model`, `timestamp`, message id. |

**Accepted risk:** the usage endpoint is unofficial and its shape may change. The backend parses defensively; the live section degrades to "live data unavailable" without affecting the history section.

## Architecture

Standard template shape — no new npm dependencies (Node built-ins + vanilla DOM + inline SVG):

```
manifest.json            name: claude-usage, slot: tab
src/types.ts             plugin API types (from template, unchanged)
src/index.ts             frontend: dashboard UI
src/server.ts            backend: /live and /history endpoints
```

## Backend (`src/server.ts`)

### `GET /live`
- Read `~/.claude/.credentials.json`; if missing → `{error}` with guidance.
- If `expiresAt` is past → `{error: "token expired — run claude to refresh"}`. The plugin never uses the refresh token and never writes to the credentials file.
- Call the usage endpoint; normalize to `{plan, tier, limits: [{kind, label, percent, severity, resetsAt, model?}], extraUsage?}`.
- Cache the response in memory for 30 seconds.

### `GET /history?days=30`
- Walk `~/.claude/projects/*/ *.jsonl` (project dir name doubles as project label, prettified).
- For each line with `message.usage`, extract tokens, model, timestamp, message id.
- **Dedupe by message id** — transcripts repeat identical usage lines for a message.
- Aggregate: `daily[]` (date, tokens by type, est. cost), `byModel[]`, `byProject[]`, `totals` (tokens, est. cost, session count).
- Cost from a bundled static price table for current model families ($/MTok: input, output, cache write, cache read). Unknown models: tokens counted, cost marked unpriced.
- Cache parsed per-file results keyed by mtime; re-polls only re-read changed files.

## Frontend (`src/index.ts`)

Single scrollable dashboard, theme-aware (`api.context.theme`, re-styled on `onContextChange`).

1. **Live section** — plan badge (e.g. `max · 20x`); one horizontal gauge per active limit with percent, severity color (normal / warning / exceeded), and "resets in Xh Ym" countdown. Auto-refresh: `rpc GET /live` every 60 s while mounted; countdown ticks locally every minute. Timers cleared in `unmount`.
2. **History section** — daily stacked bar chart (last 30 days, token types stacked); totals row (total tokens, est. cost, sessions); breakdown tables by model and by project (tokens + est. cost).

Sections fail independently: an error in one renders an inline notice there while the other still displays.

## Error handling summary

| Failure | Behavior |
|---|---|
| No credentials file / expired token | Live section shows guidance message; history unaffected |
| Usage endpoint changed / unreachable | Live section: "live data unavailable"; history unaffected |
| No transcripts / unreadable files | History shows empty state; unreadable files skipped silently |
| Unknown model in transcripts | Tokens counted, cost column shows "—" |

## Testing

- `npm run build` (tsc) type-checks both entry points.
- Backend verified directly: `node dist/server.js`, then `curl localhost:<port>/live` and `/history`.
- End-to-end: install the plugin in CloudCLI UI (Settings → Plugins) and verify the tab renders both sections.

## Out of scope

- Refreshing OAuth tokens.
- Live per-request streaming updates (polling only).
- Pricing accuracy guarantees for API-billed accounts (costs are estimates).
- Any interaction with the chat/session system.
