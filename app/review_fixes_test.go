//go:build windows

package main

import (
	"context"
	"encoding/base64"
	"net/http"
	"testing"
	"time"
)

type reviewRoundTrip func(*http.Request) (*http.Response, error)

func (f reviewRoundTrip) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

// Account requests use real HTTP sockets without creating an SSH process.
func reviewHTTP(t *testing.T, handler http.HandlerFunc) *serverConnection {
	t.Helper()
	current := nativeSessionFixture(t, handler)
	current.accessToken = "TRACE_SECRET_REQUEST_HEADER"
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
	id := reserveTestRequest(t, "api")
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
		w.Header().Set("X-Refreshed-Token", testSessionToken(1, "fixture", "trace-refresh"))
		_, _ = w.Write([]byte("actual HTTP response"))
	})
	bridge := FrontendBridge{}
	response := bridge.ServerRequest(reserveTestRequest(t, "api"), "GET", "/api/projects", nil, "")
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
	id := reserveTestRequest(t, "api")
	bridge.CancelServerRequest(id)
	if response := bridge.ServerRequest(id, "GET", "/api/projects", nil, ""); response.Status != 499 {
		t.Fatal(response)
	}
	id = reserveTestRequest(t, "api")
	value, _ := bridgeRequests.Load(id)
	current.cancel()
	if value.(*bridgeRequest).ctx.Err() != context.Canceled {
		t.Fatal("replacing an account connection left its requests alive")
	}
}
