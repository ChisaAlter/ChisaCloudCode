//go:build windows

package main

import (
	"encoding/json"
	"encoding/pem"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
)

func TestServerTransportProbeKeepsCurrentHTTP2PoolAndIsolatesHTTP1(t *testing.T) {
	output := captureServerRequestTraceLog(t)
	const token = "probe-only-authorization-canary"
	const responseBody = "private running metadata must not leave probe"
	var reads atomic.Int32
	server := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/hold" {
			w.WriteHeader(http.StatusOK)
			w.(http.Flusher).Flush()
			<-r.Context().Done()
			return
		}
		if r.URL.Path != "/api/providers/sessions/running" || r.Method != http.MethodGet || r.Header.Get("Authorization") != "Bearer "+token {
			t.Error("probe changed its fixed read-only authenticated route")
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		reads.Add(1)
		io.WriteString(w, responseBody)
	}))
	server.EnableHTTP2 = true
	server.StartTLS()
	t.Cleanup(server.Close)
	previousDefaults, previousConnection := serviceConfiguration, apiConnection
	t.Cleanup(func() { serviceConfiguration, apiConnection = previousDefaults, previousConnection })
	cert := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: server.Certificate().Raw})
	serviceConfiguration, _ = json.Marshal(serviceDefaults{CACertificate: string(cert)})
	connection, err := newServerConnection(server.URL, server.URL)
	if err != nil {
		t.Fatal(err)
	}
	// This diagnostic fixture explicitly opts into H2; product connections
	// prefer H1 after the deployed gateway's shared-stream failures.
	base, ok := serverHTTPTransport(connection.client.Transport)
	if !ok {
		t.Fatal("product HTTP transport unavailable")
	}
	base.Protocols = new(http.Protocols)
	base.Protocols.SetHTTP1(true)
	base.Protocols.SetHTTP2(true)
	connection.authenticated, connection.accessToken = true, token
	apiConnection = connection
	t.Cleanup(func() { connection.cancel(); connection.client.CloseIdleConnections() })
	transport := connection.client.Transport
	// A real active H2 stream prevents the production four-second idle timer
	// from retiring this shared pool connection while periodic GETs reuse it.
	hold, err := connection.client.Get(server.URL + "/hold")
	if err != nil || hold.ProtoMajor != 2 {
		t.Fatal("unable to establish the shared active HTTP/2 connection")
	}
	t.Cleanup(func() { hold.Body.Close() })
	result := (FrontendBridge{}).ProbeServerHTTPTransport()
	if result["ok"] != true || connection.client.Transport != transport {
		t.Fatal("probe replaced or invalidated the product transport")
	}
	samples, ok := result["samples"].([]map[string]any)
	if !ok || len(samples) != 4 || reads.Load() != 4 {
		t.Fatal("probe did not perform exactly two read-only comparison rounds")
	}
	for _, sample := range samples {
		if sample["status"] != http.StatusOK || sample["error"] != "none" || sample["phase"] != "response-received" || sample["bytes"] != int64(len(responseBody)) {
			t.Fatalf("incomplete probe observation: %v", sample)
		}
		if sample["mode"] == "default-pool" {
			if sample["protocol"] != "HTTP/2.0" || sample["reused"] != true {
				t.Fatal("default comparison did not use the actual shared HTTP/2 pool", sample)
			}
		} else if sample["protocol"] != "HTTP/1.1" || sample["reused"] != false {
			t.Fatal("HTTP/1 comparison changed protocol or production idle lifetime", sample)
		}
	}
	raw, _ := json.Marshal(result)
	if strings.Contains(string(raw), token) || strings.Contains(string(raw), responseBody) {
		t.Fatal("probe returned account credentials or response contents")
	}
	if strings.Count(output.String(), "[server-transport-blocks]") != 2 || !strings.Contains(output.String(), `"point":"before"`) || !strings.Contains(output.String(), `"point":"after"`) || strings.Contains(output.String(), token) || strings.Contains(output.String(), responseBody) {
		t.Fatal("explicit probe lost its before/after private static block samples")
	}
}
