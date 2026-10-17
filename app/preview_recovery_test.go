//go:build windows

package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

const recoveredPreviewID = "chisa-account-preview-0123456789abcdef0123-0123456789abcdef"

func previewRecoveryFixture(t *testing.T, handler http.HandlerFunc) *serverConnection {
	t.Helper()
	connection := accountWorkspaceFixture(t, handler)
	cfg := store.config()
	cfg.ServerURL, cfg.WorkspaceServerURL = connection.baseURL, connection.baseURL
	cfg.WorkspaceAccount, cfg.WorkspaceLoginURL, cfg.WorkspaceRoot = connection.accountIdentity, connection.loginURL, "/srv/workspaces"
	if err := store.updateConfig(cfg); err != nil {
		t.Fatal(err)
	}
	previews.Lock()
	previous := previews.items
	previews.items = make(map[string]Preview)
	previews.Unlock()
	t.Cleanup(func() {
		previews.Lock()
		previews.items = previous
		previews.Unlock()
	})
	return connection
}

func TestPreviewRecoveryDiscoversAndStopsUnboundRemoteWithoutTunnel(t *testing.T) {
	removed := false
	connection := previewRecoveryFixture(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/workspace-sync/preview" || r.Header.Get("Authorization") != "Bearer header.payload.signature" {
			t.Error("preview recovery lost its authenticated API scope")
		}
		var body map[string]string
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Error(err)
		}
		switch body["op"] {
		case "list":
			_ = json.NewEncoder(w).Encode(map[string]any{"previews": []managedPreviewRecord{{ID: recoveredPreviewID, ServerPath: "/srv/workspaces/removed-mapping", BindingEpoch: "old-epoch", RemoteHost: "172.18.0.9", RemotePort: 3000}}})
		case "remove":
			if body["id"] != recoveredPreviewID {
				t.Error("stop did not retain exact recovered capability")
			}
			removed = true
			_, _ = w.Write([]byte(`{"ok":true}`))
		default:
			t.Error("unexpected preview operation", body)
		}
	})
	connection.workspaceRecoveryOnly = true
	if err := recoverManagedPreviewsContext(context.Background()); err != nil {
		t.Fatal(err)
	}
	item := previews.items[recoveredPreviewID]
	if !item.Managed || item.ServerID != serverIdentity(store.config()) || item.LocalURL != "" || item.RemoteEpoch != "old-epoch" {
		t.Fatalf("lost detached preview recovery state: %+v", item)
	}
	if len(store.mappings()) != 0 || tunnel != nil {
		t.Fatal("discovery must not create a mapping or start SSH")
	}
	result := (FrontendBridge{}).StopPreview(recoveredPreviewID)
	if result["ok"] != true || !removed || len(previews.items) != 0 {
		t.Fatalf("unbound remote preview could not be stopped: %v removed=%v", result, removed)
	}
}

func TestPreviewRecoveryRejectsMalformedInventoryWithoutLosingKnownPreview(t *testing.T) {
	previewRecoveryFixture(t, func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"previews":[{"id":"not-a-preview","serverPath":"/srv/workspaces/project"}]}`))
	})
	previews.items[recoveredPreviewID] = Preview{ID: recoveredPreviewID, Managed: true, ServerID: serverIdentity(store.config())}
	if err := recoverManagedPreviewsContext(context.Background()); err == nil || !strings.Contains(err.Error(), "列表无效") {
		t.Fatal("malformed remote inventory was not rejected", err)
	}
	if len(previews.items) != 1 {
		t.Fatal("failed discovery discarded a known stop capability")
	}
}

func TestPreviewRecoveryWillNotAdoptOldBindingOrUntrustedForward(t *testing.T) {
	mapping := &Mapping{BindingEpoch: "current-epoch"}
	for _, item := range []Preview{
		{RemoteEpoch: "old-epoch", RemoteHost: "172.18.0.9", RemotePort: 3000},
		{RemoteEpoch: "current-epoch", RemoteHost: "8.8.8.8", RemotePort: 3000},
		{RemoteEpoch: "current-epoch", RemoteHost: "172.18.0.9", RemotePort: 0},
	} {
		if err := restoreManagedPreviewForward(context.Background(), item, mapping); err == nil {
			t.Fatal("invalid recovered metadata started a preview forward")
		}
	}
}

func TestPreviewRecoverySnapshotDoesNotDiscoverAndExplicitRefreshDoes(t *testing.T) {
	var requests atomic.Int32
	previewRecoveryFixture(t, func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		_ = json.NewEncoder(w).Encode(map[string]any{"previews": []managedPreviewRecord{{ID: recoveredPreviewID, ServerPath: "/srv/workspaces/project"}}})
	})
	bridge := FrontendBridge{}
	if state := bridge.GetState(); len(state["previews"].([]Preview)) != 0 || requests.Load() != 0 {
		t.Fatal("ordinary state snapshot performed remote preview discovery", state, requests.Load())
	}
	state := bridge.RefreshPreviews()
	if requests.Load() != 1 || len(state["previews"].([]Preview)) != 1 || state["previewRecoveryError"] != nil {
		t.Fatal("explicit refresh did not return recovered previews", state, requests.Load())
	}
}

func TestPreviewRecoveryFailureRetainsKnownStopCapability(t *testing.T) {
	previewRecoveryFixture(t, func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "Docker unavailable", http.StatusServiceUnavailable)
	})
	previews.items[recoveredPreviewID] = Preview{ID: recoveredPreviewID, Managed: true, ServerID: serverIdentity(store.config())}
	state := (FrontendBridge{}).RefreshPreviews()
	if state["previewRecoveryError"] == nil || len(state["previews"].([]Preview)) != 1 {
		t.Fatal("failed refresh lost the existing preview controls", state)
	}
}

func TestPreviewRecoveryInventoryCannotRecreateSuccessfulStop(t *testing.T) {
	firstList, releaseList := make(chan struct{}), make(chan struct{})
	removed := make(chan struct{})
	var calls atomic.Int32
	previewRecoveryFixture(t, func(w http.ResponseWriter, r *http.Request) {
		var body map[string]string
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Error(err)
			return
		}
		switch body["op"] {
		case "list":
			if calls.Add(1) == 1 {
				close(firstList)
				<-releaseList
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"previews": []managedPreviewRecord{{ID: recoveredPreviewID, ServerPath: "/srv/workspaces/project"}}})
		case "remove":
			close(removed)
			_, _ = w.Write([]byte(`{"ok":true}`))
		default:
			t.Error("unexpected operation", body)
		}
	})
	refreshed := make(chan error, 1)
	go func() { refreshed <- recoverPreviewsContext(context.Background()) }()
	<-firstList
	stopped := make(chan map[string]any, 1)
	go func() { stopped <- (FrontendBridge{}).StopPreview(recoveredPreviewID) }()
	select {
	case <-removed:
		close(releaseList)
		t.Fatal("stop passed an older in-flight inventory")
	case <-time.After(30 * time.Millisecond):
	}
	close(releaseList)
	if err := <-refreshed; err != nil {
		t.Fatal(err)
	}
	if result := <-stopped; result["ok"] != true {
		t.Fatal(result)
	}
	if len(previewList()) != 0 {
		t.Fatal("an older inventory recreated the removed preview")
	}
}

func manualPreviewRecoveryFixture(t *testing.T) *Mapping {
	t.Helper()
	connection := previewRecoveryFixture(t, func(w http.ResponseWriter, r *http.Request) {
		t.Error("manual SSH preview attempted a managed account API", r.URL.Path)
		http.Error(w, "unexpected account API", http.StatusBadRequest)
	})
	cfg := store.config()
	cfg.WorkspaceAccount, cfg.WorkspaceLoginURL, cfg.WorkspaceRoot = "", "", ""
	cfg.SSHHost, cfg.SSHUser = "manual.example.test", "test-user"
	cfg.ServerURL, cfg.WorkspaceServerURL = connection.baseURL, connection.baseURL
	if err := store.updateConfig(cfg); err != nil {
		t.Fatal(err)
	}
	tunnel = newTunnel(cfg, "unused-fixture-key", func() {})
	mapping := &Mapping{LocalPath: t.TempDir(), ServerPath: "/srv/manual-project", ServerID: serverIdentity(cfg), BindingEpoch: "manual-epoch", Mode: "vps"}
	if err := store.addMapping(mapping); err != nil {
		t.Fatal(err)
	}
	previousDocker := previewDockerOutputContext
	t.Cleanup(func() { previewDockerOutputContext = previousDocker })
	return mapping
}

func manualPreviewDetail(id string, mapping *Mapping) manualPreviewInspect {
	var detail manualPreviewInspect
	detail.Name = "/" + id
	detail.Config.Labels = map[string]string{"chisa.project": mapping.ServerPath}
	detail.Mounts = append(detail.Mounts, struct {
		Type, Source, Destination string
		RW                        bool
	}{Type: "bind", Source: mapping.ServerPath, Destination: "/workspace", RW: true})
	return detail
}

func TestPreviewRecoveryManualDiscoversAndStopsOnlyScopedLegacyContainer(t *testing.T) {
	mapping := manualPreviewRecoveryFixture(t)
	legacyID := "chisa-preview-0123456789abcdef"
	details := []manualPreviewInspect{manualPreviewDetail(legacyID, mapping)}
	wrongMount := manualPreviewDetail("chisa-preview-1111111111111111", mapping)
	wrongMount.Mounts[0].Source = "/srv/other-project"
	foreign := manualPreviewDetail("chisa-preview-2222222222222222", mapping)
	foreign.Config.Labels["chisa.preview.scope"] = "another-ssh-scope"
	wrongName := manualPreviewDetail("unrelated-container", mapping)
	details = append(details, wrongMount, foreign, wrongName)
	removed := ""
	transport := tunnel
	previewDockerOutputContext = func(_ context.Context, _ time.Duration, captured *Tunnel, args ...string) ([]byte, error) {
		if captured != transport {
			t.Fatal("Docker command switched to a different SSH connection")
		}
		switch args[0] {
		case "ps":
			if strings.Join(args, " ") != "ps --all --quiet --filter label=chisa.project="+mapping.ServerPath {
				t.Fatal("preview discovery did not restrict the exact project label", args)
			}
			return []byte("fixture-container"), nil
		case "inspect":
			return json.Marshal(details)
		case "rm":
			if len(args) != 3 || args[1] != "--force" || args[2] != legacyID {
				t.Fatal("stop targeted an unverified Docker container", args)
			}
			removed, details = args[2], nil
			return nil, nil
		default:
			return nil, fmt.Errorf("unexpected Docker operation: %v", args)
		}
	}
	if err := recoverPreviewsContext(context.Background()); err != nil {
		t.Fatal(err)
	}
	items := previewList()
	if len(items) != 1 || items[0].ID != legacyID || items[0].ServerID != mapping.ServerID || items[0].Managed || items[0].LocalURL != "" {
		t.Fatal("legacy manual preview was not precisely recovered", items)
	}
	if err := restoreManualPreviewForward(context.Background(), items[0], mapping); err == nil || !strings.Contains(err.Error(), "旧绑定") {
		t.Fatal("legacy preview without metadata was adopted for opening", err)
	}
	result := (FrontendBridge{}).StopPreview(legacyID)
	if result["ok"] != true || removed != legacyID || len(previewList()) != 0 {
		t.Fatal("recovered manual preview could not be stopped", result, removed)
	}
}

func TestPreviewRecoveryManualMetadataAndBindingLimitOpening(t *testing.T) {
	mapping := manualPreviewRecoveryFixture(t)
	id := "chisa-preview-0123456789abcdef"
	detail := manualPreviewDetail(id, mapping)
	detail.Config.Labels["chisa.preview.scope"] = mapping.ServerID
	detail.Config.Labels["chisa.preview.epoch"] = mapping.BindingEpoch
	detail.Config.Labels["chisa.preview.port"] = "3000"
	_ = json.Unmarshal([]byte(`{"PortBindings":{"3000/tcp":[{"HostIp":"127.0.0.1","HostPort":"43000"}]}}`), &detail.HostConfig)
	previewDockerOutputContext = func(_ context.Context, _ time.Duration, _ *Tunnel, args ...string) ([]byte, error) {
		if args[0] == "ps" {
			return []byte("fixture-container"), nil
		}
		return json.Marshal([]manualPreviewInspect{detail})
	}
	if err := recoverPreviewsContext(context.Background()); err != nil {
		t.Fatal(err)
	}
	item := previewList()[0]
	if item.RemoteEpoch != mapping.BindingEpoch || item.RemoteHost != "127.0.0.1" || item.RemotePort != 43000 {
		t.Fatal("published localhost forward metadata was not recovered", item)
	}
	detail.Config.Labels["chisa.preview.epoch"] = "old-binding"
	previews.Lock()
	item.LocalURL = "http://127.0.0.1:1"
	previews.items[id] = item
	previews.Unlock()
	result := (FrontendBridge{}).OpenPreview(id)
	if result["ok"] != false || !strings.Contains(result["error"].(string), "旧绑定") {
		t.Fatal("old epoch bypassed the Open guard using a previous local URL", result)
	}
}

func TestPreviewRecoveryManualRejectsChangedScopeAndMalformedInventory(t *testing.T) {
	mapping := manualPreviewRecoveryFixture(t)
	previewDockerOutputContext = func(_ context.Context, _ time.Duration, _ *Tunnel, args ...string) ([]byte, error) {
		if args[0] == "ps" {
			return []byte("fixture-container"), nil
		}
		cfg := store.config()
		cfg.SSHHost = "other.example.test"
		if err := store.updateConfig(cfg); err != nil {
			t.Fatal(err)
		}
		tunnel = newTunnel(cfg, "unused-fixture-key", func() {})
		return json.Marshal([]manualPreviewInspect{manualPreviewDetail("chisa-preview-0123456789abcdef", mapping)})
	}
	if err := recoverPreviewsContext(context.Background()); err == nil || !strings.Contains(err.Error(), "连接已改变") || len(previewList()) != 0 {
		t.Fatal("late inventory was adopted after an SSH scope switch", err, previewList())
	}
	cfg := store.config()
	cfg.SSHHost = "manual.example.test"
	if err := store.updateConfig(cfg); err != nil {
		t.Fatal(err)
	}
	tunnel = newTunnel(cfg, "unused-fixture-key", func() {})
	id := "chisa-preview-0123456789abcdef"
	previews.items[id] = Preview{ID: id, ServerPath: mapping.ServerPath, ServerID: mapping.ServerID, Epoch: mapping.BindingEpoch}
	previewDockerOutputContext = func(_ context.Context, _ time.Duration, _ *Tunnel, args ...string) ([]byte, error) {
		if args[0] == "ps" {
			return []byte("fixture-container"), nil
		}
		return []byte("not JSON"), nil
	}
	if err := recoverPreviewsContext(context.Background()); err == nil || len(previewList()) != 1 {
		t.Fatal("invalid manual inventory discarded a known stop capability", err)
	}
}
