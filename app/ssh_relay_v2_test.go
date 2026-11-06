package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

const relayV2TestEpoch = "f74d9ba7-e66e-46ed-a721-9270a0348f43"

func relayV2TestRegistration(writer http.ResponseWriter, request *http.Request) {
	var payload map[string]any
	_ = json.NewDecoder(request.Body).Decode(&payload)
	writeAgentJSON(writer, http.StatusOK, map[string]any{"ok": true, "connection": map[string]any{"id": payload["id"], "port": payload["port"], "transport": "agent"}})
}

func relayV2TestPoll(writer http.ResponseWriter, jobs ...map[string]any) {
	if jobs == nil {
		jobs = []map[string]any{}
	}
	writeAgentJSON(writer, http.StatusOK, map[string]any{"ready": true, "protocol": 2, "epoch": relayV2TestEpoch, "jobs": jobs})
}

// A truncated real HTTP response models the server accepting work while its
// response never reaches the desktop. No workspace operation may be replayed.
func relayV2TestDropResponse(t *testing.T, writer http.ResponseWriter) {
	t.Helper()
	connection, buffered, err := writer.(http.Hijacker).Hijack()
	if err != nil {
		t.Error("cannot inject lost response", err)
		return
	}
	_, _ = buffered.WriteString("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 100\r\nConnection: close\r\n\r\n{\"ok\":")
	_ = buffered.Flush()
	_ = connection.Close()
}

func relayV2TestNative(t *testing.T, local *httptest.Server) (*sshTunnelManager, SshTunnelProfile) {
	t.Helper()
	manager, _ := sshTestManager(t)
	preserveDesktopSshManager(t, manager)
	manager.deps.startAgent = func(int) (*localWorkspaceAgent, error) {
		ctx, cancel := context.WithCancel(context.Background())
		return &localWorkspaceAgent{port: local.Listener.Addr().(*net.TCPAddr).Port, token: strings.Repeat("a", 64), ctx: ctx, cancel: cancel}, nil
	}
	manager.deps.after = func(time.Duration) <-chan time.Time { return time.After(2 * time.Millisecond) }
	response := (FrontendBridge{}).EnsureSshAgent("")
	if response["ok"] != true {
		t.Fatal("v2 native relay did not start", response)
	}
	profile := response["profile"].(SshTunnelProfile)
	t.Cleanup(func() {
		(FrontendBridge{}).StopSshTunnel(profile.ID)
		waitSshState(t, manager, mustSshScope(t), profile.ID, "stopped")
	})
	return manager, profile
}

func TestSshRelayV2SlowResultAcknowledgementsDoNotHoldExecutionOrControls(t *testing.T) {
	const regular, total = 12, 14
	var polls, results atomic.Int32
	settled := make(chan struct{}, total)
	allResults := make(chan struct{})
	var mu sync.Mutex
	accepted := map[string]bool{}
	executions := map[int]int{}
	local := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		var body struct {
			Index int `json:"index"`
		}
		_ = json.NewDecoder(request.Body).Decode(&body)
		mu.Lock()
		executions[body.Index]++
		mu.Unlock()
		writeAgentJSON(writer, 200, map[string]any{"ok": true})
	}))
	t.Cleanup(local.Close)
	accountWorkspaceFixture(t, func(writer http.ResponseWriter, request *http.Request) {
		switch request.URL.Path {
		case "/api/ssh-workspaces/agent/connections":
			relayV2TestRegistration(writer, request)
		case "/api/ssh-workspaces/agent/relay/poll":
			if request.URL.Query().Get("wait") == "0" {
				relayV2TestPoll(writer)
				return
			}
			index := int(polls.Add(1)) - 1
			if index > 0 && index <= total {
				select {
				case <-settled:
				case <-request.Context().Done():
					return
				}
			}
			if index >= total {
				<-request.Context().Done()
				return
			}
			op := "read"
			if index >= regular {
				op = "job_status"
			}
			payload, _ := json.Marshal(map[string]any{"index": index, "request": map[string]any{"op": op}})
			relayV2TestPoll(writer, map[string]any{"requestId": fmt.Sprintf("8830c317-c617-4644-be0e-%012d", index), "payload": json.RawMessage(payload), "deadlineAt": time.Now().Add(30 * time.Second).UnixMilli()})
		case "/api/ssh-workspaces/agent/relay/ack":
			writeAgentJSON(writer, 200, map[string]any{"ok": true, "accepted": true, "epoch": relayV2TestEpoch})
		case "/api/ssh-workspaces/agent/relay/result":
			var body struct {
				RequestID string `json:"requestId"`
			}
			_ = json.NewDecoder(request.Body).Decode(&body)
			mu.Lock()
			first := !accepted[body.RequestID]
			accepted[body.RequestID] = true
			mu.Unlock()
			if first {
				settled <- struct{}{}
				if results.Add(1) == total {
					close(allResults)
				}
			}
			// The broker accepted this result; only its HTTP reply is stalled.
			<-request.Context().Done()
		case "/api/ssh-workspaces/agent/relay/heartbeat":
			var body struct {
				Active []string `json:"activeRequestIds"`
			}
			_ = json.NewDecoder(request.Body).Decode(&body)
			obsolete := []string{}
			mu.Lock()
			for _, id := range body.Active {
				if accepted[id] {
					obsolete = append(obsolete, id)
				}
			}
			mu.Unlock()
			writeAgentJSON(writer, 200, map[string]any{"ok": true, "epoch": relayV2TestEpoch, "obsoleteRequestIds": obsolete})
		default:
			t.Error("unexpected slow result endpoint", request.URL.Path)
			http.NotFound(writer, request)
		}
	})
	relayV2TestNative(t, local)
	select {
	case <-allResults:
	case <-time.After(10 * time.Second):
		t.Fatal("slow result ACKs blocked regular or control execution", results.Load())
	}
	mu.Lock()
	defer mu.Unlock()
	if len(executions) != total {
		t.Fatal("missing execution during stalled result acknowledgements", executions)
	}
	for index := 0; index < total; index++ {
		if executions[index] != 1 {
			t.Fatal("slow result acknowledgement repeated work", index, executions[index])
		}
	}
}

func TestSshRelayV2RecoversLostPollAndReceiptAndRetainsResultWithoutReexecution(t *testing.T) {
	var polls, acks, executions, results atomic.Int32
	var receiptConfirmed atomic.Bool
	ackLost := make(chan struct{})
	resultDone := make(chan struct{})
	var resultOnce sync.Once
	var resultMu sync.Mutex
	var resultBodies []string
	local := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if !receiptConfirmed.Load() {
			t.Error("workspace operation ran before receipt acknowledgement")
		}
		executions.Add(1)
		_, _ = io.Copy(io.Discard, request.Body)
		writeAgentJSON(writer, 200, map[string]any{"ok": true, "marker": "executed once"})
	}))
	t.Cleanup(local.Close)
	payload := json.RawMessage(`{"protocol":1,"rootPath":"C:\\workspace","generation":"fault-test","request":{"op":"read","path":"marker.txt"}}`)
	deadline := time.Now().Add(30 * time.Second).UnixMilli()
	accountWorkspaceFixture(t, func(writer http.ResponseWriter, request *http.Request) {
		switch request.URL.Path {
		case "/api/ssh-workspaces/agent/connections":
			relayV2TestRegistration(writer, request)
		case "/api/ssh-workspaces/agent/relay/poll":
			if request.URL.Query().Get("wait") == "0" {
				relayV2TestPoll(writer)
				return
			}
			switch polls.Add(1) {
			case 1:
				relayV2TestDropResponse(t, writer)
			case 2:
				relayV2TestPoll(writer, map[string]any{"requestId": "30bc37cf-e2d3-4318-93cb-2a9b22221740", "payload": payload, "deadlineAt": deadline})
			case 3:
				select {
				case <-ackLost:
					relayV2TestPoll(writer, map[string]any{"requestId": "30bc37cf-e2d3-4318-93cb-2a9b22221740", "payload": payload, "deadlineAt": deadline})
				case <-request.Context().Done():
				}
			default:
				<-request.Context().Done()
			}
		case "/api/ssh-workspaces/agent/relay/ack":
			var receipt struct {
				Epoch     string `json:"epoch"`
				RequestID string `json:"requestId"`
			}
			_ = json.NewDecoder(request.Body).Decode(&receipt)
			if receipt.Epoch != relayV2TestEpoch || receipt.RequestID != "30bc37cf-e2d3-4318-93cb-2a9b22221740" {
				t.Error("receipt used another correlation identity", receipt)
			}
			if acks.Add(1) == 1 {
				relayV2TestDropResponse(t, writer)
				close(ackLost)
				return
			}
			receiptConfirmed.Store(true)
			writeAgentJSON(writer, 200, map[string]any{"ok": true, "accepted": true, "epoch": relayV2TestEpoch})
		case "/api/ssh-workspaces/agent/relay/result":
			raw, _ := io.ReadAll(request.Body)
			resultMu.Lock()
			resultBodies = append(resultBodies, string(raw))
			resultMu.Unlock()
			if results.Add(1) <= 8 {
				http.Error(writer, "temporary upstream failure", 503)
				return
			}
			writeAgentJSON(writer, 200, map[string]any{"ok": true, "accepted": true, "epoch": relayV2TestEpoch})
			resultOnce.Do(func() { close(resultDone) })
		case "/api/ssh-workspaces/agent/relay/heartbeat":
			writeAgentJSON(writer, 200, map[string]any{"ok": true, "epoch": relayV2TestEpoch, "obsoleteRequestIds": []string{}})
		default:
			t.Error("unexpected v2 endpoint", request.URL.Path)
			http.NotFound(writer, request)
		}
	})
	manager, profile := relayV2TestNative(t, local)
	select {
	case <-resultDone:
	case <-time.After(10 * time.Second):
		status, _ := manager.getStatus(mustSshScope(t), profile.ID)
		t.Fatalf("result was discarded after transport failures: polls=%d receipts=%d results=%d status=%+v", polls.Load(), acks.Load(), results.Load(), status)
	}
	if executions.Load() != 1 || acks.Load() < 2 || results.Load() < 9 {
		t.Fatal("lost response caused missing or repeated workspace execution", executions.Load(), acks.Load(), results.Load())
	}
	resultMu.Lock()
	defer resultMu.Unlock()
	for _, body := range resultBodies {
		if body != resultBodies[0] {
			t.Fatal("result retransmission changed the retained response")
		}
	}
}

func TestSshRelayV2HeartbeatContinuesWhilePollResponseIsStalled(t *testing.T) {
	pollEntered := make(chan struct{})
	var pollOnce sync.Once
	var heartbeats atomic.Int32
	heartbeatDone := make(chan struct{})
	var heartbeatOnce sync.Once
	local := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		t.Error("empty stalled poll unexpectedly executed local work")
		writeAgentJSON(writer, 200, map[string]any{"ok": true})
	}))
	t.Cleanup(local.Close)
	accountWorkspaceFixture(t, func(writer http.ResponseWriter, request *http.Request) {
		switch request.URL.Path {
		case "/api/ssh-workspaces/agent/connections":
			relayV2TestRegistration(writer, request)
		case "/api/ssh-workspaces/agent/relay/poll":
			if request.URL.Query().Get("wait") == "0" {
				relayV2TestPoll(writer)
				return
			}
			pollOnce.Do(func() { close(pollEntered) })
			<-request.Context().Done()
		case "/api/ssh-workspaces/agent/relay/heartbeat":
			select {
			case <-pollEntered:
				if heartbeats.Add(1) >= 3 {
					heartbeatOnce.Do(func() { close(heartbeatDone) })
				}
			default:
			}
			writeAgentJSON(writer, 200, map[string]any{"ok": true, "epoch": relayV2TestEpoch, "obsoleteRequestIds": []string{}})
		default:
			t.Error("unexpected heartbeat test endpoint", request.URL.Path)
			http.NotFound(writer, request)
		}
	})
	manager, profile := relayV2TestNative(t, local)
	select {
	case <-heartbeatDone:
	case <-time.After(5 * time.Second):
		t.Fatal("poll response blocked the independent heartbeat", heartbeats.Load())
	}
	status, err := manager.getStatus(mustSshScope(t), profile.ID)
	if err != nil || status.State != "forwarding" || !status.OuterConnected {
		t.Fatal("healthy independent heartbeat lost native readiness", status, err)
	}
}

func TestSshRelayV2HeartbeatEpochChangeCancelsOldReadAndRehandshakes(t *testing.T) {
	const nextEpoch = "af2f5d30-8adb-434f-ab40-9edf043b3a51"
	var rotated, offered atomic.Bool
	var executions, registrations atomic.Int32
	localStarted, localCancelled, reconnected := make(chan struct{}), make(chan struct{}), make(chan struct{})
	var startedOnce, cancelledOnce, reconnectedOnce sync.Once
	local := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		_, _ = io.Copy(io.Discard, request.Body)
		executions.Add(1)
		startedOnce.Do(func() { close(localStarted) })
		<-request.Context().Done()
		cancelledOnce.Do(func() { close(localCancelled) })
	}))
	t.Cleanup(local.Close)
	payload := json.RawMessage(`{"protocol":1,"rootPath":"C:\\workspace","generation":"epoch-test","request":{"op":"read","path":"old-epoch.txt"}}`)
	var tokenMu sync.Mutex
	privateToken := ""
	accountWorkspaceFixture(t, func(writer http.ResponseWriter, request *http.Request) {
		switch request.URL.Path {
		case "/api/ssh-workspaces/agent/connections":
			var registration struct {
				ID    string `json:"id"`
				Port  int    `json:"port"`
				Token string `json:"token"`
			}
			_ = json.NewDecoder(request.Body).Decode(&registration)
			tokenMu.Lock()
			if privateToken != "" && privateToken != registration.Token {
				t.Error("broker epoch recovery rotated local Agent credentials")
			}
			privateToken = registration.Token
			tokenMu.Unlock()
			registrations.Add(1)
			writeAgentJSON(writer, 200, map[string]any{"ok": true, "connection": map[string]any{"id": registration.ID, "port": registration.Port, "transport": "agent"}})
		case "/api/ssh-workspaces/agent/relay/poll":
			if request.URL.Query().Get("wait") == "0" {
				if rotated.Load() {
					writeAgentJSON(writer, 200, map[string]any{"ready": true, "protocol": 2, "epoch": nextEpoch, "jobs": []any{}})
					reconnectedOnce.Do(func() { close(reconnected) })
				} else {
					relayV2TestPoll(writer)
				}
				return
			}
			if offered.CompareAndSwap(false, true) {
				relayV2TestPoll(writer, map[string]any{"requestId": "2d1cb302-9c45-40f9-a05f-31eec63a41df", "payload": payload, "deadlineAt": time.Now().Add(30 * time.Second).UnixMilli()})
				return
			}
			<-request.Context().Done()
		case "/api/ssh-workspaces/agent/relay/ack":
			writeAgentJSON(writer, 200, map[string]any{"ok": true, "accepted": true, "epoch": relayV2TestEpoch})
		case "/api/ssh-workspaces/agent/relay/heartbeat":
			epoch := relayV2TestEpoch
			obsolete := []string{}
			select {
			case <-localStarted:
				rotated.Store(true)
				epoch = nextEpoch
				obsolete = []string{"2d1cb302-9c45-40f9-a05f-31eec63a41df"}
			default:
			}
			writeAgentJSON(writer, 200, map[string]any{"ok": true, "epoch": epoch, "obsoleteRequestIds": obsolete})
		case "/api/ssh-workspaces/agent/relay/result":
			_, _ = io.Copy(io.Discard, request.Body)
			writeAgentJSON(writer, 200, map[string]any{"ok": true, "accepted": false, "epoch": nextEpoch})
		default:
			t.Error("unexpected epoch test endpoint", request.URL.Path)
			http.NotFound(writer, request)
		}
	})
	relayV2TestNative(t, local)
	for _, signal := range []struct {
		name  string
		ready <-chan struct{}
	}{{"old local read cancellation", localCancelled}, {"new epoch handshake", reconnected}} {
		select {
		case <-signal.ready:
		case <-time.After(5 * time.Second):
			t.Fatal("heartbeat epoch change did not finish", signal.name)
		}
	}
	if executions.Load() != 1 || registrations.Load() < 2 {
		t.Fatal("epoch change replayed work or skipped native registration", executions.Load(), registrations.Load())
	}
}

func TestSshRelayV2DelayedOldHeartbeatCannotRollBackNewerPollEpoch(t *testing.T) {
	const nextEpoch = "a5e58eb4-2f93-4b7e-9ae8-dc87a8cad216"
	const requestID = "4c45821f-667b-434a-889a-c4f278a4df6c"
	firstHeartbeat := make(chan struct{})
	localStarted, localCancelled := make(chan struct{}), make(chan struct{})
	currentHeartbeat := make(chan string, 1)
	var polls, heartbeats atomic.Int32
	var startOnce, cancelledOnce sync.Once
	local := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		_, _ = io.Copy(io.Discard, request.Body)
		startOnce.Do(func() { close(localStarted) })
		<-request.Context().Done()
		cancelledOnce.Do(func() { close(localCancelled) })
	}))
	t.Cleanup(local.Close)
	payload := json.RawMessage(`{"protocol":1,"rootPath":"C:\\workspace","generation":"newer-epoch-test","request":{"op":"read","path":"new-epoch.txt"}}`)
	accountWorkspaceFixture(t, func(writer http.ResponseWriter, request *http.Request) {
		switch request.URL.Path {
		case "/api/ssh-workspaces/agent/connections":
			relayV2TestRegistration(writer, request)
		case "/api/ssh-workspaces/agent/relay/poll":
			if request.URL.Query().Get("wait") == "0" {
				relayV2TestPoll(writer)
				return
			}
			if polls.Add(1) == 1 {
				select {
				case <-firstHeartbeat:
					writeAgentJSON(writer, 200, map[string]any{"ready": true, "protocol": 2, "epoch": nextEpoch, "jobs": []any{map[string]any{"requestId": requestID, "payload": payload, "deadlineAt": time.Now().Add(30 * time.Second).UnixMilli()}}})
				case <-request.Context().Done():
				}
				return
			}
			<-request.Context().Done()
		case "/api/ssh-workspaces/agent/relay/ack":
			writeAgentJSON(writer, 200, map[string]any{"ok": true, "accepted": true, "epoch": nextEpoch})
		case "/api/ssh-workspaces/agent/relay/heartbeat":
			var heartbeat struct {
				Epoch string `json:"epoch"`
			}
			_ = json.NewDecoder(request.Body).Decode(&heartbeat)
			if heartbeats.Add(1) == 1 {
				if heartbeat.Epoch != relayV2TestEpoch {
					t.Error("first heartbeat did not capture initial epoch", heartbeat.Epoch)
				}
				close(firstHeartbeat)
				select {
				case <-localStarted:
					// The receive loop has already adopted nextEpoch and dispatched
					// its read. This old response must not revoke the newer work.
					writeAgentJSON(writer, 200, map[string]any{"ok": true, "epoch": relayV2TestEpoch, "obsoleteRequestIds": []string{requestID}})
				case <-request.Context().Done():
				}
				return
			}
			writeAgentJSON(writer, 200, map[string]any{"ok": true, "epoch": nextEpoch, "obsoleteRequestIds": []string{}})
			select {
			case currentHeartbeat <- heartbeat.Epoch:
			default:
			}
		case "/api/ssh-workspaces/agent/relay/result":
			_, _ = io.Copy(io.Discard, request.Body)
			writeAgentJSON(writer, 200, map[string]any{"ok": true, "accepted": false, "epoch": nextEpoch})
		default:
			t.Error("unexpected delayed heartbeat endpoint", request.URL.Path)
			http.NotFound(writer, request)
		}
	})
	relayV2TestNative(t, local)
	select {
	case epoch := <-currentHeartbeat:
		if epoch != nextEpoch {
			t.Fatal("delayed old heartbeat rolled native session back", epoch)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("newer poll epoch did not retain its independent heartbeat")
	}
	select {
	case <-localCancelled:
		t.Fatal("delayed old heartbeat cancelled a read from the newer epoch")
	default:
	}
}

func TestSshRelayV2StaleCredentialRejectionRetriesTheCurrentAccount(t *testing.T) {
	var polls, registrations atomic.Int32
	currentPoll := make(chan struct{})
	var currentOnce sync.Once
	local := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		t.Error("credential recovery executed unexpected workspace operation")
		writeAgentJSON(writer, 200, map[string]any{"ok": true})
	}))
	t.Cleanup(local.Close)
	var connection *serverConnection
	connection = accountWorkspaceFixture(t, func(writer http.ResponseWriter, request *http.Request) {
		switch request.URL.Path {
		case "/api/ssh-workspaces/agent/connections":
			registrations.Add(1)
			relayV2TestRegistration(writer, request)
		case "/api/ssh-workspaces/agent/relay/poll":
			if request.URL.Query().Get("wait") == "0" {
				relayV2TestPoll(writer)
				return
			}
			switch polls.Add(1) {
			case 1:
				serverConnectionMu.Lock()
				connection.accessToken = "refreshed.payload.signature"
				serverConnectionMu.Unlock()
				writer.Header().Set("X-Auth-Error", "session-expired")
				writeAgentJSON(writer, 401, map[string]any{"code": "AUTH_TOKEN_EXPIRED", "error": "captured token expired"})
			case 2:
				if request.Header.Get("Authorization") != "Bearer refreshed.payload.signature" {
					t.Error("reconnect reused the rejected credential snapshot")
				}
				relayV2TestPoll(writer)
				currentOnce.Do(func() { close(currentPoll) })
			default:
				<-request.Context().Done()
			}
		case "/api/ssh-workspaces/agent/relay/heartbeat":
			writeAgentJSON(writer, 200, map[string]any{"ok": true, "epoch": relayV2TestEpoch, "obsoleteRequestIds": []string{}})
		default:
			t.Error("unexpected credential test endpoint", request.URL.Path)
			http.NotFound(writer, request)
		}
	})
	manager, profile := relayV2TestNative(t, local)
	select {
	case <-currentPoll:
	case <-time.After(5 * time.Second):
		t.Fatal("a stale credential response permanently stopped the Agent")
	}
	waitSshState(t, manager, mustSshScope(t), profile.ID, "forwarding")
	if registrations.Load() != 1 || connection.ctx.Err() != nil {
		t.Fatal("stale credential response replaced the current account or Agent registration", registrations.Load(), connection.ctx.Err())
	}
}

func TestSshRelayV2LocalReadDeadlineCancelsWithoutReplay(t *testing.T) {
	var delivered atomic.Bool
	var executions atomic.Int32
	localStarted := make(chan struct{})
	localCancelled := make(chan struct{})
	var startOnce, cancelledOnce sync.Once
	local := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		_, _ = io.Copy(io.Discard, request.Body)
		executions.Add(1)
		startOnce.Do(func() { close(localStarted) })
		<-request.Context().Done()
		cancelledOnce.Do(func() { close(localCancelled) })
	}))
	t.Cleanup(local.Close)
	payload := json.RawMessage(`{"protocol":1,"rootPath":"C:\\workspace","generation":"deadline-test","request":{"op":"read","path":"slow.txt"}}`)
	accountWorkspaceFixture(t, func(writer http.ResponseWriter, request *http.Request) {
		switch request.URL.Path {
		case "/api/ssh-workspaces/agent/connections":
			relayV2TestRegistration(writer, request)
		case "/api/ssh-workspaces/agent/relay/poll":
			if request.URL.Query().Get("wait") == "0" {
				relayV2TestPoll(writer)
				return
			}
			if delivered.CompareAndSwap(false, true) {
				relayV2TestPoll(writer, map[string]any{"requestId": "fd42b99f-e846-43ce-8e4d-c8a46fa713b5", "payload": payload, "deadlineAt": time.Now().Add(500 * time.Millisecond).UnixMilli()})
				return
			}
			<-request.Context().Done()
		case "/api/ssh-workspaces/agent/relay/ack":
			writeAgentJSON(writer, 200, map[string]any{"ok": true, "accepted": true, "epoch": relayV2TestEpoch})
		case "/api/ssh-workspaces/agent/relay/result":
			_, _ = io.Copy(io.Discard, request.Body)
			writeAgentJSON(writer, 200, map[string]any{"ok": true, "accepted": false, "epoch": relayV2TestEpoch})
		case "/api/ssh-workspaces/agent/relay/heartbeat":
			writeAgentJSON(writer, 200, map[string]any{"ok": true, "epoch": relayV2TestEpoch, "obsoleteRequestIds": []string{}})
		default:
			t.Error("unexpected deadline test endpoint", request.URL.Path)
			http.NotFound(writer, request)
		}
	})
	relayV2TestNative(t, local)
	select {
	case <-localStarted:
	case <-time.After(3 * time.Second):
		t.Fatal("deadline read did not start")
	}
	select {
	case <-localCancelled:
	case <-time.After(3 * time.Second):
		t.Fatal("expired broker deadline left local HTTP read running")
	}
	if executions.Load() != 1 {
		t.Fatal(fmt.Sprintf("read deadline caused %d executions", executions.Load()))
	}
}
