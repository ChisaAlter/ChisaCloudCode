package main

import (
	"context"
	"os"
	"path/filepath"
	"testing"
)

func TestGitSyncBranchIndexAndRecovery(t *testing.T) {
	m := isolatePi(t)
	ctx := context.Background()
	git := func(args ...string) string {
		t.Helper()
		out, err := gitOutputContext(ctx, m.LocalPath, args...)
		if err != nil {
			t.Fatal(err)
		}
		return out
	}
	write := func(name, body string) {
		t.Helper()
		if err := os.WriteFile(filepath.Join(m.LocalPath, name), []byte(body), 0600); err != nil {
			t.Fatal(err)
		}
	}
	git("init", "-b", "main")
	git("config", "user.name", "QA")
	git("config", "user.email", "qa@localhost")
	write("tracked.txt", "base\n")
	git("add", ".")
	git("commit", "-m", "base")
	base, err := readLocalGitState(ctx, m)
	if err != nil {
		t.Fatal(err)
	}
	git("checkout", "-b", "cloud/feature")
	write("tracked.txt", "cloud commit\n")
	git("add", ".")
	git("commit", "-m", "cloud commit")
	write("tracked.txt", "staged\n")
	git("add", "tracked.txt")
	write("tracked.txt", "unstaged\n")
	write("untracked.txt", "keep\n")
	desired, err := readLocalGitState(ctx, m)
	if err != nil {
		t.Fatal(err)
	}
	// Simulate file delivery while the old client still points at main.
	git("symbolic-ref", "HEAD", "refs/heads/main")
	git("read-tree", base.Index)
	r := &syncGitCheckpoint{State: base}
	selected, err := selectGitState(ctx, m, r, base, desired)
	if err != nil || selected != desired {
		t.Fatalf("branch change rejected: %v %+v", err, selected)
	}
	if err = applyLocalGitState(ctx, m, base, desired); err != nil {
		t.Fatal(err)
	}
	actual, err := readLocalGitState(ctx, m)
	if err != nil || actual != desired {
		t.Fatalf("state did not match: %+v %v", actual, err)
	}
	if git("rev-parse", "refs/heads/main") != base.Head {
		t.Fatal("old branch moved")
	}
	if git("show", ":tracked.txt") != "staged" {
		t.Fatal("staging was lost")
	}
	for name, want := range map[string]string{"tracked.txt": "unstaged\n", "untracked.txt": "keep\n"} {
		body, _ := os.ReadFile(filepath.Join(m.LocalPath, name))
		if string(body) != want {
			t.Fatalf("worktree overwritten: %s", name)
		}
	}
	// A restart resumes a recorded partial metadata update, not an arbitrary edit.
	r.Pending = &syncGitPending{Local: base, Remote: desired, Desired: desired}
	partial := base
	partial.Head = desired.Head
	partial.Branch = desired.Branch
	if got, e := selectGitState(ctx, m, r, partial, desired); e != nil || got != desired {
		t.Fatalf("partial restart: %+v %v", got, e)
	}
	altered := partial
	altered.Index = "unexpected-stage"
	if _, e := selectGitState(ctx, m, r, altered, desired); e == nil {
		t.Fatal("restart overwrote a newer index")
	}
	r.Pending = nil
	both := base
	both.Branch = "refs/heads/local-feature"
	if _, e := selectGitState(ctx, m, r, both, desired); e == nil {
		t.Fatal("concurrent branch edits were overwritten")
	}
	// Branch names matter even when both branches point to the same commit.
	same := base
	same.Branch = "refs/heads/same-commit"
	if got, e := selectGitState(ctx, m, r, base, same); e != nil || got != same {
		t.Fatal("same-commit branch switch ignored", e)
	}
	// An owned cloud handback upgrades old mappings with no checkpoint.
	if got, e := selectGitState(context.WithValue(ctx, syncGitSourceKey{}, "remote"), m, &syncGitCheckpoint{}, base, desired); e != nil || got != desired {
		t.Fatal("old mapping handback", e)
	}
	sameBranch := desired
	sameBranch.Branch = base.Branch
	if got, e := selectGitState(context.WithValue(ctx, syncGitSourceKey{}, "remote"), m, &syncGitCheckpoint{}, base, sameBranch); e != nil || got != sameBranch {
		t.Fatal("owned same-branch history rewrite was rejected", e)
	}
	if e := os.WriteFile(filepath.Join(m.LocalPath, ".git", "index.lock"), []byte("another git writer"), 0600); e != nil {
		t.Fatal(e)
	}
	if e := applyLocalGitState(ctx, m, desired, base); e == nil {
		t.Fatal("concurrent Git index lock ignored")
	}
	lock, _ := os.ReadFile(filepath.Join(m.LocalPath, ".git", "index.lock"))
	if string(lock) != "another git writer" {
		t.Fatal("another writer's lock was removed")
	}
	if e := os.Remove(filepath.Join(m.LocalPath, ".git", "index.lock")); e != nil {
		t.Fatal(e)
	}
	index := filepath.Join(m.LocalPath, ".git", "index")
	if e := os.WriteFile(index+".chisa-owned", []byte("interrupted sync"), 0600); e != nil {
		t.Fatal(e)
	}
	if e := os.Link(index+".chisa-owned", index+".lock"); e != nil {
		t.Fatal(e)
	}
	if got, e := readLocalGitState(ctx, m); e != nil || got != desired {
		t.Fatal("owned interrupted lock did not recover", e)
	}
	// A replacement lock at the same path belongs to another Git operation.
	if e := os.WriteFile(index+".chisa-owned", []byte("old sync"), 0600); e != nil {
		t.Fatal(e)
	}
	if e := os.WriteFile(index+".lock", []byte("new git writer"), 0600); e != nil {
		t.Fatal(e)
	}
	if e := removeOwnedIndexLock(index); e != nil {
		t.Fatal(e)
	}
	if b, _ := os.ReadFile(index + ".lock"); string(b) != "new git writer" {
		t.Fatal("replacement Git lock deleted")
	}
	if e := os.Remove(index + ".lock"); e != nil {
		t.Fatal(e)
	}
	// Detached HEAD is mirrored without deleting the previously active branch.
	detached := desired
	detached.Branch = ""
	if e := applyLocalGitState(ctx, m, desired, detached); e != nil {
		t.Fatal(e)
	}
	if got, e := readLocalGitState(ctx, m); e != nil || got != detached {
		t.Fatal("detached HEAD not mirrored", e)
	}
	sub := filepath.Join(m.LocalPath, "child")
	_ = os.Mkdir(sub, 0700)
	if owns, e := localGitRepository(ctx, sub); e != nil || owns {
		t.Fatal("nested folder claimed parent Git", e)
	}
}

func TestReadOnlyHandbackStillChecksGitState(t *testing.T) {
	m := isolateSyncRecovery(t)
	remoteLeaseContext = func(context.Context, *Mapping, string, string, string) (map[string]any, error) {
		return map[string]any{"ok": true, "lease": map[string]any{"id": "read-only-run", "epoch": m.BindingEpoch, "owner": "sync-needed"}}, nil
	}
	called := false
	synchronizeProjectContext = func(_ context.Context, actual *Mapping, pause bool) error {
		if actual.ServerPath != m.ServerPath || pause {
			t.Fatal("wrong handback mapping or pause")
		}
		called = true
		return nil
	}
	result := synchronizationRPCContext(context.Background(), m, map[string]any{"op": "sync_end", "runId": "read-only-run", "changed": false})
	if result["ok"] != true || !called {
		t.Fatalf("read-only hint skipped Git synchronization: %v", result)
	}
	cloudReservations.Delete(m.ServerPath)
}
