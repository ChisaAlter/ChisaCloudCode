//go:build windows

package main

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/binary"
	"encoding/json"
	"encoding/pem"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/http/httptrace"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

type tlsRecoveryListener struct {
	net.Listener
	silent  int
	accepts atomic.Int32
	hellos  chan struct{}
	mu      sync.Mutex
	owned   []net.Conn
}

func (listener *tlsRecoveryListener) Accept() (net.Conn, error) {
	for {
		connection, err := listener.Listener.Accept()
		if err != nil {
			return nil, err
		}
		index := int(listener.accepts.Add(1))
		listener.mu.Lock()
		listener.owned = append(listener.owned, connection)
		listener.mu.Unlock()
		if listener.silent < 0 || index <= listener.silent {
			go func() {
				defer connection.Close()
				var header [5]byte
				if _, err := io.ReadFull(connection, header[:]); err != nil {
					return
				}
				if _, err := io.CopyN(io.Discard, connection, int64(binary.BigEndian.Uint16(header[3:]))); err != nil {
					return
				}
				select {
				case listener.hellos <- struct{}{}:
				default:
				}
				io.Copy(io.Discard, connection)
			}()
			continue
		}
		return connection, nil
	}
}

func (listener *tlsRecoveryListener) closeOwned() {
	listener.mu.Lock()
	defer listener.mu.Unlock()
	for _, connection := range listener.owned {
		connection.Close()
	}
}

func tlsRecoveryAccount(t *testing.T, origin string, certificate []byte) (*serverConnection, *http.Transport) {
	t.Helper()
	previous := serviceConfiguration
	serviceConfiguration, _ = json.Marshal(serviceDefaults{CACertificate: string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: certificate}))})
	t.Cleanup(func() { serviceConfiguration = previous })
	connection, err := newServerConnection(origin, origin)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { connection.cancel(); connection.client.CloseIdleConnections() })
	base, ok := serverHTTPTransport(connection.client.Transport)
	if !ok {
		t.Fatal("native account transport cannot expose its standard underlying transport")
	}
	return connection, base
}

func tlsRecoveryFixture(t *testing.T, silent int, handler http.HandlerFunc) (*serverConnection, *http.Transport, *tlsRecoveryListener) {
	t.Helper()
	server := httptest.NewUnstartedServer(handler)
	listener := &tlsRecoveryListener{Listener: server.Listener, silent: silent, hellos: make(chan struct{}, 8)}
	server.Listener = listener
	server.StartTLS()
	t.Cleanup(server.Close)
	t.Cleanup(listener.closeOwned)
	connection, base := tlsRecoveryAccount(t, server.URL, server.Certificate().Raw)
	return connection, base, listener
}

type tlsRecoveryBody struct {
	reader        *strings.Reader
	reads, closes atomic.Int32
}

func (body *tlsRecoveryBody) Read(p []byte) (int, error) {
	body.reads.Add(1)
	return body.reader.Read(p)
}

func (body *tlsRecoveryBody) Close() error { body.closes.Add(1); return nil }

func TestServerTLSRecoveryRetriesUnsentPostWithFreshBodyAtOriginalTimeout(t *testing.T) {
	output := captureHTTP2LivenessLog(t)
	const content = "TLS_RECOVERY_PRIVATE_POST_BODY"
	var posts atomic.Int32
	connection, base, listener := tlsRecoveryFixture(t, 1, func(w http.ResponseWriter, request *http.Request) {
		posts.Add(1)
		body, err := io.ReadAll(request.Body)
		if err != nil || request.Method != http.MethodPost || string(body) != content {
			t.Error("recovered POST did not arrive intact")
		}
		io.WriteString(w, "recovered exactly once")
	})
	if base.TLSHandshakeTimeout != 10*time.Second || base.ResponseHeaderTimeout != 0 || connection.client.Timeout != 0 {
		t.Fatal("success regression must preserve the real ten-second TLS and original application budgets")
	}
	original := &tlsRecoveryBody{reader: strings.NewReader(content)}
	var restored *tlsRecoveryBody
	var restores atomic.Int32
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	request, _ := http.NewRequestWithContext(ctx, http.MethodPost, connection.baseURL+"/api/recover?token=TLS_RECOVERY_PRIVATE_QUERY", original)
	request.ContentLength = int64(len(content))
	request.Header.Set("Authorization", "Bearer TLS_RECOVERY_PRIVATE_HEADER")
	request.GetBody = func() (io.ReadCloser, error) {
		restores.Add(1)
		restored = &tlsRecoveryBody{reader: strings.NewReader(content)}
		return restored, nil
	}
	started := time.Now()
	response, err := connection.client.Do(request)
	if err != nil {
		t.Fatal("safe pre-HTTP recovery failed:", err)
	}
	body, readErr := io.ReadAll(response.Body)
	response.Body.Close()
	if readErr != nil || response.StatusCode != 200 || string(body) != "recovered exactly once" {
		t.Fatal("recovered response was not intact:", readErr)
	}
	if elapsed := time.Since(started); elapsed < 9*time.Second || elapsed > 13*time.Second {
		t.Fatalf("first acquisition did not use the original ten-second TLS timeout: %s", elapsed)
	}
	if listener.accepts.Load() != 2 || posts.Load() != 1 || restores.Load() != 1 || original.reads.Load() != 0 || original.closes.Load() != 1 || restored == nil || restored.reads.Load() == 0 || restored.closes.Load() != 1 {
		t.Fatalf("body/acquisition contract changed: connections=%d posts=%d restores=%d original_read_calls=%d original_closes=%d", listener.accepts.Load(), posts.Load(), restores.Load(), original.reads.Load(), original.closes.Load())
	}
	if strings.Count(output.String(), "event=tls-pre-http-reconnect ") != 1 || strings.Contains(output.String(), "TLS_RECOVERY_PRIVATE_") {
		t.Fatal("recovery was not one-shot or its log exposed request content")
	}
	t.Logf("original TLS timeout elapsed=%s connections=2 POST deliveries=1 original body reads=0 closes=1 GetBody=1 fresh body read/closed; original caller deadline retained", time.Since(started))
}

func TestServerTLSRecoveryPersistentFailureStopsAfterTwoAcquisitions(t *testing.T) {
	output := captureHTTP2LivenessLog(t)
	connection, base, listener := tlsRecoveryFixture(t, -1, func(http.ResponseWriter, *http.Request) { t.Error("silent TLS reached HTTP") })
	base.TLSHandshakeTimeout = 100 * time.Millisecond
	response, err := connection.client.Get(connection.baseURL + "/api/two-attempts")
	if response != nil {
		response.Body.Close()
	}
	if !isServerTLSHandshakeTimeout(err) || listener.accepts.Load() != 2 || strings.Count(output.String(), "event=tls-pre-http-reconnect ") != 1 {
		t.Fatalf("persistent TLS failure did not stop after two acquisitions: connections=%d error_type=%T", listener.accepts.Load(), err)
	}
}

func TestServerTLSRecoveryDoesNotReplayCertificateHTTPOrUnknownResults(t *testing.T) {
	for _, mode := range []string{"certificate", "http-status", "partial-body", "unknown-post"} {
		t.Run(mode, func(t *testing.T) {
			output := captureHTTP2LivenessLog(t)
			var requests atomic.Int32
			connection, _, listener := tlsRecoveryFixture(t, 0, func(w http.ResponseWriter, request *http.Request) {
				requests.Add(1)
				io.Copy(io.Discard, request.Body)
				switch mode {
				case "http-status":
					w.WriteHeader(http.StatusServiceUnavailable)
					io.WriteString(w, "service declined")
				case "partial-body":
					w.Header().Set("Content-Length", "100")
					io.WriteString(w, "partial")
				case "unknown-post":
					connection, _, err := w.(http.Hijacker).Hijack()
					if err != nil {
						t.Error(err)
						return
					}
					connection.Close()
				default:
					t.Error("untrusted TLS must not reach HTTP")
				}
			})
			base, _ := serverHTTPTransport(connection.client.Transport)
			if mode == "certificate" {
				base.TLSClientConfig.RootCAs = x509.NewCertPool()
			}
			request, _ := http.NewRequest(http.MethodPost, connection.baseURL+"/api/no-replay", strings.NewReader("a single non-idempotent operation"))
			response, err := connection.client.Do(request)
			if mode == "certificate" {
				var certificateError *tls.CertificateVerificationError
				if !errors.As(err, &certificateError) || requests.Load() != 0 {
					t.Fatalf("certificate failure changed: error_type=%T HTTP requests=%d", err, requests.Load())
				}
			} else if mode == "unknown-post" {
				if err == nil || requests.Load() != 1 {
					t.Fatal("unknown POST outcome was not preserved as a failure")
				}
			} else {
				if err != nil {
					t.Fatal(err)
				}
				_, readErr := io.ReadAll(response.Body)
				response.Body.Close()
				if mode == "http-status" && (response.StatusCode != 503 || readErr != nil) || mode == "partial-body" && !errors.Is(readErr, io.ErrUnexpectedEOF) {
					t.Fatalf("HTTP result changed: status=%d read_error_type=%T", response.StatusCode, readErr)
				}
			}
			if listener.accepts.Load() != 1 || strings.Contains(output.String(), "event=tls-pre-http-reconnect ") {
				t.Fatalf("non-eligible result was replayed: connections=%d", listener.accepts.Load())
			}
		})
	}
}

func TestServerTLSRecoveryRequiresRestorableBody(t *testing.T) {
	for _, mode := range []string{"no-get-body", "restore-error", "account-canceled-during-restore"} {
		t.Run(mode, func(t *testing.T) {
			output := captureHTTP2LivenessLog(t)
			connection, base, listener := tlsRecoveryFixture(t, -1, func(http.ResponseWriter, *http.Request) { t.Error("silent TLS reached HTTP") })
			base.TLSHandshakeTimeout = 80 * time.Millisecond
			original := &tlsRecoveryBody{reader: strings.NewReader("original unread body")}
			request, _ := http.NewRequest(http.MethodPost, connection.baseURL+"/api/body-contract", original)
			var fresh *tlsRecoveryBody
			if mode != "no-get-body" {
				request.GetBody = func() (io.ReadCloser, error) {
					if mode == "restore-error" {
						return nil, errors.New("body restoration unavailable")
					}
					fresh = &tlsRecoveryBody{reader: strings.NewReader("fresh body")}
					connection.cancel()
					return fresh, nil
				}
			}
			response, err := connection.client.Do(request)
			if response != nil {
				response.Body.Close()
			}
			if err == nil || listener.accepts.Load() != 1 || original.reads.Load() != 0 || original.closes.Load() != 1 || strings.Contains(output.String(), "event=tls-pre-http-reconnect ") {
				t.Fatalf("unrestorable body was reused: mode=%s connections=%d reads=%d closes=%d error_type=%T", mode, listener.accepts.Load(), original.reads.Load(), original.closes.Load(), err)
			}
			if fresh != nil && (fresh.reads.Load() != 0 || fresh.closes.Load() != 1) {
				t.Fatal("a canceled retry did not close its freshly restored unread body")
			}
		})
	}
}

func TestServerTLSRecoveryKeepsCallerAccountAndOriginalDeadline(t *testing.T) {
	for _, mode := range []string{"caller-cancel", "account-cancel", "legacy-cancel", "deadline-before-first", "deadline-during-second"} {
		t.Run(mode, func(t *testing.T) {
			output := captureHTTP2LivenessLog(t)
			connection, base, listener := tlsRecoveryFixture(t, -1, func(http.ResponseWriter, *http.Request) { t.Error("silent TLS reached HTTP") })
			base.TLSHandshakeTimeout = 100 * time.Millisecond
			ctx, cancel := context.WithCancel(context.Background())
			if mode == "deadline-before-first" || mode == "deadline-during-second" {
				cancel()
				budget := 30 * time.Millisecond
				if mode == "deadline-during-second" {
					budget = 160 * time.Millisecond
				}
				ctx, cancel = context.WithTimeout(context.Background(), budget)
			}
			defer cancel()
			legacy := make(chan struct{})
			request, _ := http.NewRequestWithContext(ctx, http.MethodGet, connection.baseURL+"/api/cancel-gates", nil)
			if mode == "legacy-cancel" {
				request.Cancel = legacy
			}
			result := make(chan error, 1)
			started := time.Now()
			go func() {
				response, err := connection.client.Do(request)
				if response != nil {
					response.Body.Close()
				}
				result <- err
			}()
			select {
			case <-listener.hellos:
			case <-time.After(time.Second):
				t.Fatal("ClientHello did not reach the local server")
			}
			switch mode {
			case "caller-cancel":
				cancel()
			case "account-cancel":
				connection.cancel()
			case "legacy-cancel":
				close(legacy)
			}
			select {
			case err := <-result:
				if err == nil {
					t.Fatal("canceled or deadline-bound TLS unexpectedly succeeded")
				}
				if strings.HasPrefix(mode, "deadline-") && !errors.Is(err, context.DeadlineExceeded) {
					t.Fatalf("caller deadline changed: error_type=%T", err)
				}
			case <-time.After(time.Second):
				t.Fatal("recovery extended the original caller/account cancellation budget")
			}
			wantConnections, wantRecoveries := int32(1), 0
			if mode == "deadline-during-second" {
				wantConnections, wantRecoveries = 2, 1
			}
			if listener.accepts.Load() != wantConnections || strings.Count(output.String(), "event=tls-pre-http-reconnect ") != wantRecoveries || time.Since(started) > 500*time.Millisecond {
				t.Fatalf("recovery exceeded its gate or original deadline: mode=%s connections=%d elapsed=%s", mode, listener.accepts.Load(), time.Since(started))
			}
		})
	}
}

func TestServerTLSRecoveryRejectsMessageAndGeneralTimeoutLookalikes(t *testing.T) {
	for _, err := range []error{nil, errors.New("net/http: TLS handshake timeout"), context.DeadlineExceeded, &tls.CertificateVerificationError{Err: errors.New("verification failed")}} {
		if isServerTLSHandshakeTimeout(err) {
			t.Fatalf("non-canonical TLS failure was admitted: error_type=%T", err)
		}
	}
}

func TestServerTLSRecoveryRejectsOuterRetryAfterRealHTTP2ImplicitAttempt(t *testing.T) {
	output := captureHTTP2LivenessLog(t)
	seed := httptest.NewTLSServer(http.NotFoundHandler())
	serverTLS, certificate := seed.TLS.Clone(), seed.Certificate().Raw
	seed.Close()
	serverTLS.NextProtos = []string{"h2"}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	var accepts, headers atomic.Int32
	var ownedMu sync.Mutex
	var owned []net.Conn
	serverErrors := make(chan error, 8)
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
			raw, err := listener.Accept()
			if err != nil {
				return
			}
			index := accepts.Add(1)
			ownedMu.Lock()
			owned = append(owned, raw)
			ownedMu.Unlock()
			go func() {
				defer raw.Close()
				if index != 1 {
					// The Go-internal retry gets a new TCP connection but no
					// server TLS reply. Only net/http's TLS timer may end it.
					io.Copy(io.Discard, raw)
					return
				}
				connection := tls.Server(raw, serverTLS)
				if err := connection.Handshake(); err != nil {
					serverErrors <- err
					return
				}
				preface := make([]byte, 24)
				if _, err := io.ReadFull(connection, preface); err != nil {
					serverErrors <- err
					return
				}
				if string(preface) != "PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n" {
					serverErrors <- errors.New("client did not send the HTTP/2 preface")
					return
				}
				if _, err := connection.Write([]byte{0, 0, 0, 4, 0, 0, 0, 0, 0}); err != nil {
					serverErrors <- err
					return
				}
				var headerStream uint32
				for {
					var frame [9]byte
					if _, err := io.ReadFull(connection, frame[:]); err != nil {
						serverErrors <- err
						return
					}
					length := int64(frame[0])<<16 | int64(frame[1])<<8 | int64(frame[2])
					if _, err := io.CopyN(io.Discard, connection, length); err != nil {
						serverErrors <- err
						return
					}
					stream := binary.BigEndian.Uint32(frame[5:]) & 0x7fffffff
					if frame[3] == 4 && frame[4]&1 == 0 {
						if _, err := connection.Write([]byte{0, 0, 0, 4, 1, 0, 0, 0, 0}); err != nil {
							serverErrors <- err
							return
						}
					}
					if frame[3] == 1 && stream != 0 {
						headerStream = stream
					}
					if headerStream != 0 && stream == headerStream && (frame[3] == 1 || frame[3] == 9) && frame[4]&4 != 0 {
						headers.Add(1)
						// GOAWAY(NO_ERROR,lastStreamID=0) marks the first stream
						// unprocessed and forces Go's internal retry onto TCP #2.
						_, err := connection.Write([]byte{0, 0, 8, 7, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0})
						if err != nil {
							serverErrors <- err
							return
						}
						io.Copy(io.Discard, connection)
						return
					}
				}
			}()
		}
	}()
	origin := "https://" + listener.Addr().String()
	connection, base := tlsRecoveryAccount(t, origin, certificate)
	// Exercise defensive H2 recovery only through an explicit diagnostic opt-in.
	base.Protocols = new(http.Protocols)
	base.Protocols.SetHTTP1(true)
	base.Protocols.SetHTTP2(true)
	base.TLSHandshakeTimeout = 200 * time.Millisecond
	var assigned, verified, timedOut atomic.Int32
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	ctx = httptrace.WithClientTrace(ctx, &httptrace.ClientTrace{
		GotConn: func(httptrace.GotConnInfo) { assigned.Add(1) },
		TLSHandshakeDone: func(_ tls.ConnectionState, err error) {
			if err == nil {
				verified.Add(1)
			} else if isServerTLSHandshakeTimeout(err) {
				timedOut.Add(1)
			}
		},
	})
	request, _ := http.NewRequestWithContext(ctx, http.MethodGet, origin+"/api/h2-implicit-attempt", nil)
	response, err := connection.client.Do(request)
	if response != nil {
		response.Body.Close()
	}
	select {
	case serverErr := <-serverErrors:
		t.Fatalf("controlled HTTP/2 sequence failed: error_type=%T", serverErr)
	default:
	}
	if !isServerTLSHandshakeTimeout(err) || ctx.Err() != nil || accepts.Load() != 2 || headers.Load() != 1 || assigned.Load() != 1 || verified.Load() != 1 || timedOut.Load() != 1 {
		t.Fatalf("did not reach real H2 HEADERS then internal TLS failure: connections=%d headers=%d GotConn=%d verified=%d tls_timeouts=%d error_type=%T caller_error=%v", accepts.Load(), headers.Load(), assigned.Load(), verified.Load(), timedOut.Load(), err, ctx.Err())
	}
	if strings.Contains(output.String(), "event=tls-pre-http-reconnect ") {
		t.Fatal("outer recovery replayed a request after a prior implicit attempt had GotConn")
	}
	t.Log("real H2 HEADERS + GOAWAY caused standard internal acquisition #2; TLS timeout returned; sticky GotConn prevented outer acquisition #3")
}
