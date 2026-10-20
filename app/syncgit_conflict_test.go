package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

// Windows lacks fcntl. The shim replaces only that platform's flock; real Git,
// hard-link ownership, index locks, snapshots and filesystem changes still run.
// Linux executes the real worker lock. Tests inject failures only after a real
// operation file replacement succeeds, preserving the partial on-disk state.
const syncGitApplyTestBootstrap = `import os, pathlib, sys, types
try:
    import fcntl
except ImportError:
    sys.modules['fcntl'] = types.SimpleNamespace(LOCK_EX=2, LOCK_NB=4, flock=lambda *args: None)
mode = sys.argv[2] if len(sys.argv) > 2 else ''
if mode:
    replace = os.replace
    def interrupted_replace(source, destination):
        replace(source, destination)
        path = pathlib.Path(destination)
        if mode == 'interrupt-operation' and path.name == 'MERGE_HEAD': os._exit(124)
        if mode == 'interrupt-rebase' and path.parent.name in ('rebase-merge', 'rebase-apply') and path.name == 'onto': os._exit(124)
    os.replace = interrupted_replace
    unlink = pathlib.Path.unlink
    def interrupted_unlink(path, *args, **kwargs):
        unlink(path, *args, **kwargs)
        if mode == 'interrupt-delete-operation' and path.name == 'MERGE_HEAD': os._exit(124)
    pathlib.Path.unlink = interrupted_unlink
exec(compile(sys.argv[1], 'embedded-sync-git-apply.py', 'exec'), {'__name__': '__main__'})
`

func syncGitConflictFixture(t *testing.T) (*syncSeedTestTools, *Mapping, string, syncGitState) {
	t.Helper()
	m := isolatePi(t)
	tools := syncSeedTools(t)
	// Both the worker tools and native helpers operate only on temporary repos.
	for _, item := range tools.env {
		key, value, _ := strings.Cut(item, "=")
		if strings.HasPrefix(key, "GIT_") {
			t.Setenv(key, value)
		}
	}
	tools.gitRun(t, m.LocalPath, "init", "-b", "main")
	tools.gitRun(t, m.LocalPath, "config", "user.name", "Conflict regression")
	tools.gitRun(t, m.LocalPath, "config", "user.email", "conflict@localhost")
	tools.gitRun(t, m.LocalPath, "config", "core.autocrlf", "false")
	syncSeedWrite(t, m.LocalPath, " conflict space.txt", "base\n")
	syncSeedWrite(t, m.LocalPath, "clean.txt", "base clean\n")
	tools.gitRun(t, m.LocalPath, "add", ".")
	tools.gitRun(t, m.LocalPath, "commit", "-m", "base")
	tools.gitRun(t, m.LocalPath, "checkout", "-b", "topic")
	syncSeedWrite(t, m.LocalPath, " conflict space.txt", "topic\n")
	tools.gitRun(t, m.LocalPath, "commit", "-am", "topic")
	tools.gitRun(t, m.LocalPath, "checkout", "main")
	syncSeedWrite(t, m.LocalPath, " conflict space.txt", "main\n")
	tools.gitRun(t, m.LocalPath, "commit", "-am", "main")
	before, err := readLocalGitState(context.Background(), m)
	if err != nil {
		t.Fatal(err)
	}
	replica := t.TempDir()
	tools.gitRun(t, replica, "clone", "--no-hardlinks", m.LocalPath, ".")
	tools.gitRun(t, replica, "config", "user.name", "Conflict regression")
	tools.gitRun(t, replica, "config", "user.email", "conflict@localhost")
	tools.gitRun(t, replica, "config", "core.autocrlf", "false")
	// Clone does not create the inactive local branch; operations must be able to
	// reference its commit via the snapshot, not an implicit checkout/fetch-all.
	return tools, m, replica, before
}

func syncGitExpectFailure(t *testing.T, tools *syncSeedTestTools, root string, args ...string) {
	t.Helper()
	arguments := append([]string{"-C", root}, args...)
	out, stderr, err := tools.command(t, nil, tools.git, arguments...)
	if err == nil {
		t.Fatalf("expected Git conflict: %s %s", out, stderr)
	}
	if !strings.Contains(out+stderr, "CONFLICT") {
		t.Fatalf("Git failed without a conflict: %v %s %s", err, out, stderr)
	}
}

func syncGitWorker(t *testing.T, tools *syncSeedTestTools, request any, mode string) (string, error) {
	t.Helper()
	input, err := json.Marshal(request)
	if err != nil {
		t.Fatal(err)
	}
	stdout, stderr, err := tools.command(t, input, tools.python, "-c", syncGitApplyTestBootstrap, syncGitApplyWorker, mode)
	if err != nil {
		return stdout, fmt.Errorf("%w: %s", err, stderr)
	}
	return strings.TrimSpace(stdout), nil
}

func syncGitWorkerRead(t *testing.T, tools *syncSeedTestTools, root string) syncGitState {
	t.Helper()
	out, err := syncGitWorker(t, tools, map[string]any{"root": root, "op": "read"}, "")
	if err != nil {
		t.Fatal(err)
	}
	var state syncGitState
	if err := json.Unmarshal([]byte(out), &state); err != nil {
		t.Fatal(err, out)
	}
	return state
}

func syncGitTransferForTest(t *testing.T, tools *syncSeedTestTools, source *Mapping, destination string, state syncGitState) string {
	t.Helper()
	ref := "refs/chisa/transfer/conflict-regression"
	commit, err := localGitSnapshot(context.Background(), source, state, ref)
	if err != nil {
		t.Fatal(err)
	}
	tools.gitRun(t, destination, "fetch", "--no-tags", source.LocalPath, ref)
	return commit
}

func TestGitSyncConflictIndexRoundTripAndResolution(t *testing.T) {
	tools, source, replica, before := syncGitConflictFixture(t)
	ctx := context.Background()
	syncGitExpectFailure(t, tools, source.LocalPath, "merge", "topic")
	// Every entry/stage, a binary blob, executable and symlink mode are retained.
	syncSeedWrite(t, source.LocalPath, "binary staged.dat", "\x00\xffstage zero\x00")
	tools.gitRun(t, source.LocalPath, "add", "binary staged.dat")
	tools.gitRun(t, source.LocalPath, "update-index", "--chmod=+x", "binary staged.dat")
	link := tools.gitInput(t, source.LocalPath, []byte("clean.txt"), "hash-object", "-w", "--stdin")
	tools.gitRun(t, source.LocalPath, "update-index", "--add", "--cacheinfo", "120000,"+link+",link")
	syncSeedWrite(t, source.LocalPath, "clean.txt", "unstaged local content\n")
	syncSeedWrite(t, source.LocalPath, "untracked.txt", "keep untracked\n")
	desired, err := readLocalGitState(ctx, source)
	if err != nil || !strings.HasPrefix(desired.Index, syncGitStagesPrefix) || desired.Operations == "" {
		t.Fatalf("conflict not captured: %+v %v", desired, err)
	}
	if remote := syncGitWorkerRead(t, tools, source.LocalPath); remote != desired {
		t.Fatalf("Go/Python conflict representation differs:\n%+v\n%+v", desired, remote)
	}
	commit := syncGitTransferForTest(t, tools, source, replica, desired)
	manifest := tools.gitRun(t, replica, "show", commit+":state.json")
	var saved syncGitState
	if err := json.Unmarshal([]byte(manifest), &saved); err != nil || saved != desired {
		t.Fatalf("recovery does not retain exact conflict state: %s %v", manifest, err)
	}
	worktree := syncSeedSnapshot(t, replica, true)
	out, err := syncGitWorker(t, tools, map[string]any{"root": replica, "before": before, "desired": desired, "backup": "refs/chisa/recovery/before-conflict"}, "")
	if err != nil {
		t.Fatal(err, out)
	}
	if actual := syncGitWorkerRead(t, tools, replica); actual != desired {
		t.Fatalf("worker conflict apply mismatch: %+v", actual)
	}
	if !reflect.DeepEqual(worktree, syncSeedSnapshot(t, replica, true)) {
		t.Fatal("metadata apply changed worktree files")
	}
	if tools.gitRun(t, source.LocalPath, "ls-files", "--stage", "-z") != tools.gitRun(t, replica, "ls-files", "--stage", "-z") {
		t.Fatal("stage entries or file modes changed")
	}
	// Native apply must also accept an unresolved source and reconstruct it.
	local := *source
	local.LocalPath = replica
	if err := applyLocalGitState(ctx, &local, desired, before); err != nil {
		t.Fatal(err)
	}
	if err := applyLocalGitState(ctx, &local, before, desired); err != nil {
		t.Fatal(err)
	}
	if actual, err := readLocalGitState(ctx, &local); err != nil || actual != desired {
		t.Fatalf("native conflict round-trip failed: %+v %v", actual, err)
	}
	// Next turn resolves and commits on the original owner; the receiving side
	// returns to an ordinary tree, removes MERGE_*, and retains clean old JSON.
	syncSeedWrite(t, source.LocalPath, " conflict space.txt", "resolved\n")
	tools.gitRun(t, source.LocalPath, "add", " conflict space.txt")
	tools.gitRun(t, source.LocalPath, "commit", "-m", "resolved merge")
	resolved, err := readLocalGitState(ctx, source)
	if err != nil || strings.HasPrefix(resolved.Index, syncGitStagesPrefix) {
		t.Fatalf("resolution not captured: %+v %v", resolved, err)
	}
	syncGitTransferForTest(t, tools, source, replica, resolved)
	selected, err := selectGitState(ctx, &local, &syncGitCheckpoint{State: desired}, desired, resolved)
	if err != nil || selected != resolved {
		t.Fatalf("next handback selection failed: %+v %v", selected, err)
	}
	if err := applyLocalGitState(ctx, &local, desired, resolved); err != nil {
		t.Fatal(err)
	}
	if actual := syncGitWorkerRead(t, tools, replica); actual != resolved {
		t.Fatalf("resolved handback mismatch: %+v", actual)
	}
	if got := tools.gitRun(t, replica, "ls-files", "--unmerged"); got != "" {
		t.Fatalf("stale conflict stages retained: %s", got)
	}
	if !reflect.DeepEqual(worktree, syncSeedSnapshot(t, replica, true)) {
		t.Fatal("resolution metadata apply changed worktree bytes")
	}
}

func TestGitSyncConflictOperationInterruptionAndIndependentEdits(t *testing.T) {
	tools, source, replica, before := syncGitConflictFixture(t)
	syncGitExpectFailure(t, tools, source.LocalPath, "merge", "topic")
	desired, err := readLocalGitState(context.Background(), source)
	if err != nil {
		t.Fatal(err)
	}
	syncGitTransferForTest(t, tools, source, replica, desired)
	request := map[string]any{"root": replica, "before": before, "desired": desired, "backup": "refs/chisa/recovery/interrupted"}
	if _, err := syncGitWorker(t, tools, request, "interrupt-operation"); err == nil {
		t.Fatal("operation interruption did not fire")
	}
	partial := syncGitWorkerRead(t, tools, replica)
	if partial == before || partial == desired || !gitTransitionMatches(partial, before, desired) {
		t.Fatalf("operation partial not safely resumable: %+v", partial)
	}
	journal := &syncGitCheckpoint{Pending: &syncGitPending{Local: before, Remote: desired, Desired: desired}}
	local := *source
	local.LocalPath = replica
	selected, err := selectGitState(context.Background(), &local, journal, partial, desired)
	if err != nil || selected != desired {
		t.Fatalf("interrupted handback not selected: %+v %v", selected, err)
	}
	// A modified existing operation file or a newly added file is never a
	// recorded transition, even if HEAD and the staged conflict are unchanged.
	syncSeedWrite(t, replica, ".git/MERGE_MSG", "independent merge message\n")
	changed := syncGitWorkerRead(t, tools, replica)
	if _, err := selectGitState(context.Background(), &local, journal, changed, desired); err == nil {
		t.Fatal("pending transition swallowed an independent operation edit")
	}
	if err := applyLocalGitState(context.Background(), &local, partial, desired); err == nil {
		t.Fatal("native apply overwrote independent operation edit")
	}
	if _, err := syncGitWorker(t, tools, map[string]any{"root": replica, "before": partial, "desired": desired, "backup": "refs/chisa/recovery/rejected"}, ""); err == nil {
		t.Fatal("worker overwrote independent operation edit")
	}
	paths, err := localGitOperationPaths(context.Background(), &local)
	if err != nil {
		t.Fatal(err)
	}
	if err := applyGitOperations(paths, changed.Operations, partial.Operations); err != nil {
		t.Fatal(err)
	}
	if err := applyLocalGitState(context.Background(), &local, partial, desired); err != nil {
		t.Fatalf("native retry did not complete: %v", err)
	}
	if actual := syncGitWorkerRead(t, tools, replica); actual != desired {
		t.Fatalf("retry state mismatch: %+v", actual)
	}
	// Hard termination also interrupts deletion while returning to a clean
	// state. The owned index lock is recovered without touching foreign locks.
	if _, err := syncGitWorker(t, tools, map[string]any{"root": replica, "before": desired, "desired": before, "backup": "refs/chisa/recovery/interrupted-removal"}, "interrupt-delete-operation"); err == nil {
		t.Fatal("operation removal interruption did not fire")
	}
	removed := syncGitWorkerRead(t, tools, replica)
	if removed == desired || removed == before || !gitTransitionMatches(removed, desired, before) {
		t.Fatalf("partial operation removal not resumable: %+v", removed)
	}
	if _, err := syncGitWorker(t, tools, map[string]any{"root": replica, "before": removed, "desired": before, "backup": "refs/chisa/recovery/removal-retry"}, ""); err != nil {
		t.Fatal(err)
	}
	if err := applyLocalGitState(context.Background(), &local, before, desired); err != nil {
		t.Fatal(err)
	}
	// Both readers retain independently changed staging as part of the state.
	syncSeedWrite(t, replica, "independent.txt", "new staged edit\n")
	tools.gitRun(t, replica, "add", "independent.txt")
	changed = syncGitWorkerRead(t, tools, replica)
	if gitTransitionMatches(changed, before, desired) {
		t.Fatal("independent staging treated as pending transition")
	}
}

func TestGitSyncRebaseMetadataContinuesAfterHandback(t *testing.T) {
	tools, source, replica, before := syncGitConflictFixture(t)
	ctx := context.Background()
	tools.gitRun(t, source.LocalPath, "checkout", "topic")
	// The receiver has never checked out topic. Its missing local branch must
	// still permit the received operation to continue with Git's ref checks.
	local := *source
	local.LocalPath = replica
	before, err := readLocalGitState(ctx, &local)
	if err != nil {
		t.Fatal(err)
	}
	syncGitExpectFailure(t, tools, source.LocalPath, "rebase", "main")
	desired, err := readLocalGitState(ctx, source)
	if err != nil || desired.Branch != "" {
		t.Fatalf("rebase detached state missing: %+v %v", desired, err)
	}
	operations, err := decodeGitOperations(desired.Operations)
	if err != nil || !operations["rebase-merge"].directory {
		t.Fatalf("rebase directory not captured: %v %v", operations, err)
	}
	// Exercise empty directories and binary metadata without relying on JSON
	// text normalization. Git safely ignores these ancillary operation files.
	syncSeedWrite(t, source.LocalPath, ".git/rebase-merge/chisa-binary", "\x00\xff\r\n")
	if err := os.Mkdir(filepath.Join(source.LocalPath, ".git", "rebase-merge", "chisa-empty"), 0700); err != nil {
		t.Fatal(err)
	}
	desired, err = readLocalGitState(ctx, source)
	if err != nil {
		t.Fatal(err)
	}
	syncGitTransferForTest(t, tools, source, replica, desired)
	if _, err := syncGitWorker(t, tools, map[string]any{"root": replica, "before": before, "desired": desired, "backup": "refs/chisa/recovery/rebase"}, "interrupt-rebase"); err == nil {
		t.Fatal("rebase metadata interruption did not fire")
	}
	partial := syncGitWorkerRead(t, tools, replica)
	if !gitTransitionMatches(partial, before, desired) {
		t.Fatalf("partial rebase not resumable: %+v", partial)
	}
	if err := applyLocalGitState(ctx, &local, partial, desired); err != nil {
		t.Fatal(err)
	}
	if actual := syncGitWorkerRead(t, tools, replica); actual != desired {
		t.Fatalf("Go/Python rebase state mismatch: %+v", actual)
	}
	syncSeedWrite(t, replica, " conflict space.txt", "resolved rebase\n")
	tools.gitRun(t, replica, "add", " conflict space.txt")
	tools.gitRun(t, replica, "-c", "core.editor=true", "rebase", "--continue")
	resolved, err := readLocalGitState(ctx, &local)
	if err != nil || resolved.Branch != "refs/heads/topic" || strings.HasPrefix(resolved.Index, syncGitStagesPrefix) {
		t.Fatalf("rebase could not continue using received metadata: %+v %v", resolved, err)
	}
	remaining, err := decodeGitOperations(resolved.Operations)
	if err != nil {
		t.Fatal(err)
	}
	if _, active := remaining["rebase-merge"]; active {
		t.Fatal("rebase completion retained active operation directory")
	}
	// Reverse direction uses the Python snapshot path, including ORIG_HEAD, and
	// native application removes the original owner's unfinished operation.
	ref := "refs/chisa/transfer/resolved-rebase"
	if _, err := syncGitWorker(t, tools, map[string]any{"root": replica, "op": "snapshot", "state": resolved, "backup": ref}, ""); err != nil {
		t.Fatal(err)
	}
	tools.gitRun(t, source.LocalPath, "fetch", "--no-tags", replica, ref)
	original := strings.TrimSpace(operations["rebase-merge/orig-head"].content)
	// A separately moved inactive target must not receive the rebase exception.
	unrelated := tools.gitRun(t, source.LocalPath, "commit-tree", "main^{tree}", "-p", "main", "-m", "independent inactive branch")
	tools.gitRun(t, source.LocalPath, "update-ref", "refs/heads/topic", unrelated, original)
	if err := applyLocalGitState(ctx, source, desired, resolved); err == nil {
		t.Fatal("rebase exception overwrote an independently moved target")
	}
	if _, err := syncGitWorker(t, tools, map[string]any{"root": source.LocalPath, "before": desired, "desired": resolved, "backup": "refs/chisa/recovery/rebase-independent"}, ""); err == nil {
		t.Fatal("worker rebase exception overwrote an independent target")
	}
	tools.gitRun(t, source.LocalPath, "update-ref", "refs/heads/topic", original, unrelated)
	if err := applyLocalGitState(ctx, source, desired, resolved); err != nil {
		t.Fatal(err)
	}
	if actual, err := readLocalGitState(ctx, source); err != nil || actual != resolved {
		t.Fatalf("resolved rebase reverse handback failed: %+v %v", actual, err)
	}
	// Recreate only metadata (no checkout) to verify the symmetric worker path.
	if err := applyLocalGitState(ctx, source, resolved, desired); err != nil {
		t.Fatal(err)
	}
	if got := tools.gitRun(t, source.LocalPath, "rev-parse", "refs/heads/topic"); got != original {
		t.Fatalf("active rebase did not restore original branch: %s", got)
	}
	if _, err := syncGitWorker(t, tools, map[string]any{"root": source.LocalPath, "before": desired, "desired": resolved, "backup": "refs/chisa/recovery/rebase-complete"}, ""); err != nil {
		t.Fatalf("worker rejected completed rebase: %v", err)
	}
}

func TestGitSyncMergeAutostashContinuesAndAborts(t *testing.T) {
	for _, action := range []string{"continue", "abort"} {
		t.Run(action, func(t *testing.T) {
			tools, source, replica, before := syncGitConflictFixture(t)
			private := "private owner edit retained after " + action + "\n"
			syncSeedWrite(t, source.LocalPath, "clean.txt", private)
			syncGitExpectFailure(t, tools, source.LocalPath, "merge", "--autostash", "topic")
			desired, err := readLocalGitState(context.Background(), source)
			if err != nil {
				t.Fatal(err)
			}
			operations, err := decodeGitOperations(desired.Operations)
			autostash := strings.TrimSpace(operations["MERGE_AUTOSTASH"].content)
			if err != nil || !syncGitOID.MatchString(autostash) {
				t.Fatalf("autostash marker not captured: %q %v", autostash, err)
			}
			if actual := syncGitWorkerRead(t, tools, source.LocalPath); actual != desired {
				t.Fatal("autostash native/worker state differs")
			}
			if _, _, err := tools.command(t, nil, tools.git, "-C", replica, "cat-file", "-e", autostash); err == nil {
				t.Fatal("replica already has private autostash object before transfer")
			}
			if action == "continue" {
				syncGitTransferForTest(t, tools, source, replica, desired)
			} else {
				ref := "refs/chisa/transfer/autostash-abort"
				if _, err := syncGitWorker(t, tools, map[string]any{"root": source.LocalPath, "op": "snapshot", "state": desired, "backup": ref}, ""); err != nil {
					t.Fatal(err)
				}
				tools.gitRun(t, replica, "fetch", "--no-tags", source.LocalPath, ref)
			}
			if got := tools.gitRun(t, replica, "show", autostash+":clean.txt"); got != strings.TrimSpace(private) {
				t.Fatalf("private autostash bytes were not transferred: %q", got)
			}
			// Simulate Mutagen's separately owned file transfer before continuing
			// Git. The metadata apply itself must leave those bytes untouched.
			for _, name := range []string{" conflict space.txt", "clean.txt"} {
				data, err := os.ReadFile(filepath.Join(source.LocalPath, name))
				if err != nil {
					t.Fatal(err)
				}
				syncSeedWrite(t, replica, name, string(data))
			}
			worktree := syncSeedSnapshot(t, replica, true)
			local := *source
			local.LocalPath = replica
			if action == "continue" {
				if _, err := syncGitWorker(t, tools, map[string]any{"root": replica, "before": before, "desired": desired, "backup": "refs/chisa/recovery/autostash-continue"}, ""); err != nil {
					t.Fatal(err)
				}
			} else if err := applyLocalGitState(context.Background(), &local, before, desired); err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(worktree, syncSeedSnapshot(t, replica, true)) || syncGitWorkerRead(t, tools, replica) != desired {
				t.Fatal("autostash metadata apply altered worktree or state")
			}
			if action == "continue" {
				syncSeedWrite(t, replica, " conflict space.txt", "resolved autostash merge\n")
				tools.gitRun(t, replica, "add", " conflict space.txt")
			}
			tools.gitRun(t, replica, "-c", "core.editor=true", "merge", "--"+action)
			if content, err := os.ReadFile(filepath.Join(replica, "clean.txt")); err != nil || string(content) != private {
				t.Fatalf("merge --%s lost private owner edit: %q %v", action, content, err)
			}
			settled, err := readLocalGitState(context.Background(), &local)
			if err != nil {
				t.Fatal(err)
			}
			remaining, err := decodeGitOperations(settled.Operations)
			if err != nil {
				t.Fatal(err)
			}
			if _, active := remaining["MERGE_AUTOSTASH"]; active {
				t.Fatal("merge completion retained autostash marker")
			}
			if strings.HasPrefix(settled.Index, syncGitStagesPrefix) {
				t.Fatal("merge completion retained unmerged stages")
			}
		})
	}
}

func TestGitSyncRebaseUpdateRefsRejectedBeforeHandback(t *testing.T) {
	tools, source, replica, before := syncGitConflictFixture(t)
	ctx := context.Background()
	tools.gitRun(t, source.LocalPath, "checkout", "topic")
	tools.gitRun(t, source.LocalPath, "branch", "middle")
	syncSeedWrite(t, source.LocalPath, "later.txt", "later topic commit\n")
	tools.gitRun(t, source.LocalPath, "add", "later.txt")
	tools.gitRun(t, source.LocalPath, "commit", "-m", "later topic")
	syncGitExpectFailure(t, tools, source.LocalPath, "rebase", "--update-refs", "main")
	record, err := os.ReadFile(filepath.Join(source.LocalPath, ".git", "rebase-merge", "update-refs"))
	if err != nil || !bytes.Contains(record, []byte("refs/heads/middle")) {
		t.Fatalf("actual --update-refs fixture missing middle branch: %q %v", record, err)
	}
	original := syncSeedSnapshot(t, source.LocalPath, false)
	desired, err := readLocalGitState(ctx, source)
	if err == nil || !strings.Contains(err.Error(), "--update-refs") || desired.Operations == "" {
		t.Fatalf("native read did not explicitly reject unsupported rebase: %+v %v", desired, err)
	}
	if _, err := syncGitWorker(t, tools, map[string]any{"root": source.LocalPath, "op": "read"}, ""); err == nil || !strings.Contains(err.Error(), "--update-refs") {
		t.Fatalf("worker read did not explicitly reject unsupported rebase: %v", err)
	}
	// State supplied directly or retained in a pending checkpoint must also be
	// rejected before creating a journal or transfer snapshot.
	if _, err := selectGitState(ctx, source, &syncGitCheckpoint{}, desired, desired); err == nil || !strings.Contains(err.Error(), "--update-refs") {
		t.Fatalf("equal unsupported endpoints bypassed validation: %v", err)
	}
	if _, err := selectGitState(ctx, source, &syncGitCheckpoint{Pending: &syncGitPending{Local: before, Remote: desired, Desired: desired}}, before, before); err == nil || !strings.Contains(err.Error(), "--update-refs") {
		t.Fatalf("pending unsupported state bypassed validation: %v", err)
	}
	if _, err := localGitSnapshot(ctx, source, desired, "refs/chisa/transfer/rejected-update-refs"); err == nil || !strings.Contains(err.Error(), "--update-refs") {
		t.Fatalf("native snapshot accepted unsupported operation: %v", err)
	}
	if _, err := syncGitWorker(t, tools, map[string]any{"root": source.LocalPath, "op": "snapshot", "state": desired, "backup": "refs/chisa/transfer/rejected-update-refs-worker"}, ""); err == nil || !strings.Contains(err.Error(), "--update-refs") {
		t.Fatalf("worker snapshot accepted unsupported operation: %v", err)
	}
	local := *source
	local.LocalPath = replica
	receiverOriginal := syncSeedSnapshot(t, replica, true)
	indexOriginal, err := os.ReadFile(filepath.Join(replica, ".git", "index"))
	if err != nil {
		t.Fatal(err)
	}
	if err := applyLocalGitState(ctx, &local, before, desired); err == nil || !strings.Contains(err.Error(), "--update-refs") {
		t.Fatalf("native apply accepted unsupported operation: %v", err)
	}
	if _, err := syncGitWorker(t, tools, map[string]any{"root": replica, "before": before, "desired": desired, "backup": "refs/chisa/recovery/rejected-update-refs"}, ""); err == nil || !strings.Contains(err.Error(), "--update-refs") {
		t.Fatalf("worker apply accepted unsupported operation: %v", err)
	}
	if actual := syncGitWorkerRead(t, tools, replica); actual != before {
		t.Fatal("rejected operation changed receiver Git state")
	}
	indexAfter, err := os.ReadFile(filepath.Join(replica, ".git", "index"))
	if err != nil || !bytes.Equal(indexOriginal, indexAfter) || !reflect.DeepEqual(receiverOriginal, syncSeedSnapshot(t, replica, true)) {
		t.Fatal("rejected operation changed receiver index or worktree")
	}
	// Guard files are the only auxiliary entries readers may create.
	after := syncSeedSnapshot(t, source.LocalPath, false)
	delete(after, ".git/index.chisa-guard")
	delete(original, ".git/index.chisa-guard")
	if !reflect.DeepEqual(original, after) {
		t.Fatal("rejecting --update-refs changed original repository data")
	}
}

func TestGitSyncConflictStateSafetyAndLegacyJSON(t *testing.T) {
	var old syncGitState
	if err := json.Unmarshal([]byte(`{"head":"abc","branch":"refs/heads/main","index":"tree"}`), &old); err != nil || old.Operations != "" {
		t.Fatalf("old checkpoint JSON incompatible: %+v %v", old, err)
	}
	encoded, err := json.Marshal(old)
	if err != nil || bytes.Contains(encoded, []byte("operations")) {
		t.Fatalf("clean JSON format changed: %s %v", encoded, err)
	}
	inert := old
	inert.Operations = encodeGitOperations(map[string]syncGitOperationEntry{"ORIG_HEAD": {content: strings.Repeat("a", 40) + "\n"}})
	if !gitLegacyCheckpointEqual(inert, old, 0) || gitLegacyCheckpointEqual(inert, old, 2) {
		t.Fatal("legacy inert-operation migration was not version limited")
	}
	active := inert
	active.Operations = encodeGitOperations(map[string]syncGitOperationEntry{"MERGE_HEAD": {content: strings.Repeat("b", 40) + "\n"}})
	if gitLegacyCheckpointEqual(active, old, 0) || gitCheckpointTransitionMatches(active, old, old, 0) {
		t.Fatal("legacy checkpoint migration swallowed an active operation")
	}
	if !gitCheckpointTransitionMatches(inert, old, old, 0) || gitCheckpointTransitionMatches(inert, old, old, 2) {
		t.Fatal("legacy pending journal compatibility was not version limited")
	}
	for _, name := range []string{"../HEAD", "HEAD", "rebase-merge/../HEAD", "rebase-apply/../../config", "/MERGE_HEAD", "rebase-merge\\config"} {
		value := encodeGitOperations(map[string]syncGitOperationEntry{name: {content: "malicious"}})
		if _, err := decodeGitOperations(value); err == nil {
			t.Fatalf("unsafe metadata path accepted: %s", name)
		}
	}
	tools, source, _, _ := syncGitConflictFixture(t)
	if err := os.Mkdir(filepath.Join(source.LocalPath, ".git", "rebase-merge"), 0700); err != nil {
		t.Fatal(err)
	}
	syncSeedWrite(t, source.LocalPath, ".git/rebase-merge/extra", "independent")
	state, err := readLocalGitState(context.Background(), source)
	if err != nil {
		t.Fatal(err)
	}
	// Initial synchronization cannot overwrite a separately begun operation just
	// because its tree still matches HEAD and there is no old Git checkpoint.
	clean := state
	clean.Operations = ""
	ctx := context.WithValue(context.Background(), syncGitSourceKey{}, "remote")
	if _, err := selectGitState(ctx, source, &syncGitCheckpoint{}, state, clean); err == nil {
		t.Fatal("initial handback overwrote an independent operation")
	}
	if actual := syncGitWorkerRead(t, tools, source.LocalPath); actual != state {
		t.Fatal("operation read parity failed")
	}
}
