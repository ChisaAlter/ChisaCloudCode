package main

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
)

func resetLegacyProjectMigration() {
	legacyProjectMigration.Lock()
	legacyProjectMigration.done = map[string]bool{}
	legacyProjectMigration.Unlock()
}

// legacyProjectFixture installs a store whose configuration yields the managed
// account identity, plus one mapping for that identity and one foreign mapping.
func legacyProjectFixture(t *testing.T) (identity string, foreign *Mapping) {
	t.Helper()
	previous := store
	t.Cleanup(func() { store = previous; resetLegacyProjectMigration() })
	resetLegacyProjectMigration()

	cfg := Config{
		WorkspaceLoginURL: "https://login.example",
		ServerURL:         "https://workspace.example",
		WorkspaceAccount:  `{"id":1,"username":"owner"}`,
		WorkspaceRoot:     "/opt/chisacloudcode/workspaces",
	}
	store = &Store{Cfg: cfg}
	identity = serverIdentity(cfg)
	foreign = &Mapping{LocalPath: t.TempDir(), ServerPath: "/opt/chisacloudcode/workspaces/local/other", ServerID: "account:" + "b" + "000000000000000000000000000000000000000000000000000000000000000"}
	store.Mappings = []*Mapping{
		{LocalPath: t.TempDir(), ServerPath: "/opt/chisacloudcode/workspaces/local/legacy-a", ServerID: identity},
		{LocalPath: t.TempDir(), ServerPath: "/opt/chisacloudcode/workspaces/local/legacy-a", ServerID: identity},
		{LocalPath: t.TempDir(), ServerPath: "/opt/chisacloudcode/workspaces/local/legacy-b", ServerID: identity},
		foreign,
	}
	return identity, foreign
}

func TestLegacyMigratableServerPathsKeepsOnlyTheCurrentAccount(t *testing.T) {
	identity, _ := legacyProjectFixture(t)

	paths := legacyMigratableServerPaths(identity)

	if len(paths) != 2 {
		t.Fatalf("expected the two distinct paths of the current account, got %d: %v", len(paths), paths)
	}
	if paths[0] != "/opt/chisacloudcode/workspaces/local/legacy-a" || paths[1] != "/opt/chisacloudcode/workspaces/local/legacy-b" {
		t.Fatalf("unexpected paths: %v", paths)
	}
	if paths := legacyMigratableServerPaths(""); len(paths) != 0 {
		t.Fatalf("an empty identity must migrate nothing, got %v", paths)
	}
}

func TestLegacyMigratableServerPathsRejectsUnusableValues(t *testing.T) {
	identity, _ := legacyProjectFixture(t)
	store.Mappings = append(store.Mappings,
		&Mapping{ServerPath: "relative/path", ServerID: identity},
		&Mapping{ServerPath: "/", ServerID: identity},
		&Mapping{ServerPath: "/opt/chisacloudcode/workspaces/local/line\nbreak", ServerID: identity},
		nil,
	)

	for _, path := range legacyMigratableServerPaths(identity) {
		if path == "relative/path" || path == "/" || len(path) == 0 {
			t.Fatalf("unusable path leaked into migration: %q", path)
		}
	}
}

func TestRegisterLegacyProjectsPostsOncePerIdentity(t *testing.T) {
	identity, _ := legacyProjectFixture(t)
	requests := 0
	var received []string
	var authorization string

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests++
		authorization = r.Header.Get("Authorization")
		if r.Method != http.MethodPost || r.URL.Path != "/api/projects/register-existing" {
			t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
		}
		body, _ := io.ReadAll(r.Body)
		var payload struct {
			Paths []string `json:"paths"`
		}
		if err := json.Unmarshal(body, &payload); err != nil {
			t.Errorf("unreadable payload: %v", err)
		}
		received = payload.Paths
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"success":true,"results":[{"path":"/x","outcome":"registered"},{"path":"/y","outcome":"existing"}]}`))
	}))
	defer server.Close()

	connection := &serverConnection{baseURL: server.URL, client: server.Client(), accessToken: "test-token"}
	registerLegacyProjects(connection)
	registerLegacyProjects(connection)

	if requests != 1 {
		t.Fatalf("expected exactly one registration per identity, got %d requests", requests)
	}
	if authorization != "Bearer test-token" {
		t.Fatalf("registration must reuse the authenticated token, got %q", authorization)
	}
	if len(received) != 2 || received[0] != "/opt/chisacloudcode/workspaces/local/legacy-a" {
		t.Fatalf("unexpected paths sent: %v (identity %s)", received, identity)
	}
	for _, path := range received {
		if path == "/opt/chisacloudcode/workspaces/local/other" {
			t.Fatal("a foreign account mapping must never be registered")
		}
	}
}

func TestRegisterLegacyProjectsSkipsWithoutMatchingAccountOrToken(t *testing.T) {
	legacyProjectFixture(t)
	requests := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		requests++
		_, _ = w.Write([]byte(`{"success":true,"results":[]}`))
	}))
	defer server.Close()

	// No usable access token: the request must not be attempted at all.
	registerLegacyProjects(&serverConnection{baseURL: server.URL, client: server.Client()})
	if requests != 0 {
		t.Fatalf("registration without a token must not call the backend, got %d", requests)
	}

	// Only a foreign mapping exists for this identity: nothing to migrate.
	store.Mappings = []*Mapping{{ServerPath: "/opt/chisacloudcode/workspaces/local/other", ServerID: "account:" + "c" + "000000000000000000000000000000000000000000000000000000000000000"}}
	resetLegacyProjectMigration()
	registerLegacyProjects(&serverConnection{baseURL: server.URL, client: server.Client(), accessToken: "token"})
	if requests != 0 {
		t.Fatalf("foreign mappings must not reach the backend, got %d requests", requests)
	}
}

func TestRegisterLegacyProjectsToleratesFailure(t *testing.T) {
	legacyProjectFixture(t)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer server.Close()

	registerLegacyProjects(&serverConnection{baseURL: server.URL, client: server.Client(), accessToken: "token"})
	registerLegacyProjects(&serverConnection{baseURL: server.URL, client: server.Client(), accessToken: "token"})
}
