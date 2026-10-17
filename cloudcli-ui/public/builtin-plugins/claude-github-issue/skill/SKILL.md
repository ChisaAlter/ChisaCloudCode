---
name: github-task
description: Manage GitHub Issues as tasks — list, move between columns, update with comments, and order the Plan tab. Reads GitHub config from .GitHubBoard/github-sync.json in the current project. Use when the user invokes /github-task or asks to "check tasks", "move issue to in-progress", "update task", "what needs testing", "mark done", "sprawdź taski", "przenieś task", "zaktualizuj task", or to order/rank the Plan board: "ułóż plan", "ustaw kolejność w Plan", "uporządkuj plan wg pilności", "przelicz plan", "ustaw kolejność issues", "ułóż issues od najpilniejszych", "order the plan", "set plan order", "reorder phases".
---

# github-task skill

Read and manage GitHub Issues directly via the GitHub API using the project's stored token.

## Setup — read config

First, find and read `.GitHubBoard/github-sync.json` in the current project:

```bash
cat .GitHubBoard/github-sync.json 2>/dev/null || find . -name "github-sync.json" -path "*GitHubBoard*" 2>/dev/null | head -1 | xargs cat
```

Extract: `token`, `owner`, `repo`. If missing → tell user to configure in the GitHub Issues Board tab (click the ⚙ gear icon).

Set shell variables:
```bash
TOKEN="<token from config>"
OWNER="<owner>"
REPO="<repo>"
BASE="https://api.github.com"
AUTH="-H \"Authorization: Bearer $TOKEN\" -H \"Accept: application/vnd.github+json\" -H \"X-GitHub-Api-Version: 2022-11-28\""
```

## Status → GitHub mapping

| Column      | GitHub state | Labels to ADD              | Labels to REMOVE (status labels) |
|-------------|-------------|----------------------------|----------------------------------|
| to-do       | open        | *(none)*                   | in-progress, review, blocked, need-testing |
| in-progress | open        | in-progress                | review, blocked, need-testing    |
| review      | open        | review, need-testing       | in-progress, blocked             |
| blocked     | open        | blocked                    | in-progress, review, need-testing |
| done        | **closed**  | *(none)*                   | *(close the issue)*              |

Status labels (never show in visible label list): `in-progress`, `review`, `blocked`, `need-testing`

## Operations

### List tasks in a column

Fetch open issues:
```bash
curl -s $AUTH "$BASE/repos/$OWNER/$REPO/issues?state=open&per_page=100"
```

Filter by column:
- **to-do**: open issues with NO status labels
- **in-progress**: has label `in-progress`
- **review / need-testing**: has label `review` or `need-testing`
- **blocked**: has label `blocked`

Show as a numbered list: `#123 [priority] Title — assignee`

Closed issues (done): use `?state=closed&per_page=50`

### Move issue to new status

1. Get current issue labels:
```bash
curl -s $AUTH "$BASE/repos/$OWNER/$REPO/issues/$NUMBER" | python3 -c "import json,sys; i=json.load(sys.stdin); print(' '.join(l['name'] for l in i['labels']))"
```

2. Compute new labels: keep non-status labels, add new status label(s)

3. PATCH the issue:
```bash
# For status changes (not done):
curl -s -X PATCH $AUTH -H "Content-Type: application/json" \
  -d "{\"labels\": $NEW_LABELS_JSON}" \
  "$BASE/repos/$OWNER/$REPO/issues/$NUMBER"

# For done (close):
curl -s -X PATCH $AUTH -H "Content-Type: application/json" \
  -d "{\"state\": \"closed\"}" \
  "$BASE/repos/$OWNER/$REPO/issues/$NUMBER"
```

4. Confirm success with issue title and new status.

### Update issue (add comment)

Post a comment to the issue:
```bash
curl -s -X POST $AUTH -H "Content-Type: application/json" \
  -d "{\"body\": \"$COMMENT_TEXT\"}" \
  "$BASE/repos/$OWNER/$REPO/issues/$NUMBER/comments"
```

Include context from the user's update — what changed, what was done, what's next.

## Behavior rules

- **No confirmation needed** for status moves — execute directly and report what was done
- **Do confirm** before closing (done) if the issue has open sub-tasks or the user seems unsure
- When moving to **review**: always add BOTH `review` AND `need-testing` labels
- When moving to **done**: close the issue (state=closed), do NOT add any labels
- When user asks "what needs testing" → list issues with `need-testing` label
- When user asks "what's blocking" → list issues with `blocked` label
- When user asks "what's to do" or "sprawdź taski" → list to-do column
- When user asks to **update** a task with a message → post a comment with that message, then confirm

## Response format after each operation

```
✓ #123 — "Issue title"
  Status: in-progress → review
  Labels added: review, need-testing
  Labels removed: in-progress
```

Or for comment:
```
✓ #123 — "Issue title"
  Comment posted: "your message"
```

Keep responses short. List multiple issues as a compact table. No markdown prose.

## Screenshot pipeline — attach a screen to an issue comment

When the user asks to take a screenshot and attach it to a GitHub issue, follow this pipeline regardless of how the screenshot is captured.

### Step 1 — Get the screenshot file

Use whatever screenshot tool is appropriate for the context:

- `/screen` — generic screenshot skill (saves PNG to `temp-img/` in the current project)
- Project-specific screen command if one exists
- User-provided image path (e.g. they already have the file)

The result is a local PNG/JPG file path, e.g. `temp-img/1234567890_screen.png`.

If the user just says "take a screenshot and add to issue #N" with no further context, ask: **what URL or app should I screenshot?** then use the appropriate tool.

### Step 2 — Upload image to GitHub as release asset

GitHub issue comments don't support direct binary uploads via API. Use a release asset as image host:

```bash
# Read config
TOKEN_FILE=$(find . -name "github-sync.json" -path "*GitHubBoard*" 2>/dev/null | head -1)
OWNER=$(python3 -c "import json; d=json.load(open('$TOKEN_FILE')); print(d['owner'])")
REPO=$(python3 -c "import json; d=json.load(open('$TOKEN_FILE')); print(d['repo'])")

FILE="<path-to-screenshot>"
FNAME=$(basename $FILE)

# Get latest release tag
TAG=$(gh release list --repo $OWNER/$REPO --limit 1 --json tagName --jq '.[0].tagName')

# Upload (--clobber overwrites if name already exists)
gh release upload $TAG $FILE --repo $OWNER/$REPO --clobber

# Get public URL
URL=$(gh release view $TAG --repo $OWNER/$REPO --json assets \
  --jq ".assets[] | select(.name == \"$FNAME\") | .url")
```

### Step 3 — Post comment with image

```bash
gh issue comment <NUMBER> --repo $OWNER/$REPO \
  --body "![screenshot]($URL)"
```

Add context above the image if useful (what was captured, when, etc.).
## Plan tab — phases & ordering

The Plan tab groups issues by **GitHub Milestone** (= phase) and adds a per-issue
**order** that GitHub does not store. Order lives in a plain file the agent edits directly.

### Order store: `.GitHubBoard/plan.json`

```json
{
  "<issue#>": { "order": <int>, "phase": "<milestone title>" },
  "__phaseOrder__": ["<milestone title top-first>", "..."]
}
```
- `order` — position WITHIN a phase. Lower = higher in the list. `phase` = milestone title (informational).
- Issues with no entry sort after ordered ones, by issue number.
- `__phaseOrder__` — reserved key holding the manual order of the PHASES (milestone titles, top-first). Phases not listed keep their GitHub milestone order, after the ranked ones. This is how you move a whole milestone up/down the Plan tab.
- The plugin backend reads this file fresh on every load — just read/write it directly, no API call. Effect shows after the user hits Refresh in the Plan tab.

### Set a task's order (within a phase)
Edit `.GitHubBoard/plan.json`: assign consecutive `order` values (0, 1, 2, …) to the issues
in the phase, in the desired top-to-bottom sequence. Create the file if missing.

### Order a whole phase list "by urgency" (the common request)
When the user asks to "ułóż plan wg pilności" / "order the plan", regenerate the store
deterministically — group every issue by its milestone, sort each group, write `order` 0..n.
A good default ranking (matches the board's Priority sort):

```python
import json, subprocess
R = "OWNER/REPO"   # from github-sync.json
issues = json.loads(subprocess.check_output(
    ["gh","issue","list","--repo",R,"--state","all","--limit","400",
     "--json","number,title,labels,milestone,state"]))
PR = {"priority:high":0, "priority:medium":1, "priority:low":2}
def rank(i):
    labs = [l["name"] for l in i["labels"]]
    base = 100 if i["state"] == "closed" else 0          # closed/done sink to bottom
    p = min([PR[l] for l in labs if l in PR], default=3)  # then by priority label
    return (base, p, i["number"])                         # tiebreak: issue number
groups = {}
for i in issues:
    t = (i["milestone"] or {}).get("title")
    if t: groups.setdefault(t, []).append(i)
store = {}
for title, arr in groups.items():
    arr.sort(key=rank)
    for idx, i in enumerate(arr):
        store[str(i["number"])] = {"order": idx, "phase": title}
old = json.load(open(".GitHubBoard/plan.json"))          # preserve manual phase order
if old.get("__phaseOrder__"): store["__phaseOrder__"] = old["__phaseOrder__"]
json.dump(store, open(".GitHubBoard/plan.json","w"), indent=2, ensure_ascii=False)
```

Always back up `plan.json` → `plan.json.bak` before regenerating. To honor a custom
per-issue sequence the user dictates, override `rank` (or just write `order` by hand).
To reorder phases, set `__phaseOrder__` to the milestone titles in the wanted order.

### Set a task's phase (milestone)
```bash
gh issue edit <ISSUE#> --milestone "FAZA L"   # milestone must already exist
```
To create a milestone first:
```bash
gh api repos/$OWNER/$REPO/milestones -f title="FAZA L"
```

### Conventions
- **Milestone = phase** (e.g. "FAZA L"). One milestone per phase.
- **Priority/bug = labels** (`bug`, `P0`..`P5`) — same as the board.
- **Done = closed**, status = labels — unchanged from the board mapping above.
