//go:build windows

package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"testing"
	"time"
)

type reviewRoundTrip func(*http.Request) (*http.Response, error)

func (f reviewRoundTrip) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

// Account requests use real HTTP sockets without creating an SSH process.
func reviewHTTP(t *testing.T, handler http.HandlerFunc) *serverConnection {
	t.Helper()
	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)
	previous := apiConnection
	current, err := newServerConnection(server.URL, server.URL)
	if err != nil {
		t.Fatal(err)
	}
	apiConnection = current
	t.Cleanup(func() {
		current.cancel()
		apiConnection = previous
	})
	return current
}

func TestReviewBridgeCancellationReachesRealHTTP(t *testing.T) {
	started, canceled := make(chan struct{}), make(chan struct{})
	reviewHTTP(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/slow" {
			t.Errorf("unexpected preflight: %s", r.URL.Path)
			w.WriteHeader(500)
			return
		}
		close(started)
		<-r.Context().Done()
		close(canceled)
	})
	bridge := FrontendBridge{}
	id := bridge.BeginServerRequest()
	result := make(chan BridgeResponse, 1)
	go func() { result <- bridge.ServerRequest(id, "GET", "/api/slow", nil, "") }()
	select {
	case <-started:
	case <-time.After(3 * time.Second):
		t.Fatal("HTTP did not start")
	}
	bridge.CancelServerRequest(id)
	select {
	case response := <-result:
		if response.Status != 499 {
			t.Fatalf("canceled request returned %d", response.Status)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("bridge cancellation did not settle")
	}
	select {
	case <-canceled:
	case <-time.After(3 * time.Second):
		t.Fatal("upstream socket did not observe cancellation")
	}
}

func TestReviewBridgeSendsNoHealthPreflight(t *testing.T) {
	paths := make(chan string, 2)
	reviewHTTP(t, func(w http.ResponseWriter, r *http.Request) {
		paths <- r.URL.Path
		w.Header().Set("X-Refreshed-Token", "example.payload.signature")
		_, _ = w.Write([]byte("actual HTTP response"))
	})
	bridge := FrontendBridge{}
	response := bridge.ServerRequest(bridge.BeginServerRequest(), "GET", "/api/projects", nil, "")
	body, _ := base64.StdEncoding.DecodeString(response.BodyB64)
	if response.Status != 200 || string(body) != "actual HTTP response" {
		t.Fatalf("response lost: %+v", response)
	}
	if len(paths) != 1 || <-paths != "/api/projects" {
		t.Fatal("business request sent extra health probes")
	}
}

func TestReviewBridgeCancelBeforeForwardAndOnAccountReplacement(t *testing.T) {
	current := reviewHTTP(t, func(w http.ResponseWriter, r *http.Request) { t.Error("canceled request was forwarded") })
	bridge := FrontendBridge{}
	id := bridge.BeginServerRequest()
	bridge.CancelServerRequest(id)
	if response := bridge.ServerRequest(id, "GET", "/api/projects", nil, ""); response.Status != 499 {
		t.Fatal(response)
	}
	id = bridge.BeginServerRequest()
	value, _ := bridgeRequests.Load(id)
	current.cancel()
	if value.(*bridgeRequest).ctx.Err() != context.Canceled {
		t.Fatal("replacing an account connection left its requests alive")
	}
}

func TestReviewServerSwitchPreservesExistingMappingAndConnection(t *testing.T) {
	m := isolatePi(t)
	key := filepath.Join(t.TempDir(), "key")
	if err := os.WriteFile(key, []byte("test key"), 0600); err != nil {
		t.Fatal(err)
	}
	store.Cfg = Config{ServerURL: "http://first.test:8791", WorkspaceServerURL: "http://first.test:8791", SSHHost: "first.test", SSHUser: "root", KeyPath: key}
	m.ServerID = serverIdentity(store.Cfg)
	previous := tunnel
	current := &Tunnel{proc: &exec.Cmd{}, bridgeReady: true, bridgePort: 10001}
	tunnel = current
	t.Cleanup(func() { tunnel = previous })
	for _, target := range []string{"http://second.test:8791", "http://first.test:8792"} {
		result := (FrontendBridge{}).ConnectWorkspace(target, "first.test", "root", key)
		if result["ok"] != false || tunnel != current || store.config().SSHHost != "first.test" || len(store.mappings()) != 1 {
			t.Fatalf("server switch modified the old binding: %v", result)
		}
	}
	piAgents.sessions["running"] = &piSession{Running: true}
	result := (FrontendBridge{}).ConnectWorkspace("http://first.test:8791", "first.test", "root", key)
	if result["ok"] != true || tunnel != current {
		t.Fatal("connecting the ready instance interrupted its task")
	}
}

func TestReviewLegacyBindingMigrationAndWrongServerSync(t *testing.T) {
	directory := t.TempDir()
	cfg := Config{ServerURL: "http://old.test:8791", SSHHost: "old.test", SSHUser: "user", Token: "test"}
	raw, _ := json.Marshal(map[string]any{"config": cfg, "mappings": []Mapping{{LocalPath: "C:\\project", ServerPath: "/srv/project", BindingEpoch: "epoch"}}})
	if err := os.WriteFile(filepath.Join(directory, "state.json"), raw, 0600); err != nil {
		t.Fatal(err)
	}
	saved := loadStore(directory)
	m := saved.mappings()[0]
	if m.ServerID != serverIdentity(cfg) || loadStore(directory).mappings()[0].ServerID != m.ServerID {
		t.Fatal("legacy ownership did not persist")
	}
	previous := store
	store = saved
	t.Cleanup(func() { store = previous })
	other := cfg
	other.SSHHost = "other.test"
	if err := store.updateConfig(other); err != nil {
		t.Fatal(err)
	}
	if err := ensureSync(m); err == nil {
		t.Fatal("wrong-server synchronization was accepted")
	}
}

func TestReviewPiDeltaUpdatesAndHistoryRecovery(t *testing.T) {
	m := isolatePi(t)
	s := &piSession{SessionID: "delta", ServerPath: m.ServerPath, Cursor: 20, Messages: []piMessage{{ID: "old", Content: "unchanged", updatedAt: 1}, {ID: "stream", Content: "latest", updatedAt: 20}}, Events: []piEvent{{Seq: 19}, {Seq: 20}}}
	full := piSnapshotLocked(s, 0)
	if len(full["messages"].([]piMessage)) != 2 || full["messagesReset"] != true {
		t.Fatal("initial history incomplete")
	}
	delta := piSnapshotLocked(s, 19)
	if !reflect.DeepEqual(delta["messages"], []piMessage{s.Messages[1]}) || delta["messagesReset"] != false {
		t.Fatal("delta repeated old history or lost streaming updates")
	}
	idle := piSnapshotLocked(s, 20)
	if len(idle["messages"].([]piMessage)) != 0 {
		t.Fatal("idle poll repeated history")
	}
	if _, included := idle["lastResult"]; included {
		t.Fatal("idle poll repeated full outcome")
	}
	recovered := piSnapshotLocked(s, 5)
	if len(recovered["messages"].([]piMessage)) != 2 || recovered["messagesReset"] != true {
		t.Fatal("lost event window did not recover history")
	}
	s.Events = nil
	s.Messages[0].updatedAt, s.Messages[1].updatedAt = 0, 0
	if len(piSnapshotLocked(s, 0)["messages"].([]piMessage)) != 2 {
		t.Fatal("restart lost persisted history")
	}
}
