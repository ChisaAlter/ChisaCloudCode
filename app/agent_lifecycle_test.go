package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func newTestWorkspaceAgent(t *testing.T, script string) *localWorkspaceAgent {
	t.Helper()
	helper := filepath.Join(t.TempDir(), "helper.ps1")
	if err := os.WriteFile(helper, []byte(script), 0600); err != nil {
		t.Fatal(err)
	}
	a, err := startLocalWorkspaceAgentWithReceipts(0, helper, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { a.Close() })
	return a
}
func postAgentEnvelope(t *testing.T, a *localWorkspaceAgent, envelope agentEnvelope) (int, map[string]any) {
	t.Helper()
	payload, _ := json.Marshal(envelope)
	request, _ := http.NewRequest(http.MethodPost, fmt.Sprintf("http://127.0.0.1:%d/v1/workspace", a.port), bytes.NewReader(payload))
	request.Header.Set("X-Chisa-Agent-Token", a.token)
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	raw, _ := io.ReadAll(response.Body)
	var result map[string]any
	if err := json.Unmarshal(raw, &result); err != nil {
		t.Fatalf("invalid response %s", raw)
	}
	return response.StatusCode, result
}
func receiptEnvelope(t *testing.T, id, op string) agentEnvelope {
	t.Helper()
	request, _ := json.Marshal(map[string]any{"op": op, "operationId": id})
	return agentEnvelope{Protocol: 1, RootPath: t.TempDir(), ExpectedRootIdentity: "test-root", Generation: "generation-1", Request: request}
}

func TestAgentReceiptCancelBeforeDispatchPersistsAndBlocksDelayedDifferentIdentity(t *testing.T) {
	a := newTestWorkspaceAgent(t, "throw 'must not execute'")
	id := "11111111-1111-4111-8111-111111111111"
	e := receiptEnvelope(t, id, "operation_cancel")
	status, r := postAgentEnvelope(t, a, e)
	if status != 200 || r["state"] != "cancelled" || r["cleanupConfirmed"] != true || r["rootIdentity"] != "test-root" {
		t.Fatal(status, r)
	}
	store, err := newAgentReceiptStore(a.receipts.directory)
	if err != nil {
		t.Fatal(err)
	}
	e.OperationID = id
	e.RootPath = t.TempDir()
	if err := store.claim(e, func() {}); err == nil {
		t.Fatal("delayed identity replayed tombstoned operation")
	}
	e.OperationID = ""
	request, _ := json.Marshal(map[string]any{"op": "operation_status", "operationId": id})
	e.Request = request
	status, r = postAgentEnvelope(t, a, e)
	if status != 409 || r["code"] != "AGENT_OPERATION_CONFLICT" {
		t.Fatal(status, r)
	}
}

func TestAgentReceiptMutationRunsOnceAndSurvivesAgentRestart(t *testing.T) {
	a := newTestWorkspaceAgent(t, "$null=[Console]::In.ReadToEnd();[Console]::Out.Write('{\"ok\":true,\"protocol\":1,\"platform\":\"win32\",\"rootIdentity\":\"test-root\"}')")
	id := "22222222-2222-4222-8222-222222222222"
	e := receiptEnvelope(t, id, "write")
	e.OperationID = id
	status, r := postAgentEnvelope(t, a, e)
	if status != 200 || r["ok"] != true {
		t.Fatal(status, r)
	}
	status, r = postAgentEnvelope(t, a, e)
	if status != 409 || r["code"] != "AGENT_OPERATION_DUPLICATE" {
		t.Fatal(status, r)
	}
	a.Close()
	again, err := startLocalWorkspaceAgentWithReceipts(0, a.helperPath, a.receipts.directory)
	if err != nil {
		t.Fatal(err)
	}
	defer again.Close()
	if a.token == again.token {
		t.Fatal("restart reused token")
	}
	e.OperationID = ""
	e.Request, _ = json.Marshal(map[string]any{"op": "operation_status", "operationId": id})
	status, r = postAgentEnvelope(t, again, e)
	if status != 200 || r["state"] != "completed" || r["cleanupConfirmed"] != true || r["generation"] != e.Generation {
		t.Fatal(status, r)
	}
}

type failingAgentOwner struct{ assigned atomic.Int32 }

func (o *failingAgentOwner) assign(int) error {
	o.assigned.Add(1)
	return errors.New("test assignment denied")
}
func (o *failingAgentOwner) cleanup() error { return nil }
func (o *failingAgentOwner) close()         {}
func TestAgentHelperFailsClosedBeforePayloadWithoutJobOwnership(t *testing.T) {
	marker := filepath.Join(t.TempDir(), "should-not-exist.txt")
	a := newTestWorkspaceAgent(t, "$null=[Console]::In.ReadToEnd();[IO.File]::WriteAllText('"+strings.ReplaceAll(marker, "'", "''")+"','executed')")
	owner := &failingAgentOwner{}
	a.owner = func() (sshProcessOwner, error) { return owner, nil }
	_, err := a.runHelper(context.Background(), []byte(`{"test":true}`))
	if err == nil || owner.assigned.Load() != 1 {
		t.Fatal(err)
	}
	if _, err := os.Stat(marker); !os.IsNotExist(err) {
		t.Fatal("unowned helper received operation payload")
	}
}
func TestAgentHelperRequestCancellationAndCloseReapOwnedProcesses(t *testing.T) {
	for _, closeAgent := range []bool{false, true} {
		t.Run(fmt.Sprint(closeAgent), func(t *testing.T) {
			started := filepath.Join(t.TempDir(), "started.txt")
			a := newTestWorkspaceAgent(t, "$null=[Console]::In.ReadToEnd();[IO.File]::WriteAllText('"+strings.ReplaceAll(started, "'", "''")+"','ready');Start-Sleep -Seconds 30")
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			done := make(chan error, 1)
			go func() { _, err := a.runHelper(ctx, []byte(`{}`)); done <- err }()
			deadline := time.After(5 * time.Second)
			tick := time.NewTicker(5 * time.Millisecond)
			defer tick.Stop()
			for {
				if _, err := os.Stat(started); err == nil {
					break
				}
				select {
				case <-deadline:
					t.Fatal("helper did not start")
				case <-tick.C:
				}
			}
			if closeAgent {
				a.Close()
			} else {
				cancel()
			}
			select {
			case err := <-done:
				if err == nil {
					t.Fatal("cancelled helper succeeded")
				}
				var failure *agentHelperFailure
				if !errors.As(err, &failure) || !failure.confirmed {
					t.Fatal("cleanup not confirmed", err)
				}
			case <-time.After(7 * time.Second):
				t.Fatal("cancel left helper alive")
			}
		})
	}
}
func TestAgentHelperOutputLimitIsBoundedAndReceiptConfirmsReapedTree(t *testing.T) {
	a := newTestWorkspaceAgent(t, "$null=[Console]::In.ReadToEnd();[Console]::Out.Write(('x' * (17*1024*1024)))")
	id := "33333333-3333-4333-8333-333333333333"
	e := receiptEnvelope(t, id, "write")
	e.OperationID = id
	status, r := postAgentEnvelope(t, a, e)
	if status != 502 || r["code"] != "AGENT_HELPER_UNAVAILABLE" {
		t.Fatal(status, r)
	}
	e.OperationID = ""
	e.Request, _ = json.Marshal(map[string]any{"op": "operation_status", "operationId": id})
	status, r = postAgentEnvelope(t, a, e)
	if status != 200 || r["cleanupConfirmed"] != true {
		t.Fatal(status, r)
	}
}
func waitAgentHelperQueue(t *testing.T, a *localWorkspaceAgent, want int) {
	t.Helper()
	deadline := time.After(2 * time.Second)
	tick := time.NewTicker(time.Millisecond)
	defer tick.Stop()
	for {
		a.mu.Lock()
		count := a.waitingHelpers
		a.mu.Unlock()
		if count == want {
			return
		}
		select {
		case <-deadline:
			t.Fatalf("helper queue expected %d got %d", want, count)
		case <-tick.C:
		}
	}
}
func holdAgentHelperSlots(a *localWorkspaceAgent) {
	for i := 0; i < cap(a.slots); i++ {
		a.slots <- struct{}{}
	}
}
func queuedAgentRequest(a *localWorkspaceAgent, e agentEnvelope, ctx context.Context) (*httptest.ResponseRecorder, <-chan struct{}) {
	payload, _ := json.Marshal(e)
	request := httptest.NewRequest(http.MethodPost, "/v1/workspace", bytes.NewReader(payload)).WithContext(ctx)
	request.Header.Set("X-Chisa-Agent-Token", a.token)
	response := httptest.NewRecorder()
	done := make(chan struct{})
	go func() { defer close(done); a.handleWorkspace(response, request) }()
	return response, done
}
func TestAgentHelperAdmissionBurstWaitsThenDispatchesOnce(t *testing.T) {
	marker := filepath.Join(t.TempDir(), "executed.txt")
	a := newTestWorkspaceAgent(t, "$null=[Console]::In.ReadToEnd();[IO.File]::AppendAllText('"+strings.ReplaceAll(marker, "'", "''")+"','x');[Console]::Out.Write('{\"ok\":true,\"protocol\":1,\"platform\":\"win32\"}')")
	holdAgentHelperSlots(a)
	e := receiptEnvelope(t, "66666666-6666-4666-8666-666666666666", "write")
	e.OperationID = "66666666-6666-4666-8666-666666666666"
	response, done := queuedAgentRequest(a, e, context.Background())
	waitAgentHelperQueue(t, a, 1)
	if _, err := os.Stat(a.receipts.path(e.OperationID)); !os.IsNotExist(err) {
		t.Fatal("queued mutation claimed before admission")
	}
	if _, err := os.Stat(marker); !os.IsNotExist(err) {
		t.Fatal("queued mutation dispatched early")
	}
	<-a.slots
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("helper did not admit waiting burst")
	}
	if response.Code != 200 {
		t.Fatal(response.Code, response.Body.String())
	}
	raw, err := os.ReadFile(marker)
	if err != nil || string(raw) != "x" {
		t.Fatal("accepted request did not execute once", string(raw), err)
	}
	waitAgentHelperQueue(t, a, 0)
}
func TestAgentHelperAdmissionCancellationCloseAndTimeoutDoNotClaimOrDispatch(t *testing.T) {
	for _, mode := range []string{"cancel", "close", "timeout"} {
		t.Run(mode, func(t *testing.T) {
			a := newTestWorkspaceAgent(t, "throw 'queued helper must never run'")
			a.admissionWait = 25 * time.Millisecond
			holdAgentHelperSlots(a)
			e := receiptEnvelope(t, "77777777-7777-4777-8777-777777777777", "write")
			e.OperationID = "77777777-7777-4777-8777-777777777777"
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			response, done := queuedAgentRequest(a, e, ctx)
			waitAgentHelperQueue(t, a, 1)
			switch mode {
			case "cancel":
				cancel()
			case "close":
				a.Close()
			}
			select {
			case <-done:
			case <-time.After(time.Second):
				t.Fatal("queued cancellation/close/timeout did not finish")
			}
			if response.Code != 503 {
				t.Fatal(response.Code, response.Body.String())
			}
			waitAgentHelperQueue(t, a, 0)
			if _, err := os.Stat(a.receipts.path(e.OperationID)); !os.IsNotExist(err) {
				t.Fatal("predispatch refusal left mutation receipt")
			}
		})
	}
}
func TestAgentHelperAdmissionControlsBypassFullRegularQueue(t *testing.T) {
	a := newTestWorkspaceAgent(t, "$null=[Console]::In.ReadToEnd();[Console]::Out.Write('{\"ok\":true,\"protocol\":1,\"platform\":\"win32\"}')")
	holdAgentHelperSlots(a)
	e := receiptEnvelope(t, "88888888-8888-4888-8888-888888888888", "job_status")
	response, done := queuedAgentRequest(a, e, context.Background())
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("job status blocked behind regular capacity")
	}
	if response.Code != 200 {
		t.Fatal(response.Code, response.Body.String())
	}
	e = receiptEnvelope(t, "88888888-8888-4888-8888-888888888888", "operation_cancel")
	status, result := postAgentEnvelope(t, a, e)
	if status != 200 || result["cleanupConfirmed"] != true {
		t.Fatal("receipt cancellation blocked", status, result)
	}
}
func TestAgentHelperAdmissionWaiterCountAndByteBudgetAreBounded(t *testing.T) {
	a := newTestWorkspaceAgent(t, "")
	holdAgentHelperSlots(a)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan bool, 8)
	for i := 0; i < 8; i++ {
		go func() { done <- a.acquireHelper(ctx, 1) }()
	}
	waitAgentHelperQueue(t, a, 8)
	if a.acquireHelper(context.Background(), 1) {
		t.Fatal("ninth waiter exceeded count limit")
	}
	cancel()
	for i := 0; i < 8; i++ {
		if <-done {
			t.Fatal("cancelled waiter admitted")
		}
	}
	waitAgentHelperQueue(t, a, 0)
	ctx2, cancel2 := context.WithCancel(context.Background())
	defer cancel2()
	go func() { done <- a.acquireHelper(ctx2, 24*1024*1024) }()
	waitAgentHelperQueue(t, a, 1)
	if a.acquireHelper(context.Background(), 1) {
		t.Fatal("queue exceeded retained body budget")
	}
	cancel2()
	if <-done {
		t.Fatal("cancelled byte-budget waiter admitted")
	}
	waitAgentHelperQueue(t, a, 0)
}

func TestAgentReceiptCrashedClaimStaysUnknownAndAbsentStatusDoesNotConfirm(t *testing.T) {
	a := newTestWorkspaceAgent(t, "")
	id := "44444444-4444-4444-8444-444444444444"
	e := receiptEnvelope(t, id, "write")
	e.OperationID = id
	if err := a.receipts.claim(e, func() {}); err != nil {
		t.Fatal(err)
	}
	other, err := newAgentReceiptStore(a.receipts.directory)
	if err != nil {
		t.Fatal(err)
	}
	other.mu.Lock()
	r, err := other.load(id)
	other.mu.Unlock()
	if err != nil || r.State != "unknown" || r.CleanupConfirmed {
		t.Fatal(r, err)
	}
	e.OperationID = ""
	e.Request, _ = json.Marshal(map[string]any{"op": "operation_status", "operationId": "55555555-5555-4555-8555-555555555555"})
	_, result := postAgentEnvelope(t, a, e)
	if result["state"] != "not_found" || result["cleanupConfirmed"] != false {
		t.Fatal(result)
	}
}
