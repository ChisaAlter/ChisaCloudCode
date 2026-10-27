//go:build windows

package main

import (
	"context"
	"encoding/base64"
	"net/http"
	"net/http/httptest"
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
