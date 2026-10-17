package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/egoist/mygo"
)

// FrontendBridge：仅暴露具体产品能力给 App 自有页面（mygo:// 源）。
// 按计划 §5：不向页面暴露通用 exec；本结构体只含连接、目录选择、受限 API 代理。
type FrontendBridge struct{}

type BridgeResponse struct {
	Status  int               `json:"status"`
	Headers map[string]string `json:"headers"`
	BodyB64 string            `json:"bodyB64"`
}

type FrontendErrorReport struct {
	Source         string `json:"source"`
	Path           string `json:"path"`
	Message        string `json:"message"`
	Stack          string `json:"stack"`
	ComponentStack string `json:"componentStack"`
}

func errorLogField(value string, limit int) string {
	if len(value) <= limit {
		return value
	}
	return strings.ToValidUTF8(value[:limit], "")
}

func errorLogPath(value string) string {
	parsed, err := url.Parse(value)
	if err != nil {
		return ""
	}
	return errorLogField(parsed.Path, 512)
}

func (FrontendBridge) ReportFrontendError(report FrontendErrorReport) {
	report.Source = errorLogField(report.Source, 64)
	report.Path = errorLogPath(report.Path)
	report.Message = errorLogField(report.Message, 2048)
	report.Stack = errorLogField(report.Stack, 8192)
	report.ComponentStack = errorLogField(report.ComponentStack, 8192)
	raw, _ := json.Marshal(report)
	log.Printf("[frontend-error] %s", raw)
}

var serverConnectionMu sync.RWMutex

type bridgeRequest struct {
	ctx        context.Context
	cancel     context.CancelFunc
	connection *serverConnection
}

var bridgeRequests sync.Map

// Reserve before sending so cancellation also works before HTTP forwarding starts.
func (FrontendBridge) BeginServerRequest() string {
	serverConnectionMu.RLock()
	defer serverConnectionMu.RUnlock()
	if apiConnection == nil {
		return ""
	}
	ctx, cancel := context.WithTimeout(apiConnection.ctx, serverRequestTimeout)
	id := randHex(16)
	bridgeRequests.Store(id, &bridgeRequest{ctx: ctx, cancel: cancel, connection: apiConnection})
	context.AfterFunc(ctx, func() { bridgeRequests.Delete(id) })
	return id
}

func (FrontendBridge) CancelServerRequest(id string) {
	if pending, ok := bridgeRequests.Load(id); ok {
		pending.(*bridgeRequest).cancel()
	}
}

// ServerRequest forwards account APIs over the independently verified service connection.
// path 为相对路径（/api/...）；headers 由前端传入（含 Authorization）。
func (FrontendBridge) ServerRequest(id, method, path string, headers map[string]string, bodyB64 string) BridgeResponse {
	started := time.Now()
	resp := BridgeResponse{Status: 502, Headers: map[string]string{}, BodyB64: ""}
	pending, ok := bridgeRequests.Load(id)
	if !ok {
		resp.Status = 499
		resp.Headers["X-Chisa-Error"] = "request canceled"
		return resp
	}
	request := pending.(*bridgeRequest)
	defer request.cancel()
	defer bridgeRequests.Delete(id)
	if request.ctx.Err() != nil {
		resp.Status = 499
		return resp
	}
	if !strings.HasPrefix(path, "/") {
		path = "/" + path
	}
	endpoint, err := url.Parse(path)
	if err != nil || endpoint.Host != "" || endpoint.Scheme != "" || !strings.HasPrefix(endpoint.Path, "/api/") {
		resp.Status = 400
		return resp
	}
	var body io.Reader
	if bodyB64 != "" {
		raw, err := base64.StdEncoding.DecodeString(bodyB64)
		if err != nil {
			resp.Status = 400
			resp.Headers["X-Chisa-Error"] = "bad body"
			return resp
		}
		body = bytes.NewReader(raw)
	}
	baseURL := request.connection.baseURL
	if endpoint.Path == "/api/auth/login" {
		baseURL = request.connection.loginURL
	}
	req, err := http.NewRequestWithContext(request.ctx, strings.ToUpper(method), baseURL+path, body)
	if err != nil {
		resp.Status = 400
		resp.Headers["X-Chisa-Error"] = "bad request"
		return resp
	}
	for k, v := range headers {
		if strings.EqualFold(k, "Host") {
			continue
		}
		req.Header.Set(k, v)
	}
	deadline, _ := request.ctx.Deadline()
	req.Header.Set(workspaceDeadlineHeader, strconv.FormatInt(deadline.UnixMilli(), 10))
	up, err := request.connection.client.Do(req)
	if err != nil {
		if request.ctx.Err() != nil {
			resp.Status = 499
			resp.Headers["X-Chisa-Error"] = "request interrupted; operation may require workspace recovery"
			return resp
		}
		requestError := err
		if wrapped, ok := err.(*url.Error); ok {
			requestError = wrapped.Err
		}
		log.Printf("[server-request] endpoint=%s elapsed=%s error=%v", endpoint.Path, time.Since(started), requestError)
		resp.BodyB64 = b64encode(`{"error":{"message":"无法连接账号服务，请检查服务地址、网络和客户端证书"}}`)
		return resp
	}
	defer up.Body.Close()
	resp.Status = up.StatusCode
	for k := range up.Header {
		lk := strings.ToLower(k)
		if lk == "x-refreshed-token" || lk == "x-auth-error" || lk == "content-type" {
			resp.Headers[k] = up.Header.Get(k)
		}
	}
	raw, readErr := io.ReadAll(io.LimitReader(up.Body, 64*1024*1024+1))
	if request.ctx.Err() != nil {
		return BridgeResponse{Status: 499, Headers: map[string]string{}}
	}
	if readErr != nil || len(raw) > 64*1024*1024 {
		if readErr != nil {
			log.Printf("[server-request] endpoint=%s elapsed=%s error=%v", endpoint.Path, time.Since(started), readErr)
		} else {
			log.Printf("[server-request] endpoint=%s elapsed=%s error=upstream response exceeds bridge limit", endpoint.Path, time.Since(started))
		}
		resp.Status = 502
		resp.Headers["X-Chisa-Error"] = "upstream response exceeds bridge limit"
		return resp
	}
	responseConnection := request.connection
	if resp.Status == http.StatusOK && (endpoint.Path == "/api/auth/login" || endpoint.Path == "/api/auth/user") {
		serverConnectionMu.Lock()
		if apiConnection != request.connection {
			serverConnectionMu.Unlock()
			return BridgeResponse{Status: 499, Headers: map[string]string{}}
		}
		var payload struct {
			Token              string          `json:"token"`
			User               json.RawMessage `json:"user"`
			InstancePath       string          `json:"instancePath"`
			WorkspaceServerURL string          `json:"workspaceServerUrl"`
		}
		if json.Unmarshal(raw, &payload) == nil && len(payload.User) > 0 && string(payload.User) != "null" {
			var account struct {
				ID       json.RawMessage `json:"id,omitempty"`
				Username string          `json:"username,omitempty"`
			}
			accountIdentity := ""
			if json.Unmarshal(payload.User, &account) == nil && (len(account.ID) > 0 || account.Username != "") {
				identity, _ := json.Marshal(account)
				accountIdentity = string(identity)
			}
			if endpoint.Path == "/api/auth/user" {
				payload.InstancePath = up.Header.Get("X-Chisa-Instance-Path")
				payload.WorkspaceServerURL = up.Header.Get("X-Chisa-Workspace-Server-Url")
			}
			if (endpoint.Path == "/api/auth/login" && payload.Token != "") || (endpoint.Path == "/api/auth/user" && payload.InstancePath != "") {
				cfg := store.config()
				previousWorkspaceURL := cfg.WorkspaceServerURL
				cfg.APIURL = request.connection.loginURL
				cfg.WorkspaceServerURL = payload.WorkspaceServerURL
				if payload.InstancePath != "" {
					if !regexp.MustCompile(`^/instances/[a-zA-Z0-9_-]+$`).MatchString(payload.InstancePath) {
						serverConnectionMu.Unlock()
						return loginConnectionError()
					}
					origin, _ := url.Parse(request.connection.loginURL)
					origin.Path = payload.InstancePath
					cfg.APIURL = origin.String()
				}
				preserveConnection := endpoint.Path == "/api/auth/user" && apiConnection.authenticated &&
					accountIdentity != "" && apiConnection.accountIdentity == accountIdentity &&
					apiConnection.baseURL == cfg.APIURL && previousWorkspaceURL == cfg.WorkspaceServerURL
				var next *serverConnection
				if !preserveConnection {
					next, err = newServerConnection(request.connection.loginURL, cfg.APIURL)
					if err != nil {
						serverConnectionMu.Unlock()
						return loginConnectionError()
					}
				}
				if err = store.updateConfig(cfg); err != nil {
					if next != nil {
						next.cancel()
					}
					serverConnectionMu.Unlock()
					return loginConnectionError()
				}
				if next != nil {
					next.authenticated = true
					next.accountIdentity = accountIdentity
					next.accessToken = payload.Token
					if next.accessToken == "" {
						next.accessToken = strings.TrimPrefix(req.Header.Get("Authorization"), "Bearer ")
					}
					replaceServerConnection(next)
				} else if token := strings.TrimPrefix(req.Header.Get("Authorization"), "Bearer "); token != "" {
					apiConnection.accessToken = token
				}
			} else if endpoint.Path == "/api/auth/user" {
				apiConnection.authenticated = true
				apiConnection.accountIdentity = accountIdentity
				apiConnection.accessToken = strings.TrimPrefix(req.Header.Get("Authorization"), "Bearer ")
			}
			resp.Headers["X-Chisa-Connection-Version"] = strconv.FormatUint(apiConnection.version, 10)
			responseConnection = apiConnection
			go resumeAuthorizedWorkspace(apiConnection.version)
		}
		serverConnectionMu.Unlock()
	}
	serverConnectionMu.Lock()
	if apiConnection != responseConnection || responseConnection.ctx.Err() != nil {
		serverConnectionMu.Unlock()
		return BridgeResponse{Status: 499, Headers: map[string]string{}}
	}
	recordNativeRefreshedToken(responseConnection, up.Header, resp.Status)
	serverConnectionMu.Unlock()
	resp.BodyB64 = base64.StdEncoding.EncodeToString(raw)
	return resp
}

// The caller holds serverConnectionMu and has checked the response's connection identity.
func recordNativeRefreshedToken(connection *serverConnection, headers http.Header, status int) {
	if connection == nil || !connection.authenticated || status < 200 || status >= 300 || headers.Get("X-Auth-Error") != "" {
		return
	}
	if token := headers.Get("X-Refreshed-Token"); regexp.MustCompile(`^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$`).MatchString(token) {
		connection.accessToken = token
	}
}

func loginConnectionError() BridgeResponse {
	return BridgeResponse{Status: 502, Headers: map[string]string{"Content-Type": "application/json"}, BodyB64: b64encode(`{"error":{"message":"登录成功，但无法保存对应服务连接；请重试"}}`)}
}

// SelectLocalFolder 原生目录选择器 → 静默建立同步与服务器映射

func (FrontendBridge) SelectLocalFolder() map[string]any {
	paths, err := mygo.Dialog.Open(mygo.OpenDialogOptions{
		Title:     "选择要交给 Claude 的本地文件夹",
		Directory: true,
	})
	if err != nil {
		return map[string]any{"ok": false, "error": err.Error()}
	}
	if len(paths) == 0 {
		return map[string]any{"ok": false, "canceled": true}
	}
	return prepareLocalProject(paths[0])
}

// ConnectWorkspace configures optional local-file synchronization separately from account login.
func (FrontendBridge) ConnectWorkspace(rawURL, sshHost, sshUser, keyPath string) map[string]any {
	u := strings.TrimSpace(rawURL)
	if u == "" {
		return map[string]any{"ok": false, "error": "地址为空"}
	}
	if !strings.HasPrefix(u, "http") {
		u = "http://" + u
	}
	u = strings.TrimSuffix(u, "/")
	parsed, err := url.Parse(u)
	if err != nil || parsed.Hostname() == "" || parsed.User != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Path != "" || parsed.RawQuery != "" {
		return map[string]any{"ok": false, "error": "请输入有效的服务器地址和端口"}
	}
	serverConnectionMu.Lock()
	defer serverConnectionMu.Unlock()
	if apiConnection == nil || !apiConnection.authenticated {
		return map[string]any{"ok": false, "error": "请先登录账号，再配置本地文件同步"}
	}
	cfg := store.config()
	if cfg.WorkspaceServerURL != "" && strings.TrimRight(cfg.WorkspaceServerURL, "/") != u {
		return map[string]any{"ok": false, "error": "同步实例必须与当前账号所属服务一致"}
	}
	sshHost, sshUser, keyPath = strings.TrimSpace(sshHost), strings.TrimSpace(sshUser), strings.TrimSpace(keyPath)
	if sshHost == "" || strings.ContainsAny(sshHost, " \t\r\n/@") || !regexp.MustCompile(`^[a-zA-Z0-9_.-]+$`).MatchString(sshUser) {
		return map[string]any{"ok": false, "error": "请输入有效的 SSH 主机和用户名"}
	}
	if !filepath.IsAbs(keyPath) {
		return map[string]any{"ok": false, "error": "请选择 SSH 私钥文件"}
	}
	if info, err := os.Stat(keyPath); err != nil || info.IsDir() {
		return map[string]any{"ok": false, "error": "SSH 私钥文件不存在"}
	}
	next := cfg
	next.ServerURL = u
	if next.WorkspaceServerURL == "" {
		next.WorkspaceServerURL = u
	}
	next.SSHHost, next.SSHUser, next.KeyPath = sshHost, sshUser, keyPath
	if cfg.ServerURL != u || cfg.SSHHost != sshHost || cfg.SSHUser != sshUser || cfg.KeyPath != keyPath {
		next.SSHPort, next.WorkspaceRoot = 0, ""
		next.ControlHost = ""
		next.WorkspaceAccount, next.WorkspaceLoginURL = "", ""
		next.SSHKnownHostsPath, next.SSHHostKeyPinned = "", false
	}
	changingServer := serverIdentity(cfg) != serverIdentity(next) || cfg.KeyPath != keyPath
	if changingServer && piRuntimeActive() {
		return map[string]any{"ok": false, "error": "请先停止 Pi 和它运行的程序，再重新连接服务器"}
	}
	for _, m := range store.mappings() {
		if m.ServerID != serverIdentity(next) {
			return map[string]any{"ok": false, "error": "请先移除当前服务器的项目映射，再切换服务器；两端项目文件会保留"}
		}
	}
	// Reconnecting the same ready instance must not interrupt its running tasks.
	if !changingServer && tunnel.controlAlive() {
		ensureSyncMonitor()
		return map[string]any{"ok": true, "tunnel": true, "serverUrl": cfg.ServerURL}
	}
	if !changingServer {
		tunnel.mu.Lock()
		registrationCanRecover := tunnel.proc != nil && tunnel.bridgePort > 0 && !tunnel.stopped
		tunnel.mu.Unlock()
		if registrationCanRecover {
			if err := tunnel.PushToken(cfg.Token); err != nil {
				return map[string]any{"ok": false, "tunnel": false, "serverUrl": u, "error": err.Error()}
			}
			ensureSyncMonitor()
			connected := tunnel.connected()
			return map[string]any{"ok": connected, "tunnel": connected, "serverUrl": cfg.ServerURL}
		}
	}
	if err := store.updateConfig(next); err != nil {
		return map[string]any{"ok": false, "error": "连接配置保存失败"}
	}
	if changingServer {
		stopSyncMonitor(false)
	}
	ensureSyncMonitor()
	tunnel.stop()
	tunnel = newTunnel(next, store.keyPathOf(), func() {})
	if err := tunnel.start(); err != nil {
		return map[string]any{"ok": false, "tunnel": false, "serverUrl": u, "error": err.Error()}
	}
	connected := tunnel.connected()
	return map[string]any{"ok": connected, "tunnel": connected, "serverUrl": u}
}

// ConnectServer verifies the account service without SSH or a stored account token.
func (FrontendBridge) ConnectServer(rawURL string) map[string]any {
	u, err := normalizeServiceURL(rawURL)
	if err != nil {
		return map[string]any{"ok": false, "error": err.Error()}
	}
	serverConnectionMu.Lock()
	defer serverConnectionMu.Unlock()
	if apiConnection != nil && apiConnection.loginURL == u {
		return map[string]any{"ok": true, "serverUrl": u, "changed": false}
	}
	next, err := newServerConnection(u, u)
	if err != nil {
		return map[string]any{"ok": false, "error": err.Error()}
	}
	ctx, cancel := context.WithTimeout(next.ctx, 15*time.Second)
	defer cancel()
	request, _ := http.NewRequestWithContext(ctx, "GET", u+"/api/auth/status", nil)
	response, err := next.client.Do(request)
	if err != nil {
		next.cancel()
		return map[string]any{"ok": false, "error": "账号服务连接失败，请检查 HTTPS 地址、网络和客户端证书"}
	}
	response.Body.Close()
	if response.StatusCode != 200 {
		next.cancel()
		return map[string]any{"ok": false, "error": fmt.Sprintf("账号服务返回 HTTP %d", response.StatusCode)}
	}
	cfg := store.config()
	cfg.LoginURL, cfg.APIURL, cfg.WorkspaceServerURL = u, u, ""
	if err := store.updateConfig(cfg); err != nil {
		next.cancel()
		return map[string]any{"ok": false, "error": "账号服务配置保存失败"}
	}
	replaceServerConnection(next)
	if tunnel != nil {
		tunnel.stop()
	}
	stopSyncMonitor(false)
	return map[string]any{"ok": true, "serverUrl": u, "changed": true}
}

func (FrontendBridge) SelectWorkspaceKey() map[string]any {
	paths, err := mygo.Dialog.Open(mygo.OpenDialogOptions{Title: "选择你自己的 SSH 私钥"})
	if err != nil {
		return map[string]any{"ok": false, "error": err.Error()}
	}
	if len(paths) == 0 {
		return map[string]any{"ok": false, "canceled": true}
	}
	return map[string]any{"ok": true, "path": paths[0]}
}

// GetState 连接与映射状态（供设置页与状态栏）
// Revoke 撤销本地目录映射（设置页「移除」按钮）
func (FrontendBridge) Revoke(serverPath string) map[string]any {
	return revokeMapping(serverPath)
}

func (FrontendBridge) GetState() map[string]any {
	serverConnectionMu.RLock()
	defer serverConnectionMu.RUnlock()
	cfg := store.config()
	mappings := []*Mapping{}
	workspaceReady := workspaceMappingsActiveLocked()
	inactiveMappings := []*Mapping{}
	activeBindings := make(map[string]string)
	for _, mapping := range store.mappings() {
		if workspaceMappingActiveLocked(mapping) {
			mappings = append(mappings, mapping)
			activeBindings[mapping.ServerPath] = mapping.BindingEpoch
		} else {
			inactiveMappings = append(inactiveMappings, mapping)
		}
	}
	visiblePreviews := []Preview{}
	for _, preview := range previewList() {
		epoch, mapped := activeBindings[preview.ServerPath]
		if (mapped && epoch == preview.Epoch && !preview.Managed && preview.ServerID != "" && preview.ServerID == manualPreviewScopeLocked()) || (preview.Managed && preview.ServerID != "" && preview.ServerID == managedPreviewScopeLocked()) {
			visiblePreviews = append(visiblePreviews, preview)
		}
	}
	visibleOperations := map[string]SyncInfo{}
	for path, operation := range activeSyncOperations() {
		if activeBindings[path] == operation.BindingEpoch {
			visibleOperations[path] = operation
		}
	}
	states := make(map[string]SyncInfo)
	for _, m := range mappings {
		states[m.ServerPath] = observedProjectSync(m.ServerPath)
	}
	workspaceConnecting, workspaceError := false, ""
	if apiConnection != nil && apiConnection.workspaceSetup != nil {
		setup := apiConnection.workspaceSetup
		select {
		case <-setup.done:
			if setup.err != nil {
				workspaceError = setup.err.Error()
			}
		default:
			workspaceConnecting = true
		}
	}
	return map[string]any{
		"tunnel":                    workspaceReady && tunnel != nil && tunnel.connected() && (apiConnection == nil || !apiConnection.workspaceRecoveryOnly),
		"serverUrl":                 cfg.LoginURL,
		"workspaceServerUrl":        cfg.ServerURL,
		"accountWorkspaceServerUrl": cfg.WorkspaceServerURL,
		"sshHost":                   cfg.SSHHost,
		"sshUser":                   cfg.SSHUser,
		"keyPath":                   cfg.KeyPath,
		"workspaceConnecting":       workspaceConnecting,
		"workspaceError":            workspaceError,
		"mappings":                  mappings,
		"inactiveMappings":          inactiveMappings,
		"previews":                  visiblePreviews,
		"sync":                      states,
		"syncOperations":            visibleOperations,
		"executor": map[string]any{
			"backend": "vps",
		},
	}
}

// Preview discovery is remote IO, not a prerequisite for login, Pi or settings
// snapshots. The preview section refreshes it independently.
func (bridge FrontendBridge) RefreshPreviews() map[string]any {
	ctx, cancel := context.WithTimeout(context.Background(), 6*time.Second)
	defer cancel()
	err := recoverPreviewsContext(ctx)
	state := bridge.GetState()
	if err != nil {
		state["previewRecoveryError"] = err.Error()
	}
	return state
}

func (FrontendBridge) GetProjectSync(serverPath string) SyncInfo {
	serverConnectionMu.RLock()
	defer serverConnectionMu.RUnlock()
	// VPS-only projects do not depend on a local synchronization connection.
	mapping := store.findMappingByServer(serverPath)
	if mapping == nil {
		return observedProjectSync(serverPath)
	}
	if !workspaceMappingActiveLocked(mapping) {
		return SyncInfo{Status: "disconnected", Detail: "当前账号未连接本地文件同步", ServerPath: serverPath}
	}
	if apiConnection.workspaceRecoveryOnly {
		return SyncInfo{Status: "blocked", Detail: "工作区正在恢复交还，请先完成恢复再同步", ServerPath: serverPath, BindingEpoch: mapping.BindingEpoch}
	}
	ensureSyncMonitor()
	return observedProjectSync(serverPath)
}
