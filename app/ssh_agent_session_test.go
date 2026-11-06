package main

import (
	"context"
	"net/http"
	"reflect"
	"strings"
	"testing"
	"time"
)

func testSshAgentSession(t *testing.T) *sshAgentSession {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	entry := &sshTunnelEntry{
		ctx: ctx, cancel: cancel, scope: sshAccountScope{ctx: ctx},
		profile: SshTunnelProfile{SshTunnelProfileInput: SshTunnelProfileInput{ID: strings.Repeat("a", 32)}},
		agent:   &localWorkspaceAgent{token: strings.Repeat("b", 64)},
		status:  SshTunnelStatus{State: "starting", Generation: 1},
		changed: make(chan struct{}), retryRegistration: make(chan struct{}, 1),
	}
	manager := &sshTunnelManager{deps: sshTunnelDependencies{
		registerAgent: func(context.Context, sshAccountScope, SshTunnelProfile, string) error { return nil },
		after: func(time.Duration) <-chan time.Time {
			ready := make(chan time.Time, 1)
			ready <- time.Now()
			return ready
		},
	}}
	session := newSshAgentSession(manager, entry)
	session.jitter = func(ceiling time.Duration) time.Duration { return ceiling }
	return session
}

func TestSshAgentSessionRetriesRegistrationAndHandshakeWithoutUserOrAgentReplacement(t *testing.T) {
	session := testSshAgentSession(t)
	agent := session.entry.agent
	var registered, handshakes int
	var delays []time.Duration
	session.manager.deps.registerAgent = func(ctx context.Context, _ sshAccountScope, _ SshTunnelProfile, token string) error {
		registered++
		if token != agent.token {
			t.Fatal("network recovery changed Agent token")
		}
		if deadline, ok := ctx.Deadline(); !ok || time.Until(deadline) > 12*time.Second {
			t.Fatal("registration attempt has no bounded deadline")
		}
		if registered == 1 {
			return sshFailure("SSH_AGENT_REGISTRATION_FAILED", "temporary registration outage")
		}
		return nil
	}
	after := session.manager.deps.after
	session.manager.deps.after = func(delay time.Duration) <-chan time.Time {
		delays = append(delays, delay)
		if status := session.entry.status; status.State != "reconnecting" || status.RegistrationState != "registering" || status.RegistrationError != "" {
			t.Fatal("retry published a terminal registration failure", status)
		}
		return after(delay)
	}
	err := session.connect(func(ctx context.Context) error {
		handshakes++
		if deadline, ok := ctx.Deadline(); !ok || time.Until(deadline) > 12*time.Second {
			t.Fatal("handshake attempt has no bounded deadline")
		}
		if handshakes == 1 {
			return sshFailure("SSH_AGENT_RELAY_HANDSHAKE_FAILED", "temporary handshake outage")
		}
		return nil
	})
	if err != nil || registered != 3 || handshakes != 2 || !reflect.DeepEqual(delays, []time.Duration{time.Second, 2 * time.Second}) {
		t.Fatal("registration/handshake did not recover automatically", registered, handshakes, delays, err)
	}
	status := session.entry.status
	if session.entry.agent != agent || session.failures != 0 || status.ReconnectAttempt != 0 || status.State != "forwarding" || !status.OuterConnected || status.RegistrationState != "registered" {
		t.Fatal("recovery did not retain ownership and reset status", status)
	}
}

func TestSshAgentSessionBackoffCapsAndResetsAfterSuccess(t *testing.T) {
	session := testSshAgentSession(t)
	var delays []time.Duration
	after := session.manager.deps.after
	session.manager.deps.after = func(delay time.Duration) <-chan time.Time {
		delays = append(delays, delay)
		return after(delay)
	}
	failure := sshFailure("SSH_AGENT_RELAY_UNAVAILABLE", "network unavailable")
	for range 6 {
		if err := session.wait(failure); err != nil {
			t.Fatal(err)
		}
	}
	session.ready()
	if err := session.wait(failure); err != nil {
		t.Fatal(err)
	}
	want := []time.Duration{time.Second, 2 * time.Second, 4 * time.Second, 8 * time.Second, 8 * time.Second, 8 * time.Second, time.Second}
	if !reflect.DeepEqual(delays, want) || session.entry.status.ReconnectAttempt != 1 {
		t.Fatal("isolated failures accumulated across successful polls", delays, session.entry.status)
	}
}

func TestSshAgentSessionJitterAlwaysWithinBoundedLivenessBudget(t *testing.T) {
	for _, ceiling := range []time.Duration{time.Second, 2 * time.Second, 4 * time.Second, 8 * time.Second} {
		session := testSshAgentSession(t)
		jitter := newSshAgentSession(session.manager, session.entry).jitter
		for range 100 {
			if delay := jitter(ceiling); delay < ceiling/2 || delay > ceiling {
				t.Fatal("jitter exceeded reconnect bounds", ceiling, delay)
			}
		}
	}
}

func TestSshAgentSessionStopCancelsRegistrationBackoff(t *testing.T) {
	session := testSshAgentSession(t)
	waiting := make(chan struct{})
	never := make(chan time.Time)
	session.manager.deps.registerAgent = func(context.Context, sshAccountScope, SshTunnelProfile, string) error {
		return sshFailure("SSH_AGENT_REGISTRATION_FAILED", "network unavailable")
	}
	session.manager.deps.after = func(time.Duration) <-chan time.Time { close(waiting); return never }
	finished := make(chan error, 1)
	go func() {
		finished <- session.connect(func(context.Context) error { t.Error("failed registration reached handshake"); return nil })
	}()
	<-waiting
	session.entry.cancel()
	select {
	case err := <-finished:
		if code, _ := sshErrorFields(err); code != "SSH_ACCOUNT_CHANGED" {
			t.Fatal("account cancellation lost its identity fence", err)
		}
	case <-time.After(time.Second):
		t.Fatal("stop did not cancel native reconnect backoff")
	}
}

func TestSshAgentSessionExplicitRetryWakesNativeBackoff(t *testing.T) {
	session := testSshAgentSession(t)
	waiting := make(chan struct{})
	never := make(chan time.Time)
	session.manager.deps.after = func(time.Duration) <-chan time.Time { close(waiting); return never }
	finished := make(chan error, 1)
	go func() { finished <- session.wait(sshFailure("SSH_AGENT_RELAY_UNAVAILABLE", "network unavailable")) }()
	<-waiting
	session.entry.retryRegistration <- struct{}{}
	select {
	case err := <-finished:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("explicit retry did not wake native reconnect backoff")
	}
}

func TestSshAgentSessionDistinguishesAccountRevocationFromLostBrokerRegistration(t *testing.T) {
	for _, code := range []string{"SSH_ACCOUNT_CHANGED", "SSH_ACCOUNT_REQUIRED", "SSH_AGENT_RELAY_AUTH_FAILED"} {
		t.Run(code, func(t *testing.T) {
			session := testSshAgentSession(t)
			session.manager.deps.after = func(time.Duration) <-chan time.Time { t.Error("revoked account retried"); return nil }
			failure := sshFailure(code, "account revoked")
			if err := session.wait(failure); err != failure {
				t.Fatal("account revocation did not terminate recovery", err)
			}
		})
	}
	session := testSshAgentSession(t)
	failure := sshFailure("SSH_AGENT_REGISTRATION_REQUIRED", "broker lost registration")
	if err := session.wait(failure); err != failure || session.failures != 0 {
		t.Fatal("lost broker registration did not request reconnect", err)
	}
	attempts := 0
	session.manager.deps.registerAgent = func(context.Context, sshAccountScope, SshTunnelProfile, string) error {
		attempts++
		if attempts == 1 {
			return failure
		}
		return nil
	}
	if err := session.connect(func(context.Context) error { return nil }); err != nil || attempts != 2 {
		t.Fatal("lost broker registration did not recover automatically", attempts, err)
	}
}

func TestSshAgentRegistrationUsesHTTPAuthClassification(t *testing.T) {
	cases := []struct {
		name      string
		header    string
		body      string
		rotateJWT bool
		code      string
	}{
		{"raw gateway denial", "", `<html>unauthorized</html>`, false, "SSH_AGENT_RELAY_UNAVAILABLE"},
		{"revoked account", "invalid-token", `{"code":"AUTH_TOKEN_INVALID"}`, false, "SSH_AGENT_RELAY_AUTH_FAILED"},
		{"old credential reply", "session-expired", `{"code":"AUTH_TOKEN_EXPIRED"}`, true, "SSH_AGENT_RELAY_UNAVAILABLE"},
		{"lost broker registration", "", `{"error":{"code":"AGENT_UNAUTHORIZED"}}`, false, "SSH_AGENT_REGISTRATION_REQUIRED"},
	}
	for _, item := range cases {
		t.Run(item.name, func(t *testing.T) {
			var connection *serverConnection
			connection = accountWorkspaceFixture(t, func(writer http.ResponseWriter, request *http.Request) {
				if item.rotateJWT {
					serverConnectionMu.Lock()
					connection.accessToken = "refreshed.payload.signature"
					serverConnectionMu.Unlock()
				}
				writer.Header().Set("X-Auth-Error", item.header)
				writer.WriteHeader(http.StatusUnauthorized)
				_, _ = writer.Write([]byte(item.body))
			})
			scope := mustSshScope(t)
			profile := SshTunnelProfile{SshTunnelProfileInput: SshTunnelProfileInput{ID: strings.Repeat("a", 32), AgentTransport: "relay"}}
			err := registerSshAgent(scope.ctx, scope, profile, strings.Repeat("b", 64))
			if code, _ := sshErrorFields(err); code != item.code {
				t.Fatal("registration used wrong recovery path", code, item.code)
			}
		})
	}
}

func TestSshAgentHTTPFailureClassifiesCredentialEpochAndProxyResponses(t *testing.T) {
	cases := []struct {
		name    string
		status  int
		header  string
		body    string
		current string
		code    string
	}{
		{"success", 200, "", `{"ok":true}`, "old", ""},
		{"expired current JWT", 401, "session-expired", `{"code":"AUTH_TOKEN_EXPIRED"}`, "old", "SSH_AGENT_RELAY_AUTH_FAILED"},
		{"invalid current JWT", 401, "invalid-token", `{"code":"AUTH_TOKEN_INVALID"}`, "old", "SSH_AGENT_RELAY_AUTH_FAILED"},
		{"expired captured JWT refreshed while pending", 401, "session-expired", `{"code":"AUTH_TOKEN_EXPIRED"}`, "new", "SSH_AGENT_RELAY_UNAVAILABLE"},
		{"broker denial", 401, "", `{"error":{"code":"AGENT_UNAUTHORIZED"}}`, "old", "SSH_AGENT_REGISTRATION_REQUIRED"},
		{"top level broker denial with string message", 401, "", `{"code":"AGENT_UNAUTHORIZED","error":"Agent denied"}`, "old", "SSH_AGENT_REGISTRATION_REQUIRED"},
		{"proxy unauthorized", 401, "", `<html>unauthorized</html>`, "old", "SSH_AGENT_RELAY_UNAVAILABLE"},
		{"proxy forbidden", 403, "", `<html>forbidden</html>`, "old", "SSH_AGENT_RELAY_UNAVAILABLE"},
		{"unknown auth header", 401, "proxy-error", `{}`, "old", "SSH_AGENT_RELAY_UNAVAILABLE"},
		{"gateway unavailable", 503, "", `<html>unavailable</html>`, "old", "SSH_AGENT_RELAY_UNAVAILABLE"},
		{"overlapping old poll", 409, "", `{"error":{"code":"AGENT_RELAY_POLL_IN_PROGRESS"}}`, "old", "SSH_AGENT_RELAY_UNAVAILABLE"},
	}
	for _, item := range cases {
		t.Run(item.name, func(t *testing.T) {
			headers := make(http.Header)
			headers.Set("X-Auth-Error", item.header)
			err := sshAgentHTTPFailure(item.status, headers, []byte(item.body), "old", item.current)
			if item.code == "" {
				if err != nil {
					t.Fatal(err)
				}
				return
			}
			if code, _ := sshErrorFields(err); code != item.code {
				t.Fatal("wrong authentication recovery path", code, item.code)
			}
		})
	}
}
