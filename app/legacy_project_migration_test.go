package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// Root-package tests share store/apiConnection and are intentionally not
// parallel. Each W08 fixture captures/restores the globals under the account
// lock, cancels its own connections, and waits for all migration goroutines.
type legacyMigrationFixture struct {
	store         *Store
	connection    *serverConnection
	upstream      *httptest.Server
	workspaceURL  string
	instancePath  string
	registrations atomic.Int32
	verifications atomic.Int32
	mu            sync.Mutex
	received      [][]string
	override      http.HandlerFunc
}

func legacyMigrationToken(id int, username, nonce string) string {
	claims, _ := json.Marshal(map[string]any{"userId": id, "username": username, "nonce": nonce})
	return "eyJhbGciOiJIUzI1NiJ9." + base64.RawURLEncoding.EncodeToString(claims) + ".test-signature"
}

func newLegacyMigrationFixture(t *testing.T, registration http.HandlerFunc) *legacyMigrationFixture {
	t.Helper()
	fixture := &legacyMigrationFixture{workspaceURL: "https://workspace.example/instances/legacy", instancePath: "/instances/legacy"}
	fixture.upstream = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fixture.mu.Lock()
		override := fixture.override
		fixture.mu.Unlock()
		if override != nil {
			override(w, r)
			return
		}
		expectedToken := "Bearer " + legacyMigrationToken(1, "owner", "initial")
		if r.Header.Get("Authorization") != expectedToken {
			t.Errorf("request has unexpected originating credential")
		}
		switch {
		case strings.HasSuffix(r.URL.Path, "/api/auth/user"):
			fixture.verifications.Add(1)
			w.Header().Set("X-Chisa-Instance-Path", fixture.instancePath)
			w.Header().Set("X-Chisa-Workspace-Server-Url", fixture.workspaceURL)
			fmt.Fprint(w, `{"user":{"id":1,"username":"owner"}}`)
		case strings.HasSuffix(r.URL.Path, "/api/projects/register-existing"):
			fixture.registrations.Add(1)
			var body struct {
				Paths []string `json:"paths"`
			}
			if r.Method != http.MethodPost || json.NewDecoder(r.Body).Decode(&body) != nil {
				t.Error("invalid registration request")
				w.WriteHeader(http.StatusBadRequest)
				return
			}
			fixture.mu.Lock()
			fixture.received = append(fixture.received, append([]string(nil), body.Paths...))
			fixture.mu.Unlock()
			if registration != nil {
				// The body was consumed only to record paths; give the handler its
				// own copy so fault injection uses the real HTTP contract.
				raw, _ := json.Marshal(body)
				r.Body = io.NopCloser(bytes.NewReader(raw))
				registration(w, r)
				return
			}
			writeLegacyMigrationSuccess(t, w, body.Paths, "registered")
		default:
			t.Errorf("unexpected migration route %s", r.URL.Path)
			http.NotFound(w, r)
		}
	}))
	c, err := newServerConnection(fixture.upstream.URL, fixture.upstream.URL+fixture.instancePath)
	if err != nil {
		fixture.upstream.Close()
		t.Fatal(err)
	}
	fixture.connection = c
	c.authenticated, c.accessToken = true, legacyMigrationToken(1, "owner", "initial")
	c.accountIdentity = tokenAccountIdentity(c.accessToken)
	profile := t.TempDir()
	cfg := Config{
		LoginURL: fixture.upstream.URL, APIURL: c.baseURL, WorkspaceLoginURL: fixture.upstream.URL,
		ServerURL: fixture.workspaceURL, WorkspaceServerURL: fixture.workspaceURL,
		WorkspaceAccount: c.accountIdentity, WorkspaceRoot: "/workspaces",
	}
	identity := serverIdentity(cfg)
	fixture.store = &Store{path: filepath.Join(profile, "state.json"), Cfg: cfg, Mappings: []*Mapping{
		{LocalPath: filepath.Join(profile, "project-a"), ServerPath: "/workspaces/local/legacy-a", ServerID: identity, BindingEpoch: "epoch-a"},
		{LocalPath: filepath.Join(profile, "project-b"), ServerPath: "/workspaces/local/legacy-b", ServerID: identity, BindingEpoch: "epoch-b"},
	}}
	if err := fixture.store.flush(); err != nil {
		t.Fatal(err)
	}
	serverConnectionMu.Lock()
	previousStore, previousConnection, previousSwitching := store, apiConnection, serverConnectionSwitching
	store, apiConnection, serverConnectionSwitching = fixture.store, c, false
	serverConnectionMu.Unlock()
	frontendRequestsMu.Lock()
	previousClosed := frontendRequestsClosed
	frontendRequestsClosed = false
	frontendRequestsMu.Unlock()
	t.Cleanup(func() {
		serverConnectionMu.Lock()
		if apiConnection != nil && apiConnection != previousConnection {
			apiConnection.cancel()
			apiConnection.client.CloseIdleConnections()
		}
		c.cancel()
		store, apiConnection, serverConnectionSwitching = previousStore, previousConnection, previousSwitching
		serverConnectionMu.Unlock()
		fixture.upstream.Close()
		frontendRequestsMu.Lock()
		frontendRequestsClosed = previousClosed
		frontendRequestsMu.Unlock()
	})
	return fixture
}

// A second test process reloads the persisted Store and a new session handle;
// no parent-side process map, gate or parsed state can suppress its HTTP calls.
func TestLegacyMigrationProcessRestartHelper(t *testing.T) {
	if os.Getenv("CHISA_W08_RESTART_HELPER") != "1" {
		return
	}
	profile := os.Getenv("CHISA_W08_PROFILE")
	raw, err := os.ReadFile(profile)
	if err != nil {
		t.Fatal(err)
	}
	loaded := &Store{path: profile}
	if err := json.Unmarshal(raw, loaded); err != nil {
		t.Fatal(err)
	}
	c, err := newServerConnection(loaded.Cfg.LoginURL, loaded.Cfg.APIURL)
	if err != nil {
		t.Fatal(err)
	}
	defer c.cancel()
	c.authenticated, c.accessToken = true, legacyMigrationToken(1, "owner", "initial")
	c.accountIdentity = tokenAccountIdentity(c.accessToken)
	store, apiConnection, serverConnectionSwitching = loaded, c, false
	snapshot, reason := captureLegacyProjectMigration(c)
	if snapshot == nil {
		t.Fatalf("fresh process could not capture source: %s", reason)
	}
	state, err := openLegacyMigrationState(profile)
	if err != nil {
		snapshot.close()
		t.Fatalf("fresh process could not reopen state: %v", err)
	}
	for _, mapping := range snapshot.mappings {
		if done, err := state.completed(legacyMigrationRecordFor(snapshot, mapping)); err != nil || !done {
			state.close()
			snapshot.close()
			t.Fatal("fresh process did not recover a verified success")
		}
	}
	state.close()
	snapshot.close()
	registerLegacyProjects(c)
}

func TestLegacyMigrationSuccessSurvivesRealProcessRestart(t *testing.T) {
	fixture := newLegacyMigrationFixture(t, nil)
	registerLegacyProjects(fixture.connection)
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	command := exec.CommandContext(ctx, executable, "-test.run=^TestLegacyMigrationProcessRestartHelper$", "-test.count=1")
	command.Env = append(os.Environ(), "CHISA_W08_RESTART_HELPER=1", "CHISA_W08_PROFILE="+fixture.store.path)
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("fresh process failed: %v\n%s", err, output)
	}
	if fixture.registrations.Load() != 1 || fixture.verifications.Load() != 1 {
		t.Fatal("fresh process repeated a completed migration")
	}
}

func writeLegacyMigrationSuccess(t *testing.T, w http.ResponseWriter, paths []string, outcome string) {
	t.Helper()
	results := make([]map[string]string, 0, len(paths))
	for _, serverPath := range paths {
		results = append(results, map[string]string{"path": serverPath, "outcome": outcome})
	}
	if err := json.NewEncoder(w).Encode(map[string]any{"success": true, "results": results}); err != nil {
		t.Errorf("write test response: %v", err)
	}
}

func legacyMigrationAwait(t *testing.T, signal <-chan struct{}, label string) {
	t.Helper()
	select {
	case <-signal:
	case <-time.After(5 * time.Second):
		t.Fatal(label)
	}
}

func legacyMigrationRun(connection *serverConnection) <-chan struct{} {
	done := make(chan struct{})
	go func() { defer close(done); registerLegacyProjects(connection) }()
	return done
}

func (fixture *legacyMigrationFixture) setHandler(handler http.HandlerFunc) {
	fixture.mu.Lock()
	fixture.override = handler
	fixture.mu.Unlock()
}

func (fixture *legacyMigrationFixture) paths() [][]string {
	fixture.mu.Lock()
	defer fixture.mu.Unlock()
	result := make([][]string, len(fixture.received))
	for i, values := range fixture.received {
		result[i] = append([]string(nil), values...)
	}
	return result
}

func TestLegacyMigrationRegistersOnlyProvenSourceAndPreservesRetiredStore(t *testing.T) {
	fixture := newLegacyMigrationFixture(t, nil)
	fixture.store.mu.Lock()
	duplicate := *fixture.store.Mappings[0]
	fixture.store.Mappings = append(fixture.store.Mappings,
		&duplicate,
		&Mapping{LocalPath: "foreign", ServerPath: "/workspaces/local/FOREIGN_PATH_CANARY", ServerID: "account:unknown"},
		&Mapping{LocalPath: "invalid", ServerPath: "/workspaces/../foreign", ServerID: duplicate.ServerID},
		&Mapping{LocalPath: "outside", ServerPath: "/other/root", ServerID: duplicate.ServerID},
		&Mapping{LocalPath: "unknown", ServerPath: "/workspaces/local/unknown"}, nil,
	)
	fixture.store.mu.Unlock()
	if err := fixture.store.flush(); err != nil {
		t.Fatal(err)
	}
	before, err := os.ReadFile(fixture.store.path)
	if err != nil {
		t.Fatal(err)
	}
	registerLegacyProjects(fixture.connection)
	registerLegacyProjects(fixture.connection)
	if fixture.registrations.Load() != 1 || fixture.verifications.Load() != 1 {
		t.Fatalf("successful mapping repeated: post=%d verify=%d", fixture.registrations.Load(), fixture.verifications.Load())
	}
	if got := fixture.paths(); !reflect.DeepEqual(got, [][]string{{"/workspaces/local/legacy-a", "/workspaces/local/legacy-b"}}) {
		t.Fatalf("unproven or duplicate paths reached origin: %v", got)
	}
	after, err := os.ReadFile(fixture.store.path)
	if err != nil || !bytes.Equal(before, after) {
		t.Fatal("migration rewrote the retired mapping store")
	}
}

func TestLegacyMigrationSuccessSurvivesFreshLoginAndStoreReload(t *testing.T) {
	fixture := newLegacyMigrationFixture(t, nil)
	registerLegacyProjects(fixture.connection)
	serverConnectionMu.Lock()
	fresh, err := newServerConnection(fixture.connection.loginURL, fixture.connection.baseURL)
	if err != nil {
		serverConnectionMu.Unlock()
		t.Fatal(err)
	}
	fresh.authenticated, fresh.accountIdentity, fresh.accessToken = true, fixture.connection.accountIdentity, fixture.connection.accessToken
	fixture.connection.cancel()
	apiConnection = fresh
	raw, err := os.ReadFile(fixture.store.path)
	if err != nil {
		serverConnectionMu.Unlock()
		t.Fatal(err)
	}
	reloaded := &Store{path: fixture.store.path}
	if err := json.Unmarshal(raw, reloaded); err != nil {
		serverConnectionMu.Unlock()
		t.Fatal(err)
	}
	store = reloaded
	serverConnectionMu.Unlock()
	registerLegacyProjects(fresh)
	if fixture.registrations.Load() != 1 || fixture.verifications.Load() != 1 {
		t.Fatal("fresh login/reloaded store lost durable success")
	}
	if fresh.sessionHandle == fixture.connection.sessionHandle || fresh.version == fixture.connection.version {
		t.Fatal("test did not establish a fresh session incarnation")
	}
}

func TestLegacyMigrationFailureAndUnverifiedResultsRemainRetryable(t *testing.T) {
	for _, failure := range []string{"http", "rejected", "malformed", "unknown-path", "duplicate-path", "missing-result", "missing-success"} {
		t.Run(failure, func(t *testing.T) {
			var calls atomic.Int32
			fixture := newLegacyMigrationFixture(t, func(w http.ResponseWriter, r *http.Request) {
				var payload struct {
					Paths []string `json:"paths"`
				}
				if json.NewDecoder(r.Body).Decode(&payload) != nil {
					t.Error("invalid test payload")
				}
				if calls.Add(1) == 1 {
					switch failure {
					case "http":
						w.WriteHeader(http.StatusInternalServerError)
					case "rejected":
						writeLegacyMigrationSuccess(t, w, payload.Paths, "rejected")
					case "malformed":
						fmt.Fprint(w, `{"success":true`)
					case "unknown-path":
						writeLegacyMigrationSuccess(t, w, []string{"/workspaces/foreign", payload.Paths[1]}, "registered")
					case "duplicate-path":
						writeLegacyMigrationSuccess(t, w, []string{payload.Paths[0], payload.Paths[0]}, "registered")
					case "missing-result":
						writeLegacyMigrationSuccess(t, w, payload.Paths[:1], "registered")
					case "missing-success":
						fmt.Fprint(w, `{"results":[]}`)
					}
					return
				}
				writeLegacyMigrationSuccess(t, w, payload.Paths, "existing")
			})
			registerLegacyProjects(fixture.connection)
			registerLegacyProjects(fixture.connection)
			registerLegacyProjects(fixture.connection)
			if got := fixture.registrations.Load(); got != 2 {
				t.Fatalf("failure suppressed retry or success repeated: %d", got)
			}
		})
	}
}

func TestLegacyMigrationPersistsOnlySuccessfulPaths(t *testing.T) {
	var calls atomic.Int32
	fixture := newLegacyMigrationFixture(t, func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Paths []string `json:"paths"`
		}
		json.NewDecoder(r.Body).Decode(&body)
		if calls.Add(1) == 1 {
			json.NewEncoder(w).Encode(map[string]any{"success": true, "results": []map[string]string{
				{"path": body.Paths[0], "outcome": "reactivated_archived"},
				{"path": body.Paths[1], "outcome": "rejected"},
			}})
			return
		}
		writeLegacyMigrationSuccess(t, w, body.Paths, "registered")
	})
	registerLegacyProjects(fixture.connection)
	registerLegacyProjects(fixture.connection)
	registerLegacyProjects(fixture.connection)
	want := [][]string{{"/workspaces/local/legacy-a", "/workspaces/local/legacy-b"}, {"/workspaces/local/legacy-b"}}
	if !reflect.DeepEqual(fixture.paths(), want) {
		t.Fatalf("partial success not acknowledged per mapping: %v", fixture.paths())
	}
}

func TestLegacyMigrationWrongAccountServerInstanceAndUnknownSourceNeverPost(t *testing.T) {
	for _, mode := range []string{"wrong-account", "wrong-login", "wrong-server", "unknown-owner", "unknown-root", "manual-ssh", "unproven-instance", "stale-server-key", "token-identity-mismatch", "missing-handle", "missing-generation", "unauthenticated", "switching", "stale-pointer"} {
		t.Run(mode, func(t *testing.T) {
			fixture := newLegacyMigrationFixture(t, nil)
			serverConnectionMu.Lock()
			fixture.store.mu.Lock()
			switch mode {
			case "wrong-account":
				fixture.store.Cfg.WorkspaceAccount = `{"id":2,"username":"other"}`
			case "wrong-login":
				fixture.store.Cfg.WorkspaceLoginURL = "https://other.example"
			case "wrong-server":
				fixture.store.Cfg.ServerURL = "https://old-other.example"
				for _, mapping := range fixture.store.Mappings {
					mapping.ServerID = serverIdentity(fixture.store.Cfg)
				}
			case "unknown-owner":
				for _, mapping := range fixture.store.Mappings {
					mapping.ServerID = ""
				}
			case "unknown-root":
				fixture.store.Cfg.WorkspaceRoot = ""
			case "manual-ssh":
				fixture.store.Cfg.WorkspaceAccount = ""
			case "unproven-instance":
				fixture.connection.baseURL = fixture.upstream.URL + "/instances/other"
				fixture.connection.serverKey = serverKey(fixture.connection.loginURL, fixture.connection.baseURL)
				fixture.store.Cfg.APIURL = fixture.connection.baseURL
			case "stale-server-key":
				fixture.connection.serverKey = strings.Repeat("a", 64)
			case "token-identity-mismatch":
				fixture.connection.accessToken = legacyMigrationToken(2, "other", "other")
			case "missing-handle":
				fixture.connection.sessionHandle = ""
			case "missing-generation":
				fixture.connection.version = 0
			case "unauthenticated":
				fixture.connection.authenticated = false
			case "switching":
				serverConnectionSwitching = true
			case "stale-pointer":
				apiConnection = nil
			}
			fixture.store.mu.Unlock()
			serverConnectionMu.Unlock()
			registerLegacyProjects(fixture.connection)
			if fixture.registrations.Load() != 0 {
				t.Fatalf("%s sent a stored path", mode)
			}
		})
	}
}

func TestLegacyMigrationRequiresFreshOriginAttestation(t *testing.T) {
	for _, mode := range []string{"missing-workspace", "other-workspace", "other-account", "other-instance", "no-instance-proof", "unauthorized", "redirect"} {
		t.Run(mode, func(t *testing.T) {
			fixture := newLegacyMigrationFixture(t, nil)
			var foreign atomic.Int32
			other := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				foreign.Add(1)
				t.Error("origin attestation followed redirect")
			}))
			defer other.Close()
			fixture.setHandler(func(w http.ResponseWriter, r *http.Request) {
				if strings.HasSuffix(r.URL.Path, "/register-existing") {
					fixture.registrations.Add(1)
					t.Error("unproven source reached registration")
					return
				}
				workspace, instance, user := fixture.workspaceURL, fixture.instancePath, `{"id":1,"username":"owner"}`
				switch mode {
				case "missing-workspace":
					workspace = ""
				case "other-workspace":
					workspace = "https://other.example"
				case "other-account":
					user = `{"id":2,"username":"other"}`
				case "other-instance":
					instance = "/instances/other"
				case "no-instance-proof":
					instance = ""
				case "unauthorized":
					w.WriteHeader(http.StatusUnauthorized)
					return
				case "redirect":
					http.Redirect(w, r, other.URL, http.StatusTemporaryRedirect)
					return
				}
				w.Header().Set("X-Chisa-Workspace-Server-Url", workspace)
				w.Header().Set("X-Chisa-Instance-Path", instance)
				fmt.Fprintf(w, `{"user":%s}`, user)
			})
			registerLegacyProjects(fixture.connection)
			if fixture.registrations.Load() != 0 || foreign.Load() != 0 {
				t.Fatal("unverified origin or redirect received a path or token")
			}
		})
	}
}

func TestLegacyMigrationUsesVerifiedAuthenticationTargetWithoutExtraProfileProbe(t *testing.T) {
	fixture := newLegacyMigrationFixture(t, nil)
	serverConnectionMu.Lock()
	fixture.connection.verifiedWorkspaceURL = fixture.workspaceURL
	fixture.store.mu.Lock()
	fixture.store.Cfg.WorkspaceServerURL = "https://STALE_CONFIG_MUST_NOT_AUTHORIZE.example"
	fixture.store.mu.Unlock()
	serverConnectionMu.Unlock()
	registerLegacyProjects(fixture.connection)
	registerLegacyProjects(fixture.connection)
	if fixture.registrations.Load() != 1 || fixture.verifications.Load() != 0 {
		t.Fatal("verified native handoff ignored or global config used as origin")
	}
}

func TestLegacyMigrationVerifiedInternalWorkspaceTargetIsEvidenceNotADestination(t *testing.T) {
	fixture := newLegacyMigrationFixture(t, nil)
	serverConnectionMu.Lock()
	fixture.connection.verifiedWorkspaceURL = "http://workspace.internal:8791"
	fixture.store.mu.Lock()
	fixture.store.Cfg.ServerURL = fixture.connection.verifiedWorkspaceURL
	for _, mapping := range fixture.store.Mappings {
		mapping.ServerID = serverIdentity(fixture.store.Cfg)
	}
	fixture.store.mu.Unlock()
	serverConnectionMu.Unlock()
	registerLegacyProjects(fixture.connection)
	if fixture.registrations.Load() != 1 || fixture.verifications.Load() != 0 {
		t.Fatal("authenticated internal workspace metadata was rejected or used as transport")
	}
}

func TestLegacyMigrationVerifiedTargetMismatchNeverFallsBackOrPosts(t *testing.T) {
	fixture := newLegacyMigrationFixture(t, nil)
	serverConnectionMu.Lock()
	fixture.connection.verifiedWorkspaceURL = "https://different-instance.example"
	serverConnectionMu.Unlock()
	registerLegacyProjects(fixture.connection)
	if fixture.registrations.Load() != 0 || fixture.verifications.Load() != 0 {
		t.Fatal("verified target mismatch fell back or sent legacy paths")
	}
}

func TestLegacyMigrationCapturesSourceBeforeGlobalStoreChanges(t *testing.T) {
	fixture := newLegacyMigrationFixture(t, nil)
	snapshot, reason := captureLegacyProjectMigration(fixture.connection)
	if snapshot == nil {
		t.Fatalf("capture failed: %s", reason)
	}
	defer snapshot.close()
	fixture.store.mu.Lock()
	fixture.store.Cfg.WorkspaceAccount = `{"id":2,"username":"other"}`
	fixture.store.Cfg.ServerURL = "https://replacement.example"
	fixture.store.Mappings[0].ServerPath = "/workspaces/local/REPLACEMENT_PATH_CANARY"
	fixture.store.mu.Unlock()
	if snapshot.accountIdentity != fixture.connection.accountIdentity || snapshot.legacyServerURL != fixture.workspaceURL || snapshot.mappings[0].path != "/workspaces/local/legacy-a" {
		t.Fatal("snapshot borrowed mutable config, identity or mapping")
	}
}

func TestLegacyMigrationSwitchCancelBeforeDispatchKeepsAllAPathsOffB(t *testing.T) {
	fixture := newLegacyMigrationFixture(t, nil)
	var callsB atomic.Int32
	serverB := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		callsB.Add(1)
		t.Error("B received an A migration request or credential")
	}))
	defer serverB.Close()
	snapshot, reason := captureLegacyProjectMigration(fixture.connection)
	if snapshot == nil {
		t.Fatalf("capture failed: %s", reason)
	}
	defer snapshot.close()
	serverConnectionMu.Lock()
	next, err := newServerConnection(serverB.URL, serverB.URL)
	if err != nil {
		serverConnectionMu.Unlock()
		t.Fatal(err)
	}
	next.authenticated, next.accountIdentity, next.accessToken = true, `{"id":2,"username":"other"}`, "B-token"
	fixture.connection.cancel()
	apiConnection = next
	fixture.store.mu.Lock()
	fixture.store.Cfg.LoginURL, fixture.store.Cfg.APIURL = serverB.URL, serverB.URL
	fixture.store.mu.Unlock()
	serverConnectionMu.Unlock()
	if _, _, _, err := snapshot.request(http.MethodPost, "/api/projects/register-existing", []byte(`{"paths":["/workspaces/local/legacy-a"]}`), 1024); err == nil {
		t.Fatal("stale snapshot dispatched")
	}
	registerLegacyProjects(fixture.connection)
	registerLegacyProjects(next)
	if callsB.Load() != 0 || fixture.registrations.Load() != 0 {
		t.Fatal("switch reassembled old paths with new global server")
	}
}

type legacyMigrationBarrierTransport struct {
	next    http.RoundTripper
	entered chan struct{}
}

func (transport legacyMigrationBarrierTransport) RoundTrip(request *http.Request) (*http.Response, error) {
	if request.Method == http.MethodPost {
		close(transport.entered)
		<-request.Context().Done()
		return nil, request.Context().Err()
	}
	return transport.next.RoundTrip(request)
}

func TestLegacyMigrationTwoServersSwitchAtPostDispatchBarrier(t *testing.T) {
	fixture := newLegacyMigrationFixture(t, nil)
	var callsB atomic.Int32
	serverB := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		callsB.Add(1)
		t.Error("B received A path or credential after dispatch switch")
	}))
	defer serverB.Close()
	entered := make(chan struct{})
	serverConnectionMu.Lock()
	fixture.connection.verifiedWorkspaceURL = fixture.workspaceURL
	fixture.connection.client.Transport = legacyMigrationBarrierTransport{next: fixture.connection.client.Transport, entered: entered}
	serverConnectionMu.Unlock()
	done := legacyMigrationRun(fixture.connection)
	legacyMigrationAwait(t, entered, "POST did not reach transport dispatch barrier")
	serverConnectionMu.Lock()
	next, err := newServerConnection(serverB.URL, serverB.URL)
	if err != nil {
		serverConnectionMu.Unlock()
		t.Fatal(err)
	}
	next.authenticated, next.accountIdentity, next.accessToken = true, `{"id":2,"username":"other"}`, "B-token"
	fixture.connection.cancel()
	apiConnection = next
	fixture.store.mu.Lock()
	fixture.store.Cfg.LoginURL, fixture.store.Cfg.APIURL = serverB.URL, serverB.URL
	fixture.store.mu.Unlock()
	serverConnectionMu.Unlock()
	legacyMigrationAwait(t, done, "switch did not cancel dispatch-blocked migration")
	if callsB.Load() != 0 || fixture.registrations.Load() != 0 {
		t.Fatal("a dispatch-blocked old migration reached either upstream")
	}
}

func TestLegacyMigrationCancellationDuringOriginProofPreventsPathDispatch(t *testing.T) {
	for _, mode := range []string{"switch", "logout", "window-close"} {
		t.Run(mode, func(t *testing.T) {
			fixture := newLegacyMigrationFixture(t, nil)
			entered, canceled := make(chan struct{}), make(chan struct{})
			release := make(chan struct{})
			fixture.setHandler(func(w http.ResponseWriter, r *http.Request) {
				if strings.HasSuffix(r.URL.Path, "/register-existing") {
					fixture.registrations.Add(1)
					return
				}
				close(entered)
				select {
				case <-r.Context().Done():
					close(canceled)
				case <-release:
				}
			})
			done := legacyMigrationRun(fixture.connection)
			defer close(release)
			legacyMigrationAwait(t, entered, "origin proof did not reach barrier")
			switch mode {
			case "switch":
				serverConnectionMu.Lock()
				serverConnectionSwitching = true
				cancelFrontendRequestsForSwitch()
				serverConnectionMu.Unlock()
			case "logout":
				serverConnectionMu.Lock()
				fixture.connection.cancel()
				apiConnection = nil
				serverConnectionMu.Unlock()
			case "window-close":
				cancelFrontendProxyRequests()
			}
			legacyMigrationAwait(t, canceled, "origin request did not inherit cancellation")
			legacyMigrationAwait(t, done, "canceled migration did not settle")
			if fixture.registrations.Load() != 0 {
				t.Fatal("canceled proof sent a stored path")
			}
		})
	}
}

func TestLegacyMigrationCanceledPostIsNotPersistedAndCanRetry(t *testing.T) {
	entered, canceled, release := make(chan struct{}), make(chan struct{}), make(chan struct{})
	var calls atomic.Int32
	fixture := newLegacyMigrationFixture(t, func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Paths []string `json:"paths"`
		}
		json.NewDecoder(r.Body).Decode(&body)
		if calls.Add(1) == 1 {
			close(entered)
			select {
			case <-r.Context().Done():
				close(canceled)
			case <-release:
			}
			return
		}
		writeLegacyMigrationSuccess(t, w, body.Paths, "existing")
	})
	defer close(release)
	done := legacyMigrationRun(fixture.connection)
	legacyMigrationAwait(t, entered, "POST did not reach barrier")
	serverConnectionMu.Lock()
	serverConnectionSwitching = true
	cancelFrontendRequestsForSwitch()
	serverConnectionMu.Unlock()
	legacyMigrationAwait(t, canceled, "POST did not receive switch cancellation")
	legacyMigrationAwait(t, done, "canceled POST did not settle")
	serverConnectionMu.Lock()
	serverConnectionSwitching = false
	serverConnectionMu.Unlock()
	registerLegacyProjects(fixture.connection)
	registerLegacyProjects(fixture.connection)
	if got := fixture.registrations.Load(); got != 2 {
		t.Fatalf("canceled request suppressed retry: %d", got)
	}
}

func TestLegacyMigrationConcurrentAttemptsWaitAndUseDurableSuccess(t *testing.T) {
	entered, release := make(chan struct{}), make(chan struct{})
	fixture := newLegacyMigrationFixture(t, func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Paths []string `json:"paths"`
		}
		json.NewDecoder(r.Body).Decode(&body)
		close(entered)
		<-release
		writeLegacyMigrationSuccess(t, w, body.Paths, "registered")
	})
	first := legacyMigrationRun(fixture.connection)
	legacyMigrationAwait(t, entered, "first migration did not reach barrier")
	second := legacyMigrationRun(fixture.connection)
	close(release)
	legacyMigrationAwait(t, first, "first migration did not settle")
	legacyMigrationAwait(t, second, "second migration did not settle")
	if fixture.registrations.Load() != 1 {
		t.Fatal("concurrent attempts duplicated a successful registration")
	}
}

func TestLegacyMigrationPrivateStateEvidenceAndPermissions(t *testing.T) {
	fixture := newLegacyMigrationFixture(t, nil)
	snapshot, reason := captureLegacyProjectMigration(fixture.connection)
	if snapshot == nil {
		t.Fatalf("capture failed: %s", reason)
	}
	expected := legacyMigrationRecordFor(snapshot, snapshot.mappings[0])
	snapshot.close()
	registerLegacyProjects(fixture.connection)
	directory := filepath.Join(filepath.Dir(fixture.store.path), legacyMigrationStateDirectory)
	entries, err := os.ReadDir(directory)
	if err != nil {
		t.Fatal(err)
	}
	var recordFiles int
	for _, entry := range entries {
		if strings.HasSuffix(entry.Name(), ".tmp") {
			t.Fatal("temporary state was not removed")
		}
		if !strings.HasSuffix(entry.Name(), ".json") {
			continue
		}
		recordFiles++
		filename := filepath.Join(directory, entry.Name())
		raw, err := os.ReadFile(filename)
		if err != nil {
			t.Fatal(err)
		}
		for _, private := range []string{fixture.connection.accessToken, fixture.connection.accountIdentity, "/workspaces/", fixture.connection.sessionHandle, fixture.workspaceURL} {
			if bytes.Contains(raw, []byte(private)) {
				t.Fatal("state contains plaintext token, identity, path or handle")
			}
		}
		var record legacyMigrationRecord
		if json.Unmarshal(raw, &record) != nil || !validLegacyMigrationRecord(record) {
			t.Fatal("persisted source evidence/hash invalid")
		}
		if runtime.GOOS != "windows" {
			info, err := os.Stat(filename)
			if err != nil || info.Mode().Perm() != 0600 {
				t.Fatal("state is not private 0600")
			}
		}
	}
	if recordFiles != 2 {
		t.Fatalf("expected per-mapping durable records, got %d", recordFiles)
	}
	state, err := openLegacyMigrationState(fixture.store.path)
	if err != nil {
		t.Fatal(err)
	}
	defer state.close()
	if done, err := state.completed(expected); err != nil || !done {
		t.Fatal("success could not be recovered from disk")
	}
	if second, err := openLegacyMigrationState(fixture.store.path); err == nil {
		second.close()
		t.Fatal("second process/owner admitted to state directory")
	}
}

func TestLegacyMigrationInvalidStateFailsClosedWithoutOverwritingEvidence(t *testing.T) {
	for _, mode := range []string{"corrupt-hash", "source-mismatch", "file-symlink", "directory-symlink", "insecure-mode"} {
		t.Run(mode, func(t *testing.T) {
			fixture := newLegacyMigrationFixture(t, nil)
			snapshot, reason := captureLegacyProjectMigration(fixture.connection)
			if snapshot == nil {
				t.Fatalf("capture failed: %s", reason)
			}
			record := legacyMigrationRecordFor(snapshot, snapshot.mappings[0])
			snapshot.close()
			directory := filepath.Join(filepath.Dir(fixture.store.path), legacyMigrationStateDirectory)
			if mode == "directory-symlink" {
				target := t.TempDir()
				if err := os.Symlink(target, directory); err != nil {
					t.Skipf("symlink not permitted: %v", err)
				}
				registerLegacyProjects(fixture.connection)
				if got, _ := os.ReadDir(target); len(got) != 0 {
					t.Fatal("linked state directory was modified")
				}
			} else {
				state, err := openLegacyMigrationState(fixture.store.path)
				if err != nil {
					t.Fatal(err)
				}
				state.close()
				filename := filepath.Join(directory, record.Key+".json")
				record.Outcome, record.CompletedAt = "registered", time.Now().UTC().Format(time.RFC3339Nano)
				record.SHA256 = legacyMigrationRecordHash(record)
				switch mode {
				case "corrupt-hash":
					record.SHA256 = strings.Repeat("a", 64)
				case "source-mismatch":
					record.SourceSHA256 = strings.Repeat("a", 64)
					record.SHA256 = legacyMigrationRecordHash(record)
				}
				raw, _ := json.Marshal(record)
				if mode == "file-symlink" {
					target := filepath.Join(t.TempDir(), "evidence")
					if err := os.WriteFile(target, raw, 0600); err != nil {
						t.Fatal(err)
					}
					if err := os.Symlink(target, filename); err != nil {
						t.Skipf("symlink not permitted: %v", err)
					}
				} else {
					if err := os.WriteFile(filename, raw, 0600); err != nil {
						t.Fatal(err)
					}
					if mode == "insecure-mode" {
						if runtime.GOOS == "windows" {
							t.Skip("Windows privacy uses ACLs instead of POSIX mode bits")
						}
						if err := os.Chmod(filename, 0644); err != nil {
							t.Fatal(err)
						}
					}
				}
				before, err := os.ReadFile(filename)
				if err != nil {
					t.Fatal(err)
				}
				registerLegacyProjects(fixture.connection)
				after, err := os.ReadFile(filename)
				if err != nil || !bytes.Equal(before, after) {
					t.Fatal("invalid evidence was overwritten")
				}
			}
			if fixture.registrations.Load() != 0 || fixture.verifications.Load() != 0 {
				t.Fatal("invalid private state allowed automatic migration")
			}
		})
	}
}

func TestLegacyMigrationStateSaveFailureDoesNotClaimCompletion(t *testing.T) {
	var fixture *legacyMigrationFixture
	var calls atomic.Int32
	blockedPath := make(chan string, 1)
	fixture = newLegacyMigrationFixture(t, func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Paths []string `json:"paths"`
		}
		if json.NewDecoder(r.Body).Decode(&body) != nil {
			t.Error("invalid payload")
		}
		if calls.Add(1) == 1 {
			snapshot, reason := captureLegacyProjectMigration(fixture.connection)
			if snapshot == nil {
				t.Errorf("capture for save fault: %s", reason)
				w.WriteHeader(500)
				return
			}
			record := legacyMigrationRecordFor(snapshot, snapshot.mappings[0])
			snapshot.close()
			blocked := filepath.Join(filepath.Dir(fixture.store.path), legacyMigrationStateDirectory, record.Key+".json")
			if err := os.Mkdir(blocked, 0700); err != nil {
				t.Error(err)
			}
			blockedPath <- blocked
		}
		writeLegacyMigrationSuccess(t, w, body.Paths, "existing")
	})
	registerLegacyProjects(fixture.connection)
	var blocked string
	select {
	case blocked = <-blockedPath:
	default:
		t.Fatal("save fault did not execute")
	}
	if err := os.Remove(blocked); err != nil {
		t.Fatal(err)
	}
	registerLegacyProjects(fixture.connection)
	registerLegacyProjects(fixture.connection)
	if fixture.registrations.Load() != 2 {
		t.Fatal("save failure created a false completed claim")
	}
}

func TestLegacyMigrationRegisterRedirectNeverForwardsCredentialOrPaths(t *testing.T) {
	var received atomic.Int32
	foreign := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		received.Add(1)
		t.Error("redirect target received migration")
	}))
	defer foreign.Close()
	fixture := newLegacyMigrationFixture(t, func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, foreign.URL+"/api/projects/register-existing", http.StatusTemporaryRedirect)
	})
	registerLegacyProjects(fixture.connection)
	registerLegacyProjects(fixture.connection)
	if received.Load() != 0 || fixture.registrations.Load() != 2 {
		t.Fatal("redirect followed or suppressed a safe retry")
	}
}

func TestLegacyMigrationUnknownSourceIsExplicitAndLogContainsNoPathsOrTokens(t *testing.T) {
	fixture := newLegacyMigrationFixture(t, nil)
	fixture.store.mu.Lock()
	for _, mapping := range fixture.store.Mappings {
		mapping.ServerID = ""
	}
	fixture.store.mu.Unlock()
	var output bytes.Buffer
	previous := log.Writer()
	log.SetOutput(&output)
	defer log.SetOutput(previous)
	registerLegacyProjects(fixture.connection)
	message := output.String()
	if !strings.Contains(message, "reason=unknown_source") || !strings.Contains(message, "action=no_automatic_migration") {
		t.Fatal("unknown source was not explicitly reported")
	}
	for _, private := range []string{fixture.connection.accessToken, "/workspaces/", fixture.connection.sessionHandle, fixture.workspaceURL} {
		if strings.Contains(message, private) {
			t.Fatal("log contains credential, path, or capability")
		}
	}
	if fixture.registrations.Load() != 0 || fixture.verifications.Load() != 0 {
		t.Fatal("unknown source attempted network activity")
	}
}

func TestLegacyMigrationPathValidationRejectsUnsafeStoredValues(t *testing.T) {
	for _, value := range []string{"", "/", "relative/path", "/workspaces/../other", "/workspaces/./a", "/workspaces//a", "/workspaces/a/", "/workspaces/a\\b", "/workspaces/a\nb", "/workspaces/\x00a", "/workspaces/\x7fa"} {
		if legacyMigrationPath(value) {
			t.Fatalf("unsafe path admitted: %q", value)
		}
	}
	if !legacyMigrationPath("/workspaces/local/项目") {
		t.Fatal("ordinary absolute UTF-8 workspace path rejected")
	}
}

// A manually captured context must remain a child of the connection; canceling
// the parent before request construction never touches the HTTP transport.
func TestLegacyMigrationCapturedVerifiedTargetCannotMutateAfterAdmission(t *testing.T) {
	fixture := newLegacyMigrationFixture(t, nil)
	serverConnectionMu.Lock()
	fixture.connection.verifiedWorkspaceURL = fixture.workspaceURL
	serverConnectionMu.Unlock()
	snapshot, reason := captureLegacyProjectMigration(fixture.connection)
	if snapshot == nil {
		t.Fatalf("capture failed: %s", reason)
	}
	defer snapshot.close()
	serverConnectionMu.Lock()
	fixture.connection.verifiedWorkspaceURL = "https://replacement.example"
	serverConnectionMu.Unlock()
	if snapshot.verifyOrigin() {
		t.Fatal("mutated native identity retained admission")
	}
	if fixture.registrations.Load() != 0 || fixture.verifications.Load() != 0 {
		t.Fatal("stale native target sent a request")
	}
}

func TestLegacyMigrationSnapshotContextIsConnectionDerived(t *testing.T) {
	fixture := newLegacyMigrationFixture(t, nil)
	snapshot, reason := captureLegacyProjectMigration(fixture.connection)
	if snapshot == nil {
		t.Fatalf("capture failed: %s", reason)
	}
	defer snapshot.close()
	fixture.connection.cancel()
	legacyMigrationAwait(t, snapshot.ctx.Done(), "snapshot context outlived its connection")
	if snapshot.ctx.Err() != context.Canceled {
		t.Fatal("migration context is detached from the connection")
	}
}
