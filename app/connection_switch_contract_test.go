//go:build windows

package main

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestConnectionSwitchReportsActualReplacement(t *testing.T) {
	previous := accountWorkspaceFixture(t, func(w http.ResponseWriter, r *http.Request) {
		t.Error("same-service reconnect must not probe or replace the existing session")
	})
	bridge := FrontendBridge{}
	unchanged := bridge.ConnectServer(previous.loginURL)
	if unchanged["ok"] != true || unchanged["changed"] != false || apiConnection != previous || previous.ctx.Err() != nil {
		t.Fatal("same-service reconnect changed the authenticated session", unchanged)
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
		w.WriteHeader(http.StatusOK)
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
