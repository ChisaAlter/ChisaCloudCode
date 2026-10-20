//go:build windows

package main

import (
	"bytes"
	"context"
	"errors"
	"os"
	"reflect"
	"strings"
	"testing"
)

type syncGitRecoveryFixture struct {
	tools   *syncSeedTestTools
	mapping *Mapping
	replica *Mapping
	base    syncGitState
}

func newSyncGitRecoveryFixture(t *testing.T) *syncGitRecoveryFixture {
	t.Helper()
	m := isolateSyncRecovery(t)
	syncGitObservationTestEnvironment(t)
	tools := syncSeedTools(t)
	// Native observations and the real Git subprocesses share an isolated config.
	for _, entry := range tools.env {
		key, value, _ := strings.Cut(entry, "=")
		if strings.HasPrefix(key, "GIT_") {
			t.Setenv(key, value)
		}
	}
	tools.gitRun(t, m.LocalPath, "init", "-b", "main")
	tools.gitRun(t, m.LocalPath, "config", "core.autocrlf", "false")
	syncSeedWrite(t, m.LocalPath, "tracked.txt", "base\n")
	tools.gitRun(t, m.LocalPath, "add", ".")
	tools.gitRun(t, m.LocalPath, "commit", "-m", "base")
	base := syncGitRecoveryRead(t, m)
	tools.gitRun(t, m.LocalPath, "checkout", "-b", "local-side")
	replica := *m
	replica.LocalPath = t.TempDir()
	tools.gitRun(t, replica.LocalPath, "clone", "--no-hardlinks", m.LocalPath, ".")
	tools.gitRun(t, replica.LocalPath, "config", "core.autocrlf", "false")
	tools.gitRun(t, replica.LocalPath, "checkout", "-b", "remote-side")
	return &syncGitRecoveryFixture{tools: tools, mapping: m, replica: &replica, base: base}
}

func syncGitRecoveryRead(t *testing.T, m *Mapping) syncGitState {
	t.Helper()
	ctx := context.WithValue(context.Background(), syncGitPreviewKey{}, true)
	state, err := readLocalGitState(ctx, m)
	if err != nil {
		t.Fatal(err)
	}
	return state
}

func (f *syncGitRecoveryFixture) states(t *testing.T) (syncGitState, syncGitState) {
	t.Helper()
	return syncGitRecoveryRead(t, f.mapping), syncGitRecoveryRead(t, f.replica)
}

func (f *syncGitRecoveryFixture) endpoints(source string) (chosen, receiver *Mapping) {
	if source == "remote" {
		return f.replica, f.mapping
	}
	return f.mapping, f.replica
}

func (f *syncGitRecoveryFixture) beginMerge(t *testing.T, m *Mapping) {
	t.Helper()
	// A real, uncommitted merge with an unchanged tree isolates operation safety
	// from independent staged changes. Git writes MERGE_HEAD and ORIG_HEAD itself.
	tree := f.tools.gitRun(t, m.LocalPath, "rev-parse", "HEAD^{tree}")
	head := f.tools.gitRun(t, m.LocalPath, "rev-parse", "HEAD")
	commit := f.tools.gitRun(t, m.LocalPath, "commit-tree", tree, "-p", head, "-m", "merge candidate")
	f.tools.gitRun(t, m.LocalPath, "branch", "merge-candidate", commit)
	f.tools.gitRun(t, m.LocalPath, "merge", "--no-ff", "--no-commit", "merge-candidate")
}

func syncGitRecoveryExpectUnchanged(t *testing.T, root string, before map[string]string) {
	t.Helper()
	if after := syncSeedSnapshot(t, root, false); !reflect.DeepEqual(after, before) {
		t.Fatalf("recovery selection changed repository or worktree files in %s", root)
	}
}

func TestSyncGitRecoverySameCommitBranchesRequireSource(t *testing.T) {
	f := newSyncGitRecoveryFixture(t)
	local, remote := f.states(t)
	if local.Head != remote.Head || local.Index != remote.Index || local.Branch == remote.Branch || local.Operations != remote.Operations {
		t.Fatalf("fixture must differ only by branch: local=%+v remote=%+v", local, remote)
	}
	checkpoint, err := loadGitCheckpoint(f.mapping)
	if err != nil {
		t.Fatal(err)
	}
	localFiles, remoteFiles := syncSeedSnapshot(t, f.mapping.LocalPath, false), syncSeedSnapshot(t, f.replica.LocalPath, false)
	_, err = selectGitState(context.Background(), f.mapping, checkpoint, local, remote)
	var direction *syncGitDirectionError
	if !errors.As(err, &direction) {
		t.Fatalf("same commit on different branches did not require a source: %v", err)
	}
	for _, source := range []string{"local", "remote"} {
		ctx := context.WithValue(context.Background(), syncGitSourceKey{}, source)
		chosen, err := selectGitState(ctx, f.mapping, checkpoint, local, remote)
		want := local
		if source == "remote" {
			want = remote
		}
		if err != nil || chosen != want {
			t.Fatalf("source %s selected %+v, want %+v: %v", source, chosen, want, err)
		}
	}
	for _, source := range []string{"LOCAL", "auto", " local "} {
		ctx := context.WithValue(context.Background(), syncGitSourceKey{}, source)
		for _, other := range []syncGitState{remote, local} {
			if _, err := selectGitState(ctx, f.mapping, checkpoint, local, other); err == nil || !strings.Contains(err.Error(), "无效的 Git 状态来源") {
				t.Fatalf("invalid source %q was not rejected before state selection: %v", source, err)
			}
		}
	}
	syncGitRecoveryExpectUnchanged(t, f.mapping.LocalPath, localFiles)
	syncGitRecoveryExpectUnchanged(t, f.replica.LocalPath, remoteFiles)
	if _, err := os.Stat(syncGitCheckpointPath(f.mapping)); !os.IsNotExist(err) {
		t.Fatalf("direction selection unexpectedly persisted a checkpoint: %v", err)
	}
}

func TestSyncGitRecoveryRejectsIndependentReceiverState(t *testing.T) {
	for _, source := range []string{"local", "remote"} {
		for _, mutation := range []string{"staged", "merge"} {
			t.Run(source+"/"+mutation, func(t *testing.T) {
				f := newSyncGitRecoveryFixture(t)
				chosen, receiver := f.endpoints(source)
				if mutation == "staged" {
					syncSeedWrite(t, receiver.LocalPath, "receiver staged.txt", "independent stage\n")
					f.tools.gitRun(t, receiver.LocalPath, "add", "receiver staged.txt")
				} else {
					f.beginMerge(t, receiver)
				}
				syncSeedWrite(t, receiver.LocalPath, "tracked.txt", "receiver unstaged\n")
				syncSeedWrite(t, receiver.LocalPath, "receiver untracked.txt", "keep receiver\n")
				syncSeedWrite(t, chosen.LocalPath, "chosen untracked.txt", "keep chosen\n")
				local, remote := f.states(t)
				receiverState := syncGitRecoveryRead(t, receiver)
				if mutation == "merge" && (receiverState.Index != f.base.Index || gitOnlyInertOperations(receiverState.Operations)) {
					t.Fatalf("merge fixture did not isolate an active operation: %+v", receiverState)
				}
				if mutation == "staged" && receiverState.Index == f.base.Index {
					t.Fatal("receiver fixture did not contain an independent staged tree")
				}
				checkpoint, err := loadGitCheckpoint(f.mapping)
				if err != nil {
					t.Fatal(err)
				}
				localFiles, remoteFiles := syncSeedSnapshot(t, f.mapping.LocalPath, false), syncSeedSnapshot(t, f.replica.LocalPath, false)
				ctx := context.WithValue(context.Background(), syncGitSourceKey{}, source)
				if _, err := selectGitState(ctx, f.mapping, checkpoint, local, remote); err == nil || !strings.Contains(err.Error(), "接收端存在独立暂存修改或 Git 操作") {
					t.Fatalf("source %s overwrote receiver %s: %v", source, mutation, err)
				}
				syncGitRecoveryExpectUnchanged(t, f.mapping.LocalPath, localFiles)
				syncGitRecoveryExpectUnchanged(t, f.replica.LocalPath, remoteFiles)
				if actualLocal, actualRemote := f.states(t); actualLocal != local || actualRemote != remote {
					t.Fatal("rejected recovery changed an endpoint's observed Git state")
				}
			})
		}
	}
}

func TestSyncGitRecoveryDurableBaselineAndPendingTakePrecedence(t *testing.T) {
	f := newSyncGitRecoveryFixture(t)
	local, remote := f.states(t)
	for _, source := range []string{"local", "remote"} {
		t.Run("baseline/"+source, func(t *testing.T) {
			checkpoint, err := loadGitCheckpoint(f.mapping)
			if err != nil {
				t.Fatal(err)
			}
			checkpoint.State, checkpoint.Pending = local, nil
			want := remote
			if source == "remote" {
				checkpoint.State, want = remote, local
			}
			if err := saveGitCheckpoint(f.mapping, checkpoint); err != nil {
				t.Fatal(err)
			}
			restarted, err := loadGitCheckpoint(f.mapping)
			if err != nil {
				t.Fatal(err)
			}
			ctx := context.WithValue(context.Background(), syncGitSourceKey{}, source)
			if got, err := selectGitState(ctx, f.mapping, restarted, local, remote); err != nil || got != want {
				t.Fatalf("explicit source %s reversed a durable baseline: got=%+v want=%+v err=%v", source, got, want, err)
			}
		})
		t.Run("pending/"+source, func(t *testing.T) {
			checkpoint, err := loadGitCheckpoint(f.mapping)
			if err != nil {
				t.Fatal(err)
			}
			// Both sides changed from main. Only the persisted Pending can choose.
			want := remote
			if source == "remote" {
				want = local
			}
			checkpoint.Version, checkpoint.State = 2, f.base
			checkpoint.Pending = &syncGitPending{Local: local, Remote: remote, Desired: want}
			if err := saveGitCheckpoint(f.mapping, checkpoint); err != nil {
				t.Fatal(err)
			}
			restarted, err := loadGitCheckpoint(f.mapping)
			if err != nil {
				t.Fatal(err)
			}
			for _, ctx := range []context.Context{context.Background(), context.WithValue(context.Background(), syncGitSourceKey{}, source)} {
				if got, err := selectGitState(ctx, f.mapping, restarted, local, remote); err != nil || got != want {
					t.Fatalf("source %s replaced the durable Pending choice: got=%+v want=%+v err=%v", source, got, want, err)
				}
			}
		})
	}
	checkpoint, err := loadGitCheckpoint(f.mapping)
	if err != nil {
		t.Fatal(err)
	}
	checkpoint.State, checkpoint.Pending = f.base, nil
	if err := saveGitCheckpoint(f.mapping, checkpoint); err != nil {
		t.Fatal(err)
	}
	for _, source := range []string{"local", "remote"} {
		ctx := context.WithValue(context.Background(), syncGitSourceKey{}, source)
		if _, err := selectGitState(ctx, f.mapping, checkpoint, local, remote); err == nil || !strings.Contains(err.Error(), "两端在上次同步后都更改") {
			t.Fatalf("source %s bypassed independent changes from a baseline: %v", source, err)
		}
	}
}

func syncGitRecoveryPreparedPlan(t *testing.T, source string, withOperation bool) (*syncGitRecoveryFixture, *syncGitPlan, context.Context) {
	t.Helper()
	f := newSyncGitRecoveryFixture(t)
	chosen, receiver := f.endpoints(source)
	syncSeedWrite(t, chosen.LocalPath, "chosen committed.txt", "chosen commit\n")
	f.tools.gitRun(t, chosen.LocalPath, "add", "chosen committed.txt")
	f.tools.gitRun(t, chosen.LocalPath, "commit", "-m", "chosen commit")
	if withOperation {
		f.beginMerge(t, chosen)
	}
	syncSeedWrite(t, chosen.LocalPath, "chosen stage.bin", "\x00chosen staged\xff\n")
	f.tools.gitRun(t, chosen.LocalPath, "add", "chosen stage.bin")
	syncSeedWrite(t, chosen.LocalPath, "tracked.txt", "chosen unstaged\n")
	syncSeedWrite(t, receiver.LocalPath, "receiver untracked.txt", "receiver worktree\n")
	// The execution plan materializes new index trees in each real object store.
	// Read-only previews intentionally discard those trees after observation.
	local, err := readLocalGitState(context.Background(), f.mapping)
	if err != nil {
		t.Fatal(err)
	}
	remote, err := readLocalGitState(context.Background(), f.replica)
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.WithValue(context.Background(), syncGitSourceKey{}, source)
	checkpoint, err := loadGitCheckpoint(f.mapping)
	if err != nil {
		t.Fatal(err)
	}
	desired, err := selectGitState(ctx, f.mapping, checkpoint, local, remote)
	if err != nil {
		t.Fatal(err)
	}
	// Transfer the real index/operation objects before capturing metadata proofs.
	// Actual Git application below can then resume without an SSH transport.
	syncGitTransferForTest(t, f.tools, chosen, receiver.LocalPath, desired)
	p := &syncGitPlan{
		mapping: *f.mapping, key: syncGitObservationKey(ctx, f.mapping), checkpoint: checkpoint,
		git: true, local: local, remote: remote, desired: desired,
		localFingerprint:  syncGitObservationTestFingerprint(t, f.mapping, true),
		remoteFingerprint: syncGitObservationTestFingerprint(t, f.replica, true),
	}
	previousObserver := observeSyncGitRemoteMetadata
	observeSyncGitRemoteMetadata = func(_ context.Context, actual *Mapping) (syncMetadataObservation, error) {
		if *actual != *f.mapping {
			t.Fatal("recovery verification observed a different project binding")
		}
		token, repository, err := localSyncMetadataFingerprint(f.replica)
		return syncMetadataObservation{Git: token, Repository: repository}, err
	}
	t.Cleanup(func() { observeSyncGitRemoteMetadata = previousObserver })
	preview := *p
	preview.desired = syncGitState{}
	consent := &syncGitRecoveryConsent{plan: &preview}
	ctx = context.WithValue(ctx, syncGitRecoveryKey{}, consent)
	return f, p, ctx
}

func TestSyncGitRecoveryIntentPersistsBeforeFlushAndResumesWithoutSource(t *testing.T) {
	for _, source := range []string{"local", "remote"} {
		t.Run(source, func(t *testing.T) {
			f, plan, ctx := syncGitRecoveryPreparedPlan(t, source, true)
			original := *plan.checkpoint
			localFiles, remoteFiles := syncSeedSnapshot(t, f.mapping.LocalPath, false), syncSeedSnapshot(t, f.replica.LocalPath, false)
			if err := plan.persistRecoveryIntent(ctx, f.mapping); err != nil {
				t.Fatal(err)
			}
			// This is the pre-flush boundary: no worktree flush or Git apply has run.
			// Reopen the disk record, rather than trusting the plan's in-memory copy.
			restartedMapping := *f.mapping
			restarted, err := loadGitCheckpoint(&restartedMapping)
			if err != nil {
				t.Fatal(err)
			}
			want := original
			want.Version = 2
			want.Pending = &syncGitPending{Local: plan.local, Remote: plan.remote, Desired: plan.desired}
			if !reflect.DeepEqual(restarted, &want) || !reflect.DeepEqual(plan.checkpoint, &want) {
				t.Fatalf("pre-flush checkpoint lost the exact bound plan: disk=%+v plan=%+v want=%+v", restarted, plan.checkpoint, want)
			}
			if restarted.Pending.Desired.Operations == "" || restarted.Pending.Desired.Index == f.base.Index || restarted.Pending.Desired.Head == f.base.Head {
				t.Fatal("persisted fixture did not exercise exact commit, index and operation state")
			}
			syncGitRecoveryExpectUnchanged(t, f.mapping.LocalPath, localFiles)
			syncGitRecoveryExpectUnchanged(t, f.replica.LocalPath, remoteFiles)
			checkpointBytes, err := os.ReadFile(syncGitCheckpointPath(f.mapping))
			if err != nil {
				t.Fatal(err)
			}
			desired := restarted.Pending.Desired
			resume := func() {
				t.Helper()
				local, remote := f.states(t)
				if got, err := selectGitState(context.Background(), &restartedMapping, restarted, local, remote); err != nil || got != desired {
					t.Fatalf("restart without a source failed to resume: got=%+v want=%+v err=%v", got, desired, err)
				}
			}
			resume()
			_, receiver := f.endpoints(source)
			worktree := syncSeedSnapshot(t, receiver.LocalPath, true)
			// Interrupt after the ref/HEAD transition, then after index installation.
			// Each observed state comes from a real repository, not a synthetic tuple.
			f.tools.gitRun(t, receiver.LocalPath, "update-ref", desired.Branch, desired.Head)
			f.tools.gitRun(t, receiver.LocalPath, "symbolic-ref", "HEAD", desired.Branch)
			partial := syncGitRecoveryRead(t, receiver)
			if partial.Head != desired.Head || partial.Branch != desired.Branch || partial.Index == desired.Index || partial.Operations == desired.Operations {
				t.Fatalf("HEAD-only interruption was not a partial transition: %+v", partial)
			}
			resume()
			f.tools.gitRun(t, receiver.LocalPath, "read-tree", desired.Index)
			partial = syncGitRecoveryRead(t, receiver)
			if partial.Index != desired.Index || partial.Operations == desired.Operations {
				t.Fatalf("index interruption did not precede operation installation: %+v", partial)
			}
			resume()
			if err := applyLocalGitState(context.Background(), receiver, partial, desired); err != nil {
				t.Fatal(err)
			}
			local, remote := f.states(t)
			if local != desired || remote != desired {
				t.Fatalf("resumed Git application did not converge: local=%+v remote=%+v want=%+v", local, remote, desired)
			}
			resume()
			if actual := syncSeedSnapshot(t, receiver.LocalPath, true); !reflect.DeepEqual(actual, worktree) {
				t.Fatal("resuming Git metadata changed receiver worktree contents")
			}
			if actual, err := os.ReadFile(syncGitCheckpointPath(f.mapping)); err != nil || !bytes.Equal(actual, checkpointBytes) {
				t.Fatalf("resumption silently replaced the persisted recovery intent: %v", err)
			}
			if err := finishGitCheckpoint(&restartedMapping, restarted, desired); err != nil {
				t.Fatal(err)
			}
			finished, err := loadGitCheckpoint(&restartedMapping)
			if err != nil || finished.Pending != nil || finished.State != desired || finished.Version != 2 {
				t.Fatalf("completed recovery did not save its exact baseline: %+v %v", finished, err)
			}
		})
	}
}

func TestSyncGitRecoveryPersistedIntentRejectsNewGitChanges(t *testing.T) {
	for _, endpoint := range []string{"local", "remote"} {
		for _, mutation := range []string{"commit", "staged", "operation", "inert-operation"} {
			t.Run(endpoint+"/"+mutation, func(t *testing.T) {
				f, plan, ctx := syncGitRecoveryPreparedPlan(t, "local", false)
				if err := plan.persistRecoveryIntent(ctx, f.mapping); err != nil {
					t.Fatal(err)
				}
				changed := f.mapping
				if endpoint == "remote" {
					changed = f.replica
				}
				switch mutation {
				case "commit":
					syncSeedWrite(t, changed.LocalPath, "new commit.txt", "new commit after recovery consent\n")
					f.tools.gitRun(t, changed.LocalPath, "add", "new commit.txt")
					f.tools.gitRun(t, changed.LocalPath, "commit", "-m", "independent commit after consent")
				case "staged":
					syncSeedWrite(t, changed.LocalPath, "new stage.txt", "new stage after recovery consent\n")
					f.tools.gitRun(t, changed.LocalPath, "add", "new stage.txt")
				case "operation":
					// Write the same real Git pseudoref that starts a cherry-pick,
					// while leaving HEAD, branch and index exactly as recorded.
					f.tools.gitRun(t, changed.LocalPath, "update-ref", "CHERRY_PICK_HEAD", f.base.Head)
				case "inert-operation":
					// Version 2 must be exact even for ORIG_HEAD; the legacy
					// checkpoint exemption cannot swallow this post-consent change.
					f.tools.gitRun(t, changed.LocalPath, "update-ref", "ORIG_HEAD", f.base.Head)
				}
				restarted, err := loadGitCheckpoint(f.mapping)
				if err != nil {
					t.Fatal(err)
				}
				checkpointBytes, err := os.ReadFile(syncGitCheckpointPath(f.mapping))
				if err != nil {
					t.Fatal(err)
				}
				local, remote := f.states(t)
				localFiles, remoteFiles := syncSeedSnapshot(t, f.mapping.LocalPath, false), syncSeedSnapshot(t, f.replica.LocalPath, false)
				for _, restartCtx := range []context.Context{context.Background(), context.WithValue(context.Background(), syncGitSourceKey{}, "remote")} {
					if _, err := selectGitState(restartCtx, f.mapping, restarted, local, remote); err == nil || !strings.Contains(err.Error(), "上次 Git 同步未完成后又有新修改") {
						t.Fatalf("restart accepted independent %s %s: %v", endpoint, mutation, err)
					}
				}
				syncGitRecoveryExpectUnchanged(t, f.mapping.LocalPath, localFiles)
				syncGitRecoveryExpectUnchanged(t, f.replica.LocalPath, remoteFiles)
				if actual, err := os.ReadFile(syncGitCheckpointPath(f.mapping)); err != nil || !bytes.Equal(actual, checkpointBytes) {
					t.Fatalf("rejecting new Git state changed the persisted choice: %v", err)
				}
			})
		}
	}
}

func TestSyncGitRecoveryStalePlanDoesNotPersistIntent(t *testing.T) {
	for _, endpoint := range []string{"local", "remote"} {
		t.Run(endpoint, func(t *testing.T) {
			f, plan, ctx := syncGitRecoveryPreparedPlan(t, "local", false)
			changed := f.mapping
			if endpoint == "remote" {
				changed = f.replica
			}
			syncSeedWrite(t, changed.LocalPath, "changed before flush.txt", "independent staged state\n")
			f.tools.gitRun(t, changed.LocalPath, "add", "changed before flush.txt")
			localFiles, remoteFiles := syncSeedSnapshot(t, f.mapping.LocalPath, false), syncSeedSnapshot(t, f.replica.LocalPath, false)
			if err := plan.persistRecoveryIntent(ctx, f.mapping); err == nil || !strings.Contains(err.Error(), "文件同步期间 Git 状态发生改变") {
				t.Fatalf("changed %s metadata was persisted as the earlier consent: %v", endpoint, err)
			}
			if _, err := os.Stat(syncGitCheckpointPath(f.mapping)); !os.IsNotExist(err) {
				t.Fatalf("stale recovery created a durable intent: %v", err)
			}
			if plan.checkpoint.Pending != nil {
				t.Fatal("stale recovery changed the in-memory checkpoint")
			}
			syncGitRecoveryExpectUnchanged(t, f.mapping.LocalPath, localFiles)
			syncGitRecoveryExpectUnchanged(t, f.replica.LocalPath, remoteFiles)
		})
	}
}
