//go:build windows

package main

import (
	"bytes"
	"context"
	"crypto/tls"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

type http2LivenessLog struct {
	mu     sync.Mutex
	buffer bytes.Buffer
}

func (output *http2LivenessLog) Write(p []byte) (int, error) {
	output.mu.Lock()
	defer output.mu.Unlock()
	return output.buffer.Write(p)
}

func (output *http2LivenessLog) String() string {
	output.mu.Lock()
	defer output.mu.Unlock()
	return output.buffer.String()
}

func captureHTTP2LivenessLog(t *testing.T) *http2LivenessLog {
	t.Helper()
	output := &http2LivenessLog{}
	writer, flags, prefix := log.Writer(), log.Flags(), log.Prefix()
	log.SetOutput(output)
	log.SetFlags(0)
	log.SetPrefix("")
	t.Cleanup(func() {
		log.SetOutput(writer)
		log.SetFlags(flags)
		log.SetPrefix(prefix)
	})
	return output
}

// Dropping encrypted server writes leaves the TCP/TLS connection open and
// writable. Only this accepted connection loses server-to-client frames.
type http2LivenessConn struct {
	net.Conn
	drop          atomic.Bool
	closed        atomic.Bool
	writes, drops atomic.Int32
}

func (connection *http2LivenessConn) Close() error {
	connection.closed.Store(true)
	return connection.Conn.Close()
}

func (connection *http2LivenessConn) Write(p []byte) (int, error) {
	connection.writes.Add(1)
	if connection.drop.Load() {
		connection.drops.Add(1)
		return len(p), nil
	}
	return connection.Conn.Write(p)
}

type http2LivenessListener struct {
	net.Listener
	mu          sync.Mutex
	connections []*http2LivenessConn
}

func (listener *http2LivenessListener) Accept() (net.Conn, error) {
	connection, err := listener.Listener.Accept()
	if err != nil {
		return nil, err
	}
	controlled := &http2LivenessConn{Conn: connection}
	listener.mu.Lock()
	listener.connections = append(listener.connections, controlled)
	listener.mu.Unlock()
	return controlled, nil
}

func (listener *http2LivenessListener) closeConnections() {
	listener.mu.Lock()
	defer listener.mu.Unlock()
	for _, connection := range listener.connections {
		connection.Close()
	}
}

type http2LivenessConnKey struct{}

func newHTTP2LivenessConnection(t *testing.T, handler http.HandlerFunc) *serverConnection {
	t.Helper()
	server := httptest.NewUnstartedServer(handler)
	controlled := &http2LivenessListener{Listener: server.Listener}
	server.Listener = controlled
	server.EnableHTTP2 = true
	server.Config.ConnContext = func(ctx context.Context, connection net.Conn) context.Context {
		raw := connection.(*tls.Conn).NetConn().(*http2LivenessConn)
		return context.WithValue(ctx, http2LivenessConnKey{}, raw)
	}
	server.StartTLS()
	t.Cleanup(server.Close)
	// Close owned sockets before httptest.Close, even if an assertion fails
	// while a handler is deliberately waiting for request cancellation.
	t.Cleanup(controlled.closeConnections)
	previousDefaults, previousConnection := serviceConfiguration, apiConnection
	certificate := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: server.Certificate().Raw})
	serviceConfiguration, _ = json.Marshal(serviceDefaults{CACertificate: string(certificate)})
	t.Cleanup(func() {
		serviceConfiguration, apiConnection = previousDefaults, previousConnection
	})
	connection, err := newServerConnection(server.URL, server.URL)
	if err != nil {
		t.Fatal(err)
	}
	apiConnection = connection
	t.Cleanup(func() { connection.cancel(); connection.client.CloseIdleConnections() })
	transport, ok := serverHTTPTransport(connection.client.Transport)
	if !ok {
		t.Fatal("product HTTP transport unavailable")
	}
	// Product traffic defaults to H1. These diagnostic fixtures explicitly opt
	// into H2 while keeping the production 15s + 15s PING/ACK configuration.
	transport.Protocols = new(http.Protocols)
	transport.Protocols.SetHTTP1(true)
	transport.Protocols.SetHTTP2(true)
	if transport.HTTP2 == nil || transport.HTTP2.SendPingTimeout != 15*time.Second || transport.HTTP2.PingTimeout != 15*time.Second {
		t.Fatal("explicit diagnostic H2 must exercise the retained 15s + 15s liveness policy")
	}
	if connection.client.Timeout != 0 || transport.ResponseHeaderTimeout != 0 {
		t.Fatal("protocol liveness unexpectedly introduced an application response timeout")
	}
	return connection
}

func TestServerConnectionHTTP2LivenessDropsSilentConnectionWithoutReplayingPost(t *testing.T) {
	output := captureHTTP2LivenessLog(t)
	const prefix = "partial response already received"
	const postBody = "non-idempotent POST already delivered"
	bodyConnection := make(chan *http2LivenessConn, 1)
	postConnection := make(chan *http2LivenessConn, 2)
	recoveryConnection := make(chan *http2LivenessConn, 1)
	var posts atomic.Int32
	connection := newHTTP2LivenessConnection(t, func(w http.ResponseWriter, request *http.Request) {
		if request.ProtoMajor != 2 {
			t.Error("liveness fixture did not negotiate HTTP/2")
		}
		raw := request.Context().Value(http2LivenessConnKey{}).(*http2LivenessConn)
		switch request.URL.Path {
		case "/api/liveness/body":
			io.WriteString(w, prefix)
			w.(http.Flusher).Flush()
			bodyConnection <- raw
			<-request.Context().Done()
		case "/api/liveness/post":
			posts.Add(1)
			body, err := io.ReadAll(request.Body)
			if err != nil || request.Method != http.MethodPost || string(body) != postBody {
				t.Error("the entire non-idempotent POST was not received before silence")
			}
			postConnection <- raw
			<-request.Context().Done()
		case "/api/liveness/recovered":
			recoveryConnection <- raw
			io.WriteString(w, "read-only recovery succeeded")
		default:
			t.Errorf("unexpected fixture endpoint: %s", request.URL.Path)
			w.WriteHeader(http.StatusNotFound)
		}
	})
	request, _ := http.NewRequestWithContext(connection.ctx, http.MethodGet, connection.baseURL+"/api/liveness/body", nil)
	response, err := connection.client.Do(request)
	if err != nil {
		t.Fatal("initial HTTP/2 response:", err)
	}
	defer response.Body.Close()
	if response.ProtoMajor != 2 {
		t.Fatal("initial response was not HTTP/2")
	}
	old := <-bodyConnection
	alreadyRead := make([]byte, len(prefix))
	if _, err := io.ReadFull(response.Body, alreadyRead); err != nil || string(alreadyRead) != prefix {
		t.Fatal("partial response did not reach the actual body reader:", err)
	}
	bodyResult := make(chan error, 1)
	go func() { _, err := io.ReadAll(response.Body); bodyResult <- err }()
	bridge := FrontendBridge{}
	postID := bridge.BeginServerRequest()
	t.Cleanup(func() { bridge.CancelServerRequest(postID) })
	postResult := make(chan BridgeResponse, 1)
	go func() {
		postResult <- bridge.ServerRequest(postID, http.MethodPost, "/api/liveness/post", nil, base64.StdEncoding.EncodeToString([]byte(postBody)))
	}()
	select {
	case actual := <-postConnection:
		if actual != old {
			t.Fatal("POST and existing body did not share the old HTTP/2 connection")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("POST did not reach the local server")
	}
	old.drop.Store(true)
	started := time.Now()
	guard := time.NewTimer(42 * time.Second)
	defer guard.Stop()
	select {
	case result := <-postResult:
		requireServerRequestError(t, result, 502, "UPSTREAM_CONNECTION_FAILED")
	case <-guard.C:
		t.Fatal("lost PING did not release the delivered POST")
	}
	select {
	case err := <-bodyResult:
		if err == nil || !strings.Contains(err.Error(), "http2: client connection lost") {
			t.Fatalf("existing body read did not fail from protocol liveness: %v", err)
		}
	case <-guard.C:
		t.Fatal("lost PING left the existing response body blocked")
	}
	elapsed := time.Since(started)
	if elapsed < 25*time.Second || old.drops.Load() == 0 {
		t.Fatalf("failure did not exercise the actual PING budget: elapsed=%s dropped_writes=%d", elapsed, old.drops.Load())
	}
	result := bridge.ServerRequest(bridge.BeginServerRequest(), http.MethodGet, "/api/liveness/recovered", nil, "")
	body, _ := base64.StdEncoding.DecodeString(result.BodyB64)
	if result.Status != http.StatusOK || string(body) != "read-only recovery succeeded" || <-recoveryConnection == old {
		t.Fatal("the next read-only request did not succeed on a fresh connection")
	}
	if posts.Load() != 1 {
		t.Fatalf("the delivered POST was replayed: count=%d", posts.Load())
	}
	var postFailures int
	for _, line := range strings.Split(output.String(), "\n") {
		if strings.Contains(line, "endpoint=/api/liveness/post ") && strings.Contains(line, "event=transport-failed ") {
			postFailures++
			requireServerRequestTraceFields(t, line, "method=POST ", "phase=awaiting-headers ", "protocol=h2 ", "error=h2-connection-lost ")
		}
	}
	if postFailures != 1 || strings.Contains(output.String(), "event=connection-lost-ping ") {
		t.Fatalf("liveness must describe the single failed request, not a process counter: request_failures=%d", postFailures)
	}
	t.Logf("HTTP/2 old connection failed after %s; dropped server writes=%d; POST deliveries=1; existing body released; next GET used a new connection; actual POST error=h2-connection-lost; process-counter logs=0", elapsed, old.drops.Load())
}

func TestServerConnectionHTTP2LivenessKeepsHealthyLongResponse(t *testing.T) {
	output := captureHTTP2LivenessLog(t)
	const finalBody = "healthy long response completed"
	release := make(chan struct{})
	var releaseOnce sync.Once
	t.Cleanup(func() { releaseOnce.Do(func() { close(release) }) })
	serverConnection := make(chan *http2LivenessConn, 1)
	retiredServerConnection := make(chan *http2LivenessConn, 1)
	var requests atomic.Int32
	var serverContextClosed atomic.Bool
	connection := newHTTP2LivenessConnection(t, func(w http.ResponseWriter, request *http.Request) {
		if request.ProtoMajor != 2 {
			t.Error("long response did not negotiate HTTP/2")
		}
		if request.URL.Path == "/api/liveness/retired" {
			retiredServerConnection <- request.Context().Value(http2LivenessConnKey{}).(*http2LivenessConn)
			io.WriteString(w, "normally completed retired response")
			return
		}
		requests.Add(1)
		w.Header().Set("Content-Length", strconv.Itoa(len(finalBody)))
		w.WriteHeader(http.StatusOK)
		w.(http.Flusher).Flush()
		serverConnection <- request.Context().Value(http2LivenessConnKey{}).(*http2LivenessConn)
		select {
		case <-release:
			io.WriteString(w, finalBody)
		case <-request.Context().Done():
			serverContextClosed.Store(true)
		}
	})
	// Go 1.27 can emit a delayed CountError callback after normal retirement.
	// Keep that real control case beside the healthy response and ensure it
	// produces no false request-failure observation.
	retired, err := newServerConnection(connection.loginURL, connection.baseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { retired.cancel(); retired.client.CloseIdleConnections() })
	retiredTransport, ok := serverHTTPTransport(retired.client.Transport)
	if !ok {
		t.Fatal("retired diagnostic HTTP transport unavailable")
	}
	// This separate diagnostic connection must opt in before its first request.
	retiredTransport.Protocols = new(http.Protocols)
	retiredTransport.Protocols.SetHTTP1(true)
	retiredTransport.Protocols.SetHTTP2(true)
	completed, err := retired.client.Get(retired.baseURL + "/api/liveness/retired")
	if err != nil {
		t.Fatal("retired control response:", err)
	}
	retiredBody, readErr := io.ReadAll(completed.Body)
	completed.Body.Close()
	if readErr != nil || string(retiredBody) != "normally completed retired response" || completed.ProtoMajor != 2 {
		t.Fatal("retired control did not finish normally:", readErr)
	}
	retiredRaw := <-retiredServerConnection
	retired.client.CloseIdleConnections()
	retired.cancel()
	request, _ := http.NewRequestWithContext(connection.ctx, http.MethodGet, connection.baseURL+"/api/liveness/long", nil)
	response, err := connection.client.Do(request)
	if err != nil {
		t.Fatal("long response headers:", err)
	}
	defer response.Body.Close()
	if response.ProtoMajor != 2 {
		t.Fatal("long response was not HTTP/2")
	}
	raw := <-serverConnection
	writesBefore := raw.writes.Load()
	type readResult struct {
		body []byte
		err  error
	}
	result := make(chan readResult, 1)
	go func() { body, err := io.ReadAll(response.Body); result <- readResult{body, err} }()
	started := time.Now()
	quiet := time.NewTimer(33 * time.Second)
	defer quiet.Stop()
	select {
	case early := <-result:
		t.Fatalf("healthy response ended during the silent application-body interval: bytes=%d error=%v", len(early.body), early.err)
	case <-quiet.C:
	}
	controlWrites := raw.writes.Load() - writesBefore
	if controlWrites < 2 {
		t.Fatalf("expected live HTTP/2 control replies while no application body was sent; server writes=%d", controlWrites)
	}
	if !retiredRaw.closed.Load() || raw.closed.Load() || serverContextClosed.Load() {
		t.Fatalf("connection ownership changed: retired_closed=%t healthy_closed=%t healthy_server_context_closed=%t", retiredRaw.closed.Load(), raw.closed.Load(), serverContextClosed.Load())
	}
	if strings.Contains(output.String(), "event=connection-lost-ping ") || strings.Contains(output.String(), "error=h2-connection-lost ") {
		t.Fatal("a healthy or normally retired connection produced a false liveness-failure observation")
	}
	releaseOnce.Do(func() { close(release) })
	select {
	case completed := <-result:
		if completed.err != nil || string(completed.body) != finalBody {
			t.Fatalf("long response did not complete intact: bytes=%d error=%v", len(completed.body), completed.err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("healthy long response did not finish after release")
	}
	if requests.Load() != 1 || strings.Contains(output.String(), "event=connection-lost-ping ") || strings.Contains(output.String(), "error=h2-connection-lost ") {
		t.Fatal("healthy long response was replayed or its connection was lost")
	}
	t.Logf("HTTP/2 response remained healthy for %s with no application body; server control writes=%d; final body intact; request_count=1; healthy_version=%d healthy_closed=%t healthy_server_context_closed=%t; retired_version=%d retired_closed=%t; false liveness-failure logs=0", time.Since(started), controlWrites, connection.version, raw.closed.Load(), serverContextClosed.Load(), retired.version, retiredRaw.closed.Load())
}

func TestServerConnectionHTTP2LivenessErrorClassPreservesPrivacy(t *testing.T) {
	output := captureHTTP2LivenessLog(t)
	lost := errors.New("http2: client connection lost")
	wrapped := &url.Error{Op: "Post", URL: "https://TRACE_SECRET_HOST/api/post?token=TRACE_SECRET_QUERY", Err: lost}
	for _, test := range []struct {
		name, class string
		err         error
	}{
		{"direct", "h2-connection-lost", lost},
		{"url-wrapped", "h2-connection-lost", wrapped},
		{"multiply-wrapped", "h2-connection-lost", fmt.Errorf("TRACE_SECRET_WRAPPER: %w", wrapped)},
		{"lookalike", "transport-error", errors.New("TRACE_SECRET_ERROR: http2: client connection lost")},
	} {
		t.Run(test.name, func(t *testing.T) {
			if got := serverRequestErrorClass(test.err); got != test.class {
				t.Fatalf("error class=%s, want %s", got, test.class)
			}
			before := len(output.String())
			trace := newServerRequestTrace(time.Now(), 17, http.MethodPost, "/api/class-canary")
			trace.log("transport-failed", test.err, 0, -1)
			line := output.String()[before:]
			requireServerRequestTraceFields(t, line, "event=transport-failed ", "error="+test.class+" ")
			if strings.Contains(line, "TRACE_SECRET_") || strings.Contains(line, "http2: client connection lost") {
				t.Fatal("classified failure log exposed an error message, URL, or wrapper content")
			}
		})
	}
}
