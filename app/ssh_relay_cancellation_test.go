package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// Cancellation revokes execution, but the settled local HTTP outcome must still
// become durable. Leaving a running receipt reserves a full result allocation
// forever in the live journal, exhausting ordinary work after a few cancellations.
func TestSshRelayRuntimeRepeatedCancellationReleasesJournalCapacity(t *testing.T) {
	accountWorkspaceFixture(t, func(writer http.ResponseWriter, request *http.Request) {
		switch request.URL.Path {
		case "/api/ssh-workspaces/agent/relay/ack", "/api/ssh-workspaces/agent/relay/result":
			writeAgentJSON(writer, 200, map[string]any{"ok": true, "accepted": true, "epoch": relayV2TestEpoch})
		default:
			t.Error("unexpected cancellation test endpoint", request.URL.Path)
			http.NotFound(writer, request)
		}
	})
	started := make(chan string, 16)
	stopped := make(chan string, 16)
	var localExecutions atomic.Int32
	local := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		var body struct {
			Request struct {
				Path string `json:"path"`
			} `json:"request"`
		}
		if err := json.NewDecoder(request.Body).Decode(&body); err != nil {
			http.Error(writer, "invalid body", 400)
			return
		}
		localExecutions.Add(1)
		if body.Request.Path == "final.txt" {
			writeAgentJSON(writer, 200, map[string]any{"ok": true, "marker": "capacity remains usable"})
			return
		}
		started <- body.Request.Path
		<-request.Context().Done()
		stopped <- body.Request.Path
	}))
	t.Cleanup(local.Close)
	manager, _ := sshTestManager(t)
	manager.deps.after = func(time.Duration) <-chan time.Time { return time.After(2 * time.Millisecond) }
	scope := mustSshScope(t)
	ctx, cancel := context.WithCancel(scope.ctx)
	journal, err := newRelayJournal(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	agent := &localWorkspaceAgent{port: local.Listener.Addr().(*net.TCPAddr).Port, token: strings.Repeat("a", 64)}
	entry := &sshTunnelEntry{ctx: ctx, cancel: cancel, scope: scope, profile: SshTunnelProfile{SshTunnelProfileInput: SshTunnelProfileInput{ID: strings.Repeat("b", 32)}}, agent: agent}
	client := &http.Client{Transport: &http.Transport{Proxy: nil}}
	runtime := newSshRelayRuntime(manager, entry, client, journal)
	runtime.setEpoch(relayV2TestEpoch)
	t.Cleanup(func() { cancel(); runtime.close(); client.CloseIdleConnections() })

	waitFor := func(label string, condition func() bool) {
		t.Helper()
		ticker := time.NewTicker(time.Millisecond)
		defer ticker.Stop()
		deadline := time.NewTimer(2 * time.Second)
		defer deadline.Stop()
		for !condition() {
			select {
			case <-deadline.C:
				journal.mu.Lock()
				reserved, regularReserved := journal.reserved, journal.regularReserved
				journal.mu.Unlock()
				t.Fatalf("%s did not settle; reserved=%d regularReserved=%d", label, reserved, regularReserved)
			case <-ticker.C:
			}
		}
	}
	awaitPath := func(signal <-chan string, wanted, label string) {
		t.Helper()
		select {
		case actual := <-signal:
			if actual != wanted {
				t.Fatalf("%s belongs to %s, wanted %s", label, actual, wanted)
			}
		case <-time.After(2 * time.Second):
			t.Fatalf("%s never occurred for %s", label, wanted)
		}
	}
	for index := 0; index < 8; index++ {
		requestID := fmt.Sprintf("2bc96ef7-4a12-4c97-9c3f-%012d", index)
		virtualPath := fmt.Sprintf("cancel-%d.txt", index)
		payload, _ := json.Marshal(map[string]any{"protocol": 1, "rootPath": `C:\workspace`, "request": map[string]any{"op": "read", "path": virtualPath}})
		runtime.admit(relayV2TestEpoch, agentRelayJob{RequestID: requestID, Payload: payload, DeadlineAt: time.Now().Add(30 * time.Second).UnixMilli()})
		awaitPath(started, virtualPath, "local read start")
		// One cancellation also suffers a transient installed-receipt flush
		// failure. Its retry must outlive execution cancellation as well.
		if index == 3 {
			var flushes atomic.Int32
			journal.mu.Lock()
			journal.syncInstalled = func(file *os.File) error {
				if flushes.Add(1) == 1 {
					return errors.New("injected cancellation receipt flush failure")
				}
				return file.Sync()
			}
			journal.mu.Unlock()
		}
		runtime.mu.Lock()
		active := runtime.active[requestID]
		if active != nil {
			active.cancel()
		}
		runtime.mu.Unlock()
		if active == nil {
			t.Fatal("accepted read was absent from runtime cancellation state")
		}
		awaitPath(stopped, virtualPath, "local read cancellation")
		waitFor("cancelled terminal receipt", func() bool {
			journal.mu.Lock()
			defer journal.mu.Unlock()
			record := journal.entries[relayJournalKey(relayV2TestEpoch, requestID)]
			return record != nil && record.State == "completed" && record.Result != nil && journal.reserved == 0 && journal.regularReserved == 0
		})
		waitFor("cancelled runtime worker", func() bool {
			runtime.mu.Lock()
			defer runtime.mu.Unlock()
			return runtime.active[requestID] == nil
		})
		journal.mu.Lock()
		journal.syncInstalled = (*os.File).Sync
		journal.mu.Unlock()
	}
	finalID := "2bc96ef7-4a12-4c97-9c3f-000000000099"
	payload := json.RawMessage(`{"protocol":1,"rootPath":"C:\\workspace","request":{"op":"read","path":"final.txt"}}`)
	runtime.admit(relayV2TestEpoch, agentRelayJob{RequestID: finalID, Payload: payload, DeadlineAt: time.Now().Add(30 * time.Second).UnixMilli()})
	waitFor("final ordinary read", func() bool {
		journal.mu.Lock()
		defer journal.mu.Unlock()
		record := journal.entries[relayJournalKey(relayV2TestEpoch, finalID)]
		return record != nil && record.State == "completed" && record.Result != nil && record.Result.Status == 200 && strings.Contains(record.Result.Body, "capacity remains usable") && journal.reserved == 0
	})
	if localExecutions.Load() != 9 {
		t.Fatal("cancellation leaked capacity or caused replay", localExecutions.Load())
	}
}
