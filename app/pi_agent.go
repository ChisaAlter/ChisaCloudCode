package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

type piMessage struct {
	ID          string         `json:"id"`
	Role        string         `json:"role"`
	Content     string         `json:"content"`
	Timestamp   string         `json:"timestamp"`
	Attachments []piAttachment `json:"attachments,omitempty"`
	updatedAt   int64
}

type piEvent struct {
	Seq  int64          `json:"seq"`
	Type string         `json:"type"`
	Data map[string]any `json:"data"`
}

// One app session owns one native Pi history; a project has at most one owner.
type piSession struct {
	SessionID         string         `json:"sessionId"`
	ServerPath        string         `json:"serverPath"`
	BindingEpoch      string         `json:"bindingEpoch"`
	Owner             string         `json:"owner"`
	Running           bool           `json:"running"`
	Cursor            int64          `json:"cursor"`
	Messages          []piMessage    `json:"messages"`
	LastResult        map[string]any `json:"lastResult"`
	SessionFile       string         `json:"sessionFile,omitempty"`
	Context           string         `json:"handoffContext,omitempty"`
	ContextFile       string         `json:"claudeReferenceFile,omitempty"`
	LeaseID           string         `json:"workspaceLease,omitempty"`
	Events            []piEvent      `json:"-"`
	process           *piProcess
	secrets           []string
	runID             uint64
	aborting          bool
	assistant         int
	blocks            map[int]string
	stopReason        string
	runError          string
	toolPaths         map[string]string
	changedFiles      map[string]bool
	toolFailures      []map[string]any
	toolStates        map[string]string
	toolCalls         int
	toolsOK           int
	toolsFailed       int
	workspaceBaseline *piWorkspaceSnapshot
}

type piProcess struct {
	cmd        *exec.Cmd
	stdin      io.WriteCloser
	guard      *piProcessGuard
	done       chan struct{}
	writeMu    sync.Mutex
	mu         sync.Mutex
	nextID     uint64
	pending    map[string]chan map[string]any
	closing    bool
	diagnostic string
}

var piAgents = struct {
	sync.Mutex
	loaded   bool
	loadErr  error
	sessions map[string]*piSession
	owners   map[string]string
	stopping bool
}{sessions: make(map[string]*piSession), owners: make(map[string]string)}

var piSessionIDPattern = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$`)
var piShellExitPattern = regexp.MustCompile(`(?:^|\n)Command exited with code (-?[0-9]+)\s*$`)

func piSessionDirectory(sessionID string) string {
	return filepath.Join(dataDir(), "pi", "sessions", sessionID)
}

func piFailure(message, code string) map[string]any {
	return map[string]any{"ok": false, "error": message, "code": code}
}

func piMapping(serverPath, sessionID string) (*Mapping, map[string]any) {
	serverConnectionMu.RLock()
	ready := workspaceConnectionMatchesSession()
	serverConnectionMu.RUnlock()
	if !ready {
		return nil, piFailure("当前账号未连接此本地工作区", "UNBOUND_WORKSPACE")
	}
	if !piSessionIDPattern.MatchString(sessionID) {
		return nil, piFailure("无效的 Pi 会话标识", "INVALID_SESSION_ID")
	}
	m := store.findMappingByServer(serverPath)
	if m == nil || m.ServerID != serverIdentity(store.config()) {
		return nil, piFailure("项目尚未绑定本地目录", "UNBOUND_WORKSPACE")
	}
	return m, nil
}

// Load ownership before any workspace mutation, including after client restart.
func piLoadLocked() error {
	if piAgents.loaded {
		return piAgents.loadErr
	}
	piAgents.loaded = true
	entries, err := os.ReadDir(filepath.Join(dataDir(), "pi", "sessions"))
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		piAgents.loadErr = errors.New("Pi 会话记录无法读取")
		return piAgents.loadErr
	}
	for _, entry := range entries {
		if !entry.IsDir() || !piSessionIDPattern.MatchString(entry.Name()) {
			continue
		}
		b, readErr := os.ReadFile(filepath.Join(piSessionDirectory(entry.Name()), "state.json"))
		if os.IsNotExist(readErr) {
			continue
		}
		var s piSession
		if readErr != nil || json.Unmarshal(b, &s) != nil || s.SessionID != entry.Name() {
			piAgents.loadErr = errors.New("Pi 会话记录无效；保留原记录")
			return piAgents.loadErr
		}
		if s.Messages == nil {
			s.Messages = []piMessage{}
		}
		s.Events = []piEvent{}
		s.assistant = -1
		if s.Running {
			s.LastResult = map[string]any{"status": "aborted", "content": "", "error": "客户端退出时任务尚未完成", "completedAt": time.Now().UTC().Format(time.RFC3339Nano)}
		}
		s.Running = false
		// A restarted client has no live native execution to reserve the project.
		s.Owner = "claude"
		if s.LeaseID != "" {
			s.Owner = "pi"
			piAgents.owners[s.ServerPath] = s.SessionID
			if s.LastResult == nil {
				s.LastResult = map[string]any{"status": "aborted", "content": ""}
			}
			s.LastResult["workspaceStatus"] = "failed"
			s.LastResult["workspaceError"] = "客户端重启后工作区尚未交还，请重新交还工作区"
		}
		piAgents.sessions[s.SessionID] = &s
	}
	return nil
}

func piSessionLocked(m *Mapping, sessionID string) (*piSession, error) {
	if err := piLoadLocked(); err != nil {
		return nil, err
	}
	if s := piAgents.sessions[sessionID]; s != nil {
		if s.ServerPath != m.ServerPath || s.BindingEpoch != m.BindingEpoch {
			return nil, errors.New("Pi 会话的项目绑定已失效")
		}
		return s, nil
	}
	// Session IDs are opaque but their Windows directories are case insensitive.
	for id := range piAgents.sessions {
		if strings.EqualFold(id, sessionID) {
			return nil, errors.New("Pi 会话标识大小写与已保存记录不一致")
		}
	}
	s := &piSession{SessionID: sessionID, ServerPath: m.ServerPath, BindingEpoch: m.BindingEpoch, Owner: "claude", Messages: []piMessage{}, Events: []piEvent{}, assistant: -1}
	piAgents.sessions[sessionID] = s
	return s, nil
}

func piSaveLocked(s *piSession) error {
	dir := piSessionDirectory(s.SessionID)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return errors.New("Pi 会话目录无法创建")
	}
	data, err := json.MarshalIndent(s, "", "  ")
	if err != nil {
		return errors.New("Pi 会话记录无法编码")
	}
	file := filepath.Join(dir, "state.json")
	if err := os.WriteFile(file+".tmp", data, 0o600); err != nil {
		return errors.New("Pi 会话记录无法保存")
	}
	if err := os.Rename(file+".tmp", file); err != nil {
		return errors.New("Pi 会话记录无法替换")
	}
	return nil
}

func piSecretText(s *piSession, value string) string {
	for _, secret := range s.secrets {
		if secret != "" {
			value = strings.ReplaceAll(value, secret, "[redacted]")
		}
	}
	return value
}

func piSanitizeValue(s *piSession, value any) any {
	switch v := value.(type) {
	case string:
		return piSecretText(s, v)
	case map[string]any:
		out := make(map[string]any, len(v))
		for k, item := range v {
			if v["type"] == "image" && k == "data" {
				out[k] = "[image attachment]"
				continue
			}
			out[k] = piSanitizeValue(s, item)
		}
		return out
	case []any:
		out := make([]any, len(v))
		for i, item := range v {
			out[i] = piSanitizeValue(s, item)
		}
		return out
	}
	return value
}

func piEventLocked(s *piSession, kind string, event map[string]any) {
	s.Cursor++
	s.Events = append(s.Events, piEvent{Seq: s.Cursor, Type: kind, Data: piSanitizeValue(s, event).(map[string]any)})
	// Completed messages live in state.json and Pi's original JSONL. This is a
	// bounded live event window, not a duplicate permanent copy of tool output.
	if len(s.Events) > 512 {
		s.Events = s.Events[len(s.Events)-512:]
	}
}

func piSnapshotLocked(s *piSession, after int64) map[string]any {
	owner, running := "claude", s.Running
	ownerID := piAgents.owners[s.ServerPath]
	if ownerID != "" {
		owner = "pi"
		if owning := piAgents.sessions[ownerID]; owning != nil {
			running = owning.Running
		}
	}
	events := []piEvent{}
	for _, event := range s.Events {
		if event.Seq > after {
			events = append(events, event)
		}
	}
	// Initial loads and a lost event window restore the authoritative full history.
	reset := after <= 0 || after > s.Cursor || (len(s.Events) > 0 && after < s.Events[0].Seq-1)
	messages := []piMessage{}
	for _, message := range s.Messages {
		if reset || message.updatedAt > after {
			messages = append(messages, message)
		}
	}
	view := map[string]any{"ok": true, "sessionId": s.SessionID, "serverPath": s.ServerPath, "owner": owner, "ownerSessionId": ownerID, "running": running, "runtimeActive": s.process != nil, "cursor": s.Cursor, "messages": messages, "messagesReset": reset, "events": events}
	if reset || len(events) > 0 {
		view["lastResult"] = s.LastResult
	}
	return view
}

// Used by Pi configuration: retaining an idle RPC also retains native GUI
// descendants, so changing its provider/key requires an explicit stop first.
func piRuntimeActive() bool {
	piAgents.Lock()
	defer piAgents.Unlock()
	_ = piLoadLocked()
	for _, s := range piAgents.sessions {
		if s.process != nil || s.Running {
			return true
		}
	}
	return false
}

func piWorkspaceOwned(serverPath string) bool {
	piAgents.Lock()
	defer piAgents.Unlock()
	// An unreadable execution record must not silently re-enable workspace writes.
	if piLoadLocked() != nil {
		return true
	}
	return piAgents.owners[serverPath] != ""
}

func (FrontendBridge) PiGetSession(serverPath, sessionID string) map[string]any {
	return (FrontendBridge{}).PiEvents(serverPath, sessionID, 0)
}

func (FrontendBridge) PiEvents(serverPath, sessionID string, after int64) map[string]any {
	m, failure := piMapping(serverPath, sessionID)
	if failure != nil {
		return failure
	}
	piAgents.Lock()
	defer piAgents.Unlock()
	s, err := piSessionLocked(m, sessionID)
	if err != nil {
		return piFailure(err.Error(), "STALE_BINDING")
	}
	return piSnapshotLocked(s, after)
}

func (FrontendBridge) PiPrompt(serverPath, sessionID, message, handoffContext string, attachments []piAttachmentInput) map[string]any {
	m, failure := piMapping(serverPath, sessionID)
	if failure != nil {
		return failure
	}
	ctx, cancel := context.WithTimeout(context.Background(), workspaceSyncTimeout)
	defer cancel()
	unlock, err := lockWorkspace(ctx, serverPath)
	if err != nil {
		return piFailure(err.Error(), "SYNC_BLOCKED")
	}
	defer unlock()
	return piStartLockedContext(ctx, m, sessionID, message, handoffContext, attachments)
}

// Caller holds the project lock, so an existing Cloud mutation finishes before
// Pi claims the project and no later Cloud mutation can race the claim.
func piStartLocked(m *Mapping, sessionID, message, handoffContext string, inputs []piAttachmentInput) map[string]any {
	ctx, cancel := context.WithTimeout(context.Background(), workspaceSyncTimeout)
	defer cancel()
	return piStartLockedContext(ctx, m, sessionID, message, handoffContext, inputs)
}

func piStartLockedContext(ctx context.Context, m *Mapping, sessionID, message, handoffContext string, inputs []piAttachmentInput) (result map[string]any) {
	serverConnectionMu.RLock()
	recoveryOnly := apiConnection != nil && apiConnection.workspaceRecoveryOnly
	serverConnectionMu.RUnlock()
	if recoveryOnly {
		return piFailure("请先恢复并交还原工作区，再启动新的 Pi 任务", "SYNC_BLOCKED")
	}
	if strings.TrimSpace(message) == "" && len(inputs) == 0 {
		return piFailure("请输入 Pi 任务", "INVALID_REQUEST")
	}
	if strings.TrimSpace(message) == "" {
		message = "请查看附件。"
	}
	if current := store.findMappingByServer(m.ServerPath); current == nil || current.BindingEpoch != m.BindingEpoch {
		return piFailure("工作区绑定已失效", "STALE_BINDING")
	}
	piAgents.Lock()
	if piAgents.stopping {
		piAgents.Unlock()
		return piFailure("客户端正在退出", "PI_CLOSING")
	}
	s, err := piSessionLocked(m, sessionID)
	if err != nil {
		piAgents.Unlock()
		return piFailure(err.Error(), "STALE_BINDING")
	}
	if owning := piAgents.owners[m.ServerPath]; owning != "" {
		piAgents.Unlock()
		return piFailure("项目任务正在执行或结束处理中", "PI_BUSY")
	}
	if s.Running {
		piAgents.Unlock()
		return piFailure("Pi 当前任务尚未结束", "PI_BUSY")
	}
	piAgents.Unlock()
	if m.Mode != "vps" {
		return piFailure("请先在设置中完成项目的 VPS 同步", "SYNC_BLOCKED")
	}
	leaseID := randHex(16)
	if _, err := remoteLeaseContext(ctx, m, "claim", "pi", leaseID); err != nil {
		return piFailure(err.Error(), "WORKSPACE_BUSY")
	}
	claimed := false
	releaseBlocked := false
	prepared := false
	var baseline *piWorkspaceSnapshot
	defer func() {
		if !claimed {
			if prepared {
				// Preparation paused a real sync. Every later rejection must use
				// the same handback as a finished turn, not just drop its lease.
				message, _ := result["error"].(string)
				code, _ := result["code"].(string)
				piAgents.Lock()
				s.Owner, s.LeaseID, s.Running = "pi", leaseID, false
				s.runID++
				piResetTurnLocked(s)
				s.workspaceBaseline = baseline
				s.LastResult = map[string]any{"status": "error", "content": "", "error": message, "completedAt": time.Now().UTC().Format(time.RFC3339Nano)}
				piResultEvidenceLocked(s)
				piAgents.owners[m.ServerPath] = s.SessionID
				piEventLocked(s, "run_error", map[string]any{"type": "run_error", "error": message})
				runID := s.runID
				_ = piSaveLocked(s)
				piAgents.Unlock()
				releaseErr := piReleaseWorkspaceLocked(s, runID)
				piAgents.Lock()
				result = piSnapshotLocked(s, 0)
				piAgents.Unlock()
				result["ok"], result["error"], result["code"] = false, message, code
				if releaseErr != nil {
					result["error"], result["code"] = message+"；工作区尚未交还："+releaseErr.Error(), "PI_HANDOFF_FAILED"
				}
				return
			}
			var releaseErr error
			if releaseBlocked {
				releaseErr = errors.New("同步暂停尚未确认，工作区仍由 Pi 保留")
			} else {
				_, releaseErr = executeRemoteLease(m, "release", "", leaseID)
			}
			if releaseErr != nil {
				piAgents.Lock()
				s.Owner, s.LeaseID, s.Running = "pi", leaseID, false
				piAgents.owners[m.ServerPath] = s.SessionID
				if s.LastResult == nil {
					s.LastResult = map[string]any{"status": "error", "content": ""}
				}
				runID := s.runID
				piAgents.Unlock()
				piHandoffStatus(s, runID, "failed", releaseErr)
				setSyncInfo(m, "blocked", "Pi 准备未完成且工作区释放未确认，请重新交还工作区")
				piAgents.Lock()
				result = piSnapshotLocked(s, 0)
				piAgents.Unlock()
				result["ok"], result["error"], result["code"] = false, releaseErr.Error(), "PI_HANDOFF_FAILED"
			}
		}
	}()
	if err := stopProjectPreviewsContext(ctx, m.ServerPath); err != nil {
		return piFailure("停止该项目的 VPS 预览失败，Pi 尚未接管", "PI_PREVIEW_STOP_FAILED")
	}
	if err := synchronizeProjectContext(syncLeaseContext(ctx, leaseID), m, true); err != nil {
		var pauseError *syncPauseError
		releaseBlocked = errors.As(err, &pauseError)
		return piFailure(err.Error(), "SYNC_BLOCKED")
	}
	prepared = true
	// Observation failure must retain the full handback path. In particular,
	// shell commands can modify files without emitting edit/write events.
	baseline, _ = capturePiWorkspace(ctx, m)
	attachments, err := piStoreAttachments(sessionID, inputs)
	if err != nil {
		return piFailure(err.Error(), "PI_ATTACHMENT_FAILED")
	}
	referencePath, err := piWriteClaudeReference(sessionID, handoffContext)
	if err != nil {
		return piFailure(err.Error(), "PI_CONTEXT_FAILED")
	}
	if err := ctx.Err(); err != nil {
		return piFailure(err.Error(), "SYNC_BLOCKED")
	}
	piAgents.Lock()
	if piAgents.stopping {
		piAgents.Unlock()
		return piFailure("客户端正在退出", "PI_CLOSING")
	}
	previousOwner := s.Owner
	previousProjectOwner := piAgents.owners[m.ServerPath]
	s.Owner, s.Running = "pi", true
	s.LeaseID = leaseID
	s.Context, s.ContextFile, s.LastResult, s.aborting = "", referencePath, nil, false
	s.runID++
	piResetTurnLocked(s)
	s.workspaceBaseline = baseline
	piAgents.owners[m.ServerPath] = sessionID
	piEventLocked(s, "workspace_reserved", map[string]any{"type": "workspace_reserved"})
	s.Messages = append(s.Messages, piMessage{ID: fmt.Sprintf("user-%s-%d", sessionID, s.Cursor), Role: "user", Content: message, Timestamp: time.Now().UTC().Format(time.RFC3339Nano), Attachments: attachments, updatedAt: s.Cursor})
	if err := piSaveLocked(s); err != nil {
		s.Owner, s.Running = previousOwner, false
		if previousProjectOwner == "" {
			delete(piAgents.owners, m.ServerPath)
		} else {
			piAgents.owners[m.ServerPath] = previousProjectOwner
		}
		s.LeaseID = ""
		piAgents.Unlock()
		return piFailure(err.Error(), "PI_STORAGE_FAILED")
	}
	runID := s.runID
	response := piSnapshotLocked(s, 0)
	response["accepted"] = true
	piAgents.Unlock()
	publishProjectSync(m)
	claimed = true
	go piSendPrompt(s, m, runID, message, referencePath, attachments)
	return response
}

func piResetTurnLocked(s *piSession) {
	s.assistant, s.blocks, s.stopReason, s.runError = -1, make(map[int]string), "", ""
	s.toolPaths, s.changedFiles = make(map[string]string), make(map[string]bool)
	s.toolFailures = nil
	s.toolStates, s.toolCalls, s.toolsOK, s.toolsFailed = make(map[string]string), 0, 0, 0
}

func (p *piProcess) request(kind string, fields map[string]any, timeout time.Duration) (map[string]any, error) {
	p.mu.Lock()
	p.nextID++
	id := fmt.Sprintf("pi-%d", p.nextID)
	response := make(chan map[string]any, 1)
	p.pending[id] = response
	p.mu.Unlock()
	defer func() { p.mu.Lock(); delete(p.pending, id); p.mu.Unlock() }()
	command := make(map[string]any, len(fields)+2)
	for k, v := range fields {
		command[k] = v
	}
	command["id"], command["type"] = id, kind
	p.writeMu.Lock()
	err := json.NewEncoder(p.stdin).Encode(command)
	p.writeMu.Unlock()
	if err != nil {
		return nil, errors.New("无法向 Pi 发送请求")
	}
	select {
	case result := <-response:
		if success, _ := result["success"].(bool); !success {
			message, _ := result["error"].(string)
			if message == "" {
				message = "Pi 拒绝了请求"
			}
			return nil, errors.New(message)
		}
		data, _ := result["data"].(map[string]any)
		return data, nil
	case <-p.done:
		return nil, errors.New("Pi 进程已退出")
	case <-time.After(timeout):
		return nil, errors.New("Pi 请求响应超时")
	}
}

func piStartProcess(s *piSession, m *Mapping, runID uint64) (*piProcess, error) {
	binary, args, environment, err := piRuntimeSpec()
	if err != nil {
		return nil, err
	}
	piAgents.Lock()
	if s.runID != runID || s.aborting {
		piAgents.Unlock()
		return nil, errors.New("Pi 任务已取消")
	}
	if s.process != nil {
		p := s.process
		piAgents.Unlock()
		return p, nil
	}
	s.secrets = nil
	for _, item := range environment {
		key, value, found := strings.Cut(item, "=")
		upper := strings.ToUpper(key)
		if found && value != "" && (strings.Contains(upper, "API_KEY") || strings.Contains(upper, "TOKEN") || strings.Contains(upper, "SECRET") || strings.Contains(upper, "PASSWORD")) {
			s.secrets = append(s.secrets, value)
		}
	}
	args = append(append([]string{}, args...), "--session-dir", piSessionDirectory(s.SessionID))
	if s.SessionFile != "" {
		if !piSessionFileInside(s, s.SessionFile) {
			piAgents.Unlock()
			return nil, errors.New("Pi 原会话路径无效")
		}
		migrated, err := piExternalizeLegacyContext(s.SessionFile)
		if err != nil {
			piAgents.Unlock()
			return nil, errors.New("Pi 历史上下文修复未完成：" + err.Error())
		}
		if migrated > 0 {
			piEventLocked(s, "context_externalized", map[string]any{"type": "context_externalized", "messages": migrated, "originalHistoryPreserved": true})
		}
		args = append(args, "--session", s.SessionFile)
	}
	defer piAgents.Unlock()
	cmd := exec.Command(binary, args...)
	cmd.Dir, cmd.Env = m.LocalPath, environment
	preparePiProcess(cmd)
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, errors.New("Pi 输入通道无法创建")
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		stdin.Close()
		return nil, errors.New("Pi 输出通道无法创建")
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		stdin.Close()
		return nil, errors.New("Pi 诊断通道无法创建")
	}
	if err := cmd.Start(); err != nil {
		stdin.Close()
		return nil, errors.New("Pi 进程无法启动，请检查本地运行时")
	}
	guard, err := attachPiProcess(cmd)
	if err != nil {
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
		stdin.Close()
		return nil, errors.New("Pi 进程管理初始化失败")
	}
	p := &piProcess{cmd: cmd, stdin: stdin, guard: guard, done: make(chan struct{}), pending: make(map[string]chan map[string]any)}
	s.process = p
	aborting := s.aborting || s.runID != runID
	stdoutDone, stderrDone := make(chan struct{}), make(chan struct{})
	go func() {
		defer close(stderrDone)
		buffer := make([]byte, 4096)
		for {
			n, readErr := stderr.Read(buffer)
			if n > 0 {
				p.mu.Lock()
				p.diagnostic += string(buffer[:n])
				if len(p.diagnostic) > 8192 {
					p.diagnostic = p.diagnostic[len(p.diagnostic)-8192:]
				}
				p.mu.Unlock()
			}
			if readErr != nil {
				return
			}
		}
	}()
	go func() {
		defer close(stdoutDone)
		reader := bufio.NewReader(stdout)
		for {
			line, readErr := reader.ReadBytes('\n')
			if len(line) > 0 {
				var event map[string]any
				if json.Unmarshal(line, &event) != nil {
					piProcessFailure(s, p, "Pi 返回了无效的 JSONL 协议")
					_ = p.guard.close()
					return
				}
				kind, _ := event["type"].(string)
				if kind == "response" {
					id, _ := event["id"].(string)
					p.mu.Lock()
					pending := p.pending[id]
					p.mu.Unlock()
					if pending != nil {
						select {
						case pending <- event:
						default:
						}
					}
				} else {
					piHandleEvent(s, p, event)
				}
			}
			if readErr != nil {
				return
			}
		}
	}()
	go func() {
		<-stdoutDone
		waitErr := cmd.Wait()
		<-stderrDone
		_ = guard.close()
		p.mu.Lock()
		closing, diagnostic := p.closing, p.diagnostic
		p.mu.Unlock()
		piAgents.Lock()
		if s.process == p {
			s.process = nil
			if !closing && s.Running {
				s.Running = false
				message := "Pi 在任务结束前退出"
				if s.runError != "" {
					message = piSecretText(s, s.runError)
				}
				if waitErr != nil && strings.TrimSpace(diagnostic) != "" {
					message += ": " + piSecretText(s, strings.TrimSpace(diagnostic))
				}
				s.LastResult = map[string]any{"status": "error", "content": "", "error": message, "completedAt": time.Now().UTC().Format(time.RFC3339Nano)}
				piResultEvidenceLocked(s)
				piEventLocked(s, "process_exit", map[string]any{"type": "process_exit", "error": message})
				_ = piSaveLocked(s)
			}
			if !closing && s.Owner == "pi" {
				runID := s.runID
				go func() { _ = piReleaseWorkspace(s, runID) }()
			}
		}
		piAgents.Unlock()
		close(p.done)
	}()
	if aborting {
		_ = p.guard.close()
		return nil, errors.New("Pi 任务已取消")
	}
	return p, nil
}

func piSessionFileInside(s *piSession, name string) bool {
	relative, err := filepath.Rel(piSessionDirectory(s.SessionID), filepath.Clean(name))
	return err == nil && !filepath.IsAbs(relative) && relative != ".." && !strings.HasPrefix(relative, ".."+string(filepath.Separator)) && strings.EqualFold(filepath.Ext(name), ".jsonl")
}

func piRememberSession(s *piSession, p *piProcess) (map[string]any, error) {
	data, err := p.request("get_state", nil, 15*time.Second)
	if err != nil {
		return nil, err
	}
	if _, ok := data["isStreaming"].(bool); !ok {
		return nil, errors.New("Pi 状态响应无效")
	}
	if _, ok := data["isCompacting"].(bool); !ok {
		return nil, errors.New("Pi 状态响应无效")
	}
	if _, ok := data["pendingMessageCount"].(float64); !ok {
		return nil, errors.New("Pi 队列状态响应无效")
	}
	file, _ := data["sessionFile"].(string)
	piAgents.Lock()
	defer piAgents.Unlock()
	if file != "" && !piSessionFileInside(s, file) {
		return nil, errors.New("Pi 返回的原会话路径无效")
	}
	if file != "" {
		s.SessionFile = file
		if saveErr := piSaveLocked(s); saveErr != nil {
			return nil, saveErr
		}
	}
	return data, nil
}

func piSendPrompt(s *piSession, m *Mapping, runID uint64, message, referencePath string, attachments []piAttachment) {
	p, err := piStartProcess(s, m, runID)
	if err != nil {
		piFinishFailed(s, runID, err.Error())
		return
	}
	if _, err := piRememberSession(s, p); err != nil {
		piFinishFailed(s, runID, err.Error())
		return
	}
	piAgents.Lock()
	aborting := s.aborting || s.runID != runID
	piAgents.Unlock()
	if aborting {
		piFinishFailed(s, runID, "Pi 任务已取消")
		return
	}
	fields, err := piPromptFields(message, referencePath, attachments)
	if err != nil {
		piFinishFailed(s, runID, err.Error())
		return
	}
	data, err := p.request("prompt", fields, 30*time.Second)
	if err != nil {
		piFinishFailed(s, runID, err.Error())
		return
	}
	if disposition, _ := data["disposition"].(string); disposition == "handled" {
		piHandleEvent(s, p, map[string]any{"type": "request_handled"})
	}
}

func piMessageText(value any) string {
	if text, ok := value.(string); ok {
		return text
	}
	blocks, _ := value.([]any)
	text := []string{}
	for _, block := range blocks {
		if item, ok := block.(map[string]any); ok && item["type"] == "text" {
			if value, ok := item["text"].(string); ok {
				text = append(text, value)
			}
		}
	}
	return strings.Join(text, "\n")
}

func piHandleEvent(s *piSession, p *piProcess, event map[string]any) {
	kind, _ := event["type"].(string)
	piAgents.Lock()
	if s.process != p {
		piAgents.Unlock()
		return
	}
	piEventLocked(s, kind, event)
	save := false
	switch kind {
	case "message_start":
		message, _ := event["message"].(map[string]any)
		if message["role"] == "assistant" {
			s.assistant = len(s.Messages)
			s.blocks = make(map[int]string)
			s.Messages = append(s.Messages, piMessage{ID: fmt.Sprintf("assistant-%s-%d", s.SessionID, s.Cursor), Role: "assistant", Content: piSecretText(s, piMessageText(message["content"])), Timestamp: time.Now().UTC().Format(time.RFC3339Nano), updatedAt: s.Cursor})
		}
	case "message_update":
		update, _ := event["assistantMessageEvent"].(map[string]any)
		if s.assistant >= 0 && s.assistant < len(s.Messages) {
			index, _ := update["contentIndex"].(float64)
			if update["type"] == "text_delta" {
				delta, _ := update["delta"].(string)
				s.blocks[int(index)] += delta
			}
			if update["type"] == "text_end" {
				content, _ := update["content"].(string)
				s.blocks[int(index)] = content
			}
			indices := []int{}
			for i := range s.blocks {
				indices = append(indices, i)
			}
			sort.Ints(indices)
			parts := []string{}
			for _, i := range indices {
				parts = append(parts, s.blocks[i])
			}
			s.Messages[s.assistant].Content = piSecretText(s, strings.Join(parts, "\n"))
			s.Messages[s.assistant].updatedAt = s.Cursor
		}
	case "message_end":
		message, _ := event["message"].(map[string]any)
		if message["role"] == "assistant" {
			content := piSecretText(s, piMessageText(message["content"]))
			if s.assistant >= 0 && s.assistant < len(s.Messages) {
				s.Messages[s.assistant].Content = content
				s.Messages[s.assistant].updatedAt = s.Cursor
			} else {
				s.assistant = len(s.Messages)
				s.Messages = append(s.Messages, piMessage{ID: fmt.Sprintf("assistant-%s-%d", s.SessionID, s.Cursor), Role: "assistant", Content: content, Timestamp: time.Now().UTC().Format(time.RFC3339Nano), updatedAt: s.Cursor})
			}
			s.stopReason, _ = message["stopReason"].(string)
			s.runError, _ = message["errorMessage"].(string)
			save = true
		}
	case "auto_retry_end":
		if success, exists := event["success"].(bool); exists && !success {
			s.runError, _ = event["finalError"].(string)
			s.stopReason = "error"
		}
	case "tool_execution_start":
		piObserveToolLocked(s, event, false)
		if event["toolName"] == "edit" || event["toolName"] == "write" {
			id, _ := event["toolCallId"].(string)
			args, _ := event["args"].(map[string]any)
			name, _ := args["path"].(string)
			if id != "" && name != "" {
				s.toolPaths[id] = name
			}
		}
	case "tool_execution_end":
		id, _ := event["toolCallId"].(string)
		failed, observed := event["isError"].(bool)
		completed := piObserveToolLocked(s, event, true)
		if completed && observed && failed {
			piRecordToolFailure(s, event)
		}
		if name := s.toolPaths[id]; name != "" && observed && !failed {
			if m := store.findMappingByServer(s.ServerPath); m != nil {
				absolute := filepath.FromSlash(name)
				if !filepath.IsAbs(absolute) {
					absolute = filepath.Join(m.LocalPath, absolute)
				}
				relative, relErr := filepath.Rel(m.LocalPath, absolute)
				if relErr == nil && relative != ".." && !strings.HasPrefix(relative, ".."+string(filepath.Separator)) && !filepath.IsAbs(relative) {
					s.changedFiles[filepath.ToSlash(relative)] = true
				}
			}
		}
		delete(s.toolPaths, id)
	case "agent_settled", "request_handled":
		status, content := "completed", ""
		if s.assistant >= 0 && s.assistant < len(s.Messages) {
			content = s.Messages[s.assistant].Content
		}
		if kind == "request_handled" {
			content = "Pi 已处理请求，未启动模型运行。"
		}
		if s.stopReason == "length" {
			s.runError = "Pi 输出达到长度上限并被截断，本轮任务未完成。"
		}
		if kind != "request_handled" && !s.aborting && s.stopReason != "aborted" && s.runError == "" && strings.TrimSpace(content) == "" {
			s.runError = "Pi 未返回可用答复，本轮任务结果未确认。"
		}
		if s.stopReason == "error" || s.runError != "" {
			status = "error"
		}
		if s.aborting || s.stopReason == "aborted" {
			status = "aborted"
		}
		s.LastResult = map[string]any{"status": status, "content": content, "completedAt": time.Now().UTC().Format(time.RFC3339Nano)}
		piResultEvidenceLocked(s)
		if status == "error" {
			if s.runError == "" {
				s.runError = "Pi 模型运行失败"
			}
			s.LastResult["error"] = piSecretText(s, s.runError)
		}
		if status == "aborted" {
			s.LastResult["error"] = "Pi 任务已停止"
		}
		s.Running = false
		s.LastResult["workspaceStatus"] = "releasing"
		piEventLocked(s, "workspace_handoff", map[string]any{"type": "workspace_handoff", "status": "releasing"})
		runID := s.runID
		_ = piSaveLocked(s)
		piAgents.Unlock()
		go piAfterSettled(s, p, runID)
		return
	}
	if save {
		if err := piSaveLocked(s); err != nil {
			s.runError = err.Error()
		}
	}
	piAgents.Unlock()
}

// Counts describe observed calls, not whether the user's acceptance criteria
// passed. A cancelled call can have no success/failure outcome yet.
func piObserveToolLocked(s *piSession, event map[string]any, ended bool) bool {
	if s.toolStates == nil {
		s.toolStates = make(map[string]string)
	}
	id, _ := event["toolCallId"].(string)
	if id == "" {
		id = fmt.Sprintf("event-%d", s.Cursor)
	}
	previous := s.toolStates[id]
	if previous == "succeeded" || previous == "failed" || previous == "ended" {
		return false
	}
	if previous == "" {
		s.toolCalls++
	}
	if !ended {
		s.toolStates[id] = "started"
		return false
	}
	s.toolStates[id] = "ended"
	if failed, known := event["isError"].(bool); known {
		if failed {
			s.toolsFailed++
			s.toolStates[id] = "failed"
		} else {
			s.toolsOK++
			s.toolStates[id] = "succeeded"
		}
	}
	return true
}

func piResultEvidenceLocked(s *piSession) {
	s.LastResult["toolCalls"] = s.toolCalls
	s.LastResult["successfulToolCalls"] = s.toolsOK
	s.LastResult["failedToolCalls"] = s.toolsFailed
	s.LastResult["stopReason"] = s.stopReason
	s.LastResult["observedToolFailures"] = append([]map[string]any{}, s.toolFailures...)
	changed := []string{}
	for file := range s.changedFiles {
		changed = append(changed, file)
	}
	sort.Strings(changed)
	s.LastResult["changedFiles"] = changed
}

// These are observed failures, not a claim that a later tool call failed to
// recover. Keep a short actual diagnostic instead of copying tool/file output.
func piRecordToolFailure(s *piSession, event map[string]any) {
	tool, _ := event["toolName"].(string)
	result, _ := event["result"].(map[string]any)
	text := piSecretText(s, piMessageText(result["content"]))
	failure := map[string]any{"toolName": tool}
	if tool == "powershell" || tool == "bash" {
		structured, _ := result["structuredContent"].(map[string]any)
		if code, ok := structured["exit_code"].(float64); ok {
			failure["exitCode"] = code
		} else if match := piShellExitPattern.FindStringSubmatch(text); len(match) == 2 {
			if code, err := strconv.ParseInt(match[1], 10, 64); err == nil {
				failure["exitCode"] = code
			}
		}
	}
	runes := []rune(text)
	if len(runes) > 1024 {
		text = "[truncated] " + string(runes[len(runes)-1024:])
	}
	if strings.TrimSpace(text) == "" {
		text = "Pi 工具返回错误"
	}
	failure["error"] = text
	s.toolFailures = append(s.toolFailures, failure)
	if len(s.toolFailures) > 16 {
		s.toolFailures = s.toolFailures[len(s.toolFailures)-16:]
	}
}

func piProcessFailure(s *piSession, p *piProcess, message string) {
	piAgents.Lock()
	defer piAgents.Unlock()
	if s.process == p {
		s.runError, s.stopReason = message, "error"
	}
}

func piFinishFailed(s *piSession, runID uint64, message string) {
	piFinishFailedWithLock(s, runID, message, false)
}

func piFinishFailedWithLock(s *piSession, runID uint64, message string, projectLocked bool) {
	piAgents.Lock()
	if s.runID != runID {
		piAgents.Unlock()
		return
	}
	status := "error"
	if s.aborting {
		status = "aborted"
	}
	s.LastResult = map[string]any{"status": status, "content": "", "error": piSecretText(s, message), "completedAt": time.Now().UTC().Format(time.RFC3339Nano)}
	piResultEvidenceLocked(s)
	s.Running = false
	p := s.process
	if p != nil {
		s.Running = true
	}
	piEventLocked(s, "run_error", map[string]any{"type": "run_error", "error": message})
	_ = piSaveLocked(s)
	piAgents.Unlock()
	if p != nil {
		_ = p.guard.close()
		_ = piCloseSession(s, projectLocked)
	} else if projectLocked {
		_ = piReleaseWorkspaceLocked(s, runID)
	} else {
		_ = piReleaseWorkspace(s, runID)
	}
}

func piAfterSettled(s *piSession, p *piProcess, runID uint64) {
	state, err := piRememberSession(s, p)
	piAgents.Lock()
	current := s.runID == runID && !s.aborting && s.process == p
	piAgents.Unlock()
	if !current {
		return
	}
	if err != nil {
		piHandoffStatus(s, runID, "failed", err)
		return
	}
	if err == nil && piStateIdle(state) {
		piAgents.Lock()
		canRelease := !s.aborting && s.runID == runID && s.process == p
		piAgents.Unlock()
		if canRelease {
			_ = piReleaseWorkspace(s, runID)
		}
	} else {
		piHandoffStatus(s, runID, "failed", errors.New("Pi 仍有待处理任务，请确认停止后重新交还工作区"))
	}
}

func piStateIdle(state map[string]any) bool {
	streaming, streamingKnown := state["isStreaming"].(bool)
	compacting, compactingKnown := state["isCompacting"].(bool)
	pending, queueKnown := state["pendingMessageCount"].(float64)
	return streamingKnown && compactingKnown && queueKnown && !streaming && !compacting && pending == 0
}

// Releasing the completed task's reservation leaves its RPC/GUI runtime alive.
func piReleaseWorkspace(s *piSession, runID uint64) error {
	ctx, cancel := context.WithTimeout(context.Background(), workspaceSyncTimeout)
	defer cancel()
	unlock, err := lockWorkspace(ctx, s.ServerPath)
	if err != nil {
		piHandoffStatus(s, runID, "failed", err)
		return err
	}
	defer unlock()
	return piReleaseWorkspaceContext(ctx, s, runID)
}

func piReleaseWorkspaceLocked(s *piSession, runID uint64) error {
	ctx, cancel := context.WithTimeout(context.Background(), workspaceSyncTimeout)
	defer cancel()
	return piReleaseWorkspaceContext(ctx, s, runID)
}

func piHandoffStatus(s *piSession, runID uint64, status string, failure error) {
	piAgents.Lock()
	defer piAgents.Unlock()
	if s.runID != runID {
		return
	}
	if s.LastResult == nil {
		s.LastResult = map[string]any{"status": "completed", "content": ""}
	}
	s.LastResult["workspaceStatus"] = status
	delete(s.LastResult, "workspaceError")
	event := map[string]any{"type": "workspace_handoff", "status": status}
	if failure != nil {
		message := piSecretText(s, failure.Error())
		s.LastResult["workspaceError"], event["error"] = message, message
	}
	piEventLocked(s, "workspace_handoff", event)
	_ = piSaveLocked(s)
}

func piReleaseWorkspaceContext(ctx context.Context, s *piSession, runID uint64) (failure error) {
	piAgents.Lock()
	if s.runID != runID || s.Running {
		piAgents.Unlock()
		return errors.New("Pi 当前任务尚未结束")
	}
	owner := piAgents.owners[s.ServerPath]
	leaseID, baseline := s.LeaseID, s.workspaceBaseline
	// An idle runtime can outlive its reservation. Stopping it, or receiving a
	// duplicate settle, must not rewrite a result or touch another turn's owner.
	if leaseID == "" && owner != s.SessionID {
		piAgents.Unlock()
		return nil
	}
	if owner != "" && owner != s.SessionID {
		piAgents.Unlock()
		return errors.New("此会话没有 Pi 工作区交还权")
	}
	piAgents.Unlock()
	defer func() {
		status := "released"
		if failure != nil {
			status = "failed"
		}
		piHandoffStatus(s, runID, status, failure)
	}()
	piHandoffStatus(s, runID, "releasing", nil)
	if leaseID != "" {
		m := store.findMappingByServer(s.ServerPath)
		if m == nil || m.BindingEpoch != s.BindingEpoch || m.ServerID != serverIdentity(store.config()) {
			return errors.New("项目绑定已失效，尚未交还同步")
		}
		if baseline != nil && (baseline.localPath != m.LocalPath || baseline.serverID != m.ServerID || baseline.syncName != m.SyncName) {
			return errors.New("Pi 任务的工作区绑定已失效，保留原工作区")
		}
		changed, observationErr := baseline.changed(ctx, m)
		if observationErr == nil && !changed {
			if err := resumePiWorkspace(ctx, m, leaseID); err != nil {
				return err
			}
		} else {
			piHandoffStatus(s, runID, "syncing", nil)
			if err := synchronizeProjectContext(syncLeaseContext(ctx, leaseID), m, false); err != nil {
				return err
			}
		}
		if _, err := remoteLeaseContext(ctx, m, "release", "pi", leaseID); err != nil {
			setSyncInfo(m, "blocked", err.Error())
			return err
		}
		setSyncInfo(m, "ready", "")
	}
	piAgents.Lock()
	defer func() {
		piAgents.Unlock()
		if m := store.findMappingByServer(s.ServerPath); m != nil {
			publishProjectSync(m)
		}
	}()
	s.LeaseID = ""
	s.Owner = "claude"
	s.workspaceBaseline = nil
	reserved := piAgents.owners[s.ServerPath] == s.SessionID
	if reserved {
		delete(piAgents.owners, s.ServerPath)
	}
	piEventLocked(s, "workspace_released", map[string]any{"type": "workspace_released"})
	if err := piSaveLocked(s); err != nil {
		s.Owner = "pi"
		s.LeaseID = leaseID
		s.workspaceBaseline = baseline
		if reserved {
			piAgents.owners[s.ServerPath] = s.SessionID
		}
		return err
	}
	return nil
}

// Retry only the idle task's hand-back; never replay a model prompt or kill its GUI.
func (FrontendBridge) PiRecoverSession(serverPath, sessionID string) map[string]any {
	m, failure := piMapping(serverPath, sessionID)
	if failure != nil {
		return failure
	}
	piAgents.Lock()
	s, err := piSessionLocked(m, sessionID)
	if err == nil && (s.Running || piAgents.owners[serverPath] != sessionID) {
		err = errors.New("只有当前项目已结束的 Pi 任务可以重新交还工作区")
	}
	if err != nil {
		piAgents.Unlock()
		return piFailure(err.Error(), "PI_BUSY")
	}
	runID, process := s.runID, s.process
	piAgents.Unlock()
	if process != nil {
		state, stateErr := piRememberSession(s, process)
		if stateErr != nil || !piStateIdle(state) {
			if stateErr == nil {
				stateErr = errors.New("Pi 仍有待处理任务，未交还工作区")
			}
			piHandoffStatus(s, runID, "failed", stateErr)
			piAgents.Lock()
			view := piSnapshotLocked(s, 0)
			piAgents.Unlock()
			view["ok"], view["error"], view["code"] = false, stateErr.Error(), "PI_HANDOFF_FAILED"
			return view
		}
	}
	err = piReleaseWorkspace(s, runID)
	piAgents.Lock()
	defer piAgents.Unlock()
	view := piSnapshotLocked(s, 0)
	if err != nil {
		view["ok"], view["error"], view["code"] = false, err.Error(), "PI_HANDOFF_FAILED"
	}
	return view
}

// Closing stdin is Pi's documented orderly shutdown. The Job Object provides
// bounded cancellation and kills only this Pi process and its descendants.
func piCloseSession(s *piSession, projectLocked bool) error {
	piAgents.Lock()
	p := s.process
	wasRunning := s.Running
	if p != nil {
		p.mu.Lock()
		p.closing = true
		p.mu.Unlock()
	}
	piAgents.Unlock()
	if p != nil {
		p.writeMu.Lock()
		_ = p.stdin.Close()
		p.writeMu.Unlock()
		select {
		case <-p.done:
		case <-time.After(5 * time.Second):
			if err := p.guard.close(); err != nil {
				return errors.New("Pi 子进程无法停止；项目仍由 Pi 拥有")
			}
			select {
			case <-p.done:
			case <-time.After(5 * time.Second):
				return errors.New("Pi 退出尚未确认；项目仍由 Pi 拥有")
			}
		}
	}
	piAgents.Lock()
	s.Running = false
	// Process shutdown and workspace handback are separate outcomes. Persist the
	// confirmed stop first so a later sync/lease failure cannot invent a normal
	// completion or erase this turn's output and observed tool facts.
	if s.aborting && wasRunning {
		content := ""
		if s.assistant >= 0 && s.assistant < len(s.Messages) {
			content = s.Messages[s.assistant].Content
		}
		s.LastResult = map[string]any{"status": "aborted", "content": content, "error": "Pi 任务已停止", "completedAt": time.Now().UTC().Format(time.RFC3339Nano)}
		piResultEvidenceLocked(s)
		piEventLocked(s, "run_error", map[string]any{"type": "run_error", "error": "Pi 任务已停止"})
		if err := piSaveLocked(s); err != nil {
			piAgents.Unlock()
			return err
		}
	}
	runID := s.runID
	piAgents.Unlock()
	if !projectLocked {
		return piReleaseWorkspace(s, runID)
	}
	return piReleaseWorkspaceLocked(s, runID)
}

func (FrontendBridge) PiAbort(serverPath, sessionID string) map[string]any {
	m, failure := piMapping(serverPath, sessionID)
	if failure != nil {
		return failure
	}
	lock, _ := workspaceLocks.LoadOrStore(serverPath, &sync.Mutex{})
	mu := lock.(*sync.Mutex)
	mu.Lock()
	defer mu.Unlock()
	piAgents.Lock()
	s, err := piSessionLocked(m, sessionID)
	if err != nil {
		piAgents.Unlock()
		return piFailure(err.Error(), "STALE_BINDING")
	}
	if owner := piAgents.owners[serverPath]; owner != "" && owner != sessionID && s.Running {
		piAgents.Unlock()
		return piFailure("此会话没有 Pi 执行权", "LOCAL_AGENT_OWNS_WORKSPACE")
	}
	wasRunning := s.Running
	s.aborting = true
	p := s.process
	if p != nil {
		p.mu.Lock()
		p.closing = true
		p.mu.Unlock()
	}
	piAgents.Unlock()
	if p != nil {
		_ = p.guard.close()
	}
	if err := piCloseSession(s, true); err != nil {
		piAgents.Lock()
		view := piSnapshotLocked(s, 0)
		piAgents.Unlock()
		view["ok"], view["error"], view["code"] = false, err.Error(), "PI_STOP_FAILED"
		return view
	}
	if !wasRunning {
		piAgents.Lock()
		piEventLocked(s, "runtime_stopped", map[string]any{"type": "runtime_stopped"})
		if err := piSaveLocked(s); err != nil {
			piAgents.Unlock()
			return piFailure(err.Error(), "PI_STORAGE_FAILED")
		}
		piAgents.Unlock()
	}
	return (FrontendBridge{}).PiGetSession(serverPath, sessionID)
}

func stopProjectPi(serverPath string) error {
	piAgents.Lock()
	if serverPath == "" {
		piAgents.stopping = true
	}
	if err := piLoadLocked(); err != nil {
		piAgents.Unlock()
		return err
	}
	items := []*piSession{}
	for _, s := range piAgents.sessions {
		if serverPath == "" || s.ServerPath == serverPath {
			if s.process != nil || s.Owner == "pi" {
				s.aborting = true
				items = append(items, s)
			}
		}
	}
	piAgents.Unlock()
	for _, s := range items {
		piAgents.Lock()
		p := s.process
		if p != nil {
			p.mu.Lock()
			p.closing = true
			p.mu.Unlock()
		}
		piAgents.Unlock()
		if p != nil {
			_ = p.guard.close()
		}
		if err := piCloseSession(s, serverPath != ""); err != nil {
			return err
		}
	}
	return nil
}

func stopAllPi() error { return stopProjectPi("") }
