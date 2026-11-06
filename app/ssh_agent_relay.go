package main

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/url"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

type agentRelayJob struct {
	RequestID  string          `json:"requestId"`
	Payload    json.RawMessage `json:"payload"`
	DeadlineAt int64           `json:"deadlineAt,omitempty"`
}
type agentRelayPoll struct {
	Ready        bool            `json:"ready"`
	Jobs         []agentRelayJob `json:"jobs"`
	Protocol     int             `json:"protocol,omitempty"`
	Epoch        string          `json:"epoch,omitempty"`
	Capabilities *struct {
		Events int `json:"events,omitempty"`
	} `json:"capabilities,omitempty"`
}
type agentRelayResponse struct {
	Status int    `json:"status"`
	Body   string `json:"body"`
}

type agentRelayResultBudget struct {
	mu    sync.Mutex
	bytes int
}

func (b *agentRelayResultBudget) reserve(n int) bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	if n > 24*1024*1024-b.bytes {
		return false
	}
	b.bytes += n
	return true
}
func (b *agentRelayResultBudget) release(n int) { b.mu.Lock(); b.bytes -= n; b.mu.Unlock() }
func relayControlPayload(payload []byte) bool {
	var envelope struct {
		Request struct {
			Op string `json:"op"`
		} `json:"request"`
	}
	if json.Unmarshal(payload, &envelope) != nil {
		return false
	}
	op := envelope.Request.Op
	return op == "job_status" || op == "job_cancel" || op == "job_output" || op == "operation_status" || op == "operation_cancel"
}

// All requests retain the captured account/client. Token refresh may update the
// credential snapshot; identity/version changes revoke the owning SSH context.
func sshAgentServiceRequest(ctx context.Context, scope sshAccountScope, agentToken, method, path string, payload []byte, limit int64) ([]byte, error) {
	serverConnectionMu.RLock()
	c := scope.connection
	current := c != nil && apiConnection == c && c.authenticated && c.accountIdentity == scope.identity && c.version == scope.version && scope.ctx.Err() == nil && c.ctx.Err() == nil
	accessToken := ""
	var revision uint64
	if current {
		accessToken, revision = c.accessToken, c.tokenRevision
	}
	serverConnectionMu.RUnlock()
	if !current || accessToken == "" {
		return nil, sshFailure("SSH_ACCOUNT_CHANGED", "账号连接已改变，Agent 连接已取消。")
	}
	request, err := http.NewRequestWithContext(ctx, method, strings.TrimRight(c.baseURL, "/")+path, bytes.NewReader(payload))
	if err != nil {
		return nil, sshFailure("SSH_AGENT_RELAY_INVALID", "无法创建 Agent 中继请求。")
	}
	request.Header.Set("Authorization", "Bearer "+accessToken)
	request.Header.Set("X-Chisa-Agent-Token", agentToken)
	if payload != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	response, err := c.client.Do(request)
	if err != nil {
		return nil, sshFailure("SSH_AGENT_RELAY_UNAVAILABLE", "Agent 中继暂时无法连接，正在重连。")
	}
	defer response.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(response.Body, limit+1))
	serverConnectionMu.Lock()
	defer serverConnectionMu.Unlock()
	if apiConnection != c || !c.authenticated || c.accountIdentity != scope.identity || c.version != scope.version || scope.ctx.Err() != nil {
		return nil, sshFailure("SSH_ACCOUNT_CHANGED", "账号连接已改变，Agent 连接已取消。")
	}
	if ctx.Err() != nil {
		return nil, sshFailure("SSH_AGENT_RELAY_UNAVAILABLE", "Agent 中继请求超时或中断，正在重连。")
	}
	// Accept refresh headers only after a complete bounded response; a
	// recognized 401 can still revoke exactly its captured credential revision.
	if response.StatusCode != http.StatusUnauthorized && (err != nil || len(raw) > int(limit)) {
		return nil, sshFailure("SSH_AGENT_RELAY_UNAVAILABLE", "Agent 中继连接中断，正在重连。")
	}
	if saveErr := recordNativeRefreshedToken(c, response.Header, response.StatusCode, accessToken, revision); saveErr != nil {
		return nil, sshFailure("SESSION_SAVE_FAILED", "账号凭据未保存，请重试。")
	}
	if failure := sshAgentHTTPFailure(response.StatusCode, response.Header, raw, accessToken, c.accessToken); failure != nil {
		return nil, failure
	}
	if err != nil || len(raw) > int(limit) || response.StatusCode != http.StatusOK {
		return nil, sshFailure("SSH_AGENT_RELAY_UNAVAILABLE", "Agent 中继连接中断，正在重连。")
	}
	return raw, nil
}

func (m *sshTunnelManager) relayStatus(entry *sshTunnelEntry, state, registration, code, message string, attempt int) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if entry.ctx.Err() != nil || entry.status.State == "stopping" {
		return
	}
	entry.status.State, entry.status.RegistrationState = state, registration
	entry.status.OuterConnected = state == "forwarding"
	entry.status.Code, entry.status.Message, entry.status.ReconnectAttempt = code, message, attempt
	if registration != "error" {
		entry.status.RegistrationError = ""
	} else {
		entry.status.RegistrationError = message
	}
	m.notifyLocked(entry)
}

func (m *sshTunnelManager) runRelay(entry *sshTunnelEntry) (string, string) {
	ctx := entry.ctx
	agent, err := m.deps.startAgent(0)
	if err != nil {
		return "SSH_AGENT_START_FAILED", "无法启动本地工作区 Agent。"
	}
	entry.agent = agent
	localTransport := &http.Transport{Proxy: nil, DialContext: (&net.Dialer{Timeout: 5 * time.Second}).DialContext, DisableKeepAlives: true}
	localClient := &http.Client{Transport: localTransport, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	defer localTransport.CloseIdleConnections()
	var jobs sync.WaitGroup
	defer func() { entry.cancel(); jobs.Wait() }()
	// Poll is at-most-once at the broker. This cache additionally rejects any
	// repeated request ID without ever resending the local workspace operation.
	seen := map[string]bool{}
	// Match the broker's 32 regular / 4 control pending-request limits. These
	// are HTTP forwarding slots; the local Agent separately bounds helper work
	// and returns AGENT_BUSY per request rather than disconnecting this relay.
	regularSlots, controlSlots := make(chan struct{}, 32), make(chan struct{}, 4)
	// Result delivery can outlive local execution: the broker accepts a result
	// before its HTTP acknowledgement reaches this client. Bound that backlog
	// separately so slow acknowledgements neither consume execution slots nor
	// permit unbounded delivery goroutines (including small error responses).
	// Allow one complete broker-sized execution batch plus one batch whose
	// results were accepted but whose acknowledgements are still in flight.
	regularDeliveries, controlDeliveries := make(chan struct{}, 64), make(chan struct{}, 8)
	resultBudget := &agentRelayResultBudget{}
	registered := false
	session := newSshAgentSession(m, entry)
	var protocol int
	var runtime *sshRelayRuntime
	var heartbeatCancel context.CancelFunc
	var heartbeatDone chan struct{}
	defer func() {
		entry.cancel()
		if heartbeatCancel != nil {
			heartbeatCancel()
			<-heartbeatDone
		}
		if runtime != nil {
			runtime.close()
		}
	}()
	handshake := func(handshakeCtx context.Context) error {
		raw, failure := sshAgentServiceRequest(handshakeCtx, entry.scope, agent.token, http.MethodGet, "/api/ssh-workspaces/agent/relay/poll?connectionId="+url.QueryEscape(entry.profile.ID)+"&wait=0&protocol=2", nil, 64*1024)
		if failure != nil {
			return failure
		}
		var reply agentRelayPoll
		if json.Unmarshal(raw, &reply) != nil || !reply.Ready || len(reply.Jobs) != 0 {
			return sshFailure("SSH_AGENT_RELAY_HANDSHAKE_FAILED", "无法确认账号 Agent 中继已就绪，正在重新连接。")
		}
		if reply.Protocol == 2 {
			if validateRelayEpoch(reply.Epoch) != nil {
				return sshFailure("SSH_AGENT_RELAY_INVALID", "Agent 中继会话身份无效。")
			}
			if runtime == nil {
				journal, failure := newRelayJournal(filepath.Join(filepath.Dir(m.path), "agent-relay-journal-v2", entry.scope.binding, entry.profile.ID))
				if failure != nil {
					return sshFailure("SSH_AGENT_RELAY_STORAGE_UNAVAILABLE", "无法安全保存 Agent 任务收据，正在等待本地存储恢复。")
				}
				runtime = newSshRelayRuntime(m, entry, localClient, journal)
				heartbeatCtx, stop := context.WithCancel(ctx)
				heartbeatCancel, heartbeatDone = stop, make(chan struct{})
				go func() { defer close(heartbeatDone); runtime.heartbeat(heartbeatCtx) }()
			}
			runtime.setEpoch(reply.Epoch)
			runtime.setEventsEnabled(reply.Capabilities != nil && reply.Capabilities.Events > 0)
			runtime.resume(reply.Epoch)
		} else if runtime != nil {
			return sshFailure("SSH_AGENT_RELAY_INVALID", "Agent 服务协议已改变，正在重新协商。")
		}
		protocol = reply.Protocol
		return nil
	}
	for {
		if ctx.Err() != nil {
			return "", "Agent 已停止。"
		}
		if !registered {
			if failure := session.connect(handshake); failure != nil {
				return sshErrorFields(failure)
			}
			registered = true
		}
		path := "/api/ssh-workspaces/agent/relay/poll?connectionId=" + url.QueryEscape(entry.profile.ID)
		if protocol == 2 {
			path += "&protocol=2"
		}
		var raw []byte
		var pollErr error
		if runtime != nil {
			raw, pollErr = runtime.receive(ctx, path)
		} else {
			pollCtx, cancel := context.WithTimeout(ctx, 32*time.Second)
			raw, pollErr = sshAgentServiceRequest(pollCtx, entry.scope, agent.token, http.MethodGet, path, nil, 50*1024*1024)
			cancel()
		}
		var poll agentRelayPoll
		if pollErr == nil && (json.Unmarshal(raw, &poll) != nil || !poll.Ready || len(poll.Jobs) > 4) {
			pollErr = sshFailure("SSH_AGENT_RELAY_INVALID", "账号 Agent 中继响应无效。")
		}
		if pollErr != nil {
			if ctx.Err() != nil {
				return "", "Agent 已停止。"
			}
			if failure := session.wait(pollErr); failure != nil {
				code, _ := sshErrorFields(failure)
				if code == "SSH_AGENT_REGISTRATION_REQUIRED" {
					registered = false
					continue
				}
				return sshErrorFields(failure)
			}
			continue
		}
		if protocol == 2 && (poll.Protocol != 2 || validateRelayEpoch(poll.Epoch) != nil) {
			registered = false
			if failure := session.wait(sshFailure("SSH_AGENT_RELAY_INVALID", "Agent 中继响应不完整，正在重新协商。")); failure != nil {
				return sshErrorFields(failure)
			}
			continue
		}
		if protocol == 2 {
			runtime.setEpoch(poll.Epoch)
			runtime.setEventsEnabled(poll.Capabilities != nil && poll.Capabilities.Events > 0)
		}
		session.ready()
		for _, job := range poll.Jobs {
			if job.RequestID == "" || len(job.RequestID) > 128 || len(job.Payload) > 12*1024*1024 || !json.Valid(job.Payload) {
				return "SSH_AGENT_RELAY_INVALID", "账号 Agent 中继任务无效。"
			}
			if protocol == 2 {
				runtime.admit(poll.Epoch, job)
				continue
			}
			if seen[job.RequestID] {
				continue
			}
			seen[job.RequestID] = true
			// Legacy servers never redeliver request IDs. Keep compatibility
			// bounded without terminating a healthy long-running desktop session.
			if len(seen) > 65536 {
				seen = map[string]bool{job.RequestID: true}
			}
			slots, deliveries := regularSlots, regularDeliveries
			if relayControlPayload(job.Payload) {
				slots, deliveries = controlSlots, controlDeliveries
			}
			// Reserve delivery capacity before admitting a local operation, so
			// even a saturated result backlog never executes a mutation untracked.
			select {
			case deliveries <- struct{}{}:
			default:
				return "SSH_AGENT_RELAY_DELIVERY_LIMIT", "Agent 中继结果等待确认过多，请恢复当前任务后重连。"
			}
			select {
			case slots <- struct{}{}:
			default:
				<-deliveries
				return "SSH_AGENT_RELAY_LIMIT", "Agent 中继任务已达到并发上限，请恢复当前任务后重连。"
			}
			jobs.Add(1)
			go func(job agentRelayJob, slots, deliveries chan struct{}) {
				defer jobs.Done()
				defer func() { <-deliveries }()
				response := func() agentRelayResponse {
					defer func() { <-slots }()
					return relayLocalWorkspace(ctx, localClient, agent, job.Payload)
				}()
				m.deliverRelayResult(entry, job.RequestID, response, resultBudget)
			}(job, slots, deliveries)
		}
	}
}

func relayLocalWorkspace(ctx context.Context, client *http.Client, agent *localWorkspaceAgent, payload []byte) agentRelayResponse {
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, "http://127.0.0.1:"+strconv.Itoa(agent.port)+"/v1/workspace", bytes.NewReader(payload))
	if err != nil {
		return agentRelayResponse{502, `{"ok":false,"code":"AGENT_HELPER_UNAVAILABLE"}`}
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("X-Chisa-Agent-Token", agent.token)
	response, err := client.Do(request)
	if err != nil {
		return agentRelayResponse{502, `{"ok":false,"code":"AGENT_HELPER_UNAVAILABLE"}`}
	}
	defer response.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(response.Body, 16*1024*1024+1))
	if err != nil || len(raw) > 16*1024*1024 || !json.Valid(raw) {
		return agentRelayResponse{502, `{"ok":false,"code":"AGENT_HELPER_UNAVAILABLE"}`}
	}
	return agentRelayResponse{response.StatusCode, string(raw)}
}

func (m *sshTunnelManager) deliverRelayResult(entry *sshTunnelEntry, id string, response agentRelayResponse, budget *agentRelayResultBudget) {
	ctxDeadline, cancelDeadline := context.WithTimeout(entry.ctx, 30*time.Second)
	defer cancelDeadline()
	reserved := len(response.Body)*2 + 1024
	if !budget.reserve(reserved) {
		response = agentRelayResponse{502, `{"ok":false,"code":"AGENT_HELPER_UNAVAILABLE"}`}
		reserved = 0
	}
	if reserved > 0 {
		defer budget.release(reserved)
	}
	payload, _ := json.Marshal(map[string]any{"connectionId": entry.profile.ID, "requestId": id, "response": response})
	if len(payload) > 24*1024*1024 {
		payload, _ = json.Marshal(map[string]any{"connectionId": entry.profile.ID, "requestId": id, "response": agentRelayResponse{502, `{"ok":false,"code":"AGENT_HELPER_UNAVAILABLE"}`}})
	}
	for attempt := 0; attempt < 6 && ctxDeadline.Err() == nil; attempt++ {
		ctx, cancel := context.WithTimeout(ctxDeadline, 12*time.Second)
		raw, err := sshAgentServiceRequest(ctx, entry.scope, entry.agent.token, http.MethodPost, "/api/ssh-workspaces/agent/relay/result", payload, 64*1024)
		cancel()
		if err == nil {
			var result struct {
				OK bool `json:"ok"`
			}
			if json.Unmarshal(raw, &result) == nil && result.OK {
				return
			}
		}
		if err != nil {
			code, _ := sshErrorFields(err)
			if code == "SSH_ACCOUNT_CHANGED" || code == "SSH_AGENT_RELAY_AUTH_FAILED" {
				return
			}
		}
		select {
		case <-ctxDeadline.Done():
			return
		case <-m.deps.after(time.Second << min(attempt, 5)):
		}
	}
}
