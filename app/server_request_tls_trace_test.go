//go:build windows

package main

import (
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"encoding/pem"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestServerRequestTLSTraceObservesSilentHelloOnce(t *testing.T) {
	for _, end := range []string{"cancel", "transport-timeout"} {
		t.Run(end, func(t *testing.T) {
			attempts := int32(1)
			budget := 10 * time.Second
			if end == "transport-timeout" {
				attempts, budget = 2, 20*time.Second
			}
			output := captureHTTP2LivenessLog(t)
			listener, err := net.Listen("tcp", "127.0.0.1:0")
			if err != nil {
				t.Fatal(err)
			}
			var accepts atomic.Int32
			var ownedMu sync.Mutex
			var owned []net.Conn
			ready, closed := make(chan error, 4), make(chan struct{}, 4)
			t.Cleanup(func() {
				listener.Close()
				ownedMu.Lock()
				defer ownedMu.Unlock()
				for _, connection := range owned {
					connection.Close()
				}
			})
			go func() {
				for {
					connection, err := listener.Accept()
					if err != nil {
						return
					}
					accepts.Add(1)
					ownedMu.Lock()
					owned = append(owned, connection)
					ownedMu.Unlock()
					go func() {
						defer connection.Close()
						var header [5]byte
						_, err := io.ReadFull(connection, header[:])
						if err == nil && (header[0] != 22 || header[1] != 3) {
							t.Error("silent fixture did not receive a TLS handshake record")
						}
						if err == nil {
							_, err = io.CopyN(io.Discard, connection, int64(binary.BigEndian.Uint16(header[3:])))
						}
						ready <- err
						if err == nil {
							io.Copy(io.Discard, connection)
						}
						closed <- struct{}{}
					}()
				}
			}()
			origin := "https://" + listener.Addr().String()
			connection, err := newServerConnection(origin, origin)
			if err != nil {
				t.Fatal(err)
			}
			previous := apiConnection
			apiConnection = connection
			t.Cleanup(func() { connection.cancel(); connection.client.CloseIdleConnections(); apiConnection = previous })
			transport, ok := serverHTTPTransport(connection.client.Transport)
			if !ok {
				t.Fatal("product HTTP transport unavailable")
			}
			if transport.TLSHandshakeTimeout != 10*time.Second || transport.ResponseHeaderTimeout != 0 || connection.client.Timeout != 0 {
				t.Fatal("TLS observation changed the existing transport or application time budget")
			}
			bridge := FrontendBridge{}
			id := bridge.BeginServerRequest()
			t.Cleanup(func() { bridge.CancelServerRequest(id) })
			result := make(chan BridgeResponse, 1)
			started := time.Now()
			var canceledAt time.Time
			go func() {
				result <- bridge.ServerRequest(id, http.MethodPost, "/api/tls-pending?token=TLS_PRIVATE_QUERY", map[string]string{"Authorization": "Bearer TLS_PRIVATE_HEADER"}, base64.StdEncoding.EncodeToString([]byte("TLS_PRIVATE_BODY")))
			}()
			select {
			case err := <-ready:
				if err != nil {
					t.Fatal("reading the local ClientHello:", err)
				}
			case <-time.After(3 * time.Second):
				t.Fatal("ClientHello did not reach the local socket")
			}
			if end == "cancel" {
				// Hold through two one-second boundaries: observation must still
				// be one-shot, rather than turning into periodic stack sampling.
				time.Sleep(2100 * time.Millisecond)
				canceledAt = time.Now()
				bridge.CancelServerRequest(id)
			}
			select {
			case response := <-result:
				if end == "cancel" {
					requireServerRequestError(t, response, 499, "REQUEST_INTERRUPTED")
					if time.Since(canceledAt) > 2*time.Second {
						t.Fatal("canceling the native caller waited for the detached TLS handshake")
					}
				} else {
					requireServerRequestError(t, response, 502, "UPSTREAM_CONNECTION_FAILED")
					if elapsed := time.Since(started); elapsed < budget-time.Second || elapsed > budget+3*time.Second {
						t.Fatalf("real TLS handshake timeout no longer follows two bounded ten-second acquisitions: %s", elapsed)
					}
				}
			case <-time.After(budget + 3*time.Second):
				t.Fatal("native TLS request did not settle on cancellation or the existing timeout")
			}
			// net/http deliberately detaches in-flight dialing/TLS from request
			// cancellation so another request can reuse the connection. The
			// canceled caller settles immediately; socket cleanup still follows
			// the unchanged ten-second TLS transport budget, not a new deadline.
			remaining := budget + 3*time.Second - time.Since(started)
			if remaining <= 0 {
				t.Fatal("TLS cleanup exceeded the original transport budget")
			}
			for index := int32(0); index < attempts; index++ {
				select {
				case <-closed:
				case <-time.After(remaining):
					t.Fatal("native TLS cleanup did not close the peer within its acquisition budget")
				}
			}
			if accepts.Load() != attempts {
				t.Fatalf("silent TLS request opened %d connections, want %d bounded pre-HTTP acquisitions", accepts.Load(), attempts)
			}
			pending, samples := 0, 0
			for _, line := range strings.Split(output.String(), "\n") {
				if strings.Contains(line, "event=tls-pending ") {
					pending++
					requireServerRequestTraceFields(t, line, "endpoint=/api/tls-pending ", "method=POST ", "phase=tls-handshake ", "error=none ")
				}
				if strings.HasPrefix(line, "[server-transport-blocks] ") {
					var sample serverTransportBlockSample
					if err := json.Unmarshal([]byte(strings.TrimPrefix(line, "[server-transport-blocks] ")), &sample); err != nil {
						t.Fatal("TLS block sample was not structured JSON:", err)
					}
					if sample.Point != "tls-one-second" || sample.Scope != "process" || sample.Truncated {
						t.Fatalf("TLS sample lost its static point or process scope: %+v", sample)
					}
					found := false
					for _, count := range sample.Counts {
						found = found || count.Category == "http-client-tls" && count.State == "read-io" && count.Count > 0
					}
					if !found {
						t.Fatalf("real silent TLS reader was not observed as read-io: %+v", sample.Counts)
					}
					samples++
				}
			}
			if pending != int(attempts) || samples != int(attempts) {
				t.Fatalf("TLS pending/sample counts=%d/%d, want one each per acquisition (%d)", pending, samples, attempts)
			}
			if strings.Contains(output.String(), "TLS_PRIVATE_") || strings.Contains(output.String(), "goroutine ") || strings.Contains(output.String(), ".go:") {
				t.Fatal("TLS pending evidence exposed request secrets or raw stack material")
			}
			t.Logf("silent ClientHello ending=%s elapsed=%s pending=%d sample=tls-one-second/http-client-tls/read-io connections=%d peers-closed=true", end, time.Since(started), pending, accepts.Load())
		})
	}
}

func TestServerRequestTLSTraceFastTrustedHandshakeHasNoLatePending(t *testing.T) {
	output := captureHTTP2LivenessLog(t)
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		io.WriteString(w, "trusted local response")
	}))
	t.Cleanup(server.Close)
	previousDefaults, previousConnection := serviceConfiguration, apiConnection
	certificate := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: server.Certificate().Raw})
	serviceConfiguration, _ = json.Marshal(serviceDefaults{CACertificate: string(certificate)})
	t.Cleanup(func() { serviceConfiguration, apiConnection = previousDefaults, previousConnection })
	connection, err := newServerConnection(server.URL, server.URL)
	if err != nil {
		t.Fatal(err)
	}
	apiConnection = connection
	t.Cleanup(func() { connection.cancel(); connection.client.CloseIdleConnections() })
	bridge := FrontendBridge{}
	response := bridge.ServerRequest(bridge.BeginServerRequest(), http.MethodGet, "/api/tls-fast", nil, "")
	body, _ := base64.StdEncoding.DecodeString(response.BodyB64)
	if response.Status != http.StatusOK || string(body) != "trusted local response" {
		t.Fatal("a normally verified local TLS response did not complete")
	}
	time.Sleep(1100 * time.Millisecond)
	if strings.Contains(output.String(), "event=tls-pending ") || strings.Contains(output.String(), `"point":"tls-one-second"`) {
		t.Fatal("completed trusted TLS handshake emitted a late pending observation")
	}
	t.Log("normally verified TLS completed; no pending or stack observation after the one-second boundary")
}

func TestServerRequestTLSTraceWindowsChainClassifierIsStatic(t *testing.T) {
	for _, frame := range []string{"crypto/x509.(*Certificate).systemVerify", "syscall.CertGetCertificateChain", "syscall.CertVerifyCertificateChainPolicy"} {
		stack := "goroutine 83 [syscall]:\n" + frame + "(TLS_PRIVATE_ARGUMENT)\n\tC:/TLS_PRIVATE_PATH/token=TLS_PRIVATE_QUERY.go:249 +0xabc\ncreated by TLS_PRIVATE_CREATOR in goroutine 12\n"
		sample := classifyServerTransportBlocks([]byte(stack), false)
		if len(sample.Counts) != 1 || sample.Counts[0] != (serverTransportBlockCount{Category: "windows-cert-chain", State: "syscall", Count: 1}) {
			t.Fatalf("Windows verification frame was not classified with static labels: %+v", sample.Counts)
		}
		raw, err := json.Marshal(sample)
		if err != nil {
			t.Fatal(err)
		}
		if sample.Scope != "process" || strings.Contains(string(raw), "TLS_PRIVATE_") || strings.Contains(string(raw), "goroutine") || strings.Contains(string(raw), "CertGet") || strings.Contains(string(raw), "systemVerify") {
			t.Fatal("Windows certificate classification exposed stack functions, paths, or arguments")
		}
	}
}
