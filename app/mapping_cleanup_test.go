//go:build windows

package main

import (
	"context"
	"errors"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"
)

func isolateInactiveMapping(t *testing.T) *Mapping {
	t.Helper()
	m := isolatePi(t)
	store.path = filepath.Join(t.TempDir(), "state.json")
	store.Cfg.WorkspaceAccount, store.Cfg.WorkspaceLoginURL = "previous-account", "https://previous.example"
	m.ServerID = serverIdentity(store.Cfg)
	previousTunnel := tunnel
	tunnel = &Tunnel{}
	t.Cleanup(func() { tunnel = previousTunnel })
	apiConnection.client.Transport = reviewRoundTrip(func(*http.Request) (*http.Response, error) {
		t.Fatal("local mapping cleanup contacted the current account service")
		return nil, errors.New("unexpected account request")
	})
	if err := store.flush(); err != nil {
		t.Fatal(err)
	}
	return m
}

func TestInactiveMappingsRemainManageableAfterAccountSwitch(t *testing.T) {
	m := isolateInactiveMapping(t)
	state := (FrontendBridge{}).GetState()
	if len(state["mappings"].([]*Mapping)) != 0 || len(state["inactiveMappings"].([]*Mapping)) != 1 {
		t.Fatal("old account mapping was hidden from management or exposed as active", state)
	}
	if inactive := state["inactiveMappings"].([]*Mapping)[0]; inactive.ServerPath != m.ServerPath || inactive.BindingEpoch != m.BindingEpoch {
		t.Fatal("management lost the exact binding identity", inactive)
	}
	apiConnection.accountIdentity, apiConnection.loginURL = store.Cfg.WorkspaceAccount, store.Cfg.WorkspaceLoginURL
	state = (FrontendBridge{}).GetState()
	if len(state["inactiveMappings"].([]*Mapping)) != 0 || len(state["mappings"].([]*Mapping)) != 1 {
		t.Fatal("active account mapping was incorrectly offered for local-only cleanup", state)
	}
}

func TestForgetInactiveMappingPreservesFilesConnectionAndOtherBinding(t *testing.T) {
	m := isolateInactiveMapping(t)
	file := filepath.Join(m.LocalPath, "keep.txt")
	if err := os.WriteFile(file, []byte("user project contents"), 0600); err != nil {
		t.Fatal(err)
	}
	other := &Mapping{LocalPath: t.TempDir(), ServerPath: "/srv/other", BindingEpoch: "other", ServerID: m.ServerID}
	if err := store.addMapping(other); err != nil {
		t.Fatal(err)
	}
	previousConfig, previousConnection, previousTunnel := store.config(), apiConnection, tunnel
	result := (FrontendBridge{}).ForgetMapping(m.ServerPath, m.BindingEpoch)
	if result["ok"] != true {
		t.Fatal(result)
	}
	if body, err := os.ReadFile(file); err != nil || string(body) != "user project contents" {
		t.Fatal("cleanup changed local project files", err)
	}
	if !reflect.DeepEqual(previousConfig, store.config()) || apiConnection != previousConnection || tunnel != previousTunnel {
		t.Fatal("local cleanup changed the current connection")
	}
	restored := loadStore(filepath.Dir(store.path))
	if restored.findMappingByServer(m.ServerPath) != nil || restored.findMappingByServer(other.ServerPath) == nil {
		t.Fatal("cleanup failed to persist only the selected mapping removal")
	}
}

func TestForgetMappingRejectsStaleAndActiveBindings(t *testing.T) {
	m := isolateInactiveMapping(t)
	for _, epoch := range []string{"", "stale"} {
		if result := (FrontendBridge{}).ForgetMapping(m.ServerPath, epoch); result["ok"] != false || store.findMappingByServer(m.ServerPath) == nil {
			t.Fatal("stale UI removed the current mapping", result)
		}
	}
	apiConnection.accountIdentity, apiConnection.loginURL = store.Cfg.WorkspaceAccount, store.Cfg.WorkspaceLoginURL
	if result := (FrontendBridge{}).ForgetMapping(m.ServerPath, m.BindingEpoch); result["ok"] != false || store.findMappingByServer(m.ServerPath) == nil {
		t.Fatal("local-only cleanup accepted an active account binding", result)
	}
}

func TestForgetInactiveMappingPreservesBusyOwnership(t *testing.T) {
	for _, busy := range []string{"workspace-operation", "cloud-task", "sync-operation", "pi-runtime", "pi-lease", "preview", "sync-journal", "pending-sync-release"} {
		t.Run(busy, func(t *testing.T) {
			m := isolateInactiveMapping(t)
			switch busy {
			case "workspace-operation":
				mu := &sync.Mutex{}
				mu.Lock()
				workspaceLocks.Store(m.ServerPath, mu)
				t.Cleanup(mu.Unlock)
			case "cloud-task":
				cloudReservations.Store(m.ServerPath, "cloud-run")
				t.Cleanup(func() { cloudReservations.Delete(m.ServerPath) })
			case "sync-operation":
				syncActivities.items[m.ServerPath] = syncActivity{epoch: m.BindingEpoch, count: 1, phase: "syncing"}
				t.Cleanup(func() { delete(syncActivities.items, m.ServerPath) })
			case "pi-runtime":
				piAgents.sessions["busy"] = &piSession{ServerPath: m.ServerPath, BindingEpoch: m.BindingEpoch, Running: true}
			case "pi-lease":
				piAgents.sessions["busy"] = &piSession{ServerPath: m.ServerPath, BindingEpoch: m.BindingEpoch, Owner: "pi", LeaseID: "unreleased"}
			case "preview":
				previews.items["inactive-preview"] = Preview{ID: "inactive-preview", ServerPath: m.ServerPath, Epoch: m.BindingEpoch}
				t.Cleanup(func() { delete(previews.items, "inactive-preview") })
			case "sync-journal":
				if err := saveSyncRelease(m, "unreleased"); err != nil {
					t.Fatal(err)
				}
			case "pending-sync-release":
				pendingSyncReleases.Store(m.ServerPath, pendingSyncRelease{id: "unreleased", epoch: m.BindingEpoch})
				t.Cleanup(func() { pendingSyncReleases.Delete(m.ServerPath) })
			}
			if result := (FrontendBridge{}).ForgetMapping(m.ServerPath, m.BindingEpoch); result["ok"] != false || store.findMappingByServer(m.ServerPath) == nil {
				t.Fatal("cleanup discarded active ownership", result)
			}
		})
	}
}

func TestForgetInactiveMappingRetainsBindingWhenSyncCannotStop(t *testing.T) {
	m := isolateInactiveMapping(t)
	m.SyncName = "must-confirm-termination"
	t.Setenv("MUTAGEN_DISABLE_AUTOSTART", "1")
	if result := (FrontendBridge{}).ForgetMapping(m.ServerPath, m.BindingEpoch); result["ok"] != false || store.findMappingByServer(m.ServerPath) == nil {
		t.Fatal("unavailable sync engine was reported as a completed removal", result)
	}
}

func TestForgetInactiveMappingTerminatesOnlyItsRealLocalSyncSession(t *testing.T) {
	m := isolateInactiveMapping(t)
	m.SyncName = "inactive-exact-session"
	beta, otherAlpha, otherBeta := t.TempDir(), t.TempDir(), t.TempDir()
	for _, directory := range []string{m.LocalPath, beta, otherAlpha, otherBeta} {
		if err := os.WriteFile(filepath.Join(directory, "keep.txt"), []byte(directory), 0600); err != nil {
			t.Fatal(err)
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	t.Cleanup(func() {
		cleanup, stop := context.WithTimeout(context.Background(), 15*time.Second)
		defer stop()
		if _, err := runMutagenContext(cleanup, "daemon", "stop"); err != nil {
			t.Error("isolated sync daemon cleanup failed", err)
		}
	})
	if _, err := runMutagenContext(ctx, "sync", "create", "--paused", "--name", m.SyncName, m.LocalPath, beta); err != nil {
		t.Fatal("isolated old-account session could not start", err)
	}
	const unrelated = "unrelated-local-session"
	if _, err := runMutagenContext(ctx, "sync", "create", "--paused", "--name", unrelated, otherAlpha, otherBeta); err != nil {
		t.Fatal("isolated control session could not start", err)
	}
	if result := (FrontendBridge{}).ForgetMapping(m.ServerPath, m.BindingEpoch); result["ok"] != true {
		t.Fatal(result)
	}
	sessions, err := listSyncSessionsContext(ctx)
	if err != nil || len(matchingSyncSessions(sessions, m.SyncName)) != 0 || len(matchingSyncSessions(sessions, unrelated)) != 1 {
		t.Fatal("cleanup did not terminate exactly the selected local daemon session", sessions, err)
	}
	for _, directory := range []string{m.LocalPath, beta, otherAlpha, otherBeta} {
		if body, err := os.ReadFile(filepath.Join(directory, "keep.txt")); err != nil || string(body) != directory {
			t.Fatal("terminating the mapping changed a local session endpoint's files", directory, err)
		}
	}
	t.Log("real isolated Mutagen session removed; unrelated session and all endpoint files retained; no account HTTP request")
}

func TestOpenDirectoryOffersMappingManagementOnlyForBindingConflict(t *testing.T) {
	m := isolateInactiveMapping(t)
	for _, tc := range []struct {
		name   string
		err    error
		action any
	}{
		{name: "mapping-conflict", err: errWorkspaceMappingsConflict, action: "manage-mappings"},
		{name: "unrelated-enrollment-error", err: errors.New("account synchronization service unavailable")},
	} {
		t.Run(tc.name, func(t *testing.T) {
			done := make(chan struct{})
			close(done)
			apiConnection.workspaceSetup = &accountWorkspaceSetup{done: done, err: tc.err}
			localPath := m.LocalPath
			if tc.action == nil {
				localPath = t.TempDir()
			}
			result := prepareLocalProject(localPath)
			if result["ok"] != false || result["action"] != tc.action {
				t.Fatal("open directory offered the wrong recovery action", result)
			}
		})
	}
}

func TestSameAccountEnrollmentRootChangeRetainsOldBinding(t *testing.T) {
	m := isolateInactiveMapping(t)
	apiConnection.accountIdentity = "same-managed-account"
	store.Cfg.WorkspaceAccount, store.Cfg.WorkspaceLoginURL = apiConnection.accountIdentity, apiConnection.loginURL
	store.Cfg.WorkspaceRoot = "/srv/previous-root"
	m.ServerID = serverIdentity(store.Cfg)
	previousConfig, previousMapping := store.config(), *m
	next := previousConfig
	next.WorkspaceRoot = "/srv/new-enrollment-root"
	err := startAccountWorkspace(apiConnection, next)
	if err == nil || err == errWorkspaceMappingsConflict {
		t.Fatal("changed enrollment root must retain foreign mappings and continue to transport preparation", err)
	}
	done := make(chan struct{})
	close(done)
	apiConnection.workspaceSetup = &accountWorkspaceSetup{done: done, err: err}
	if !workspaceConnectionMatchesSession() || store.config().WorkspaceRoot != next.WorkspaceRoot || !reflect.DeepEqual(*store.findMappingByServer(m.ServerPath), previousMapping) {
		t.Fatal("new account configuration stole or removed the old binding")
	}
	state := (FrontendBridge{}).GetState()
	if state["tunnel"] != false || len(state["mappings"].([]*Mapping)) != 0 || len(state["inactiveMappings"].([]*Mapping)) != 1 {
		t.Fatal("retained old-root project was exposed as active or transport ready", state)
	}
	if result := prepareLocalProject(m.LocalPath); result["action"] != "manage-mappings" {
		t.Fatal("same-account enrollment conflict had no settings recovery action", result)
	}
	if result := (FrontendBridge{}).ForgetMapping(m.ServerPath, m.BindingEpoch); result["ok"] != true {
		t.Fatal("same-account rejected binding could not be removed locally", result)
	}
	if store.findMappingByServer(m.ServerPath) != nil || store.config().WorkspaceRoot != next.WorkspaceRoot {
		t.Fatal("old-root cleanup failed or changed the current account configuration")
	}
}

func selectedWorkspaceBindings(mappings ...*Mapping) []WorkspaceBindingSelection {
	bindings := make([]WorkspaceBindingSelection, 0, len(mappings))
	for _, mapping := range mappings {
		bindings = append(bindings, WorkspaceBindingSelection{ServerPath: mapping.ServerPath, BindingEpoch: mapping.BindingEpoch})
	}
	return bindings
}

func TestSwitchAccountWorkspaceRejectsChangedSnapshotBeforeCleanup(t *testing.T) {
	for _, variant := range []string{"missing", "stale", "duplicate", "logged-out"} {
		t.Run(variant, func(t *testing.T) {
			m := isolateInactiveMapping(t)
			bindings := selectedWorkspaceBindings(m)
			switch variant {
			case "missing":
				bindings = nil
			case "stale":
				bindings[0].BindingEpoch = "stale"
			case "duplicate":
				bindings = append(bindings, bindings[0])
			case "logged-out":
				apiConnection.authenticated = false
			}
			before := store.mappings()
			result := (FrontendBridge{}).SwitchAccountWorkspace(bindings)
			if result["ok"] != false || result["clearedMappings"] != 0 || !reflect.DeepEqual(before, store.mappings()) {
				t.Fatal("changed or unauthorized switch mutated the old mappings", result)
			}
		})
	}
}

func TestSwitchAccountWorkspacePrechecksEveryBindingBeforeCleanup(t *testing.T) {
	m := isolateInactiveMapping(t)
	m.ServerPath = "/srv/a-first"
	busy := &Mapping{LocalPath: t.TempDir(), ServerPath: "/srv/z-busy", BindingEpoch: "busy", ServerID: m.ServerID}
	if err := store.addMapping(busy); err != nil {
		t.Fatal(err)
	}
	cloudReservations.Store(busy.ServerPath, "active-run")
	t.Cleanup(func() { cloudReservations.Delete(busy.ServerPath) })
	before := store.mappings()
	result := (FrontendBridge{}).SwitchAccountWorkspace(selectedWorkspaceBindings(m))
	if result["ok"] != false || result["clearedMappings"] != 0 || !reflect.DeepEqual(before, store.mappings()) {
		t.Fatal("a later busy project allowed earlier destructive cleanup", result)
	}
}

func TestSwitchAccountWorkspaceReportsPartialLocalCleanup(t *testing.T) {
	m := isolateInactiveMapping(t)
	m.ServerPath = "/srv/a-first"
	remaining := &Mapping{LocalPath: t.TempDir(), ServerPath: "/srv/z-failure", BindingEpoch: "remaining", ServerID: m.ServerID, SyncName: "unavailable-session"}
	if err := store.addMapping(remaining); err != nil {
		t.Fatal(err)
	}
	t.Setenv("MUTAGEN_DISABLE_AUTOSTART", "1")
	result := (FrontendBridge{}).SwitchAccountWorkspace(selectedWorkspaceBindings(m, remaining))
	if result["ok"] != false || result["clearedMappings"] != 1 || result["bindingsCleared"] != false || store.findMappingByServer(m.ServerPath) != nil || store.findMappingByServer(remaining.ServerPath) == nil {
		t.Fatal("partial cleanup was hidden or rolled back as if it had not happened", result)
	}
	if !strings.Contains(result["error"].(string), "已解除 1 个旧映射") {
		t.Fatal("partial cleanup was not explained to the caller", result)
	}
}

func TestSwitchAccountWorkspaceAutomaticallyConnectsOnlyAfterRealSyncCleanup(t *testing.T) {
	m := isolateInactiveMapping(t)
	m.SyncName = "switch-old-binding"
	apiConnection.accountIdentity, apiConnection.accessToken = "current-account", "current.account.token"
	beta, otherAlpha, otherBeta := t.TempDir(), t.TempDir(), t.TempDir()
	for _, directory := range []string{m.LocalPath, beta, otherAlpha, otherBeta} {
		if err := os.WriteFile(filepath.Join(directory, "keep.txt"), []byte(directory), 0600); err != nil {
			t.Fatal(err)
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	t.Cleanup(func() {
		cleanup, stop := context.WithTimeout(context.Background(), 15*time.Second)
		defer stop()
		if _, err := runMutagenContext(cleanup, "daemon", "stop"); err != nil {
			t.Error("isolated switch daemon cleanup failed", err)
		}
	})
	if _, err := runMutagenContext(ctx, "sync", "create", "--paused", "--name", m.SyncName, m.LocalPath, beta); err != nil {
		t.Fatal(err)
	}
	const unrelated = "switch-unrelated-session"
	if _, err := runMutagenContext(ctx, "sync", "create", "--paused", "--name", unrelated, otherAlpha, otherBeta); err != nil {
		t.Fatal(err)
	}
	requests := 0
	apiConnection.client.Transport = reviewRoundTrip(func(request *http.Request) (*http.Response, error) {
		requests++
		if request.URL.Path != "/api/workspace-sync/enroll" || request.Header.Get("Authorization") != "Bearer current.account.token" || len(store.mappings()) != 0 {
			t.Error("automatic current-account enrollment ran before cleanup or used the wrong account")
		}
		sessions, err := listSyncSessionsContext(ctx)
		if err != nil || len(matchingSyncSessions(sessions, m.SyncName)) != 0 || len(matchingSyncSessions(sessions, unrelated)) != 1 {
			t.Error("current-account enrollment preceded exact local sync termination", sessions, err)
		}
		return &http.Response{StatusCode: 503, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(`{"error":{"message":"current service unavailable"}}`))}, nil
	})
	result := (FrontendBridge{}).SwitchAccountWorkspace(selectedWorkspaceBindings(m))
	if result["ok"] != false || result["clearedMappings"] != 1 || result["bindingsCleared"] != true || requests != 1 || len(store.mappings()) != 0 {
		t.Fatal("switch did not automatically connect or honestly report the connection failure", result, requests)
	}
	if !strings.Contains(result["error"].(string), "旧映射已解除") || !strings.Contains(result["error"].(string), "current service unavailable") {
		t.Fatal("connection failure hid the completed local cleanup", result)
	}
	for _, directory := range []string{m.LocalPath, beta, otherAlpha, otherBeta} {
		if body, err := os.ReadFile(filepath.Join(directory, "keep.txt")); err != nil || string(body) != directory {
			t.Fatal("one-action switch changed project endpoint files", directory, err)
		}
	}
	t.Log("one action terminated the exact real old session, preserved unrelated session/files, then attempted current-account enrollment")
}

func TestSwitchAccountWorkspaceAwaitsCurrentSetupAndRejectsAccountReplacement(t *testing.T) {
	for _, replace := range []bool{false, true} {
		t.Run(map[bool]string{false: "setup-completes", true: "account-replaced"}[replace], func(t *testing.T) {
			m := isolateInactiveMapping(t)
			done := make(chan struct{})
			apiConnection.workspaceSetup = &accountWorkspaceSetup{done: done}
			connection := apiConnection
			result := make(chan map[string]any, 1)
			go func() { result <- (FrontendBridge{}).SwitchAccountWorkspace(selectedWorkspaceBindings(m)) }()
			deadline := time.Now().Add(3 * time.Second)
			for store.findMappingByServer(m.ServerPath) != nil {
				if time.Now().After(deadline) {
					t.Fatal("switch did not finish local cleanup")
				}
				time.Sleep(5 * time.Millisecond)
			}
			serverConnectionMu.Lock()
			if replace {
				apiConnection = nil
				connection.cancel()
			}
			close(done)
			serverConnectionMu.Unlock()
			select {
			case completed := <-result:
				if completed["ok"] != false || completed["bindingsCleared"] != true || completed["clearedMappings"] != 1 {
					t.Fatal("switch fabricated a completed project rebind from account setup alone", completed)
				}
				if !replace && !strings.Contains(completed["error"].(string), "尚未完成切换") {
					t.Fatal("post-setup project preparation failure was not reported", completed)
				}
			case <-time.After(3 * time.Second):
				t.Fatal("switch remained pending after account setup settled")
			}
		})
	}
}

func TestSelectiveSwitchKeepsUnselectedBindingAndSessionRecord(t *testing.T) {
	selected := isolateInactiveMapping(t)
	other := &Mapping{LocalPath: t.TempDir(), ServerPath: "/srv/untouched", BindingEpoch: "untouched-epoch", ServerID: "another-original-owner", SyncName: "untouched-session", Mode: "vps"}
	if err := store.addMapping(other); err != nil {
		t.Fatal(err)
	}
	before := *other
	selection, cleared, err := clearAccountWorkspaceBindings(selectedWorkspaceBindings(selected))
	if err != nil || cleared != 1 || len(selection.mappings) != 1 || selection.mappings[0].LocalPath != selected.LocalPath {
		t.Fatal("single project selection was rejected or expanded", cleared, err)
	}
	if store.findMappingByServer(selected.ServerPath) != nil || !reflect.DeepEqual(*store.findMappingByServer(other.ServerPath), before) {
		t.Fatal("switching one project altered an unselected owner's binding")
	}
	if reloaded := loadStore(filepath.Dir(store.path)).findMappingByServer(other.ServerPath); reloaded == nil || !reflect.DeepEqual(*reloaded, before) {
		t.Fatal("unselected project owner, epoch or sync name was not persisted intact", reloaded)
	}
}

func TestCurrentAccountStatePartitionsRetainedOwners(t *testing.T) {
	foreign := isolateInactiveMapping(t)
	apiConnection.accountIdentity = "current-managed-account"
	store.Cfg.WorkspaceAccount, store.Cfg.WorkspaceLoginURL = apiConnection.accountIdentity, apiConnection.loginURL
	current := &Mapping{LocalPath: t.TempDir(), ServerPath: "/srv/current", BindingEpoch: "current-epoch", ServerID: serverIdentity(store.Cfg), Mode: "vps"}
	if err := store.addMapping(current); err != nil {
		t.Fatal(err)
	}
	state := (FrontendBridge{}).GetState()
	active, inactive := state["mappings"].([]*Mapping), state["inactiveMappings"].([]*Mapping)
	if len(active) != 1 || active[0].ServerPath != current.ServerPath || len(inactive) != 1 || inactive[0].ServerPath != foreign.ServerPath {
		t.Fatal("current and retained foreign projects were not partitioned by owner", state)
	}
	if result := prepareLocalProject(foreign.LocalPath); result["action"] != "manage-mappings" || result["ok"] != false {
		t.Fatal("opening an unselected foreign folder reused it under the current account", result)
	}
	for _, result := range []map[string]any{
		(FrontendBridge{}).Revoke(foreign.ServerPath),
		workspaceRPC(foreign, map[string]any{"op": "read", "path": "/workspace/keep.txt"}),
		previewRPC(foreign, map[string]any{"op": "preview_status", "previewId": "foreign-preview"}),
	} {
		if result["ok"] == true || result["error"] == nil {
			t.Fatal("foreign project action was routed through the current account", result)
		}
	}
	if store.findMappingByServer(foreign.ServerPath) == nil {
		t.Fatal("a rejected foreign owner operation removed its mapping")
	}
}

func TestTunnelRegistersOnlyCurrentOwnerMappings(t *testing.T) {
	foreign := isolateInactiveMapping(t)
	cfg := store.config()
	cfg.WorkspaceAccount, cfg.WorkspaceLoginURL = "new-account", apiConnection.loginURL
	current := newTunnel(cfg, "", func() {})
	current.proc, current.bridgePort = &exec.Cmd{}, 12345
	if err := current.PushToken("unused"); err != nil {
		t.Fatal("retained foreign mapping prevented current transport readiness", err)
	}
	if !current.bridgeReady || store.findMappingByServer(foreign.ServerPath) == nil {
		t.Fatal("token registration changed the foreign record or failed readiness")
	}
}

func TestAccountTransportPausesForeignSessionWithoutRemovingIt(t *testing.T) {
	foreign := isolateInactiveMapping(t)
	foreign.SyncName = "retained-foreign-project"
	apiConnection.accountIdentity = "current-managed-account"
	beta, unrelatedAlpha, unrelatedBeta := t.TempDir(), t.TempDir(), t.TempDir()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	t.Cleanup(func() {
		cleanup, stop := context.WithTimeout(context.Background(), 15*time.Second)
		defer stop()
		if _, err := runMutagenContext(cleanup, "daemon", "stop"); err != nil {
			t.Error(err)
		}
	})
	if _, err := runMutagenContext(ctx, "sync", "create", "--name", foreign.SyncName, foreign.LocalPath, beta); err != nil {
		t.Fatal(err)
	}
	const unrelated = "unregistered-control-session"
	if _, err := runMutagenContext(ctx, "sync", "create", "--name", unrelated, unrelatedAlpha, unrelatedBeta); err != nil {
		t.Fatal(err)
	}
	before, err := syncSessionsContext(ctx, foreign.SyncName)
	if err != nil || len(before) != 1 || before[0].Paused {
		t.Fatal("real retained session did not begin active", before, err)
	}
	oldBinding := *foreign
	cfg := store.config()
	cfg.WorkspaceAccount, cfg.WorkspaceLoginURL = apiConnection.accountIdentity, apiConnection.loginURL
	err = startAccountWorkspace(apiConnection, cfg)
	if err == nil || err == errWorkspaceMappingsConflict {
		t.Fatal("local fixture should proceed past foreign ownership to its unavailable SSH transport", err)
	}
	after, queryErr := syncSessionsContext(ctx, foreign.SyncName)
	control, controlErr := syncSessionsContext(ctx, unrelated)
	if queryErr != nil || len(after) != 1 || !after[0].Paused || after[0].Identifier != before[0].Identifier || !reflect.DeepEqual(*store.findMappingByServer(foreign.ServerPath), oldBinding) {
		t.Fatal("account transition terminated or rewrote the retained old project", after, queryErr)
	}
	if controlErr != nil || len(control) != 1 || control[0].Paused {
		t.Fatal("account transition touched an unrelated daemon session", control, controlErr)
	}
	t.Log("real foreign session paused with the same identifier; mapping owner/epoch/sync name retained; unrelated session stayed active")
}

func TestSyncSSHRetainsOwnerSpecificHostStanzas(t *testing.T) {
	_ = isolateInactiveMapping(t)
	previous := store.config()
	previous.SSHHost, previous.SSHUser, previous.WorkspaceRoot = "old-host.example", "old-user", "/srv/old"
	previousAlias, err := prepareSyncSSH(previous, filepath.Join(t.TempDir(), "old-key"))
	if err != nil {
		t.Fatal(err)
	}
	current := previous
	current.WorkspaceAccount, current.SSHHost, current.SSHUser = "new-owner", "new-host.example", "new-user"
	currentAlias, err := prepareSyncSSH(current, filepath.Join(t.TempDir(), "new-key"))
	if err != nil || currentAlias == previousAlias {
		t.Fatal("accounts did not receive distinct SSH aliases", currentAlias, err)
	}
	previous.SSHHost = "updated-old-host.example"
	if _, err := prepareSyncSSH(previous, filepath.Join(t.TempDir(), "updated-old-key")); err != nil {
		t.Fatal(err)
	}
	config := filepath.Join(dataDir(), "sync-ssh.conf")
	for alias, host := range map[string]string{previousAlias: "updated-old-host.example", currentAlias: "new-host.example"} {
		output, err := exec.Command(sshExe(), "-G", "-F", config, alias).CombinedOutput()
		if err != nil || !strings.Contains(string(output), "hostname "+host) {
			t.Fatal("OpenSSH resolved an owner's alias to another account", alias, string(output), err)
		}
	}
	contents, err := os.ReadFile(config)
	if err != nil || strings.Count(string(contents), "Host "+previousAlias+"\n") != 1 || strings.Count(string(contents), "Host "+currentAlias+"\n") != 1 {
		t.Fatal("updating one account duplicated or removed another owner's SSH stanza", string(contents), err)
	}
}

func TestSelectiveSwitchOnReadyTransportLeavesUnselectedSessionRunning(t *testing.T) {
	selected := isolateInactiveMapping(t)
	selected.SyncName = "selected-old-session"
	retained := &Mapping{LocalPath: t.TempDir(), ServerPath: "/srv/retained-busy", BindingEpoch: "retained", ServerID: selected.ServerID, SyncName: "retained-old-session", Mode: "vps"}
	if err := store.addMapping(retained); err != nil {
		t.Fatal(err)
	}
	beforeBinding := *retained
	apiConnection.accountIdentity = "ready-current-account"
	store.Cfg.WorkspaceAccount, store.Cfg.WorkspaceLoginURL = apiConnection.accountIdentity, apiConnection.loginURL
	tunnel = newTunnel(store.config(), "", func() {})
	tunnel.proc, tunnel.bridgeReady, tunnel.bridgePort = &exec.Cmd{}, true, 12345
	previousTransport := tunnel
	cloudReservations.Store(retained.ServerPath, "retained-task")
	t.Cleanup(func() { cloudReservations.Delete(retained.ServerPath) })
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	t.Cleanup(func() {
		cleanup, stop := context.WithTimeout(context.Background(), 15*time.Second)
		defer stop()
		if _, err := runMutagenContext(cleanup, "daemon", "stop"); err != nil {
			t.Error(err)
		}
	})
	for _, mapping := range []*Mapping{selected, retained} {
		if _, err := runMutagenContext(ctx, "sync", "create", "--name", mapping.SyncName, mapping.LocalPath, t.TempDir()); err != nil {
			t.Fatal(err)
		}
	}
	before, err := syncSessionsContext(ctx, retained.SyncName)
	if err != nil || len(before) != 1 || before[0].Paused {
		t.Fatal(before, err)
	}
	selection, cleared, err := clearAccountWorkspaceBindings(selectedWorkspaceBindings(selected))
	if err != nil || cleared != 1 || selection.connection != apiConnection || tunnel != previousTransport {
		t.Fatal("unchanged current transport unnecessarily blocked or replaced an unrelated task", cleared, err)
	}
	after, err := syncSessionsContext(ctx, retained.SyncName)
	if err != nil || len(after) != 1 || after[0].Paused || after[0].Identifier != before[0].Identifier || !reflect.DeepEqual(*store.findMappingByServer(retained.ServerPath), beforeBinding) {
		t.Fatal("selected project cleanup paused, terminated or rewrote the unselected busy project", after, err)
	}
	if selectedSessions, err := syncSessionsContext(ctx, selected.SyncName); err != nil || len(selectedSessions) != 0 {
		t.Fatal("selected old session was not terminated", selectedSessions, err)
	}
	t.Log("ready current transport retained; only selected old session terminated; unselected busy record/session remained active")
}
