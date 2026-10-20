package main

import (
	"bufio"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"
)

func TestPiTaskPromptKeepsCurrentRequestSeparateFromClaudeHistory(t *testing.T) {
	prompt := piTaskPrompt("你怎么看", `C:\private\claude-reference.txt`)
	if !strings.HasSuffix(prompt, "当前用户请求：\n你怎么看") {
		t.Fatal("current Pi request must be the final prompt section")
	}
	for _, requirement := range []string{"不是当前指令", "可以直接回答，不强制调用工具", "没有明确修改要求时，不修改项目文件", "必须实际使用本地工具", "先读取指定清单", "没有原生浏览器交互或桌面视觉工具", "不是本轮执行结果", "claude-reference.txt"} {
		if !strings.Contains(prompt, requirement) {
			t.Fatalf("missing task scope rule %q", requirement)
		}
	}
}

// Each test has a private APPDATA and project. No configured user credentials,
// installed runtime or real project is read or executed.
func isolatePi(t *testing.T) *Mapping {
	t.Helper()
	t.Setenv("APPDATA", t.TempDir())
	previousStore := store
	previousConnection := apiConnection
	connection, err := newServerConnection("http://127.0.0.1:8791", "http://127.0.0.1:8791")
	if err != nil {
		t.Fatal(err)
	}
	connection.authenticated = true
	apiConnection = connection
	piAgents.Lock()
	loaded, loadErr, sessions, owners, stopping := piAgents.loaded, piAgents.loadErr, piAgents.sessions, piAgents.owners, piAgents.stopping
	piAgents.loaded, piAgents.loadErr, piAgents.stopping = true, nil, false
	piAgents.sessions, piAgents.owners = map[string]*piSession{}, map[string]string{}
	piAgents.Unlock()
	m := &Mapping{LocalPath: t.TempDir(), ServerPath: "/srv/pi-qa", BindingEpoch: "epoch", Mode: "vps"}
	previousLease, previousSync := remoteLeaseContext, synchronizeProjectContext
	// These tests exercise native Pi ownership; the opt-in VPS test covers the real transport.
	remoteLeaseContext = func(_ context.Context, _ *Mapping, _, _, _ string) (map[string]any, error) {
		return map[string]any{"ok": true}, nil
	}
	synchronizeProjectContext = func(_ context.Context, _ *Mapping, _ bool) error { return nil }
	store = &Store{Cfg: Config{ServerURL: "http://example.test:8791", WorkspaceServerURL: "http://example.test:8791"}, Mappings: []*Mapping{m}}
	m.ServerID = serverIdentity(store.config())
	t.Cleanup(func() {
		// Released ownership is visible before the handback's final sync
		// publication. Drain its workspace lock before restoring globals.
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		unlock, err := lockWorkspace(ctx, m.ServerPath)
		if err != nil {
			t.Errorf("Pi handback still held the fixture workspace during cleanup: %v", err)
		} else {
			defer unlock()
		}
		piAgents.Lock()
		piAgents.loaded, piAgents.loadErr, piAgents.sessions, piAgents.owners, piAgents.stopping = loaded, loadErr, sessions, owners, stopping
		piAgents.Unlock()
		store = previousStore
		connection.cancel()
		apiConnection = previousConnection
		remoteLeaseContext, synchronizeProjectContext = previousLease, previousSync
		workspaceLocks.Delete(m.ServerPath)
	})
	return m
}

func waitPi(t *testing.T, condition func() bool) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if condition() {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("Pi condition did not settle")
}

// The only simulated RPC is get_state. Model/tool events below use official
// protocol shapes; root separately validates the installed official Pi RPC.
type piStateReply struct {
	s      *piSession
	p      *piProcess
	mu     sync.Mutex
	closed bool
	queue  float64
}

func (w *piStateReply) Write(raw []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.closed {
		return 0, errors.New("closed")
	}
	var command map[string]any
	if err := json.Unmarshal(raw, &command); err != nil {
		return 0, err
	}
	if command["type"] != "get_state" {
		return 0, errors.New("unexpected RPC")
	}
	id, _ := command["id"].(string)
	w.p.mu.Lock()
	response := w.p.pending[id]
	w.p.mu.Unlock()
	response <- map[string]any{"success": true, "data": map[string]any{
		"isStreaming": false, "isCompacting": false, "pendingMessageCount": w.queue,
		"sessionFile": filepath.Join(piSessionDirectory(w.s.SessionID), "original.jsonl"),
	}}
	return len(raw), nil
}

func (w *piStateReply) Close() error {
	w.mu.Lock()
	defer w.mu.Unlock()
	if !w.closed {
		w.closed = true
		piAgents.Lock()
		w.s.process = nil
		piAgents.Unlock()
		close(w.p.done)
	}
	return nil
}

func seedPi(m *Mapping, id string) (*piSession, *piStateReply) {
	s := &piSession{SessionID: id, ServerPath: m.ServerPath, BindingEpoch: m.BindingEpoch, Owner: "pi", Running: true, Messages: []piMessage{}, Events: []piEvent{}, assistant: -1, blocks: map[int]string{}, toolPaths: map[string]string{}, changedFiles: map[string]bool{}, runID: 1}
	p := &piProcess{done: make(chan struct{}), pending: map[string]chan map[string]any{}, guard: &piProcessGuard{}}
	w := &piStateReply{s: s, p: p}
	p.stdin, s.process = w, p
	piAgents.Lock()
	piAgents.sessions[id], piAgents.owners[m.ServerPath] = s, id
	piAgents.Unlock()
	return s, w
}

func finishPi(s *piSession, text, reason, modelError string) {
	p := s.process
	piHandleEvent(s, p, map[string]any{"type": "message_start", "message": map[string]any{"role": "assistant", "content": []any{}}})
	piHandleEvent(s, p, map[string]any{"type": "message_end", "message": map[string]any{"role": "assistant", "content": []any{map[string]any{"type": "text", "text": text}}, "stopReason": reason, "errorMessage": modelError}})
	piHandleEvent(s, p, map[string]any{"type": "agent_settled"})
}

func TestPiClaimSerializesAndBlocksCloudMutations(t *testing.T) {
	m := isolatePi(t)
	handbackEntered := make(chan struct{})
	allowHandback := make(chan struct{})
	var handbackOnce sync.Once
	unblockHandback := func() { handbackOnce.Do(func() { close(allowHandback) }) }
	synchronizeProjectContext = func(ctx context.Context, _ *Mapping, pause bool) error {
		if pause {
			return nil
		}
		close(handbackEntered)
		select {
		case <-allowHandback:
			return nil
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	// Drain the handback before isolatePi restores the globals it still uses,
	// including when an assertion below fails while synchronization is gated.
	drainHandback := func() {
		unblockHandback()
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		unlock, err := lockWorkspace(ctx, m.ServerPath)
		if err != nil {
			t.Errorf("startup handback did not leave the workspace mutex: %v", err)
			return
		}
		unlock()
	}
	t.Cleanup(drainHandback)
	lock, _ := workspaceLocks.LoadOrStore(m.ServerPath, &sync.Mutex{})
	mu := lock.(*sync.Mutex)
	mu.Lock()
	result := make(chan map[string]any, 1)
	entered := make(chan struct{})
	go func() {
		close(entered)
		result <- (FrontendBridge{}).PiPrompt(m.ServerPath, "manual-A", "task", "", nil)
	}()
	<-entered
	select {
	case <-result:
		mu.Unlock()
		t.Fatal("claim bypassed workspace mutation mutex")
	case <-time.After(20 * time.Millisecond):
	}
	if piWorkspaceOwned(m.ServerPath) {
		mu.Unlock()
		t.Fatal("ownership changed before earlier mutation finished")
	}
	mu.Unlock()
	if accepted := <-result; accepted["accepted"] != true {
		t.Fatalf("claim rejected: %v", accepted)
	}
	select {
	case <-handbackEntered:
	case <-time.After(3 * time.Second):
		t.Fatal("startup failure did not enter workspace handback")
	}
	// Running=false only means startup ended. Its reservation must remain until
	// the unified handback finishes, even though no runtime was created.
	state := (FrontendBridge{}).PiGetSession(m.ServerPath, "manual-A")
	last, ok := state["lastResult"].(map[string]any)
	if !ok || last["status"] != "error" || last["error"] == "" || last["workspaceStatus"] != "syncing" || state["running"] != false || state["runtimeActive"] != false || state["owner"] != "pi" || state["ownerSessionId"] != "manual-A" || !piWorkspaceOwned(m.ServerPath) {
		t.Fatalf("startup failure lost its error or reservation during handback: %v", state)
	}
	mutations := []string{"write", "mkdir", "rename", "copy", "remove", "exec", "preview_start"}
	for _, op := range mutations {
		ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
		response := workspaceRPCContext(ctx, m, map[string]any{"op": op})
		cancel()
		if response["ok"] != false || response["code"] != "WORKSPACE_UNAVAILABLE" {
			t.Fatalf("%s bypassed the gated handback mutex: %v", op, response)
		}
	}
	unblockHandback()
	waitPi(t, func() bool {
		view := (FrontendBridge{}).PiGetSession(m.ServerPath, "manual-A")
		result, _ := view["lastResult"].(map[string]any)
		return view["owner"] == "claude" && result["workspaceStatus"] == "released"
	})
	drainHandback()
	// Missing private QA model config remains a startup error after handback.
	state = (FrontendBridge{}).PiGetSession(m.ServerPath, "manual-A")
	if state["lastResult"].(map[string]any)["status"] != "error" || state["running"] != false || state["runtimeActive"] != false || piWorkspaceOwned(m.ServerPath) {
		t.Fatalf("startup failure was masked or retained its completed reservation: %v", state)
	}
	s, _ := seedPi(m, "manual-A")
	for _, op := range mutations {
		response := workspaceRPC(m, map[string]any{"op": op})
		if !reflect.DeepEqual(response, map[string]any{"ok": false, "error": "Workspace is busy", "code": "WORKSPACE_BUSY"}) {
			t.Fatalf("%s was not blocked with a generic busy response: %v", op, response)
		}
	}
	if state := (FrontendBridge{}).PiGetSession(m.ServerPath, "other-B"); state["owner"] != "pi" || state["ownerSessionId"] != "manual-A" {
		t.Fatal("cross-session project owner was hidden")
	}
	if response := (FrontendBridge{}).PiPrompt(m.ServerPath, s.SessionID, "next task", "", nil); response["code"] != "PI_BUSY" {
		t.Fatal("active project reservation accepted an overlapping native task")
	}
	if response := (FrontendBridge{}).PiAbort(m.ServerPath, s.SessionID); response["owner"] != "claude" {
		t.Fatal("native abort did not release the project reservation")
	}
}

func TestPiSettledAutomaticallyReleasesOnlyIdleQueue(t *testing.T) {
	for _, pending := range []float64{0, 1} {
		t.Run(fmt.Sprintf("pending-%g", pending), func(t *testing.T) {
			m := isolatePi(t)
			s, w := seedPi(m, "settled-session")
			w.queue = pending
			finishPi(s, "task summary", "stop", "")
			waitPi(t, func() bool {
				piAgents.Lock()
				defer piAgents.Unlock()
				return s.SessionFile != "" && (pending != 0 || s.Owner == "claude")
			})
			state := (FrontendBridge{}).PiGetSession(m.ServerPath, s.SessionID)
			if state["running"] != false || state["runtimeActive"] != true || state["lastResult"].(map[string]any)["status"] != "completed" {
				t.Fatal("settled model killed idle runtime or misreported state")
			}
			if pending != 0 {
				if state["owner"] != "pi" || !piWorkspaceOwned(m.ServerPath) {
					t.Fatal("pending queue released the project reservation")
				}
				if response := (FrontendBridge{}).PiPrompt(m.ServerPath, s.SessionID, "next task", "", nil); response["code"] != "PI_BUSY" {
					t.Fatal("settled but pending queue accepted an overlapping native task")
				}
				w.mu.Lock()
				w.queue = 0
				w.mu.Unlock()
				piAfterSettled(s, s.process, s.runID)
			}
			state = (FrontendBridge{}).PiGetSession(m.ServerPath, s.SessionID)
			if state["owner"] != "claude" || state["runtimeActive"] != true || piWorkspaceOwned(m.ServerPath) {
				t.Fatal("idle settlement failed to automatically release reservation or closed runtime")
			}
			before, _ := json.Marshal(state["lastResult"])
			response := (FrontendBridge{}).PiAbort(m.ServerPath, s.SessionID)
			after, _ := json.Marshal(response["lastResult"])
			if response["ok"] != true || response["runtimeActive"] != false || response["owner"] != "claude" || string(before) != string(after) {
				t.Fatal("idle stop did not stop runtime or rewrote completed task result")
			}
		})
	}
}

func TestPiLengthTerminationIsUnfinishedAndPreservesHandback(t *testing.T) {
	for _, task := range []struct {
		name, content, reason, status string
	}{
		{"empty-length", "", "length", "error"},
		{"partial-length", "已读取插件说明，尚未安装。", "length", "error"},
		{"empty-stop", "", "stop", "error"},
		{"normal-stop", "本轮任务已完成。", "stop", "completed"},
		{"aborted", "任务停止前的部分内容。", "aborted", "aborted"},
	} {
		t.Run(task.name, func(t *testing.T) {
			m := isolatePi(t)
			s, w := seedPi(m, "termination-result")
			t.Cleanup(func() { _ = w.Close() })
			s.LeaseID = "termination-exact-lease"
			content := []any{}
			if task.content != "" {
				content = append(content, map[string]any{"type": "text", "text": task.content})
			}
			piHandleEvent(s, s.process, map[string]any{"type": "message_start", "message": map[string]any{"role": "assistant", "content": []any{}}})
			piHandleEvent(s, s.process, map[string]any{"type": "message_end", "message": map[string]any{"role": "assistant", "content": content, "stopReason": task.reason}})
			piHandleEvent(s, s.process, map[string]any{"type": "agent_settled"})
			waitPi(t, func() bool {
				view := (FrontendBridge{}).PiGetSession(m.ServerPath, s.SessionID)
				last, _ := view["lastResult"].(map[string]any)
				return view["owner"] == "claude" && last["workspaceStatus"] == "released"
			})
			view := (FrontendBridge{}).PiGetSession(m.ServerPath, s.SessionID)
			last := view["lastResult"].(map[string]any)
			if last["status"] != task.status || last["content"] != task.content {
				t.Fatalf("terminal outcome lost completion status or partial content: %v", last)
			}
			if task.reason == "length" {
				message, _ := last["error"].(string)
				if !strings.Contains(message, "长度上限") || !strings.Contains(message, "未完成") {
					t.Fatalf("truncation does not explain why the task is unfinished: %q", message)
				}
			}
			messages := view["messages"].([]piMessage)
			if len(messages) != 1 || messages[0].Content != task.content {
				t.Fatal("final assistant history lost partial content")
			}
			if view["running"] != false || view["runtimeActive"] != true || s.LeaseID != "" || piWorkspaceOwned(m.ServerPath) {
				t.Fatal("terminal result altered idle runtime or automatic workspace handback")
			}
		})
	}
}

func TestPiHandoffFailureCursorAndExplicitRecovery(t *testing.T) {
	m := isolatePi(t)
	s, _ := seedPi(m, "handoff-recovery")
	s.Running, s.LeaseID = false, "pi-exact-lease"
	s.LastResult = map[string]any{"status": "completed", "content": "model finished"}
	before := s.Cursor
	synchronizeProjectContext = func(ctx context.Context, actual *Mapping, pause bool) error {
		id, _ := ctx.Value(syncLeaseContextKey{}).(string)
		if id != s.LeaseID || actual.BindingEpoch != m.BindingEpoch || pause {
			t.Fatal("Pi handback did not carry its exact reservation")
		}
		return errors.New("return synchronization failed")
	}
	if err := piReleaseWorkspace(s, s.runID); err == nil {
		t.Fatal("failed Pi handback reported success")
	}
	view := (FrontendBridge{}).PiEvents(m.ServerPath, s.SessionID, before)
	last, ok := view["lastResult"].(map[string]any)
	if !ok || last["status"] != "completed" || last["workspaceStatus"] != "failed" || last["workspaceError"] == "" || view["owner"] != "pi" || s.LeaseID == "" || !piWorkspaceOwned(m.ServerPath) {
		t.Fatalf("handoff failure lost outcome, cursor update or reservation: %v", view)
	}
	synchronizeProjectContext = func(context.Context, *Mapping, bool) error { return nil }
	remoteLeaseContext = func(context.Context, *Mapping, string, string, string) (map[string]any, error) {
		return nil, errors.New("lease release failed")
	}
	view = (FrontendBridge{}).PiRecoverSession(m.ServerPath, s.SessionID)
	if view["ok"] != false || view["owner"] != "pi" || view["lastResult"].(map[string]any)["workspaceStatus"] != "failed" || s.LeaseID == "" {
		t.Fatal("retry failure returned no session view or falsely unlocked ownership")
	}
	remoteLeaseContext = func(_ context.Context, _ *Mapping, op, _ string, id string) (map[string]any, error) {
		if op != "release" || id != "pi-exact-lease" {
			t.Fatal("recovery released a nonmatching reservation")
		}
		return map[string]any{"ok": true}, nil
	}
	view = (FrontendBridge{}).PiRecoverSession(m.ServerPath, s.SessionID)
	if view["ok"] != true || view["owner"] != "claude" || view["runtimeActive"] != true || view["lastResult"].(map[string]any)["workspaceStatus"] != "released" || s.LeaseID != "" || piWorkspaceOwned(m.ServerPath) {
		t.Fatalf("explicit handback recovery replayed/stopped runtime or did not release: %v", view)
	}
}

func TestPiRecoveryOnlyBlocksNewPromptButKeepsSessionHandback(t *testing.T) {
	m := isolatePi(t)
	serverConnectionMu.Lock()
	apiConnection.workspaceRecoveryOnly = true
	serverConnectionMu.Unlock()
	leaseOperations := []string{}
	remoteLeaseContext = func(_ context.Context, actual *Mapping, op, _ string, id string) (map[string]any, error) {
		if actual.BindingEpoch != m.BindingEpoch || op != "release" || id != "recovery-only-exact-lease" {
			t.Fatalf("recovery used the wrong mapping or admitted a new lease: op=%s id=%s", op, id)
		}
		leaseOperations = append(leaseOperations, op)
		return map[string]any{"ok": true}, nil
	}
	syncCalls := 0
	synchronizeProjectContext = func(ctx context.Context, actual *Mapping, pause bool) error {
		id, _ := ctx.Value(syncLeaseContextKey{}).(string)
		if actual.BindingEpoch != m.BindingEpoch || pause || id != "recovery-only-exact-lease" {
			t.Fatal("recovery did not resume synchronization under its original lease")
		}
		syncCalls++
		return nil
	}
	view := (FrontendBridge{}).PiPrompt(m.ServerPath, "recovery-only-new", "new task", "", nil)
	if view["ok"] != false || view["code"] != "SYNC_BLOCKED" || len(leaseOperations) != 0 || syncCalls != 0 || piWorkspaceOwned(m.ServerPath) {
		t.Fatalf("recovery-only transport admitted a new Pi task or acquired workspace ownership: %v", view)
	}
	s, writer := seedPi(m, "recovery-only-saved")
	t.Cleanup(func() { _ = writer.Close() })
	s.Running, s.LeaseID = false, "recovery-only-exact-lease"
	s.LastResult = map[string]any{"status": "completed", "content": "original task finished", "workspaceStatus": "failed"}
	for _, view := range []map[string]any{
		(FrontendBridge{}).PiGetSession(m.ServerPath, s.SessionID),
		(FrontendBridge{}).PiEvents(m.ServerPath, s.SessionID, 0),
	} {
		if view["ok"] != true || view["owner"] != "pi" || view["running"] != false || view["lastResult"].(map[string]any)["content"] != "original task finished" {
			t.Fatalf("recovery-only transport hid the original Pi session: %v", view)
		}
	}
	if len(leaseOperations) != 0 || syncCalls != 0 {
		t.Fatal("reading the original Pi session acquired or released its lease")
	}
	view = (FrontendBridge{}).PiRecoverSession(m.ServerPath, s.SessionID)
	if view["ok"] != true || view["owner"] != "claude" || view["running"] != false || view["runtimeActive"] != true || view["lastResult"].(map[string]any)["workspaceStatus"] != "released" || s.LeaseID != "" || piWorkspaceOwned(m.ServerPath) {
		t.Fatalf("recovery-only transport could not return the exact idle Pi lease: %v", view)
	}
	if syncCalls != 1 || !reflect.DeepEqual(leaseOperations, []string{"release"}) {
		t.Fatalf("recovery replayed admission or synchronization: sync=%d lease=%v", syncCalls, leaseOperations)
	}
}

func TestPiFailedPrepareReturnsRetainedOwnership(t *testing.T) {
	m := isolatePi(t)
	t.Cleanup(func() { syncStates.Delete(m.ServerPath) })
	claimed := ""
	remoteLeaseContext = func(_ context.Context, _ *Mapping, op, _, id string) (map[string]any, error) {
		if op == "claim" {
			claimed = id
			return map[string]any{"ok": true}, nil
		}
		if op != "release" || id != claimed {
			t.Fatal("failed preparation cleanup did not use its exact claim")
		}
		return nil, errors.New("prepare lease release not confirmed")
	}
	synchronizeProjectContext = func(context.Context, *Mapping, bool) error {
		return errors.New("preparation failed before model startup")
	}
	view := (FrontendBridge{}).PiPrompt(m.ServerPath, "failed-prepare", "do not start a model", "", nil)
	result, ok := view["lastResult"].(map[string]any)
	if claimed == "" || view["ok"] != false || view["code"] != "PI_HANDOFF_FAILED" || view["sessionId"] != "failed-prepare" || view["serverPath"] != m.ServerPath || view["owner"] != "pi" || view["ownerSessionId"] != "failed-prepare" || view["running"] != false || view["runtimeActive"] != false || !ok || result["workspaceStatus"] != "failed" || result["workspaceError"] != "prepare lease release not confirmed" {
		t.Fatalf("failed preparation reply omitted its authoritative retained ownership/recovery state: %v", view)
	}
	if !piWorkspaceOwned(m.ServerPath) || syncOperationInfo(m).Status != "blocked" {
		t.Fatal("failed preparation falsely released the workspace")
	}
}

func TestPiRestartLeaseKeepsVisibleRecovery(t *testing.T) {
	m := isolatePi(t)
	s := &piSession{SessionID: "restart-lease", ServerPath: m.ServerPath, BindingEpoch: m.BindingEpoch, Owner: "pi", LeaseID: "saved-lease"}
	piAgents.Lock()
	if err := piSaveLocked(s); err != nil {
		piAgents.Unlock()
		t.Fatal(err)
	}
	piAgents.loaded, piAgents.sessions, piAgents.owners = false, map[string]*piSession{}, map[string]string{}
	piAgents.Unlock()
	view := (FrontendBridge{}).PiGetSession(m.ServerPath, s.SessionID)
	result, ok := view["lastResult"].(map[string]any)
	if !ok || result["workspaceStatus"] != "failed" || result["workspaceError"] == "" || view["owner"] != "pi" || view["running"] != false || !piWorkspaceOwned(m.ServerPath) {
		t.Fatalf("restart hid the retained reservation's recovery entry: %v", view)
	}
}

func TestPiPersistenceRestartAndStaleBinding(t *testing.T) {
	m := isolatePi(t)
	s, _ := seedPi(m, "persistent")
	s.Messages = []piMessage{{ID: "history", Role: "assistant", Content: "prior completion"}}
	s.SessionFile = filepath.Join(piSessionDirectory(s.SessionID), "original.jsonl")
	piAgents.Lock()
	if err := piSaveLocked(s); err != nil {
		piAgents.Unlock()
		t.Fatal(err)
	}
	second := &piSession{SessionID: "interrupted-second", ServerPath: m.ServerPath, BindingEpoch: m.BindingEpoch, Owner: "pi", Running: true}
	if err := piSaveLocked(second); err != nil {
		piAgents.Unlock()
		t.Fatal(err)
	}
	piAgents.loaded, piAgents.sessions, piAgents.owners = false, map[string]*piSession{}, map[string]string{}
	piAgents.Unlock()
	state := (FrontendBridge{}).PiGetSession(m.ServerPath, s.SessionID)
	if state["owner"] != "claude" || state["running"] != false || state["runtimeActive"] != false || state["lastResult"].(map[string]any)["status"] != "aborted" || len(state["messages"].([]piMessage)) != 1 || piWorkspaceOwned(m.ServerPath) {
		t.Fatal("restart lost history, retained a dead reservation or claimed interrupted task succeeded")
	}
	piAgents.Lock()
	sessionPreserved := piAgents.sessions[s.SessionID].SessionFile == s.SessionFile
	secondRestored := piAgents.sessions[second.SessionID]
	secondReleased := secondRestored.Owner == "claude" && !secondRestored.Running && secondRestored.LastResult["status"] == "aborted"
	piAgents.loaded, piAgents.sessions, piAgents.owners = false, map[string]*piSession{}, map[string]string{}
	piAgents.Unlock()
	if !sessionPreserved {
		t.Fatal("original Pi session path was lost")
	}
	if !secondReleased {
		t.Fatal("interrupted native task retained ownership after restart")
	}
	store.Mappings[0].BindingEpoch = "replacement"
	if response := (FrontendBridge{}).PiGetSession(m.ServerPath, s.SessionID); response["code"] != "STALE_BINDING" || piWorkspaceOwned(m.ServerPath) {
		t.Fatal("stale record resumed or kept replacement binding owned")
	}
	if response := (FrontendBridge{}).PiGetSession("/srv/unbound", "valid"); response["code"] != "UNBOUND_WORKSPACE" {
		t.Fatal("unbound workspace was accepted")
	}
	if response := (FrontendBridge{}).PiGetSession(m.ServerPath, "../bad"); response["code"] != "INVALID_SESSION_ID" {
		t.Fatal("session path traversal was accepted")
	}
}

func TestPiProjectRevocationAndAppExitCleanup(t *testing.T) {
	m := isolatePi(t)
	other := &Mapping{LocalPath: t.TempDir(), ServerPath: "/srv/pi-other-qa", BindingEpoch: "other-epoch", ServerID: m.ServerID}
	store.Mappings = append(store.Mappings, other)
	t.Cleanup(func() { workspaceLocks.Delete(other.ServerPath) })
	first, _ := seedPi(m, "revoke-first")
	second, _ := seedPi(other, "retain-second")
	piAgents.Lock()
	first.Running, second.Running = false, false
	first.LastResult = map[string]any{"status": "completed", "content": "first result"}
	second.LastResult = map[string]any{"status": "completed", "content": "second result"}
	piAgents.Unlock()
	if err := stopProjectPi(m.ServerPath); err != nil {
		t.Fatal(err)
	}
	firstView := (FrontendBridge{}).PiGetSession(m.ServerPath, first.SessionID)
	secondView := (FrontendBridge{}).PiGetSession(other.ServerPath, second.SessionID)
	if firstView["runtimeActive"] != false || firstView["owner"] != "claude" || secondView["runtimeActive"] != true || secondView["owner"] != "pi" {
		t.Fatal("project revocation failed to scope runtime cleanup")
	}
	if err := stopAllPi(); err != nil {
		t.Fatal(err)
	}
	secondView = (FrontendBridge{}).PiGetSession(other.ServerPath, second.SessionID)
	if secondView["runtimeActive"] != false || secondView["owner"] != "claude" || secondView["lastResult"].(map[string]any)["content"] != "second result" {
		t.Fatal("app exit left runtime/reservation active or lost completed result")
	}
	if _, err := os.Stat(filepath.Join(piSessionDirectory(second.SessionID), "state.json")); err != nil {
		t.Fatal("cleanup removed durable Pi record")
	}
}

func TestPiIdleSessionStopPreservesOtherActiveReservation(t *testing.T) {
	m := isolatePi(t)
	idle, _ := seedPi(m, "idle-A")
	finishPi(idle, "prior result", "stop", "")
	waitPi(t, func() bool { return (FrontendBridge{}).PiGetSession(m.ServerPath, idle.SessionID)["owner"] == "claude" })
	active, _ := seedPi(m, "active-B")
	response := (FrontendBridge{}).PiAbort(m.ServerPath, idle.SessionID)
	if response["ok"] != true || response["runtimeActive"] != false || response["owner"] != "pi" || response["ownerSessionId"] != active.SessionID || response["running"] != true {
		t.Fatal("stopping an idle runtime changed another session's active reservation")
	}
	if response["lastResult"].(map[string]any)["content"] != "prior result" {
		t.Fatal("stopping idle runtime changed its completed result")
	}
	if response := (FrontendBridge{}).PiGetSession(m.ServerPath, active.SessionID); response["runtimeActive"] != true || response["running"] != true {
		t.Fatal("stopping an idle session stopped another native runtime")
	}
}

func TestPiCloudOperationsAreIndistinguishableFromUnknown(t *testing.T) {
	m := isolatePi(t)
	expected := workspaceRPC(m, map[string]any{"op": "unknown-operation"})
	for _, active := range []bool{false, true} {
		if active {
			seedPi(m, "private-local-session")
		}
		for _, op := range []string{"pi_start", "pi_status", "pi_stop", "pi_anything"} {
			response := workspaceRPC(m, map[string]any{"op": op, "sessionId": "private-local-session", "origin": "cloud", "message": "must never run"})
			if !reflect.DeepEqual(response, expected) {
				t.Fatalf("active=%t op=%s disclosed a native capability: %v", active, op, response)
			}
			raw, _ := json.Marshal(response)
			if strings.Contains(strings.ToLower(string(raw)), "pi") || response["messages"] != nil || response["events"] != nil || response["lastResult"] != nil {
				t.Fatalf("remote operation revealed local identity or state: %s", raw)
			}
		}
		piAgents.Lock()
		count := len(piAgents.sessions)
		piAgents.Unlock()
		if (!active && count != 0) || (active && count != 1) {
			t.Fatal("remote unknown operations created native session state")
		}
	}
}

func TestPiFreshLocalSessionRoundtripNull(t *testing.T) {
	m := isolatePi(t)
	response := (FrontendBridge{}).PiGetSession(m.ServerPath, "fresh-session")
	raw, err := json.Marshal(response)
	if err != nil {
		t.Fatal(err)
	}
	var decoded map[string]any
	if err := json.Unmarshal(raw, &decoded); err != nil {
		t.Fatal(err)
	}
	last, exists := decoded["lastResult"]
	if decoded["ok"] != true || !exists || last != nil {
		t.Fatalf("fresh local session must serialize lastResult as null: %s", raw)
	}
}

func TestPiObservedFailuresChangedFilesAndSecretRedaction(t *testing.T) {
	m := isolatePi(t)
	s, _ := seedPi(m, "failure-summary")
	s.secrets = []string{"synthetic-qa-secret"}
	for _, tc := range []struct {
		id, path string
		failed   bool
	}{{"write-ok", "src/ok.txt", false}, {"write-fail", "bad.txt", true}, {"outside", "../outside.txt", false}} {
		piHandleEvent(s, s.process, map[string]any{"type": "tool_execution_start", "toolCallId": tc.id, "toolName": "write", "args": map[string]any{"path": tc.path}})
		piHandleEvent(s, s.process, map[string]any{"type": "tool_execution_end", "toolCallId": tc.id, "toolName": "write", "isError": tc.failed, "result": map[string]any{"content": []any{map[string]any{"type": "text", "text": "write rejected"}}}})
	}
	piHandleEvent(s, s.process, map[string]any{"type": "tool_execution_end", "toolCallId": "shell-fail", "toolName": "powershell", "isError": true, "result": map[string]any{"content": []any{map[string]any{"type": "text", "text": m.LocalPath + "\\file.txt synthetic-qa-secret\n\nCommand exited with code 7"}}}})
	// A recovered model stop remains completed; observed failures are explicit,
	// not inferred to remain unresolved or relabelled a business success.
	finishPi(s, "Task failed; fix the command before retrying.", "stop", "")
	waitPi(t, func() bool { return (FrontendBridge{}).PiGetSession(m.ServerPath, s.SessionID)["owner"] == "claude" })
	response := (FrontendBridge{}).PiGetSession(m.ServerPath, s.SessionID)
	last := response["lastResult"].(map[string]any)
	if last["status"] != "completed" || !reflect.DeepEqual(last["changedFiles"], []string{"src/ok.txt"}) {
		t.Fatal("tool failure changed model settlement semantics or claimed failed/outside writes")
	}
	if last["toolCalls"] != 4 || last["successfulToolCalls"] != 2 || last["failedToolCalls"] != 2 || last["stopReason"] != "stop" {
		t.Fatalf("current turn tool evidence did not reflect actual events: %v", last)
	}
	failures := last["observedToolFailures"].([]map[string]any)
	if len(failures) != 2 || failures[1]["exitCode"] != int64(7) {
		t.Fatal("actual failures or official exit code were lost")
	}
	raw, _ := json.Marshal(response)
	if strings.Contains(string(raw), "synthetic-qa-secret") || !strings.Contains(string(raw), "[redacted]") {
		t.Fatal("native results or event history exposed a configured secret")
	}
	// Model failures still propagate independently of tool observation.
	piAgents.Lock()
	s.Running, s.Owner, s.runID = true, "pi", s.runID+1
	piAgents.owners[m.ServerPath] = s.SessionID
	piAgents.Unlock()
	finishPi(s, "", "error", "provider rejected request")
	waitPi(t, func() bool { return (FrontendBridge{}).PiGetSession(m.ServerPath, s.SessionID)["owner"] == "claude" })
	if last := (FrontendBridge{}).PiGetSession(m.ServerPath, s.SessionID)["lastResult"].(map[string]any); last["status"] != "error" || last["error"] != "provider rejected request" {
		t.Fatal("model failure was wrapped as completion")
	}
}

func TestPiConfigDPAPIEndpointAndRuntimeGate(t *testing.T) {
	m := isolatePi(t)
	key := "synthetic-test-only-secret"
	input := map[string]any{"provider": "custom", "model": "qa-model", "baseUrl": "https://example.test/v1", "api": "openai-responses", "apiKey": key}
	if view := (FrontendBridge{}).PiSaveConfig(input); view["ok"] != true || view["hasApiKey"] != true {
		t.Fatalf("config could not be saved: %v", view)
	}
	cfg, err := readPiConfig()
	if err != nil {
		t.Fatal(err)
	}
	protected, err := base64.StdEncoding.DecodeString(cfg.ProtectedKey)
	if err != nil {
		t.Fatal(err)
	}
	plain, err := unprotectPiSecret(protected)
	if err != nil || string(plain) != key || strings.Contains(string(protected), key) {
		t.Fatal("actual Windows DPAPI did not protect and restore current-user key")
	}
	raw, _ := json.Marshal((FrontendBridge{}).PiGetConfig())
	if strings.Contains(string(raw), key) || strings.Contains(string(raw), "protectedKey") {
		t.Fatal("config view exposes credentials")
	}
	input["apiKey"], input["model"] = "", "qa-model-2"
	if response := (FrontendBridge{}).PiSaveConfig(input); response["ok"] != true {
		t.Fatal("same endpoint lost key")
	}
	input["baseUrl"] = "https://another.test/v1"
	if response := (FrontendBridge{}).PiSaveConfig(input); response["ok"] != false {
		t.Fatal("new endpoint reused old credentials")
	}
	input["baseUrl"] = "https://example.test/v1"
	// Metadata-only stub validates registry creation without executing a runtime.
	runtimeDir := filepath.Join(piDirectory(), "runtime", piVersion)
	if err := os.MkdirAll(runtimeDir, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(runtimeDir, "metadata-only.exe"), []byte{}, 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(piDirectory(), "runtime.json"), []byte(`{"version":"1.0.2","executable":"metadata-only.exe"}`), 0600); err != nil {
		t.Fatal(err)
	}
	_, args, environment, err := piRuntimeSpec()
	if err != nil {
		t.Fatal(err)
	}
	registry, err := os.ReadFile(filepath.Join(piDirectory(), "agent", "models.json"))
	if err != nil || strings.Contains(string(registry), key) || !strings.Contains(string(registry), "$CHISA_PI_API_KEY") || strings.Contains(strings.Join(args, " "), key) {
		t.Fatal("model registry or argv exposed key or lost environment reference")
	}
	if !strings.Contains(strings.Join(environment, "\n"), "CHISA_PI_API_KEY="+key) {
		t.Fatal("child authentication environment missing")
	}
	s, w := seedPi(m, "config-active")
	for _, running := range []bool{true, false} {
		piAgents.Lock()
		s.Running = running
		piAgents.Unlock()
		if response := (FrontendBridge{}).PiSaveConfig(input); response["ok"] != false {
			t.Fatal("running/idle native runtime allowed provider changes")
		}
	}
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	piAgents.Lock()
	s.Running = true // reserved startup is active even before process creation
	piAgents.Unlock()
	if response := (FrontendBridge{}).PiSaveConfig(input); response["ok"] != false {
		t.Fatal("reserved launch allowed provider changes")
	}
	piAgents.Lock()
	s.Running = false
	piAgents.Unlock()
	if response := (FrontendBridge{}).PiSaveConfig(input); response["ok"] != true {
		t.Fatal("stopped runtime could not save configuration")
	}
}

func TestPiOfficialMiniMaxRuntimeContextRegistration(t *testing.T) {
	for _, endpoint := range []struct {
		name, model, baseURL, api string
		official                  bool
	}{
		{"official-cn", "MiniMax-M3.1-Flash-Preview", "https://api.minimax.cn/v1", "openai-completions", true},
		{"official-global", "MiniMax-M3.1-Flash-Preview", "https://api.minimax.io/v1", "openai-completions", true},
		{"official-anthropic", "MiniMax-M3.1-Flash-Preview", "https://api.minimax.io/anthropic", "anthropic-messages", true},
		{"anthropic-wrong-protocol", "MiniMax-M3.1-Flash-Preview", "https://api.minimax.io/anthropic", "openai-completions", false},
		{"anthropic-unknown-endpoint", "MiniMax-M3.1-Flash-Preview", "https://example.test/anthropic", "anthropic-messages", false},
		{"anthropic-unconfirmed-cn", "MiniMax-M3.1-Flash-Preview", "https://api.minimax.cn/anthropic", "anthropic-messages", false},
		{"anthropic-other-model", "another-model", "https://api.minimax.io/anthropic", "anthropic-messages", false},
		{"other-model", "another-model", "https://api.minimax.cn/v1", "openai-completions", false},
		{"other-endpoint", "MiniMax-M3.1-Flash-Preview", "https://example.test/v1", "openai-completions", false},
		{"other-api-path", "MiniMax-M3.1-Flash-Preview", "https://api.minimax.cn/other", "openai-completions", false},
	} {
		t.Run(endpoint.name, func(t *testing.T) {
			_ = isolatePi(t)
			input := map[string]any{"provider": "custom", "model": endpoint.model, "baseUrl": endpoint.baseURL, "api": endpoint.api, "apiKey": "synthetic-test-only-secret"}
			if response := (FrontendBridge{}).PiSaveConfig(input); response["ok"] != true {
				t.Fatal("private model configuration could not be saved")
			}
			// piRuntimeSpec only requires runtime metadata; this file is never executed.
			runtimeDir := filepath.Join(piDirectory(), "runtime", piVersion)
			if err := os.MkdirAll(runtimeDir, 0700); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(filepath.Join(runtimeDir, "metadata-only.exe"), nil, 0600); err != nil {
				t.Fatal(err)
			}
			marker, _ := json.Marshal(map[string]string{"version": piVersion, "executable": "metadata-only.exe"})
			if err := os.WriteFile(filepath.Join(piDirectory(), "runtime.json"), marker, 0600); err != nil {
				t.Fatal(err)
			}
			if _, _, _, err := piRuntimeSpec(); err != nil {
				t.Fatal(err)
			}
			raw, err := os.ReadFile(filepath.Join(piDirectory(), "agent", "models.json"))
			if err != nil {
				t.Fatal(err)
			}
			var registry struct {
				Providers map[string]struct {
					Models []struct {
						ID            string `json:"id"`
						ContextWindow *int   `json:"contextWindow"`
						MaxTokens     *int   `json:"maxTokens"`
					} `json:"models"`
				} `json:"providers"`
			}
			if err := json.Unmarshal(raw, &registry); err != nil {
				t.Fatal(err)
			}
			models := registry.Providers["chisa-local"].Models
			if len(models) != 1 || models[0].ID != endpoint.model {
				t.Fatal("runtime registry changed the selected custom model")
			}
			model := models[0]
			if endpoint.official {
				if model.ContextWindow == nil || *model.ContextWindow != 1_000_000 || model.MaxTokens == nil || *model.MaxTokens != 16384 {
					t.Fatal("official MiniMax model did not receive its documented context and retained output budget")
				}
			} else if model.ContextWindow != nil || model.MaxTokens != nil {
				t.Fatal("MiniMax capacities were assigned to an unknown model or endpoint")
			}
		})
	}
}

// This helper only runs in the test's private hidden subprocess tree.
func TestPiJobHelperProcess(t *testing.T) {
	mode := os.Getenv("CHISA_PI_JOB_HELPER")
	if mode == "" {
		return
	}
	if mode == "parent" {
		executable, _ := os.Executable()
		child := hideCommandWindow(exec.Command(executable, "-test.run=^TestPiJobHelperProcess$"))
		child.Env = append(os.Environ(), "CHISA_PI_JOB_HELPER=child")
		if err := child.Start(); err != nil {
			os.Exit(2)
		}
		fmt.Printf("CHILD:%d\n", child.Process.Pid)
	}
	time.Sleep(time.Hour)
	os.Exit(0)
}

func TestPiWindowsLifecycleStopsOnlyOwnedDescendants(t *testing.T) {
	for _, action := range []string{"abort", "revoke", "app-exit"} {
		t.Run(action, func(t *testing.T) {
			testPiOwnedNativeTreeLifecycle(t, action)
		})
	}
}

func testPiOwnedNativeTreeLifecycle(t *testing.T, action string) {
	m := isolatePi(t)
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	control := hideCommandWindow(exec.Command(executable, "-test.run=^TestPiJobHelperProcess$"))
	control.Env = append(os.Environ(), "CHISA_PI_JOB_HELPER=child")
	if err := control.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = control.Process.Kill(); _ = control.Wait() })
	controlHandle, err := syscall.OpenProcess(0x00100000, false, uint32(control.Process.Pid))
	if err != nil {
		t.Fatal(err)
	}
	defer syscall.CloseHandle(controlHandle)
	parent := exec.Command(executable, "-test.run=^TestPiJobHelperProcess$")
	parent.Env = append(os.Environ(), "CHISA_PI_JOB_HELPER=parent")
	preparePiProcess(parent)
	stdout, err := parent.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := parent.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = parent.Process.Kill(); _ = parent.Wait() })
	guard, err := attachPiProcess(parent)
	if err != nil {
		t.Fatal(err)
	}
	defer guard.close()
	line := make(chan string, 1)
	go func() { value, _ := bufio.NewReader(stdout).ReadString('\n'); line <- value }()
	var childPID int
	select {
	case value := <-line:
		childPID, err = strconv.Atoi(strings.TrimSpace(strings.TrimPrefix(value, "CHILD:")))
		if err != nil {
			t.Fatal("helper did not report child PID")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("suspended parent was not resumed")
	}
	childHandle, err := syscall.OpenProcess(0x00100000, false, uint32(childPID))
	if err != nil {
		t.Fatal(err)
	}
	defer syscall.CloseHandle(childHandle)
	s, _ := seedPi(m, "native-lifecycle")
	s.process.cmd, s.process.guard = parent, guard
	finishPi(s, "completed native task", "stop", "")
	waitPi(t, func() bool { return (FrontendBridge{}).PiGetSession(m.ServerPath, s.SessionID)["owner"] == "claude" })
	if state := (FrontendBridge{}).PiGetSession(m.ServerPath, s.SessionID); state["runtimeActive"] != true || piWorkspaceOwned(m.ServerPath) {
		t.Fatal("automatic idle release closed runtime or retained project reservation")
	}
	if state, err := syscall.WaitForSingleObject(childHandle, 0); err != nil || state != syscall.WAIT_TIMEOUT {
		t.Fatal("automatic idle release killed an owned native descendant")
	}
	parentHandle, err := syscall.OpenProcess(0x00100000, false, uint32(parent.Process.Pid))
	if err != nil {
		t.Fatal(err)
	}
	defer syscall.CloseHandle(parentHandle)
	if state, err := syscall.WaitForSingleObject(parentHandle, 0); err != nil || state != syscall.WAIT_TIMEOUT {
		t.Fatal("automatic idle release killed the owned runtime process")
	}
	switch action {
	case "abort":
		if response := (FrontendBridge{}).PiAbort(m.ServerPath, s.SessionID); response["ok"] != true || response["runtimeActive"] != false {
			t.Fatalf("native abort failed: %v", response)
		}
	case "revoke":
		if err := stopProjectPi(m.ServerPath); err != nil {
			t.Fatal(err)
		}
	case "app-exit":
		if err := stopAllPi(); err != nil {
			t.Fatal(err)
		}
	}
	if state, err := syscall.WaitForSingleObject(childHandle, 3000); err != nil || state != syscall.WAIT_OBJECT_0 {
		t.Fatal("native lifecycle cleanup left an owned descendant running")
	}
	if state, err := syscall.WaitForSingleObject(parentHandle, 3000); err != nil || state != syscall.WAIT_OBJECT_0 {
		t.Fatal("native lifecycle cleanup left the owned runtime process running")
	}
	if state, err := syscall.WaitForSingleObject(controlHandle, 0); err != nil || state != syscall.WAIT_TIMEOUT {
		t.Fatal("Pi cancellation stopped an unrelated process")
	}
	if state := (FrontendBridge{}).PiGetSession(m.ServerPath, s.SessionID); state["runtimeActive"] != false || state["owner"] != "claude" || state["lastResult"].(map[string]any)["content"] != "completed native task" {
		t.Fatal("native lifecycle cleanup lost completed result or retained runtime/reservation")
	}
	t.Logf("action=%s owned parent=%d child=%d alive after automatic idle release; both stopped afterward; outside control=%d remained alive", action, parent.Process.Pid, childPID, control.Process.Pid)
}
