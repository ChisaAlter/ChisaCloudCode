package main

import (
	"encoding/json"
	"encoding/pem"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestCloneProgressProxyHasOneBrowserCORSOrigin(t *testing.T) {
	previousConnection, previousDefaults := apiConnection, serviceConfiguration
	upstream := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer fixture" { t.Error("proxy lost native account credential") }
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprint(w, "data: {\"type\":\"complete\"}\n\n")
	}))
	defer upstream.Close()
	cert := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: upstream.Certificate().Raw})
	serviceConfiguration, _ = json.Marshal(serviceDefaults{CACertificate: string(cert)})
	connection, err := newServerConnection(upstream.URL, upstream.URL)
	if err != nil {
		t.Fatal(err)
	}
	connection.authenticated, connection.accessToken = true, "fixture"
	apiConnection = connection
	defer func() {
		connection.cancel()
		apiConnection, serviceConfiguration = previousConnection, previousDefaults
	}()
	if err := StartAPIProxy(); err != nil {
		t.Fatal(err)
	}
	req, _ := http.NewRequest("GET", fmt.Sprintf("http://127.0.0.1:%d/channel/%s/api/projects/clone-progress", apiProxyPort, connection.proxyCapability), nil)
	req.Header.Set("Origin", "http://desktop.invalid")
	resp, err := (&http.Client{Timeout: 3 * time.Second}).Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	body, readErr := io.ReadAll(resp.Body)
	if readErr != nil || resp.StatusCode != 200 || string(body) != "data: {\"type\":\"complete\"}\n\n" { t.Fatal("clone event did not reach browser", resp.StatusCode, readErr) }
	if origins := resp.Header.Values("Access-Control-Allow-Origin"); len(origins) != 1 || origins[0] != "*" {
		t.Fatalf("browser rejects duplicate CORS origin headers: %q", origins)
	}
}
