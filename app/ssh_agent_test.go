package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func testAgentDependencies(t *testing.T, manager *sshTunnelManager) <-chan *localWorkspaceAgent {
	t.Helper()
	agents := make(chan *localWorkspaceAgent, 8)
	helper := filepath.Join(t.TempDir(), "test-helper.ps1")
	if err := os.WriteFile(helper, []byte("$null=[Console]::In.ReadToEnd();[Console]::Out.Write('{\"ok\":true,\"protocol\":1,\"platform\":\"win32\"}')"), 0600); err != nil {
		t.Fatal(err)
	}
	manager.deps.agentPreflight = func() SshPreflight { return SshPreflight{OK: true, sshExecutable: "fake-ssh.exe"} }
	manager.deps.startAgent = func(int) (*localWorkspaceAgent, error) {
		a, err := startLocalWorkspaceAgentWithHelper(0, helper)
		if err == nil {
			agents <- a
		}
		return a, err
	}
	return agents
}
func testAgentProfile(t *testing.T, m *sshTunnelManager, s sshAccountScope) SshTunnelProfile {
	t.Helper()
	input := sshTestProfile(t)
	input.Mode = "agent"
	input.LocalPort = 18765
	p, err := m.save(s, input)
	if err != nil {
		t.Fatal(err)
	}
	return p
}
func acknowledgeAgent(t *testing.T, start fakeSshStart) {
	t.Helper()
	for i, arg := range start.args {
		if arg == "-R" {
			parts := strings.Split(start.args[i+1], ":")
			_, _ = fmt.Fprintf(start.output, "debug1: remote forward success for: listen 127.0.0.1:%s, connect 127.0.0.1:%s\n", parts[1], parts[3])
			return
		}
	}
	t.Fatal("missing forward argv")
}
func waitRegistration(t *testing.T, m *sshTunnelManager, s sshAccountScope, id, state string) SshTunnelStatus {
	t.Helper()
	deadline := time.After(3 * time.Second)
	ticker := time.NewTicker(time.Millisecond)
	defer ticker.Stop()
	for {
		status, err := m.getStatus(s, id)
		if err != nil {
			t.Fatal(err)
		}
		if status.RegistrationState == state {
			return status
		}
		select {
		case <-deadline:
			t.Fatalf("expected registration %s, got %+v", state, status)
		case <-ticker.C:
		}
	}
}

func TestSshAgentEnsureConcurrentForwardAndRegistrationAreSeparateAndPrivate(t *testing.T) {
	m, runtime := sshTestManager(t)
	s := sshTestScope(t, "account")
	agents := testAgentDependencies(t, m)
	p := testAgentProfile(t, m, s)
	registerStarted, registerRelease := make(chan struct{}, 1), make(chan struct{})
	m.deps.registerAgent = func(ctx context.Context, _ sshAccountScope, _ SshTunnelProfile, token string) error {
		if len(token) != 64 {
			t.Error("missing private native token")
		}
		registerStarted <- struct{}{}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-registerRelease:
			return nil
		}
	}
	results := make(chan error, 8)
	for i := 0; i < 8; i++ {
		go func() { _, err := m.ensure(s, p.ID, 2*time.Second); results <- err }()
	}
	a := <-agents
	started := <-runtime.starts
	select {
	case <-registerStarted:
		t.Fatal("registered before actual forward acknowledgement")
	default:
	}
	acknowledgeAgent(t, started)
	<-registerStarted
	status := waitRegistration(t, m, s, p.ID, "registering")
	if status.State != "forwarding" || !status.OuterConnected {
		t.Fatal(status)
	}
	raw, _ := json.Marshal(status)
	profiles, statuses := m.list(s)
	all, _ := json.Marshal([]any{profiles, statuses})
	if strings.Contains(string(raw), a.token) || strings.Contains(string(all), a.token) || strings.Contains(string(raw), "agentToken") {
		t.Fatal("public status leaked agent credential")
	}
	close(registerRelease)
	for i := 0; i < 8; i++ {
		if err := <-results; err != nil {
			t.Fatal(err)
		}
	}
	select {
	case <-runtime.starts:
		t.Fatal("concurrent ensures spawned twice")
	default:
	}
	_, _ = m.stop(s, p.ID)
	waitSshState(t, m, s, p.ID, "stopped")
	listener, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", a.port))
	if err != nil {
		t.Fatal("stopped preceded listener close", err)
	}
	listener.Close()
}

func TestSshAgentRegistrationRetryRetainsAgentAndGeneration(t *testing.T) {
	m, runtime := sshTestManager(t)
	s := sshTestScope(t, "account")
	agents := testAgentDependencies(t, m)
	p := testAgentProfile(t, m, s)
	var attempts atomic.Int32
	m.deps.registerAgent = func(context.Context, sshAccountScope, SshTunnelProfile, string) error {
		if attempts.Add(1) == 1 {
			return errors.New("secret token must not reach status")
		}
		return nil
	}
	result := make(chan error, 1)
	go func() { _, err := m.ensure(s, p.ID, 2*time.Second); result <- err }()
	<-agents
	start := <-runtime.starts
	acknowledgeAgent(t, start)
	if err := <-result; err == nil {
		t.Fatal("registration error became success")
	}
	first := waitRegistration(t, m, s, p.ID, "error")
	if strings.Contains(first.RegistrationError, "secret") {
		t.Fatal("unsafe registration error")
	}
	status, err := m.ensure(s, p.ID, time.Second)
	if err != nil || status.Generation != first.Generation || attempts.Load() != 2 {
		t.Fatal(status, err, attempts.Load())
	}
	select {
	case <-agents:
		t.Fatal("registration retry restarted Agent")
	case <-runtime.starts:
		t.Fatal("registration retry restarted tunnel")
	default:
	}
}

func TestSshAgentNetworkRetryKeepsTokenAndStopCancelsBackoff(t *testing.T) {
	m, runtime := sshTestManager(t)
	s := sshTestScope(t, "account")
	agents := testAgentDependencies(t, m)
	p := testAgentProfile(t, m, s)
	backoff := make(chan time.Time)
	delays := make(chan time.Duration, 8)
	m.deps.after = func(d time.Duration) <-chan time.Time {
		if d == 20*time.Second {
			return make(chan time.Time)
		}
		delays <- d
		return backoff
	}
	var tokens []string
	var mu sync.Mutex
	m.deps.registerAgent = func(_ context.Context, _ sshAccountScope, _ SshTunnelProfile, token string) error {
		mu.Lock()
		tokens = append(tokens, token)
		mu.Unlock()
		return nil
	}
	_, _ = m.start(s, p.ID)
	a := <-agents
	first := <-runtime.starts
	acknowledgeAgent(t, first)
	waitRegistration(t, m, s, p.ID, "registered")
	first.process.exit(errors.New("network"))
	status := waitSshState(t, m, s, p.ID, "reconnecting")
	if status.ReconnectAttempt != 1 || status.OuterConnected {
		t.Fatal(status)
	}
	if d := <-delays; d != time.Second {
		t.Fatal(d)
	}
	backoff <- time.Now()
	second := <-runtime.starts
	acknowledgeAgent(t, second)
	waitRegistration(t, m, s, p.ID, "registered")
	mu.Lock()
	same := len(tokens) == 2 && tokens[0] == tokens[1] && tokens[0] == a.token
	mu.Unlock()
	if !same {
		t.Fatal("network retry rotated private Agent")
	}
	second.process.exit(errors.New("network"))
	waitSshState(t, m, s, p.ID, "reconnecting")
	<-delays
	_, _ = m.stop(s, p.ID)
	waitSshState(t, m, s, p.ID, "stopped")
	select {
	case <-runtime.starts:
		t.Fatal("stop left retry alive")
	default:
	}
}

func TestSshAgentPermanentAuthenticationFailureDoesNotRetry(t *testing.T) {
	for _, diagnostic := range []string{"Host key verification failed.", "Permission denied (publickey)."} {
		t.Run(diagnostic, func(t *testing.T) {
			m, r := sshTestManager(t)
			s := sshTestScope(t, "a")
			testAgentDependencies(t, m)
			p := testAgentProfile(t, m, s)
			_, _ = m.start(s, p.ID)
			start := <-r.starts
			_, _ = io.WriteString(start.output, diagnostic+"\n")
			start.process.exit(errors.New("ssh"))
			waitSshState(t, m, s, p.ID, "error")
			select {
			case <-r.starts:
				t.Fatal("permanent failure retried")
			default:
			}
		})
	}
}

func TestSshAgentTimeoutIsNotSuccessAndPreflightDoesNotBlockStop(t *testing.T) {
	m, r := sshTestManager(t)
	s := sshTestScope(t, "a")
	testAgentDependencies(t, m)
	p := testAgentProfile(t, m, s)
	_, err := m.ensure(s, p.ID, 20*time.Millisecond)
	if err == nil || sshErrorResponse(err)["code"] != "SSH_AGENT_READY_TIMEOUT" {
		t.Fatal(err)
	}
	start := <-r.starts
	_, _ = m.stop(s, p.ID)
	<-start.process.killed
	waitSshState(t, m, s, p.ID, "stopped")
	entered, release := make(chan struct{}), make(chan struct{})
	m.deps.agentPreflight = func() SshPreflight { close(entered); <-release; return SshPreflight{OK: true} }
	_, _ = m.start(s, p.ID)
	<-entered
	stopped := make(chan struct{})
	go func() { m.stopAll(false); close(stopped) }()
	select {
	case <-stopped:
	case <-time.After(time.Second):
		t.Fatal("stop blocked on preflight under lifecycle lock")
	}
	close(release)
	waitSshState(t, m, s, p.ID, "stopped")
}

func TestSshRelayDefaultNeedsNoLegacyReferencesAndEnsuresOneAccountRegistration(t *testing.T) {
	var registered atomic.Int32
	pollEntered := make(chan struct{}, 1)
	var tokenMu sync.Mutex
	privateToken := ""
	connection := accountWorkspaceFixture(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer header.payload.signature" {
			t.Error("native account auth missing")
		}
		switch r.URL.Path {
		case "/api/ssh-workspaces/agent/connections":
			var body map[string]any
			json.NewDecoder(r.Body).Decode(&body)
			if body["delivery"] != "relay" || body["port"] != float64(18766) {
				t.Error(body)
			}
			tokenMu.Lock()
			privateToken, _ = body["token"].(string)
			tokenMu.Unlock()
			registered.Add(1)
			writeAgentJSON(w, 200, map[string]any{"ok": true, "connection": map[string]any{"id": body["id"], "port": body["port"], "transport": "agent"}})
		case "/api/ssh-workspaces/agent/relay/poll":
			tokenMu.Lock()
			matches := privateToken != "" && r.Header.Get("X-Chisa-Agent-Token") == privateToken
			tokenMu.Unlock()
			if !matches {
				t.Error("relay private auth missing")
			}
			if r.URL.Query().Get("wait") == "0" {
				writeAgentJSON(w, 200, map[string]any{"ready": true, "jobs": []any{}})
				return
			}
			select {
			case pollEntered <- struct{}{}:
			default:
			}
			<-r.Context().Done()
		default:
			t.Error("unexpected endpoint", r.URL.Path)
		}
	})
	_ = connection
	m, _ := sshTestManager(t)
	preserveDesktopSshManager(t, m)
	testAgentDependencies(t, m)
	m.deps.preflight = func() SshPreflight { t.Error("relay used system SSH"); return SshPreflight{} }
	if response := (FrontendBridge{}).GetSshTunnelProfiles(); len(response["profiles"].([]SshTunnelProfile)) != 0 {
		t.Fatal("inert list seeded profiles")
	}
	var wg sync.WaitGroup
	responses := make(chan map[string]any, 6)
	for i := 0; i < 6; i++ {
		wg.Add(1)
		go func() { defer wg.Done(); responses <- (FrontendBridge{}).EnsureSshAgent("") }()
	}
	wg.Wait()
	close(responses)
	var profile SshTunnelProfile
	for response := range responses {
		if response["ok"] != true {
			t.Fatal(response)
		}
		profile = response["profile"].(SshTunnelProfile)
		status := response["status"].(SshTunnelStatus)
		if !status.OuterConnected || status.RegistrationState != "registered" || profile.AgentTransport != "relay" || profile.KeyPath != "" {
			t.Fatal(response)
		}
	}
	if registered.Load() != 1 {
		t.Fatal("duplicate native registration", registered.Load())
	}
	<-pollEntered
	(FrontendBridge{}).StopSshTunnel(profile.ID)
	waitSshState(t, m, mustSshScope(t), profile.ID, "stopped")
}
func TestSshAgentRegistrationBodyTimeoutIsNotAccountChange(t *testing.T) {
	release := make(chan struct{})
	accountWorkspaceFixture(t, func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(200)
		w.(http.Flusher).Flush()
		select {
		case <-r.Context().Done():
		case <-release:
		}
	})
	t.Cleanup(func() { close(release) })
	scope := mustSshScope(t)
	ctx, cancel := context.WithTimeout(scope.ctx, 30*time.Millisecond)
	defer cancel()
	err := registerSshAgent(ctx, scope, SshTunnelProfile{SshTunnelProfileInput: SshTunnelProfileInput{ID: strings.Repeat("a", 32), Name: "Agent", RemotePort: 18766, AgentTransport: "relay"}}, strings.Repeat("b", 64))
	if err == nil || sshErrorResponse(err)["code"] != "SSH_AGENT_REGISTRATION_FAILED" {
		t.Fatal(err)
	}
	if scope.ctx.Err() != nil {
		t.Fatal("registration body timeout revoked account")
	}
}

func mustSshScope(t *testing.T) sshAccountScope {
	t.Helper()
	s, err := currentSshAccount()
	if err != nil {
		t.Fatal(err)
	}
	return s
}
