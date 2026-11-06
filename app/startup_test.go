package main

import (
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestStartupDataDirectoryIsolation(t *testing.T) {
	t.Setenv("CHISA_DATA_DIR", "")
	t.Setenv("MYGO_ENV", "production")
	base, err := os.UserConfigDir()
	if err != nil {
		t.Fatal(err)
	}
	if got := dataDir(); got != filepath.Join(base, "ChisaCloudCode") {
		t.Fatalf("production profile changed: %q", got)
	}
	t.Setenv("MYGO_ENV", "development")
	t.Setenv("CHISA_DEV_SESSION", "startup-test")
	if got := dataDir(); got != filepath.Join(base, "ChisaCloudCode Dev", "sessions", "startup-test") {
		t.Fatalf("development profile is not isolated: %q", got)
	}
	custom := filepath.Join(t.TempDir(), "explicit-profile")
	t.Setenv("CHISA_DATA_DIR", custom)
	if got := dataDir(); got != custom {
		t.Fatalf("explicit profile ignored: %q", got)
	}
}

func TestStartupListenersChooseAvailableLoopbackPorts(t *testing.T) {
	// A previous/production window may already own the legacy fixed ports.
	var held []net.Listener
	for _, port := range []int{18792, 18082} {
		if listener, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", port)); err == nil {
			held = append(held, listener)
		}
	}
	t.Cleanup(func() {
		for _, listener := range held {
			listener.Close()
		}
	})
	if err := StartAPIProxy(); err != nil {
		t.Fatal(err)
	}
	for _, port := range []int{apiProxyPort} {
		if port == 0 || port == 18792 || port == 18082 {
			t.Fatalf("listener did not choose an independent port: %d", port)
		}
		connection, err := net.Dial("tcp", fmt.Sprintf("127.0.0.1:%d", port))
		if err != nil {
			t.Fatal(err)
		}
		connection.Close()
	}
	token := testSessionToken(7, "startup", "initial")
	connection := accountWorkspaceFixture(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.RawQuery != "" || r.Header.Get("Cookie") != "" || r.Host != r.Context().Value(http.LocalAddrContextKey).(net.Addr).String() {
			t.Error("startup proxy changed the captured origin or credential transport")
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		switch r.URL.Path {
		case "/api/auth/login":
			if r.Method != http.MethodPost || r.Header.Get("Authorization") != "" {
				t.Error("startup login admitted an existing bearer or wrong method")
				w.WriteHeader(http.StatusBadRequest)
				return
			}
			fmt.Fprintf(w, `{"token":%q,"user":{"id":7,"username":"startup"}}`, token)
		case "/api/startup-probe":
			if r.Method != http.MethodGet || r.Header.Get("Authorization") != "Bearer "+token {
				t.Error("advertised proxy did not use the authenticated native bearer")
				w.WriteHeader(http.StatusUnauthorized)
				return
			}
			fmt.Fprint(w, "startup capability reached captured upstream")
		default:
			t.Errorf("startup contacted unexpected path: %s", r.URL.Path)
			w.WriteHeader(http.StatusNotFound)
		}
	})
	connection.authenticated, connection.accountIdentity, connection.accessToken = false, "", ""
	bridge := FrontendBridge{}
	apiConnection = nil
	unconfigured := bridge.GetApiConnection()
	apiConnection = connection
	if unconfigured["configured"] != false || unconfigured["sessionHandle"] != "" || unconfigured["httpProxyUrl"] != "" || unconfigured["webSocketUrl"] != "" {
		t.Fatal("unconfigured startup exposed a session capability")
	}
	configured := bridge.GetApiConnection()
	if configured["configured"] != true || configured["authenticated"] != false || configured["sessionHandle"] != connection.sessionHandle || configured["accessToken"] != "" || configured["httpProxyUrl"] != "" || configured["webSocketUrl"] != "" {
		t.Fatal("configured signed-out startup exposed an authenticated capability")
	}
	login := bridge.ServerRequest(reserveTestRequest(t, "login"), http.MethodPost, "/api/auth/login", nil, "")
	if login.Status != http.StatusOK || login.SessionTransition == nil {
		t.Fatal("startup could not authenticate through its native login reservation")
	}
	snapshot := bridge.GetApiConnection()
	if snapshot["authenticated"] != true || snapshot["sessionHandle"] == connection.sessionHandle || snapshot["accessToken"] != token {
		t.Fatal("startup login did not publish a new authenticated session")
	}
	wantHTTP := fmt.Sprintf("http://127.0.0.1:%d/channel/%s", apiProxyPort, apiConnection.proxyCapability)
	wantWS := fmt.Sprintf("ws://127.0.0.1:%d/channel/%s", apiProxyPort, apiConnection.proxyCapability)
	if snapshot["httpProxyUrl"] != wantHTTP || snapshot["webSocketUrl"] != wantWS {
		t.Fatal("authenticated bridge did not advertise the bound API port and current capability")
	}
	client := &http.Client{Timeout: 3 * time.Second}
	response, err := client.Get(snapshot["httpProxyUrl"].(string) + "/api/startup-probe")
	if err != nil {
		t.Fatal("advertised startup capability was not reachable")
	}
	raw, readErr := io.ReadAll(response.Body)
	response.Body.Close()
	if readErr != nil || response.StatusCode != http.StatusOK || string(raw) != "startup capability reached captured upstream" {
		t.Fatal("advertised startup capability did not reach the captured upstream")
	}
}
