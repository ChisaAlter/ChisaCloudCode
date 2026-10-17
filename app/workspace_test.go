package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
)

func TestWorkspaceRPCRejectsUnboundCapabilities(t *testing.T) {
	previous := store
	defer func() { store = previous }()
	store = &Store{Cfg: Config{Token: "session-token"}, Mappings: []*Mapping{{ServerPath: "/srv/project", BindingEpoch: "current"}}}
	mux := http.NewServeMux()
	registerFSEndpoints(mux)
	for _, tc := range []struct {
		token, epoch string
		status       int
	}{{"", "current", 401}, {"wrong", "current", 401}, {"session-token", "old", 409}} {
		req := httptest.NewRequest("POST", "/workspace/rpc", strings.NewReader(`{"op":"read","path":"/workspace/private"}`))
		req.Header.Set("X-Bridge-Token", tc.token)
		req.Header.Set("X-Cwd", "/srv/project")
		req.Header.Set("X-Binding-Epoch", tc.epoch)
		response := httptest.NewRecorder()
		mux.ServeHTTP(response, req)
		if response.Code != tc.status {
			t.Fatalf("token/epoch guard returned %d; want %d", response.Code, tc.status)
		}
	}
}

func TestStorePersistsConnectionAndRevocation(t *testing.T) {
	dir := t.TempDir()
	s := loadStore(dir)
	cfg := s.config()
	cfg.ServerURL = "http://example.test:8791"
	cfg.SSHHost = "example.test"
	if err := s.updateConfig(cfg); err != nil {
		t.Fatal(err)
	}
	m := &Mapping{LocalPath: filepath.Join(dir, "project"), ServerPath: "/srv/Project", BindingEpoch: "epoch"}
	if err := s.addMapping(m); err != nil {
		t.Fatal(err)
	}
	restored := loadStore(dir)
	if restored.config().ServerURL != cfg.ServerURL || restored.findMappingByServer("/srv/Project") == nil {
		t.Fatal("state lost connection or binding")
	}
	if restored.findMappingByServer("/srv/project") != nil {
		t.Fatal("POSIX server paths must be case-sensitive")
	}
	if err := restored.removeMapping(m.ServerPath); err != nil {
		t.Fatal(err)
	}
	if len(loadStore(dir).mappings()) != 0 {
		t.Fatal("revocation did not persist")
	}
}

func TestUnavailableWorkspaceNeverFallsBackToWindows(t *testing.T) {
	previous := store
	defer func() { store = previous }()
	m := &Mapping{LocalPath: t.TempDir(), ServerPath: "/srv/project", BindingEpoch: "epoch"}
	store = &Store{Mappings: []*Mapping{m}}
	response := workspaceRPC(m, map[string]any{"op": "exec", "command": "echo MUST_NOT_RUN"})
	raw, _ := json.Marshal(response)
	if response["code"] != "WORKSPACE_UNAVAILABLE" || strings.Contains(string(raw), "MUST_NOT_RUN") {
		t.Fatalf("unexpected unavailable response: %s", raw)
	}
}
