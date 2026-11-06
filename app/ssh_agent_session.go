package main

import (
	"context"
	"encoding/json"
	"log"
	"math/rand/v2"
	"net/http"
	"time"
)

// sshAgentSession owns recovery for one captured account and local Agent. Network
// failures never rotate the Agent token or require a mounted WebView to retry.
// The receive loop calls connect again when the broker loses its registration.
type sshAgentSession struct {
	manager  *sshTunnelManager
	entry    *sshTunnelEntry
	failures int
	stage    string
	jitter   func(time.Duration) time.Duration
}

func newSshAgentSession(manager *sshTunnelManager, entry *sshTunnelEntry) *sshAgentSession {
	return &sshAgentSession{
		manager: manager,
		entry:   entry,
		jitter: func(ceiling time.Duration) time.Duration {
			// Equal jitter keeps retries bounded and avoids synchronized desktop
			// reconnects after a gateway outage. The ceiling never exceeds 8s.
			return ceiling/2 + time.Duration(rand.Int64N(int64(ceiling/2)+1))
		},
	}
}

func (session *sshAgentSession) contextFailure() error {
	if session.entry.scope.ctx != nil && session.entry.scope.ctx.Err() != nil {
		return sshFailure("SSH_ACCOUNT_CHANGED", "账号连接已改变，Agent 连接已取消。")
	}
	return session.entry.ctx.Err()
}

// connect retries the idempotent account registration and authenticated
// handshake together. Neither timeout is the lifetime of the owned local Agent.
func (session *sshAgentSession) connect(handshake func(context.Context) error) error {
	for {
		if err := session.contextFailure(); err != nil {
			return err
		}
		state := "starting"
		if session.failures > 0 {
			state = "reconnecting"
		}
		session.stage = "register"
		session.manager.relayStatus(session.entry, state, "registering", "", "正在登记账号的本地 Agent。", session.failures)
		log.Printf("[agent-relay] event=connect profile=%s stage=register attempt=%d", session.entry.profile.ID, session.failures+1)
		ctx, cancel := context.WithTimeout(session.entry.ctx, 12*time.Second)
		err := session.manager.deps.registerAgent(ctx, session.entry.scope, session.entry.profile, session.entry.agent.token)
		cancel()
		if err == nil {
			session.stage = "handshake"
			log.Printf("[agent-relay] event=connect profile=%s stage=handshake attempt=%d", session.entry.profile.ID, session.failures+1)
			ctx, cancel = context.WithTimeout(session.entry.ctx, 12*time.Second)
			err = handshake(ctx)
			cancel()
		}
		if err == nil {
			if err = session.contextFailure(); err != nil {
				return err
			}
			session.ready()
			return nil
		}
		if err := session.recover(err, "registering"); err != nil {
			return err
		}
	}
}

// wait handles a failed established-session request. A missing broker session
// must return to connect, whereas network errors can keep the same registration.
func (session *sshAgentSession) wait(failure error) error {
	if err := session.contextFailure(); err != nil {
		return err
	}
	session.stage = "poll"
	code, _ := sshErrorFields(failure)
	if code == "SSH_AGENT_REGISTRATION_REQUIRED" {
		log.Printf("[agent-relay] event=registration-required profile=%s stage=poll code=%s attempt=%d", session.entry.profile.ID, code, session.failures)
		return failure
	}
	return session.recover(failure, "registered")
}

func (session *sshAgentSession) recover(failure error, registration string) error {
	if err := session.contextFailure(); err != nil {
		return err
	}
	code, message := sshErrorFields(failure)
	if code == "SSH_ACCOUNT_CHANGED" || code == "SSH_ACCOUNT_REQUIRED" || code == "SSH_AGENT_RELAY_AUTH_FAILED" {
		log.Printf("[agent-relay] event=account-revoked profile=%s stage=%s code=%s attempt=%d", session.entry.profile.ID, session.stage, code, session.failures)
		return failure
	}
	session.failures++
	ceiling := time.Second << min(session.failures-1, 3)
	delay := session.jitter(ceiling)
	// Keep the injected clock/jitter testable without allowing an accidental
	// zero-delay retry loop or a delay beyond the native liveness budget.
	delay = max(ceiling/2, min(delay, ceiling))
	log.Printf("[agent-relay] event=reconnect profile=%s stage=%s code=%s attempt=%d delay=%s", session.entry.profile.ID, session.stage, code, session.failures, delay)
	session.manager.relayStatus(session.entry, "reconnecting", registration, code, message, session.failures)
	select {
	case <-session.entry.ctx.Done():
		return session.contextFailure()
	case <-session.entry.retryRegistration:
		return session.contextFailure()
	case <-session.manager.deps.after(delay):
		return session.contextFailure()
	}
}

func (session *sshAgentSession) ready() {
	if session.failures > 0 {
		log.Printf("[agent-relay] event=recovered profile=%s stage=%s attempts=%d", session.entry.profile.ID, session.stage, session.failures)
	}
	session.failures = 0
	session.manager.relayStatus(session.entry, "forwarding", "registered", "", "账号 Agent 中继已连接；项目目录仍需独立验证。", 0)
}

// Account JWT failures and broker Agent authentication have different recovery
// paths. A gateway's raw 401/403 is not proof that the account was revoked, and a
// response for an older token cannot revoke a newer credential on this account.
func sshAgentHTTPFailure(status int, headers http.Header, body []byte, capturedToken, currentToken string) error {
	if status >= 200 && status < 300 {
		return nil
	}
	if status == http.StatusUnauthorized || status == http.StatusForbidden {
		if capturedToken != currentToken {
			return sshFailure("SSH_AGENT_RELAY_UNAVAILABLE", "账号凭据已刷新，正在恢复 Agent 连接。")
		}
		authError := headers.Get("X-Auth-Error")
		if authError == "invalid-token" || authError == "session-expired" {
			return sshFailure("SSH_AGENT_RELAY_AUTH_FAILED", "账号登录已失效，请重新登录。")
		}
		var result struct {
			Code  string          `json:"code"`
			Error json.RawMessage `json:"error"`
		}
		var nested struct {
			Code string `json:"code"`
		}
		// Only a structured broker denial means the Agent registration must be
		// restored. HTML proxy errors and unrelated denials retry the transport.
		if json.Unmarshal(body, &result) == nil {
			_ = json.Unmarshal(result.Error, &nested)
			if result.Code == "AGENT_UNAUTHORIZED" || nested.Code == "AGENT_UNAUTHORIZED" {
				return sshFailure("SSH_AGENT_REGISTRATION_REQUIRED", "账号 Agent 登记已失效，正在重新登记。")
			}
		}
	}
	return sshFailure("SSH_AGENT_RELAY_UNAVAILABLE", "Agent 中继暂时无法连接，正在重连。")
}
