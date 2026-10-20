package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

// A login and every local-folder open share the same account-bound setup.
type accountWorkspaceSetup struct {
	done chan struct{}
	err  error
}

var errWorkspaceMappingsConflict = fmt.Errorf("此本机目录仍绑定其他账号，请到「设置 → 服务器与同步 → 项目同步」找到该项目并点击「切换此项目」；其他项目和两端文件会保留")

type accountWorkspaceEnrollment struct {
	SSHHost            string `json:"sshHost"`
	SSHUser            string `json:"sshUser"`
	SSHPort            int    `json:"sshPort"`
	WorkspaceServerURL string `json:"workspaceServerUrl"`
	WorkspaceRoot      string `json:"workspaceRoot"`
	ControlHost        string `json:"controlHost"`
	HostKey            string `json:"hostKey"`
	RecoveryOnly       bool   `json:"recoveryOnly,omitempty"`
}

func (FrontendBridge) ConnectAccountWorkspace() map[string]any {
	serverConnectionMu.RLock()
	connection := apiConnection
	serverConnectionMu.RUnlock()
	if err := waitAccountWorkspace(connection, true); err != nil {
		return map[string]any{"ok": false, "error": err.Error()}
	}
	return map[string]any{"ok": true, "tunnel": true}
}

type accountWorkspaceRetryPolicy int

const (
	accountWorkspaceReuseSetup accountWorkspaceRetryPolicy = iota
	accountWorkspaceRetryFailure
	accountWorkspaceRetrySetup
)

func waitAccountWorkspace(connection *serverConnection, retry bool) error {
	policy := accountWorkspaceReuseSetup
	if retry {
		policy = accountWorkspaceRetrySetup
	}
	return waitAccountWorkspaceWithPolicy(connection, policy)
}

func waitAccountWorkspaceWithPolicy(connection *serverConnection, policy accountWorkspaceRetryPolicy) error {
	serverConnectionMu.Lock()
	if connection == nil || apiConnection != connection || !connection.authenticated {
		serverConnectionMu.Unlock()
		return fmt.Errorf("请先登录账号，再打开本机目录")
	}
	setup := connection.workspaceSetup
	if setup != nil && policy != accountWorkspaceReuseSetup {
		select {
		case <-setup.done:
			if policy == accountWorkspaceRetrySetup || setup.err != nil {
				setup = nil
			}
		default:
		}
	}
	if setup == nil {
		setup = &accountWorkspaceSetup{done: make(chan struct{})}
		connection.workspaceSetup = setup
		go func() {
			err := setupAccountWorkspace(connection)
			serverConnectionMu.Lock()
			setup.err = err
			close(setup.done)
			serverConnectionMu.Unlock()
		}()
	}
	serverConnectionMu.Unlock()
	select {
	case <-connection.ctx.Done():
		return fmt.Errorf("账号连接已改变，请重新打开工作目录")
	case <-setup.done:
		serverConnectionMu.RLock()
		current := apiConnection == connection && connection.authenticated && connection.ctx.Err() == nil
		serverConnectionMu.RUnlock()
		if !current {
			return fmt.Errorf("账号连接已改变，请重新打开工作目录")
		}
		return setup.err
	}
}

func setupAccountWorkspace(connection *serverConnection) error {
	serverConnectionMu.RLock()
	if apiConnection != connection || connection.ctx.Err() != nil {
		serverConnectionMu.RUnlock()
		return fmt.Errorf("账号连接已改变")
	}
	cfg := store.config()
	manual := cfg.WorkspaceAccount == "" && workspaceConnectionMatchesSession() && cfg.SSHHost != ""
	accessToken := connection.accessToken
	accountIdentity := connection.accountIdentity
	serverConnectionMu.RUnlock()
	if manual {
		if info, err := os.Stat(cfg.KeyPath); err == nil && !info.IsDir() {
			if err := startAccountWorkspace(connection, cfg); err != nil {
				return err
			}
			if err := recoverAccountWorkspaceTransport(connection.ctx, connection, true); err != nil {
				log.Printf("[workspace-recovery] %v", err)
			}
			return nil
		}
	}
	if accessToken == "" || accountIdentity == "" {
		return fmt.Errorf("账号授权未就绪，请重新登录")
	}
	ctx, cancel := context.WithTimeout(connection.ctx, 60*time.Second)
	keyPath, publicKey, err := managedWorkspaceKey(ctx, connection, accountIdentity)
	cancel()
	if err != nil {
		return err
	}
	// A legacy network gets one re-enrollment after exact-owner recovery; an
	// active task or preview leaves the recovery transport available for draining.
	for phase := 0; phase < 2; phase++ {
		next, recoveryOnly, err := enrollAccountWorkspace(connection, keyPath, publicKey)
		if err != nil {
			return err
		}
		serverConnectionMu.Lock()
		if apiConnection != connection || connection.ctx.Err() != nil {
			serverConnectionMu.Unlock()
			return fmt.Errorf("账号连接已改变")
		}
		if recoveryOnly {
			connection.workspaceRecoveryOnly = true
		}
		serverConnectionMu.Unlock()
		if err := startAccountWorkspace(connection, next); err != nil {
			return err
		}
		if !recoveryOnly {
			if err := recoverAccountWorkspaceTransport(connection.ctx, connection, true); err != nil {
				log.Printf("[workspace-recovery] %v", err)
			}
			serverConnectionMu.Lock()
			current := apiConnection == connection && connection.ctx.Err() == nil
			if current {
				connection.workspaceRecoveryOnly = false
			}
			serverConnectionMu.Unlock()
			if !current {
				return fmt.Errorf("账号连接已改变")
			}
			return nil
		}
		if phase != 0 {
			return fmt.Errorf("工作区仍有任务或预览待交还；请先停止或恢复这些项目，再重新连接文件同步")
		}
		err = recoverAccountWorkspaceTransport(connection.ctx, connection, false)
		if err != nil {
			return err
		}
	}
	return fmt.Errorf("工作区恢复尚未完成，请重新连接文件同步")
}

func enrollAccountWorkspace(connection *serverConnection, keyPath, publicKey string) (Config, bool, error) {
	serverConnectionMu.RLock()
	if apiConnection != connection || !connection.authenticated || connection.ctx.Err() != nil {
		serverConnectionMu.RUnlock()
		return Config{}, false, fmt.Errorf("账号连接已改变")
	}
	cfg := store.config()
	accessToken, accountIdentity := connection.accessToken, connection.accountIdentity
	serverConnectionMu.RUnlock()
	if accessToken == "" || accountIdentity == "" {
		return Config{}, false, fmt.Errorf("账号授权未就绪，请重新登录")
	}
	ctx, cancel := context.WithTimeout(connection.ctx, 60*time.Second)
	defer cancel()
	body, _ := json.Marshal(map[string]string{"publicKey": publicKey})
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, connection.baseURL+"/api/workspace-sync/enroll", bytes.NewReader(body))
	if err != nil {
		return Config{}, false, err
	}
	request.Header.Set("Authorization", "Bearer "+accessToken)
	request.Header.Set("Content-Type", "application/json")
	response, err := connection.client.Do(request)
	if err != nil {
		return Config{}, false, fmt.Errorf("无法连接文件同步授权服务，请检查账号服务连接")
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		var failure struct {
			Error struct {
				Message string `json:"message"`
			} `json:"error"`
		}
		decodeErr := json.NewDecoder(io.LimitReader(response.Body, 32*1024)).Decode(&failure)
		serverConnectionMu.RLock()
		current := apiConnection == connection && connection.authenticated && ctx.Err() == nil
		serverConnectionMu.RUnlock()
		if !current {
			return Config{}, false, fmt.Errorf("账号连接已改变")
		}
		if decodeErr == nil && failure.Error.Message != "" {
			return Config{}, false, fmt.Errorf("自动文件同步授权失败: %s", failure.Error.Message)
		}
		return Config{}, false, fmt.Errorf("自动文件同步授权失败（HTTP %d），请重新连接文件同步", response.StatusCode)
	}
	var enrolled accountWorkspaceEnrollment
	if err := json.NewDecoder(io.LimitReader(response.Body, 32*1024)).Decode(&enrolled); err != nil {
		return Config{}, false, fmt.Errorf("文件同步服务返回了无效的连接信息")
	}
	if err := validateWorkspaceEnrollment(enrolled); err != nil {
		return Config{}, false, err
	}
	if cfg.WorkspaceServerURL != "" && strings.TrimRight(enrolled.WorkspaceServerURL, "/") != strings.TrimRight(cfg.WorkspaceServerURL, "/") {
		return Config{}, false, fmt.Errorf("文件同步服务与当前账号所属实例不一致")
	}
	knownHosts := filepath.Join(filepath.Dir(keyPath), "known_hosts")
	serverConnectionMu.Lock()
	current := apiConnection == connection && ctx.Err() == nil
	if !current {
		serverConnectionMu.Unlock()
		return Config{}, false, fmt.Errorf("账号连接已改变")
	}
	recordNativeRefreshedToken(connection, response.Header, response.StatusCode)
	err = prepareWorkspaceHostKey(knownHosts, enrolled)
	serverConnectionMu.Unlock()
	if err != nil {
		return Config{}, false, err
	}
	next := cfg
	next.ServerURL, next.WorkspaceServerURL = enrolled.WorkspaceServerURL, enrolled.WorkspaceServerURL
	next.SSHHost, next.SSHUser, next.SSHPort, next.KeyPath = enrolled.SSHHost, enrolled.SSHUser, enrolled.SSHPort, keyPath
	next.WorkspaceRoot = path.Clean(enrolled.WorkspaceRoot)
	next.ControlHost = enrolled.ControlHost
	next.WorkspaceAccount, next.WorkspaceLoginURL = accountIdentity, connection.loginURL
	next.SSHKnownHostsPath, next.SSHHostKeyPinned = knownHosts, enrolled.HostKey != ""
	return next, enrolled.RecoveryOnly, nil
}

func managedWorkspaceKey(ctx context.Context, connection *serverConnection, accountIdentity string) (string, string, error) {
	digest := sha256.Sum256([]byte(connection.loginURL + "\n" + connection.baseURL + "\n" + accountIdentity))
	directory := filepath.Join(dataDir(), "account-sync", fmt.Sprintf("%x", digest[:16]))
	if err := os.MkdirAll(directory, 0700); err != nil {
		return "", "", fmt.Errorf("无法创建本机文件同步密钥目录")
	}
	keyPath := filepath.Join(directory, "id_ed25519")
	keygen := filepath.Join(filepath.Dir(sshExe()), "ssh-keygen.exe")
	if _, err := os.Stat(keygen); err != nil {
		keygen = "ssh-keygen"
	}
	if info, err := os.Stat(keyPath); os.IsNotExist(err) {
		command := hideCommandWindow(exec.CommandContext(ctx, keygen, "-q", "-t", "ed25519", "-N", "", "-C", "ChisaCloudCode account sync", "-f", keyPath))
		if err := command.Run(); err != nil {
			return "", "", fmt.Errorf("无法生成本机文件同步密钥，请检查 OpenSSH 是否可用")
		}
	} else if err != nil || info.IsDir() {
		return "", "", fmt.Errorf("本机文件同步密钥无法读取")
	}
	// Derive the public key even when a previous interrupted setup omitted .pub.
	publicKey, err := hideCommandWindow(exec.CommandContext(ctx, keygen, "-y", "-f", keyPath)).Output()
	if err != nil {
		return "", "", fmt.Errorf("本机文件同步密钥无法读取")
	}
	return keyPath, strings.TrimSpace(string(publicKey)), nil
}

func validateWorkspaceEnrollment(enrolled accountWorkspaceEnrollment) error {
	service, err := url.Parse(enrolled.WorkspaceServerURL)
	controlIP := net.ParseIP(enrolled.ControlHost)
	if err != nil || service.Hostname() == "" || service.User != nil || service.Path != "" || service.RawQuery != "" || service.Fragment != "" || (service.Scheme != "http" && service.Scheme != "https") ||
		enrolled.SSHHost == "" || strings.ContainsAny(enrolled.SSHHost, " \t\r\n/@") || !regexp.MustCompile(`^[a-zA-Z0-9_.-]+$`).MatchString(enrolled.SSHUser) ||
		enrolled.SSHPort < 1 || enrolled.SSHPort > 65535 || !strings.HasPrefix(enrolled.WorkspaceRoot, "/") || strings.ContainsAny(enrolled.WorkspaceRoot, "\x00\r\n") ||
		controlIP == nil || controlIP.To4() == nil || !controlIP.IsPrivate() || enrolled.HostKey == "" {
		return fmt.Errorf("文件同步服务返回了无效的连接信息")
	}
	if enrolled.HostKey != "" {
		fields := strings.Fields(enrolled.HostKey)
		if len(fields) < 2 || strings.ContainsAny(enrolled.HostKey, "\r\n") || (fields[0] != "ssh-ed25519" && fields[0] != "ssh-rsa" && !strings.HasPrefix(fields[0], "ecdsa-sha2-")) {
			return fmt.Errorf("文件同步服务返回了无效的服务器公钥")
		}
		if _, err := base64.StdEncoding.DecodeString(fields[1]); err != nil {
			return fmt.Errorf("文件同步服务返回了无效的服务器公钥")
		}
	}
	return nil
}

func prepareWorkspaceHostKey(file string, enrolled accountWorkspaceEnrollment) error {
	if enrolled.HostKey != "" {
		host := enrolled.SSHHost
		if enrolled.SSHPort != 22 {
			host = fmt.Sprintf("[%s]:%d", host, enrolled.SSHPort)
		}
		if err := os.WriteFile(file, []byte(host+" "+strings.TrimSpace(enrolled.HostKey)+"\n"), 0600); err != nil {
			return fmt.Errorf("无法保存文件同步服务器公钥")
		}
	}
	// Direct app SSH connections must not inherit the user's unrelated host settings.
	if err := os.WriteFile(filepath.Join(filepath.Dir(file), "ssh_config"), []byte("# Managed account file synchronization\n"), 0600); err != nil {
		return fmt.Errorf("无法保存文件同步连接设置")
	}
	return nil
}

func startAccountWorkspace(connection *serverConnection, cfg Config) error {
	serverConnectionMu.Lock()
	if apiConnection != connection || connection.ctx.Err() != nil {
		serverConnectionMu.Unlock()
		return fmt.Errorf("账号连接已改变")
	}
	previous := store.config()
	changing := serverIdentity(previous) != serverIdentity(cfg) || previous.KeyPath != cfg.KeyPath || previous.SSHPort != cfg.SSHPort
	current := tunnel
	transportChanging := changing || current == nil
	if current != nil {
		current.mu.Lock()
		transportChanging = transportChanging || current.stopped || current.proc == nil || !current.bridgeReady || current.bridgePort == 0 || current.Cfg.ControlHost != cfg.ControlHost
		current.mu.Unlock()
	}
	if transportChanging && piRuntimeActive() {
		serverConnectionMu.Unlock()
		return fmt.Errorf("请先停止 Pi 和它运行的程序，再重新连接文件同步")
	}
	var unlockProjects func()
	defer func() {
		if unlockProjects != nil {
			unlockProjects()
		}
	}()
	if transportChanging {
		mappings := store.mappings()
		var err error
		unlockProjects, err = lockAccountWorkspaceMappings(mappings)
		if err != nil {
			serverConnectionMu.Unlock()
			return err
		}
		for _, mapping := range mappings {
			var busyErr error
			if mapping.ServerID == serverIdentity(cfg) {
				busyErr = mappingTaskBusy(mapping, true)
			} else {
				busyErr = inactiveMappingBusy(mapping)
			}
			if busyErr != nil {
				serverConnectionMu.Unlock()
				return fmt.Errorf("项目 %s 尚在使用，未切换同步连接：%w", mapping.LocalPath, busyErr)
			}
		}
		for _, mapping := range mappings {
			if mapping.ServerID != serverIdentity(cfg) {
				if err := pauseInactiveMappingSync(mapping); err != nil {
					serverConnectionMu.Unlock()
					return fmt.Errorf("旧账号项目同步暂停失败，未切换账号连接：%s；%w", mapping.LocalPath, err)
				}
			}
		}
	}
	if err := store.updateConfig(cfg); err != nil {
		serverConnectionMu.Unlock()
		return fmt.Errorf("无法保存文件同步连接设置")
	}
	if current != nil {
		current.mu.Lock()
		stopped := current.stopped
		current.mu.Unlock()
		if changing || stopped || current.Cfg.ControlHost != cfg.ControlHost {
			current.stop()
			current = nil
		}
	}
	if current == nil {
		if changing {
			stopSyncMonitor(false)
		}
		current = newTunnel(cfg, cfg.KeyPath, func() {})
		tunnel = current
	}
	if unlockProjects != nil {
		unlockProjects()
		unlockProjects = nil
	}
	serverConnectionMu.Unlock()
	if err := current.start(); err != nil {
		return err
	}
	serverConnectionMu.RLock()
	valid := apiConnection == connection && connection.ctx.Err() == nil && tunnel == current && workspaceConnectionMatchesSession()
	var sshError error
	if valid {
		_, sshError = prepareSyncSSH(cfg, cfg.KeyPath)
	}
	serverConnectionMu.RUnlock()
	if !valid {
		return fmt.Errorf("账号连接已改变")
	}
	if !current.connected() {
		return fmt.Errorf("文件同步通道尚未就绪，请重新连接文件同步")
	}
	if sshError != nil {
		return sshError
	}
	if err := prepareMutagenTransport(connection.ctx, connection); err != nil {
		return err
	}
	ensureSyncMonitor()
	return nil
}
