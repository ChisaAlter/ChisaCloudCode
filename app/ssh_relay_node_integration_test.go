package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/http/httptest"
	"net/http/httputil"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

type relayNodeHarness struct {
	origin string
	client *http.Client
}

type relayNodeEvent struct {
	Event        string   `json:"event"`
	Kind         string   `json:"kind"`
	RequestID    string   `json:"requestId"`
	RequestIDs   []string `json:"requestIds"`
	ConnectionID string   `json:"connectionId"`
	Accepted     bool     `json:"accepted"`
}

type relayNodeState struct {
	Events      []relayNodeEvent `json:"events"`
	Connections []struct {
		ID           string `json:"id"`
		Protocol     int    `json:"protocol"`
		Online       bool   `json:"online"`
		PendingCount int    `json:"pendingCount"`
	} `json:"connections"`
}

type relayNodeEnqueued struct {
	OK       bool               `json:"ok"`
	Response agentRelayResponse `json:"response"`
	Error    struct {
		Code string `json:"code"`
	} `json:"error"`
}

type relayNodeCall struct {
	result relayNodeEnqueued
	err    error
}

// This is an opt-in dependency only when the isolated compiled harness exists.
// It runs the real broker from server/modules/ssh-workspaces, never the deployed
// API or a desktop application. Native requests still use the account fixture.
func startRelayNodeHarness(t *testing.T) *relayNodeHarness {
	t.Helper()
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("actual Node broker integration requires a Node executable")
	}
	harness := os.Getenv("CHISA_RELAY_HARNESS_JS")
	if harness == "" {
		harness = filepath.Join("..", "cloudcli-ui", "node_modules", ".cache", "chisa-relay-native-qa", "dist-server", "server", "modules", "ssh-workspaces", "tests", "agent-relay-native-harness.js")
	}
	harness, err = filepath.Abs(harness)
	if err != nil {
		t.Fatal(err)
	}
	if info, statErr := os.Stat(harness); statErr != nil || !info.Mode().IsRegular() {
		t.Skip("actual Node broker integration requires the compiled harness; set CHISA_RELAY_HARNESS_JS to its JavaScript path")
	}
	directory := t.TempDir()
	logPath := filepath.Join(directory, "broker-process.log")
	output, err := os.Create(logPath)
	if err != nil {
		t.Fatal(err)
	}
	command := exec.Command(node, harness)
	command.Env = append(os.Environ(), "CHISA_RELAY_QA_DIR="+directory, "CHISA_RELAY_QA_STDIN=0", "CHISA_RELAY_QA_PORT=0")
	command.Stdout, command.Stderr = output, output
	if err := command.Start(); err != nil {
		_ = output.Close()
		t.Fatal("cannot start isolated Node broker", err)
	}
	exited := make(chan struct{})
	var exitErr error
	go func() { exitErr = command.Wait(); close(exited) }()
	transport := &http.Transport{Proxy: nil}
	fixture := &relayNodeHarness{client: &http.Client{Transport: transport, Timeout: 20 * time.Second}}
	t.Cleanup(func() {
		if fixture.origin != "" {
			ctx, cancel := context.WithTimeout(context.Background(), time.Second)
			request, _ := http.NewRequestWithContext(ctx, http.MethodPost, fixture.origin+"/qa/shutdown", strings.NewReader("{}"))
			request.Header.Set("Content-Type", "application/json")
			if response, err := fixture.client.Do(request); err == nil {
				_, _ = io.Copy(io.Discard, response.Body)
				_ = response.Body.Close()
			}
			cancel()
		}
		select {
		case <-exited:
		case <-time.After(3 * time.Second):
			_ = command.Process.Kill()
			<-exited
		}
		transport.CloseIdleConnections()
		_ = output.Close()
		if exitErr != nil {
			raw, _ := os.ReadFile(logPath)
			t.Errorf("isolated Node broker exited with %v: %s", exitErr, raw)
		} else if t.Failed() {
			raw, _ := os.ReadFile(logPath)
			t.Logf("isolated broker trace: %s", raw)
		}
	})
	ticker := time.NewTicker(10 * time.Millisecond)
	defer ticker.Stop()
	deadline := time.NewTimer(10 * time.Second)
	defer deadline.Stop()
	for {
		raw, readErr := os.ReadFile(filepath.Join(directory, "ready.json"))
		var ready struct {
			Origin   string `json:"origin"`
			Protocol int    `json:"protocol"`
		}
		if readErr == nil && json.Unmarshal(raw, &ready) == nil && ready.Origin != "" && ready.Protocol == 2 {
			fixture.origin = ready.Origin
			return fixture
		}
		select {
		case <-exited:
			raw, _ := os.ReadFile(logPath)
			t.Fatalf("Node broker exited before ready: %v: %s", exitErr, raw)
		case <-deadline.C:
			t.Fatal("isolated Node broker did not publish ready.json within ten seconds")
		case <-ticker.C:
		}
	}
}

func (fixture *relayNodeHarness) request(method, path string, body any, result any) error {
	var reader io.Reader
	if body != nil {
		raw, err := json.Marshal(body)
		if err != nil {
			return err
		}
		reader = bytes.NewReader(raw)
	}
	request, err := http.NewRequest(method, fixture.origin+path, reader)
	if err != nil {
		return err
	}
	if body != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	response, err := fixture.client.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(response.Body, 1024*1024))
	if err != nil {
		return err
	}
	if result != nil {
		if err := json.Unmarshal(raw, result); err != nil {
			return fmt.Errorf("broker fixture returned invalid JSON (HTTP %d): %w", response.StatusCode, err)
		}
	}
	return nil
}

func (fixture *relayNodeHarness) enqueue(connectionID, label, path string) <-chan relayNodeCall {
	result := make(chan relayNodeCall, 1)
	go func() {
		var reply relayNodeEnqueued
		err := fixture.request(http.MethodPost, "/qa/enqueue", map[string]any{"connectionId": connectionID, "label": label, "timeoutMs": 15000,
			"payload": map[string]any{"protocol": 1, "rootPath": `C:\workspace`, "generation": "actual-node-test", "request": map[string]any{"op": "read", "path": path}}}, &reply)
		result <- relayNodeCall{reply, err}
	}()
	return result
}

func relayNodeAwaitCall(t *testing.T, result <-chan relayNodeCall) relayNodeEnqueued {
	t.Helper()
	select {
	case reply := <-result:
		if reply.err != nil {
			t.Fatal("actual broker request failed", reply.err)
		}
		return reply.result
	case <-time.After(18 * time.Second):
		t.Fatal("actual broker never settled the enqueued request")
		return relayNodeEnqueued{}
	}
}

func relayNodeAwaitSignal(t *testing.T, signal <-chan struct{}, label string) {
	t.Helper()
	select {
	case <-signal:
	case <-time.After(6 * time.Second):
		t.Fatalf("actual broker/native relay did not finish %s", label)
	}
}

func TestSshRelayActualNodeBrokerLostResponsesCancellationAndEpochRecovery(t *testing.T) {
	fixture := startRelayNodeHarness(t)
	upstream, err := url.Parse(fixture.origin)
	if err != nil {
		t.Fatal(err)
	}
	proxyTransport := &http.Transport{Proxy: nil}
	t.Cleanup(proxyTransport.CloseIdleConnections)
	proxy := httputil.NewSingleHostReverseProxy(upstream)
	proxy.Transport = proxyTransport
	proxy.ErrorLog = log.New(io.Discard, "", 0)
	proxy.ErrorHandler = func(writer http.ResponseWriter, request *http.Request, _ error) {
		// Preserve a lost response as actual transport failure through the
		// account fixture; the native recovery policy must observe the loss.
		if hijacker, ok := writer.(http.Hijacker); ok {
			if connection, _, err := hijacker.Hijack(); err == nil {
				_ = connection.Close()
				return
			}
		}
		http.Error(writer, "injected broker transport loss", http.StatusBadGateway)
	}
	var registrationMu sync.Mutex
	var tokens []string
	accountWorkspaceFixture(t, func(writer http.ResponseWriter, request *http.Request) {
		if request.URL.Path == "/api/ssh-workspaces/agent/connections" {
			raw, _ := io.ReadAll(request.Body)
			_ = request.Body.Close()
			request.Body = io.NopCloser(bytes.NewReader(raw))
			var registration struct {
				Token string `json:"token"`
			}
			_ = json.Unmarshal(raw, &registration)
			registrationMu.Lock()
			tokens = append(tokens, registration.Token)
			registrationMu.Unlock()
		}
		proxy.ServeHTTP(writer, request)
	})
	const markerBody = `{"ok":true,"protocol":1,"platform":"win32","rootIdentity":"node-cross-root","marker":"executed once"}`
	const probeBody = `{"ok":true,"protocol":1,"platform":"win32","rootIdentity":"node-cross-root","marker":"after epoch"}`
	cancelStarted, cancelStopped := make(chan struct{}), make(chan struct{})
	resetStarted, resetStopped := make(chan struct{}), make(chan struct{})
	var cancelStartOnce, cancelStopOnce, resetStartOnce, resetStopOnce sync.Once
	var markerExecutions, cancelExecutions, resetExecutions atomic.Int32
	local := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		var envelope struct {
			Request struct {
				Path string `json:"path"`
			} `json:"request"`
		}
		if json.NewDecoder(request.Body).Decode(&envelope) != nil {
			http.Error(writer, "invalid native payload", 400)
			return
		}
		switch envelope.Request.Path {
		case "marker.txt":
			markerExecutions.Add(1)
			writer.Header().Set("Content-Type", "application/json")
			_, _ = io.WriteString(writer, markerBody)
		case "cancel.txt":
			cancelExecutions.Add(1)
			cancelStartOnce.Do(func() { close(cancelStarted) })
			<-request.Context().Done()
			cancelStopOnce.Do(func() { close(cancelStopped) })
		case "reset.txt":
			resetExecutions.Add(1)
			resetStartOnce.Do(func() { close(resetStarted) })
			<-request.Context().Done()
			resetStopOnce.Do(func() { close(resetStopped) })
		case "after-epoch.txt":
			writer.Header().Set("Content-Type", "application/json")
			_, _ = io.WriteString(writer, probeBody)
		default:
			http.Error(writer, "unexpected local path", 400)
		}
	}))
	t.Cleanup(local.Close)
	manager, _ := sshTestManager(t)
	preserveDesktopSshManager(t, manager)
	var agentStarts atomic.Int32
	manager.deps.startAgent = func(int) (*localWorkspaceAgent, error) {
		agentStarts.Add(1)
		ctx, cancel := context.WithCancel(context.Background())
		return &localWorkspaceAgent{port: local.Listener.Addr().(*net.TCPAddr).Port, token: strings.Repeat("a", 64), ctx: ctx, cancel: cancel}, nil
	}
	manager.deps.after = func(time.Duration) <-chan time.Time { return time.After(2 * time.Millisecond) }
	ready := (FrontendBridge{}).EnsureSshAgent("")
	if ready["ok"] != true {
		t.Fatal("native Agent did not register against actual Node broker", ready)
	}
	profile := ready["profile"].(SshTunnelProfile)
	t.Cleanup(func() {
		(FrontendBridge{}).StopSshTunnel(profile.ID)
		waitSshState(t, manager, mustSshScope(t), profile.ID, "stopped")
	})

	if err := fixture.request(http.MethodPost, "/qa/faults", map[string]int{"poll": 1, "ack": 1, "result": 1}, nil); err != nil {
		t.Fatal(err)
	}
	marker := relayNodeAwaitCall(t, fixture.enqueue(profile.ID, "lost-poll-ack-result", "marker.txt"))
	if !marker.OK || marker.Response.Status != 200 || marker.Response.Body != markerBody || markerExecutions.Load() != 1 {
		t.Fatalf("actual broker/native loss recovery changed execution or response: %+v executions=%d", marker, markerExecutions.Load())
	}
	var state relayNodeState
	if err := fixture.request(http.MethodGet, "/qa/state", nil, &state); err != nil {
		t.Fatal(err)
	}
	faultCounts := map[string]int{}
	var offeredIDs []string
	ackCounts := map[string]int{}
	for _, event := range state.Events {
		if event.Event == "response-dropped" {
			faultCounts[event.Kind]++
		}
		if event.Event == "poll" {
			offeredIDs = append(offeredIDs, event.RequestIDs...)
		}
		if event.Event == "ack" && event.Accepted {
			ackCounts[event.RequestID]++
		}
	}
	if faultCounts["poll"] != 1 || faultCounts["ack"] != 1 || faultCounts["result"] != 1 || len(offeredIDs) < 2 || offeredIDs[0] != offeredIDs[1] || ackCounts[offeredIDs[0]] < 2 {
		t.Fatalf("crossimplementation test did not traverse actual broker loss windows: faults=%v offers=%v receipts=%v", faultCounts, offeredIDs, ackCounts)
	}

	cancelledCall := fixture.enqueue(profile.ID, "cancel-active-read", "cancel.txt")
	relayNodeAwaitSignal(t, cancelStarted, "local cancellable read startup")
	if err := fixture.request(http.MethodPost, "/qa/abort", map[string]string{"label": "cancel-active-read"}, nil); err != nil {
		t.Fatal(err)
	}
	relayNodeAwaitSignal(t, cancelStopped, "heartbeat cancellation of caller-aborted read")
	if reply := relayNodeAwaitCall(t, cancelledCall); reply.Error.Code != "AGENT_RELAY_INTERRUPTED" {
		t.Fatal("caller abort did not retain the actual broker error", reply)
	}

	resetCall := fixture.enqueue(profile.ID, "reset-active-read", "reset.txt")
	relayNodeAwaitSignal(t, resetStarted, "old-epoch read startup")
	if err := fixture.request(http.MethodPost, "/qa/reset", map[string]string{"connectionId": profile.ID}, nil); err != nil {
		t.Fatal(err)
	}
	relayNodeAwaitSignal(t, resetStopped, "old-epoch read cancellation")
	if reply := relayNodeAwaitCall(t, resetCall); reply.Error.Code != "AGENT_RELAY_REPLACED" {
		t.Fatal("epoch reset did not fence original broker work", reply)
	}
	// Ensure the native receive supervisor has negotiated the fresh epoch before
	// enqueueing another operation. This does not launch another local Agent.
	deadline := time.NewTimer(6 * time.Second)
	defer deadline.Stop()
	ticker := time.NewTicker(5 * time.Millisecond)
	defer ticker.Stop()
	for {
		if err := fixture.request(http.MethodGet, "/qa/state", nil, &state); err != nil {
			t.Fatal(err)
		}
		registered := 0
		for _, event := range state.Events {
			if event.Event == "registered" {
				registered++
			}
		}
		if len(state.Connections) == 1 && state.Connections[0].Protocol == 2 && state.Connections[0].Online && registered >= 2 {
			break
		}
		select {
		case <-deadline.C:
			t.Fatal("native relay did not re-register and negotiate the actual broker epoch")
		case <-ticker.C:
		}
	}
	after := relayNodeAwaitCall(t, fixture.enqueue(profile.ID, "post-epoch-probe", "after-epoch.txt"))
	if !after.OK || after.Response.Status != 200 || after.Response.Body != probeBody {
		t.Fatal("fresh epoch could not dispatch a new operation", after)
	}
	registrationMu.Lock()
	defer registrationMu.Unlock()
	if agentStarts.Load() != 1 || len(tokens) < 2 || cancelExecutions.Load() != 1 || resetExecutions.Load() != 1 {
		t.Fatal("native epoch recovery restarted Agent or replayed reads", agentStarts.Load(), len(tokens), cancelExecutions.Load(), resetExecutions.Load())
	}
	for _, token := range tokens {
		if token != tokens[0] || token == "" {
			t.Fatal("native broker recovery rotated the owned Agent token")
		}
	}
	t.Log("actual Node broker + native Go relay verified lost poll/ACK/result, one execution, caller cancellation and epoch recovery with one Agent/token")
}
