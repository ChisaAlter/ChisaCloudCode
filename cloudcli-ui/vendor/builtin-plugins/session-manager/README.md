# CloudCLI Session Manager Plugin

A session management tab plugin for [CloudCLI](https://github.com/siteboon/claudecodeui) that lets you view, monitor, kill, resume, and clean up Claude Code sessions — all from the web UI.

## Features

- **Live session list** — See all running Claude Code processes with PID, project, user, and uptime
- **Three-state status** — Sessions are classified as ACTIVE (processing), IDLE (waiting at prompt), or STUCK (frozen 30+ min)
- **Context inspection** — Click any session row to see last prompt, away summary, and last Claude output
- **Kill sessions** — Send SIGTERM (with SIGKILL fallback) to stuck or unwanted sessions
- **Resume sessions** — Resume a stopped session by its session ID
- **Cleanup** — Delete orphaned session JSON files and compress old `.jsonl` logs (30+ days)
- **Auto-refresh** — Optional 10-second polling with toggle
- **Dark/light theme** — Automatically follows CloudCLI's theme setting

## Screenshots

| Dark Mode | Light Mode |
|-----------|------------|
| ![Dark](img/Dark.jpg) | ![Light](img/Light.jpg) |

## Installation

### Via CloudCLI Settings

1. Open CloudCLI web UI
2. Go to **Settings > Plugins**
3. Paste the repository URL:
   ```
   https://github.com/strykereye2/cloudcli-plugin-session-manager
   ```
4. Click **Install**
5. Restart CloudCLI (or refresh the page)

### Manual Installation

```bash
# Clone into your plugins directory
cd ~/.claude-code-ui/plugins
git clone https://github.com/strykereye2/cloudcli-plugin-session-manager session-manager

# Register in plugins.json
node -e "
  const fs = require('fs');
  const p = process.env.HOME + '/.claude-code-ui/plugins.json';
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(p, 'utf8')); } catch {}
  cfg['session-manager'] = { name: 'session-manager', source: 'local', enabled: true };
  fs.writeFileSync(p, JSON.stringify(cfg, null, 2));
  console.log('Registered session-manager plugin');
"
```

### Docker Integration

If you're baking this into a Docker image, copy the plugin files at build time and register at runtime:

```dockerfile
# Dockerfile
COPY plugins/session-manager /home/user/.claude-code-ui/plugins/session-manager
```

```bash
# Runtime registration (e.g., in an entrypoint script)
node -e "
  const fs = require('fs');
  const p = '/home/user/.claude-code-ui/plugins.json';
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(p, 'utf8')); } catch {}
  if (!cfg['session-manager']) {
    cfg['session-manager'] = { name: 'session-manager', source: 'local', enabled: true };
    fs.writeFileSync(p, JSON.stringify(cfg, null, 2));
  }
"
```

## Configuration

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `SESSION_MANAGER_HOMES` | Comma-separated list of home directories to scan for Claude session data | `$HOME` (current user's home) |
| `SESSION_MANAGER_USER` | OS user to run resumed sessions as | Current user (`os.userInfo().username`) |

**Example:**

```bash
export SESSION_MANAGER_HOMES="/home/myuser,/root"
export SESSION_MANAGER_USER="myuser"
```

### How Status Detection Works

The plugin uses Linux `/proc` filesystem to detect session state:

| Status | Condition | Meaning |
|--------|-----------|---------|
| **ACTIVE** | `wchan != ep_poll` | Claude is processing, running a tool, or generating output |
| **IDLE** | `wchan == ep_poll` AND `.jsonl` modified < 30 min ago | Waiting at prompt after recent work |
| **STUCK** | `wchan == ep_poll` AND `.jsonl` untouched 30+ min | Frozen or abandoned session |

### Platform Note

This plugin uses `/proc` for process inspection, which means it only works on **Linux** systems. It is designed for containerized environments (Docker, Podman) where Claude Code runs headless.

## API Endpoints

The plugin server exposes these endpoints (accessed via CloudCLI's plugin RPC proxy):

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/sessions` | List all running Claude Code sessions |
| `GET` | `/sessions/:pid/context` | Get session context (last prompt, away summary, last output) |
| `POST` | `/sessions/:pid/kill` | Kill a session (SIGTERM + SIGKILL fallback) |
| `POST` | `/sessions/resume` | Resume a session by ID (body: `{sessionId, cwd, user}`) |
| `POST` | `/sessions/cleanup` | Delete orphaned session files + compress old logs |

## Plugin Architecture

```
cloudcli-plugin-session-manager/
├── manifest.json       # Plugin metadata (name, slot, entry points)
├── icon.svg            # Tab icon (clock face)
├── src/
│   ├── server.js       # Node.js HTTP backend (/proc parsing, session management)
│   └── index.js        # Frontend UI (mount/unmount exports)
├── dist/
│   ├── server.js       # Production copy of server
│   └── index.js        # Production copy of frontend
├── package.json
├── LICENSE             # MIT
└── README.md
```

### How CloudCLI Plugins Work

- **`manifest.json`** — Declares the plugin name, type (`module`), slot (`tab`), and entry points
- **`server`** entry — CloudCLI spawns this as a child process; it prints `{"ready": true, "port": N}` to stdout
- **`entry`** — Frontend module that exports `mount(container, api)` and `unmount(container)`
- **`api.rpc(method, path, body)`** — Proxied to the server process via CloudCLI's plugin RPC
- **`api.context`** — Provides theme, project path, session info
- **`api.onContextChange(cb)`** — Subscribe to theme/project changes

## Development

```bash
# Clone the repo
git clone https://github.com/strykereye2/cloudcli-plugin-session-manager
cd cloudcli-plugin-session-manager

# Build (copies src -> dist)
npm run build

# Test the server standalone (Linux only)
node dist/server.js
# Outputs: {"ready":true,"port":XXXXX}

# Then test endpoints:
curl http://127.0.0.1:XXXXX/sessions
```

## Requirements

- **CloudCLI** v0.3.0+ (plugin system support)
- **Node.js** v18+ (uses ES modules, `node:` imports)
- **Linux** (requires `/proc` filesystem for process inspection)

## License

MIT — see [LICENSE](LICENSE).
