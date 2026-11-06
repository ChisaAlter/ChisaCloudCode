package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestSshRelayRuntimeHeartbeatDoesNotWaitForJournalMutex(t *testing.T) {
	beats := make(chan struct{}, 10)
	accountWorkspaceFixture(t, func(writer http.ResponseWriter, request *http.Request) {
		if request.URL.Path != "/api/ssh-workspaces/agent/relay/heartbeat" {
			t.Error("unexpected journal-lock endpoint", request.URL.Path)
		}
		writeAgentJSON(writer, 200, map[string]any{"ok": true, "epoch": relayV2TestEpoch, "obsoleteRequestIds": []string{}})
		select {
		case beats <- struct{}{}:
		default:
		}
	})
	manager, _ := sshTestManager(t)
	manager.deps.after = func(time.Duration) <-chan time.Time { return time.After(time.Millisecond) }
	scope := mustSshScope(t)
	ctx, cancel := context.WithCancel(scope.ctx)
	journal, err := newRelayJournal(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	entry := &sshTunnelEntry{ctx: ctx, cancel: cancel, scope: scope, profile: SshTunnelProfile{SshTunnelProfileInput: SshTunnelProfileInput{ID: strings.Repeat("c", 32)}}, agent: &localWorkspaceAgent{token: strings.Repeat("d", 64)}}
	runtime := newSshRelayRuntime(manager, entry, &http.Client{}, journal)
	runtime.setEpoch(relayV2TestEpoch)
	journal.mu.Lock()
	defer journal.mu.Unlock()
	heartbeatDone := make(chan struct{})
	go func() { defer close(heartbeatDone); runtime.heartbeat(ctx) }()
	defer func() { cancel(); <-heartbeatDone }()
	// Unlock before runtime.close waits for disk maintenance to finish.
	t.Cleanup(func() { runtime.close() })
	for range 3 {
		select {
		case <-beats:
		case <-time.After(time.Second):
			t.Fatal("journal fsync/mutex blocked independent heartbeat")
		}
	}
}

func TestSshRelayRuntimeRestartDrainsCompletedResultsBeyondExecutionCapacity(t *testing.T) {
	const total = 40
	const epoch = "3cac2305-1f59-4e70-b4ab-08f79dde2c2e"
	directory := t.TempDir()
	journal, err := newRelayJournal(directory)
	if err != nil {
		t.Fatal(err)
	}
	payload := json.RawMessage(`{"request":{"op":"read"}}`)
	for index := 0; index < total; index++ {
		job := agentRelayJob{RequestID: fmt.Sprintf("90cf44fe-5507-4738-a82d-%012d", index), Payload: payload, DeadlineAt: time.Now().Add(30 * time.Second).UnixMilli()}
		record, _, claimErr := journal.claim(epoch, job)
		if claimErr != nil {
			t.Fatal("cannot prepare retained result", index, claimErr)
		}
		if err := journal.markRunning(record); err != nil {
			t.Fatal(err)
		}
		if err := journal.complete(record, agentRelayResponse{Status: 200, Body: fmt.Sprintf(`{"ok":true,"index":%d}`, index)}); err != nil {
			t.Fatal(err)
		}
	}
	if err := journal.close(); err != nil {
		t.Fatal(err)
	}
	journal, err = newRelayJournal(directory)
	if err != nil {
		t.Fatal("cannot reopen restart result outbox", err)
	}
	t.Cleanup(func() { _ = journal.close() })

	allDelivered := make(chan struct{})
	var resultMu sync.Mutex
	received := make(map[string]int)
	var count atomic.Int32
	accountWorkspaceFixture(t, func(writer http.ResponseWriter, request *http.Request) {
		var identity struct {
			Epoch     string `json:"epoch"`
			RequestID string `json:"requestId"`
		}
		if err := json.NewDecoder(request.Body).Decode(&identity); err != nil {
			t.Error(err)
		}
		if identity.Epoch != epoch || identity.RequestID == "" {
			t.Error("restart outbox lost request identity", identity)
		}
		switch request.URL.Path {
		case "/api/ssh-workspaces/agent/relay/result":
			resultMu.Lock()
			received[identity.RequestID]++
			resultMu.Unlock()
			if count.Add(1) == total {
				close(allDelivered)
			}
			writeAgentJSON(writer, 200, map[string]any{"ok": true, "accepted": true, "epoch": epoch})
		default:
			t.Error("cached completed result unexpectedly executed local work", request.URL.Path)
			http.NotFound(writer, request)
		}
	})
	manager, _ := sshTestManager(t)
	scope := mustSshScope(t)
	ctx, cancel := context.WithCancel(scope.ctx)
	defer cancel()
	entry := &sshTunnelEntry{ctx: ctx, cancel: cancel, scope: scope, profile: SshTunnelProfile{SshTunnelProfileInput: SshTunnelProfileInput{ID: strings.Repeat("d", 32)}}, agent: &localWorkspaceAgent{token: strings.Repeat("e", 64)}}
	runtime := newSshRelayRuntime(manager, entry, &http.Client{}, journal)
	runtime.setEpoch(epoch)
	t.Cleanup(func() { cancel(); runtime.close() })
	// A single restart scan must drain more records than the execution lane
	// admits at once; each completed worker must pump the next retained result.
	runtime.resume(epoch)
	select {
	case <-allDelivered:
	case <-time.After(10 * time.Second):
		t.Fatal("restart stranded completed outbox records after first execution wave", count.Load())
	}
	resultMu.Lock()
	defer resultMu.Unlock()
	if len(received) != total {
		t.Fatal("restart outbox skipped retained requests", len(received))
	}
	for requestID, copies := range received {
		if copies != 1 {
			t.Fatal("restart pump repeatedly posted an already acknowledged result", requestID, copies)
		}
	}
}
