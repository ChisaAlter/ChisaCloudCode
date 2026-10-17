<div align="center">
  <img src="https://raw.githubusercontent.com/siteboon/claudecodeui/main/public/logo.svg" alt="CloudCLI" width="64" height="64">
  <h1>Codex Usage</h1>
  <p>Live Codex plan limits and account token activity inside CloudCLI.</p>
</div>

# Codex Usage — CloudCLI Plugin

Codex Usage adds a dedicated CloudCLI tab with:

- Live Codex rate-limit windows, utilization, reset countdowns, and available free resets.
- A zero-filled 30-day token activity chart.
- 30-day, lifetime, peak-day, and current-streak summaries.
- Automatic plan-limit refresh every 60 seconds.

The backend talks only to the official [`codex app-server`](https://developers.openai.com/codex/app-server/) JSON-RPC interface. It does not read `~/.codex/auth.json`, store tokens, or call private web endpoints.

## Requirements

- A recent Codex CLI with `account/rateLimits/read` and `account/usage/read` app-server methods.
- Codex signed in with ChatGPT-backed authentication.

Account activity is not available for API-key-only or Amazon Bedrock authentication. This is a Codex service limitation, and the plugin shows the app-server error when those modes are active.

## Installation

Open **Settings > Plugins** in CloudCLI, paste this repository URL, and click **Install**. Or install manually:

```bash
git clone https://github.com/dongwook-chan/cloudcli-plugin-codex-usage.git ~/.claude-code-ui/plugins/codex-usage
cd ~/.claude-code-ui/plugins/codex-usage
npm install
npm run build
```

## Development

```bash
npm install
npm test
npm run build
```

The plugin server exposes two host-proxied read-only routes:

- `GET /rate-limits` → `account/rateLimits/read`
- `GET /activity?days=30` → `account/usage/read`

## License

MIT
