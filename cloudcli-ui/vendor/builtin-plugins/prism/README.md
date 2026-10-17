<div align="center">
  <h1>PRISM for CloudCLI</h1>
</div>

<p align="center">
  <a href="https://github.com/jakeefr/prism">PRISM</a> · <a href="https://cloudcli.ai">CloudCLI Cloud</a> · <a href="https://cloudcli.ai/docs/plugin-overview">Plugin Docs</a> · <a href="https://github.com/jakeefr/cloudcli-plugin-prism/issues">Bug Reports</a>
</p>

<div align="center">

**Session intelligence for Claude Code, inside CloudCLI. See why your sessions are burning tokens without leaving the browser.**

</div>

---

## What it does

This plugin adds a PRISM tab to [CloudCLI](https://github.com/siteboon/claudecodeui) that scores your Claude Code sessions after the fact and tells you what to fix:

1. **A health grade per project**: overall score plus a breakdown across five dimensions (token efficiency, tool health, context hygiene, CLAUDE.md adherence, session continuity)
2. **The top issues PRISM found**: retry loops, CLAUDE.md re-read costs, rule violations, truncated sessions, with severity
3. **An all-projects overview when nothing is selected**: every project sorted worst first, so the sessions that need attention surface immediately

Remote sessions write the same JSONL data as local ones, so everything PRISM scores locally works the same when your sessions run through CloudCLI.

---

## Quick start

[PRISM](https://github.com/jakeefr/prism) needs to be installed and on PATH (Python 3.11+):

```bash
# Install PRISM
pip install prism-cc

# Or isolated
pipx install prism-cc
```

Then install the plugin: open **Settings > Plugins** in CloudCLI, paste this repository's URL, and click **Install**. The repo is cloned, dependencies are installed, TypeScript is compiled, and the plugin is ready to enable.

Manual install works too:

```bash
git clone https://github.com/jakeefr/cloudcli-plugin-prism.git ~/.claude-code-ui/plugins/prism
cd ~/.claude-code-ui/plugins/prism
npm install
npm run build
```

Enable "PRISM" in **Settings > Plugins** and a new tab appears.

---

## What you'll see

With a project selected:

```
 my-project                                          [refresh]

 B+   overall health        83.8 / 100 · 12 sessions

 dimensions
   token efficiency      ████████░░   75   B
   tool health           ████████░░   75   B
   context hygiene       █████████░   90   A
   claude.md adherence   █████████░   85   A-
   session continuity    ██████████  100   A+

 top issues
   HIGH    token_efficiency   CLAUDE.md re-reads consume >200% of session tokens
   MEDIUM  tool_health        Retry loop detected on npm test
```

With no project selected, a table of every project, worst first. Select a project for the full report. Refresh re-runs the analysis on demand; results are cached per project until you refresh or switch.

For deeper digging (session replay, CLAUDE.md fix recommendations, the interactive TUI), run `prism` directly in a terminal. This tab is the at-a-glance view.

---

## How it works

The frontend renders into the plugin tab and talks to a small backend through the host's RPC proxy. The backend spawns `prism analyze --json` (scoped with `--project <path>` when a project is selected), parses the JSON report, and returns it.

```
plugin tab (dist/index.js)
    |  api.rpc('GET', 'report?path=...')
    v
plugin backend (dist/server.js)
    |  prism analyze --project <path> --json
    v
prism CLI -> ~/.claude/projects/<encoded>/[...].jsonl
```

If `prism` is installed somewhere unusual, point the plugin at it with the `PRISM_BIN` environment variable.

---

## Trust & Safety

<details>
<summary><b>Does this plugin send any data anywhere?</b></summary>

No. The backend only talks to the locally installed prism CLI, and PRISM itself never makes network calls. All analysis runs locally against files already on your machine.
</details>

<details>
<summary><b>Can it hurt my sessions?</b></summary>

No. The plugin is read-only end to end. It reads what PRISM reads, your own session files under `~/.claude/projects/`, and never writes to them.
</details>

---

## Development

```bash
npm install
npm run build   # compile TypeScript to dist/
npm test        # build + node --test against the compiled helpers
```

`src/types.ts` is the plugin API definition copied from the [plugin starter](https://github.com/cloudcli-ai/cloudcli-plugin-starter).

## License

MIT
