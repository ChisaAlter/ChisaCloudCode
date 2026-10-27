//go:build windows

package main

import (
	"encoding/json"
	"encoding/pem"
	"fmt"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
	"time"
)

func TestAccountCheckKeepsConcurrentPluginQuery(t *testing.T) {
	cases := []struct {
		name                          string
		id                            int
		username, instance, workspace string
		preserve                      bool
	}{
		{"same account", 1, "tester", "/instances/main", "http://fixture.test:8791", true},
		{"different account", 2, "other", "/instances/main", "http://fixture.test:8791", false},
		{"different instance", 1, "tester", "/instances/other", "http://fixture.test:8791", false},
		{"different workspace authorization", 1, "tester", "/instances/main", "http://fixture.test:8792", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv("APPDATA", t.TempDir())
			previousStore, previousConnection, previousDefaults := store, apiConnection, serviceConfiguration
			store = &Store{path: filepath.Join(t.TempDir(), "state.json")}
			started, release := make(chan struct{}), make(chan struct{})
			upstream := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				switch r.URL.Path {
				case "/api/auth/login":
					fmt.Fprint(w, `{"token":"fixture-token","user":{"id":1,"username":"tester","displayName":"Before"},"instancePath":"/instances/main","workspaceServerUrl":"http://fixture.test:8791"}`)
				case "/instances/main/api/auth/user":
					w.Header().Set("X-Chisa-Instance-Path", tc.instance)
					w.Header().Set("X-Chisa-Workspace-Server-Url", tc.workspace)
					fmt.Fprintf(w, `{"user":{"id":%d,"username":%q,"displayName":"Updated profile"}}`, tc.id, tc.username)
				case "/instances/main/api/plugins":
					close(started)
					select {
					case <-release:
						fmt.Fprint(w, `{"plugins":[{"name":"claude-usage","enabled":true}]}`)
					case <-r.Context().Done():
					}
				default:
					w.WriteHeader(404)
				}
			}))
			cert := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: upstream.Certificate().Raw})
			serviceConfiguration, _ = json.Marshal(serviceDefaults{LoginURL: upstream.URL, CACertificate: string(cert)})
			t.Cleanup(func() {
				if apiConnection != nil {
					apiConnection.cancel()
				}
				upstream.Close()
				store, apiConnection, serviceConfiguration = previousStore, previousConnection, previousDefaults
			})
			if err := initializeServerConnection(); err != nil {
				t.Fatal(err)
			}
			bridge := FrontendBridge{}
			login := bridge.ServerRequest(bridge.BeginServerRequest(), "POST", "/api/auth/login", nil, "")
			if login.Status != 200 {
				t.Fatalf("login status=%d", login.Status)
			}
			before := bridge.GetApiConnection()["version"]
			plugins := make(chan BridgeResponse, 1)
			id := bridge.BeginServerRequest()
			go func() { plugins <- bridge.ServerRequest(id, "GET", "/api/plugins", nil, "") }()
			select {
			case <-started:
			case <-time.After(3 * time.Second):
				t.Fatal("plugin request did not reach service")
			}
			account := bridge.ServerRequest(bridge.BeginServerRequest(), "GET", "/api/auth/user", nil, "")
			close(release)
			if account.Status != 200 {
				t.Fatalf("account status=%d", account.Status)
			}
			after := bridge.GetApiConnection()["version"]
			select {
			case result := <-plugins:
				if tc.preserve {
					if before != after || result.Status != 200 {
						t.Fatalf("same account canceled plugins: before=%v after=%v status=%d", before, after, result.Status)
					}
				} else if before == after || result.Status != 499 {
					t.Fatalf("changed authorization retained stale request: before=%v after=%v status=%d", before, after, result.Status)
				}
			case <-time.After(3 * time.Second):
				t.Fatal("plugin request did not finish")
			}
		})
	}
}
