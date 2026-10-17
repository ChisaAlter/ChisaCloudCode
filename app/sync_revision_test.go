package main

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestGitSyncPreservesIndependentTargetAndOtherWorktree(t *testing.T) {
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
	git("config", "core.autocrlf", "false")
	write("file.txt", "base\n")
	git("add", ".")
	git("commit", "-m", "base")
	base := git("rev-parse", "HEAD")
	git("checkout", "-b", "feature")
	write("file.txt", "independent local feature\n")
	git("commit", "-am", "local feature")
	independent := git("rev-parse", "HEAD")
	git("checkout", "-b", "cloud-proposal", base)
	write("file.txt", "different cloud feature\n")
	git("commit", "-am", "cloud feature")
	desired, err := readLocalGitState(ctx, m)
	if err != nil {
		t.Fatal(err)
	}
	desired.Branch = "refs/heads/feature"
	git("checkout", "main")
	write("staged.txt", "keep staged\n")
	git("add", "staged.txt")
	write("untracked.txt", "keep untracked\n")
	before, err := readLocalGitState(ctx, m)
	if err != nil {
		t.Fatal(err)
	}
	status := git("status", "--porcelain=v1", "--untracked-files=all")
	assertPreserved := func(tip string) {
		t.Helper()
		actual, err := readLocalGitState(ctx, m)
		if err != nil || actual != before {
			t.Fatalf("active Git state changed: %+v, %v", actual, err)
		}
		if got := git("rev-parse", "refs/heads/feature"); got != tip {
			t.Fatalf("target branch moved from %s to %s", tip, got)
		}
		if got := git("status", "--porcelain=v1", "--untracked-files=all"); got != status {
			t.Fatalf("index or untracked status changed: %q -> %q", status, got)
		}
		for name, want := range map[string]string{"file.txt": "base\n", "staged.txt": "keep staged\n", "untracked.txt": "keep untracked\n"} {
			body, err := os.ReadFile(filepath.Join(m.LocalPath, name))
			if err != nil || string(body) != want {
				t.Fatalf("worktree file %s changed: %q, %v", name, body, err)
			}
		}
	}
	if err := applyLocalGitState(ctx, m, before, desired); err == nil || !strings.Contains(err.Error(), "独立提交") {
		t.Fatalf("independent target history was not rejected: %v", err)
	}
	assertPreserved(independent)

	// Even an equal target tip cannot be checked out by this replica when it is
	// already in use by another worktree of the same repository.
	git("branch", "-f", "feature", desired.Head)
	other := filepath.Join(t.TempDir(), "other-worktree")
	git("worktree", "add", other, "feature")
	if err := applyLocalGitState(ctx, m, before, desired); err == nil || !strings.Contains(err.Error(), "其他工作树") {
		t.Fatalf("occupied target branch was not rejected: %v", err)
	}
	assertPreserved(desired.Head)
	if body, err := os.ReadFile(filepath.Join(other, "file.txt")); err != nil || string(body) != "different cloud feature\n" {
		t.Fatalf("other worktree changed: %q, %v", body, err)
	}
	git("worktree", "remove", other)

	// A fast-forward of an inactive branch retains its history and remains usable.
	git("branch", "-f", "feature", base)
	if err := applyLocalGitState(ctx, m, before, desired); err != nil {
		t.Fatalf("safe target fast-forward was rejected: %v", err)
	}
	if actual, err := readLocalGitState(ctx, m); err != nil || actual != desired {
		t.Fatalf("safe target did not receive metadata: %+v, %v", actual, err)
	}
	if body, err := os.ReadFile(filepath.Join(m.LocalPath, "untracked.txt")); err != nil || string(body) != "keep untracked\n" {
		t.Fatalf("safe metadata transition overwrote untracked content: %q, %v", body, err)
	}
}

func TestRecoveryTransportBlocksNewSyncButAllowsExactHandback(t *testing.T) {
	m := isolateSyncRecovery(t)
	t.Cleanup(func() { cloudReservations.Delete(m.ServerPath) })
	apiConnection.workspaceRecoveryOnly = true
	if _, cancel, err := bindWorkspaceSyncConnection(context.Background()); err == nil {
		cancel()
		t.Fatal("normal synchronization admitted through a recovery-only transport")
	}
	ctx, cancel, err := bindWorkspaceSyncConnection(context.WithValue(context.Background(), workspaceRecoveryContextKey{}, true))
	if err != nil {
		t.Fatalf("exact recovery could not use its transport: %v", err)
	}
	defer cancel()
	if err := workspaceSyncCurrent(ctx); err != nil {
		t.Fatal(err)
	}
	remoteLeaseContext = func(context.Context, *Mapping, string, string, string) (map[string]any, error) {
		return map[string]any{"ok": true, "lease": map[string]any{"id": "old-run", "epoch": m.BindingEpoch, "owner": "sync-needed"}}, nil
	}
	called := false
	synchronizeProjectContext = func(context.Context, *Mapping, bool) error { called = true; return nil }
	if got := synchronizationRPCContext(context.Background(), m, map[string]any{"op": "sync_begin", "runId": "old-run"}); got["ok"] == true || called {
		t.Fatalf("new task synchronization admitted during recovery: %v", got)
	}
	if got := synchronizationRPCContext(context.Background(), m, map[string]any{"op": "sync_end", "runId": "old-run"}); got["ok"] != true || !called {
		t.Fatalf("existing exact-owner handback was blocked: %v", got)
	}
}
