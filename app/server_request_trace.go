package main

import (
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/http/httptrace"
	"sync"
	"time"
)

// Record the transport stage, not URLs, headers, tokens, or response contents.
// A slow observation is diagnostic only: it does not cancel or replay a request.
type serverRequestTrace struct {
	mu                sync.Mutex
	started, phaseAt  time.Time
	version           uint64
	method, endpoint  string
	phase, connection string
	protocol          string
	reused, wasIdle   bool
	idleTime          time.Duration
	status            int
	tlsActive         bool
	tlsSequence       uint64
	tlsSample         *time.Timer
}

func newServerRequestTrace(started time.Time, version uint64, method, endpoint string) *serverRequestTrace {
	return &serverRequestTrace{started: started, phaseAt: started, version: version, method: method, endpoint: endpoint, phase: "acquiring-connection", protocol: "unknown", connection: "none"}
}

func (t *serverRequestTrace) setPhase(phase string) {
	t.mu.Lock()
	t.phase, t.phaseAt = phase, time.Now()
	t.mu.Unlock()
}

func (t *serverRequestTrace) beginTLS() {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.phase, t.phaseAt, t.tlsActive = "tls-handshake", time.Now(), true
	t.tlsSequence++
	sequence := t.tlsSequence
	if t.tlsSample != nil {
		t.tlsSample.Stop()
	}
	// Observe the actual native handshake before its ten-second transport
	// budget expires. A separate successful probe can warm certificate caches
	// and miss a first-request Windows chain-verification stall.
	t.tlsSample = time.AfterFunc(time.Second, func() {
		t.mu.Lock()
		pending := t.tlsActive && t.tlsSequence == sequence
		if pending {
			t.logLocked("tls-pending", nil, -1, -1)
		}
		t.mu.Unlock()
		if pending {
			sampleServerTransportBlocks("tls-one-second")
		}
	})
}

func (t *serverRequestTrace) endTLS() {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.tlsActive = false
	if t.tlsSample != nil {
		t.tlsSample.Stop()
	}
}

func (t *serverRequestTrace) context(ctx context.Context) context.Context {
	return httptrace.WithClientTrace(ctx, &httptrace.ClientTrace{
		GetConn:           func(string) { t.setPhase("acquiring-connection") },
		DNSStart:          func(httptrace.DNSStartInfo) { t.setPhase("resolving-host") },
		ConnectStart:      func(string, string) { t.setPhase("connecting") },
		TLSHandshakeStart: t.beginTLS,
		TLSHandshakeDone:  func(tls.ConnectionState, error) { t.endTLS() },
		GotConn: func(info httptrace.GotConnInfo) {
			t.mu.Lock()
			t.phase, t.phaseAt = "writing-request", time.Now()
			t.connection = fmt.Sprintf("%p", info.Conn)
			t.reused, t.wasIdle, t.idleTime = info.Reused, info.WasIdle, info.IdleTime
			if connection, ok := info.Conn.(interface{ ConnectionState() tls.ConnectionState }); ok {
				t.protocol = connection.ConnectionState().NegotiatedProtocol
				if t.protocol == "" {
					t.protocol = "no-alpn"
				}
			}
			t.mu.Unlock()
		},
		WroteRequest: func(info httptrace.WroteRequestInfo) {
			if info.Err != nil {
				t.setPhase("request-write-failed")
			} else {
				t.setPhase("awaiting-headers")
			}
		},
		GotFirstResponseByte: func() { t.setPhase("reading-headers") },
	})
}

func (t *serverRequestTrace) response(response *http.Response) {
	t.mu.Lock()
	t.phase, t.phaseAt = "reading-body", time.Now()
	t.protocol, t.status = response.Proto, response.StatusCode
	t.mu.Unlock()
}

func (t *serverRequestTrace) complete() { t.setPhase("response-received") }

func serverRequestErrorClass(err error) string {
	switch {
	case err == nil:
		return "none"
	case errors.Is(err, io.ErrUnexpectedEOF):
		return "unexpected-eof"
	case errors.Is(err, io.EOF):
		return "eof"
	case errors.Is(err, context.Canceled):
		return "canceled"
	case errors.Is(err, context.DeadlineExceeded):
		return "deadline"
	default:
		// Go 1.27's HTTP2 CountError can report a lost PING after an already
		// retired connection's read timer fires. Classify only the canonical
		// error that actually reached this request, never that process metric.
		for cause := err; cause != nil; cause = errors.Unwrap(cause) {
			if cause.Error() == "http2: client connection lost" {
				return "h2-connection-lost"
			}
		}
		var networkError net.Error
		if errors.As(err, &networkError) && networkError.Timeout() {
			return "network-timeout"
		}
		return "transport-error"
	}
}

func (t *serverRequestTrace) log(event string, err error, bytes int, expected int64) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.logLocked(event, err, bytes, expected)
}

func (t *serverRequestTrace) logLocked(event string, err error, bytes int, expected int64) {
	log.Printf("[server-request] endpoint=%s method=%s connection_version=%d event=%s elapsed=%s phase=%s phase_elapsed=%s conn=%s reused=%t was_idle=%t idle=%s protocol=%s status=%d bytes=%d expected=%d error=%s error_type=%T", t.endpoint, t.method, t.version, event, time.Since(t.started), t.phase, time.Since(t.phaseAt), t.connection, t.reused, t.wasIdle, t.idleTime, t.protocol, t.status, bytes, expected, serverRequestErrorClass(err), err)
}
