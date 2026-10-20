package main

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func syncGitHeadFixture(t *testing.T) (*syncSeedTestTools, *Mapping, syncGitState, string) {
	t.Helper()
	m := isolatePi(t)
	tools := syncSeedTools(t)
	for _, item := range tools.env {
		key, value, _ := strings.Cut(item, "=")
		if strings.HasPrefix(key, "GIT_") {
			t.Setenv(key, value)
		}
	}
	tools.gitRun(t, m.LocalPath, "init", "-b", "main")
	tools.gitRun(t, m.LocalPath, "config", "user.name", "HEAD CAS regression")
	tools.gitRun(t, m.LocalPath, "config", "user.email", "head@localhost")
	tools.gitRun(t, m.LocalPath, "config", "core.autocrlf", "false")
	syncSeedWrite(t, m.LocalPath, "tracked.txt", "keep worktree\n")
	tools.gitRun(t, m.LocalPath, "add", ".")
	tools.gitRun(t, m.LocalPath, "commit", "-m", "base")
	before, err := readLocalGitState(context.Background(), m)
	if err != nil {
		t.Fatal(err)
	}
	next := tools.gitRun(t, m.LocalPath, "commit-tree", before.Index, "-p", before.Head, "-m", "next")
	tools.gitRun(t, m.LocalPath, "branch", "feature")
	tools.gitRun(t, m.LocalPath, "branch", "raced")
	return tools, m, before, next
}

func syncGitHeadPath(t *testing.T, tools *syncSeedTestTools, m *Mapping) string {
	t.Helper()
	path := tools.gitRun(t, m.LocalPath, "rev-parse", "--git-path", "HEAD")
	if !filepath.IsAbs(path) {
		path = filepath.Join(m.LocalPath, path)
	}
	return path
}

func syncGitExpectHead(t *testing.T, tools *syncSeedTestTools, m *Mapping, state syncGitState) {
	t.Helper()
	path := syncGitHeadPath(t, tools, m)
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if !syncGitHeadMatches(raw, state) || tools.gitRun(t, m.LocalPath, "rev-parse", "HEAD") != state.Head {
		t.Fatalf("unexpected HEAD %q; wanted %+v", raw, state)
	}
	if _, err = os.Lstat(path + ".lock"); !os.IsNotExist(err) {
		t.Fatalf("our HEAD.lock survived: %v", err)
	}
	if paths, err := filepath.Glob(filepath.Join(filepath.Dir(path), "chisa-head-*")); err != nil || len(paths) != 0 {
		t.Fatalf("temporary Git context survived: %q %v", paths, err)
	}
	if content, err := os.ReadFile(filepath.Join(m.LocalPath, "tracked.txt")); err != nil || string(content) != "keep worktree\n" {
		t.Fatalf("worktree changed: %q %v", content, err)
	}
}

func TestGitHeadCASBranchAndDetach(t *testing.T) {
	for _, name := range []string{"branch-switch", "same-branch", "new-branch", "detach", "attach", "detached-move", "legacy-branch-switch", "unicode-branch"} {
		t.Run(name, func(t *testing.T) {
			tools, m, before, next := syncGitHeadFixture(t)
			desired := before
			desired.Head, desired.Branch = next, "refs/heads/feature"
			old := before.Head
			switch name {
			case "same-branch":
				desired.Branch = before.Branch
			case "new-branch":
				desired.Branch, old = "refs/heads/new", strings.Repeat("0", len(next))
			case "detach":
				desired.Branch, old = "", ""
			case "attach", "detached-move":
				tools.gitRun(t, m.LocalPath, "update-ref", "--no-deref", "HEAD", before.Head)
				before.Branch = ""
				if name == "detached-move" {
					desired.Branch, old = "", ""
				}
			case "unicode-branch":
				desired.Branch, old = "refs/heads/开发", strings.Repeat("0", len(next))
			}
			var err error
			if name == "legacy-branch-switch" {
				path := syncGitHeadPath(t, tools, m)
				observed, readErr := os.ReadFile(path)
				if readErr != nil {
					t.Fatal(readErr)
				}
				err = applyLocalGitHeadLocked(context.Background(), m, before, desired, old, path, observed)
			} else {
				err = applyLocalGitHead(context.Background(), m, before, desired, old)
			}
			if err != nil {
				t.Fatal(err)
			}
			syncGitExpectHead(t, tools, m, desired)
			if desired.Branch != "refs/heads/main" && tools.gitRun(t, m.LocalPath, "rev-parse", "refs/heads/main") != before.Head {
				t.Fatal("previous branch moved")
			}
		})
	}
}

func TestGitHeadCASRejectsSameOIDSwitchBeforeLock(t *testing.T) {
	for _, name := range []string{"native-branch", "detach", "detached-attach", "detached-move"} {
		t.Run(name, func(t *testing.T) {
			tools, m, before, next := syncGitHeadFixture(t)
			desired := before
			desired.Head, desired.Branch = next, "refs/heads/feature"
			if strings.HasPrefix(name, "detached-") {
				tools.gitRun(t, m.LocalPath, "update-ref", "--no-deref", "HEAD", before.Head)
				before.Branch = ""
			}
			if name == "detach" || name == "detached-move" {
				desired.Branch = ""
			}
			calls := 0
			ctx := context.WithValue(context.Background(), syncGitHeadBeforeLockKey{}, func() {
				calls++
				tools.gitRun(t, m.LocalPath, "symbolic-ref", "HEAD", "refs/heads/raced")
			})
			if err := applyLocalGitHead(ctx, m, before, desired, before.Head); err == nil {
				t.Fatal("same-OID external HEAD switch was overwritten")
			}
			if calls != 1 {
				t.Fatalf("race was not injected exactly once: %d", calls)
			}
			raced := before
			raced.Branch = "refs/heads/raced"
			syncGitExpectHead(t, tools, m, raced)
			if tools.gitRun(t, m.LocalPath, "rev-parse", "refs/heads/feature") != before.Head {
				t.Fatal("target branch moved despite failed HEAD CAS")
			}
		})
	}
}

func TestGitHeadCASPreservesForeignLockAndTargetTip(t *testing.T) {
	for _, name := range []string{"native-branch", "same-branch", "detach"} {
		t.Run(name, func(t *testing.T) {
			tools, m, before, next := syncGitHeadFixture(t)
			desired := before
			desired.Head, desired.Branch = next, "refs/heads/feature"
			if name == "same-branch" {
				desired.Branch = before.Branch
			} else if name == "detach" {
				desired.Branch = ""
			}
			path := syncGitHeadPath(t, tools, m)
			foreign := []byte("another Git writer's lock\n")
			if err := os.WriteFile(path+".lock", foreign, 0600); err != nil {
				t.Fatal(err)
			}
			if err := applyLocalGitHead(context.Background(), m, before, desired, before.Head); err == nil {
				t.Fatal("foreign HEAD.lock was ignored")
			}
			if raw, err := os.ReadFile(path + ".lock"); err != nil || string(raw) != string(foreign) {
				t.Fatalf("foreign lock changed: %q %v", raw, err)
			}
			if tools.gitRun(t, m.LocalPath, "rev-parse", "refs/heads/main") != before.Head || tools.gitRun(t, m.LocalPath, "rev-parse", "refs/heads/feature") != before.Head {
				t.Fatal("branch moved while HEAD was locked by another writer")
			}
		})
	}
}

func TestGitHeadCASExactTargetOID(t *testing.T) {
	for _, name := range []string{"native-branch", "legacy-branch", "same-branch"} {
		t.Run(name, func(t *testing.T) {
			tools, m, before, next := syncGitHeadFixture(t)
			desired := before
			desired.Head, desired.Branch = next, "refs/heads/feature"
			if name == "same-branch" {
				desired.Branch = before.Branch
			}
			// The observed target tip is deliberately stale, even though HEAD
			// and its raw attachment still exactly match the expected state.
			var err error
			if name == "legacy-branch" {
				path := syncGitHeadPath(t, tools, m)
				observed, readErr := os.ReadFile(path)
				if readErr != nil {
					t.Fatal(readErr)
				}
				err = applyLocalGitHeadLocked(context.Background(), m, before, desired, next, path, observed)
			} else {
				err = applyLocalGitHead(context.Background(), m, before, desired, next)
			}
			if err == nil {
				t.Fatal("stale target branch expectation was ignored")
			}
			syncGitExpectHead(t, tools, m, before)
			if tools.gitRun(t, m.LocalPath, "rev-parse", desired.Branch) != before.Head {
				t.Fatal("target branch was overwritten")
			}
		})
	}
}

func TestGitHeadCASRejectsNonCommitDetachedTarget(t *testing.T) {
	tools, m, before, _ := syncGitHeadFixture(t)
	desired := before
	desired.Head, desired.Branch = before.Index, ""
	if err := applyLocalGitHead(context.Background(), m, before, desired, ""); err == nil {
		t.Fatal("detached HEAD accepted a tree object")
	}
	syncGitExpectHead(t, tools, m, before)
}

func TestGitHeadCASLinkedWorktree(t *testing.T) {
	tools, main, before, next := syncGitHeadFixture(t)
	linked := *main
	linked.LocalPath = filepath.Join(t.TempDir(), "linked")
	tools.gitRun(t, main.LocalPath, "worktree", "add", "--detach", linked.LocalPath, before.Head)
	before.Branch = ""
	desired := before
	desired.Branch, desired.Head = "refs/heads/feature", next
	if err := applyLocalGitHead(context.Background(), &linked, before, desired, before.Head); err != nil {
		t.Fatal(err)
	}
	syncGitExpectHead(t, tools, &linked, desired)
	mainState := before
	mainState.Branch = "refs/heads/main"
	syncGitExpectHead(t, tools, main, mainState)
	// Same-branch CAS must share the common refs while locking the linked
	// worktree's actual HEAD, not the main worktree's .git/HEAD.
	if err := applyLocalGitHead(context.Background(), &linked, desired, syncGitState{Head: before.Head, Branch: desired.Branch}, next); err != nil {
		t.Fatal(err)
	}
	syncGitExpectHead(t, tools, &linked, syncGitState{Head: before.Head, Branch: desired.Branch})
	syncGitExpectHead(t, tools, main, mainState)
}

const syncGitHeadWorkerBootstrap = `import os, pathlib, subprocess, sys, types
try:
    import fcntl
except ImportError:
    sys.modules['fcntl'] = types.SimpleNamespace(LOCK_EX=2, LOCK_NB=4, flock=lambda *args: None)
mode = sys.argv[2]
run = subprocess.run
target_changed = False
def legacy_run(args, *positional, **keyword):
    global target_changed
    data = keyword.get('input') or b''
    if 'legacy' in mode and b'symref-update HEAD\0' in data:
        return subprocess.CompletedProcess(args, 128, b'', b'fatal: unknown command: symref-update HEAD\n')
    if mode.endswith('target-stale') and not target_changed:
        new = None
        if b'symref-update HEAD\0' in data:
            parts = data.split(b'\0')
            new = parts[6].decode('ascii')
        elif 'update-ref' in args and 'refs/heads/feature' in args:
            new = args[args.index('refs/heads/feature') + 1]
        if new:
            target_changed = True
            run(['git', '-C', sys.argv[3], 'update-ref', 'refs/heads/feature', new], check=True, capture_output=True)
    return run(args, *positional, **keyword)
subprocess.run = legacy_run
read_bytes = pathlib.Path.read_bytes
injected = False
def raced_read_bytes(path):
    global injected
    data = read_bytes(path)
    if 'race' in mode and path.name == 'HEAD' and not injected:
        injected = True
        command = ['git', '-c', 'core.hooksPath=/dev/null', '-C', sys.argv[3], 'symbolic-ref', 'HEAD', 'refs/heads/raced']
        subprocess.run(command, check=True, capture_output=True)
    return data
pathlib.Path.read_bytes = raced_read_bytes
exec(compile(sys.argv[1], 'embedded-sync-git-head.py', 'exec'), {'__name__': '__main__'})
`

func syncGitHeadWorker(t *testing.T, tools *syncSeedTestTools, m *Mapping, request any, mode string) (string, string, error) {
	t.Helper()
	input, err := json.Marshal(request)
	if err != nil {
		t.Fatal(err)
	}
	return tools.command(t, input, tools.python, "-c", syncGitHeadWorkerBootstrap, syncGitApplyWorker, mode, m.LocalPath)
}

func TestGitHeadCASWorkerBranchDetachAndLegacy(t *testing.T) {
	for _, name := range []string{"native-branch", "legacy-branch", "same-branch", "detach", "detached-attach", "detached-move", "unicode-branch", "linked-worktree"} {
		t.Run(name, func(t *testing.T) {
			tools, m, before, next := syncGitHeadFixture(t)
			desired := before
			desired.Head, desired.Branch = next, "refs/heads/feature"
			if name == "same-branch" {
				desired.Branch = before.Branch
			} else if name == "unicode-branch" {
				desired.Branch = "refs/heads/开发"
			} else if name == "linked-worktree" {
				main := m
				linked := *m
				linked.LocalPath = filepath.Join(t.TempDir(), "linked")
				tools.gitRun(t, main.LocalPath, "worktree", "add", "--detach", linked.LocalPath, before.Head)
				m = &linked
				// Worktree creation records ORIG_HEAD for the detached checkout.
				before = syncGitWorkerRead(t, tools, m.LocalPath)
				desired.Operations = before.Operations
			}
			if strings.HasPrefix(name, "detached-") {
				tools.gitRun(t, m.LocalPath, "update-ref", "--no-deref", "HEAD", before.Head)
				before.Branch = ""
			}
			if name == "detach" || name == "detached-move" {
				desired.Branch = ""
			}
			request := map[string]any{"root": m.LocalPath, "before": before, "desired": desired, "backup": "refs/chisa/recovery/head-worker"}
			stdout, stderr, err := syncGitHeadWorker(t, tools, m, request, name)
			if err != nil {
				t.Fatalf("worker failed: %v %s %s", err, stdout, stderr)
			}
			syncGitExpectHead(t, tools, m, desired)
			if actual := syncGitWorkerRead(t, tools, m.LocalPath); actual != desired {
				t.Fatalf("worker state mismatch: %+v wanted %+v", actual, desired)
			}
			if tools.gitRun(t, m.LocalPath, "rev-parse", "refs/chisa/recovery/head-worker^{commit}") == "" {
				t.Fatal("worker recovery snapshot is missing")
			}
		})
	}
}

func TestGitHeadCASWorkerSameOIDRaceAndForeignLock(t *testing.T) {
	for _, name := range []string{"native-race", "legacy-race", "detach-race", "detached-attach-race", "foreign-native", "foreign-same-branch", "foreign-detach"} {
		t.Run(name, func(t *testing.T) {
			tools, m, before, next := syncGitHeadFixture(t)
			desired := before
			desired.Head, desired.Branch = next, "refs/heads/feature"
			if name == "foreign-same-branch" {
				desired.Branch = before.Branch
			}
			if name == "detach-race" || name == "foreign-detach" {
				desired.Branch = ""
			}
			if name == "detached-attach-race" {
				tools.gitRun(t, m.LocalPath, "update-ref", "--no-deref", "HEAD", before.Head)
				before.Branch = ""
			}
			path := syncGitHeadPath(t, tools, m)
			if strings.HasPrefix(name, "foreign-") {
				if err := os.WriteFile(path+".lock", []byte("foreign lock\n"), 0600); err != nil {
					t.Fatal(err)
				}
			}
			request := map[string]any{"root": m.LocalPath, "before": before, "desired": desired, "backup": "refs/chisa/recovery/head-worker"}
			stdout, stderr, err := syncGitHeadWorker(t, tools, m, request, name)
			if err == nil {
				t.Fatalf("worker overwrote competing Git state: %s %s", stdout, stderr)
			}
			if strings.HasPrefix(name, "foreign-") {
				if raw, err := os.ReadFile(path + ".lock"); err != nil || string(raw) != "foreign lock\n" {
					t.Fatalf("foreign HEAD lock was changed: %q %v", raw, err)
				}
			} else {
				raced := before
				raced.Branch = "refs/heads/raced"
				syncGitExpectHead(t, tools, m, raced)
			}
			if tools.gitRun(t, m.LocalPath, "rev-parse", "refs/heads/feature") != before.Head {
				t.Fatal("worker target branch moved despite failed HEAD CAS")
			}
		})
	}
}

func TestGitHeadCASWorkerExactTargetOID(t *testing.T) {
	for _, mode := range []string{"native-target-stale", "legacy-target-stale", "detached-target-stale"} {
		t.Run(mode, func(t *testing.T) {
			tools, m, before, next := syncGitHeadFixture(t)
			if mode == "detached-target-stale" {
				tools.gitRun(t, m.LocalPath, "update-ref", "--no-deref", "HEAD", before.Head)
				before.Branch = ""
			}
			desired := before
			desired.Head, desired.Branch = next, "refs/heads/feature"
			request := map[string]any{"root": m.LocalPath, "before": before, "desired": desired, "backup": "refs/chisa/recovery/head-worker"}
			stdout, stderr, err := syncGitHeadWorker(t, tools, m, request, mode)
			if err == nil || !strings.Contains(stderr, "but expected") {
				t.Fatalf("worker ignored changed target OID: %v %s %s", err, stdout, stderr)
			}
			syncGitExpectHead(t, tools, m, before)
			if tools.gitRun(t, m.LocalPath, "rev-parse", "refs/heads/feature") != next {
				t.Fatal("worker did not preserve external target change")
			}
		})
	}
}

func TestGitHeadCASWorkerPreflightBeforeIndexLock(t *testing.T) {
	tools, m, before, next := syncGitHeadFixture(t)
	desired := before
	desired.Head, desired.Branch = next, "refs/heads/feature"
	index := filepath.Join(m.LocalPath, ".git", "index")
	if err := os.WriteFile(index+".lock", []byte("foreign index lock\n"), 0600); err != nil {
		t.Fatal(err)
	}
	request := map[string]any{"root": m.LocalPath, "op": "preflight", "before": before, "desired": desired}
	stdout, stderr, err := syncGitHeadWorker(t, tools, m, request, "")
	if err != nil || strings.TrimSpace(stdout) != "{}" {
		t.Fatalf("read-only preflight required index lock: %v %s %s", err, stdout, stderr)
	}
	other := filepath.Join(t.TempDir(), "other-worktree")
	tools.gitRun(t, m.LocalPath, "worktree", "add", other, "feature")
	_, stderr, err = syncGitHeadWorker(t, tools, m, request, "")
	if err == nil || !strings.Contains(stderr, "another worktree") {
		t.Fatalf("preflight missed occupied target: %v %s", err, stderr)
	}
	if raw, err := os.ReadFile(index + ".lock"); err != nil || string(raw) != "foreign index lock\n" {
		t.Fatalf("preflight modified foreign index lock: %q %v", raw, err)
	}
}
