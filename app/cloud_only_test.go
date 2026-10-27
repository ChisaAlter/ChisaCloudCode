package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func accountWorkspaceFixture(t *testing.T, handler http.HandlerFunc) *serverConnection {
	t.Helper()
	t.Setenv("CHISA_DATA_DIR", t.TempDir())
	previousStore, previousConnection := store, apiConnection
	upstream := httptest.NewServer(handler)
	connection, err := newServerConnection(upstream.URL, upstream.URL)
	if err != nil {
		t.Fatal(err)
	}
	connection.authenticated, connection.accountIdentity, connection.accessToken = true, "fixture-account", "header.payload.signature"
	apiConnection = connection
	store = loadStore(dataDir())
	t.Cleanup(func() {
		if apiConnection != nil && apiConnection != previousConnection {
			apiConnection.cancel()
			apiConnection.client.CloseIdleConnections()
		}
		connection.cancel()
		upstream.Close()
		store, apiConnection = previousStore, previousConnection
	})
	return connection
}

func TestCloudOnlyLegacyRPCsNeverReadOrMutateLocalState(t *testing.T) {
	previousStore := store
	store = nil // Any attempt to inspect legacy state would panic.
	t.Cleanup(func() { store = previousStore })
	bridge := FrontendBridge{}
	operations := []func() map[string]any{
		bridge.SelectLocalFolder, bridge.SelectWorkspaceKey, bridge.ConnectAccountWorkspace, bridge.PiInstall, bridge.PiGetConfig, bridge.RefreshPreviews,
		func() map[string]any { return bridge.ConnectWorkspace("https://legacy", "host", "user", "key") },
		func() map[string]any { return bridge.SyncProject("/old") },
		func() map[string]any { return bridge.ConfirmProjectEmpty("/old", "epoch") },
		func() map[string]any {
			return bridge.SwitchAccountWorkspace([]WorkspaceBindingSelection{{ServerPath: "/old", BindingEpoch: "epoch"}})
		},
		func() map[string]any { return bridge.ForgetMapping("/old", "epoch") },
		func() map[string]any { return bridge.Revoke("/old") },
		func() map[string]any { return bridge.GetProjectGitRecovery("/old", "epoch") },
		func() map[string]any { return bridge.RecoverProjectGit("/old", "epoch", "token", "local") },
		func() map[string]any { return bridge.PiSaveConfig(map[string]any{"apiKey": "do not save"}) },
		func() map[string]any { return bridge.PiGetSession("/old", "session") },
		func() map[string]any { return bridge.PiEvents("/old", "session", 0) },
		func() map[string]any { return bridge.PiPrompt("/old", "session", "run", "", nil) },
		func() map[string]any { return bridge.PiRecoverSession("/old", "session") },
		func() map[string]any { return bridge.PiAbort("/old", "session") },
		func() map[string]any { return bridge.OpenPreview("old") },
		func() map[string]any { return bridge.StopPreview("old") },
	}
	for index, operation := range operations {
		if result := operation(); result["ok"] != false || result["code"] != cloudOnlyCode {
			t.Fatalf("legacy RPC %d activated: %v", index, result)
		}
	}
	if sync := bridge.GetProjectSync("/old"); sync.Status != "disabled" || sync.Code != cloudOnlyCode {
		t.Fatal(sync)
	}
	if size := bridge.GetProjectStorage("/old")["/old"]; size.LocalBytes != nil || size.LocalError == "" {
		t.Fatal(size)
	}
}

func TestCloudOnlyAuthRestoreAndServerSwitchIgnoreLegacyMappings(t *testing.T) {
	requests := []string{}
	connection := accountWorkspaceFixture(t, func(w http.ResponseWriter, r *http.Request) {
		requests = append(requests, r.URL.Path)
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/api/auth/status":
			fmt.Fprint(w, `{"isAuthenticated":false}`)
		case "/api/auth/login":
			fmt.Fprint(w, `{"token":"cloud-token","user":{"id":2,"username":"cloud"},"instancePath":"/instances/cloud"}`)
		case "/instances/cloud/api/auth/user":
			w.Header().Set("X-Chisa-Instance-Path", "/instances/cloud")
			fmt.Fprint(w, `{"user":{"id":2,"username":"cloud"}}`)
		default:
			t.Errorf("cloud login contacted retired route %s", r.URL.Path)
			w.WriteHeader(500)
		}
	})
	mapping := &Mapping{LocalPath: filepath.Join(t.TempDir(), "missing-project"), ServerPath: "/old/account/project", BindingEpoch: strings.Repeat("a", 32), ServerID: "foreign-account", SyncName: "old-session"}
	store.Mappings = []*Mapping{mapping}
	store.Cfg.ServerURL, store.Cfg.SSHHost, store.Cfg.KeyPath = "https://old.invalid", "old.invalid", "missing-key"
	store.Cfg.WorkspaceAccount = "old-account-with-pending-lease"
	if err := store.flush(); err != nil {
		t.Fatal(err)
	}
	before := *mapping
	bridge := FrontendBridge{}
	result := bridge.ServerRequest(bridge.BeginServerRequest(), "POST", "/api/auth/login", nil, "")
	if result.Status != 200 || !apiConnection.authenticated || !strings.HasSuffix(apiConnection.baseURL, "/instances/cloud") {
		t.Fatalf("legacy record blocked login: %+v", result)
	}
	if !reflect.DeepEqual(*store.Mappings[0], before) {
		t.Fatal("login rewrote legacy mapping")
	}
	version := apiConnection.version
	result = bridge.ServerRequest(bridge.BeginServerRequest(), "GET", "/api/auth/user", map[string]string{"Authorization": "Bearer cloud-token"}, "")
	if result.Status != 200 || apiConnection.version != version {
		t.Fatal("restored same account lost its connection")
	}
	state := bridge.GetState()
	if state["tunnel"] != false || state["workspaceConnecting"] != false || len(state["mappings"].([]*Mapping)) != 0 || len(state["inactiveMappings"].([]*Mapping)) != 1 {
		t.Fatal(state)
	}
	if len(requests) != 2 {
		t.Fatalf("authentication initiated local sync: %v", requests)
	}
	// A completely different service can be selected without handback or SSH.
	replacement := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { fmt.Fprint(w, `{"isAuthenticated":false}`) }))
	defer replacement.Close()
	if switched := bridge.ConnectServer(replacement.URL); switched["ok"] != true || switched["changed"] != true {
		t.Fatal(switched)
	}
	if !reflect.DeepEqual(*store.Mappings[0], before) || connection.ctx.Err() == nil {
		t.Fatal("server switch changed history or left the prior account alive")
	}
}

func TestCloudOnlyBothAPIPathsRejectEnrollmentWithoutForwarding(t *testing.T) {
	accountWorkspaceFixture(t, func(http.ResponseWriter, *http.Request) { t.Error("retired enrollment reached upstream") })
	bridge := FrontendBridge{}
	for _, endpoint := range []string{"/api/workspace-sync/enroll", "/api/workspace-sync/worker", "/api/a/../workspace-sync/enroll", "/api/workspace-sync"} {
		response := bridge.ServerRequest(bridge.BeginServerRequest(), "POST", endpoint, nil, "")
		if response.Status != http.StatusGone {
			t.Fatalf("retired native API escaped: %s %+v", endpoint, response)
		}
		payload, _ := base64.StdEncoding.DecodeString(response.BodyB64)
		if !strings.Contains(string(payload), cloudOnlyCode) {
			t.Fatal(string(payload))
		}
	}
	if err := StartAPIProxy(); err != nil {
		t.Fatal(err)
	}
	for _, endpoint := range []string{"/api/workspace-sync/enroll", "/api/workspace-sync/worker"} {
		response, err := http.Post(fmt.Sprintf("http://127.0.0.1:%d/channel/%s%s", apiProxyPort, apiProxyKey, endpoint), "application/json", nil)
		if err != nil {
			t.Fatal(err)
		}
		raw, _ := io.ReadAll(response.Body)
		response.Body.Close()
		if response.StatusCode != http.StatusGone || !strings.Contains(string(raw), cloudOnlyCode) {
			t.Fatal(response.StatusCode, string(raw))
		}
	}
}

func TestCloudOnlyLegacyHistoryLoadDoesNotInventOwnership(t *testing.T) {
	directory := t.TempDir()
	state := `{"config":{"loginUrl":"https://cloud.invalid","token":"saved-token"},"mappings":[null,{"localPath":"C:\\history","serverPath":"/legacy","syncName":"legacy"}]}`
	if err := os.WriteFile(filepath.Join(directory, "state.json"), []byte(state), 0600); err != nil {
		t.Fatal(err)
	}
	saved := loadStore(directory)
	mapping := saved.mappings()[0]
	if mapping.ServerID != "" || mapping.BindingEpoch != "" || mapping.LocalPath != `C:\history` {
		t.Fatalf("inert legacy history granted ownership: %+v", mapping)
	}
	if len(saved.Mappings) != 2 || saved.Mappings[0] != nil {
		t.Fatal("old metadata was discarded")
	}
}

type fakeLegacySyncRunner struct {
	sessions []legacySyncSession
	calls    []string
	fail     bool
	replace  bool
}

func (runner *fakeLegacySyncRunner) list(context.Context) ([]legacySyncSession, error) {
	if runner.fail {
		return nil, fmt.Errorf("private diagnostic")
	}
	return append([]legacySyncSession{}, runner.sessions...), nil
}
func (runner *fakeLegacySyncRunner) pause(_ context.Context, id string) error {
	runner.calls = append(runner.calls, id)
	for index := range runner.sessions {
		if runner.sessions[index].Identifier == id {
			runner.sessions[index].Paused = true
			if runner.replace {
				runner.sessions[index].Identifier = "sync_Replacement000000000000000"
			}
		}
	}
	return nil
}
func legacyRetirementFixture(t *testing.T) (*Mapping, legacySyncSession) {
	t.Helper()
	cfg := Config{SSHHost: "sync.example", SSHUser: "root", ServerURL: "http://legacy:8791"}
	mapping := &Mapping{LocalPath: t.TempDir(), ServerPath: "/srv/legacy/project", BindingEpoch: strings.Repeat("a", 32), ServerID: serverIdentity(cfg)}
	mapping.SyncName = "chisa-vps-" + mapping.BindingEpoch
	session := legacySyncSession{Name: mapping.SyncName, Identifier: "sync_0123456789abcdefghijklmn", Alpha: legacySyncEndpoint{Protocol: "local", Path: mapping.LocalPath}, Beta: legacySyncEndpoint{Protocol: "ssh", Host: legacySyncAlias(mapping), Path: mapping.ServerPath}}
	return mapping, session
}

func TestCloudOnlyRetirementPausesOnlyExactOwnedSessions(t *testing.T) {
	mapping, owned := legacyRetirementFixture(t)
	foreign := owned
	foreign.Name = "unrelated"
	foreign.Identifier = "sync_Foreign000000000000000000"
	foreign.Beta.Path = "/someone/else"
	runner := &fakeLegacySyncRunner{sessions: []legacySyncSession{owned, foreign}}
	before := *mapping
	result := retireLegacySync(context.Background(), &Store{Mappings: []*Mapping{mapping}}, runner)
	if len(runner.calls) != 1 || runner.calls[0] != owned.Identifier || result.Paused != 1 || result.Unverified != 1 || result.Status != "unverified" {
		t.Fatal(runner.calls, result)
	}
	if !reflect.DeepEqual(*mapping, before) || runner.sessions[1].Paused {
		t.Fatal("retirement changed metadata or a foreign session")
	}
}

func TestCloudOnlyRetirementRejectsAmbiguousAndMismatchedIdentity(t *testing.T) {
	for _, kind := range []string{"foreign-path", "foreign-local", "foreign-host", "foreign-account", "name-only", "missing-epoch", "duplicate-name", "duplicate-id", "replaced"} {
		t.Run(kind, func(t *testing.T) {
			mapping, session := legacyRetirementFixture(t)
			runner := &fakeLegacySyncRunner{sessions: []legacySyncSession{session}}
			switch kind {
			case "foreign-path":
				runner.sessions[0].Beta.Path += "-other"
			case "foreign-local":
				runner.sessions[0].Alpha.Path += "-other"
			case "foreign-host":
				runner.sessions[0].Beta.Host = "wrong-host"
			case "foreign-account":
				mapping.ServerID = "account:" + strings.Repeat("b", 64)
			case "name-only":
				runner.sessions[0].Identifier = "some-arbitrary-name"
			case "missing-epoch":
				mapping.BindingEpoch = ""
			case "duplicate-name":
				other := session
				other.Identifier = "sync_Other00000000000000000000"
				runner.sessions = append(runner.sessions, other)
			case "duplicate-id":
				other := session
				other.Name = "other-name"
				runner.sessions = append(runner.sessions, other)
			case "replaced":
				runner.replace = true
			}
			result := retireLegacySync(context.Background(), &Store{Mappings: []*Mapping{mapping}}, runner)
			if result.Paused != 0 {
				t.Fatal("unconfirmed session marked stopped", result)
			}
			if kind == "replaced" {
				if result.Status != "unconfirmed" || len(runner.calls) != 1 {
					t.Fatal(result, runner.calls)
				}
			} else if len(runner.calls) != 0 {
				t.Fatal("unverified identity was paused", runner.calls)
			}
		})
	}
}

func TestCloudOnlyRetirementFailureDoesNotBlockCloudState(t *testing.T) {
	accountWorkspaceFixture(t, func(http.ResponseWriter, *http.Request) {})
	result := retireLegacySync(context.Background(), store, &fakeLegacySyncRunner{fail: true})
	if result.Status != "unconfirmed" || result.Error == "" {
		t.Fatal(result)
	}
	state := (FrontendBridge{}).GetState()
	if state["workspaceError"] != "" || state["workspaceConnecting"] != false || !apiConnection.authenticated {
		t.Fatal(state)
	}
}

func TestCloudOnlyBuildHasNoLocalExecutionImplementations(t *testing.T) {
	for _, name := range []string{"tunnel.go", "syncmgr.go", "syncmonitor.go", "account_workspace.go", "pi_agent.go", "fschannel.go", "executor.go"} {
		if _, err := os.Stat(name); !os.IsNotExist(err) {
			t.Fatalf("retired implementation restored to package: %s", name)
		}
	}
	config, err := os.ReadFile("mygo.config.ts")
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(config), "mutagen.exe") || strings.Contains(string(config), "mutagen-agents") {
		t.Fatal("sync engine still packaged")
	}
	frontend, err := os.ReadFile("scripts/build-frontend.mjs")
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(frontend), "build-sync-ssh") {
		t.Fatal("frontend build still prepares synchronization")
	}
	// The output remains JSON serializable for older/native clients.
	if _, err := json.Marshal(cloudOnlyFailure()); err != nil {
		t.Fatal(err)
	}
}
