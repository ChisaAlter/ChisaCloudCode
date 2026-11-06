<div align="center">
  <img src="https://raw.githubusercontent.com/siteboon/claudecodeui/main/public/logo.svg" alt="CloudCLI" width="64" height="64">
  <h1>Claude Usage</h1>
  <p>A Claude Code usage plugin for <a href="https://cloudcli.ai">CloudCLI Cloud</a> and <a href="https://github.com/siteboon/claudecodeui">CloudCLI UI</a></p>
</div>

<p align="center">
  <a href="https://cloudcli.ai">CloudCLI Cloud</a> · <a href="https://discord.gg/buxwujPNRE">Discord</a> · <a href="https://github.com/siteboon/claudecodeui/issues">Bug Reports</a> · <a href="https://cloudcli.ai/docs/plugin-overview">Plugin Docs</a>
</p>

<p align="center">
  <a href="https://cloudcli.ai"><img src="https://img.shields.io/badge/☁️_CloudCLI_Cloud-Try_Now-0066FF?style=for-the-badge" alt="CloudCLI Cloud"></a>
  <a href="https://discord.gg/buxwujPNRE"><img src="https://img.shields.io/badge/Discord-Join%20Community-5865F2?style=for-the-badge&logo=discord&logoColor=white" alt="Join our Discord"></a>
</p>

---

![Claude Usage plugin running in a CloudCLI tab: plan-limit gauges, 30-day token chart, and per-model/per-project cost breakdowns](banner.png)

# Claude Usage — CloudCLI Plugin

Shows the current usage of Claude Code in a CloudCLI tab:

- **Live plan limits** — session (5h window), weekly, and per-model utilization
  gauges with severity coloring and reset countdowns, straight from the same
  endpoint that powers Claude Code's `/usage` screen. Auto-refreshes every 60s.
- **30-day history** — daily token bar chart, totals (tokens / estimated cost /
  sessions), and per-model / per-project breakdowns, parsed locally from
  `~/.claude/projects/**/*.jsonl` transcripts.

## Installation

Open **Settings > Plugins** in CloudCLI UI, paste this repository's URL, and
click **Install**. Or manually:

```bash
git clone https://github.com/HandyS11/cloudcli-plugin-claude-usage.git ~/.claude-code-ui/plugins/claude-usage
cd ~/.claude-code-ui/plugins/claude-usage
npm install && npm run build
```

## How it works

The backend subprocess (`dist/server.js`) exposes two endpoints via the host's
RPC proxy:

- `GET /live` — reads the OAuth token from `~/.claude/.credentials.json` and
  calls `https://api.anthropic.com/api/oauth/usage` (cached 30s). It never
  writes to the credentials file and never uses the refresh token; if the token
  is expired it asks you to run `claude` to refresh it.
- `GET /history?days=30` — parses local session transcripts (deduped by message
  id, cached by file mtime) and aggregates tokens and estimated cost by day,
  model, and project. Costs use a bundled price table; unknown models show "—".

Both sections fail independently — no credentials still shows history, and
vice-versa.

> **Note:** the usage endpoint is unofficial and may change; the live section
> degrades gracefully if it does.

## Development

```bash
npm install
npm test        # tsc + node --test dist/
npm run dev     # tsc --watch
```

## License

MIT
