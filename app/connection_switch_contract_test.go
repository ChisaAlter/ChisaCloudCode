//go:build windows

package main

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestConnectionProbeRejectsWrongServiceAndReleasesStateLock(t *testing.T) {
	previous := accountWorkspaceFixture(t, func(w http.ResponseWriter, r *http.Request) {})
	bridge := FrontendBridge{}
	for _, body := range []string{"<html>ordinary website</html>", `{}`, `{"isAuthenticated":"false"}`, `{"isAuthenticated":false} trailing`} {
		t.Run(body, func(t *testing.T) {
			wrong := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { fmt.Fprint(w, body) }))
			defer wrong.Close()
			if result := bridge.ConnectServer(wrong.URL); result["ok"] != false || apiConnection != previous {
				t.Fatal("invalid account response was accepted or changed the session", result)
			}
		})
	}
	entered, release := make(chan struct{}), make(chan struct{})
	slow := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		close(entered)
		<-release
		fmt.Fprint(w, `{"isAuthenticated":false}`)
	}))
	defer slow.Close()
	defer close(release)
	result := make(chan map[string]any, 1)
	go func() { result <- bridge.ConnectServer(slow.URL) }()
	<-entered
	state := make(chan map[string]any, 1)
	go func() { state <- bridge.GetApiConnection() }()
	select {
	case <-state:
	case <-time.After(time.Second):
		t.Fatal("a slow network probe blocked native state reads")
	}
	// Simulate a session transition while the candidate is still probing.
	serverConnectionMu.Lock()
	next, err := newServerConnection(previous.loginURL, previous.baseURL)
	if err != nil {
		serverConnectionMu.Unlock()
		t.Fatal(err)
	}
	replaceServerConnection(next)
	serverConnectionMu.Unlock()
	t.Cleanup(func() { next.cancel() })
	// Let the probe finish without closing the deferred channel twice.
	release <- struct{}{}
	if response := <-result; response["ok"] != false || apiConnection != next {
		t.Fatal("stale probe overwrote the newer account connection", response)
	}
}

func TestConnectionSwitchReportsActualReplacement(t *testing.T) {
	probes := 0
	available := true
	previous := accountWorkspaceFixture(t, func(w http.ResponseWriter, r *http.Request) {
		probes++
		if r.URL.Path != "/api/auth/status" || r.Header.Get("Authorization") != "" {
			t.Error("same-service probe sent credentials or used the wrong endpoint")
		}
		if !available {
			w.WriteHeader(http.StatusServiceUnavailable)
			return
		}
		w.Write([]byte(`{"isAuthenticated":false}`))
	})
	bridge := FrontendBridge{}
	unchanged := bridge.ConnectServer(previous.loginURL)
	if unchanged["ok"] != true || unchanged["changed"] != false || apiConnection != previous || previous.ctx.Err() != nil {
		t.Fatal("same-service reconnect changed the authenticated session", unchanged)
	}
	if probes != 1 {
		t.Fatal("same-service reconnect did not verify reachability")
	}
	available = false
	if result := bridge.ConnectServer(previous.loginURL); result["ok"] != false || apiConnection != previous || previous.ctx.Err() != nil {
		t.Fatal("unavailable same-service reconnect reported success or destroyed the session", result)
	}
	failed := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusServiceUnavailable) }))
	defer failed.Close()
	result := bridge.ConnectServer(failed.URL)
	if result["ok"] != false || apiConnection != previous || previous.ctx.Err() != nil {
		t.Fatal("failed replacement invalidated the existing session", result)
	}
	replacement := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/auth/status" || r.Header.Get("Authorization") != "" {
			t.Error("replacement service probe used the old account token or wrong endpoint")
		}
		w.Write([]byte(`{"isAuthenticated":false}`))
	}))
	defer replacement.Close()
	t.Cleanup(func() {
		if apiConnection != previous {
			apiConnection.cancel()
		}
	})
	result = bridge.ConnectServer(replacement.URL)
	if result["ok"] != true || result["changed"] != true || apiConnection == previous || apiConnection.loginURL != replacement.URL || previous.ctx.Err() == nil {
		t.Fatal("successful replacement did not report its native identity transition", result)
	}
}
