# claude-github-issue

A [claudecodeui](https://github.com/siteboon/claudecodeui) plugin that adds a **GitHub Issues Kanban board** tab to your workspace. Manage issues visually, filter and sort them, create new ones, and prioritize with AI — all without leaving your editor.

Also auto-installs the `/github-task` skill so Claude can manage issues directly from chat.

<img width="2106" height="1004" alt="GitHub Issues Board" src="https://github.com/user-attachments/assets/020995b5-6292-4e70-9af1-9eb124e4686b" />

<img width="2076" height="197" alt="Toolbar with search, priority filters and sort" src="https://github.com/user-attachments/assets/9deb1117-a711-46f6-8ab1-bf55a357c79d" />

---

## Features

### Kanban Board
- 5 columns: **To Do**, **In Progress**, **In Review**, **Blocked**, **Done**
- Collapsible columns — state persisted per-project in localStorage
- Drag-free: move issues by clicking a card → selecting the target column
- Auto-refreshes every 30 seconds

### Search, Filter & Sort
- **Live search** — filter by title, issue number, or body text
- **Priority pills** — filter board by High / Medium / Low priority (detected from labels)
- **Sort dropdown** — sort by Number, Updated, Created, Comments, Title, or Priority
- **Direction toggle** — ascending / descending with a single click

### Issue Cards
- Shows title, issue number, assignee avatars, comment count, and labels
- **Image thumbnails** — images in issue body appear as inline previews
- Click any thumbnail to open a full-screen **lightbox**
- Color-coded **priority dot** (red / amber / gray) after AI prioritization

### Issue Detail Modal
- Full description with image thumbnails and lightbox
- Labels, assignees, timestamps
- **Move to column** — instantly reassigns labels (and closes/reopens as needed)
- **Comments** — full history with user avatars, images, and timestamps
- **Add comment** — post directly to GitHub from the modal
- Open on GitHub link

### New Issue
- **+ New Issue** button in the toolbar
- Quick form: title (required) + description (optional)
- Issue appears on the board immediately after creation

### AI Prioritize
- Single **★ AI Prioritize** button — always works, no setup required
- Without API key: uses smart heuristics (labels, age, engagement)
- With Anthropic API key: sends issues to **Claude Haiku** for semantic analysis
- Results: color-coded priority dots on cards + hover tooltips with reasoning
- Auto-switches sort to Priority after analysis
- **Claude.ai subscription mode** — available in ⚙ Settings → "Use claude.ai →": generates a ready-to-paste prompt, paste Claude's JSON response back to apply priorities

### Settings (⚙ per project)
- GitHub Personal Access Token
- Repository owner and name
- Optional Anthropic API key (enables real AI prioritization)
- Link to `/github-task` skill documentation
- Config stored in `.GitHubBoard/github-sync.json` in the project root (not committed if added to `.gitignore`)

### /github-task CLI Skill
On first plugin load, installs `/github-task` skill to `~/.claude/skills/github-task/SKILL.md` — available in every Claude Code chat session:

```
/github-task list to do
/github-task move #42 to in-progress
/github-task what needs testing?
/github-task update #17 — implemented the new login flow
```

---

## Installation

1. Open **claudecodeui**
2. Go to **Settings → Plugins**
3. Paste the repository URL:
   ```
   https://github.com/szmidtpiotr/claude-github-issue
   ```
4. Click **Install**

The plugin appears as a new **GitHub Issues** tab. No global configuration needed — each project configures its own GitHub connection.

---

## Project Configuration

Click the **⚙** button in the board toolbar to open settings, or create `.GitHubBoard/github-sync.json` manually:

<img width="895" height="1192" alt="image" src="https://github.com/user-attachments/assets/655fd817-23c5-4b00-bc93-edfd896d0434" />


**Generate a token:** GitHub → Settings → Developer settings → Personal access tokens → Generate new (classic)
Required scope: `repo`

To enable real AI prioritization, also add:
```json
{
  "anthropicKey": "sk-ant-api03-..."
}
```

---

## Column → Label Mapping

| Column      | Condition                        |
|-------------|----------------------------------|
| To Do       | Open issue, no status labels     |
| In Progress | Has label `in-progress`          |
| In Review   | Has label `review`               |
| Blocked     | Has label `blocked`              |
| Done        | Issue is closed                  |

Moving an issue via the UI updates labels and state via the GitHub API immediately.

### Priority Detection (from labels)

| Priority | Detected from labels                                                            |
|----------|---------------------------------------------------------------------------------|
| High     | `critical`, `blocker`, `p0`, `urgent`, `security`, `high`, `priority:high`      |
| Medium   | `p1`, `important`, `medium`, `priority:medium`                                  |
| Low      | `p2`, `p3`, `low`, `nice-to-have`, `enhancement`, `priority:low`               |

---

## Development

```bash
git clone https://github.com/szmidtpiotr/claude-github-issue
cd claude-github-issue
npm install
npm run build
```

Output:
- `dist/frontend.js` — browser bundle (React, classic JSX runtime)
- `dist/backend.js` — CommonJS Node.js server (listens on random port, reports `{"ready":true,"port":N}`)

### Dev watch mode
```bash
npm run dev
```

### Stack
- **Frontend:** React 18, TypeScript, Vite
- **Backend:** Node.js HTTP server, TypeScript, esbuild
- **Plugin protocol:** `manifest.json` + `mount(container, api)` / `unmount(container)` exports

---

## Contributing

PRs welcome. Please open an issue first for significant changes.

## License

MIT
