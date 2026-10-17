# Token Cost Calculator

**Know exactly how much you're spending on API calls — before the bill arrives.**

You're deep into a Claude Code session, hammering out features for hours, and suddenly wonder: *"Wait, how much did today cost me?"* Instead of logging into your Anthropic/OpenAI/DeepSeek billing dashboard and digging through usage charts, you open this plugin and see the answer in one click: **$2.37 today, $18.52 this month, $143.80 since day one.**

Token Cost Calculator is a CloudCLI tab plugin that reads your real Claude Code session transcripts (JSONL files stored locally at `~/.claude/projects/`) and turns raw token counts into dollar amounts. It covers everything — main conversation turns, sub-agent sessions, cached prompt hits, thinking tokens from reasoning models — and gives you per-day, per-project, and all-time breakdowns with zero manual work.

<img width="1468" height="909" alt="image" src="https://github.com/user-attachments/assets/698bb525-fac6-45a0-9e58-9b61b62818cc" />


---

## What it does (in plain English)

- **Auto-detect your real usage.** No copy-pasting from a billing page. The plugin scans the JSONL transcript files Claude Code already writes to your disk, extracts actual `input_tokens`, `output_tokens`, `cache_read_input_tokens`, and `cache_creation_input_tokens`, and multiplies by the price you set.
- **Five ways to slice the data.** Manual entry for quick estimates. Auto-detect for the current session. Project mode for "how much did this entire repo cost me?" All-time for total spending. Daily mode with a date picker (defaults to today) so you can check "what did I spend last Tuesday?"
- **Built-in model prices.** Claude Opus 4.7, Sonnet 4.6, Haiku 4.5, GPT-4o, GPT-4o-mini, Gemini 2.5 Pro/Flash, DeepSeek V4 Pro — pick from the dropdown or type your own custom pricing per 1M tokens.
- **Handles the weird stuff.** DeepSeek (and other reasoning models) emit multiple content blocks per turn (thinking + text + tool_use), each written as a separate JSONL entry with duplicate `message.usage`. The plugin deduplicates by `message.id` so you're not 3x overcounting. Sub-agent sessions (from Claude Code's Task tool) are scanned too.

---

## Install — 3 steps, no config files

### Step 1 — Clone into your plugins folder

```bash
cd ~/.claude-code-ui/plugins
git clone https://github.com/NightmareAway/cloudcli-plugin-token-cost-calculator.git token-cost-calculator
```

### Step 2 — Install and build

```bash
cd token-cost-calculator
npm install
npm run build
```

### Step 3 — Restart CloudCLI

Close and reopen CloudCLI (or reload the plugins panel). The **Token Cost Calculator** tab appears automatically.

That's it. No API keys, no `.env` files, no configuration. The plugin reads whatever Claude Code already stores on your machine.

---

## The five modes

| Mode | Best for | What you see |
|---|---|---|
| **Manual** | Quick estimates, hypothetical "what-if" scenarios | Enter token counts yourself, tap quick-add buttons (+1K / +10K / +100K / +1M / +10M) |
| **Auto-detect** | The session you're in right now | Reads the active JSONL transcript live, includes all turns and sub-agents |
| **Project** | "How much did this whole repo cost?" | Sums every session under one project folder, lists each session with model name |
| **All-time** | "What have I spent since installing Claude Code?" | Aggregates all projects with colored progress bars — one bar per project |
| **Daily** | "Show me just today" or "what about last Wednesday?" | Day-by-day navigator (◀ ▶ buttons), defaults to today, click any day in the list |

All modes share the same **Price per 1M Tokens** panel and **Cost Breakdown** at the bottom. Switch modes without losing your price settings.

---

## Keywords & technical details

This plugin touches a bunch of topics people search for. Here's what's under the hood:

- **Claude Code plugin / CloudCLI plugin** — Built on the CloudCLI plugin architecture (`manifest.json` + `mount`/`unmount` lifecycle hooks). Runs a Node.js HTTP subprocess for backend logic.
- **LLM token cost tracking / API spend calculator** — Multiplies `input_tokens` / `output_tokens` / `cache_read_input_tokens` by per-1M-token prices. Supports Anthropic, OpenAI, Google Gemini, and DeepSeek pricing models.
- **Prompt caching cost** — Separately tracks `cache_creation_input_tokens` and `cache_read_input_tokens`, billed at the lower cache rate. This is often the silent cost driver in long conversations.
- **JSONL session transcript parsing** — Reads `~/.claude/projects/<encoded-path>/<session-uuid>.jsonl` files line by line via Node.js `readline`. Filters `"type": "assistant"` entries and extracts `message.usage`.
- **Message deduplication** — Reasoning models (DeepSeek V4 Pro, and potentially Opus with extended thinking) emit multiple assistant JSONL rows per API call — one per content block (thinking, text, tool_use). Each row carries identical cumulative `usage`. The plugin tracks `message.id` in a `Set<string>` and skips duplicates.
- **Sub-agent / tool-use sessions** — Claude Code's Task tool spawns sub-agents whose transcripts live under `<session-dir>/subagents/*.jsonl`. The plugin recursively scans and includes these.
- **Path encoding quirks (Windows)** — Claude Code encodes project paths like `C:\Users\...` → `C--Users-...` (replacing `\`, `:`, spaces, and underscores with `-`). The plugin normalizes and reverse-maps these paths.
- **Daily token aggregation** — Groups usage by `timestamp` field (ISO 8601, extracted to `YYYY-MM-DD`). Frontend day navigator lets you step through dates or jump to today.
- **Persistent state via localStorage** — Mode, custom prices, and manual token counts survive page reloads.

---

## Project layout

```
token-cost-calculator/
├── manifest.json        # CloudCLI plugin metadata (slot: tab)
├── package.json
├── tsconfig.json
├── icon.svg
└── src/
    ├── index.ts         # Frontend: 5-mode UI, day navigator, dark/light theme
    ├── server.ts        # Backend: HTTP API, JSONL reader, token aggregation
    └── types.ts         # PluginContext / PluginAPI / PluginModule types
```

## API endpoints (backend)

| Endpoint | Returns |
|---|---|
| `GET /presets` | 8 built-in model prices |
| `GET /session-usage?projectPath=...&sessionId=...` | One session's token counts + model |
| `POST /calculate` | Cost breakdown for given tokens & prices |
| `GET /project-usage?projectPath=...` | All sessions under one project |
| `GET /all-usage` | Every project, ranked by total tokens |
| `GET /daily-usage` | All sessions grouped by `YYYY-MM-DD` |

## Develop

```bash
npm install
npm run dev     # tsc --watch
npm run build   # tsc
```

MIT.
