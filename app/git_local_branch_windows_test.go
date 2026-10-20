package main

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"testing"
	"time"
)

type localBranchFixture struct {
	m                    *Mapping
	git                  func(...string) string
	lease                map[string]any
	events               []string
	syncs                int
	syncHook             func(context.Context, int) error
	failRelease          bool
	failPause            bool
	failAlign            bool
	cleanupAfterCanceled bool
}

func localBranchTestFixture(t *testing.T) *localBranchFixture {
	t.Helper()
	m, git := localGitReadFixture(t)
	f := &localBranchFixture{m: m, git: git}
	previousRemote := localGitBranchRemote
	t.Cleanup(func() { localGitBranchRemote = previousRemote })
	remoteLeaseContext = func(ctx context.Context, actual *Mapping, op, owner, id string) (map[string]any, error) {
		if actual != m || (op != "read" && owner != "sync") {
			t.Fatal("branch operation changed its lease binding/owner")
		}
		f.events = append(f.events, "lease:"+op)
		switch op {
		case "read":
			if f.lease == nil {
				return map[string]any{"ok": true, "lease": nil}, nil
			}
			return map[string]any{"ok": true, "lease": f.lease}, nil
		case "claim":
			if f.lease != nil {
				return nil, errors.New("already leased")
			}
			record, err := loadSyncRelease(m)
			if err != nil || record == nil || record.ID != id {
				t.Fatal("branch claim did not have its durable exact-ID journal")
			}
			f.lease = map[string]any{"owner": "sync", "id": id, "epoch": m.BindingEpoch}
		case "release":
			if f.lease == nil || f.lease["owner"] != owner || f.lease["id"] != id || f.lease["epoch"] != m.BindingEpoch {
				t.Fatal("branch operation tried to release another lease")
			}
			if f.failRelease {
				return nil, errors.New("release response lost")
			}
			if ctx.Err() != nil {
				t.Fatal("release reused a canceled request context")
			}
			f.lease = nil
		default:
			t.Fatalf("branch operation attempted forbidden lease operation %s", op)
		}
		return map[string]any{"ok": true}, nil
	}
	pauseProjectSync = func(ctx context.Context, _ *Mapping) error {
		f.events = append(f.events, "pause")
		if f.cleanupAfterCanceled && ctx.Err() != nil {
			t.Fatal("pause cleanup reused the canceled request context")
		}
		if f.failPause {
			return errors.New("pause failed")
		}
		return nil
	}
	synchronizeProjectContext = func(ctx context.Context, actual *Mapping, pause bool) error {
		f.events = append(f.events, "sync")
		f.syncs++
		id, _ := ctx.Value(syncLeaseContextKey{}).(string)
		if actual != m || pause || f.lease == nil || id != f.lease["id"] || f.lease["owner"] != "sync" {
			t.Fatal("branch synchronization lacks its exact owner lease")
		}
		if f.syncHook != nil {
			return f.syncHook(ctx, f.syncs)
		}
		return nil
	}
	localGitBranchRemote = func(ctx context.Context, actual *Mapping, phase, branch, head, expected string) (string, error) {
		f.events = append(f.events, phase)
		if actual != m || f.lease == nil || ctx.Value(syncLeaseContextKey{}) != f.lease["id"] {
			t.Fatal("remote branch alignment lacks its exact lease")
		}
		if phase == "observe" {
			if expected != "" || head != "" {
				t.Fatal("branch observation already had expected state")
			}
			return "observed-state", nil
		}
		if phase != "align" || expected != "observed-state" || strings.TrimSpace(git("branch", "--show-current")) != branch || strings.TrimSpace(git("rev-parse", "HEAD")) != head {
			t.Fatal("remote ref alignment preceded a successful exact local switch")
		}
		if f.failAlign {
			return "", errors.New("remote state changed")
		}
		return "", nil
	}
	return f
}

func (f *localBranchFixture) rpc(action, branch string, force ...bool) map[string]any {
	request := map[string]any{"op": "git_branch", "action": action, "branch": branch}
	if len(force) != 0 {
		request["force"] = force[0]
	}
	return workspaceRPCContext(context.Background(), f.m, request)
}

func localBranchCode(t *testing.T, result map[string]any, code string) {
	t.Helper()
	if result["ok"] != false || result["code"] != code || result["error"] == "" {
		t.Fatalf("wanted %s, got %#v", code, result)
	}
}

func (f *localBranchFixture) released(t *testing.T) {
	t.Helper()
	record, err := loadSyncRelease(f.m)
	if err != nil || record != nil || f.lease != nil || branchMapHas(&pendingSyncReleases, f.m.ServerPath) {
		t.Fatalf("successful handback leaked lease/journal: lease=%v record=%v err=%v", f.lease, record, err)
	}
}

func (f *localBranchFixture) retained(t *testing.T) {
	t.Helper()
	record, err := loadSyncRelease(f.m)
	if err != nil || record == nil || f.lease == nil || record.ID != f.lease["id"] || !branchMapHas(&pendingSyncReleases, f.m.ServerPath) || slices.Contains(f.events, "lease:release") {
		t.Fatalf("failed synchronization lost exact recovery barrier: events=%v lease=%v record=%v err=%v", f.events, f.lease, record, err)
	}
}

func TestLocalGitBranchOwnerExactBranchesAndHandback(t *testing.T) {
	f := localBranchTestFixture(t)
	if result := localGitReadTestRPC(f.m, "prepare"); result["ok"] != true || result["gitBranch"] != true {
		t.Fatalf("missing native branch capability: %v", result)
	}
	for _, operation := range [][2]string{{"create", "中文/topic"}, {"checkout", "main"}, {"checkout", "中文/topic"}, {"checkout", "main"}, {"delete", "中文/topic"}} {
		f.events = nil
		result := f.rpc(operation[0], operation[1])
		if result["ok"] != true || result["exitCode"] != 0 || result["branch"] != strings.TrimSpace(f.git("branch", "--show-current")) {
			t.Fatalf("%v failed: %#v events=%v", operation, result, f.events)
		}
		f.released(t)
		want := []string{"lease:read", "lease:claim", "sync", "pause", "observe", "align", "sync", "lease:read", "lease:release"}
		if operation[0] == "delete" {
			want = []string{"lease:read", "lease:claim", "sync", "pause", "sync", "lease:read", "lease:release"}
		}
		if !reflect.DeepEqual(f.events, want) {
			t.Fatalf("branch handback order %v, wanted %v", f.events, want)
		}
	}
	localBranchCode(t, f.rpc("checkout", "origin/main"), "WORKSPACE_GIT_BRANCH_MISSING")
	localBranchCode(t, f.rpc("create", "main"), "WORKSPACE_GIT_BRANCH_EXISTS")
}

func TestLocalGitBranchShadowedBySameNameTagUsesExactHead(t *testing.T) {
	f := localBranchTestFixture(t)
	f.git("branch", "topic")
	f.git("tag", "topic")
	f.git("branch", "unused")
	for _, operation := range [][2]string{{"checkout", "topic"}, {"delete", "unused"}} {
		result := f.rpc(operation[0], operation[1])
		if result["ok"] != true || result["branch"] != "topic" || strings.TrimSpace(f.git("symbolic-ref", "HEAD")) != "refs/heads/topic" {
			t.Fatalf("same-name tag changed exact owner branch result: %#v", result)
		}
		f.released(t)
	}
	if strings.TrimSpace(f.git("rev-parse", "refs/tags/topic")) != strings.TrimSpace(f.git("rev-parse", "refs/heads/topic")) {
		t.Fatal("branch operation changed same-name tag")
	}
}

func TestLocalGitBranchRejectsInvalidNamesAndOptionsBeforeLease(t *testing.T) {
	f := localBranchTestFixture(t)
	for _, name := range []string{"", "-f", ".", "..", "@{-1}", "HEAD~1", "refs/heads/main^{commit}", "a..b", "a b", "a\nb", "a\\b", "a.lock", "a/", "HEAD"} {
		localBranchCode(t, f.rpc("create", name), "INVALID_REQUEST")
	}
	for _, request := range []map[string]any{
		{"op": "git_branch", "action": "reset", "branch": "main"},
		{"op": "git_branch", "action": "checkout", "branch": "main", "force": true},
		{"op": "git_branch", "action": "delete", "branch": "main", "force": "true"},
		{"op": "git_branch", "action": "create", "branch": "topic", "argv": []string{"--force"}},
	} {
		localBranchCode(t, workspaceRPCContext(context.Background(), f.m, request), "INVALID_REQUEST")
	}
	if len(f.events) != 0 {
		t.Fatalf("invalid request reached lease/sync: %v", f.events)
	}
}

func TestLocalGitBranchDirtyAndIgnoredFilesNeverDiscarded(t *testing.T) {
	f := localBranchTestFixture(t)
	f.git("branch", "topic")
	piWorkspaceWrite(t, f.m.LocalPath, "plain.txt", "owner edit\n")
	index, err := os.ReadFile(filepath.Join(f.m.LocalPath, ".git", "index"))
	if err != nil {
		t.Fatal(err)
	}
	for _, action := range []string{"checkout", "create"} {
		name := "topic"
		if action == "create" {
			name = "new"
		}
		localBranchCode(t, f.rpc(action, name), "WORKSPACE_GIT_DIRTY")
	}
	if len(f.events) != 0 || strings.TrimSpace(f.git("branch", "--show-current")) != "main" {
		t.Fatalf("dirty refusal performed work: %v", f.events)
	}
	after, _ := os.ReadFile(filepath.Join(f.m.LocalPath, ".git", "index"))
	body, _ := os.ReadFile(filepath.Join(f.m.LocalPath, "plain.txt"))
	if string(index) != string(after) || string(body) != "owner edit\n" {
		t.Fatal("dirty refusal changed owner index/worktree")
	}
	// Delete can run without touching any worktree contents.
	if result := f.rpc("delete", "topic"); result["ok"] != true {
		t.Fatal(result)
	}
	f.released(t)
}

func TestLocalGitBranchIgnoredCollisionAndLinkedWorktreeStayUntouched(t *testing.T) {
	for _, scenario := range []string{"ignored", "linked"} {
		t.Run(scenario, func(t *testing.T) {
			f := localBranchTestFixture(t)
			if scenario == "ignored" {
				piWorkspaceWrite(t, f.m.LocalPath, ".gitignore", "owner.dat\n")
				f.git("add", ".gitignore")
				f.git("commit", "-m", "ignore owner file")
				f.git("switch", "-c", "topic")
				piWorkspaceWrite(t, f.m.LocalPath, "owner.dat", "topic tracked\n")
				f.git("add", "--force", "owner.dat")
				f.git("commit", "-m", "topic file")
				f.git("switch", "main")
				piWorkspaceWrite(t, f.m.LocalPath, "owner.dat", "owner ignored data\n")
			} else {
				f.git("branch", "topic")
				f.git("worktree", "add", filepath.Join(t.TempDir(), "linked"), "topic")
			}
			localBranchCode(t, f.rpc("checkout", "topic"), "WORKSPACE_GIT_REJECTED")
			f.released(t)
			if strings.TrimSpace(f.git("branch", "--show-current")) != "main" {
				t.Fatal("rejected switch changed owner HEAD")
			}
			if scenario == "ignored" {
				body, err := os.ReadFile(filepath.Join(f.m.LocalPath, "owner.dat"))
				if err != nil || string(body) != "owner ignored data\n" {
					t.Fatal("ignored owner file was overwritten")
				}
			}
		})
	}
}

func TestLocalGitBranchExternalCheckoutDriversNeverExecute(t *testing.T) {
	for _, scenario := range []string{"filter-current", "filter-target", "submodule-target", "hook"} {
		t.Run(scenario, func(t *testing.T) {
			f := localBranchTestFixture(t)
			f.git("branch", "topic")
			marker := filepath.ToSlash(filepath.Join(t.TempDir(), "external-helper-ran"))
			if scenario == "hook" {
				hook := "#!/bin/sh\nprintf ran > '" + marker + "'\n"
				if err := os.WriteFile(filepath.Join(f.m.LocalPath, ".git", "hooks", "post-checkout"), []byte(hook), 0700); err != nil {
					t.Fatal(err)
				}
				if result := f.rpc("checkout", "topic"); result["ok"] != true {
					t.Fatal(result)
				}
				f.released(t)
			} else {
				if scenario != "filter-current" {
					f.git("switch", "topic")
				}
				if scenario == "submodule-target" {
					f.git("update-index", "--add", "--cacheinfo", "160000,"+strings.TrimSpace(f.git("rev-parse", "HEAD"))+",submodule")
					f.git("commit", "-m", "gitlink")
				} else {
					piWorkspaceWrite(t, f.m.LocalPath, ".gitattributes", "plain.txt filter=unsafe\n")
					f.git("add", ".gitattributes")
					f.git("commit", "-m", "filter")
				}
				if scenario != "filter-current" {
					f.git("switch", "main")
				}
				f.git("config", "filter.unsafe.smudge", "sh -c 'printf ran > \""+marker+"\"; cat'")
				f.git("config", "filter.unsafe.clean", "sh -c 'printf ran > \""+marker+"\"; cat'")
				localBranchCode(t, f.rpc("checkout", "topic"), "WORKSPACE_GIT_UNSUPPORTED")
				if len(f.events) != 0 {
					t.Fatal("unsafe repository reached synchronization")
				}
			}
			if _, err := os.Stat(filepath.FromSlash(marker)); !errors.Is(err, os.ErrNotExist) {
				t.Fatal("external checkout helper executed")
			}
		})
	}
}

func TestLocalGitBranchForceOnlyDeletesExactLocalHistory(t *testing.T) {
	f := localBranchTestFixture(t)
	f.git("switch", "-c", "independent")
	piWorkspaceWrite(t, f.m.LocalPath, "independent.txt", "unique history\n")
	f.git("add", ".")
	f.git("commit", "-m", "independent")
	head := strings.TrimSpace(f.git("rev-parse", "HEAD"))
	f.git("switch", "main")
	localBranchCode(t, f.rpc("delete", "independent"), "WORKSPACE_GIT_REJECTED")
	f.released(t)
	if result := f.rpc("delete", "independent", true); result["ok"] != true {
		t.Fatal(result)
	}
	f.released(t)
	if !strings.Contains(f.git("cat-file", "-t", head), "commit") {
		t.Fatal("delete removed commit object")
	}
	localBranchCode(t, f.rpc("delete", "main", true), "WORKSPACE_GIT_REJECTED")
	f.released(t)
}

func TestLocalGitBranchActiveGitOperationAndUnmergedStages(t *testing.T) {
	for _, marker := range []string{"MERGE_HEAD", "MERGE_AUTOSTASH", "REBASE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply", "sequencer", "refs/rewritten"} {
		t.Run(marker, func(t *testing.T) {
			f := localBranchTestFixture(t)
			f.git("branch", "topic")
			path := filepath.Join(f.m.LocalPath, ".git", marker)
			if strings.Contains(marker, "rebase-") || marker == "sequencer" || marker == "refs/rewritten" {
				if err := os.Mkdir(path, 0700); err != nil {
					t.Fatal(err)
				}
			} else if err := os.WriteFile(path, []byte(strings.TrimSpace(f.git("rev-parse", "HEAD"))+"\n"), 0600); err != nil {
				t.Fatal(err)
			}
			for _, action := range []string{"checkout", "create", "delete"} {
				branch := "topic"
				if action == "create" {
					branch = "new"
				}
				localBranchCode(t, f.rpc(action, branch), "WORKSPACE_GIT_OPERATION")
			}
			if len(f.events) != 0 {
				t.Fatal(f.events)
			}
		})
	}
	t.Run("unmerged", func(t *testing.T) {
		f := localBranchTestFixture(t)
		f.git("switch", "-c", "topic")
		piWorkspaceWrite(t, f.m.LocalPath, "plain.txt", "topic\n")
		f.git("commit", "-am", "topic")
		f.git("switch", "main")
		piWorkspaceWrite(t, f.m.LocalPath, "plain.txt", "main\n")
		f.git("commit", "-am", "main")
		out, err := runLocalGitRead(context.Background(), f.m.LocalPath, f.m.LocalPath, []string{"merge", "--no-commit", "topic"})
		if err != nil || out.exitCode == 0 {
			t.Fatalf("expected real merge conflict: %v %v", out, err)
		}
		before := f.git("ls-files", "--unmerged", "-z")
		localBranchCode(t, f.rpc("checkout", "topic"), "WORKSPACE_GIT_CONFLICT")
		if f.git("ls-files", "--unmerged", "-z") != before || len(f.events) != 0 {
			t.Fatal("unmerged refusal changed stages")
		}
	})
	t.Run("persistent ORIG_HEAD is allowed", func(t *testing.T) {
		f := localBranchTestFixture(t)
		f.git("update-ref", "ORIG_HEAD", strings.TrimSpace(f.git("rev-parse", "HEAD")))
		if result := f.rpc("create", "topic"); result["ok"] != true {
			t.Fatal(result)
		}
		f.released(t)
	})
}

func TestLocalGitBranchAdmissionAndRecoveryBarriers(t *testing.T) {
	for _, barrier := range []string{"task", "pi", "sync", "journal", "pending", "pause", "cloud-recovery", "remote-task", "pending-git"} {
		t.Run(barrier, func(t *testing.T) {
			f := localBranchTestFixture(t)
			want := "WORKSPACE_BUSY"
			switch barrier {
			case "task":
				cloudReservations.Store(f.m.ServerPath, "task")
				t.Cleanup(func() { cloudReservations.Delete(f.m.ServerPath) })
			case "pi":
				piAgents.Lock()
				piAgents.owners[f.m.ServerPath] = "pi-session"
				piAgents.Unlock()
			case "sync":
				finish := beginSyncOperation(f.m, "syncing")
				defer finish()
			case "journal":
				if err := saveSyncRelease(f.m, "old"); err != nil {
					t.Fatal(err)
				}
				want = "SYNC_BLOCKED"
			case "pending":
				pendingSyncReleases.Store(f.m.ServerPath, pendingSyncRelease{id: "old", epoch: f.m.BindingEpoch})
				want = "SYNC_BLOCKED"
			case "pause":
				syncStopUnconfirmed.Store(f.m.ServerPath, unconfirmedSyncStop{f.m.BindingEpoch, f.m.SyncName})
				want = "SYNC_BLOCKED"
			case "cloud-recovery":
				cloudSyncRecovery.Store(f.m.ServerPath, "old")
				t.Cleanup(func() { cloudSyncRecovery.Delete(f.m.ServerPath) })
				want = "SYNC_BLOCKED"
			case "remote-task":
				f.lease = map[string]any{"owner": "claude", "id": "task", "epoch": f.m.BindingEpoch}
			case "pending-git":
				r, _ := loadGitCheckpoint(f.m)
				r.Pending = &syncGitPending{}
				if err := saveGitCheckpoint(f.m, r); err != nil {
					t.Fatal(err)
				}
				want = "SYNC_BLOCKED"
			}
			localBranchCode(t, f.rpc("create", "topic"), want)
			for _, event := range f.events {
				if event != "lease:read" {
					t.Fatalf("barrier allowed work: %v", f.events)
				}
			}
			if strings.TrimSpace(f.git("branch", "--show-current")) != "main" {
				t.Fatal("barrier switched local branch")
			}
		})
	}
}

func TestLocalGitBranchSyncFailuresRetainExactLeaseAndLocalResult(t *testing.T) {
	for _, phase := range []string{"preflight", "postflight", "pause", "align", "release", "cancel"} {
		t.Run(phase, func(t *testing.T) {
			f := localBranchTestFixture(t)
			want := "SYNC_BLOCKED"
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			switch phase {
			case "preflight":
				f.syncHook = func(context.Context, int) error { return errors.New("sync conflict") }
			case "postflight":
				f.syncHook = func(_ context.Context, n int) error {
					if n == 2 {
						return errors.New("sync conflict")
					}
					return nil
				}
			case "pause":
				f.failPause = true
				want = "SYNC_PAUSE_UNCONFIRMED"
			case "align":
				f.failAlign = true
			case "release":
				f.failRelease = true
				want = "WORKSPACE_RELEASE_FAILED"
			case "cancel":
				f.cleanupAfterCanceled = true
				want = "WORKSPACE_UNAVAILABLE"
				f.syncHook = func(_ context.Context, n int) error {
					if n == 2 {
						cancel()
						return context.Canceled
					}
					return nil
				}
			}
			result := workspaceRPCContext(ctx, f.m, map[string]any{"op": "git_branch", "action": "create", "branch": "topic"})
			localBranchCode(t, result, want)
			current := strings.TrimSpace(f.git("branch", "--show-current"))
			if phase == "preflight" || phase == "pause" {
				if current != "main" {
					t.Fatal("branch changed before preflight/pause")
				}
			} else if current != "topic" {
				t.Fatal("failed handback undid successful local switch")
			}
			if phase != "release" {
				f.retained(t)
			} else if record, _ := loadSyncRelease(f.m); record == nil || f.lease == nil {
				t.Fatal("release failure lost exact journal")
			}
			before := len(f.events)
			localBranchCode(t, f.rpc("checkout", "main"), "SYNC_BLOCKED")
			if len(f.events) != before {
				t.Fatal("recovery barrier allowed another attempt")
			}
		})
	}
}

func TestLocalGitBranchChecksAgainAfterSynchronization(t *testing.T) {
	f := localBranchTestFixture(t)
	f.syncHook = func(_ context.Context, n int) error {
		if n == 1 {
			piWorkspaceWrite(t, f.m.LocalPath, "plain.txt", "concurrent edit\n")
		}
		return nil
	}
	localBranchCode(t, f.rpc("create", "topic"), "WORKSPACE_GIT_DIRTY")
	f.released(t)
	if slices.Contains(f.events, "pause") || strings.TrimSpace(f.git("branch", "--show-current")) != "main" {
		t.Fatal(f.events)
	}
}

func TestLocalGitBranchRepositoryIdentityCannotChangeDuringSync(t *testing.T) {
	f := localBranchTestFixture(t)
	original := filepath.Join(f.m.LocalPath, ".git")
	preserved := filepath.Join(t.TempDir(), "original-git")
	if !filepath.IsAbs(original) || !filepath.IsAbs(preserved) || !strings.EqualFold(filepath.Clean(strings.TrimSpace(f.git("rev-parse", "--absolute-git-dir"))), filepath.Clean(original)) {
		t.Fatal("identity fixture is not its private absolute Git directory")
	}
	f.syncHook = func(_ context.Context, n int) error {
		if n == 1 {
			// Both paths were checked above; preserve the original private repo.
			if err := os.Rename(original, preserved); err != nil {
				t.Fatal(err)
			}
			f.git("init", "-b", "main")
			f.git("-c", "user.name=Replacement", "-c", "user.email=replacement@localhost", "commit", "--allow-empty", "-m", "replacement")
		}
		return nil
	}
	localBranchCode(t, f.rpc("create", "topic"), "WORKSPACE_GIT_CHANGED")
	f.released(t)
	if slices.Contains(f.events, "pause") || strings.TrimSpace(f.git("branch", "--show-current")) != "main" {
		t.Fatal("metadata replacement entered branch mutation")
	}
	if _, err := os.Stat(filepath.Join(preserved, "HEAD")); err != nil {
		t.Fatal("original metadata lost")
	}
}

func TestLocalGitBranchCancellationWaitingForMutexDoesNotEnter(t *testing.T) {
	f := localBranchTestFixture(t)
	unlock, err := lockWorkspace(context.Background(), f.m.ServerPath)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	result := workspaceRPCContext(ctx, f.m, map[string]any{"op": "git_branch", "action": "create", "branch": "topic"})
	unlock()
	localBranchCode(t, result, "WORKSPACE_UNAVAILABLE")
	if len(f.events) != 0 {
		t.Fatal(f.events)
	}
}

func branchWorkerTest(t *testing.T, tools *syncSeedTestTools, root, phase, ref, head, expected, backup string) (string, error) {
	t.Helper()
	input, err := json.Marshal(map[string]any{"root": root, "phase": phase, "ref": ref, "head": head, "expected": expected, "backup": backup})
	if err != nil {
		t.Fatal(err)
	}
	out, diagnostic, err := tools.command(t, input, tools.python, "-c", syncGitApplyTestBootstrap, localGitBranchRemoteWorker)
	if err != nil {
		return "", errors.New(diagnostic)
	}
	return strings.TrimSpace(out), nil
}

func TestLocalGitBranchRemoteIndexLockRecoversOnlyOwnedInterruptedLock(t *testing.T) {
	tools := syncSeedTools(t)
	for _, scenario := range []string{"interrupted-owned", "foreign", "foreign-with-owned-marker"} {
		t.Run(scenario, func(t *testing.T) {
			root := t.TempDir()
			tools.gitRun(t, root, "init", "-b", "main")
			syncSeedWrite(t, root, "file.txt", "owner index\n")
			tools.gitRun(t, root, "add", ".")
			tools.gitRun(t, root, "commit", "-m", "main")
			index := filepath.Join(root, ".git", "index")
			before, err := os.ReadFile(index)
			if err != nil {
				t.Fatal(err)
			}
			lock, owned := index+".lock", index+".chisa-owned"
			if scenario == "interrupted-owned" {
				input, err := json.Marshal(map[string]any{"root": root, "phase": "observe", "ref": "refs/heads/topic"})
				if err != nil {
					t.Fatal(err)
				}
				crash := "import os\noriginal_link = os.link\ndef interrupted_link(source, destination):\n    original_link(source, destination)\n    os._exit(124)\nos.link = interrupted_link\n"
				if _, _, err := tools.command(t, input, tools.python, "-c", syncGitApplyTestBootstrap, crash+localGitBranchRemoteWorker); err == nil {
					t.Fatal("expected worker process interruption after index lock claim")
				}
				lockInfo, lockErr := os.Stat(lock)
				ownedInfo, ownedErr := os.Stat(owned)
				if lockErr != nil || ownedErr != nil || !os.SameFile(lockInfo, ownedInfo) {
					t.Fatal("interruption did not leave its provably owned lock")
				}
			} else {
				if err := os.WriteFile(lock, []byte("foreign Git transaction\n"), 0600); err != nil {
					t.Fatal(err)
				}
				if scenario == "foreign-with-owned-marker" {
					if err := os.WriteFile(owned, []byte("older owned marker\n"), 0600); err != nil {
						t.Fatal(err)
					}
				}
			}
			_, err = branchWorkerTest(t, tools, root, "observe", "refs/heads/topic", "", "", "refs/chisa/recovery/lock-test")
			if scenario == "interrupted-owned" {
				if err != nil {
					t.Fatal(err)
				}
				for _, path := range []string{lock, owned} {
					if _, err := os.Stat(path); !errors.Is(err, os.ErrNotExist) {
						t.Fatal("owned interrupted lock was not recovered")
					}
				}
			} else {
				body, readErr := os.ReadFile(lock)
				if err == nil || readErr != nil || string(body) != "foreign Git transaction\n" {
					t.Fatal("foreign Git lock was removed or ignored")
				}
			}
			after, readErr := os.ReadFile(index)
			if readErr != nil || string(before) != string(after) {
				t.Fatal("branch observation changed index")
			}
		})
	}
}

func TestLocalGitBranchRemoteStaleRefPreservedAndStateCompared(t *testing.T) {
	tools := syncSeedTools(t)
	for _, scenario := range []string{"preserve", "active", "linked-worktree", "changed-state", "backup-exists", "operation", "autostash", "missing"} {
		t.Run(scenario, func(t *testing.T) {
			root := t.TempDir()
			tools.gitRun(t, root, "init", "-b", "main")
			syncSeedWrite(t, root, "file.txt", "main\n")
			tools.gitRun(t, root, "add", ".")
			tools.gitRun(t, root, "commit", "-m", "main")
			main := tools.gitRun(t, root, "rev-parse", "HEAD")
			tools.gitRun(t, root, "switch", "-c", "topic")
			syncSeedWrite(t, root, "file.txt", "remote independent\n")
			tools.gitRun(t, root, "commit", "-am", "independent")
			old := tools.gitRun(t, root, "rev-parse", "HEAD")
			if scenario != "active" {
				tools.gitRun(t, root, "switch", "main")
			}
			if scenario == "missing" {
				tools.gitRun(t, root, "branch", "-D", "topic")
			}
			const target = "refs/heads/topic"
			const backup = "refs/chisa/recovery/branch-test"
			expected, err := branchWorkerTest(t, tools, root, "observe", target, "", "", backup)
			if err != nil {
				t.Fatal(err)
			}
			switch scenario {
			case "linked-worktree":
				tools.gitRun(t, root, "worktree", "add", filepath.Join(t.TempDir(), "linked"), "topic")
			case "changed-state":
				tools.gitRun(t, root, "update-ref", target, main)
			case "backup-exists":
				tools.gitRun(t, root, "update-ref", backup, main)
			case "operation":
				syncSeedWrite(t, root, ".git/MERGE_HEAD", old+"\n")
			case "autostash":
				syncSeedWrite(t, root, ".git/MERGE_AUTOSTASH", old+"\n")
			}
			_, err = branchWorkerTest(t, tools, root, "align", target, main, expected, backup)
			if scenario == "preserve" || scenario == "missing" {
				if err != nil {
					t.Fatal(err)
				}
				if scenario == "preserve" && tools.gitRun(t, root, "rev-parse", backup) != old {
					t.Fatal("independent remote history lost")
				}
				stdout, _, checkErr := tools.command(t, nil, tools.git, "-C", root, "show-ref", "--verify", "--quiet", target)
				if checkErr == nil {
					t.Fatalf("stale ref still exists: %s", stdout)
				}
			} else {
				if err == nil {
					t.Fatal("unsafe remote retirement accepted")
				}
				want := old
				if scenario == "changed-state" {
					want = main
				}
				if tools.gitRun(t, root, "rev-parse", target) != want {
					t.Fatal("failed remote guard mutated target")
				}
				if scenario == "backup-exists" && tools.gitRun(t, root, "rev-parse", backup) != main {
					t.Fatal("backup ref overwritten")
				}
			}
			if tools.gitRun(t, root, "rev-parse", "HEAD") != map[bool]string{true: old, false: main}[scenario == "active"] {
				t.Fatal("remote helper changed HEAD")
			}
		})
	}
}
