//go:build windows

package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"
)

// This CLI mode gives a complete pipeline a real, exact-session flush followed
// by one fresh IDE-edit cycle. No actual daemon or project is touched.
func init() {
	if os.Getenv("CHISA_CONNECTION_TEST_TOOL") != "watching-wait" {
		return
	}
	args := os.Args[1:]
	fail := func(err error) { fmt.Fprintln(os.Stderr, err); os.Exit(94) }
	if len(args) == 1 && args[0] == "version" {
		fmt.Println(workspaceSyncEngineVersion)
		os.Exit(0)
	}
	encoded, err := json.Marshal(args)
	if err != nil {
		fail(err)
	}
	log, err := os.OpenFile(os.Getenv("CHISA_CONNECTION_TEST_TOOL_LOG"), os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0600)
	if err != nil {
		fail(err)
	}
	_, err = fmt.Fprintln(log, string(encoded))
	if closeErr := log.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		fail(err)
	}
	raw, err := os.ReadFile(os.Getenv("CHISA_POLICY_GUARD_SESSIONS"))
	if err != nil {
		fail(err)
	}
	var sessions []syncSession
	if err = json.Unmarshal(raw, &sessions); err != nil {
		fail(err)
	}
	marker := os.Getenv("CHISA_WATCHING_WAIT_MARKER")
	if len(args) >= 2 && args[0] == "sync" && args[1] == "list" {
		if _, err = os.Stat(marker); err == nil && len(sessions) == 1 {
			// The first query after the already successful explicit flush catches
			// a new scan; subsequent observations see its normal completion.
			sessions[0].Status, sessions[0].Alpha.Scanned = "scanning", false
			if err = os.Rename(marker, marker+".observed"); err != nil {
				fail(err)
			}
		}
		encoded, err = json.Marshal(sessions)
		if err != nil {
			fail(err)
		}
		fmt.Println("CHISA_SYNC_JSON:" + string(encoded))
		os.Exit(0)
	}
	if len(args) == 3 && args[0] == "sync" && args[1] == "flush" && len(sessions) == 1 && args[2] == sessions[0].Identifier {
		if err = os.WriteFile(marker, []byte("new IDE edit after flush"), 0600); err != nil {
			fail(err)
		}
		os.Exit(0)
	}
	fail(fmt.Errorf("healthy edit reached an unexpected mutation: %q", args))
}

func TestSyncWatchingWaitsForHealthyEditCycleWithoutMutations(t *testing.T) {
	fixture := newSyncPolicyGuardFixture(t)
	m := fixture.mapping
	for _, status := range []string{"scanning", "reconciling", "staging", "transitioning", "saving", "waiting-for-rescan"} {
		t.Run(status, func(t *testing.T) {
			busy := fixture.session()
			busy.Status, busy.Alpha.Scanned = status, false
			ready := fixture.session()
			ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
			defer cancel()
			observations := 0
			if err := waitSyncWatchingContext(ctx, m, busy, func() ([]syncSession, error) {
				observations++
				return []syncSession{ready}, nil
			}); err != nil {
				t.Fatalf("healthy cycle did not converge: %v", err)
			}
			if observations != 1 {
				t.Fatalf("expected one next frame, got %d", observations)
			}
		})
	}
	if calls := fixture.calls(); len(calls) != 0 {
		t.Fatalf("waiting touched the CLI: %v", calls)
	}
}

func TestSyncWatchingWaitDoesNotAdmitPolicyRetryBeforeRevalidation(t *testing.T) {
	fixture := newSyncPolicyGuardFixture(t)
	waiting := fixture.session()
	waiting.Status = "waiting-for-rescan"
	waiting.LastError = ""
	// A prior successful cycle is not evidence that the current policy retry
	// completed. Even retaining both scanned flags must not admit handoff.
	if state := syncSessionInfo(waiting); state.Status != "checking" {
		t.Fatalf("policy revalidation was presented as ready: %+v", state)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	observed := make(chan struct{})
	revalidate := make(chan struct{})
	result := make(chan error, 1)
	go func() {
		result <- waitSyncWatchingContext(ctx, fixture.mapping, waiting, func() ([]syncSession, error) {
			close(observed)
			select {
			case <-ctx.Done():
				return nil, ctx.Err()
			case <-revalidate:
			}
			ready := fixture.session()
			ready.SuccessfulCycles = waiting.SuccessfulCycles + 1
			return []syncSession{ready}, nil
		})
	}()
	select {
	case err := <-result:
		t.Fatalf("policy retry returned before fresh confirmation: %v", err)
	case <-observed:
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	select {
	case err := <-result:
		t.Fatalf("pending revalidation admitted handoff: %v", err)
	default:
	}
	close(revalidate)
	select {
	case err := <-result:
		if err != nil {
			t.Fatalf("fresh confirmed cycle did not admit handoff: %v", err)
		}
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	// If revalidation never succeeds, cancellation must end the wait instead of
	// converting the older successful cycle into a new readiness receipt.
	pendingContext, cancelPending := context.WithTimeout(context.Background(), 250*time.Millisecond)
	defer cancelPending()
	pendingObservations := 0
	if err := waitSyncWatchingContext(pendingContext, fixture.mapping, waiting, func() ([]syncSession, error) {
		pendingObservations++
		return []syncSession{waiting}, nil
	}); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("unfinished policy retry returned without cancellation: %v", err)
	}
	if pendingObservations == 0 {
		t.Fatal("unfinished retry was not actually observed")
	}
	fixture.requireQueriesOnly()
}

func TestSyncWatchingWaitPreservesFailureAndIdentityBarriers(t *testing.T) {
	fixture := newSyncPolicyGuardFixture(t)
	for _, kind := range []string{"paused", "halted", "conflict", "scan-problem", "error", "disconnected", "no-cycle", "mode", "vcs", "replacement", "endpoint", "query-error"} {
		t.Run(kind, func(t *testing.T) {
			busy, next := fixture.session(), fixture.session()
			busy.Status = "scanning"
			switch kind {
			case "paused":
				next.Paused = true
			case "halted":
				next.Status = "halted-on-root-emptied"
			case "conflict":
				next.ExcludedConflicts = 1
			case "scan-problem":
				next.Alpha.ScanProblems = []syncProblem{{Path: "code.txt", Error: "unreadable"}}
			case "error":
				next.LastError = "endpoint failed"
			case "disconnected":
				next.Beta.Connected = false
			case "no-cycle":
				next.SuccessfulCycles = 0
			case "mode":
				next.Mode = "one-way-replica"
			case "vcs":
				next.Ignore.VCS = false
			case "replacement":
				next.Identifier += "-replacement"
			case "endpoint":
				next.Beta.Path += "-replacement"
			}
			ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
			defer cancel()
			if err := waitSyncWatchingContext(ctx, fixture.mapping, busy, func() ([]syncSession, error) {
				if kind == "query-error" {
					return nil, errors.New("observation unavailable")
				}
				return []syncSession{next}, nil
			}); err == nil {
				t.Fatalf("%s escaped the final confirmation", kind)
			}
		})
	}
	fixture.requireQueriesOnly()
}

func TestSyncWatchingWaitHonorsCancellation(t *testing.T) {
	fixture := newSyncPolicyGuardFixture(t)
	busy := fixture.session()
	busy.Status = "scanning"
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := waitSyncWatchingContext(ctx, fixture.mapping, busy, func() ([]syncSession, error) {
		t.Fatal("canceled confirmation queried another frame")
		return nil, nil
	}); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancellation lost: %v", err)
	}
	ctx, deadline := context.WithTimeout(context.Background(), 30*time.Millisecond)
	defer deadline()
	if err := waitSyncWatchingContext(ctx, fixture.mapping, busy, func() ([]syncSession, error) {
		t.Fatal("deadline did not stop waiting")
		return nil, nil
	}); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("deadline lost: %v", err)
	}
}

func TestSyncPipelineKeepsWatcherRunningAfterPostFlushEdit(t *testing.T) {
	fixture := newSyncPolicyGuardFixture(t)
	m := fixture.mapping
	fixture.setSessions(fixture.session())
	t.Setenv("CHISA_CONNECTION_TEST_TOOL", "watching-wait")
	t.Setenv("CHISA_WATCHING_WAIT_MARKER", fixture.statePath+".cycle")
	previousObserver := observeSyncGitRemoteMetadata
	observeSyncGitRemoteMetadata = func(context.Context, *Mapping) (syncMetadataObservation, error) {
		return syncMetadataObservation{Git: "stable-file-only-remote"}, nil
	}
	t.Cleanup(func() { observeSyncGitRemoteMetadata = previousObserver })
	remoteLeaseContext = func(context.Context, *Mapping, string, string, string) (map[string]any, error) {
		return map[string]any{"ok": true, "lease": map[string]any{"owner": "sync", "id": "fixture", "epoch": m.BindingEpoch}}, nil
	}
	pauseProjectSync = pauseProjectSyncContext
	syncMonitor.Lock()
	previousClosed := syncMonitor.closed
	syncMonitor.closed = true
	syncMonitor.Unlock()
	t.Cleanup(func() { syncMonitor.Lock(); syncMonitor.closed = previousClosed; syncMonitor.Unlock() })
	ctx, cancel := context.WithTimeout(syncLeaseContext(context.Background(), "fixture"), 30*time.Second)
	defer cancel()
	if err := syncProjectContentsContext(ctx, m, false); err != nil {
		t.Fatalf("post-flush ordinary edit failed pipeline: %v", err)
	}
	if _, err := os.Stat(fixture.statePath + ".cycle.observed"); err != nil {
		t.Fatalf("new cycle was not exercised: %v", err)
	}
	counts := map[string]int{}
	for _, args := range fixture.calls() {
		if len(args) > 1 {
			counts[args[1]]++
		}
	}
	if counts["flush"] != 1 || counts["pause"] != 0 || counts["resume"] != 0 || counts["update-ignores"] != 0 {
		t.Fatalf("ordinary postflush edit restarted endpoints: %v", counts)
	}
	if status := syncOperationInfo(m); status.Status != "ready" || strings.Contains(status.Detail, "中断") {
		t.Fatalf("healthy pipeline remained blocked: %+v", status)
	}
}
