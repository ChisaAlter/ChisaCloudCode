package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"sync"
	"time"
)

// The receive supervisor, liveness lane and execution/result workers have separate
// lifetimes. Losing an HTTP response never cancels the Agent or replays a job.
type sshRelayRuntime struct {
	manager           *sshTunnelManager
	entry             *sshTunnelEntry
	agent             *localWorkspaceAgent
	client            *http.Client
	journal           *relayJournal
	mu                sync.Mutex
	epoch             string
	active            map[string]*sshRelayActive
	failures          chan error
	workers           sync.WaitGroup
	regular           chan struct{}
	control           chan struct{}
	regularDeliveries chan struct{}
	controlDeliveries chan struct{}
	pumping           bool
	resumed           map[string]int64
	regularMemory     chan struct{}
	controlMemory     chan struct{}
	regularSends      chan struct{}
	controlSends      chan struct{}
	maintenance       chan struct{}
	maintenanceCancel context.CancelFunc
	maintenanceDone   chan struct{}
	watcher           *sshRelayWatcher
}

type sshRelayActive struct {
	epoch  string
	cancel context.CancelFunc
}

type sshRelayAcknowledgement struct {
	OK                 bool     `json:"ok"`
	Accepted           bool     `json:"accepted"`
	Epoch              string   `json:"epoch"`
	ObsoleteRequestIDs []string `json:"obsoleteRequestIds"`
}

func newSshRelayRuntime(manager *sshTunnelManager, entry *sshTunnelEntry, client *http.Client, journal *relayJournal) *sshRelayRuntime {
	ctx, cancel := context.WithCancel(entry.ctx)
	runtime := &sshRelayRuntime{manager: manager, entry: entry, agent: entry.agent, client: client, journal: journal,
		active: map[string]*sshRelayActive{}, resumed: map[string]int64{}, regularMemory: make(chan struct{}, 4), controlMemory: make(chan struct{}, 1), regularSends: make(chan struct{}, 4), controlSends: make(chan struct{}, 4), failures: make(chan error, 1), regular: make(chan struct{}, 32), control: make(chan struct{}, 4), regularDeliveries: make(chan struct{}, 64), controlDeliveries: make(chan struct{}, 8), maintenance: make(chan struct{}, 1), maintenanceCancel: cancel, maintenanceDone: make(chan struct{})}
	go runtime.maintain(ctx)
	return runtime
}

// Journal scans and fsyncs must never block the heartbeat's network lifetime.
func (runtime *sshRelayRuntime) maintain(ctx context.Context) {
	defer close(runtime.maintenanceDone)
	for {
		select {
		case <-ctx.Done():
			return
		case <-runtime.maintenance:
		case <-runtime.manager.deps.after(5 * time.Second):
		}
		if ctx.Err() != nil {
			return
		}
		_ = runtime.journal.prune()
		runtime.mu.Lock()
		epoch := runtime.epoch
		runtime.mu.Unlock()
		if epoch != "" {
			runtime.resume(epoch)
		}
	}
}

func (runtime *sshRelayRuntime) scheduleMaintenance() {
	select {
	case runtime.maintenance <- struct{}{}:
	default:
	}
}

func (runtime *sshRelayRuntime) setEpoch(epoch string) {
	runtime.mu.Lock()
	defer runtime.mu.Unlock()
	if runtime.epoch != "" && runtime.epoch != epoch {
		for _, active := range runtime.active {
			active.cancel()
		}
		log.Printf("[agent-relay] event=epoch-changed profile=%s active=%d", runtime.entry.profile.ID, len(runtime.active))
	}
	runtime.epoch = epoch
}

func (runtime *sshRelayRuntime) fail(err error) {
	select {
	case runtime.failures <- err:
	default:
	}
}

func (runtime *sshRelayRuntime) currentEpoch() string {
	runtime.mu.Lock()
	defer runtime.mu.Unlock()
	return runtime.epoch
}

// The broker advertises event support only on protocol 2; the watcher starts
// once and reports observations for roots the transport has served recently.
func (runtime *sshRelayRuntime) setEventsEnabled(enabled bool) {
	if !enabled || runtime.watcher != nil {
		return
	}
	runtime.watcher = newSshRelayWatcher(runtime, runtime.entry.ctx)
}

func (runtime *sshRelayRuntime) heartbeat(ctx context.Context) {
	for {
		select {
		case <-ctx.Done():
			return
		case <-runtime.manager.deps.after(5 * time.Second):
		}
		runtime.mu.Lock()
		epoch := runtime.epoch
		ids := make([]string, 0, len(runtime.active))
		for id, active := range runtime.active {
			if active.epoch == epoch {
				ids = append(ids, id)
			}
		}
		runtime.mu.Unlock()
		if epoch == "" {
			continue
		}
		payload, _ := json.Marshal(map[string]any{"connectionId": runtime.entry.profile.ID, "epoch": epoch, "activeRequestIds": ids})
		requestCtx, cancel := context.WithTimeout(ctx, 8*time.Second)
		raw, err := sshAgentServiceRequest(requestCtx, runtime.entry.scope, runtime.agent.token, http.MethodPost, "/api/ssh-workspaces/agent/relay/heartbeat", payload, 64*1024)
		cancel()
		if ctx.Err() != nil {
			return
		}
		if err != nil {
			runtime.fail(err)
			continue
		}
		var reply sshRelayAcknowledgement
		if json.Unmarshal(raw, &reply) != nil || !reply.OK || reply.Epoch == "" {
			runtime.fail(sshFailure("SSH_AGENT_RELAY_UNAVAILABLE", "Agent 心跳响应无效，正在重新连接。"))
			continue
		}
		runtime.mu.Lock()
		// A heartbeat sent on A may return after the receive supervisor has
		// negotiated B. It cannot revoke or roll back work on the new epoch.
		if runtime.epoch != epoch {
			runtime.mu.Unlock()
			continue
		}
		for _, id := range reply.ObsoleteRequestIDs {
			if active := runtime.active[id]; active != nil && active.epoch == epoch {
				active.cancel()
			}
		}
		runtime.mu.Unlock()
		if reply.Epoch != epoch {
			runtime.mu.Lock()
			if runtime.epoch == epoch {
				for _, active := range runtime.active {
					if active.epoch == epoch {
						active.cancel()
					}
				}
			}
			runtime.mu.Unlock()
			runtime.fail(sshFailure("SSH_AGENT_REGISTRATION_REQUIRED", "服务端 Agent 会话已更新，正在恢复连接和任务状态。"))
		} else {
			runtime.scheduleMaintenance()
		}
	}
}

func (runtime *sshRelayRuntime) receive(ctx context.Context, path string) ([]byte, error) {
	requestCtx, cancel := context.WithTimeout(ctx, 32*time.Second)
	defer cancel()
	type response struct {
		body []byte
		err  error
	}
	result := make(chan response, 1)
	go func() {
		raw, err := sshAgentServiceRequest(requestCtx, runtime.entry.scope, runtime.agent.token, http.MethodGet, path, nil, 50*1024*1024)
		result <- response{raw, err}
	}()
	select {
	case reply := <-result:
		return reply.body, reply.err
	case err := <-runtime.failures:
		cancel()
		<-result
		return nil, err
	case <-ctx.Done():
		cancel()
		<-result
		return nil, ctx.Err()
	}
}

func (runtime *sshRelayRuntime) resume(epoch string) {
	runtime.mu.Lock()
	if runtime.pumping || runtime.epoch != epoch {
		runtime.mu.Unlock()
		return
	}
	runtime.pumping = true
	runtime.mu.Unlock()
	defer func() { runtime.mu.Lock(); runtime.pumping = false; runtime.mu.Unlock() }()
	for _, record := range runtime.journal.metadata() {
		resumeUntil := record.DeadlineAt
		if record.State == "completed" {
			resumeUntil += int64((5 * time.Minute) / time.Millisecond)
		}
		if record.Epoch != epoch || resumeUntil <= time.Now().UnixMilli() {
			continue
		}
		runtime.mu.Lock()
		handled := runtime.resumed[record.RequestID]
		runtime.mu.Unlock()
		if handled > time.Now().UnixMilli() {
			continue
		}
		// Recovery queues only identity metadata. Large result/payload snapshots
		// are loaded by the worker after it reserves its memory lane.
		runtime.admitReference(epoch, agentRelayJob{RequestID: record.RequestID, DeadlineAt: record.DeadlineAt}, record.Control, true)
	}
}

func (runtime *sshRelayRuntime) admit(epoch string, job agentRelayJob) {
	if runtime.watcher != nil {
		var envelope struct {
			RootPath             string `json:"rootPath"`
			ExpectedRootIdentity string `json:"expectedRootIdentity"`
		}
		if json.Unmarshal(job.Payload, &envelope) == nil && envelope.RootPath != "" {
			runtime.watcher.observe(envelope.RootPath, envelope.ExpectedRootIdentity)
		}
	}
	runtime.admitReference(epoch, job, relayControlPayload(job.Payload), false)
}

func (runtime *sshRelayRuntime) admitReference(epoch string, job agentRelayJob, control, retained bool) {
	slots, deliveries := runtime.regular, runtime.regularDeliveries
	if control {
		slots, deliveries = runtime.control, runtime.controlDeliveries
	}
	runtime.mu.Lock()
	if runtime.epoch != epoch || runtime.active[job.RequestID] != nil {
		runtime.mu.Unlock()
		return
	}
	select {
	case deliveries <- struct{}{}:
	default:
		runtime.mu.Unlock()
		return
	}
	select {
	case slots <- struct{}{}:
	default:
		<-deliveries
		runtime.mu.Unlock()
		return
	}
	ctx, cancel := context.WithCancel(runtime.entry.ctx)
	active := &sshRelayActive{epoch: epoch, cancel: cancel}
	runtime.active[job.RequestID] = active
	runtime.workers.Add(1)
	runtime.mu.Unlock()
	go func() {
		defer runtime.workers.Done()
		defer cancel()
		once := sync.Once{}
		release := func() { once.Do(func() { <-slots }) }
		defer release()
		defer func() {
			<-deliveries
			runtime.mu.Lock()
			if runtime.active[job.RequestID] == active {
				delete(runtime.active, job.RequestID)
			}
			runtime.mu.Unlock()
			if runtime.entry.ctx.Err() == nil {
				runtime.scheduleMaintenance()
			}
		}()
		runtime.execute(ctx, epoch, job, control, retained, release)
	}()
}

func relayFailureResponse(code, message string) agentRelayResponse {
	raw, _ := json.Marshal(map[string]any{"ok": false, "protocol": 1, "platform": "win32", "code": code, "error": message})
	return agentRelayResponse{Status: 503, Body: string(raw)}
}

func (runtime *sshRelayRuntime) execute(ctx context.Context, epoch string, job agentRelayJob, control, retained bool, releaseExecution func()) {
	started := time.Now()
	memory := runtime.regularMemory
	if control {
		memory = runtime.controlMemory
	}
	memoryCtx := ctx
	var cancelMemory context.CancelFunc
	if !retained {
		memoryCtx, cancelMemory = context.WithDeadline(ctx, time.UnixMilli(job.DeadlineAt))
		defer cancelMemory()
	}
	select {
	case memory <- struct{}{}:
	case <-memoryCtx.Done():
		return
	}
	var memoryOnce sync.Once
	releaseMemory := func() { memoryOnce.Do(func() { <-memory }) }
	defer releaseMemory()
	var record *relayJournalRecord
	var err error
	if retained {
		record, err = runtime.journal.record(epoch, job.RequestID)
	} else {
		record, _, err = runtime.journal.claim(epoch, job)
	}
	if err != nil {
		log.Printf("[agent-relay] event=journal-refused profile=%s request=%s error_type=%T", runtime.entry.profile.ID, job.RequestID, err)
		// Refuse an unacknowledged offer explicitly, with no local execution.
		// This control operation needs no receipt allocation on a full disk.
		payload, _ := json.Marshal(map[string]any{"connectionId": runtime.entry.profile.ID, "epoch": epoch, "requestId": job.RequestID})
		requestCtx, cancel := context.WithTimeout(ctx, 8*time.Second)
		_, _ = sshAgentServiceRequest(requestCtx, runtime.entry.scope, runtime.agent.token, http.MethodPost, "/api/ssh-workspaces/agent/relay/reject", payload, 64*1024)
		cancel()
		return
	}
	if record.Epoch != epoch {
		return
	}
	operationCtx, cancel := context.WithDeadline(ctx, time.UnixMilli(record.DeadlineAt))
	defer cancel()
	ackBody, _ := json.Marshal(map[string]any{"connectionId": runtime.entry.profile.ID, "epoch": epoch, "requestId": job.RequestID})
	acknowledged := record.State == "completed"
	for attempt := 0; !acknowledged && operationCtx.Err() == nil; attempt++ {
		requestCtx, stop := context.WithTimeout(operationCtx, 8*time.Second)
		raw, requestErr := sshAgentServiceRequest(requestCtx, runtime.entry.scope, runtime.agent.token, http.MethodPost, "/api/ssh-workspaces/agent/relay/ack", ackBody, 64*1024)
		stop()
		var ack sshRelayAcknowledgement
		if requestErr == nil && json.Unmarshal(raw, &ack) == nil && ack.OK {
			if !ack.Accepted || ack.Epoch != epoch {
				return
			}
			acknowledged = true
			break
		}
		if !runtime.retry(operationCtx, requestErr, attempt) {
			return
		}
	}
	if !acknowledged {
		return
	}
	var reply agentRelayResponse
	persist := func(reply agentRelayResponse) bool {
		// Caller cancellation stops execution, not the terminal receipt. Persist
		// after local HTTP settles so an obsolete job releases its disk reserve.
		// Account shutdown still revokes the lifetime; restart recovers unknown.
		persistCtx, stop := context.WithDeadline(runtime.entry.ctx, time.UnixMilli(record.DeadlineAt).Add(5*time.Minute))
		defer stop()
		for attempt := 0; persistCtx.Err() == nil; attempt++ {
			err := runtime.journal.complete(record, reply)
			if err == nil {
				return true
			}
			if time.Now().UnixMilli() > record.DeadlineAt+int64((5*time.Minute)/time.Millisecond) {
				return false
			}
			log.Printf("[agent-relay] event=result-persist-retry profile=%s request=%s error_type=%T", runtime.entry.profile.ID, job.RequestID, err)
			if !runtime.retry(persistCtx, nil, attempt) {
				return false
			}
		}
		return false
	}
	switch record.State {
	case "received":
		if err := runtime.journal.markRunning(record); err != nil {
			reply = relayFailureResponse("AGENT_BUSY", "Desktop journal capacity is temporarily full; this operation was not executed")
		} else {
			reply = relayLocalWorkspace(operationCtx, runtime.client, runtime.agent, record.Payload)
		}
		if !persist(reply) {
			return
		}
	case "completed":
		if record.Result == nil {
			return
		}
		reply = *record.Result
	case "unknown", "running":
		// A crashed process may have executed the command. Only higher-level
		// operation/job receipts may resolve that uncertainty; never run it again.
		reply = relayFailureResponse("AGENT_EXECUTION_UNCONFIRMED", "Desktop restarted while this operation was in progress; inspect the original operation receipt before retrying")
		if !persist(reply) {
			return
		}
	default:
		return
	}
	releaseExecution()
	releaseMemory()
	log.Printf("[agent-relay] event=execution-settled profile=%s request=%s status=%d elapsed=%s", runtime.entry.profile.ID, job.RequestID, reply.Status, time.Since(started))
	// Once persisted, delivery outlives the caller's execution deadline. It
	// sends only this immutable result, never the workspace operation again.
	resultCtx, stop := context.WithDeadline(ctx, time.UnixMilli(record.DeadlineAt).Add(5*time.Minute))
	defer stop()
	// Result encoding/network acknowledgement has its own bounded lane. A
	// stalled acknowledgement cannot retain helper execution admission.
	sends := runtime.regularSends
	if control {
		sends = runtime.controlSends
	}
	select {
	case sends <- struct{}{}:
	case <-resultCtx.Done():
		return
	}
	defer func() { <-sends }()
	payload, _ := json.Marshal(map[string]any{"connectionId": runtime.entry.profile.ID, "requestId": job.RequestID, "epoch": epoch, "response": reply})
	for attempt := 0; resultCtx.Err() == nil; attempt++ {
		requestCtx, cancel := context.WithTimeout(resultCtx, 8*time.Second)
		raw, requestErr := sshAgentServiceRequest(requestCtx, runtime.entry.scope, runtime.agent.token, http.MethodPost, "/api/ssh-workspaces/agent/relay/result", payload, 64*1024)
		cancel()
		var ack sshRelayAcknowledgement
		if requestErr == nil && json.Unmarshal(raw, &ack) == nil && ack.OK {
			if ack.Epoch != epoch {
				runtime.fail(sshFailure("SSH_AGENT_REGISTRATION_REQUIRED", "Agent 服务会话已更新，正在重新连接。"))
			}
			runtime.mu.Lock()
			runtime.resumed[job.RequestID] = record.DeadlineAt + int64((5*time.Minute)/time.Millisecond)
			for id, until := range runtime.resumed {
				if until < time.Now().UnixMilli() {
					delete(runtime.resumed, id)
				}
			}
			runtime.mu.Unlock()
			log.Printf("[agent-relay] event=result-acknowledged profile=%s request=%s accepted=%t", runtime.entry.profile.ID, job.RequestID, ack.Accepted)
			return
		}
		if !runtime.retry(resultCtx, requestErr, attempt) {
			return
		}
	}
}

func (runtime *sshRelayRuntime) retry(ctx context.Context, err error, attempt int) bool {
	if err != nil {
		code, _ := sshErrorFields(err)
		if code == "SSH_ACCOUNT_CHANGED" || code == "SSH_AGENT_RELAY_AUTH_FAILED" || code == "SSH_AGENT_REGISTRATION_REQUIRED" {
			runtime.fail(err)
			if code != "SSH_AGENT_REGISTRATION_REQUIRED" {
				return false
			}
		}
	}
	delay := time.Second << min(attempt, 3)
	select {
	case <-ctx.Done():
		return false
	case <-runtime.manager.deps.after(delay):
		return ctx.Err() == nil
	}
}

func (runtime *sshRelayRuntime) close() {
	runtime.maintenanceCancel()
	<-runtime.maintenanceDone
	if runtime.watcher != nil {
		runtime.watcher.close()
	}
	runtime.workers.Wait()
	_ = runtime.journal.close()
}

func validateRelayEpoch(epoch string) error {
	if len(epoch) < 16 || len(epoch) > 128 {
		return fmt.Errorf("invalid relay epoch")
	}
	return nil
}
