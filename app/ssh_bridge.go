package main

import (
	"context"
	"path/filepath"
	"sync"
	"time"

	"github.com/egoist/mygo"
)

var desktopSshMu sync.Mutex
var desktopSshManager *sshTunnelManager
var desktopSshClosed bool

// Authentication and cloud account/instance identity remain owned by the
// existing HTTPS connection. Native SSH accepts no account supplied by the UI.
func currentSshAccount() (sshAccountScope, error) {
	serverConnectionMu.RLock()
	defer serverConnectionMu.RUnlock()
	connection := apiConnection
	if connection == nil || !connection.authenticated || connection.accountIdentity == "" || connection.ctx == nil || connection.ctx.Err() != nil {
		return sshAccountScope{}, sshFailure("SSH_ACCOUNT_REQUIRED", "请先登录当前云端账号，再配置本地 SSH。")
	}
	accountContext := connection.sshContext
	if accountContext == nil {
		accountContext = connection.ctx
	}
	return sshAccountScope{binding: sshAccountBinding(connection.loginURL, connection.baseURL, connection.accountIdentity), serviceURL: connection.loginURL, ctx: accountContext, connection: connection, identity: connection.accountIdentity, version: connection.version}, nil
}

func getDesktopSshManager() (*sshTunnelManager, error) {
	desktopSshMu.Lock()
	defer desktopSshMu.Unlock()
	if desktopSshClosed {
		return nil, sshFailure("SSH_DESKTOP_CLOSED", "桌面窗口已关闭，不能启动新的 SSH 操作。")
	}
	if desktopSshManager == nil {
		manager, err := newSshTunnelManager(dataDir(), defaultSshTunnelDependencies())
		if err != nil {
			return nil, err
		}
		desktopSshManager = manager
	}
	return desktopSshManager, nil
}

// Caller holds serverConnectionMu. Revoking the previous SSH context prevents a
// saved in-flight native call from starting after a same-transport account change.
func resetSshAccountIdentity(connection *serverConnection) {
	if connection.sshCancel != nil {
		connection.sshCancel()
	}
	stopDesktopSshTunnels(false)
	connection.sshContext, connection.sshCancel = context.WithCancel(connection.ctx)
}

// No account lock, cloud request or child-exit wait is taken here. Cloud switch
// and window teardown must stay responsive even if the SSH child is exiting.
func stopDesktopSshTunnels(closeDesktop bool) {
	desktopSshMu.Lock()
	defer desktopSshMu.Unlock()
	desktopSshClosed = desktopSshClosed || closeDesktop
	if desktopSshManager != nil {
		desktopSshManager.stopAll(closeDesktop)
	}
}

// Old references are eligible only when the prior enrollment recorded this
// exact authenticated account and service with a pinned host. Listing is inert.
func trustedLegacySshConfig(scope sshAccountScope) (Config, bool) {
	if store == nil {
		return Config{}, false
	}
	cfg := store.config()
	return cfg, cfg.WorkspaceAccount != "" && cfg.WorkspaceAccount == scope.identity && cfg.WorkspaceLoginURL == scope.serviceURL && cfg.SSHHostKeyPinned && cfg.ServerURL != "" && cfg.ServerURL == cfg.WorkspaceServerURL
}

func defaultSshAgentProfile(manager *sshTunnelManager, scope sshAccountScope) (SshTunnelProfile, error) {
	manager.mu.Lock()
	profiles := manager.profilesForLocked(scope.binding)
	manager.mu.Unlock()
	for _, profile := range profiles {
		if profile.Mode == "agent" && profile.AgentTransport == "relay" {
			return profile, nil
		}
	}
	for _, profile := range profiles {
		if profile.Mode == "agent" {
			return profile, nil
		}
	}
	// New installations need only the authenticated service connection. Existing
	// saved profiles keep their explicit transport; no global legacy key is adopted.
	return manager.saveDefaultAgent(scope, SshTunnelProfileInput{ID: scope.binding[:32], Name: "本机 Agent", Mode: "agent", AgentTransport: "relay"})
}

func sshManagerForAccount() (*sshTunnelManager, sshAccountScope, error) {
	scope, err := currentSshAccount()
	if err != nil {
		return nil, scope, err
	}
	manager, err := getDesktopSshManager()
	return manager, scope, err
}

// GetSshDefaults exposes only non-secret legacy connection fields so the new
// agent form can prefill the VPS endpoint and existing key references.
func (FrontendBridge) GetSshDefaults() map[string]any {
	scope, err := currentSshAccount()
	if err != nil {
		return sshErrorResponse(err)
	}
	cfg, trusted := trustedLegacySshConfig(scope)
	if !trusted {
		return sshErrorResponse(sshFailure("SSH_AGENT_PROFILE_REQUIRED", "当前账号没有可安全采用的旧 SSH 配置，请手动填写连接。"))
	}
	port := cfg.SSHPort
	if port == 0 {
		port = 22
	}
	return map[string]any{
		"ok": true, "sshHost": cfg.SSHHost, "sshPort": port, "sshUser": cfg.SSHUser,
		"keyPath": cfg.KeyPath, "knownHostsPath": cfg.SSHKnownHostsPath,
		"remotePort": 18766, "localPort": 18765,
	}
}

// New SSH methods deliberately do not reactivate SelectLocalFolder,
// SelectWorkspaceKey, ConnectWorkspace or any retired synchronization RPC.
func (FrontendBridge) SelectSshLocalFolder() map[string]any {
	return selectSshPath(true, "选择本地 SSH 项目目录")
}

func (FrontendBridge) SelectSshIdentityFile() map[string]any {
	return selectSshPath(false, "选择 SSH 身份文件（仅保存路径）")
}

func (FrontendBridge) SelectSshKnownHostsFile() map[string]any {
	return selectSshPath(false, "选择已核对 VPS 指纹的 known_hosts 文件")
}

func selectSshPath(directory bool, title string) map[string]any {
	scope, err := currentSshAccount()
	if err != nil {
		return sshErrorResponse(err)
	}
	paths, err := mygo.Dialog.Open(mygo.OpenDialogOptions{Parent: win, Title: title, Directory: directory, ShowHiddenFiles: true})
	if err != nil {
		return sshErrorResponse(sshFailure("SSH_DIALOG_FAILED", "无法打开本机文件选择窗口。"))
	}
	if scope.ctx.Err() != nil {
		return sshErrorResponse(sshFailure("SSH_ACCOUNT_CHANGED", "账号连接已改变，请重新选择。"))
	}
	if len(paths) == 0 {
		return map[string]any{"ok": true, "cancelled": true}
	}
	return map[string]any{"ok": true, "path": filepath.Clean(paths[0])}
}

func (FrontendBridge) GetSshPreflight() map[string]any {
	if _, err := currentSshAccount(); err != nil {
		return sshErrorResponse(err)
	}
	result := nativeSshPreflight()
	return map[string]any{"ok": result.OK, "platform": result.Platform, "sshAvailable": result.SSHAvailable, "sshdAvailable": result.SSHDAvailable, "sshdServiceInstalled": result.SSHDServiceInstalled, "sshdServiceRunning": result.SSHDServiceRunning, "issues": result.Issues}
}

func (FrontendBridge) SaveSshTunnelProfile(profile SshTunnelProfileInput) map[string]any {
	manager, scope, err := sshManagerForAccount()
	if err != nil {
		return sshErrorResponse(err)
	}
	saved, err := manager.save(scope, profile)
	if err != nil {
		return sshErrorResponse(err)
	}
	if scope.ctx.Err() != nil {
		return sshErrorResponse(sshFailure("SSH_ACCOUNT_CHANGED", "账号连接已改变，配置保留在原账号下。"))
	}
	return map[string]any{"ok": true, "profile": saved}
}

func (FrontendBridge) GetSshTunnelProfiles() map[string]any {
	manager, scope, err := sshManagerForAccount()
	if err != nil {
		return sshErrorResponse(err)
	}
	profiles, statuses := manager.list(scope)
	if scope.ctx.Err() != nil {
		return sshErrorResponse(sshFailure("SSH_ACCOUNT_CHANGED", "账号连接已改变，请重新打开 SSH 设置。"))
	}
	return map[string]any{"ok": true, "profiles": profiles, "statuses": statuses}
}

func (FrontendBridge) StartSshTunnel(profileID string) map[string]any {
	manager, scope, err := sshManagerForAccount()
	if err != nil {
		return sshErrorResponse(err)
	}
	status, err := manager.start(scope, profileID)
	if err != nil {
		return sshErrorResponse(err)
	}
	return map[string]any{"ok": true, "status": status}
}

// EnsureSshAgent owns readiness and registration; no Agent credential crosses
// the JavaScript bridge. UI unmounts do not cancel the shared account supervisor.
func (FrontendBridge) EnsureSshAgent(profileID string) map[string]any {
	manager, scope, err := sshManagerForAccount()
	if err != nil {
		return sshErrorResponse(err)
	}
	var profile SshTunnelProfile
	if profileID == "" {
		profile, err = defaultSshAgentProfile(manager, scope)
	} else {
		manager.mu.Lock()
		profile = manager.profiles[profileID]
		manager.mu.Unlock()
		if profile.ID == "" || profile.AccountBinding != scope.binding {
			err = sshFailure("SSH_PROFILE_NOT_FOUND", "当前账号没有此 SSH 配置。")
		}
	}
	if err != nil {
		return sshErrorResponse(err)
	}
	if profile.Mode != "agent" {
		return sshErrorResponse(sshFailure("SSH_AGENT_PROFILE_REQUIRED", "请选择内置 Agent 模式的连接配置。"))
	}
	status, err := manager.ensure(scope, profile.ID, 35*time.Second)
	if scope.ctx.Err() != nil {
		return sshErrorResponse(sshFailure("SSH_ACCOUNT_CHANGED", "账号连接已改变，本地 Agent 准备已取消。"))
	}
	result := map[string]any{"ok": true}
	if err != nil {
		result = sshErrorResponse(err)
	}
	result["profile"], result["status"] = profile, status
	return result
}

func (FrontendBridge) StopSshTunnel(profileID string) map[string]any {
	manager, scope, err := sshManagerForAccount()
	if err != nil {
		return sshErrorResponse(err)
	}
	status, err := manager.stop(scope, profileID)
	if err != nil {
		return sshErrorResponse(err)
	}
	return map[string]any{"ok": true, "status": status}
}

func (FrontendBridge) GetSshTunnelStatus(profileID string) map[string]any {
	manager, scope, err := sshManagerForAccount()
	if err != nil {
		return sshErrorResponse(err)
	}
	status, err := manager.getStatus(scope, profileID)
	if err != nil {
		return sshErrorResponse(err)
	}
	if scope.ctx.Err() != nil {
		return sshErrorResponse(sshFailure("SSH_ACCOUNT_CHANGED", "账号连接已改变，请重新读取 SSH 状态。"))
	}
	return map[string]any{"ok": true, "status": status}
}
