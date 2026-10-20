//go:build windows

package main

import (
	"context"
	"encoding/json"
	"encoding/pem"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"
)

func preserveFrontendRequestLifecycle(t *testing.T) {
	t.Helper()
	frontendRequestsMu.Lock()
	previous := frontendRequestsClosed
	frontendRequestsClosed = false
	frontendRequestsMu.Unlock()
	t.Cleanup(func() {
		closeFrontendServerRequests()
		frontendRequestsMu.Lock()
		frontendRequestsClosed = previous
		frontendRequestsMu.Unlock()
	})
}

func TestFrontendWindowClosureCancelsHTTP2OnlyFrontendRequests(t *testing.T) {
	preserveFrontendRequestLifecycle(t)
	started, canceled := make(chan string, 3), make(chan string, 2)
	releaseNative := make(chan struct{})
	server := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.ProtoMajor != 2 {
			t.Error("lifecycle regression did not exercise a shared HTTP/2 transport")
		}
		if r.URL.Path == "/api/wait-body" {
			w.Header().Set("Content-Length", "20")
			w.WriteHeader(http.StatusOK)
			w.(http.Flusher).Flush()
		}
		started <- r.URL.Path
		if r.URL.Path == "/api/native-recovery" {
			select {
			case <-releaseNative:
				_, _ = io.WriteString(w, "native cleanup completed")
			case <-r.Context().Done():
				t.Error("window closure canceled native recovery")
			}
			return
		}
		<-r.Context().Done()
		canceled <- r.URL.Path
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
	apiConnection = connection
	t.Cleanup(func() { connection.cancel(); connection.client.CloseIdleConnections() })
	// Product traffic defaults to H1; explicitly enable H2 to keep exercising
	// frontend stream cancellation without canceling shared native recovery.
	base, ok := serverHTTPTransport(connection.client.Transport)
	if !ok {
		t.Fatal("product HTTP transport unavailable")
	}
	base.Protocols = new(http.Protocols)
	base.Protocols.SetHTTP1(true)
	base.Protocols.SetHTTP2(true)
	transport := connection.client.Transport
	bridge := FrontendBridge{}
	results := make(chan BridgeResponse, 2)
	for _, path := range []string{"/api/wait-headers", "/api/wait-body"} {
		id := bridge.BeginServerRequest()
		go func() { results <- bridge.ServerRequest(id, http.MethodGet, path, nil, "") }()
	}
	reservedID := bridge.BeginServerRequest()
	reserved, _ := bridgeRequests.Load(reservedID)
	nativeResult := make(chan error, 1)
	go func() {
		req, err := http.NewRequestWithContext(connection.ctx, http.MethodGet, server.URL+"/api/native-recovery", nil)
		if err == nil {
			var response *http.Response
			response, err = connection.client.Do(req)
			if err == nil {
				var body []byte
				body, err = io.ReadAll(response.Body)
				response.Body.Close()
				if err == nil && string(body) != "native cleanup completed" {
					err = errors.New("native cleanup response lost")
				}
			}
		}
		nativeResult <- err
	}()
	for range 3 {
		select {
		case <-started:
		case <-time.After(3 * time.Second):
			t.Fatal("pending HTTP/2 request did not start")
		}
	}
	closeFrontendServerRequests()
	if reserved.(*bridgeRequest).ctx.Err() != context.Canceled {
		t.Fatal("unforwarded frontend reservation survived window closure")
	}
	if bridge.BeginServerRequest() != "" {
		t.Fatal("queued bridge call reserved a request after window closure")
	}
	for range 2 {
		select {
		case response := <-results:
			if response.Status != 499 || response.Headers["Content-Type"] != "application/json" {
				t.Fatalf("closed window HTTP request did not settle as JSON interruption: %+v", response)
			}
		case <-time.After(3 * time.Second):
			t.Fatal("closed window left frontend HTTP blocked")
		}
		select {
		case <-canceled:
		case <-time.After(3 * time.Second):
			t.Fatal("upstream did not observe frontend stream cancellation")
		}
	}
	if connection.ctx.Err() != nil || apiConnection != connection || connection.client.Transport != transport {
		t.Fatal("window closure replaced or canceled the account connection")
	}
	close(releaseNative)
	select {
	case err := <-nativeResult:
		if err != nil {
			t.Fatal("native recovery could not finish after window closure:", err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("native recovery did not finish on the preserved account connection")
	}
}

func TestFrontendWindowClosureRejectsConcurrentReservations(t *testing.T) {
	preserveFrontendRequestLifecycle(t)
	previous := apiConnection
	ctx, cancel := context.WithCancel(context.Background())
	apiConnection = &serverConnection{ctx: ctx, cancel: cancel}
	t.Cleanup(func() { cancel(); apiConnection = previous })
	bridge := FrontendBridge{}
	ready := make(chan struct{})
	var workers sync.WaitGroup
	for range 64 {
		workers.Go(func() {
			<-ready
			id := bridge.BeginServerRequest()
			if id == "" {
				return
			}
			pending, exists := bridgeRequests.Load(id)
			if exists {
				<-pending.(*bridgeRequest).ctx.Done()
			}
		})
	}
	close(ready)
	closeFrontendServerRequests()
	done := make(chan struct{})
	go func() { workers.Wait(); close(done) }()
	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Fatal("a racing Begin escaped the closed-window cancellation gate")
	}
	if bridge.BeginServerRequest() != "" || ctx.Err() != nil {
		t.Fatal("closed-window gate was reopened or canceled native account lifetime")
	}
}

func TestFrontendWindowClosureDoesNotWaitForAccountConnectionLock(t *testing.T) {
	preserveFrontendRequestLifecycle(t)
	previous := apiConnection
	ctx, cancel := context.WithCancel(context.Background())
	apiConnection = &serverConnection{ctx: ctx, cancel: cancel}
	t.Cleanup(func() { cancel(); apiConnection = previous })
	bridge := FrontendBridge{}
	id := bridge.BeginServerRequest()
	pending, _ := bridgeRequests.Load(id)
	serverConnectionMu.Lock()
	locked := true
	defer func() {
		if locked {
			serverConnectionMu.Unlock()
		}
	}()
	beginEntered := make(chan struct{})
	beginResult := make(chan string, 1)
	go func() { close(beginEntered); beginResult <- bridge.BeginServerRequest() }()
	<-beginEntered
	// Wait for the actual blocked RLock, rather than relying on scheduling or
	// timing to make Begin enter before the window's OnClosed callback.
	deadline := time.Now().Add(3 * time.Second)
	for {
		stack := make([]byte, 64<<10)
		stack = stack[:runtime.Stack(stack, true)]
		waiting := false
		for _, goroutine := range strings.Split(string(stack), "\n\n") {
			if strings.Contains(goroutine, "FrontendBridge.BeginServerRequest") && strings.Contains(goroutine, "(*RWMutex).RLock") {
				waiting = true
				break
			}
		}
		if waiting {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("Begin did not reach the held account connection lock")
		}
		time.Sleep(time.Millisecond)
	}
	closed := make(chan struct{})
	go func() { closeFrontendServerRequests(); close(closed) }()
	select {
	case <-closed:
	case <-time.After(3 * time.Second):
		t.Fatal("window closure waited for a long-running account connection operation")
	}
	if pending.(*bridgeRequest).ctx.Err() != context.Canceled || ctx.Err() != nil {
		t.Fatal("window closure failed to cancel only existing frontend requests")
	}
	serverConnectionMu.Unlock()
	locked = false
	select {
	case id := <-beginResult:
		if id != "" {
			t.Fatal("queued Begin created a request when the account operation completed after closure")
		}
	case <-time.After(3 * time.Second):
		t.Fatal("queued Begin did not settle after the account operation released its lock")
	}
}

func TestShutdownStageLogsBoundariesWithoutErrorContent(t *testing.T) {
	output := captureServerRequestTraceLog(t)
	failure := errors.New("LIFECYCLE_PRIVATE_ERROR_CANARY")
	calls := 0
	if err := logShutdownStage("previews", func() error { calls++; return failure }); err != failure || calls != 1 {
		t.Fatal("stage logging changed cleanup execution or its original error")
	}
	text := output.String()
	begin, end := strings.Index(text, "stage=previews event=begin"), strings.Index(text, "stage=previews event=end")
	if begin < 0 || end <= begin || !strings.Contains(text, "elapsed=") || !strings.Contains(text, "error_type=*errors.errorString") || strings.Contains(text, failure.Error()) {
		t.Fatalf("shutdown log lost boundaries or exposed error content: %s", text)
	}
}
