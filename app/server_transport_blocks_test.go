//go:build windows

package main

import (
	"bufio"
	"context"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"runtime"
	"strings"
	"testing"
	"time"
)

func TestServerTransportBlockClassifierAllowlist(t *testing.T) {
	const h2 = "net/http/internal/http2."
	read := []string{"internal/poll.runtime_pollWait", "internal/poll.(*FD).Read"}
	write := []string{"internal/poll.runtime_pollWait", "internal/poll.(*FD).Write"}
	for _, test := range []struct {
		name, state, category, wait string
		frames                      []string
	}{
		{"tls-reader", "IO wait, 3 minutes", "h2-reader", "tls-read-io", append(read, "crypto/tls.(*Conn).Read", h2+"(*ClientConn).readLoop")},
		{"reader-write-is-not-read", "IO wait", "h2-reader", "write-io", append(write, "crypto/tls.(*Conn).Write", h2+"(*ClientConn).readLoop")},
		{"reader-h2-mutex", "sync.Mutex.Lock", "h2-reader", "mutex", []string{"sync.(*Mutex).Lock", h2 + "(*clientConnReadLoop).processSettings", h2 + "(*ClientConn).readLoop"}},
		{"reader-tls-mutex", "semacquire", "h2-reader", "tls-mutex", []string{"sync.(*Mutex).Lock", "crypto/tls.(*Conn).Read", h2 + "(*ClientConn).readLoop"}},
		{"reader-channel", "select", "h2-reader", "channel", []string{h2 + "(*ClientConn).readLoop"}},
		{"body-cond", "semacquire", "h2-response-body", "cond", []string{"sync.(*Cond).Wait", h2 + "(*pipe).Read", h2 + "transportResponseBody.Read"}},
		{"flow-cond", "sync.Cond.Wait", "h2-request-flow", "cond", []string{h2 + "(*clientStream).awaitFlowControl", h2 + "(*clientStream).writeRequest"}},
		{"slot-cond", "sync.Cond.Wait", "h2-request-slot", "cond", []string{h2 + "(*ClientConn).awaitOpenSlotForStreamLocked", h2 + "(*clientStream).writeRequest"}},
		{"roundtrip-channel", "select", "h2-roundtrip", "channel", []string{h2 + "(*ClientConn).roundTrip"}},
		{"connect-read", "IO wait", "http-proxy-connect-read", "read-io", append(read, "net/http.ReadResponse", "net/http.(*Transport).dialConn.func3")},
		{"connect-write", "IO wait", "http-proxy-connect-write", "write-io", append(write, "net/http.(*Request).Write", "net/http.(*Transport).dialConn.func3")},
		{"tls-client-read", "IO wait", "http-client-tls", "read-io", append(read, "crypto/tls.(*Conn).clientHandshake", "net/http.(*persistConn).addTLS.func2")},
		{"dial-select-is-not-connect", "select", "", "", []string{"net/http.(*Transport).dialConn"}},
		{"server-tls-not-client", "IO wait", "", "", append(read, "crypto/tls.(*Conn).serverHandshake")},
		{"unknown-state-sanitized", "PRIVATE_STATE_CANARY", "h2-reader", "other", []string{h2 + "(*ClientConn).readLoop"}},
	} {
		t.Run(test.name, func(t *testing.T) {
			stack := fmt.Sprintf("goroutine 99 [%s]:\n", test.state)
			for _, frame := range test.frames {
				stack += frame + "(PRIVATE_ARGUMENT_CANARY)\n\tC:/PRIVATE_PATH_CANARY/source.go:55 +0xabc\n"
			}
			stack += "created by PRIVATE_CREATOR_CANARY in goroutine 3\n"
			sample := classifyServerTransportBlocks([]byte(stack), true)
			if test.category == "" {
				if len(sample.Counts) != 0 {
					t.Fatalf("unsupported stack was classified: %+v", sample.Counts)
				}
			} else if len(sample.Counts) != 1 || sample.Counts[0] != (serverTransportBlockCount{test.category, test.wait, 1}) {
				t.Fatalf("incorrect static block classification: %+v", sample.Counts)
			}
			raw, _ := json.Marshal(sample)
			if sample.Scope != "process" || !sample.Truncated || strings.Contains(string(raw), "PRIVATE_") || strings.Contains(string(raw), "goroutine") || strings.Contains(string(raw), "source.go") {
				t.Fatalf("classification leaked raw stack material or lost its scope: %s", raw)
			}
		})
	}
	output := captureServerRequestTraceLog(t)
	sampleServerTransportBlocks("PRIVATE_POINT_CANARY")
	if strings.Contains(output.String(), "PRIVATE_") || !strings.Contains(output.String(), `"point":"unknown"`) {
		t.Fatal("stack sample log accepted a non-allowlisted point")
	}
}

func awaitServerTransportBlock(t *testing.T, category, state string) serverTransportBlockSample {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for {
		stack := make([]byte, 1<<20)
		n := runtime.Stack(stack, true)
		sample := classifyServerTransportBlocks(stack[:n], n == len(stack))
		for _, count := range sample.Counts {
			if count.Category == category && count.State == state && count.Count > 0 {
				t.Logf("observed static blocks: %+v", sample.Counts)
				return sample
			}
		}
		if time.Now().After(deadline) {
			t.Fatalf("real transport did not reach %s/%s; static counts=%+v", category, state, sample.Counts)
		}
		time.Sleep(time.Millisecond)
	}
}

func TestServerTransportBlocksObserveRealHTTP2ReaderAndStreamWaits(t *testing.T) {
	started := make(chan struct{}, 2)
	server := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/body" {
			w.Header().Set("Content-Length", "20")
			w.WriteHeader(http.StatusOK)
			w.(http.Flusher).Flush()
		}
		started <- struct{}{}
		<-r.Context().Done()
	}))
	server.EnableHTTP2 = true
	server.StartTLS()
	t.Cleanup(server.Close)
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	results := make(chan error, 2)
	for _, path := range []string{"/headers", "/body"} {
		go func() {
			req, _ := http.NewRequestWithContext(ctx, http.MethodGet, server.URL+path, nil)
			response, err := server.Client().Do(req)
			if err == nil {
				if response.ProtoMajor != 2 {
					t.Error("block classification did not exercise actual HTTP/2")
				}
				_, err = io.Copy(io.Discard, response.Body)
				response.Body.Close()
			}
			results <- err
		}()
	}
	for range 2 {
		select {
		case <-started:
		case <-time.After(3 * time.Second):
			t.Fatal("real HTTP/2 stream did not start")
		}
	}
	awaitServerTransportBlock(t, "h2-reader", "tls-read-io")
	awaitServerTransportBlock(t, "h2-roundtrip", "channel")
	awaitServerTransportBlock(t, "h2-response-body", "cond")
	cancel()
	for range 2 {
		select {
		case <-results:
		case <-time.After(3 * time.Second):
			t.Fatal("controlled blocked stream did not settle on cancellation")
		}
	}
}

func TestServerTransportBlocksObserveRealProxyCONNECTAndTLS(t *testing.T) {
	for _, tlsStage := range []bool{false, true} {
		t.Run(fmt.Sprintf("afterCONNECT=%t", tlsStage), func(t *testing.T) {
			listener, err := net.Listen("tcp", "127.0.0.1:0")
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { listener.Close() })
			release, ready := make(chan struct{}), make(chan error, 1)
			t.Cleanup(func() { close(release) })
			go func() {
				conn, err := listener.Accept()
				if err != nil {
					ready <- err
					return
				}
				defer conn.Close()
				reader := bufio.NewReader(conn)
				req, err := http.ReadRequest(reader)
				if err == nil && req.Method != http.MethodConnect {
					err = fmt.Errorf("expected fixed CONNECT")
				}
				if err == nil && tlsStage {
					_, err = io.WriteString(conn, "HTTP/1.1 200 Connection Established\r\n\r\n")
					if err == nil {
						var header [5]byte
						_, err = io.ReadFull(reader, header[:])
						if err == nil {
							_, err = io.CopyN(io.Discard, reader, int64(binary.BigEndian.Uint16(header[3:])))
						}
					}
				}
				ready <- err
				<-release
			}()
			transport := http.DefaultTransport.(*http.Transport).Clone()
			proxy, _ := url.Parse("http://" + listener.Addr().String())
			transport.Proxy = http.ProxyURL(proxy)
			t.Cleanup(transport.CloseIdleConnections)
			ctx, cancel := context.WithCancel(context.Background())
			t.Cleanup(cancel)
			result := make(chan error, 1)
			go func() {
				req, _ := http.NewRequestWithContext(ctx, http.MethodGet, "https://127.0.0.1:1/api/status", nil)
				response, err := (&http.Client{Transport: transport}).Do(req)
				if response != nil {
					response.Body.Close()
				}
				result <- err
			}()
			select {
			case err := <-ready:
				if err != nil {
					t.Fatal("controlled proxy stage failed:", err)
				}
			case <-time.After(3 * time.Second):
				t.Fatal("controlled proxy stage did not start")
			}
			category := "http-proxy-connect-read"
			if tlsStage {
				category = "http-client-tls"
			}
			awaitServerTransportBlock(t, category, "read-io")
			cancel()
			select {
			case <-result:
			case <-time.After(3 * time.Second):
				t.Fatal("controlled proxy request did not settle on cancellation")
			}
		})
	}
}
