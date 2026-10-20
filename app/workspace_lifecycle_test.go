//go:build windows

package main

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestWorkspaceDeadlineAndCanceledLock(t *testing.T) {
	request := httptest.NewRequest(http.MethodPost, "/workspace/rpc", nil)
	requested := time.Now().Add(3 * time.Second).Truncate(time.Millisecond)
	request.Header.Set(workspaceDeadlineHeader, strconv.FormatInt(requested.UnixMilli(), 10))
	ctx, cancel, err := workspaceRequestContext(request)
	if err != nil {
		t.Fatal(err)
	}
	defer cancel()
	if deadline, _ := ctx.Deadline(); !deadline.Equal(requested) {
		t.Fatal("a native stage extended the caller's total deadline")
	}
	request.Header.Set(workspaceDeadlineHeader, strconv.FormatInt(time.Now().Add(time.Hour).UnixMilli(), 10))
	bounded, stop, err := workspaceRequestContext(request)
	if err != nil {
		t.Fatal(err)
	}
	defer stop()
	if deadline, _ := bounded.Deadline(); time.Until(deadline) > workspaceSyncTimeout {
		t.Fatal("caller extended the native maximum budget")
	}
	request.Header.Set(workspaceDeadlineHeader, "invalid")
	if _, _, err = workspaceRequestContext(request); err == nil {
		t.Fatal("invalid absolute deadline accepted")
	}
	var mu sync.Mutex
	mu.Lock()
	waitCtx, stopWait := context.WithCancel(context.Background())
	result := make(chan error, 1)
	go func() {
		unlock, err := lockContext(waitCtx, &mu)
		if unlock != nil {
			unlock()
		}
		result <- err
	}()
	stopWait()
	select {
	case err := <-result:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("canceled lock waiter = %v", err)
		}
	case <-time.After(time.Second):
		mu.Unlock()
		t.Fatal("canceled waiter remained blocked on prior mutation")
	}
	mu.Unlock()
	acquireCtx, stopAcquire := context.WithTimeout(context.Background(), time.Second)
	defer stopAcquire()
	unlock, err := lockContext(acquireCtx, &mu)
	if err != nil {
		t.Fatal("canceled waiter retained the workspace mutex:", err)
	}
	unlock()
}

func TestWorkspaceBridgeTotalDeadlineAndBodyCancel(t *testing.T) {
	headers := make(chan int64, 1)
	reviewHTTP(t, func(w http.ResponseWriter, r *http.Request) {
		milliseconds, _ := strconv.ParseInt(r.Header.Get(workspaceDeadlineHeader), 10, 64)
		headers <- milliseconds
		w.WriteHeader(http.StatusOK)
		w.(http.Flusher).Flush()
		<-r.Context().Done()
	})
	bridge := FrontendBridge{}
	id := bridge.BeginServerRequest()
	value, _ := bridgeRequests.Load(id)
	pending := value.(*bridgeRequest)
	deadline, _ := pending.ctx.Deadline()
	if remaining := time.Until(deadline); remaining < serverRequestTimeout-time.Second || remaining > serverRequestTimeout {
		t.Fatal("desktop REST does not share the agreed total budget")
	}
	result := make(chan BridgeResponse, 1)
	go func() {
		result <- bridge.ServerRequest(id, http.MethodGet, "/api/slow-body", map[string]string{workspaceDeadlineHeader: "1"}, "")
	}()
	select {
	case actual := <-headers:
		if actual != deadline.UnixMilli() {
			t.Fatal("forwarded deadline was overwritten by caller headers or a new budget")
		}
	case <-time.After(time.Second):
		t.Fatal("HTTP body fixture did not start")
	}
	bridge.CancelServerRequest(id)
	select {
	case response := <-result:
		if response.Status != 499 {
			t.Fatalf("body cancellation returned %d", response.Status)
		}
	case <-time.After(time.Second):
		t.Fatal("headers completed but HTTP body ignored the total cancellation")
	}
}

func TestWorkspaceFolderOpenImportBudget(t *testing.T) {
	for _, test := range []struct {
		name         string
		mode         string
		budget       time.Duration
		callerLimit  time.Duration
		cancelDuring bool
	}{
		{name: "retry-initial-import", budget: workspaceImportTimeout},
		{name: "established-workspace", mode: "vps", budget: workspaceSyncTimeout},
		{name: "earlier-caller-deadline", budget: 3 * time.Second, callerLimit: 3 * time.Second},
		{name: "account-cancellation", budget: workspaceImportTimeout, cancelDuring: true},
	} {
		t.Run(test.name, func(t *testing.T) {
			m := isolatePi(t)
			isolateWorkspaceSyncTransport(t)
			m.Mode = test.mode
			connection := apiConnection
			setup := &accountWorkspaceSetup{done: make(chan struct{})}
			close(setup.done)
			connection.workspaceSetup = setup
			var cancelParent context.CancelFunc
			if test.callerLimit > 0 {
				connection.ctx, cancelParent = context.WithTimeout(connection.ctx, test.callerLimit)
			} else {
				connection.ctx, cancelParent = context.WithCancel(connection.ctx)
			}
			defer cancelParent()
			previousPause := pauseProjectSync
			t.Cleanup(func() {
				pauseProjectSync = previousPause
				syncStates.Delete(m.ServerPath)
			})
			stopped := errors.New("budget observed before remote writes")
			observed := false
			pauseProjectSync = func(ctx context.Context, _ *Mapping) error {
				observed = true
				deadline, ok := ctx.Deadline()
				remaining := time.Until(deadline)
				if !ok || remaining > test.budget || remaining < test.budget-time.Second {
					t.Fatalf("folder-open synchronization budget = %s, want %s", remaining, test.budget)
				}
				if test.cancelDuring {
					cancelParent()
					select {
					case <-ctx.Done():
					case <-time.After(time.Second):
						t.Fatal("initial import ignored account cancellation")
					}
					return ctx.Err()
				}
				return stopped
			}
			result := prepareLocalProject(m.LocalPath)
			if !observed || result["ok"] != false {
				t.Fatalf("folder open did not reach bounded synchronization: %v", result)
			}
		})
	}
}

func TestWorkspaceManualReleaseAndExactRecovery(t *testing.T) {
	m := isolatePi(t)
	isolateWorkspaceSyncTransport(t)
	m.ServerID = serverIdentity(store.config())
	m.SyncName = "manual-unit"
	previousPause := pauseProjectSync
	pauseProjectSync = func(context.Context, *Mapping) error { return nil }
	t.Cleanup(func() {
		pauseProjectSync = previousPause
		pendingSyncReleases.Delete(m.ServerPath)
		syncStates.Delete(m.ServerPath)
	})
	var claimed, released []string
	var lease map[string]any
	failRelease := true
	remoteLeaseContext = func(ctx context.Context, actual *Mapping, op, owner, id string) (map[string]any, error) {
		if actual.BindingEpoch != m.BindingEpoch {
			t.Fatal("lease operation crossed binding")
		}
		if _, ok := ctx.Deadline(); !ok && op != "release" {
			t.Fatal("business stage lost its total context")
		}
		switch op {
		case "read":
			return map[string]any{"ok": true, "lease": lease}, nil
		case "recover":
			claimed = append(claimed, id)
			lease = map[string]any{"id": id, "epoch": actual.BindingEpoch, "owner": "sync"}
		case "release":
			if owner != "sync" || lease == nil || lease["id"] != id || lease["epoch"] != actual.BindingEpoch {
				t.Fatal("release did not match the exact owned synchronization lease")
			}
			released = append(released, id)
			if failRelease {
				return nil, errors.New("remote release failed")
			}
			lease = nil
		}
		return map[string]any{"ok": true}, nil
	}
	synchronizeProjectContext = func(ctx context.Context, _ *Mapping, _ bool) error {
		if id, _ := ctx.Value(syncLeaseContextKey{}).(string); len(claimed) == 0 || id != claimed[len(claimed)-1] {
			t.Fatal("synchronization did not carry its claimed lease")
		}
		return errors.New("Git synchronization failure")
	}
	result := (FrontendBridge{}).SyncProject(m.ServerPath)
	if result["ok"] != false || result["code"] != "WORKSPACE_RELEASE_FAILED" || syncOperationInfo(m).Status != "blocked" {
		t.Fatalf("deferred release error was discarded: %v", result)
	}
	pending, ok := pendingSyncReleases.Load(m.ServerPath)
	if !ok || pending.(pendingSyncRelease).id != claimed[0] || pending.(pendingSyncRelease).epoch != m.BindingEpoch {
		t.Fatal("finished local operation lost its exact recovery identity")
	}
	failRelease = false
	result = (FrontendBridge{}).SyncProject(m.ServerPath)
	if result["ok"] != false || !strings.Contains(fmt.Sprint(result["error"]), "Git synchronization failure") {
		t.Fatal("recovery masked the remaining synchronization failure")
	}
	if len(claimed) != 2 || len(released) != 3 || released[1] != claimed[0] || released[2] != claimed[1] {
		t.Fatal("manual recovery did not release only its old exact lease before a new claim")
	}
	if _, exists := pendingSyncReleases.Load(m.ServerPath); exists {
		t.Fatal("confirmed release left the pending recovery record")
	}
	pendingSyncReleases.Store(m.ServerPath, pendingSyncRelease{id: "another-binding", epoch: "old"})
	before := len(released)
	if result := (FrontendBridge{}).SyncProject(m.ServerPath); result["ok"] != false || len(released) != before {
		t.Fatal("manual recovery stole a different binding's reservation")
	}
}

func TestWorkspaceSyncReleasedReservation(t *testing.T) {
	isolatePi(t)
	m, session, _ := isolateSyncObserver(t)
	isolateWorkspaceSyncTransport(t)
	syncMonitor.Lock()
	syncMonitor.sessions = []syncSession{session}
	syncMonitor.Unlock()
	t.Cleanup(func() {
		cloudReservations.Delete(m.ServerPath)
		workspaceLocks.Delete(m.ServerPath)
	})
	id := "release-current"
	lease := map[string]any{"id": id, "epoch": m.BindingEpoch, "owner": "claude"}
	var readFailure error
	releases := 0
	remoteLeaseContext = func(_ context.Context, actual *Mapping, op, owner, actualID string) (map[string]any, error) {
		if actual.ServerPath != m.ServerPath {
			t.Fatal("release confirmation used a different project or ownership operation")
		}
		if op == "release" {
			if owner != "sync-needed" || actualID != id || lease == nil || lease["id"] != id || lease["owner"] != owner {
				t.Fatal("handback did not use the exact guarded synchronization-needed release")
			}
			releases++
			lease = nil
			return map[string]any{"ok": true}, nil
		}
		if op != "read" {
			t.Fatal("unexpected ownership operation", op)
		}
		if readFailure != nil {
			return nil, readFailure
		}
		if lease == nil {
			return map[string]any{"ok": true, "lease": nil}, nil
		}
		return map[string]any{"ok": true, "lease": lease}, nil
	}
	synchronized := 0
	synchronizeProjectContext = func(_ context.Context, actual *Mapping, pause bool) error {
		synchronized++
		if pause != (synchronized == 1) {
			t.Fatal("task preparation and return synchronization exchanged their pause contract")
		}
		finish := beginSyncOperation(actual, "syncing")
		defer finish()
		setSyncInfo(actual, "ready", "")
		if info := observedProjectSync(m.ServerPath); info.Status != "syncing" || info.TaskOwner != "claude" {
			t.Fatalf("an active synchronization reported send readiness: %+v", info)
		}
		return nil
	}
	for _, op := range []string{"sync_begin", "sync_end"} {
		if op == "sync_end" {
			lease["owner"] = "sync-needed"
		}
		response := workspaceRPCContext(context.Background(), m, map[string]any{"op": op, "runId": id, "changed": true})
		if response["ok"] != true {
			t.Fatalf("%s failed: %v", op, response)
		}
		if info := observedProjectSync(m.ServerPath); info.Status != "reserved" || info.TaskOwner != "claude" {
			t.Fatalf("%s exposed ready before the server released its lease: %+v", op, info)
		}
	}
	if synchronized != 2 || releases != 1 || lease != nil {
		t.Fatal("task preparation, synchronization or guarded handback was bypassed")
	}
	notify := func() map[string]any {
		return workspaceRPCContext(context.Background(), m, map[string]any{"op": "sync_released", "runId": id})
	}
	reserved := observedProjectSync(m.ServerPath)
	if value, ok := cloudReservations.Load(m.ServerPath); !ok || value != id || reserved.Status != "reserved" {
		t.Fatal("atomic release removed the readiness reservation before notification")
	}
	if response := notify(); response["ok"] != true {
		t.Fatalf("confirmed matching release failed: %v", response)
	}
	ready := observedProjectSync(m.ServerPath)
	if _, ok := cloudReservations.Load(m.ServerPath); ok || ready.Status != "ready" || ready.TaskOwner != "" || ready.Sequence <= reserved.Sequence {
		t.Fatalf("confirmed release did not advance to send readiness: %+v", ready)
	}
	if response := notify(); response["ok"] != true {
		t.Fatalf("duplicate release confirmation was not idempotent: %v", response)
	}
	if duplicate := observedProjectSync(m.ServerPath); duplicate.Status != "ready" || duplicate.Sequence != ready.Sequence {
		t.Fatal("duplicate confirmation created another readiness transition")
	}
	for _, tc := range []struct {
		name     string
		reserved string
		lease    map[string]any
		failure  error
		code     string
	}{
		{name: "new cached run", reserved: "release-new", code: "WORKSPACE_BUSY"},
		{name: "new server lease", reserved: id, lease: map[string]any{"id": "release-new", "epoch": m.BindingEpoch, "owner": "claude"}, code: "WORKSPACE_BUSY"},
		{name: "unavailable lease read", reserved: id, failure: errors.New("lease read interrupted"), code: "WORKSPACE_UNAVAILABLE"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			cloudReservations.Store(m.ServerPath, tc.reserved)
			lease, readFailure = tc.lease, tc.failure
			if response := notify(); response["code"] != tc.code {
				t.Fatalf("unsafe release confirmation result: %v", response)
			}
			value, ok := cloudReservations.Load(m.ServerPath)
			info := observedProjectSync(m.ServerPath)
			if !ok || value != tc.reserved || info.Status != "reserved" || info.TaskOwner != "claude" {
				t.Fatalf("unconfirmed release exposed send readiness: %+v", info)
			}
		})
	}
}

func TestWorkspaceHandbackUsesAtomicReleaseBeforeAcknowledging(t *testing.T) {
	for _, replaceLease := range []bool{false, true} {
		t.Run(fmt.Sprintf("replacement=%t", replaceLease), func(t *testing.T) {
			isolatePi(t)
			m, _, _ := isolateSyncObserver(t)
			isolateWorkspaceSyncTransport(t)
			id := "handback-exact"
			lease := map[string]any{"owner": "sync-needed", "id": id, "epoch": m.BindingEpoch}
			cloudReservations.Store(m.ServerPath, id)
			t.Cleanup(func() {
				cloudReservations.Delete(m.ServerPath)
				cloudSyncRecovery.Delete(m.ServerPath)
				workspaceLocks.Delete(m.ServerPath)
			})
			synchronized, releases := false, 0
			remoteLeaseContext = func(_ context.Context, actual *Mapping, op, owner, actualID string) (map[string]any, error) {
				if actual.ServerPath != m.ServerPath {
					t.Fatal("handback crossed workspaces")
				}
				if op == "read" {
					return map[string]any{"ok": true, "lease": lease}, nil
				}
				if op != "release" || owner != "sync-needed" || actualID != id || !synchronized {
					t.Fatal("handback must synchronize, then use exact guarded release", op, owner, actualID)
				}
				releases++
				// The real Python operation rejects either a job admitted since the
				// earlier read or a replacement lease while holding its shared guard.
				return nil, errors.New("guarded release refused active or replaced ownership")
			}
			synchronizeProjectContext = func(_ context.Context, _ *Mapping, pause bool) error {
				if pause {
					t.Fatal("handback used preparation synchronization")
				}
				synchronized = true
				if replaceLease {
					lease = map[string]any{"owner": "pi", "id": "new-owner", "epoch": m.BindingEpoch}
				}
				return nil
			}
			response := workspaceRPCContext(context.Background(), m, map[string]any{"op": "sync_end", "runId": id})
			if response["ok"] == true || response["code"] != "WORKSPACE_CLEANUP_FAILED" || releases != 1 {
				t.Fatalf("handback acknowledged before guarded release: %v, releases=%d", response, releases)
			}
			if reserved, ok := cloudReservations.Load(m.ServerPath); !ok || reserved != id || lease == nil {
				t.Fatal("failed atomic release lost the barrier or readiness reservation")
			}
			if recovery, ok := cloudSyncRecovery.Load(m.ServerPath); !ok || recovery != id {
				t.Fatal("failed atomic release did not allow exact-run manual recovery")
			}
			if owner := syncWorkspaceOwner(m.ServerPath); owner != "" {
				t.Fatalf("failed handback was presented as an active task: %s", owner)
			}
			if replaceLease && (lease["id"] != "new-owner" || lease["owner"] != "pi") {
				t.Fatal("handback changed the replacement lease")
			}
		})
	}
}

func TestWorkspaceFailedHandbackAllowsManualRecovery(t *testing.T) {
	isolatePi(t)
	m, session, _ := isolateSyncObserver(t)
	isolateWorkspaceSyncTransport(t)
	syncMonitor.Lock()
	syncMonitor.sessions = []syncSession{session}
	syncMonitor.Unlock()
	previousPause := pauseProjectSync
	t.Cleanup(func() {
		pauseProjectSync = previousPause
		cloudReservations.Delete(m.ServerPath)
		cloudSyncRecovery.Delete(m.ServerPath)
		pendingSyncReleases.Delete(m.ServerPath)
		workspaceLocks.Delete(m.ServerPath)
	})
	id := "failed-handback"
	lease := map[string]any{"id": id, "epoch": m.BindingEpoch, "owner": "claude"}
	recoveries, releases, pauses := 0, 0, 0
	remoteLeaseContext = func(_ context.Context, _ *Mapping, op, _, _ string) (map[string]any, error) {
		switch op {
		case "read":
			return map[string]any{"ok": true, "lease": lease}, nil
		case "recover":
			recoveries++
			return nil, errors.New("server has not confirmed task exit")
		case "release":
			releases++
		}
		return map[string]any{"ok": true}, nil
	}
	var syncFailure error
	synchronizeProjectContext = func(_ context.Context, actual *Mapping, _ bool) error {
		if syncFailure != nil {
			setSyncInfo(actual, "blocked", "本地写入失败（.nodetmp/bin/npm）: privilege not held")
			return syncFailure
		}
		setSyncInfo(actual, "ready", "")
		return nil
	}
	call := func(op string) map[string]any {
		return workspaceRPCContext(context.Background(), m, map[string]any{"op": op, "runId": id})
	}
	if response := call("sync_begin"); response["ok"] != true {
		t.Fatal(response)
	}
	if info := observedProjectSync(m.ServerPath); info.Status != "reserved" || info.TaskOwner != "claude" {
		t.Fatalf("active task lost its synchronization barrier: %+v", info)
	}
	syncFailure = errors.New("file synchronization failed")
	lease["owner"] = "sync-needed"
	if response := call("sync_end"); response["code"] != "SYNC_BLOCKED" {
		t.Fatal(response)
	}
	info := observedProjectSync(m.ServerPath)
	if info.Status != "blocked" || info.TaskOwner != "" || !strings.Contains(info.Detail, "privilege not held") {
		t.Fatalf("failed handback disabled manual recovery or lost the file error: %+v", info)
	}
	if reservation, ok := cloudReservations.Load(m.ServerPath); !ok || reservation != id || lease["owner"] != "sync-needed" {
		t.Fatal("allowing recovery released the task's reservation")
	}
	if response := call("sync_released"); response["code"] != "WORKSPACE_BUSY" {
		t.Fatalf("failed handback accepted release while its lease remained: %v", response)
	}
	if recovery, ok := cloudSyncRecovery.Load(m.ServerPath); !ok || recovery != id {
		t.Fatal("unconfirmed release removed the handback recovery state")
	}
	pauseProjectSync = func(context.Context, *Mapping) error { pauses++; return nil }
	if response := (FrontendBridge{}).SyncProject(m.ServerPath); response["ok"] != false || !strings.Contains(fmt.Sprint(response["error"]), "server has not confirmed task exit") {
		t.Fatalf("manual recovery bypassed server admission: %v", response)
	}
	if recoveries != 1 || releases != 0 || pauses != 1 {
		t.Fatalf("recovery skipped its exact-session pause or lease gate: recover=%d release=%d pause=%d", recoveries, releases, pauses)
	}
	if reservation, ok := cloudReservations.Load(m.ServerPath); !ok || reservation != id {
		t.Fatal("denied recovery removed the original reservation barrier")
	}
	id = "replacement-task"
	lease = map[string]any{"id": id, "epoch": m.BindingEpoch, "owner": "claude"}
	syncFailure = nil
	if response := call("sync_begin"); response["ok"] != true {
		t.Fatal(response)
	}
	if info := observedProjectSync(m.ServerPath); info.Status != "reserved" || info.TaskOwner != "claude" {
		t.Fatalf("old recovery state hid the replacement active task: %+v", info)
	}
	syncFailure = errors.New("preparation failed")
	if response := call("sync_begin"); response["code"] != "SYNC_BLOCKED" {
		t.Fatal(response)
	}
	if info := observedProjectSync(m.ServerPath); info.TaskOwner != "claude" || info.Status != "blocked" {
		t.Fatalf("failed task preparation was mistaken for finished handback: %+v", info)
	}
}

func TestWorkspaceCanceledMutagenRetainsBarrier(t *testing.T) {
	m := isolatePi(t)
	isolateWorkspaceSyncTransport(t)
	m.ServerID, m.SyncName = serverIdentity(store.config()), "pause-unit"
	previousPause := pauseProjectSync
	t.Cleanup(func() {
		pauseProjectSync = previousPause
		syncStopUnconfirmed.Delete(m.ServerPath)
		pendingSyncReleases.Delete(m.ServerPath)
		syncStates.Delete(m.ServerPath)
	})
	pauseProjectSync = func(ctx context.Context, _ *Mapping) error {
		if ctx.Err() != nil {
			t.Fatal("daemon stop cleanup reused the canceled operation context")
		}
		return errors.New("daemon pause not confirmed")
	}
	remoteLeaseContext = func(ctx context.Context, _ *Mapping, _, _, _ string) (map[string]any, error) {
		return nil, ctx.Err()
	}
	ctx, cancel := context.WithCancel(syncLeaseContext(context.Background(), "lease-pause"))
	cancel()
	err := syncProjectContentsContext(ctx, m, false)
	var pauseError *syncPauseError
	if !errors.As(err, &pauseError) || !errors.Is(err, context.Canceled) {
		t.Fatalf("canceled CLI was mistaken for confirmed daemon stop: %v", err)
	}
	if _, exists := syncStopUnconfirmed.Load(m.ServerPath); !exists || syncOperationInfo(m).engineFailure {
		t.Fatal("unconfirmed daemon stop was auto-clearable or not retained")
	}
	pendingSyncReleases.Store(m.ServerPath, pendingSyncRelease{id: "lease-pause", epoch: m.BindingEpoch, needsPause: true})
	releases := 0
	remoteLeaseContext = func(_ context.Context, actual *Mapping, op, _, _ string) (map[string]any, error) {
		if op == "read" {
			return map[string]any{"ok": true, "lease": map[string]any{"id": "lease-pause", "epoch": actual.BindingEpoch, "owner": "sync"}}, nil
		}
		if op == "release" {
			releases++
		}
		return map[string]any{"ok": true}, nil
	}
	if result := (FrontendBridge{}).SyncProject(m.ServerPath); result["ok"] != false || releases != 0 {
		t.Fatal("manual recovery released a lease before daemon pause was confirmed")
	}
	if pending, ok := pendingSyncReleases.Load(m.ServerPath); !ok || pending.(pendingSyncRelease).id != "lease-pause" {
		t.Fatal("failed pause discarded the exact pending recovery identity")
	}
	pauseProjectSync = func(context.Context, *Mapping) error { return nil }
	if err = confirmProjectSyncStop(context.Background(), m); err != nil {
		t.Fatal(err)
	}
	if _, exists := syncStopUnconfirmed.Load(m.ServerPath); exists {
		t.Fatal("confirmed exact session pause did not clear the local stop barrier")
	}
}

func TestWorkspaceGitErrorsRemainErrors(t *testing.T) {
	isolatePi(t)
	local := t.TempDir()
	m := &Mapping{LocalPath: local, BindingEpoch: "git-unit"}
	if repository, err := localGitRepository(context.Background(), local); err != nil || repository {
		t.Fatalf("real non-repository = %t, %v", repository, err)
	}
	if _, err := gitOutput(local, "init", "-b", "main"); err != nil {
		t.Fatal(err)
	}
	if err := syncGitContext(context.Background(), m); err != nil {
		t.Fatal("unborn branch was incorrectly treated as corruption:", err)
	}
	if err := os.WriteFile(filepath.Join(local, "tracked.txt"), []byte("tracked\n"), 0600); err != nil {
		t.Fatal(err)
	}
	for _, args := range [][]string{{"add", "tracked.txt"}, {"-c", "user.name=QA", "-c", "user.email=qa@localhost", "commit", "-m", "unit"}} {
		if _, err := gitOutput(local, args...); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(local, ".git", "refs", "heads", "main"), []byte(strings.Repeat("0", 40)+"\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := syncGitContext(context.Background(), m); err == nil {
		t.Fatal("invalid HEAD object silently succeeded as an unborn branch")
	}
	if err := os.WriteFile(filepath.Join(local, ".git", "index"), []byte("corrupt index"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := syncIgnoreConfigurationContext(context.Background(), m); err == nil {
		t.Fatal("tracked-file read failure silently excluded user source")
	}
	if err := os.WriteFile(filepath.Join(local, ".git", "HEAD"), []byte("invalid HEAD\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := localGitRepository(context.Background(), local); err == nil {
		t.Fatal("corrupt .git was accepted as a non-repository")
	}
}

func TestWorkspacePreviewRequiresHTTPApplication(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	go func() {
		connection, err := listener.Accept()
		if err == nil {
			connection.Close()
		}
	}()
	if previewHTTPReady(context.Background(), "http://"+listener.Addr().String()) {
		t.Fatal("listening SSH socket was mistaken for a ready HTTP application")
	}
	application := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNotFound)
	}))
	defer application.Close()
	if !previewHTTPReady(context.Background(), application.URL) {
		t.Fatal("real HTTP application response did not establish end-to-end readiness")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if previewHTTPReady(ctx, application.URL) {
		t.Fatal("canceled readiness check started a new probe")
	}
}
