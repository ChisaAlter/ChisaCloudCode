//go:build windows

package main

import (
	"bufio"
	"context"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/http/httptrace"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestAccountTransportRetiresGatewayIdleConnectionWithoutReplay(t *testing.T) {
	previousDefaults := serviceConfiguration
	t.Cleanup(func() { serviceConfiguration = previousDefaults })
	type observedRequest struct{ address, method string }
	requests := make(chan observedRequest, 3)
	var posts atomic.Int32
	upstream := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPost {
			posts.Add(1)
			body, err := io.ReadAll(r.Body)
			if err != nil || string(body) != "single transport canary" {
				t.Error("POST canary changed")
				w.WriteHeader(http.StatusBadRequest)
				return
			}
		}
		requests <- observedRequest{r.RemoteAddr, r.Method}
		w.Header().Set("Keep-Alive", "timeout=5")
		fmt.Fprint(w, "exact transport reply")
	}))
	upstream.Config.IdleTimeout = 5 * time.Second
	upstream.StartTLS()
	t.Cleanup(upstream.Close)
	cert := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: upstream.Certificate().Raw})
	serviceConfiguration, _ = json.Marshal(serviceDefaults{CACertificate: string(cert)})
	connection, err := newServerConnection(upstream.URL, upstream.URL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { connection.cancel(); connection.client.CloseIdleConnections() })
	request := func(method string) (httptrace.GotConnInfo, observedRequest) {
		t.Helper()
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		var observed httptrace.GotConnInfo
		ctx = httptrace.WithClientTrace(ctx, &httptrace.ClientTrace{GotConn: func(info httptrace.GotConnInfo) { observed = info }})
		var body io.Reader
		if method == http.MethodPost {
			body = strings.NewReader("single transport canary")
		}
		outgoing, err := http.NewRequestWithContext(ctx, method, upstream.URL+"/api/transport-canary", body)
		if err != nil {
			t.Fatal(err)
		}
		response, err := connection.client.Do(outgoing)
		if err != nil {
			t.Fatal("trusted transport request failed", err)
		}
		reply, readErr := io.ReadAll(response.Body)
		response.Body.Close()
		if readErr != nil || response.StatusCode != http.StatusOK || string(reply) != "exact transport reply" {
			t.Fatal("trusted transport response was not preserved")
		}
		return observed, <-requests
	}
	_, first := request(http.MethodGet)
	time.Sleep(100 * time.Millisecond)
	short, second := request(http.MethodGet)
	if !short.Reused || first.address != second.address {
		t.Fatal("short idle disabled connection reuse")
	}
	time.Sleep(4200 * time.Millisecond)
	fresh, third := request(http.MethodPost)
	if fresh.Reused || third.address == second.address || third.method != http.MethodPost || posts.Load() != 1 {
		t.Fatal("expired idle socket was reused or the single POST was replayed")
	}
}

func TestAccountHTTPSLoginWithoutSSHAndRestore(t *testing.T) {
	previousStore, previousConnection, previousTunnel, previousDefaults := store, apiConnection, tunnel, serviceConfiguration
	t.Setenv("APPDATA", t.TempDir())
	store = loadStore(dataDir())
	tunnel = nil
	paths := []string{}
	upstream := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		paths = append(paths, r.URL.Path)
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/api/auth/login":
			var credentials map[string]string
			_ = json.NewDecoder(r.Body).Decode(&credentials)
			if credentials["username"] != "second" || credentials["password"] != "test password" {
				w.WriteHeader(401)
				return
			}
			fmt.Fprint(w, `{"token":"valid-test-token","user":{"id":2,"username":"second"},"instancePath":"/instances/second","workspaceServerUrl":"http://second.test:8792"}`)
		case "/instances/second/api/auth/user":
			if r.Header.Get("Authorization") != "Bearer valid-test-token" {
				t.Error("account token was lost")
			}
			w.Header().Set("X-Chisa-Instance-Path", "/instances/second")
			w.Header().Set("X-Chisa-Workspace-Server-Url", "http://second.test:8792")
			fmt.Fprint(w, `{"user":{"id":2,"username":"second"}}`)
		default:
			t.Errorf("wrong instance endpoint: %s", r.URL.Path)
			w.WriteHeader(404)
		}
	}))
	defer upstream.Close()
	cert := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: upstream.Certificate().Raw})
	serviceConfiguration, _ = json.Marshal(serviceDefaults{LoginURL: upstream.URL, CACertificate: string(cert)})
	defer func() {
		if apiConnection != nil {
			apiConnection.cancel()
		}
		store, apiConnection, tunnel, serviceConfiguration = previousStore, previousConnection, previousTunnel, previousDefaults
	}()
	if err := initializeServerConnection(); err != nil {
		t.Fatal(err)
	}
	bridge := FrontendBridge{}
	response := bridge.ServerRequest(bridge.BeginServerRequest(), "POST", "/api/auth/login", map[string]string{"Content-Type": "application/json"}, b64encode(`{"username":"second","password":"test password"}`))
	if response.Status != 200 {
		raw, _ := base64.StdEncoding.DecodeString(response.BodyB64)
		t.Fatalf("login failed: %d %s", response.Status, raw)
	}
	if apiConnection.baseURL != upstream.URL+"/instances/second" || !apiConnection.authenticated || tunnel != nil {
		t.Fatal("login used SSH or the wrong instance")
	}
	if workspaceConnectionMatchesSession() {
		t.Fatal("another account inherited an unrelated workspace")
	}
	version := apiConnection.version
	bridge.EndServerSession(version - 1)
	if !apiConnection.authenticated {
		t.Fatal("late logout ended the new account")
	}
	bridge.EndServerSession(version)
	if apiConnection.authenticated {
		t.Fatal("logout left realtime access active")
	}
	store = loadStore(filepath.Dir(store.path))
	if err := initializeServerConnection(); err != nil {
		t.Fatal(err)
	}
	response = bridge.ServerRequest(bridge.BeginServerRequest(), "GET", "/api/auth/user", map[string]string{"Authorization": "Bearer valid-test-token"}, "")
	if response.Status != 200 || !apiConnection.authenticated || len(paths) != 2 {
		t.Fatal("restored session did not remain on the selected instance")
	}
}

func TestAccountTransportRejectsUntrustedCertificateAndPlaintext(t *testing.T) {
	if _, err := normalizeServiceURL("http://remote.test:8791"); err == nil {
		t.Fatal("public plaintext credentials were permitted")
	}
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { t.Error("untrusted TLS request reached HTTP") }))
	defer server.Close()
	connection, err := newServerConnection(server.URL, server.URL)
	if err != nil {
		t.Fatal(err)
	}
	defer connection.cancel()
	_, err = connection.client.Get(server.URL + "/api/auth/status")
	if err == nil {
		t.Fatal("untrusted certificate accepted")
	}
	if _, err := x509.ParseCertificate(server.Certificate().Raw); err != nil {
		t.Fatal(err)
	}
}

func TestAccountWebSocketProxyUsesHTTPSWithoutTunnel(t *testing.T) {
	previousConnection, previousTunnel, previousDefaults := apiConnection, tunnel, serviceConfiguration
	tunnel = nil
	remoteClosed := make(chan struct{})
	continueStream := make(chan struct{})
	var upstream *httptest.Server
	upstream = httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Host != upstream.Listener.Addr().String() {
			t.Errorf("account proxy forwarded local Host %q instead of account service Host %q", r.Host, upstream.Listener.Addr().String())
			http.Error(w, "wrong virtual host", http.StatusForbidden)
			return
		}
		if r.URL.Path == "/instances/second/api/chat/stream" {
			if r.Header.Get("Authorization") != "Bearer session" || r.URL.Query().Get("cursor") != "first" {
				t.Error("account streaming route lost authentication or query")
			}
			w.Header().Set("Content-Type", "text/event-stream")
			fmt.Fprint(w, "data: first\n\n")
			w.(http.Flusher).Flush()
			select {
			case <-continueStream:
				fmt.Fprint(w, "data: second\n\n")
			case <-r.Context().Done():
			}
			return
		}
		if r.URL.Path != "/instances/second/ws" || r.URL.Query().Get("token") != "session" {
			t.Errorf("wrong websocket route: %s", r.URL.Path)
		}
		connection, buffer, err := w.(http.Hijacker).Hijack()
		if err != nil {
			t.Error(err)
			return
		}
		defer connection.Close()
		fmt.Fprint(buffer, "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n")
		buffer.Flush()
		_, _ = buffer.ReadByte()
		close(remoteClosed)
	}))
	defer upstream.Close()
	cert := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: upstream.Certificate().Raw})
	serviceConfiguration, _ = json.Marshal(serviceDefaults{CACertificate: string(cert)})
	connection, err := newServerConnection(upstream.URL, upstream.URL+"/instances/second")
	if err != nil {
		t.Fatal(err)
	}
	connection.authenticated = true
	apiConnection = connection
	defer func() {
		connection.cancel()
		apiConnection, tunnel, serviceConfiguration = previousConnection, previousTunnel, previousDefaults
	}()
	if err := StartAPIProxy(); err != nil {
		t.Fatal(err)
	}
	streamRequest, err := http.NewRequest("GET", fmt.Sprintf("http://127.0.0.1:%d/channel/%s/api/chat/stream?cursor=first", apiProxyPort, apiProxyKey), nil)
	if err != nil {
		t.Fatal(err)
	}
	streamRequest.Header.Set("Authorization", "Bearer session")
	streamResponse, err := (&http.Client{Timeout: 3 * time.Second}).Do(streamRequest)
	if err != nil {
		t.Fatal("account streaming proxy did not return flushed headers", err)
	}
	defer streamResponse.Body.Close()
	if streamResponse.StatusCode != http.StatusOK {
		t.Fatal("account streaming proxy used the wrong upstream virtual host", streamResponse.StatusCode)
	}
	streamReader := bufio.NewReader(streamResponse.Body)
	first, err := streamReader.ReadString('\n')
	if err != nil || first != "data: first\n" {
		t.Fatal("account streaming proxy buffered or changed its first event", first, err)
	}
	close(continueStream)
	remaining, err := io.ReadAll(streamReader)
	if err != nil || string(remaining) != "\ndata: second\n\n" {
		t.Fatal("account streaming proxy did not complete both flushed events", string(remaining), err)
	}
	client, err := net.DialTimeout("tcp", fmt.Sprintf("127.0.0.1:%d", apiProxyPort), time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	client.SetDeadline(time.Now().Add(3 * time.Second))
	fmt.Fprintf(client, "GET /channel/%s/ws?token=session HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n", apiProxyKey)
	buffer := bufio.NewReader(client)
	status, err := buffer.ReadString('\n')
	if err != nil || !strings.Contains(status, "101") {
		t.Fatalf("websocket upgrade failed: %s %v", status, err)
	}
	for {
		line, err := buffer.ReadString('\n')
		if err != nil {
			t.Fatal(err)
		}
		if line == "\r\n" {
			break
		}
	}
	connection.cancel()
	select {
	case <-remoteClosed:
	case <-time.After(3 * time.Second):
		t.Fatal("account replacement left the old websocket open")
	}
}
