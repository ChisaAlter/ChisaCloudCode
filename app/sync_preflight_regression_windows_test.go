//go:build windows

package main

import (
	"context"
	"encoding/hex"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func syncPreflightFileOnlyRemote(t *testing.T) {
	t.Helper()
	previous := observeSyncGitRemoteMetadata
	observeSyncGitRemoteMetadata = func(context.Context, *Mapping) (syncMetadataObservation, error) {
		return syncMetadataObservation{Git: "isolated-file-only-remote"}, nil
	}
	t.Cleanup(func() { observeSyncGitRemoteMetadata = previous })
}

func TestSyncPreflightSelectedSubdirectoryUsesFileOnlyPlan(t *testing.T) {
	syncGitObservationTestEnvironment(t)
	for _, parentState := range []string{"committed", "unborn"} {
		t.Run(parentState, func(t *testing.T) {
			m := isolatePi(t)
			parent := t.TempDir()
			m.LocalPath = filepath.Join(parent, "selected files")
			syncGitObservationTestWrite(t, filepath.Join(m.LocalPath, "proof.txt"), "selected files\n")
			syncGitObservationTestWrite(t, filepath.Join(parent, "parent-only.txt"), "private parent canary\n")
			syncGitObservationTestGit(t, parent, "init", "-b", "main")
			syncGitObservationTestGit(t, parent, "add", ".")
			if parentState == "committed" {
				syncGitObservationTestGit(t, parent, "commit", "-m", "parent fixture")
				syncGitObservationTestWrite(t, filepath.Join(parent, "parent-only.txt"), "staged parent change\n")
				syncGitObservationTestGit(t, parent, "add", "parent-only.txt")
			}
			syncPreflightFileOnlyRemote(t)
			before := readVPSQARepositorySnapshot(t, filepath.Join(parent, ".git"))
			t.Cleanup(func() {
				if after := readVPSQARepositorySnapshot(t, filepath.Join(parent, ".git")); !reflect.DeepEqual(before, after) {
					t.Error("file-only preflight changed parent Git metadata:", describeVPSQASnapshotChanges(before, after))
				}
			})

			ctx := context.Background()
			plan, err := prepareGitSyncContext(ctx, m)
			if err != nil {
				t.Fatal("selected subdirectory cannot prepare file-only synchronization:", err)
			}
			if plan.git || plan.unborn || plan.localFingerprint == "" || plan.remoteFingerprint == "" {
				t.Fatalf("selected subdirectory inherited parent Git state: %+v", plan)
			}
			syncGitObservationTestWrite(t, filepath.Join(m.LocalPath, "proof.txt"), "ordinary selected-file edit\n")
			if err := plan.verify(ctx, m); err != nil {
				t.Fatal("selected-file edit invalidated file-only plan:", err)
			}
			if err := plan.apply(ctx, m); err != nil {
				t.Fatal(err)
			}
			if err := plan.finish(ctx, m); err != nil {
				t.Fatal(err)
			}
			if _, err := os.Lstat(filepath.Join(m.LocalPath, ".git")); !os.IsNotExist(err) {
				t.Fatalf("file-only preflight created a Git marker: %v", err)
			}
		})
	}
}

func TestSyncPreflightOwnGitMarkerCannotUseFileOnlyPlan(t *testing.T) {
	syncGitObservationTestEnvironment(t)
	for _, marker := range []string{"malformed-file", "malformed-directory", "linked-worktree"} {
		t.Run(marker, func(t *testing.T) {
			m := isolatePi(t)
			parent := t.TempDir()
			m.LocalPath = filepath.Join(parent, "selected files")
			syncGitObservationTestWrite(t, filepath.Join(m.LocalPath, "proof.txt"), "selected files\n")
			syncGitObservationTestGit(t, parent, "init", "-b", "main")
			syncGitObservationTestGit(t, parent, "add", ".")
			syncGitObservationTestGit(t, parent, "commit", "-m", "parent fixture")
			syncPreflightFileOnlyRemote(t)
			ctx := context.Background()
			plan, err := prepareGitSyncContext(ctx, m)
			if err != nil {
				t.Fatal("cannot prepare marker-absence guard:", err)
			}
			switch marker {
			case "malformed-file":
				syncGitObservationTestWrite(t, filepath.Join(m.LocalPath, ".git"), "invalid Git directory pointer\n")
			case "malformed-directory":
				if err := os.Mkdir(filepath.Join(m.LocalPath, ".git"), 0700); err != nil {
					t.Fatal(err)
				}
			case "linked-worktree":
				// Install a real linked-worktree pointer at the selected root;
				// its .git file must never be treated as marker absence.
				linked := filepath.Join(t.TempDir(), "linked worktree")
				syncGitObservationTestGit(t, parent, "worktree", "add", "-b", "linked", linked)
				pointer, err := os.ReadFile(filepath.Join(linked, ".git"))
				if err != nil {
					t.Fatal(err)
				}
				syncGitObservationTestWrite(t, filepath.Join(m.LocalPath, ".git"), string(pointer))
			}
			before := readVPSQARepositorySnapshot(t, filepath.Join(parent, ".git"))
			if err := plan.verify(ctx, m); err == nil {
				t.Error("file-only plan accepted a new project-owned Git marker")
			}
			if next, err := prepareGitSyncContext(ctx, m); err == nil {
				t.Errorf("project-owned Git marker bypassed Git preflight: %+v", next)
			}
			if after := readVPSQARepositorySnapshot(t, filepath.Join(parent, ".git")); !reflect.DeepEqual(before, after) {
				t.Error("rejected Git marker changed parent metadata:", describeVPSQASnapshotChanges(before, after))
			}
		})
	}
}

func TestSyncPreflightSplitIndexKeepsPromisorSkipWorktreeObjects(t *testing.T) {
	syncGitObservationTestEnvironment(t)
	m := isolatePi(t)
	syncGitObservationTestGit(t, m.LocalPath, "init", "-b", "main")
	for name, content := range map[string]string{"kept.txt": "base\n", "omitted.txt": "intentionally absent promisor blob\n"} {
		syncGitObservationTestWrite(t, filepath.Join(m.LocalPath, name), content)
	}
	syncGitObservationTestGit(t, m.LocalPath, "add", ".")
	syncGitObservationTestGit(t, m.LocalPath, "commit", "-m", "partial fixture")
	oid := syncGitObservationTestGit(t, m.LocalPath, "rev-parse", ":omitted.txt")
	syncGitObservationTestGit(t, m.LocalPath, "update-index", "--skip-worktree", "omitted.txt")
	syncGitObservationTestGit(t, m.LocalPath, "config", "remote.fixture.promisor", "true")
	// Removing this owned loose object models a filtered clone without any
	// network endpoint. Git permits missing skip-worktree blobs for promisors.
	if err := os.Remove(filepath.Join(m.LocalPath, ".git", "objects", oid[:2], oid[2:])); err != nil {
		t.Fatal(err)
	}
	syncGitObservationTestWrite(t, filepath.Join(m.LocalPath, "kept.txt"), "staged change invalidates cache tree\n")
	syncGitObservationTestGit(t, m.LocalPath, "add", "kept.txt")
	syncGitObservationTestGit(t, m.LocalPath, "update-index", "--split-index")
	syncGitObservationTestGit(t, m.LocalPath, "update-index", "--cacheinfo", "100644,"+syncGitObservationTestGit(t, m.LocalPath, "rev-parse", ":kept.txt")+",kept.txt")
	// Explicit false must not grant the promisor missing-object exemption.
	syncGitObservationTestGit(t, m.LocalPath, "config", "remote.fixture.promisor", "false")
	if _, err := readLocalGitState(context.Background(), m); err == nil {
		t.Fatal("false promisor configuration accepted a missing index blob")
	}
	syncGitObservationTestGit(t, m.LocalPath, "config", "remote.fixture.promisor", "true")
	if _, err := readLocalGitState(context.Background(), m); err != nil {
		t.Fatal("split-index observation lost promisor recognition:", err)
	}
}

func TestSyncPreflightSplitIndexObservationDoesNotInvalidateFingerprint(t *testing.T) {
	syncGitObservationTestEnvironment(t)
	m := isolatePi(t)
	syncGitObservationTestGit(t, m.LocalPath, "init", "-b", "main")
	syncGitObservationTestWrite(t, filepath.Join(m.LocalPath, "tracked.txt"), "base\n")
	syncGitObservationTestGit(t, m.LocalPath, "add", ".")
	syncGitObservationTestGit(t, m.LocalPath, "commit", "-m", "base")
	syncGitObservationTestWrite(t, filepath.Join(m.LocalPath, "tracked.txt"), "staged\n")
	syncGitObservationTestGit(t, m.LocalPath, "add", "tracked.txt")
	// Hash the expected tree without writing it. Native observation must leave
	// its generated tree available to apply after the disposable Git dir is gone.
	blob, err := hex.DecodeString(syncGitObservationTestGit(t, m.LocalPath, "rev-parse", ":tracked.txt"))
	if err != nil {
		t.Fatal(err)
	}
	wantTree, err := gitOutputContextEnvInput(context.Background(), m.LocalPath, nil,
		append([]byte("100644 tracked.txt\x00"), blob...), "hash-object", "-t", "tree", "--stdin")
	if err != nil {
		t.Fatal(err)
	}
	want := syncGitState{
		Head:   syncGitObservationTestGit(t, m.LocalPath, "rev-parse", "HEAD"),
		Branch: "refs/heads/main",
		Index:  wantTree,
	}
	syncGitObservationTestGit(t, m.LocalPath, "update-index", "--split-index")
	shared, err := filepath.Glob(filepath.Join(m.LocalPath, ".git", "sharedindex.*"))
	if err != nil || len(shared) == 0 {
		t.Fatalf("split-index fixture has no shared base: %v %v", shared, err)
	}
	// Create the normal native guard before observing. This isolates the split
	// base freshening from one-time guard creation or an actual Git writer.
	_, guard, err := gitIndexGuard(context.Background(), m)
	if err != nil {
		t.Fatal(err)
	}
	if err := guard.Close(); err != nil {
		t.Fatal(err)
	}
	for attempt := 1; attempt <= 2; attempt++ {
		before := syncGitObservationTestFingerprint(t, m, true)
		bases := make(map[string]syncGitMetadataFile)
		for _, name := range append(shared, filepath.Join(m.LocalPath, ".git", "index")) {
			record, err := readSyncGitMetadataFile(name, false, syncGitMetadataBytes)
			if err != nil {
				t.Fatal(err)
			}
			bases[name] = record
		}
		state, err := readLocalGitState(context.Background(), m)
		if err != nil || state != want {
			t.Fatalf("native split-index read %d: got %+v, %v; want %+v", attempt, state, err, want)
		}
		if after := syncGitObservationTestFingerprint(t, m, true); after != before {
			t.Errorf("native read %d invalidated its own metadata fingerprint", attempt)
		}
		for name, previous := range bases {
			current, err := readSyncGitMetadataFile(name, false, syncGitMetadataBytes)
			if err != nil || current.stamp != previous.stamp || current.digest != previous.digest {
				t.Errorf("native read %d changed %s: before=%+v after=%+v err=%v", attempt, filepath.Base(name), previous.stamp, current.stamp, err)
			}
		}
	}
	if kind := syncGitObservationTestGit(t, m.LocalPath, "cat-file", "-t", want.Index); kind != "tree" {
		t.Fatalf("native observation discarded its portable index tree: %q", kind)
	}
}
