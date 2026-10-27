package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestSshRelayRetriesIdenticalResultNeverWorkspaceOperationAndCancelsPoll(t *testing.T) {
	marker := filepath.Join(t.TempDir(), "executions.txt")
	payload, _ := json.Marshal(map[string]any{"protocol": 1, "rootPath": t.TempDir(), "generation": "test", "request": map[string]any{"op": "probe"}})
	var polls, results atomic.Int32
	resultDone := make(chan struct{})
	pollCancelled := make(chan struct{}, 1)
	var resultBodies []string
	var mu sync.Mutex
	accountWorkspaceFixture(t, func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/ssh-workspaces/agent/connections":
			var p map[string]any
			json.NewDecoder(r.Body).Decode(&p)
			writeAgentJSON(w, 200, map[string]any{"ok": true, "connection": map[string]any{"id": p["id"], "port": p["port"], "transport": "agent"}})
		case "/api/ssh-workspaces/agent/relay/poll":
			if r.URL.Query().Get("wait") == "0" {
				writeAgentJSON(w, 200, map[string]any{"ready": true, "jobs": []any{}})
				return
			}
			if polls.Add(1) == 1 {
				writeAgentJSON(w, 200, map[string]any{"ready": true, "jobs": []any{map[string]any{"requestId": "request-one", "payload": json.RawMessage(payload)}}})
				return
			}
			<-r.Context().Done()
			select {
			case pollCancelled <- struct{}{}:
			default:
			}
		case "/api/ssh-workspaces/agent/relay/result":
			var p struct {
				Response agentRelayResponse `json:"response"`
			}
			json.NewDecoder(r.Body).Decode(&p)
			mu.Lock()
			resultBodies = append(resultBodies, p.Response.Body)
			mu.Unlock()
			if results.Add(1) == 1 {
				http.Error(w, "transient", 503)
				return
			}
			writeAgentJSON(w, 200, map[string]any{"ok": true, "accepted": true})
			close(resultDone)
		default:
			t.Error("unexpected relay endpoint", r.URL.Path)
		}
	})
	m, _ := sshTestManager(t)
	preserveDesktopSshManager(t, m)
	helper := filepath.Join(t.TempDir(), "helper.ps1")
	script := "$null=[Console]::In.ReadToEnd();[IO.File]::AppendAllText('" + strings.ReplaceAll(marker, "'", "''") + "','x');[Console]::Out.Write('{\"ok\":true,\"protocol\":1,\"platform\":\"win32\"}')"
	os.WriteFile(helper, []byte(script), 0600)
	m.deps.startAgent = func(int) (*localWorkspaceAgent, error) { return startLocalWorkspaceAgentWithHelper(0, helper) }
	m.deps.after = func(time.Duration) <-chan time.Time { return time.After(time.Millisecond) }
	response := (FrontendBridge{}).EnsureSshAgent("")
	if response["ok"] != true {
		t.Fatal(response)
	}
	p := response["profile"].(SshTunnelProfile)
	select {
	case <-resultDone:
	case <-time.After(8 * time.Second):
		t.Fatal("relay did not retry result")
	}
	raw, err := os.ReadFile(marker)
	if err != nil || string(raw) != "x" {
		t.Fatal("relay replayed workspace job", string(raw), err)
	}
	mu.Lock()
	equal := len(resultBodies) == 2 && resultBodies[0] == resultBodies[1]
	mu.Unlock()
	if !equal {
		t.Fatal("result retry changed cached response")
	}
	(FrontendBridge{}).StopSshTunnel(p.ID)
	waitSshState(t, m, mustSshScope(t), p.ID, "stopped")
	select {
	case <-pollCancelled:
	case <-time.After(time.Second):
		t.Fatal("stop did not cancel HTTPS poll")
	}
}

func TestSshRelayReleasesExecutionBeforeResultAcknowledgement(t *testing.T) {
	const regularJobs = 12
	const totalJobs = regularJobs + 1
	accepted := make(chan int, totalJobs)
	cancelledResults := make(chan struct{}, totalJobs)
	allAccepted := make(chan struct{})
	releaseResults := make(chan struct{})
	defer close(releaseResults)
	var polls atomic.Int32
	var acceptedCount atomic.Int32
	var mu sync.Mutex
	executions := make(map[int]int)
	local := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var payload struct {
			Index int `json:"index"`
		}
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			t.Error(err)
			return
		}
		mu.Lock()
		executions[payload.Index]++
		mu.Unlock()
		writeAgentJSON(w, 200, map[string]any{"ok": true})
	}))
	defer local.Close()
	accountWorkspaceFixture(t, func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/ssh-workspaces/agent/connections":
			var payload map[string]any
			json.NewDecoder(r.Body).Decode(&payload)
			writeAgentJSON(w, 200, map[string]any{"ok": true, "connection": map[string]any{"id": payload["id"], "port": payload["port"], "transport": "agent"}})
		case "/api/ssh-workspaces/agent/relay/poll":
			if r.URL.Query().Get("wait") == "0" {
				writeAgentJSON(w, 200, map[string]any{"ready": true, "jobs": []any{}})
				return
			}
			index := int(polls.Add(1)) - 1
			if index > 0 && index <= totalJobs {
				// Broker settlement makes the next job eligible while the prior
				// result HTTP response is still awaiting delivery to the client.
				select {
				case <-accepted:
				case <-r.Context().Done():
					return
				}
			}
			if index >= totalJobs {
				<-r.Context().Done()
				return
			}
			op := "read"
			if index == regularJobs {
				op = "job_status"
			}
			payload, _ := json.Marshal(map[string]any{"index": index, "request": map[string]any{"op": op}})
			writeAgentJSON(w, 200, map[string]any{"ready": true, "jobs": []any{map[string]any{"requestId": fmt.Sprintf("pending-ack-%d", index), "payload": json.RawMessage(payload)}}})
		case "/api/ssh-workspaces/agent/relay/result":
			_, _ = io.Copy(io.Discard, r.Body)
			accepted <- 1
			if acceptedCount.Add(1) == totalJobs {
				close(allAccepted)
			}
			select {
			case <-r.Context().Done():
				cancelledResults <- struct{}{}
			case <-releaseResults:
				writeAgentJSON(w, 200, map[string]any{"ok": true})
			}
		default:
			t.Error("unexpected relay endpoint", r.URL.Path)
		}
	})
	m, _ := sshTestManager(t)
	preserveDesktopSshManager(t, m)
	m.deps.agentPreflight = func() SshPreflight { return SshPreflight{OK: true} }
	m.deps.startAgent = func(int) (*localWorkspaceAgent, error) {
		ctx, cancel := context.WithCancel(context.Background())
		return &localWorkspaceAgent{port: local.Listener.Addr().(*net.TCPAddr).Port, token: strings.Repeat("a", 64), ctx: ctx, cancel: cancel}, nil
	}
	response := (FrontendBridge{}).EnsureSshAgent("")
	if response["ok"] != true {
		t.Fatal(response)
	}
	profile := response["profile"].(SshTunnelProfile)
	select {
	case <-allAccepted:
	case <-time.After(5 * time.Second):
		status, _ := m.getStatus(mustSshScope(t), profile.ID)
		t.Fatalf("result acknowledgement consumed execution slots: accepted=%d status=%+v", acceptedCount.Load(), status)
	}
	status, err := m.getStatus(mustSshScope(t), profile.ID)
	if err != nil || !status.OuterConnected || status.Code != "" {
		t.Fatal("slow result acknowledgements terminated relay", status, err)
	}
	mu.Lock()
	if len(executions) != totalJobs {
		t.Error("missing regular or recovery execution", executions)
	}
	for index := 0; index < totalJobs; index++ {
		if executions[index] != 1 {
			t.Error("workspace operation replayed or skipped", index, executions[index])
		}
	}
	mu.Unlock()
	(FrontendBridge{}).StopSshTunnel(profile.ID)
	waitSshState(t, m, mustSshScope(t), profile.ID, "stopped")
	for index := 0; index < totalJobs; index++ {
		select {
		case <-cancelledResults:
		case <-time.After(time.Second):
			t.Fatal("stop did not drain result acknowledgement requests", index)
		}
	}
}

func TestSshRelayBrokerSizedBurstPreservesControlLane(t *testing.T) {
	// The broker admits 32 regular requests. Git inspection may dispatch the
	// whole batch while every local HTTP response is still outstanding.
	const regularJobs = 32
	allRegularStarted := make(chan struct{})
	controlStarted := make(chan struct{})
	releaseRegular := make(chan struct{})
	var release sync.Once
	defer release.Do(func() { close(releaseRegular) })
	allResults := make(chan struct{})
	var regularStarted, resultCount, polls atomic.Int32
	var mu sync.Mutex
	executions := make(map[int]int)
	local := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var payload struct {
			Index int `json:"index"`
		}
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			t.Error(err)
			return
		}
		mu.Lock()
		executions[payload.Index]++
		mu.Unlock()
		if payload.Index < regularJobs {
			if regularStarted.Add(1) == regularJobs {
				close(allRegularStarted)
			}
			select {
			case <-releaseRegular:
			case <-r.Context().Done():
				return
			}
		} else {
			close(controlStarted)
		}
		writeAgentJSON(w, 200, map[string]any{"ok": true})
	}))
	defer local.Close()
	accountWorkspaceFixture(t, func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/ssh-workspaces/agent/connections":
			var payload map[string]any
			json.NewDecoder(r.Body).Decode(&payload)
			writeAgentJSON(w, 200, map[string]any{"ok": true, "connection": map[string]any{"id": payload["id"], "port": payload["port"], "transport": "agent"}})
		case "/api/ssh-workspaces/agent/relay/poll":
			if r.URL.Query().Get("wait") == "0" {
				writeAgentJSON(w, 200, map[string]any{"ready": true, "jobs": []any{}})
				return
			}
			batch := int(polls.Add(1)) - 1
			if batch > regularJobs/4 {
				<-r.Context().Done()
				return
			}
			jobs := []any{}
			if batch == regularJobs/4 {
				select {
				case <-allRegularStarted:
				case <-r.Context().Done():
					return
				}
				payload, _ := json.Marshal(map[string]any{"index": regularJobs, "request": map[string]any{"op": "job_status"}})
				jobs = append(jobs, map[string]any{"requestId": "burst-control", "payload": json.RawMessage(payload)})
			} else {
				for offset := 0; offset < 4; offset++ {
					index := batch*4 + offset
					payload, _ := json.Marshal(map[string]any{"index": index, "request": map[string]any{"op": "read"}})
					jobs = append(jobs, map[string]any{"requestId": fmt.Sprintf("burst-%d", index), "payload": json.RawMessage(payload)})
				}
			}
			writeAgentJSON(w, 200, map[string]any{"ready": true, "jobs": jobs})
		case "/api/ssh-workspaces/agent/relay/result":
			_, _ = io.Copy(io.Discard, r.Body)
			if resultCount.Add(1) == regularJobs+1 {
				close(allResults)
			}
			writeAgentJSON(w, 200, map[string]any{"ok": true})
		default:
			t.Error("unexpected relay endpoint", r.URL.Path)
		}
	})
	m, _ := sshTestManager(t)
	preserveDesktopSshManager(t, m)
	m.deps.agentPreflight = func() SshPreflight { return SshPreflight{OK: true} }
	m.deps.startAgent = func(int) (*localWorkspaceAgent, error) {
		ctx, cancel := context.WithCancel(context.Background())
		return &localWorkspaceAgent{port: local.Listener.Addr().(*net.TCPAddr).Port, token: strings.Repeat("a", 64), ctx: ctx, cancel: cancel}, nil
	}
	response := (FrontendBridge{}).EnsureSshAgent("")
	if response["ok"] != true {
		t.Fatal(response)
	}
	profile := response["profile"].(SshTunnelProfile)
	select {
	case <-controlStarted:
	case <-time.After(5 * time.Second):
		status, _ := m.getStatus(mustSshScope(t), profile.ID)
		t.Fatalf("broker-sized burst terminated relay or starved control: regular=%d status=%+v", regularStarted.Load(), status)
	}
	status, err := m.getStatus(mustSshScope(t), profile.ID)
	if err != nil || !status.OuterConnected || status.Code != "" {
		t.Fatal("broker-sized burst disconnected relay", status, err)
	}
	release.Do(func() { close(releaseRegular) })
	select {
	case <-allResults:
	case <-time.After(5 * time.Second):
		t.Fatal("burst results were not delivered", resultCount.Load())
	}
	mu.Lock()
	for index := 0; index <= regularJobs; index++ {
		if executions[index] != 1 {
			t.Error("workspace operation replayed or skipped", index, executions[index])
		}
	}
	mu.Unlock()
	(FrontendBridge{}).StopSshTunnel(profile.ID)
	waitSshState(t, m, mustSshScope(t), profile.ID, "stopped")
}

func TestSshRelayRegistrationCancelledOnAccountChangeAndNoCrossAccountDefaults(t *testing.T) {
	started, cancelled := make(chan struct{}), make(chan struct{})
	release := make(chan struct{})
	connection := accountWorkspaceFixture(t, func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
		close(started)
		select {
		case <-r.Context().Done():
			close(cancelled)
		case <-release:
		}
	})
	t.Cleanup(func() { close(release) })
	m, _ := sshTestManager(t)
	preserveDesktopSshManager(t, m)
	testAgentDependencies(t, m)
	cfg := store.config()
	cfg.SSHHost = "some-other-account.invalid"
	cfg.KeyPath = "private-reference"
	cfg.SSHKnownHostsPath = "host-reference"
	cfg.WorkspaceAccount = "another-account"
	cfg.WorkspaceLoginURL = connection.loginURL
	cfg.SSHHostKeyPinned = true
	store.updateConfig(cfg)
	if defaults := (FrontendBridge{}).GetSshDefaults(); defaults["ok"] != false {
		t.Fatal("other account refs exposed", defaults)
	}
	result := make(chan map[string]any, 1)
	go func() { result <- (FrontendBridge{}).EnsureSshAgent("") }()
	<-started
	(FrontendBridge{}).EndServerSession(connection.version)
	select {
	case response := <-result:
		if response["ok"] != false || response["code"] != "SSH_ACCOUNT_CHANGED" {
			t.Fatal(response)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("account transition did not cancel ensure")
	}
	select {
	case <-cancelled:
	case <-time.After(time.Second):
		t.Fatal("old authenticated HTTPS registration survived logout")
	}
}

func TestSshRelayControlLaneAndRetainedResultBudget(t *testing.T) {
	for _, op := range []string{"job_status", "job_cancel", "operation_status", "operation_cancel"} {
		payload, _ := json.Marshal(map[string]any{"request": map[string]any{"op": op}})
		if !relayControlPayload(payload) {
			t.Fatal("recovery starved by normal lane", op)
		}
	}
	if relayControlPayload([]byte(`{"request":{"op":"exec"}}`)) {
		t.Fatal("exec consumed recovery lane")
	}
	budget := &agentRelayResultBudget{}
	if !budget.reserve(24*1024*1024) || budget.reserve(1) {
		t.Fatal("retained relay results unbounded")
	}
	budget.release(24 * 1024 * 1024)
	if !budget.reserve(1) {
		t.Fatal("result budget not released")
	}
}

func TestSshRelayHandshakeRequiredAndRegistrationFailureRetryIsIdempotent(t *testing.T) {
	var registrations atomic.Int32
	accountWorkspaceFixture(t, func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/ssh-workspaces/agent/connections":
			var p map[string]any
			json.NewDecoder(r.Body).Decode(&p)
			registrations.Add(1)
			writeAgentJSON(w, 200, map[string]any{"ok": true, "connection": map[string]any{"id": p["id"], "port": p["port"], "transport": "agent"}})
		case "/api/ssh-workspaces/agent/relay/poll":
			if r.URL.Query().Get("wait") == "0" {
				writeAgentJSON(w, 200, map[string]any{"ready": registrations.Load() > 1, "jobs": []any{}})
				return
			}
			<-r.Context().Done()
		default:
			t.Error(r.URL.Path)
		}
	})
	m, _ := sshTestManager(t)
	preserveDesktopSshManager(t, m)
	agents := testAgentDependencies(t, m)
	first := (FrontendBridge{}).EnsureSshAgent("")
	if first["ok"] != false || first["code"] != "SSH_AGENT_REGISTRATION_FAILED" {
		t.Fatal(first)
	}
	p := first["profile"].(SshTunnelProfile)
	status := first["status"].(SshTunnelStatus)
	if status.OuterConnected || status.RegistrationState != "error" {
		t.Fatal(status)
	}
	a := <-agents
	second := (FrontendBridge{}).EnsureSshAgent(p.ID)
	if second["ok"] != true || second["status"].(SshTunnelStatus).Generation != status.Generation {
		t.Fatal(second)
	}
	select {
	case <-agents:
		t.Fatal("handshake retry restarted listener")
	default:
	}
	if len(a.token) != 64 {
		t.Fatal(fmt.Sprintf("token length %d", len(a.token)))
	}
}
