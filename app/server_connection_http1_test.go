//go:build windows

package main

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"io"
	"log"
	"net"
	"net/http"
	"net/http/httptest"
	"net/http/httptrace"
	"slices"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

const http1FixtureWait = 5 * time.Second

// Offer H2 at the server, but do not change the product client's protocols.
func newHTTP1TestConnection(t *testing.T, handler http.HandlerFunc) (*serverConnection, *http.Transport) {
	t.Helper()
	server := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		if request.ProtoMajor != 1 || request.ProtoMinor != 1 || request.TLS == nil || request.TLS.NegotiatedProtocol == "h2" {
			t.Errorf("default account request did not use verified HTTP/1.1: protocol=%s", request.Proto)
		}
		w.Header().Set("X-Fixture-Connection", request.RemoteAddr)
		handler(w, request)
	}))
	server.EnableHTTP2 = true
	server.Config.ErrorLog = log.New(io.Discard, "", 0)
	server.StartTLS()
	t.Cleanup(server.Close)
	// Unblock held handlers before waiting for httptest shutdown on failures.
	t.Cleanup(server.CloseClientConnections)
	if !slices.Contains(server.TLS.NextProtos, "h2") {
		t.Fatal("TLS fixture did not offer HTTP/2")
	}
	connection, transport := tlsRecoveryAccount(t, server.URL, server.Certificate().Raw)
	if transport.Protocols == nil || !transport.Protocols.HTTP1() || transport.Protocols.HTTP2() || transport.Protocols.UnencryptedHTTP2() {
		t.Fatal("default account transport must enable only HTTP/1.1")
	}
	if connection.client.Timeout != 0 || transport.ResponseHeaderTimeout != 0 {
		t.Fatal("protocol selection introduced an application or response-header timeout")
	}
	if transport.TLSClientConfig == nil || transport.TLSClientConfig.InsecureSkipVerify || transport.TLSClientConfig.RootCAs == nil || transport.TLSClientConfig.MinVersion < tls.VersionTLS12 {
		t.Fatal("protocol selection weakened TLS certificate verification")
	}
	return connection, transport
}

func awaitHTTP1TestEvent[T any](t *testing.T, events <-chan T, description string) T {
	t.Helper()
	select {
	case event := <-events:
		return event
	case <-time.After(http1FixtureWait):
		t.Fatalf("timed out waiting for %s", description)
		var zero T
		return zero
	}
}

type http1TestReply struct {
	body, address string
	connection    net.Conn
	reused        bool
}

func readHTTP1TestReply(t *testing.T, connection *serverConnection, method, path, body string) http1TestReply {
	t.Helper()
	ctx, cancel := context.WithTimeout(connection.ctx, http1FixtureWait)
	defer cancel()
	var observed httptrace.GotConnInfo
	ctx = httptrace.WithClientTrace(ctx, &httptrace.ClientTrace{GotConn: func(info httptrace.GotConnInfo) { observed = info }})
	request, err := http.NewRequestWithContext(ctx, method, connection.baseURL+path, strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	response, err := connection.client.Do(request)
	if err != nil {
		t.Fatal("trusted H1 request failed:", err)
	}
	defer response.Body.Close()
	reply, err := io.ReadAll(response.Body)
	if err != nil || response.StatusCode != http.StatusOK {
		t.Fatalf("H1 response did not complete: status=%d read_error=%v", response.StatusCode, err)
	}
	if response.ProtoMajor != 1 || response.ProtoMinor != 1 || response.TLS == nil || len(response.TLS.VerifiedChains) == 0 || response.TLS.NegotiatedProtocol == "h2" {
		t.Fatal("H2 was negotiated or the response did not authenticate its TLS certificate")
	}
	if observed.Conn == nil {
		t.Fatal("H1 request did not report its connection")
	}
	return http1TestReply{body: string(reply), address: response.Header.Get("X-Fixture-Connection"), connection: observed.Conn, reused: observed.Reused}
}

func TestServerConnectionHTTP1DefaultReusesVerifiedTLS(t *testing.T) {
	connection, _ := newHTTP1TestConnection(t, func(w http.ResponseWriter, request *http.Request) {
		io.WriteString(w, "completed H1 read")
	})
	first := readHTTP1TestReply(t, connection, http.MethodGet, "/api/http1/first", "")
	second := readHTTP1TestReply(t, connection, http.MethodGet, "/api/http1/second", "")
	if first.body != "completed H1 read" || second.body != first.body {
		t.Fatal("sequential H1 responses changed")
	}
	if first.reused || !second.reused || first.connection != second.connection || first.address == "" || first.address != second.address {
		t.Fatal("completed sequential reads did not reuse their H1 TLS connection")
	}
}

func TestServerConnectionHTTP1HeldStreamAllowsIndependentRequestsAndCancellation(t *testing.T) {
	const prefix = "partial streaming reply"
	const postBody = "independent non-idempotent operation"
	streamAddress := make(chan string, 1)
	streamStopped := make(chan struct{})
	var posts atomic.Int32
	connection, _ := newHTTP1TestConnection(t, func(w http.ResponseWriter, request *http.Request) {
		switch request.URL.Path {
		case "/api/http1/stream":
			defer close(streamStopped)
			io.WriteString(w, prefix)
			w.(http.Flusher).Flush()
			streamAddress <- request.RemoteAddr
			<-request.Context().Done()
		case "/api/http1/get":
			io.WriteString(w, "independent GET completed")
		case "/api/http1/post":
			posts.Add(1)
			body, err := io.ReadAll(request.Body)
			if err != nil || request.Method != http.MethodPost || string(body) != postBody {
				t.Error("independent POST did not arrive intact")
			}
			io.WriteString(w, "independent POST completed")
		default:
			http.NotFound(w, request)
		}
	})
	ctx, cancel := context.WithTimeout(connection.ctx, 3*http1FixtureWait)
	defer cancel()
	var streamConnection httptrace.GotConnInfo
	ctx = httptrace.WithClientTrace(ctx, &httptrace.ClientTrace{GotConn: func(info httptrace.GotConnInfo) { streamConnection = info }})
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, connection.baseURL+"/api/http1/stream", nil)
	if err != nil {
		t.Fatal(err)
	}
	response, err := connection.client.Do(request)
	if err != nil {
		t.Fatal("stream headers failed:", err)
	}
	defer response.Body.Close()
	if response.ProtoMajor != 1 || response.TLS == nil || len(response.TLS.VerifiedChains) == 0 {
		t.Fatal("held stream did not use authenticated H1")
	}
	partial := make([]byte, len(prefix))
	if _, err := io.ReadFull(response.Body, partial); err != nil || string(partial) != prefix {
		t.Fatal("stream prefix was not delivered intact:", err)
	}
	address := awaitHTTP1TestEvent(t, streamAddress, "held stream handler")
	type bodyResult struct {
		body []byte
		err  error
	}
	remaining := make(chan bodyResult, 1)
	go func() {
		body, err := io.ReadAll(response.Body)
		remaining <- bodyResult{body, err}
	}()
	get := readHTTP1TestReply(t, connection, http.MethodGet, "/api/http1/get", "")
	post := readHTTP1TestReply(t, connection, http.MethodPost, "/api/http1/post", postBody)
	if get.body != "independent GET completed" || post.body != "independent POST completed" || posts.Load() != 1 {
		t.Fatal("held stream prevented independent GET/POST completion")
	}
	if get.connection == streamConnection.Conn || post.connection == streamConnection.Conn || get.address == address || post.address == address {
		t.Fatal("another request shared the held H1 streaming connection")
	}
	if !post.reused || get.connection != post.connection {
		t.Fatal("independent completed requests lost H1 keep-alive reuse")
	}
	select {
	case early := <-remaining:
		t.Fatalf("stream ended before caller cancellation: bytes=%d error=%v", len(early.body), early.err)
	default:
	}
	select {
	case <-streamStopped:
		t.Fatal("stream handler ended before caller cancellation")
	default:
	}
	cancel()
	ended := awaitHTTP1TestEvent(t, remaining, "canceled stream body")
	if !errors.Is(ended.err, context.Canceled) || len(ended.body) != 0 {
		t.Fatalf("caller cancellation did not release the held body: bytes=%d error=%v", len(ended.body), ended.err)
	}
	awaitHTTP1TestEvent(t, streamStopped, "canceled stream server handler")
	after := readHTTP1TestReply(t, connection, http.MethodGet, "/api/http1/get", "")
	if !after.reused || after.connection != get.connection {
		t.Fatal("canceling a held stream disturbed the independent H1 connection")
	}
}

func TestServerConnectionHTTP1DoesNotReplayDeliveredPost(t *testing.T) {
	const content = "one fully delivered non-idempotent POST"
	type postDelivery struct {
		address, body string
		err           error
	}
	deliveries := make(chan postDelivery, 4)
	var posts atomic.Int32
	connection, _ := newHTTP1TestConnection(t, func(w http.ResponseWriter, request *http.Request) {
		if request.Method == http.MethodGet {
			io.WriteString(w, "warm H1 connection")
			return
		}
		posts.Add(1)
		body, err := io.ReadAll(request.Body)
		hijacker, ok := w.(http.Hijacker)
		if !ok {
			t.Error("H1 failure fixture cannot hijack its connection")
			w.WriteHeader(http.StatusInternalServerError)
			return
		}
		socket, _, hijackErr := hijacker.Hijack()
		if hijackErr != nil {
			t.Error("H1 failure fixture could not close its connection:", hijackErr)
			return
		}
		socket.Close() // Outcome is unknown to the client after the body arrived.
		select {
		case deliveries <- postDelivery{request.RemoteAddr, string(body), err}:
		default:
			t.Error("non-idempotent POST was repeatedly replayed")
		}
	})
	warm := readHTTP1TestReply(t, connection, http.MethodGet, "/api/http1/warm", "")
	ctx, cancel := context.WithTimeout(connection.ctx, http1FixtureWait)
	defer cancel()
	var assigned atomic.Int32
	var observed httptrace.GotConnInfo
	ctx = httptrace.WithClientTrace(ctx, &httptrace.ClientTrace{GotConn: func(info httptrace.GotConnInfo) {
		assigned.Add(1)
		observed = info
	}})
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, connection.baseURL+"/api/http1/unknown-post", strings.NewReader(content))
	if err != nil {
		t.Fatal(err)
	}
	if request.GetBody == nil {
		t.Fatal("POST fixture must be rewindable so the no-replay assertion is meaningful")
	}
	response, err := connection.client.Do(request)
	if response != nil {
		response.Body.Close()
	}
	if err == nil || response != nil {
		t.Fatal("closed connection incorrectly reported a known successful POST outcome")
	}
	delivered := awaitHTTP1TestEvent(t, deliveries, "fully delivered POST before server close")
	if delivered.err != nil || delivered.body != content || delivered.address != warm.address {
		t.Fatal("server did not receive the entire POST on the warmed connection")
	}
	if posts.Load() != 1 || assigned.Load() != 1 || !observed.Reused || observed.Conn != warm.connection {
		t.Fatalf("delivered POST was replayed or changed connections: deliveries=%d assignments=%d reused=%t", posts.Load(), assigned.Load(), observed.Reused)
	}
}

func TestServerConnectionHTTP1RejectsUnauthenticatedTLS(t *testing.T) {
	for _, mode := range []string{"untrusted-root", "wrong-server-name"} {
		t.Run(mode, func(t *testing.T) {
			var requests atomic.Int32
			connection, transport := newHTTP1TestConnection(t, func(w http.ResponseWriter, request *http.Request) {
				requests.Add(1)
				w.WriteHeader(http.StatusOK)
			})
			if mode == "untrusted-root" {
				transport.TLSClientConfig.RootCAs = x509.NewCertPool()
			} else {
				transport.TLSClientConfig.ServerName = "wrong-name.invalid"
			}
			ctx, cancel := context.WithTimeout(connection.ctx, http1FixtureWait)
			defer cancel()
			request, err := http.NewRequestWithContext(ctx, http.MethodGet, connection.baseURL+"/api/http1/certificate", nil)
			if err != nil {
				t.Fatal(err)
			}
			response, err := connection.client.Do(request)
			if response != nil {
				response.Body.Close()
			}
			var verificationError *tls.CertificateVerificationError
			if !errors.As(err, &verificationError) || response != nil || requests.Load() != 0 {
				t.Fatalf("unauthenticated TLS reached HTTP: mode=%s requests=%d error_type=%T", mode, requests.Load(), err)
			}
		})
	}
}
