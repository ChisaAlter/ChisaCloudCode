package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/egoist/mygo"
)

type SyncInfo struct {
	Status              string `json:"status"`
	Detail              string `json:"detail,omitempty"`
	CheckedAt           string `json:"checkedAt"`
	LocalPath           string `json:"localPath,omitempty"`
	ServerPath          string `json:"serverPath"`
	BindingEpoch        string `json:"bindingEpoch"`
	Sequence            uint64 `json:"sequence"`
	EngineStatus        string `json:"engineStatus,omitempty"`
	EmptySide           string `json:"emptySide,omitempty"`
	TaskOwner           string `json:"taskOwner,omitempty"`
	GitRecoveryRequired bool   `json:"gitRecoveryRequired,omitempty"`
	engineFailure       bool
}

var syncStates sync.Map
var cloudReservations sync.Map

// Failed handback keeps the reservation barrier without presenting cleanup as a running task.
var cloudSyncRecovery sync.Map

type WorkspaceSyncEvent struct {
	ServerPath string `json:"serverPath"`
	Status     string `json:"status"`
}

var workspaceSyncChanged = mygo.NewEvent[WorkspaceSyncEvent]("chisa:workspace-sync")
var workspaceSyncStateChanged = mygo.NewEvent[SyncInfo]("chisa:workspace-sync-state")

type syncActivity struct {
	epoch string
	count int
	phase string
}

var syncActivities = struct {
	sync.Mutex
	items map[string]syncActivity
}{items: make(map[string]syncActivity)}

func beginSyncOperation(m *Mapping, phase string) func() {
	syncActivities.Lock()
	activity := syncActivities.items[m.ServerPath]
	if activity.epoch != m.BindingEpoch {
		activity = syncActivity{epoch: m.BindingEpoch}
	}
	activity.count++
	activity.phase = phase
	syncActivities.items[m.ServerPath] = activity
	syncActivities.Unlock()
	setSyncInfo(m, phase, "")
	return func() {
		syncActivities.Lock()
		activity := syncActivities.items[m.ServerPath]
		if activity.epoch == m.BindingEpoch {
			activity.count--
			if activity.count == 0 {
				delete(syncActivities.items, m.ServerPath)
			} else {
				syncActivities.items[m.ServerPath] = activity
			}
		}
		syncActivities.Unlock()
		publishSyncOperation(m)
		publishProjectSync(m)
	}
}

func activeSyncOperations() map[string]SyncInfo {
	syncActivities.Lock()
	defer syncActivities.Unlock()
	operations := make(map[string]SyncInfo, len(syncActivities.items))
	for path, activity := range syncActivities.items {
		operations[path] = SyncInfo{Status: activity.phase, BindingEpoch: activity.epoch}
	}
	return operations
}

func publishSyncOperation(m *Mapping) {
	status := syncOperationInfo(m).Status
	if active, ok := activeSyncOperations()[m.ServerPath]; ok && active.BindingEpoch == m.BindingEpoch {
		status = active.Status
	} else if status == "syncing" || status == "migrating" {
		status = "idle"
	}
	_ = workspaceSyncChanged.Broadcast(WorkspaceSyncEvent{m.ServerPath, status})
}

func setSyncInfo(m *Mapping, status, detail string) {
	storeSyncInfo(m, status, detail, false)
}

func storeSyncInfo(m *Mapping, status, detail string, engineFailure bool, gitRecovery ...bool) {
	recovery := len(gitRecovery) > 0 && gitRecovery[0]
	syncStates.Store(m.ServerPath, SyncInfo{Status: status, Detail: detail, BindingEpoch: m.BindingEpoch, engineFailure: engineFailure, GitRecoveryRequired: recovery})
	if status == "syncing" || status == "migrating" {
		syncActivities.Lock()
		activity := syncActivities.items[m.ServerPath]
		if activity.epoch == m.BindingEpoch && activity.count > 0 {
			activity.phase = status
			syncActivities.items[m.ServerPath] = activity
		}
		syncActivities.Unlock()
	}
	publishSyncOperation(m)
	publishProjectSync(m)
}

type syncEngineError struct{ error }

func (e *syncEngineError) Unwrap() error { return e.error }

func setSyncFailure(m *Mapping, err error) {
	var engineError *syncEngineError
	interrupted := errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded)
	storeSyncInfo(m, "blocked", err.Error(), !interrupted && errors.As(err, &engineError), !interrupted && syncGitNeedsRecovery(err))
}

func syncOperationInfo(m *Mapping) SyncInfo {
	if value, ok := syncStates.Load(m.ServerPath); ok {
		info := value.(SyncInfo)
		if info.BindingEpoch == m.BindingEpoch {
			return info
		}
	}
	return SyncInfo{}
}

func runMutagen(args ...string) (string, error) {
	return runMutagenTimeout(10*time.Minute, args...)
}

func runMutagenTimeout(timeout time.Duration, args ...string) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	return runMutagenContext(ctx, args...)
}

func runMutagenContext(ctx context.Context, args ...string) (string, error) {
	// Pausing only waits for the daemon to acknowledge that its loop stopped;
	// it must not consume the file-transfer/Git synchronization budget.
	pausing := len(args) > 1 && args[0] == "sync" && args[1] == "pause"
	if pausing {
		bounded, cancel := context.WithTimeout(ctx, workspaceSyncPauseTimeout)
		defer cancel()
		ctx = bounded
	}
	binary := mutagenExe()
	if binary == "" {
		return "", &syncEngineError{fmt.Errorf("Mutagen 未随应用分发")}
	}
	sshPath, err := mutagenSSHPath()
	if err != nil {
		return "", &syncEngineError{err}
	}
	cmd := hideCommandWindow(exec.CommandContext(ctx, binary, args...))
	cmd.WaitDelay = time.Second
	cmd.Env = append(os.Environ(), "MUTAGEN_DATA_DIRECTORY="+filepath.Join(dataDir(), "mutagen"), "MUTAGEN_SSH_PATH="+sshPath)
	started := time.Now()
	out, err := cmd.CombinedOutput()
	if pausing {
		outcome := "ok"
		if err != nil {
			outcome = "failed"
		}
		if errors.Is(ctx.Err(), context.DeadlineExceeded) {
			outcome = "timeout"
		} else if errors.Is(ctx.Err(), context.Canceled) {
			outcome = "canceled"
		}
		log.Printf("[sync-engine] operation=pause outcome=%s elapsed=%s", outcome, time.Since(started))
	}
	if err != nil {
		if ctx.Err() != nil {
			err = ctx.Err()
		}
		return string(out), &syncEngineError{fmt.Errorf("同步失败: %w: %s", err, strings.TrimSpace(string(out)))}
	}
	return string(out), nil
}

type syncProblem struct {
	Path  string `json:"path"`
	Error string `json:"error"`
}

type syncEndpoint struct {
	Protocol                   string        `json:"protocol"`
	Host                       string        `json:"host"`
	User                       string        `json:"user"`
	Port                       uint32        `json:"port"`
	Path                       string        `json:"path"`
	Connected                  bool          `json:"connected"`
	Scanned                    bool          `json:"scanned"`
	Directories                uint64        `json:"directories"`
	Files                      uint64        `json:"files"`
	Symlinks                   uint64        `json:"symbolicLinks"`
	ScanProblems               []syncProblem `json:"scanProblems"`
	TransitionProblems         []syncProblem `json:"transitionProblems"`
	ExcludedScanProblems       uint64        `json:"excludedScanProblems"`
	ExcludedTransitionProblems uint64        `json:"excludedTransitionProblems"`
	StagingProgress            *struct {
		ExpectedFiles uint64 `json:"expectedFiles"`
	} `json:"stagingProgress"`
}
type syncSession struct {
	Name   string `json:"name"`
	Mode   string `json:"mode"`
	Ignore struct {
		Paths []string `json:"paths"`
		VCS   bool     `json:"vcs"`
	} `json:"ignore"`
	Identifier        string            `json:"identifier"`
	Status            string            `json:"status"`
	Paused            bool              `json:"paused"`
	LastError         string            `json:"lastError"`
	SuccessfulCycles  uint64            `json:"successfulCycles"`
	Conflicts         []json.RawMessage `json:"conflicts"`
	ExcludedConflicts uint64            `json:"excludedConflicts"`
	Alpha             syncEndpoint      `json:"alpha"`
	Beta              syncEndpoint      `json:"beta"`
}

func listSyncSessions() ([]syncSession, error) {
	return listSyncSessionsContext(context.Background())
}

func listSyncSessionsContext(parent context.Context) ([]syncSession, error) {
	ctx, cancel := context.WithTimeout(parent, 5*time.Second)
	defer cancel()
	out, err := runMutagenContext(ctx, "sync", "list", "--template", "CHISA_SYNC_JSON:{{json .}}")
	if err != nil {
		return nil, err
	}
	var sessions []syncSession
	position := strings.LastIndex(out, "CHISA_SYNC_JSON:")
	if position < 0 {
		return nil, &syncEngineError{fmt.Errorf("同步引擎未返回状态")}
	}
	if err := json.Unmarshal([]byte(strings.TrimSpace(out[position+len("CHISA_SYNC_JSON:"):])), &sessions); err != nil {
		return nil, &syncEngineError{fmt.Errorf("同步状态无效: %w", err)}
	}
	return sessions, nil
}

func matchingSyncSessions(sessions []syncSession, name string) []syncSession {
	matching := []syncSession{}
	if name == "" {
		return matching
	}
	for _, session := range sessions {
		if session.Name == name || session.Identifier == name {
			matching = append(matching, session)
		}
	}
	return matching
}

func syncSessions(name string) ([]syncSession, error) {
	return syncSessionsContext(context.Background(), name)
}

func syncSessionsContext(ctx context.Context, name string) ([]syncSession, error) {
	sessions, err := listSyncSessionsContext(ctx)
	if err != nil {
		return nil, err
	}
	return matchingSyncSessions(sessions, name), nil
}

func syncProblemDetail(s syncSession) string {
	var total uint64
	var first *syncProblem
	detail := ""
	for _, endpoint := range []struct {
		name string
		info syncEndpoint
	}{{"本地", s.Alpha}, {"VPS", s.Beta}} {
		for _, phase := range []struct {
			name     string
			problems []syncProblem
			excluded uint64
		}{{"扫描", endpoint.info.ScanProblems, endpoint.info.ExcludedScanProblems}, {"写入", endpoint.info.TransitionProblems, endpoint.info.ExcludedTransitionProblems}} {
			// Mutagen excludes excess problems from its response, not from synchronization.
			count := uint64(len(phase.problems)) + phase.excluded
			total += count
			if count > 0 && (detail == "" || first == nil && len(phase.problems) > 0) {
				detail = endpoint.name + phase.name + "失败"
				if len(phase.problems) > 0 {
					first = &phase.problems[0]
				}
			}
		}
	}
	if first != nil {
		path := first.Path
		if path == "" {
			path = "项目根目录"
		}
		detail += fmt.Sprintf("（%s）: %s", path, first.Error)
		if total > 1 {
			detail += fmt.Sprintf("（另有 %d 条同步错误）", total-1)
		}
	} else if total > 0 {
		detail += fmt.Sprintf("（共 %d 条同步错误）", total)
	}
	return detail
}

func syncSessionInfo(s syncSession) SyncInfo {
	info := SyncInfo{EngineStatus: s.Status}
	switch {
	case s.Paused:
		info.Status, info.Detail = "paused", "文件同步已暂停，尚不能确认两端文件一致"
	case len(s.Conflicts) > 0 || s.ExcludedConflicts > 0:
		info.Status, info.Detail = "blocked", "两端存在同步冲突，请保留两端修改并解决后重新同步"
	case s.LastError != "":
		info.Status, info.Detail = "blocked", "同步错误: "+s.LastError
	case s.Status == "halted-on-root-emptied":
		info.Status, info.Detail = "blocked", "一端项目目录已清空，批量删除同步等待确认"
		if emptySyncEndpoint(s.Alpha) && !emptySyncEndpoint(s.Beta) {
			info.EmptySide, info.Detail = "local", "本地可同步内容已清空；确认同步清空后，VPS 对应文件将移入备份，忽略文件保留"
		} else if emptySyncEndpoint(s.Beta) && !emptySyncEndpoint(s.Alpha) {
			info.EmptySide, info.Detail = "vps", "VPS 可同步内容已清空，已暂停以保护本地文件；请确认删除方向后处理"
		}
	case s.Status == "halted-on-root-deletion":
		info.Status, info.Detail = "blocked", "一端项目根目录已被删除，请恢复目录或重新绑定后同步"
	case s.Status == "halted-on-root-type-change":
		info.Status, info.Detail = "blocked", "项目根路径不再是目录，请恢复目录后同步"
	case strings.HasPrefix(s.Status, "halted-"):
		info.Status, info.Detail = "blocked", "同步引擎已停止，请检查两端目录后处理"
	case len(s.Alpha.ScanProblems)+len(s.Beta.ScanProblems)+len(s.Alpha.TransitionProblems)+len(s.Beta.TransitionProblems) > 0 ||
		s.Alpha.ExcludedScanProblems+s.Beta.ExcludedScanProblems+s.Alpha.ExcludedTransitionProblems+s.Beta.ExcludedTransitionProblems > 0:
		info.Status, info.Detail = "blocked", syncProblemDetail(s)
	case !s.Alpha.Connected || !s.Beta.Connected:
		info.Status, info.Detail = "disconnected", "本地或 VPS 同步端点未连接"
	case s.Status == "transitioning" || s.Status == "saving" ||
		(s.Alpha.StagingProgress != nil && s.Alpha.StagingProgress.ExpectedFiles > 0) ||
		(s.Beta.StagingProgress != nil && s.Beta.StagingProgress.ExpectedFiles > 0):
		info.Status, info.Detail = "syncing", "正在处理文件同步"
	case s.Status != "watching" || !s.Alpha.Scanned || !s.Beta.Scanned || s.SuccessfulCycles == 0:
		info.Status, info.Detail = "checking", "正在检查文件变更"
	default:
		info.Status = "ready"
	}
	return info
}

func syncSessionMatchesMapping(s syncSession, m *Mapping, cfg Config) bool {
	remote := s.Beta
	return norm(s.Alpha.Path) == norm(m.LocalPath) && remote.Path == m.ServerPath && remote.Protocol == "ssh" && remote.Host == syncSSHAlias(cfg) && remote.User == "" && remote.Port == 0
}

type syncSessionIdentityKey struct{}
type syncSessionIdentity struct{ identifier string }

// A name is only a lookup key: another controller can recreate it during a
// handoff. Every command and the final success check must keep the same ID.
func pinProjectSyncSessionContext(ctx context.Context, m *Mapping, session syncSession) error {
	if session.Identifier == "" || !syncSessionMatchesMapping(session, m, workspaceSyncConfig(ctx)) {
		return fmt.Errorf("项目同步会话绑定不一致")
	}
	if pinned, _ := ctx.Value(syncSessionIdentityKey{}).(*syncSessionIdentity); pinned != nil {
		if pinned.identifier != "" && pinned.identifier != session.Identifier {
			return fmt.Errorf("同步期间项目会话已被替换，请重新同步")
		}
		pinned.identifier = session.Identifier
	}
	return nil
}

func validateProjectSyncSessionContext(ctx context.Context, m *Mapping, session syncSession) error {
	if err := pinProjectSyncSessionContext(ctx, m, session); err != nil {
		return err
	}
	if session.Mode != "two-way-safe" || !session.Ignore.VCS {
		return fmt.Errorf("项目同步会话的同步模式或 Git 排除设置已改变，请修复会话后重新同步")
	}
	return nil
}

// Structural validation also admits a paused legacy session so its exact policy
// can be migrated. File transfer and readiness additionally require the live
// Git-policy capability; an old literal snapshot can never authorize resume.
func validateLiveProjectSyncSessionContext(ctx context.Context, m *Mapping, session syncSession) error {
	if err := validateProjectSyncSessionContext(ctx, m, session); err != nil {
		return err
	}
	if !syncSessionHasDynamicGitPolicy(session) {
		return fmt.Errorf("项目同步过滤策略需要升级，请立即同步以安全更新规则")
	}
	return nil
}

func syncWorkspaceOwner(serverPath string) string {
	if reservation, reserved := cloudReservations.Load(serverPath); reserved {
		if recovery, pending := cloudSyncRecovery.Load(serverPath); !pending || recovery != reservation {
			return "claude"
		}
	}
	piAgents.Lock()
	defer piAgents.Unlock()
	if piAgents.owners[serverPath] != "" {
		return "pi"
	}
	return ""
}

// Cached operation failures are not proof of file state, or of Git recovery.
func projectSyncInfo(m *Mapping, cfg Config, sessions []syncSession, queryErr error, checkedAt, owner string) SyncInfo {
	info := SyncInfo{CheckedAt: checkedAt, LocalPath: m.LocalPath, ServerPath: m.ServerPath, BindingEpoch: m.BindingEpoch}
	if m.ServerID != serverIdentity(cfg) {
		info.Status, info.Detail = "unavailable", "项目绑定属于其他服务器，请连接原服务器"
		return info
	}
	// Task ownership survives observer failures; unavailable does not release the workspace.
	info.TaskOwner = owner
	matching := matchingSyncSessions(sessions, m.SyncName)
	if len(matching) == 1 {
		info.EngineStatus = matching[0].Status
	}
	operation := syncOperationInfo(m)
	if operation.Status == "blocked" && !operation.engineFailure {
		info.Status, info.Detail = operation.Status, operation.Detail
		_, active := activeSyncOperations()[m.ServerPath]
		info.GitRecoveryRequired = operation.GitRecoveryRequired && owner == "" && !active && queryErr == nil &&
			m.SyncName != "" && len(matching) == 1 && syncSessionMatchesMapping(matching[0], m, cfg)
		if len(matching) == 1 {
			if _, pending := pendingProjectEmpty(m, matching[0]); pending {
				info.EmptySide = "local"
			}
		}
		return info
	}
	if queryErr != nil {
		info.Status, info.Detail = "unavailable", queryErr.Error()
		return info
	}
	if active, ok := activeSyncOperations()[m.ServerPath]; ok && active.BindingEpoch == m.BindingEpoch {
		info.Status = active.Status
		return info
	}
	if sessions == nil {
		info.Status, info.Detail = "checking", "正在连接同步状态监视器"
		return info
	}
	if m.SyncName == "" || len(matching) == 0 {
		info.Status, info.Detail = "needs-sync", "尚未建立本地与 VPS 文件同步会话"
		return info
	}
	if len(matching) != 1 {
		info.Status, info.Detail = "unavailable", "存在重复同步会话"
		return info
	}
	session := matching[0]
	if !syncSessionMatchesMapping(session, m, cfg) {
		info.Status, info.Detail = "unavailable", "同步会话绑定的服务器或目录不一致"
		return info
	}
	live := syncSessionInfo(session)
	info.Status, info.Detail = live.Status, live.Detail
	if session.Mode != "two-way-safe" || !session.Ignore.VCS {
		info.Status, info.Detail = "blocked", "同步会话的同步模式或 Git 排除设置已改变，请修复会话后重新同步"
	} else if !syncSessionHasDynamicGitPolicy(session) {
		info.Status, info.Detail = "needs-sync", "同步过滤策略需要升级，请立即同步以安全更新规则"
	}
	info.EmptySide = live.EmptySide
	if _, pending := pendingProjectEmpty(m, session); pending {
		info.Status, info.EmptySide = "blocked", "local"
		info.Detail = "清空同步未完成，可再次确认清空；已移动的文件保留在 VPS 备份中"
	}
	if info.Status != "blocked" && owner != "" {
		info.Status, info.Detail, info.TaskOwner = "reserved", "任务正在使用 VPS 项目，结束后交还文件同步", owner
	} else if info.Status == "ready" && m.Mode != "vps" {
		info.Status, info.Detail = "needs-sync", "文件会话已就绪，但项目尚未完成 VPS 初始化，请先同步项目"
	}
	return info
}

// The private alias supplies this app's key without changing unrelated SSH hosts.
func syncSSHAlias(cfg Config) string {
	identity := cfg.SSHUser + "@" + cfg.SSHHost
	if cfg.WorkspaceAccount != "" {
		identity = serverIdentity(cfg)
	} else if cfg.SSHPort != 0 && cfg.SSHPort != 22 {
		identity += fmt.Sprintf(":%d", cfg.SSHPort)
	}
	digest := sha256.Sum256([]byte(identity))
	return fmt.Sprintf("chisa-sync-%x", digest[:6])
}

var syncSSHConfigMu sync.Mutex

func prepareSyncSSH(cfg Config, keyPath string) (string, error) {
	syncSSHConfigMu.Lock()
	defer syncSSHConfigMu.Unlock()
	alias := syncSSHAlias(cfg)
	if err := os.MkdirAll(dataDir(), 0700); err != nil {
		return "", err
	}
	includePath := filepath.Join(dataDir(), "sync-ssh.conf")
	quote := func(value string) string { return `"` + strings.ReplaceAll(filepath.ToSlash(value), `"`, `\"`) + `"` }
	content := "Host " + alias + "\n  HostName " + cfg.SSHHost + "\n  User " + cfg.SSHUser + "\n  IdentityFile " + quote(keyPath) + "\n  IdentitiesOnly yes\n  BatchMode yes\n  StrictHostKeyChecking accept-new\n"
	if cfg.SSHPort > 0 {
		content += fmt.Sprintf("  Port %d\n", cfg.SSHPort)
	}
	if cfg.SSHKnownHostsPath != "" {
		strict := "accept-new"
		if cfg.SSHHostKeyPinned {
			strict = "yes"
		}
		content = strings.Replace(content, "  StrictHostKeyChecking accept-new\n", "  StrictHostKeyChecking "+strict+"\n", 1)
		content += "  UserKnownHostsFile " + quote(cfg.SSHKnownHostsPath) + "\n  GlobalKnownHostsFile none\n"
	}
	previous, err := os.ReadFile(includePath)
	if err != nil && !os.IsNotExist(err) {
		return "", err
	}
	// Each account already has a distinct alias. Replace only that Host block;
	// retained projects keep their old account's endpoint and credentials.
	retained := []string{}
	omit := false
	for _, line := range strings.Split(string(previous), "\n") {
		fields := strings.Fields(line)
		if len(fields) > 0 && strings.EqualFold(fields[0], "Host") {
			omit = len(fields) == 2 && fields[1] == alias
		}
		if !omit {
			retained = append(retained, line)
		}
	}
	prefix := strings.TrimRight(strings.Join(retained, "\n"), "\r\n")
	if prefix != "" {
		content = prefix + "\n" + content
	}
	if err := os.WriteFile(includePath+".tmp", []byte(content), 0600); err != nil {
		return "", err
	}
	if err := os.Rename(includePath+".tmp", includePath); err != nil {
		return "", err
	}
	return alias, nil
}

func gitOutput(local string, args ...string) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()
	return gitOutputContext(ctx, local, args...)
}

func gitOutputContext(ctx context.Context, local string, args ...string) (string, error) {
	return gitOutputContextEnv(ctx, local, nil, args...)
}

func gitOutputContextEnv(ctx context.Context, local string, env []string, args ...string) (string, error) {
	return gitOutputContextEnvInput(ctx, local, env, nil, args...)
}

func gitOutputContextEnvInput(ctx context.Context, local string, env []string, input []byte, args ...string) (string, error) {
	if err := workspaceSyncCurrent(ctx); err != nil {
		return "", err
	}
	cmd := hideCommandWindow(exec.CommandContext(ctx, "git", append([]string{"-C", local}, args...)...))
	cmd.WaitDelay = time.Second
	if input != nil {
		cmd.Stdin = bytes.NewReader(input)
	}
	keyPath := store.keyPathOf()
	if snapshot, _ := ctx.Value(workspaceSyncConnectionKey{}).(*workspaceSyncConnection); snapshot != nil {
		keyPath = snapshot.keyPath
	}
	sshArguments := sshConnectionArgs(workspaceSyncConfig(ctx), keyPath)
	command := []string{shellQuote(filepath.ToSlash(sshExe()))}
	for _, argument := range sshArguments {
		command = append(command, shellQuote(filepath.ToSlash(argument)))
	}
	cmd.Env = append(os.Environ(), "LC_ALL=C", "GIT_TERMINAL_PROMPT=0", "GIT_SSH_COMMAND="+strings.Join(command, " "))
	if objects, _ := ctx.Value(syncGitPreviewObjectsKey{}).([]string); objects != nil {
		cmd.Env = append(cmd.Env, objects...)
	}
	cmd.Env = append(cmd.Env, env...)
	out, err := cmd.CombinedOutput()
	if err != nil {
		if ctx.Err() != nil {
			err = ctx.Err()
		}
		return "", fmt.Errorf("Git 同步失败: %w: %s", err, strings.TrimSpace(string(out)))
	}
	if strings.HasSuffix(string(out), "\x00") {
		return string(out), nil
	}
	return strings.TrimSpace(string(out)), nil
}

func ensureSync(m *Mapping) error {
	ctx, cancel := context.WithTimeout(context.Background(), workspaceSyncTimeout)
	defer cancel()
	return ensureSyncContext(ctx, m)
}

// Freeze the session identity before preparing metadata evidence. Creating or
// flushing the file session is deliberately deferred until after Git preflight.
func ensureSyncNameContext(ctx context.Context, m *Mapping) error {
	if err := workspaceSyncCurrent(ctx); err != nil {
		return err
	}
	if m.ServerID != serverIdentity(workspaceSyncConfig(ctx)) {
		return fmt.Errorf("项目绑定属于其他服务器，请连接原服务器")
	}
	if m.SyncName != "" {
		return nil
	}
	m.SyncName = "chisa-vps-" + m.BindingEpoch
	serverConnectionMu.RLock()
	defer serverConnectionMu.RUnlock()
	snapshot, _ := ctx.Value(workspaceSyncConnectionKey{}).(*workspaceSyncConnection)
	if ctx.Err() != nil || (snapshot != nil && !snapshot.currentLocked()) {
		return fmt.Errorf("文件同步账号或连接已改变")
	}
	return store.updateMapping(m)
}

func ensureSyncContext(ctx context.Context, m *Mapping) error {
	if err := ensureSyncNameContext(ctx, m); err != nil {
		return err
	}
	cfg := workspaceSyncConfig(ctx)
	keyPath := store.keyPathOf()
	if snapshot, _ := ctx.Value(workspaceSyncConnectionKey{}).(*workspaceSyncConnection); snapshot != nil {
		keyPath = snapshot.keyPath
	}
	serverConnectionMu.RLock()
	snapshot, _ := ctx.Value(workspaceSyncConnectionKey{}).(*workspaceSyncConnection)
	if ctx.Err() != nil || (snapshot != nil && !snapshot.currentLocked()) {
		serverConnectionMu.RUnlock()
		return fmt.Errorf("文件同步账号或连接已改变")
	}
	alias, err := prepareSyncSSH(cfg, keyPath)
	serverConnectionMu.RUnlock()
	if err != nil {
		return err
	}
	sessions, err := syncSessionsContext(ctx, m.SyncName)
	if err != nil {
		return err
	}
	if len(sessions) == 1 {
		return validateLiveProjectSyncSessionContext(ctx, m, sessions[0])
	}
	if len(sessions) > 1 {
		return fmt.Errorf("存在重复同步会话")
	}
	if pinned, _ := ctx.Value(syncSessionIdentityKey{}).(*syncSessionIdentity); pinned != nil && pinned.identifier != "" {
		return fmt.Errorf("同步期间项目会话已消失，请重新同步")
	}
	// The versioned engine negotiates and validates both endpoints' Git policy
	// before its first scan. The live configuration is stable; native snapshots
	// belong only to explicit offline/destructive inspection.
	config, err := projectSyncIgnoreConfigurationContext(ctx, m)
	if err != nil {
		return err
	}
	_, err = runMutagenContext(ctx, "sync", "create", "--name", m.SyncName, "--mode", "two-way-safe", "--hash", "sha256", "--no-global-configuration", "--configuration-file", config, "--ignore-vcs", "--default-owner-beta", "id:1000", "--default-group-beta", "id:1000", m.LocalPath, alias+":"+m.ServerPath)
	return err
}

func flushSync(m *Mapping, pause bool) error {
	ctx, cancel := context.WithTimeout(context.Background(), workspaceSyncTimeout)
	defer cancel()
	return flushSyncContext(ctx, m, pause)
}

// Update the paused controller in place, before trying to flush old rules.
// The engine preserves its archive and projects newly ignored paths out of the
// baseline without interpreting them as deletions on either endpoint.
//
// Pausing drops endpoint connections and makes the next flush cold. A negotiated
// live policy updates itself inside each engine cycle, so only legacy sessions
// need a one-time exact-session pause/configuration migration here.
func refreshSyncIgnoreContext(ctx context.Context, m *Mapping) (bool, error) {
	// Validate the exact session before trusting its negotiated live capability.
	// The engine owns policy evidence for both endpoints; native only migrates
	// legacy configuration while preserving its archive and exact identifier.
	if err := workspaceSyncCurrent(ctx); err != nil {
		return false, err
	}
	sessions, err := syncSessionsContext(ctx, m.SyncName)
	if err != nil {
		return false, err
	}
	if len(sessions) == 0 {
		return false, nil
	}
	if len(sessions) != 1 || !syncSessionMatchesMapping(sessions[0], m, workspaceSyncConfig(ctx)) {
		return false, fmt.Errorf("更新文件过滤前发现项目会话绑定不一致")
	}
	session := sessions[0]
	if err := validateProjectSyncSessionContext(ctx, m, session); err != nil {
		return false, err
	}
	if syncSessionHasDynamicGitPolicy(session) {
		// The capability is enforced on both endpoints by engine .3 before
		// every scan and transfer. Never repeat native tree discovery, literal
		// inventories or endpoint reconnection for ordinary index/rule changes.
		return false, nil
	}
	// A legacy session is paused by engine .3 before it can connect. Migrate
	// only that pinned session to stable live policy; no old literal inventory
	// can authorize transfer or override the engine's fresh joint decisions.
	configuration, err := projectSyncIgnoreConfigurationContext(ctx, m)
	if err != nil {
		return false, err
	}
	contents, err := os.ReadFile(configuration)
	if err != nil {
		return false, err
	}
	current, err := syncSessionsContext(ctx, m.SyncName)
	if err != nil {
		return false, err
	}
	if len(current) != 1 || current[0].Identifier != session.Identifier || !syncSessionMatchesMapping(current[0], m, workspaceSyncConfig(ctx)) || syncIgnoreSessionSignature("", current[0]) != syncIgnoreSessionSignature("", session) {
		return false, fmt.Errorf("读取文件过滤期间同步会话已改变，请重新同步")
	}
	session = current[0]
	var patterns []string
	for _, line := range strings.Split(string(contents), "\n") {
		if item, found := strings.CutPrefix(strings.TrimSpace(line), "- "); found {
			var pattern string
			if err = json.Unmarshal([]byte(item), &pattern); err != nil {
				return false, err
			}
			patterns = append(patterns, pattern)
		}
	}
	policy := session
	policy.Ignore.Paths = patterns
	if !syncSessionHasDynamicGitPolicy(policy) {
		return false, fmt.Errorf("新的文件过滤配置缺少实时 Git 策略，未启动传输")
	}
	if slices.Equal(patterns, session.Ignore.Paths) {
		return false, nil
	}
	if !session.Paused {
		if err := pauseSyncSessionContext(ctx, m, session.Identifier); err != nil {
			return false, err
		}
	}
	if _, err := runMutagenContext(ctx, "sync", "update-ignores", "--configuration-file", configuration, session.Identifier); err != nil {
		return false, err
	}
	updated, err := syncSessionsContext(ctx, m.SyncName)
	if err != nil {
		return false, err
	}
	if len(updated) != 1 || updated[0].Identifier != session.Identifier || !slices.Equal(updated[0].Ignore.Paths, patterns) {
		return false, fmt.Errorf("文件过滤更新后的项目会话或规则无法确认")
	}
	if err := validateLiveProjectSyncSessionContext(ctx, m, updated[0]); err != nil {
		return false, err
	}
	return true, nil
}

// ensureSyncWatchingContext resumes a paused session without disturbing one
// that is already watching. Resuming an active session still re-dials both
// endpoints, so it must not run on every synchronization.
func ensureSyncWatchingContext(ctx context.Context, m *Mapping) error {
	sessions, err := syncSessionsContext(ctx, m.SyncName)
	if err != nil {
		return err
	}
	if len(sessions) != 1 {
		return fmt.Errorf("无法确认唯一的项目同步会话")
	}
	session := sessions[0]
	if err := validateLiveProjectSyncSessionContext(ctx, m, session); err != nil {
		return err
	}
	if session.Paused {
		if _, err := runMutagenContext(ctx, "sync", "resume", session.Identifier); err != nil {
			return err
		}
		// Resume reconnects endpoints asynchronously. Wait for its first confirmed
		// cycle before reporting success; ordinary warm sessions skip this path.
		return flushSyncContext(ctx, m, false)
	}
	// A fresh edit can start another healthy cycle after our explicit flush.
	// Observe that cycle to completion instead of treating its busy frame as a
	// failure and disconnecting the otherwise healthy endpoints. The exact
	// session, mode and endpoint identity remain pinned on every observation.
	return waitSyncWatchingContext(ctx, m, session, func() ([]syncSession, error) {
		return syncSessionsContext(ctx, m.SyncName)
	})
}

func waitSyncWatchingContext(ctx context.Context, m *Mapping, session syncSession, observe func() ([]syncSession, error)) error {
	identifier := session.Identifier
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		if err := workspaceSyncCurrent(ctx); err != nil {
			return err
		}
		if session.Identifier != identifier {
			return fmt.Errorf("同步期间项目会话已被替换，请重新同步")
		}
		if err := validateLiveProjectSyncSessionContext(ctx, m, session); err != nil {
			return err
		}
		info := syncSessionInfo(session)
		if info.Status == "ready" {
			return nil
		}
		// Only a previously initialized, connected and error-free session can
		// wait. Conflicts, halted roots, external pauses and unsafe configuration
		// still return immediately without borrowing or releasing ownership.
		transient := info.Status == "checking" || info.Status == "syncing"
		if !transient || session.Paused || !session.Alpha.Connected || !session.Beta.Connected || session.SuccessfulCycles == 0 {
			return &syncEngineError{fmt.Errorf("文件同步尚未就绪: %s", info.Detail)}
		}
		timer := time.NewTimer(100 * time.Millisecond)
		select {
		case <-ctx.Done():
			timer.Stop()
			return ctx.Err()
		case <-timer.C:
		}
		sessions, err := observe()
		if err != nil {
			return err
		}
		if len(sessions) != 1 {
			return fmt.Errorf("等待文件同步期间无法确认唯一的项目会话")
		}
		session = sessions[0]
	}
}

func flushSyncContext(ctx context.Context, m *Mapping, pause bool) error {
	setSyncInfo(m, "syncing", "")
	if err := ensureSyncContext(ctx, m); err != nil {
		return err
	}
	before, err := syncSessionsContext(ctx, m.SyncName)
	if err != nil {
		return err
	}
	if len(before) != 1 {
		return &syncEngineError{fmt.Errorf("无法确认唯一的项目同步会话")}
	}
	session := before[0]
	if err := validateProjectSyncSessionContext(ctx, m, session); err != nil {
		return err
	}
	if strings.HasPrefix(session.Status, "halted-") {
		return &syncEngineError{fmt.Errorf("%s", syncSessionInfo(session).Detail)}
	}
	if session.Paused {
		if _, err := runMutagenContext(ctx, "sync", "resume", session.Identifier); err != nil {
			return err
		}
	}
	if _, err := runMutagenContext(ctx, "sync", "flush", session.Identifier); err != nil {
		if failed, queryErr := syncSessionsContext(ctx, m.SyncName); queryErr == nil && len(failed) == 1 && failed[0].Identifier == session.Identifier && strings.HasPrefix(failed[0].Status, "halted-") {
			return &syncEngineError{fmt.Errorf("%s", syncSessionInfo(failed[0]).Detail)}
		}
		return err
	}
	sessions, err := syncSessionsContext(ctx, m.SyncName)
	if err != nil {
		return err
	}
	if len(sessions) != 1 {
		return &syncEngineError{fmt.Errorf("找不到项目同步会话")}
	}
	s := sessions[0]
	if s.Identifier != session.Identifier {
		return fmt.Errorf("同步期间项目会话已被替换，请重新同步")
	}
	if err := validateProjectSyncSessionContext(ctx, m, s); err != nil {
		return err
	}
	if s.Paused || strings.HasPrefix(s.Status, "halted-") {
		return &syncEngineError{fmt.Errorf("%s", syncSessionInfo(s).Detail)}
	}
	if len(s.Conflicts) > 0 || s.ExcludedConflicts > 0 {
		return &syncEngineError{fmt.Errorf("两端存在同步冲突，请保留两端修改并解决后重新同步")}
	}
	if s.LastError != "" {
		return &syncEngineError{fmt.Errorf("同步错误: %s", s.LastError)}
	}
	// The completed flush and this query are separate daemon requests. A
	// subsequent edit can already be scanning, including Scanned=false, when
	// the flush result arrives. Use the same exact-session convergence guard as
	// final handoff; do not turn that normal follow-up cycle into a pause.
	if err := waitSyncWatchingContext(ctx, m, s, func() ([]syncSession, error) {
		return syncSessionsContext(ctx, m.SyncName)
	}); err != nil {
		return err
	}
	if pause {
		if err := pauseSyncSessionContext(ctx, m, s.Identifier); err != nil {
			return err
		}
		setSyncInfo(m, "reserved", "")
	} else {
		setSyncInfo(m, "ready", "")
	}
	return nil
}
func terminateSync(name string) error {
	if name == "" {
		return nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	sessions, err := syncSessionsContext(ctx, name)
	if err != nil {
		return err
	}
	if len(sessions) == 0 {
		return nil
	}
	if len(sessions) != 1 || sessions[0].Identifier == "" {
		return fmt.Errorf("无法确认映射对应的唯一同步会话")
	}
	_, err = runMutagenContext(ctx, "sync", "terminate", sessions[0].Identifier)
	return err
}
func syncStatus(name string) string {
	s, e := syncSessions(name)
	if e != nil || len(s) != 1 {
		return "unavailable"
	}
	return syncSessionInfo(s[0]).Status
}
