package main

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
	"testing"
)

func TestGitRemoteReadUsesLocalTrackingRefWithoutChangingEitherRepository(t *testing.T) {
	m := isolatePi(t)
	ctx := context.Background()
	git := func(root string, args ...string) string {
		t.Helper()
		out, err := gitOutputContext(ctx, root, args...)
		if err != nil {
			t.Fatal(err)
		}
		return out
	}
	git(m.LocalPath, "init", "-b", "main")
	git(m.LocalPath, "config", "user.name", "QA")
	git(m.LocalPath, "config", "user.email", "qa@localhost")
	tracked := filepath.Join(m.LocalPath, "tracked.txt")
	if err := os.WriteFile(tracked, []byte("base\n"), 0600); err != nil {
		t.Fatal(err)
	}
	git(m.LocalPath, "add", "tracked.txt")
	git(m.LocalPath, "commit", "-m", "base")
	base := git(m.LocalPath, "rev-parse", "HEAD")
	for index := 0; index < 29; index++ {
		git(m.LocalPath, "commit", "--allow-empty", "-m", "local committed history")
	}
	head := git(m.LocalPath, "rev-parse", "HEAD")
	replica := t.TempDir()
	git(replica, "clone", "--no-hardlinks", m.LocalPath, ".")
	git(replica, "update-ref", "refs/remotes/origin/main", base)
	git(m.LocalPath, "remote", "add", "origin", replica)
	git(m.LocalPath, "config", "branch.main.remote", "origin")
	git(m.LocalPath, "config", "branch.main.merge", "refs/heads/main")
	git(m.LocalPath, "update-ref", "refs/remotes/origin/main", head)
	if count := git(replica, "--no-optional-locks", "rev-list", "--left-right", "--count", "@{u}...HEAD"); count != "0\t29" {
		t.Fatalf("counterexample does not match the installed failure: %q", count)
	}
	if err := os.WriteFile(tracked, []byte("staged\n"), 0600); err != nil {
		t.Fatal(err)
	}
	git(m.LocalPath, "add", "tracked.txt")
	if err := os.WriteFile(tracked, []byte("unstaged\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(m.LocalPath, "untracked.txt"), []byte("keep"), 0600); err != nil {
		t.Fatal(err)
	}
	for _, scenario := range []struct {
		name, localHead, upstream string
		ahead, behind             int
	}{
		{"local-up-to-date-replica-29-behind", head, head, 0, 0},
		{"local-ahead", head, base, 29, 0},
		{"local-behind", base, head, 0, 29},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			git(m.LocalPath, "update-ref", "refs/heads/main", scenario.localHead)
			git(m.LocalPath, "update-ref", "refs/remotes/origin/main", scenario.upstream)
			beforeRefs := git(m.LocalPath, "show-ref")
			replicaRefs := git(replica, "show-ref")
			beforeStatus := git(m.LocalPath, "--no-optional-locks", "status", "--porcelain=v1")
			indexPath := filepath.Join(m.LocalPath, ".git", "index")
			beforeIndex, err := os.ReadFile(indexPath)
			if err != nil {
				t.Fatal(err)
			}
			actual, err := readLocalGitRemoteStatus(ctx, m)
			if err != nil || actual == nil || actual.Head != scenario.localHead || actual.Branch != "main" || actual.Ahead != scenario.ahead || actual.Behind != scenario.behind || !actual.HasUpstream || actual.RemoteBranch != "origin/main" {
				t.Fatalf("wrong owning-repository upstream: %+v %v", actual, err)
			}
			afterIndex, err := os.ReadFile(indexPath)
			if err != nil || !bytes.Equal(beforeIndex, afterIndex) || git(m.LocalPath, "show-ref") != beforeRefs || git(replica, "show-ref") != replicaRefs || git(m.LocalPath, "--no-optional-locks", "status", "--porcelain=v1") != beforeStatus {
				t.Fatal("upstream observation changed a repository ref, staged index, or dirty files")
			}
		})
	}
}

func TestGitRemoteReadKeepsUnbornAndDetachedContracts(t *testing.T) {
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
	git("init", "-b", "main")
	git("config", "user.name", "QA")
	git("config", "user.email", "qa@localhost")
	actual, err := readLocalGitRemoteStatus(ctx, m)
	if err != nil || actual.Head != "" || actual.Branch != "main" || actual.HasUpstream || actual.HasRemote {
		t.Fatalf("unborn repository read failed: %+v %v", actual, err)
	}
	git("commit", "--allow-empty", "-m", "initial")
	head := git("rev-parse", "HEAD")
	git("checkout", "--detach", head)
	actual, err = readLocalGitRemoteStatus(ctx, m)
	if err != nil || actual.Head != head || actual.Branch != "HEAD" || actual.HasUpstream {
		t.Fatalf("detached repository read failed: %+v %v", actual, err)
	}
}
