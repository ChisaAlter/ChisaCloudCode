package main

import (
	"bufio"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// Test admission uses the public v2 contract. It never upgrades an unauthenticated
// fixture or silently treats a rejected reservation as a cancellation test.
func reserveTestRequest(t *testing.T, purpose string) string {
	t.Helper()
	bridge := FrontendBridge{}
	snapshot := bridge.GetApiConnection()
	token := ""
	if purpose == "api" {
		token = snapshot["accessToken"].(string)
	}
	if purpose == "restore" {
		token = snapshot["restorationToken"].(string)
	}
	result := bridge.BeginServerRequestV2(snapshot["sessionHandle"].(string), token, snapshot["tokenRevision"].(uint64), purpose, snapshot["serverKey"].(string))
	id, _ := result["requestId"].(string)
	if result["ok"] != true || id == "" {
		t.Fatalf("v2 %s admission failed: %v", purpose, result["code"])
	}
	return id
}

func testSessionToken(id int, username, sid string) string {
	claims, _ := json.Marshal(map[string]any{"userId": id, "username": username, "sid": sid})
	header := base64.RawURLEncoding.EncodeToString([]byte(`{"alg":"HS256","typ":"JWT"}`))
	return header + "." + base64.RawURLEncoding.EncodeToString(claims) + ".test-signature"
}

func nativeSessionFixture(t *testing.T, handler http.HandlerFunc) *serverConnection {
	t.Helper()
	previousGate := serverConnectionSwitching
	serverConnectionSwitching = false
	frontendRequestsMu.Lock()
	previousClosed := frontendRequestsClosed
	frontendRequestsClosed = false
	frontendRequestsMu.Unlock()
	t.Cleanup(func() {
		serverConnectionSwitching = previousGate
		frontendRequestsMu.Lock()
		frontendRequestsClosed = previousClosed
		frontendRequestsMu.Unlock()
	})
	c := accountWorkspaceFixture(t, handler)
	c.accessToken = testSessionToken(1, "fixture", "initial")
	c.accountIdentity = tokenAccountIdentity(c.accessToken)
	store.Cfg.LoginURL, store.Cfg.APIURL = c.loginURL, c.baseURL
	if err := store.flush(); err != nil {
		t.Fatal(err)
	}
	if err := saveAccountCredential(&persistedAccountCredential{ServerKey: c.serverKey, Token: c.accessToken}); err != nil {
		t.Fatal(err)
	}
	return c
}

func awaitNativeSignal(t *testing.T, signal <-chan struct{}, label string) {
	t.Helper()
	select {
	case <-signal:
	case <-time.After(5 * time.Second):
		t.Fatal(label)
	}
}

func TestNativeSessionV2EmptySnapshotAndLegacyFailClosed(t *testing.T) {
	previous := apiConnection
	apiConnection = nil
	t.Cleanup(func() { apiConnection = previous })
	bridge := FrontendBridge{}
	snapshot := bridge.GetApiConnection()
	if snapshot["protocolVersion"] != 2 || snapshot["configured"] != false || snapshot["sessionHandle"] != "" || snapshot["tokenRevision"] != uint64(0) || snapshot["accessToken"] != "" {
		t.Fatal("invalid empty v2 snapshot")
	}
	if bridge.BeginServerRequest() != "" {
		t.Fatal("legacy request unexpectedly admitted")
	}
	if result := bridge.BeginServerRequestV2("", "renderer-token", 0, "api", ""); result["ok"] != false {
		t.Fatal("unbound renderer credential admitted")
	}
}

func TestNativeSessionV2UnauthorizedRevokesOnlyOriginatingCredential(t *testing.T) {
	for _, mode := range []string{"active", "restore", "unknown-error"} {
		t.Run(mode, func(t *testing.T) {
			c := nativeSessionFixture(t, func(w http.ResponseWriter, r *http.Request) {
				errorCode := "invalid-token"
				if mode == "restore" {
					errorCode = "session-expired"
				}
				if mode == "unknown-error" {
					errorCode = "other"
				}
				w.Header().Set("X-Auth-Error", errorCode)
				w.WriteHeader(http.StatusUnauthorized)
			})
			purpose, endpoint := "api", "/api/projects"
			if mode == "restore" {
				c.authenticated, c.restorationToken, c.accessToken = false, c.accessToken, ""
				purpose, endpoint = "restore", "/api/auth/user"
			}
			bridge := FrontendBridge{}
			response := bridge.ServerRequest(reserveTestRequest(t, purpose), "GET", endpoint, nil, "")
			if response.Status != 401 {
				t.Fatalf("401 was lost: %d", response.Status)
			}
			if mode == "unknown-error" {
				if response.SessionTransition != nil || apiConnection != c || !c.authenticated {
					t.Fatal("unrecognized auth failure revoked account")
				}
				return
			}
			transition := response.SessionTransition
			if transition == nil || transition.PreviousSessionHandle != c.sessionHandle || transition.PreviousTokenRevision != c.tokenRevision || transition.Connection["authenticated"] != false || transition.Connection["accessToken"] != "" || transition.Connection["restorationToken"] != "" || apiConnection == c || c.ctx.Err() == nil {
				t.Fatal("401 did not conditionally revoke and rotate the originating account")
			}
			if token, err := loadAccountCredential(c.serverKey); err != nil || token != "" {
				t.Fatal("401 credential survived restart")
			}
		})
	}
}

func TestNativeSessionV2LateUnauthorizedCannotUndoRefresh(t *testing.T) {
	for _, mode := range []string{"json", "header"} {
		t.Run(mode, func(t *testing.T) {
			started, release := make(chan struct{}), make(chan struct{})
			var releaseOnce sync.Once
			finish := func() { releaseOnce.Do(func() { close(release) }) }
			defer finish()
			fresh := testSessionToken(1, "fixture", "fresh")
			c := nativeSessionFixture(t, func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path == "/api/late401" {
					close(started)
					select {
					case <-release:
					case <-r.Context().Done():
						return
					}
					w.Header().Set("X-Auth-Error", "invalid-token")
					w.WriteHeader(401)
					return
				}
				if mode == "header" {
					w.Header().Set("X-Refreshed-Token", fresh)
				}
				fmt.Fprintf(w, `{"token":%q}`, fresh)
			})
			bridge := FrontendBridge{}
			oldToken, revision, handle, capability := c.accessToken, c.tokenRevision, c.sessionHandle, c.proxyCapability
			id := reserveTestRequest(t, "api")
			late := make(chan BridgeResponse, 1)
			go func() { late <- bridge.ServerRequest(id, "GET", "/api/late401", nil, "") }()
			awaitNativeSignal(t, started, "old request did not reach upstream")
			endpoint := "/api/auth/refresh"
			if mode == "header" {
				endpoint = "/api/projects"
			}
			response := bridge.ServerRequest(reserveTestRequest(t, "api"), "POST", endpoint, nil, "")
			if response.Status != 200 || response.SessionTransition == nil || apiConnection != c || c.sessionHandle != handle || c.proxyCapability != capability || c.tokenRevision != revision+1 || c.accessToken != fresh {
				t.Fatalf("refresh did not advance only the credential revision: status=%d", response.Status)
			}
			if result := bridge.EndServerSessionV2(handle, revision); result["ok"] != false {
				t.Fatal("old logout revoked refreshed revision")
			}
			if result := bridge.BeginServerRequestV2(handle, oldToken, revision, "api", c.serverKey); result["ok"] != false {
				t.Fatal("old credential admitted after refresh")
			}
			finish()
			select {
			case result := <-late:
				if result.Status != 401 || result.SessionTransition != nil || !c.authenticated || c.accessToken != fresh || apiConnection != c {
					t.Fatal("late 401 overwrote refreshed identity")
				}
			case <-time.After(5 * time.Second):
				t.Fatal("late 401 did not settle")
			}
			if token, err := loadAccountCredential(c.serverKey); err != nil || token != fresh {
				t.Fatal("late 401 overwrote persisted refresh")
			}
		})
	}
}

func TestNativeSessionV2ClearFailureRemainsRetryable(t *testing.T) {
	c := nativeSessionFixture(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Auth-Error", "session-expired")
		w.WriteHeader(401)
	})
	originalPath := store.path
	blocker := filepath.Join(t.TempDir(), "not-a-directory")
	if err := os.WriteFile(blocker, []byte("blocked"), 0600); err != nil {
		t.Fatal(err)
	}
	store.path = filepath.Join(blocker, "state.json")
	bridge := FrontendBridge{}
	response := bridge.ServerRequest(reserveTestRequest(t, "api"), "GET", "/api/projects", nil, "")
	requireServerRequestError(t, response, 502, "SESSION_SAVE_FAILED")
	if apiConnection != c || !c.authenticated || c.ctx.Err() != nil {
		t.Fatal("failed clear published logout")
	}
	if result := bridge.EndServerSessionV2(c.sessionHandle, c.tokenRevision); result["code"] != "SESSION_SAVE_FAILED" {
		t.Fatal("logout clear failure was hidden")
	}
	store.path = originalPath
	if result := bridge.EndServerSessionV2(c.sessionHandle, c.tokenRevision); result["ok"] != true {
		t.Fatal("logout could not retry")
	}
	if token, err := loadAccountCredential(c.serverKey); err != nil || token != "" {
		t.Fatal("successful retry did not clear credential")
	}
	serverConnectionMu.Lock()
	changed, err := commitRefreshedTokenLocked(c, c.accessToken, c.tokenRevision, testSessionToken(1, "fixture", "late"))
	serverConnectionMu.Unlock()
	if changed || err != nil {
		t.Fatal("old refresh resurrected logout")
	}
}

func TestNativeSessionV2SwitchSaveFailurePreservesRetryablePredecessor(t *testing.T) {
	for _, mode := range []string{"config", "credential"} {
		t.Run(mode, func(t *testing.T) {
			c := nativeSessionFixture(t, func(http.ResponseWriter, *http.Request) {})
			originalPath, previousConfig := store.path, store.config()
			credentialPath, _ := accountCredentialPath()
			originalCredential, err := os.ReadFile(credentialPath)
			if err != nil {
				t.Fatal(err)
			}
			target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Method != http.MethodGet || r.URL.Path != "/api/auth/status" || r.Header.Get("Authorization") != "" {
					t.Error("switch probe leaked the predecessor credential")
				}
				fmt.Fprint(w, `{"isAuthenticated":false}`)
			}))
			defer target.Close()
			if mode == "config" {
				// Keep the credential directory unchanged, but make the config
				// destination a directory so the final atomic rename fails.
				store.path = filepath.Join(filepath.Dir(originalPath), "blocked-config")
				if err := os.Mkdir(store.path, 0700); err != nil {
					t.Fatal(err)
				}
			} else if err := os.WriteFile(credentialPath, []byte("unreadable credential envelope"), 0600); err != nil {
				t.Fatal(err)
			}
			result := (FrontendBridge{}).ConnectServer(target.URL)
			store.path = originalPath
			if result["ok"] != false || result["code"] != "SESSION_SAVE_FAILED" || apiConnection != c || c.ctx.Err() != nil || !c.authenticated || store.config() != previousConfig || serverConnectionSwitching {
				t.Fatal("failed switch lost the retryable predecessor or its configuration")
			}
			var disk struct {
				Config Config `json:"config"`
			}
			raw, err := os.ReadFile(originalPath)
			if err != nil || json.Unmarshal(raw, &disk) != nil || disk.Config != previousConfig {
				t.Fatal("failed switch did not preserve the durable predecessor configuration")
			}
			if mode == "credential" {
				if err := os.WriteFile(credentialPath, originalCredential, 0600); err != nil {
					t.Fatal(err)
				}
			}
			if token, err := loadAccountCredential(c.serverKey); err != nil || token != c.accessToken {
				t.Fatal("failed switch cleared the predecessor credential")
			}
			if retry := (FrontendBridge{}).ConnectServer(target.URL); retry["ok"] != true || retry["changed"] != true || apiConnection == c || apiConnection.authenticated {
				t.Fatal("switch could not retry after persistence recovered")
			}
			if token, err := loadAccountCredential(c.serverKey); err != nil || token != "" {
				t.Fatal("successful switch retained the old restoration candidate")
			}
		})
	}
}

func TestAccountCredentialV2RestartBindingAndCorruption(t *testing.T) {
	c := nativeSessionFixture(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer "+testSessionToken(1, "fixture", "initial") || r.URL.RawQuery != "" || r.Host != r.Context().Value(http.LocalAddrContextKey).(net.Addr).String() {
			t.Error("restoration/logout lost captured origin or bearer")
		}
		if r.URL.Path == "/api/auth/logout" && r.Method == http.MethodPost {
			fmt.Fprint(w, `{"success":true,"message":"Logged out successfully"}`)
			return
		}
		if r.URL.Path != "/api/auth/user" || r.Method != http.MethodGet {
			t.Errorf("unexpected restoration route: %s", r.URL.Path)
		}
		fmt.Fprint(w, `{"user":{"id":1,"username":"fixture"}}`)
	})
	key, token, handle := c.serverKey, c.accessToken, c.sessionHandle
	path, err := accountCredentialPath()
	if err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if runtime.GOOS == "windows" && strings.Contains(string(raw), token) {
		t.Fatal("Windows credential was stored in plaintext")
	}
	if other, err := loadAccountCredential(serverKey(c.loginURL+"/instances/other", c.baseURL)); err != nil || other != "" {
		t.Fatal("credential restored for another server")
	}
	if err := initializeServerConnection(); err != nil {
		t.Fatal(err)
	}
	if apiConnection.authenticated || apiConnection.restorationToken != token || apiConnection.sessionHandle == handle {
		t.Fatal("restart did not create an unverified native restoration candidate")
	}
	bridge := FrontendBridge{}
	if result := bridge.BeginServerRequestV2(apiConnection.sessionHandle, token, apiConnection.tokenRevision, "api", key); result["ok"] != false {
		t.Fatal("candidate granted protected admission before verification")
	}
	response := bridge.ServerRequest(reserveTestRequest(t, "restore"), "GET", "/api/auth/user", nil, "")
	if response.Status != 200 || response.SessionTransition == nil || !apiConnection.authenticated || apiConnection.accessToken != token {
		t.Fatal("native restoration did not authenticate")
	}
	if result := bridge.EndServerSessionV2(apiConnection.sessionHandle, apiConnection.tokenRevision); result["ok"] != true {
		t.Fatal("logout failed")
	}
	if err := initializeServerConnection(); err != nil {
		t.Fatal(err)
	}
	if apiConnection.restorationToken != "" || apiConnection.authenticated {
		t.Fatal("logout restored on restart")
	}
	if err := os.WriteFile(path, []byte("corrupt credential"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := initializeServerConnection(); err != nil {
		t.Fatal("corrupt credential blocked signed-out initialization", err)
	}
	if apiConnection.restorationToken != "" {
		t.Fatal("corrupt credential restored")
	}
	if result := bridge.BeginServerRequestV2(apiConnection.sessionHandle, token, apiConnection.tokenRevision, "restore", key); result["ok"] != false {
		t.Fatal("renderer-only legacy token restored")
	}
}

func TestNativeSessionV2TwoUpstreamSwitchRevokesHTTPAndWebSocket(t *testing.T) {
	started, canceled := make(chan struct{}), make(chan struct{})
	wsClosed := make(chan struct{})
	var wrongBearer atomic.Int32
	c := nativeSessionFixture(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/slow" {
			close(started)
			<-r.Context().Done()
			close(canceled)
			return
		}
		if r.URL.Path == "/ws" {
			client, buffer, err := w.(http.Hijacker).Hijack()
			if err != nil {
				t.Error(err)
				return
			}
			defer client.Close()
			fmt.Fprint(buffer, "HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n")
			buffer.Flush()
			io.Copy(io.Discard, client)
			close(wsClosed)
			return
		}
		w.WriteHeader(404)
	})
	oldToken, oldHandle, oldRevision, oldKey, oldCapability := c.accessToken, c.sessionHandle, c.tokenRevision, c.serverKey, c.proxyCapability
	probeStarted, releaseProbe := make(chan struct{}), make(chan struct{})
	var releaseOnce sync.Once
	finishProbe := func() { releaseOnce.Do(func() { close(releaseProbe) }) }
	var targetCalls atomic.Int32
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		targetCalls.Add(1)
		if r.Header.Get("Authorization") != "" || r.URL.Query().Get("token") != "" {
			wrongBearer.Add(1)
		}
		if r.URL.Path == "/api/auth/status" {
			close(probeStarted)
			select {
			case <-releaseProbe:
			case <-r.Context().Done():
				return
			}
			fmt.Fprint(w, `{"isAuthenticated":false}`)
			return
		}
		w.WriteHeader(500)
	}))
	defer target.Close()
	defer finishProbe()
	if err := StartAPIProxy(); err != nil {
		t.Fatal(err)
	}
	bridge := FrontendBridge{}
	reserved := reserveTestRequest(t, "api")
	slowID := reserveTestRequest(t, "api")
	slow := make(chan BridgeResponse, 1)
	go func() { slow <- bridge.ServerRequest(slowID, "GET", "/api/slow", nil, "") }()
	awaitNativeSignal(t, started, "old HTTP did not reach source")
	client, err := net.DialTimeout("tcp", fmt.Sprintf("127.0.0.1:%d", apiProxyPort), 5*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	client.SetDeadline(time.Now().Add(5 * time.Second))
	fmt.Fprintf(client, "GET /channel/%s/ws HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n", oldCapability)
	status, err := bufio.NewReader(client).ReadString('\n')
	if err != nil || !strings.Contains(status, "101") {
		t.Fatal("source websocket failed to upgrade")
	}
	switchResult := make(chan map[string]any, 1)
	go func() { switchResult <- bridge.ConnectServer(target.URL) }()
	awaitNativeSignal(t, probeStarted, "new server probe did not reach barrier")
	if result := bridge.BeginServerRequestV2(oldHandle, oldToken, oldRevision, "api", oldKey); result["code"] != "SERVER_SWITCH_IN_PROGRESS" {
		t.Fatal("switch gate admitted protected work")
	}
	awaitNativeSignal(t, canceled, "switch gate left old HTTP alive")
	awaitNativeSignal(t, wsClosed, "switch gate left old websocket alive")
	finishProbe()
	select {
	case result := <-switchResult:
		if result["ok"] != true || result["changed"] != true {
			t.Fatal(result)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("switch did not complete")
	}
	if apiConnection == c || apiConnection.authenticated || apiConnection.restorationToken != "" || c.ctx.Err() == nil {
		t.Fatal("new target inherited old account")
	}
	if result := bridge.BeginServerRequestV2(oldHandle, oldToken, oldRevision, "api", oldKey); result["ok"] != false {
		t.Fatal("old session admitted on new server")
	}
	if result := bridge.ServerRequest(reserved, "GET", "/api/projects", nil, ""); result.Status != 499 {
		t.Fatal("old unconsumed reservation survived switch")
	}
	select {
	case result := <-slow:
		if result.Status != 499 {
			t.Fatal("old HTTP result survived switch")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("old HTTP remained blocked")
	}
	response, err := http.Get(fmt.Sprintf("http://127.0.0.1:%d/channel/%s/api/projects", apiProxyPort, oldCapability))
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode < 400 || targetCalls.Load() != 1 || wrongBearer.Load() != 0 {
		t.Fatal("old proxy capability or credential reached new upstream")
	}
	if token, err := loadAccountCredential(oldKey); err != nil || token != "" {
		t.Fatal("target change retained old credential")
	}
}
