//go:build windows

package main

import (
	"bytes"
	"context"
	"crypto/tls"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/http/httptrace"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func captureServerRequestTraceLog(t *testing.T) *bytes.Buffer {
	t.Helper()
	var output bytes.Buffer
	writer, flags, prefix := log.Writer(), log.Flags(), log.Prefix()
	log.SetOutput(&output)
	log.SetFlags(0)
	log.SetPrefix("")
	t.Cleanup(func() {
		log.SetOutput(writer)
		log.SetFlags(flags)
		log.SetPrefix(prefix)
	})
	return &output
}

func requireServerRequestError(t *testing.T, response BridgeResponse, status int, code string) {
	t.Helper()
	if response.Status != status || response.Headers["Content-Type"] != "application/json" || response.Headers["X-Chisa-Error"] != code {
		t.Fatalf("unexpected native error contract: status=%d headers=%v", response.Status, response.Headers)
	}
	raw, err := base64.StdEncoding.DecodeString(response.BodyB64)
	if err != nil {
		t.Fatal("native error body is not base64:", err)
	}
	var payload struct {
		Error struct {
			Code    string `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.Unmarshal(raw, &payload); err != nil {
		t.Fatal("native error body is not JSON:", err)
	}
	if payload.Error.Code != code || strings.TrimSpace(payload.Error.Message) == "" {
		t.Fatalf("native error lost its code or message: %s", raw)
	}
}

func requireServerRequestTraceFields(t *testing.T, line string, fields ...string) {
	t.Helper()
	for _, field := range fields {
		if !strings.Contains(line, field) {
			t.Errorf("trace missing %q: %s", field, line)
		}
	}
}

func TestServerRequestTracePostHeaderEOFDoesNotReplay(t *testing.T) {
	output := captureServerRequestTraceLog(t)
	const body = "TRACE_SECRET_POST_BODY"
	var posts atomic.Int32
	reviewHTTP(t, func(w http.ResponseWriter, r *http.Request) {
		posts.Add(1)
		raw, err := io.ReadAll(r.Body)
		if err != nil || r.Method != http.MethodPost || string(raw) != body {
			t.Errorf("POST did not finish before the response failed: method=%s bytes=%d error=%v", r.Method, len(raw), err)
		}
		connection, buffer, err := w.(http.Hijacker).Hijack()
		if err != nil {
			t.Error("hijack:", err)
			return
		}
		defer connection.Close()
		// A valid status line followed by an unfinished header block must fail
		// client.Do, rather than entering the response-body path.
		if _, err := buffer.WriteString("HTTP/1.1 200 OK\r\nContent-Length: 9\r\nX-Secret: TRACE_SECRET_RESPONSE_HEADER\r\nX-Unfinished: "); err != nil {
			t.Error("write partial headers:", err)
			return
		}
		if err := buffer.Flush(); err != nil {
			t.Error("flush partial headers:", err)
		}
	})
	bridge := FrontendBridge{}
	response := bridge.ServerRequest(bridge.BeginServerRequest(), http.MethodPost, "/api/trace-post?secret=TRACE_SECRET_QUERY", map[string]string{
		"Authorization": "Bearer TRACE_SECRET_REQUEST_HEADER",
	}, base64.StdEncoding.EncodeToString([]byte(body)))
	requireServerRequestError(t, response, 502, "UPSTREAM_CONNECTION_FAILED")
	if got := posts.Load(); got != 1 {
		t.Fatalf("POST was forwarded %d times, want exactly once", got)
	}
	line := output.String()
	requireServerRequestTraceFields(t, line, "endpoint=/api/trace-post ", "method=POST ", "event=transport-failed ", "phase=reading-headers ", "error=unexpected-eof ")
	if strings.Contains(line, "TRACE_SECRET_") || strings.Contains(line, "event=body-failed ") {
		t.Fatalf("header failure trace leaked content or used the body phase: %s", line)
	}
}

func TestServerRequestTraceBodyEOFReportsPartialRead(t *testing.T) {
	output := captureServerRequestTraceLog(t)
	const partial = "TRACE_SECRET_PARTIAL_RESPONSE_BODY"
	expected := len(partial) + 17
	reviewHTTP(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Length", strconv.Itoa(expected))
		w.Header().Set("X-Secret", "TRACE_SECRET_RESPONSE_HEADER")
		if _, err := io.WriteString(w, partial); err != nil {
			t.Error("write partial response:", err)
		}
	})
	bridge := FrontendBridge{}
	response := bridge.ServerRequest(bridge.BeginServerRequest(), http.MethodGet, "/api/trace-body?secret=TRACE_SECRET_QUERY", map[string]string{
		"Authorization": "Bearer TRACE_SECRET_REQUEST_HEADER",
	}, "")
	requireServerRequestError(t, response, 502, "UPSTREAM_RESPONSE_READ_FAILED")
	line := output.String()
	requireServerRequestTraceFields(t, line, "endpoint=/api/trace-body ", "event=body-failed ", "phase=reading-body ", "protocol=HTTP/1.1 ", "status=200 ", fmt.Sprintf("bytes=%d expected=%d ", len(partial), expected), "error=unexpected-eof ")
	if strings.Contains(line, "TRACE_SECRET_") || strings.Contains(line, "response-too-large") || strings.Contains(line, "event=transport-failed ") {
		t.Fatalf("partial body was leaked or misclassified: %s", line)
	}
}

func TestServerRequestTraceCanceledReservationsReturnJSON(t *testing.T) {
	bridge := FrontendBridge{}
	t.Run("missing", func(t *testing.T) {
		requireServerRequestError(t, bridge.ServerRequest("trace-missing-"+randHex(8), http.MethodGet, "/api/trace-canceled", nil, ""), 499, "REQUEST_CANCELED")
	})
	t.Run("canceled", func(t *testing.T) {
		// Keep the reservation present so this covers the interrupted branch
		// independently of BeginServerRequest's asynchronous deletion callback.
		ctx, cancel := context.WithCancel(context.Background())
		id := "trace-canceled-" + randHex(8)
		bridgeRequests.Store(id, &bridgeRequest{ctx: ctx, cancel: cancel})
		t.Cleanup(func() { cancel(); bridgeRequests.Delete(id) })
		bridge.CancelServerRequest(id)
		requireServerRequestError(t, bridge.ServerRequest(id, http.MethodGet, "/api/trace-canceled", nil, ""), 499, "REQUEST_INTERRUPTED")
	})
	t.Run("deadline", func(t *testing.T) {
		ctx, cancel := context.WithDeadline(context.Background(), time.Now().Add(-time.Second))
		id := "trace-deadline-" + randHex(8)
		bridgeRequests.Store(id, &bridgeRequest{ctx: ctx, cancel: cancel})
		t.Cleanup(func() { cancel(); bridgeRequests.Delete(id) })
		requireServerRequestError(t, bridge.ServerRequest(id, http.MethodGet, "/api/trace-canceled", nil, ""), 499, "REQUEST_TIMED_OUT")
	})
}

type serverRequestTraceTLSConn struct{ net.Conn }

func (*serverRequestTraceTLSConn) ConnectionState() tls.ConnectionState {
	return tls.ConnectionState{NegotiatedProtocol: "h2"}
}

func TestServerRequestTraceSlowSnapshotSeparatesTransportPhases(t *testing.T) {
	output := captureServerRequestTraceLog(t)
	client, peer := net.Pipe()
	t.Cleanup(func() { client.Close(); peer.Close() })
	connection := &serverRequestTraceTLSConn{Conn: client}
	trace := newServerRequestTrace(time.Now(), 41, http.MethodGet, "/api/trace-snapshot")
	hooks := httptrace.ContextClientTrace(trace.context(context.Background()))
	hooks.GetConn("TRACE_SECRET_HOST")
	hooks.GotConn(httptrace.GotConnInfo{Conn: connection, Reused: true, WasIdle: true, IdleTime: 2 * time.Second})
	hooks.WroteRequest(httptrace.WroteRequestInfo{})
	trace.log("slow", nil, -1, -1)
	hooks.GotFirstResponseByte()
	trace.log("slow", nil, -1, -1)
	trace.response(&http.Response{Proto: "HTTP/2.0", StatusCode: http.StatusOK, ContentLength: 29})
	trace.log("slow", nil, 3, 29)
	trace.complete()
	trace.log("slow", nil, 29, 29)
	lines := strings.Split(strings.TrimSpace(output.String()), "\n")
	if len(lines) != 4 {
		t.Fatalf("slow snapshot produced %d lines, want four", len(lines))
	}
	for _, line := range lines {
		requireServerRequestTraceFields(t, line, "endpoint=/api/trace-snapshot ", "method=GET ", "connection_version=41 ", "event=slow ", fmt.Sprintf("conn=%p ", connection), "reused=true ", "was_idle=true ", "idle=2s ", "error=none ")
	}
	requireServerRequestTraceFields(t, lines[0], "phase=awaiting-headers ", "protocol=h2 ", "status=0 ")
	requireServerRequestTraceFields(t, lines[1], "phase=reading-headers ", "protocol=h2 ")
	requireServerRequestTraceFields(t, lines[2], "phase=reading-body ", "protocol=HTTP/2.0 ", "status=200 ", "bytes=3 expected=29 ")
	requireServerRequestTraceFields(t, lines[3], "phase=response-received ", "bytes=29 expected=29 ")
	if strings.Contains(output.String(), "TRACE_SECRET_") {
		t.Fatalf("slow snapshot logged the connection target: %s", output.String())
	}
}
