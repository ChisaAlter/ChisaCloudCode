package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

// SshTunnelProfileInput contains nonsecret references only. The native host derives
// its account binding; callers cannot adopt another account's saved profile.
type SshTunnelProfileInput struct {
	ID             string `json:"id,omitempty"`
	Name           string `json:"name"`
	Mode           string `json:"mode,omitempty"`           // "ssh" (system sshd) or "agent" (bundled loopback agent)
	AgentTransport string `json:"agentTransport,omitempty"` // absent preserves legacy reverse SSH; relay uses authenticated HTTPS
	SSHHost        string `json:"sshHost"`
	SSHPort        int    `json:"sshPort"`
	SSHUser        string `json:"sshUser"`
	KeyPath        string `json:"keyPath"`
	KnownHostsPath string `json:"knownHostsPath"`
	RemotePort     int    `json:"remotePort"`
	LocalPort      int    `json:"localPort"`
}

type SshTunnelProfile struct {
	SshTunnelProfileInput
	AccountBinding string `json:"accountBinding"`
	ServiceURL     string `json:"serviceUrl"`
}

// Forwarding acknowledges only the outer SSH reverse listener. The VPS must
// separately authenticate to Windows and probe the helper/project directory.
type SshTunnelStatus struct {
	ProfileID         string `json:"profileId"`
	State             string `json:"state"`
	Generation        uint64 `json:"generation"`
	OuterConnected    bool   `json:"outerConnected"`
	Verified          bool   `json:"verified"`
	RegistrationState string `json:"registrationState,omitempty"`
	RegistrationError string `json:"registrationError,omitempty"`
	ReconnectAttempt  int    `json:"reconnectAttempt,omitempty"`
	Code              string `json:"code,omitempty"`
	Message           string `json:"message,omitempty"`
}

type SshPreflightIssue struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

type SshPreflight struct {
	OK                   bool                `json:"ok"`
	Platform             string              `json:"platform"`
	SSHAvailable         bool                `json:"sshAvailable"`
	AgentAvailable       bool                `json:"agentAvailable"`
	SSHDAvailable        bool                `json:"sshdAvailable"`
	SSHDServiceInstalled bool                `json:"sshdServiceInstalled"`
	SSHDServiceRunning   bool                `json:"sshdServiceRunning"`
	Issues               []SshPreflightIssue `json:"issues"`
	sshExecutable        string
}

type sshAccountScope struct {
	binding    string
	serviceURL string
	ctx        context.Context
	connection *serverConnection
	identity   string
	version    uint64
}

type sshTunnelError struct{ code, message string }

func (e *sshTunnelError) Error() string { return e.message }

func sshFailure(code, message string) error { return &sshTunnelError{code: code, message: message} }

func sshErrorResponse(err error) map[string]any {
	var typed *sshTunnelError
	if errors.As(err, &typed) {
		return map[string]any{"ok": false, "code": typed.code, "error": typed.message}
	}
	return map[string]any{"ok": false, "code": "SSH_OPERATION_FAILED", "error": "SSH 操作失败，请检查本地配置。"}
}

func sshAccountBinding(serviceURL, instanceURL, identity string) string {
	sum := sha256.Sum256([]byte(serviceURL + "\x00" + instanceURL + "\x00" + identity))
	return hex.EncodeToString(sum[:])
}

type sshOwnedProcess interface {
	Wait() error
	Kill() error
}

type sshTunnelDependencies struct {
	preflight      func() SshPreflight
	agentPreflight func() SshPreflight
	start          func(context.Context, string, []string, io.Writer) (sshOwnedProcess, error)
	startAgent     func(int) (*localWorkspaceAgent, error)
	registerAgent  func(context.Context, sshAccountScope, SshTunnelProfile, string) error
	after          func(time.Duration) <-chan time.Time
}

type sshTunnelEntry struct {
	profile           SshTunnelProfile
	status            SshTunnelStatus
	scope             sshAccountScope
	ctx               context.Context
	cancel            context.CancelFunc
	done              chan struct{}
	changed           chan struct{}
	retryRegistration chan struct{}
	agent             *localWorkspaceAgent
}

type sshTunnelManager struct {
	mu        sync.Mutex
	profileMu sync.Mutex
	saving    map[string]bool
	path      string
	profiles  map[string]SshTunnelProfile
	entries   map[string]*sshTunnelEntry
	sequence  uint64
	closed    bool
	deps      sshTunnelDependencies
}

func defaultSshTunnelDependencies() sshTunnelDependencies {
	return sshTunnelDependencies{
		preflight:      nativeSshPreflight,
		agentPreflight: nativeAgentPreflight,
		startAgent:     startLocalWorkspaceAgent,
		registerAgent:  registerSshAgent,
		after:          time.After,
		start: func(ctx context.Context, executable string, args []string, output io.Writer) (sshOwnedProcess, error) {
			cmd := hideCommandWindow(exec.CommandContext(ctx, executable, args...))
			cmd.Env = sshTunnelEnvironment()
			cmd.Stdout, cmd.Stderr = output, output
			cmd.WaitDelay = 2 * time.Second
			owner, err := newSshProcessOwner()
			if err != nil {
				return nil, err
			}
			if err := cmd.Start(); err != nil {
				owner.close()
				return nil, err
			}
			if err := owner.assign(cmd.Process.Pid); err != nil {
				_ = cmd.Process.Kill()
				_ = cmd.Wait()
				owner.close()
				return nil, err
			}
			return &sshExecProcess{cmd: cmd, owner: owner}, nil
		},
	}
}

type sshProcessOwner interface {
	assign(pid int) error
	cleanup() error
	close()
}

type sshExecProcess struct {
	cmd   *exec.Cmd
	owner sshProcessOwner
}

func (p *sshExecProcess) Wait() error {
	defer p.owner.close()
	return p.cmd.Wait()
}
func (p *sshExecProcess) Kill() error {
	p.owner.close()
	return p.cmd.Process.Kill()
}

func newSshTunnelManager(directory string, deps sshTunnelDependencies) (*sshTunnelManager, error) {
	defaults := defaultSshTunnelDependencies()
	if deps.agentPreflight == nil {
		deps.agentPreflight = defaults.agentPreflight
	}
	if deps.startAgent == nil {
		deps.startAgent = defaults.startAgent
	}
	if deps.registerAgent == nil {
		deps.registerAgent = defaults.registerAgent
	}
	if deps.after == nil {
		deps.after = defaults.after
	}
	if deps.preflight == nil {
		deps.preflight = defaults.preflight
	}
	if deps.start == nil {
		deps.start = defaults.start
	}
	m := &sshTunnelManager{path: filepath.Join(directory, "ssh-tunnels.json"), profiles: map[string]SshTunnelProfile{}, entries: map[string]*sshTunnelEntry{}, saving: map[string]bool{}, deps: deps}
	stats, err := os.Lstat(m.path)
	if os.IsNotExist(err) {
		return m, nil
	}
	if err != nil || !stats.Mode().IsRegular() || stats.Size() > 512*1024 {
		return nil, sshFailure("SSH_PROFILE_STORE_INVALID", "SSH 配置文件无法安全读取；原文件已保留。")
	}
	raw, err := os.ReadFile(m.path)
	var disk struct {
		Version  int                `json:"version"`
		Profiles []SshTunnelProfile `json:"profiles"`
	}
	if err != nil || json.Unmarshal(raw, &disk) != nil || disk.Version != 1 || len(disk.Profiles) > 128 {
		return nil, sshFailure("SSH_PROFILE_STORE_INVALID", "SSH 配置文件无效；原文件已保留。")
	}
	for _, profile := range disk.Profiles {
		if !sshProfileIDPattern.MatchString(profile.ID) || !sshBindingPattern.MatchString(profile.AccountBinding) || profile.ServiceURL == "" || m.profiles[profile.ID].ID != "" {
			return nil, sshFailure("SSH_PROFILE_STORE_INVALID", "SSH 配置身份无效；原文件已保留。")
		}
		normalized, err := normalizeSshTunnelInput(profile.SshTunnelProfileInput)
		if err != nil {
			return nil, sshFailure("SSH_PROFILE_STORE_INVALID", "SSH 配置内容无效；原文件已保留。")
		}
		profile.SshTunnelProfileInput = normalized
		m.profiles[profile.ID] = profile
	}
	// No runtime state or legacy Config/mappings are ever restored into entries.
	return m, nil
}

var sshProfileIDPattern = regexp.MustCompile(`^[a-f0-9]{32}$`)
var sshBindingPattern = regexp.MustCompile(`^[a-f0-9]{64}$`)
var sshUserPattern = regexp.MustCompile(`^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$`)
var sshHostPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$`)

func normalizeSshTunnelInput(input SshTunnelProfileInput) (SshTunnelProfileInput, error) {
	input.Name, input.SSHHost, input.SSHUser = strings.TrimSpace(input.Name), strings.TrimSpace(input.SSHHost), strings.TrimSpace(input.SSHUser)
	input.Mode = strings.ToLower(strings.TrimSpace(input.Mode))
	if input.Mode == "" {
		input.Mode = "ssh"
	}
	input.KeyPath, input.KnownHostsPath = strings.TrimSpace(input.KeyPath), strings.TrimSpace(input.KnownHostsPath)
	input.AgentTransport = strings.ToLower(strings.TrimSpace(input.AgentTransport))
	if input.Mode == "agent" && input.AgentTransport == "relay" {
		if input.ID != "" && !sshProfileIDPattern.MatchString(input.ID) || input.Name == "" || len(input.Name) > 160 || strings.ContainsAny(input.Name, "\r\n\x00") {
			return input, sshFailure("SSH_PROFILE_INVALID", "本地 Agent 配置名称或标识无效。")
		}
		input.SSHHost, input.SSHUser, input.KeyPath, input.KnownHostsPath = "", "", "", ""
		input.SSHPort, input.LocalPort, input.RemotePort = 0, 0, 18766
		return input, nil
	}
	if input.AgentTransport != "" && input.AgentTransport != "ssh" {
		return input, sshFailure("SSH_PROFILE_INVALID", "Agent 连接方式无效。")
	}
	if input.SSHPort == 0 {
		input.SSHPort = 22
	}
	if input.LocalPort == 0 {
		if input.Mode == "agent" {
			input.LocalPort = 18765
		} else {
			input.LocalPort = 22
		}
	}
	if input.ID != "" && !sshProfileIDPattern.MatchString(input.ID) {
		return input, sshFailure("SSH_PROFILE_INVALID", "SSH 配置标识无效。")
	}
	if input.Mode != "ssh" && input.Mode != "agent" {
		return input, sshFailure("SSH_PROFILE_INVALID", "SSH 配置模式无效。")
	}
	if input.Name == "" || len(input.Name) > 160 || strings.ContainsAny(input.Name, "\r\n\x00") || !sshUserPattern.MatchString(input.SSHUser) || (!sshHostPattern.MatchString(input.SSHHost) && net.ParseIP(input.SSHHost) == nil) {
		return input, sshFailure("SSH_PROFILE_INVALID", "请填写有效的名称、VPS 主机和专用 SSH 用户。")
	}
	if input.SSHPort < 1 || input.SSHPort > 65535 || input.LocalPort < 1 || input.LocalPort > 65535 || input.RemotePort < 1024 || input.RemotePort > 65535 {
		return input, sshFailure("SSH_PORT_INVALID", "SSH 端口须为 1–65535，VPS 反向监听端口须为 1024–65535。")
	}
	if input.Mode == "agent" && input.LocalPort < 1024 {
		return input, sshFailure("SSH_PORT_INVALID", "内置 Agent 端口须为 1024–65535。")
	}
	for _, path := range []string{input.KeyPath, input.KnownHostsPath} {
		if !filepath.IsAbs(path) || strings.ContainsAny(path, "\r\n\x00\"") || strings.Contains(path, "${") || len(path) > 4096 {
			return input, sshFailure("SSH_FILE_REFERENCE_INVALID", "密钥与 known_hosts 必须引用本机绝对文件路径。")
		}
	}
	input.KeyPath, input.KnownHostsPath = filepath.Clean(input.KeyPath), filepath.Clean(input.KnownHostsPath)
	return input, nil
}

func checkSshFileReferences(profile SshTunnelProfileInput) error {
	if profile.Mode == "agent" && profile.AgentTransport == "relay" {
		return nil
	}
	for _, ref := range []struct{ path, code, message string }{
		{profile.KeyPath, "SSH_IDENTITY_UNAVAILABLE", "SSH 身份文件不存在或不可用。"},
		{profile.KnownHostsPath, "SSH_KNOWN_HOSTS_UNAVAILABLE", "known_hosts 文件不存在或为空；请先核对并登记 VPS 主机指纹。"},
	} {
		stats, err := os.Stat(ref.path)
		if err != nil || !stats.Mode().IsRegular() || stats.Size() == 0 {
			return sshFailure(ref.code, ref.message)
		}
	}
	return nil
}

func (m *sshTunnelManager) persistProfiles(profiles []SshTunnelProfile) error {
	if err := os.MkdirAll(filepath.Dir(m.path), 0700); err != nil {
		return sshFailure("SSH_PROFILE_SAVE_FAILED", "无法保存 SSH 配置。")
	}
	raw, err := json.MarshalIndent(struct {
		Version  int                `json:"version"`
		Profiles []SshTunnelProfile `json:"profiles"`
	}{1, profiles}, "", "  ")
	if err != nil {
		return sshFailure("SSH_PROFILE_SAVE_FAILED", "无法保存 SSH 配置。")
	}
	file, err := os.CreateTemp(filepath.Dir(m.path), ".ssh-tunnels-*.tmp")
	if err != nil {
		return sshFailure("SSH_PROFILE_SAVE_FAILED", "无法保存 SSH 配置。")
	}
	name := file.Name()
	defer os.Remove(name)
	if err = file.Chmod(0600); err == nil {
		_, err = file.Write(raw)
	}
	if err == nil {
		err = file.Sync()
	}
	closeErr := file.Close()
	if err == nil {
		err = closeErr
	}
	if err == nil {
		err = os.Rename(name, m.path)
	}
	if err != nil {
		return sshFailure("SSH_PROFILE_SAVE_FAILED", "无法保存 SSH 配置；旧配置未被采用。")
	}
	return nil
}

func (m *sshTunnelManager) save(scope sshAccountScope, input SshTunnelProfileInput) (SshTunnelProfile, error) {
	return m.saveProfile(scope, input, false)
}

func (m *sshTunnelManager) saveDefaultAgent(scope sshAccountScope, input SshTunnelProfileInput) (SshTunnelProfile, error) {
	return m.saveProfile(scope, input, true)
}

func (m *sshTunnelManager) saveProfile(scope sshAccountScope, input SshTunnelProfileInput, defaultAgent bool) (SshTunnelProfile, error) {
	input, err := normalizeSshTunnelInput(input)
	if err != nil {
		return SshTunnelProfile{}, err
	}
	if err := checkSshFileReferences(input); err != nil {
		return SshTunnelProfile{}, err
	}
	// Serialize disk saves independently from cancellation/status. No fsync or
	// preflight runs while holding the lifecycle mutex used by logout.
	m.profileMu.Lock()
	defer m.profileMu.Unlock()
	m.mu.Lock()
	if m.closed || scope.ctx.Err() != nil {
		m.mu.Unlock()
		return SshTunnelProfile{}, sshFailure("SSH_ACCOUNT_CHANGED", "账号连接已改变，请重新打开 SSH 设置。")
	}
	previous, exists := m.profiles[input.ID]
	if defaultAgent {
		for _, p := range m.profilesForLocked(scope.binding) {
			if p.Mode == "agent" {
				m.mu.Unlock()
				return p, nil
			}
		}
	}
	if input.ID != "" && (!exists && !defaultAgent || exists && previous.AccountBinding != scope.binding) {
		m.mu.Unlock()
		return SshTunnelProfile{}, sshFailure("SSH_PROFILE_NOT_FOUND", "当前账号没有此 SSH 配置。")
	}
	if entry := m.entries[input.ID]; entry != nil && sshTunnelActive(entry.status.State) {
		m.mu.Unlock()
		return SshTunnelProfile{}, sshFailure("SSH_TUNNEL_BUSY", "请先停止此隧道，再修改连接配置。")
	}
	if !exists && len(m.profiles) >= 128 {
		m.mu.Unlock()
		return SshTunnelProfile{}, sshFailure("SSH_PROFILE_LIMIT", "SSH 配置数量已达到上限。")
	}
	if input.ID == "" {
		input.ID = randHex(16)
	}
	profile := SshTunnelProfile{SshTunnelProfileInput: input, AccountBinding: scope.binding, ServiceURL: scope.serviceURL}
	profiles := m.profilesForLocked("")
	found := false
	for i := range profiles {
		if profiles[i].ID == profile.ID {
			profiles[i], found = profile, true
		}
	}
	if !found {
		profiles = append(profiles, profile)
	}
	m.saving[input.ID] = true
	m.mu.Unlock()
	err = m.persistProfiles(profiles)
	m.mu.Lock()
	defer m.mu.Unlock()
	delete(m.saving, input.ID)
	if err != nil {
		return SshTunnelProfile{}, err
	}
	m.profiles[input.ID] = profile
	return profile, nil
}

func (m *sshTunnelManager) profilesForLocked(binding string) []SshTunnelProfile {
	profiles := make([]SshTunnelProfile, 0, len(m.profiles))
	for _, p := range m.profiles {
		if binding == "" || p.AccountBinding == binding {
			profiles = append(profiles, p)
		}
	}
	// Stable order makes persistence and repeated UI reads predictable.
	for i := 1; i < len(profiles); i++ {
		for j := i; j > 0 && profiles[j].ID < profiles[j-1].ID; j-- {
			profiles[j], profiles[j-1] = profiles[j-1], profiles[j]
		}
	}
	return profiles
}

func (m *sshTunnelManager) list(scope sshAccountScope) ([]SshTunnelProfile, []SshTunnelStatus) {
	m.mu.Lock()
	defer m.mu.Unlock()
	profiles := m.profilesForLocked(scope.binding)
	statuses := make([]SshTunnelStatus, 0, len(profiles))
	for _, p := range profiles {
		statuses = append(statuses, m.statusLocked(p.ID))
	}
	return profiles, statuses
}

func (m *sshTunnelManager) statusLocked(id string) SshTunnelStatus {
	if entry := m.entries[id]; entry != nil {
		return entry.status
	}
	return SshTunnelStatus{ProfileID: id, State: "stopped"}
}

func (m *sshTunnelManager) getStatus(scope sshAccountScope, id string) (SshTunnelStatus, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if p, ok := m.profiles[id]; !ok || p.AccountBinding != scope.binding {
		return SshTunnelStatus{}, sshFailure("SSH_PROFILE_NOT_FOUND", "当前账号没有此 SSH 配置。")
	}
	return m.statusLocked(id), nil
}

// The tunnel needs OS/profile discovery and optionally the already-unlocked
// agent, not cloud provider tokens, askpass helpers or arbitrary inherited state.
func sshTunnelEnvironment() []string {
	// Windows OpenSSH initializes ProgramData before parsing command-line flags,
	// including -F NUL. Omitting it exits before SSH can emit normal diagnostics.
	allowed := map[string]bool{"systemroot": true, "windir": true, "systemdrive": true, "programdata": true, "userprofile": true, "homedrive": true, "homepath": true, "temp": true, "tmp": true, "ssh_auth_sock": true}
	result := []string{"SSH_ASKPASS_REQUIRE=never"}
	for _, value := range os.Environ() {
		key, _, found := strings.Cut(value, "=")
		if found && allowed[strings.ToLower(key)] {
			result = append(result, value)
		}
	}
	return result
}

func sshTunnelArguments(profile SshTunnelProfile, localPort ...int) []string {
	targetPort := profile.LocalPort
	if len(localPort) > 0 {
		targetPort = localPort[0]
	}
	return []string{
		"-F", os.DevNull, "-N", "-T", "-v", "-a", "-S", "none", "-p", strconv.Itoa(profile.SSHPort),
		"-l", profile.SSHUser, "-i", strings.ReplaceAll(profile.KeyPath, "%", "%%"),
		"-o", "BatchMode=yes", "-o", "IdentitiesOnly=yes", "-o", "StrictHostKeyChecking=yes",
		"-o", "UserKnownHostsFile=\"" + strings.ReplaceAll(filepath.ToSlash(profile.KnownHostsPath), "%", "%%") + "\"", "-o", "GlobalKnownHostsFile=" + os.DevNull,
		"-o", "UpdateHostKeys=no", "-o", "PermitLocalCommand=no", "-o", "ProxyCommand=none", "-o", "ProxyJump=none",
		"-o", "ControlMaster=no", "-o", "ExitOnForwardFailure=yes", "-o", "ConnectTimeout=10",
		"-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=3", "-o", "NumberOfPasswordPrompts=0",
		"-R", fmt.Sprintf("127.0.0.1:%d:127.0.0.1:%d", profile.RemotePort, targetPort), "--", profile.SSHHost,
	}
}

// The agent path needs only the system OpenSSH client for the reverse tunnel;
// it deliberately does not require a local sshd, service or administrator.
func nativeAgentPreflight() SshPreflight {
	result := nativeSshPreflight()
	result.AgentAvailable = result.SSHAvailable
	result.OK = result.SSHAvailable
	issues := make([]SshPreflightIssue, 0, len(result.Issues))
	for _, issue := range result.Issues {
		if issue.Code == "SSH_CLIENT_MISSING" {
			issues = append(issues, issue)
		}
	}
	result.Issues = issues
	return result
}

func sshTunnelActive(state string) bool {
	return state == "starting" || state == "forwarding" || state == "reconnecting" || state == "stopping"
}

func (m *sshTunnelManager) notifyLocked(entry *sshTunnelEntry) {
	close(entry.changed)
	entry.changed = make(chan struct{})
}

// Reserve ownership under the mutex, then perform filesystem, preflight and
// listener setup in the supervisor. Logout never waits for those operations.
func (m *sshTunnelManager) start(scope sshAccountScope, id string) (SshTunnelStatus, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	profile, ok := m.profiles[id]
	if !ok || profile.AccountBinding != scope.binding {
		return SshTunnelStatus{}, sshFailure("SSH_PROFILE_NOT_FOUND", "当前账号没有此 SSH 配置。")
	}
	if m.closed || scope.ctx.Err() != nil {
		return SshTunnelStatus{}, sshFailure("SSH_ACCOUNT_CHANGED", "账号连接已改变，请重新打开 SSH 设置。")
	}
	if m.saving[id] {
		return SshTunnelStatus{}, sshFailure("SSH_TUNNEL_BUSY", "SSH 配置正在保存，请稍后再连接。")
	}
	for _, active := range m.entries {
		if sshTunnelActive(active.status.State) {
			if active.profile.ID == id && active.status.State != "stopping" {
				if active.status.RegistrationState == "error" {
					active.status.RegistrationState, active.status.RegistrationError = "registering", ""
					select {
					case active.retryRegistration <- struct{}{}:
					default:
					}
					m.notifyLocked(active)
				}
				return active.status, nil
			}
			return SshTunnelStatus{}, sshFailure("SSH_TUNNEL_BUSY", "请等待正在运行或停止中的 SSH 隧道完成。")
		}
	}
	ctx, cancel := context.WithCancel(scope.ctx)
	m.sequence++
	entry := &sshTunnelEntry{profile: profile, scope: scope, ctx: ctx, status: SshTunnelStatus{ProfileID: id, State: "starting", Generation: m.sequence, Message: "正在准备反向 SSH 转发。"}, cancel: cancel, done: make(chan struct{}), changed: make(chan struct{}), retryRegistration: make(chan struct{}, 1)}
	if profile.Mode == "agent" {
		entry.status.RegistrationState = "unregistered"
	}
	m.entries[id] = entry
	go m.run(entry)
	return entry.status, nil
}

func (m *sshTunnelManager) stopEntryLocked(entry *sshTunnelEntry) {
	if entry != nil && sshTunnelActive(entry.status.State) && entry.status.State != "stopping" {
		entry.status.State, entry.status.OuterConnected, entry.status.Message = "stopping", false, "正在停止本应用的 SSH 转发与 Agent。"
		entry.cancel()
		m.notifyLocked(entry)
	}
}

func (m *sshTunnelManager) stop(scope sshAccountScope, id string) (SshTunnelStatus, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if p, ok := m.profiles[id]; !ok || p.AccountBinding != scope.binding {
		return SshTunnelStatus{}, sshFailure("SSH_PROFILE_NOT_FOUND", "当前账号没有此 SSH 配置。")
	}
	m.stopEntryLocked(m.entries[id])
	return m.statusLocked(id), nil
}

func (m *sshTunnelManager) stopAll(closeManager bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.closed = m.closed || closeManager
	for _, entry := range m.entries {
		m.stopEntryLocked(entry)
	}
}

// closeAdmission freezes a shutdown snapshot without stopping the transport.
// Existing authenticated relay cleanup stays live while frontend aborts reach
// the server. Entries cannot be replaced once the manager is closed.
func (m *sshTunnelManager) closeAdmission() []*sshTunnelEntry {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.closed = true
	entries := make([]*sshTunnelEntry, 0, len(m.entries))
	for _, entry := range m.entries {
		if sshTunnelActive(entry.status.State) {
			entries = append(entries, entry)
		}
	}
	return entries
}

// stopAndWait waits outside the manager/account locks. done includes owned
// process reap, helper/receipt cleanup and relay worker completion.
func (m *sshTunnelManager) stopAndWait(ctx context.Context, entries []*sshTunnelEntry) error {
	m.stopAll(true)
	for _, entry := range entries {
		select {
		case <-entry.done:
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	return nil
}

func (m *sshTunnelManager) ensure(scope sshAccountScope, id string, timeout time.Duration) (SshTunnelStatus, error) {
	ctx, cancel := context.WithTimeout(scope.ctx, timeout)
	defer cancel()
	// An explicit ensure after stop waits for the old listener and helper jobs
	// to be reaped before reserving a replacement generation.
	for {
		m.mu.Lock()
		entry := m.entries[id]
		var stopping <-chan struct{}
		if entry != nil && entry.status.State == "stopping" {
			stopping = entry.done
		}
		m.mu.Unlock()
		if stopping == nil {
			break
		}
		select {
		case <-stopping:
		case <-ctx.Done():
			return SshTunnelStatus{}, sshEnsureContextError(scope, ctx)
		}
	}
	if _, err := m.start(scope, id); err != nil {
		return SshTunnelStatus{}, err
	}
	for {
		m.mu.Lock()
		entry := m.entries[id]
		status, changed := entry.status, entry.changed
		m.mu.Unlock()
		if scope.ctx.Err() != nil {
			return status, sshEnsureContextError(scope, ctx)
		}
		if status.State == "forwarding" && status.OuterConnected && status.RegistrationState == "registered" {
			return status, nil
		}
		if status.State == "error" {
			return status, sshFailure(status.Code, status.Message)
		}
		if status.RegistrationState == "error" {
			return status, sshFailure("SSH_AGENT_REGISTRATION_FAILED", status.RegistrationError)
		}
		if status.State == "stopped" || status.State == "stopping" {
			return status, sshFailure("SSH_AGENT_STOPPED", "本地 Agent 已停止，请重新连接。")
		}
		select {
		case <-changed:
		case <-ctx.Done():
			return status, sshEnsureContextError(scope, ctx)
		}
	}
}

func sshEnsureContextError(scope sshAccountScope, ctx context.Context) error {
	if scope.ctx.Err() != nil {
		return sshFailure("SSH_ACCOUNT_CHANGED", "账号连接已改变，本地 Agent 准备已取消。")
	}
	return sshFailure("SSH_AGENT_READY_TIMEOUT", "等待本地 Agent 转发与登记超时；请查看状态后重试。")
}

func (m *sshTunnelManager) run(entry *sshTunnelEntry) {
	ctx := entry.ctx
	code, message := "", "SSH 转发与 Agent 已停止。"
	defer func() {
		entry.cancel()
		// Cleanup precedes terminal status and done: terminal state is permission
		// to bind the same listener again, so it must never race Agent.Close.
		if entry.agent != nil {
			_ = entry.agent.Close()
		}
		m.mu.Lock()
		defer m.mu.Unlock()
		state := "error"
		if code == "" || ctx.Err() != nil && entry.status.State == "stopping" {
			state, code, message = "stopped", "", "SSH 转发与 Agent 已停止。"
		}
		entry.status.State, entry.status.Code, entry.status.Message, entry.status.OuterConnected = state, code, message, false
		if entry.agent != nil {
			entry.status.RegistrationState = "unregistered"
		}
		m.notifyLocked(entry)
		close(entry.done)
	}()
	if ctx.Err() != nil {
		return
	}
	if entry.profile.Mode == "agent" && entry.profile.AgentTransport == "relay" {
		code, message = m.runRelay(entry)
		return
	}
	if err := checkSshFileReferences(entry.profile.SshTunnelProfileInput); err != nil {
		code, message = sshErrorFields(err)
		return
	}
	preflight := m.deps.preflight()
	if entry.profile.Mode == "agent" {
		preflight = m.deps.agentPreflight()
	}
	if ctx.Err() != nil {
		return
	}
	if !preflight.OK {
		code, message = "SSH_PREFLIGHT_FAILED", "Windows SSH 前置条件尚未满足。"
		if len(preflight.Issues) > 0 {
			code, message = preflight.Issues[0].Code, preflight.Issues[0].Message
		}
		return
	}
	localPort := entry.profile.LocalPort
	if entry.profile.Mode == "agent" {
		agent, err := m.deps.startAgent(localPort)
		if err != nil {
			code, message = "SSH_AGENT_START_FAILED", "无法启动内置工作区 Agent；请检查端口是否被占用。"
			return
		}
		entry.agent, localPort = agent, agent.port
	}
	for attempt := 0; ; attempt++ {
		if ctx.Err() != nil {
			code = ""
			return
		}
		code, message = m.runAttempt(entry, preflight.sshExecutable, localPort)
		if ctx.Err() != nil {
			code = ""
			return
		}
		if entry.agent == nil || !sshTransientFailure(code) {
			return
		}
		m.mu.Lock()
		entry.status.State, entry.status.OuterConnected = "reconnecting", false
		entry.status.Code, entry.status.Message, entry.status.ReconnectAttempt = code, message, attempt+1
		entry.status.RegistrationState = "unregistered"
		m.notifyLocked(entry)
		m.mu.Unlock()
		delay := time.Second << min(attempt, 5)
		select {
		case <-ctx.Done():
			code = ""
			return
		case <-m.deps.after(delay):
		}
	}
}

func sshErrorFields(err error) (string, string) {
	response := sshErrorResponse(err)
	return response["code"].(string), response["error"].(string)
}

func sshTransientFailure(code string) bool {
	return code == "SSH_CONNECTION_FAILED" || code == "SSH_TUNNEL_EXITED" || code == "SSH_START_TIMEOUT" || code == "SSH_REMOTE_FORWARD_FAILED"
}

func (m *sshTunnelManager) runAttempt(entry *sshTunnelEntry, executable string, localPort int) (string, string) {
	ctx, cancel := context.WithCancel(entry.ctx)
	defer cancel()
	output := newSshTunnelOutput(entry.profile, localPort)
	child, err := m.deps.start(ctx, executable, sshTunnelArguments(entry.profile, localPort), output)
	if err != nil {
		return "SSH_START_FAILED", "无法启动系统 SSH 客户端。"
	}
	waited := make(chan error, 1)
	go func() { waited <- child.Wait() }()
	startup, ready := m.deps.after(20*time.Second), output.ready
	var registration <-chan error
	var cancelRegistration context.CancelFunc
	beginRegistration := func() {
		if entry.agent == nil || registration != nil || ctx.Err() != nil {
			return
		}
		registerCtx, registerCancel := context.WithTimeout(ctx, 12*time.Second)
		cancelRegistration = registerCancel
		result := make(chan error, 1)
		registration = result
		m.mu.Lock()
		if ctx.Err() != nil || entry.status.State == "stopping" {
			m.mu.Unlock()
			registerCancel()
			registration, cancelRegistration = nil, nil
			return
		}
		entry.status.RegistrationState, entry.status.RegistrationError = "registering", ""
		m.notifyLocked(entry)
		m.mu.Unlock()
		go func() { result <- m.deps.registerAgent(registerCtx, entry.scope, entry.profile, entry.agent.token) }()
	}
	defer func() {
		if cancelRegistration != nil {
			cancelRegistration()
		}
		if registration != nil {
			<-registration
		}
	}()
	for {
		select {
		case <-ready:
			ready, startup = nil, nil
			m.mu.Lock()
			if ctx.Err() == nil && entry.status.State != "stopping" {
				entry.status.State, entry.status.OuterConnected, entry.status.Code = "forwarding", true, ""
				entry.status.Message = "反向转发已建立；项目目录仍需独立验证。"
				m.notifyLocked(entry)
			}
			m.mu.Unlock()
			beginRegistration()
		case err := <-registration:
			cancelRegistration()
			registration, cancelRegistration = nil, nil
			m.mu.Lock()
			if ctx.Err() == nil && entry.status.State == "forwarding" {
				entry.status.RegistrationState = "registered"
				if err != nil {
					_, safe := sshErrorFields(err)
					entry.status.RegistrationState, entry.status.RegistrationError = "error", safe
				}
				m.notifyLocked(entry)
			}
			m.mu.Unlock()
		case <-entry.retryRegistration:
			if ready == nil {
				beginRegistration()
			}
		case <-startup:
			cancel()
			_ = child.Kill()
			<-waited
			return "SSH_START_TIMEOUT", "未能确认反向监听建立；请检查 VPS 转发权限和网络。"
		case <-ctx.Done():
			_ = child.Kill()
			<-waited
			return "", "SSH 转发已停止。"
		case <-waited:
			cancel()
			return output.failure()
		}
	}
}

// SSH diagnostic text may contain key paths and host details. It is consumed as
// bounded parser input only, never returned through native APIs or application logs.
type sshTunnelOutput struct {
	mu      sync.Mutex
	ready   chan struct{}
	success string
	line    string
	total   int
	code    string
	message string
}

func newSshTunnelOutput(profile SshTunnelProfile, localPort ...int) *sshTunnelOutput {
	targetPort := profile.LocalPort
	if len(localPort) > 0 {
		targetPort = localPort[0]
	}
	return &sshTunnelOutput{ready: make(chan struct{}, 1), success: fmt.Sprintf("remote forward success for: listen 127.0.0.1:%d, connect 127.0.0.1:%d", profile.RemotePort, targetPort)}
}

func (output *sshTunnelOutput) Write(bytes []byte) (int, error) {
	output.mu.Lock()
	defer output.mu.Unlock()
	length := len(bytes)
	remaining := 64*1024 - output.total
	if remaining <= 0 {
		return length, nil
	}
	if len(bytes) > remaining {
		bytes = bytes[:remaining]
	}
	output.total += len(bytes)
	for _, b := range bytes {
		if b == '\n' || b == '\r' {
			output.parseLine(output.line)
			output.line = ""
		} else if len(output.line) < 4096 {
			output.line += string(b)
		}
	}
	return length, nil
}

func (output *sshTunnelOutput) parseLine(line string) {
	if strings.Contains(line, output.success) {
		select {
		case output.ready <- struct{}{}:
		default:
		}
	}
	lower := strings.ToLower(line)
	switch {
	case strings.Contains(lower, "remote host identification has changed") || strings.Contains(lower, "host key verification failed") || strings.Contains(lower, "no host key is known"):
		output.code, output.message = "SSH_HOST_KEY_REJECTED", "VPS 主机指纹尚未登记或已变化；请核对 known_hosts，应用不会自动接受。"
	case strings.Contains(lower, "permission denied") || strings.Contains(lower, "no supported authentication methods"):
		output.code, output.message = "SSH_AUTH_FAILED", "VPS SSH 密钥认证失败，请检查专用账户及身份文件。"
	case strings.Contains(lower, "remote port forwarding failed") || strings.Contains(lower, "remote forward failure") || strings.Contains(lower, "cannot listen to port"):
		output.code, output.message = "SSH_REMOTE_FORWARD_FAILED", "VPS 拒绝反向监听或端口已被占用。"
	case strings.Contains(lower, "could not resolve hostname") || strings.Contains(lower, "connection refused") || strings.Contains(lower, "connection timed out") || strings.Contains(lower, "network is unreachable"):
		output.code, output.message = "SSH_CONNECTION_FAILED", "无法连接 VPS SSH 服务，请检查地址、端口和网络。"
	}
}

func (output *sshTunnelOutput) failure() (string, string) {
	output.mu.Lock()
	defer output.mu.Unlock()
	output.parseLine(output.line)
	if output.code != "" {
		return output.code, output.message
	}
	return "SSH_TUNNEL_EXITED", "SSH 转发已退出；请检查连接后手动重连，不会自动重放本地任务。"
}
