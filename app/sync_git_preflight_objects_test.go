package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

// Exercise the production ordering with two separate object databases, replacing
// only SSH transport with local file transport and the same embedded worker.
func syncGitPreflightFixture(t *testing.T) (*syncSeedTestTools, *Mapping, *Mapping, syncGitState, syncGitState, string) {
	t.Helper()
	tools, source, base, _ := syncGitHeadFixture(t)
	f1 := tools.gitRun(t, source.LocalPath, "commit-tree", base.Index, "-p", base.Head, "-m", "feature one")
	tools.gitRun(t, source.LocalPath, "update-ref", "refs/heads/feature", f1)
	receiver := *source
	receiver.LocalPath = t.TempDir()
	tools.gitRun(t, receiver.LocalPath, "clone", "--no-hardlinks", source.LocalPath, ".")
	tools.gitRun(t, receiver.LocalPath, "branch", "feature", f1)
	syncSeedWrite(t, source.LocalPath, "feature two.txt", "new immutable objects\n")
	tools.gitRun(t, source.LocalPath, "add", "feature two.txt")
	tree := tools.gitRun(t, source.LocalPath, "write-tree")
	f2 := tools.gitRun(t, source.LocalPath, "commit-tree", tree, "-p", f1, "-m", "feature two")
	tools.gitRun(t, source.LocalPath, "update-ref", "refs/heads/feature", f2, f1)
	tools.gitRun(t, source.LocalPath, "symbolic-ref", "HEAD", "refs/heads/feature")
	desired, err := readLocalGitState(context.Background(), source)
	if err != nil {
		t.Fatal(err)
	}
	before, err := readLocalGitState(context.Background(), &receiver)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := gitOutputContext(context.Background(), receiver.LocalPath, "cat-file", "-e", f2+"^{commit}"); err == nil {
		t.Fatal("receiver fixture already contains F2")
	}
	left, err := os.Stat(filepath.Join(source.LocalPath, ".git", "objects", f1[:2], f1[2:]))
	if err != nil {
		t.Fatal(err)
	}
	right, err := os.Stat(filepath.Join(receiver.LocalPath, ".git", "objects", f1[:2], f1[2:]))
	if err != nil || os.SameFile(left, right) {
		t.Fatal("object databases must not share hardlinked objects", err)
	}
	return tools, source, &receiver, before, desired, f1
}

func syncGitPreflightTransport(t *testing.T, tools *syncSeedTestTools, source, receiver *Mapping, desired syncGitState) *[]string {
	t.Helper()
	previousProvision, previousWorker := provisionSyncGitObjects, runSyncGitPreflightWorker
	events := []string{}
	provisionSyncGitObjects = func(ctx context.Context, m *Mapping, local, remote, actual syncGitState) error {
		if m != source || actual != desired {
			return fmt.Errorf("unexpected fixture transfer")
		}
		events = append(events, "objects")
		ref := "refs/chisa/transfer/preflight-regression"
		if _, err := localGitSnapshot(ctx, source, actual, ref); err != nil {
			return err
		}
		_, err := gitOutputContext(ctx, receiver.LocalPath, "fetch", "--no-tags", "--no-write-fetch-head", "--no-auto-maintenance", source.LocalPath, ref)
		return err
	}
	runSyncGitPreflightWorker = func(_ context.Context, m *Mapping, _ string, input io.Reader) (string, error) {
		if m != source {
			return "", fmt.Errorf("unexpected fixture endpoint")
		}
		events = append(events, "preflight")
		var request map[string]any
		if err := json.NewDecoder(input).Decode(&request); err != nil {
			return "", err
		}
		request["root"] = receiver.LocalPath
		return syncGitWorker(t, tools, request, "")
	}
	t.Cleanup(func() { provisionSyncGitObjects, runSyncGitPreflightWorker = previousProvision, previousWorker })
	return &events
}

func TestSyncGitPreflightProvisionsIndependentObjectDatabase(t *testing.T) {
	tools, source, receiver, before, desired, f1 := syncGitPreflightFixture(t)
	request := map[string]any{"root": receiver.LocalPath, "op": "preflight", "before": before, "desired": desired}
	if _, err := syncGitWorker(t, tools, request, ""); err == nil {
		t.Fatal("missing F2 did not exercise original preflight failure")
	}
	worktree := syncSeedSnapshot(t, receiver.LocalPath, true)
	leftFP := syncGitObservationTestFingerprint(t, source, true)
	rightFP := syncGitObservationTestFingerprint(t, receiver, true)
	events := syncGitPreflightTransport(t, tools, source, receiver, desired)
	if err := preflightSyncGitState(context.Background(), source, desired, before, desired); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(*events, []string{"objects", "preflight"}) {
		t.Fatalf("ancestry ran before object provisioning: %v", *events)
	}
	if syncGitObservationTestFingerprint(t, source, true) != leftFP || syncGitObservationTestFingerprint(t, receiver, true) != rightFP {
		t.Fatal("immutable transfer invalidated endpoint portable metadata proof")
	}
	if tools.gitRun(t, receiver.LocalPath, "rev-parse", "feature") != f1 || syncGitWorkerRead(t, tools, receiver.LocalPath) != before {
		t.Fatal("object provisioning moved user's branch/HEAD/index")
	}
	if err := applyLocalGitState(context.Background(), receiver, before, desired); err != nil {
		t.Fatal(err)
	}
	if actual := syncGitWorkerRead(t, tools, receiver.LocalPath); actual != desired {
		t.Fatalf("preflight/apply failed to converge: %+v", actual)
	}
	if !reflect.DeepEqual(syncSeedSnapshot(t, receiver.LocalPath, true), worktree) {
		t.Fatal("metadata transfer changed worktree bytes")
	}
}

func TestSyncGitPreflightPreservesIndependentTargetAndWorktree(t *testing.T) {
	for _, mode := range []string{"independent-history", "occupied-worktree"} {
		t.Run(mode, func(t *testing.T) {
			tools, source, receiver, before, desired, _ := syncGitPreflightFixture(t)
			wantTip := tools.gitRun(t, receiver.LocalPath, "rev-parse", "feature")
			if mode == "independent-history" {
				wantTip = tools.gitRun(t, receiver.LocalPath, "commit-tree", before.Index, "-p", before.Head, "-m", "receiver independent feature")
				tools.gitRun(t, receiver.LocalPath, "update-ref", "refs/heads/feature", wantTip)
			} else {
				tools.gitRun(t, receiver.LocalPath, "worktree", "add", filepath.Join(t.TempDir(), "occupied"), "feature")
			}
			worktree := syncSeedSnapshot(t, receiver.LocalPath, true)
			syncGitPreflightTransport(t, tools, source, receiver, desired)
			err := preflightSyncGitState(context.Background(), source, desired, before, desired)
			if err == nil || !(strings.Contains(err.Error(), "independent commits") || strings.Contains(err.Error(), "another worktree")) {
				t.Fatalf("unsafe target accepted: %v", err)
			}
			if tools.gitRun(t, receiver.LocalPath, "rev-parse", "feature") != wantTip || !reflect.DeepEqual(syncSeedSnapshot(t, receiver.LocalPath, true), worktree) {
				t.Fatal("rejected preflight changed receiving history/worktree")
			}
		})
	}
}

func TestSyncGitPreflightPreviewUsesReadOnlyAncestry(t *testing.T) {
	tools, source, receiver, before, desired, _ := syncGitPreflightFixture(t)
	events := syncGitPreflightTransport(t, tools, source, receiver, desired)
	left, right := syncSeedSnapshot(t, source.LocalPath, false), syncSeedSnapshot(t, receiver.LocalPath, false)
	ctx := context.WithValue(context.Background(), syncGitPreviewKey{}, true)
	if err := preflightSyncGitState(ctx, source, desired, before, desired); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(*events, []string{"preflight"}) {
		t.Fatalf("preview attempted mutable snapshot/transfer: %v", *events)
	}
	syncGitPreviewUnchanged(t, source.LocalPath, left)
	syncGitPreviewUnchanged(t, receiver.LocalPath, right)
}
