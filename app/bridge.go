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
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

// FrontendBridge exposes cloud account connections and restricted API forwarding
// to the app-owned page. Retired local capabilities return inert migration errors.
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
var frontendRequestsMu sync.Mutex
var frontendRequestsClosed bool

// Reserve before sending so cancellation also works before HTTP forwarding starts.
func (FrontendBridge) BeginServerRequest() string {
	serverConnectionMu.RLock()
	defer serverConnectionMu.RUnlock()
	frontendRequestsMu.Lock()
	defer frontendRequestsMu.Unlock()
	if frontendRequestsClosed {
		return ""
	}
	if apiConnection == nil {
		return ""
	}
	ctx, cancel := context.WithTimeout(apiConnection.ctx, serverRequestTimeout)
	id := randHex(16)
	bridgeRequests.Store(id, &bridgeRequest{ctx: ctx, cancel: cancel, connection: apiConnection})
	context.AfterFunc(ctx, func() { bridgeRequests.Delete(id) })
	return id
}

// The window owns frontend reservations independently of the account connection.
// Serialize closure with Begin so already-queued bridge calls cannot reserve a
// new request after the window has gone away.
func closeFrontendServerRequests() {
	frontendRequestsMu.Lock()
	defer frontendRequestsMu.Unlock()
	frontendRequestsClosed = true
	bridgeRequests.Range(func(_, pending any) bool {
		pending.(*bridgeRequest).cancel()
		return true
	})
}

func (FrontendBridge) CancelServerRequest(id string) {
	if pending, ok := bridgeRequests.Load(id); ok {
		pending.(*bridgeRequest).cancel()
	}
}

// Native transport failures keep the same HTTP-style contract as service errors.
// In particular, callers must not mistake a failed response for an empty result.
func bridgeErrorResponse(status int, code, message string) BridgeResponse {
	raw, _ := json.Marshal(map[string]any{"error": map[string]string{"code": code, "message": message}})
	return BridgeResponse{Status: status, Headers: map[string]string{"Content-Type": "application/json", "X-Chisa-Error": code}, BodyB64: base64.StdEncoding.EncodeToString(raw)}
}

func bridgeInterruptedResponse(ctx context.Context) BridgeResponse {
	if ctx.Err() == context.DeadlineExceeded {
		return bridgeErrorResponse(499, "REQUEST_TIMED_OUT", "请求已超时；请确认云端操作结果后再重试")
	}
	return bridgeErrorResponse(499, "REQUEST_INTERRUPTED", "请求已中断；请确认云端操作结果后再重试")
}

// ServerRequest forwards account APIs over the independently verified service connection.
// path 为相对路径（/api/...）；headers 由前端传入（含 Authorization）。
func (FrontendBridge) ServerRequest(id, method, path string, headers map[string]string, bodyB64 string) BridgeResponse {
	started := time.Now()
	resp := BridgeResponse{Status: 502, Headers: map[string]string{}, BodyB64: ""}
	pending, ok := bridgeRequests.Load(id)
	if !ok {
		return bridgeErrorResponse(499, "REQUEST_CANCELED", "请求已取消")
	}
	request := pending.(*bridgeRequest)
	defer request.cancel()
	defer bridgeRequests.Delete(id)
	if request.ctx.Err() != nil {
		return bridgeInterruptedResponse(request.ctx)
	}
	if !strings.HasPrefix(path, "/") {
		path = "/" + path
	}
	endpoint, err := url.Parse(path)
	if err != nil || endpoint.Host != "" || endpoint.Scheme != "" || !strings.HasPrefix(endpoint.Path, "/api/") {
		resp.Status = 400
		return resp
	}
	if retiredWorkspaceSyncPath(endpoint.Path) {
		return bridgeErrorResponse(http.StatusGone, cloudOnlyCode, cloudOnlyMessage)
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
	trace := newServerRequestTrace(started, request.connection.version, req.Method, endpoint.Path)
	req = req.WithContext(trace.context(req.Context()))
	slowLog := time.AfterFunc(15*time.Second, func() { trace.log("slow", nil, -1, -1) })
	defer slowLog.Stop()
	up, err := request.connection.client.Do(req)
	if err != nil {
		if request.ctx.Err() != nil {
			return bridgeInterruptedResponse(request.ctx)
		}
		trace.log("transport-failed", err, 0, -1)
		return bridgeErrorResponse(502, "UPSTREAM_CONNECTION_FAILED", "无法连接账号服务，请检查服务地址、网络和客户端证书")
	}
	defer up.Body.Close()
	trace.response(up)
	resp.Status = up.StatusCode
	for k := range up.Header {
		lk := strings.ToLower(k)
		if lk == "x-refreshed-token" || lk == "x-auth-error" || lk == "content-type" {
			resp.Headers[k] = up.Header.Get(k)
		}
	}
	raw, readErr := io.ReadAll(io.LimitReader(up.Body, 64*1024*1024+1))
	if request.ctx.Err() != nil {
		return bridgeInterruptedResponse(request.ctx)
	}
	if readErr != nil || len(raw) > 64*1024*1024 {
		if readErr != nil {
			trace.log("body-failed", readErr, len(raw), up.ContentLength)
			return bridgeErrorResponse(502, "UPSTREAM_RESPONSE_READ_FAILED", "账号服务响应中断，请先检查操作结果再重试")
		}
		trace.log("response-too-large", nil, len(raw), up.ContentLength)
		return bridgeErrorResponse(502, "UPSTREAM_RESPONSE_TOO_LARGE", "账号服务响应超过客户端接收上限")
	}
	trace.complete()
	responseConnection := request.connection
	if resp.Status == http.StatusOK && (endpoint.Path == "/api/auth/login" || endpoint.Path == "/api/auth/user") {
		serverConnectionMu.Lock()
		if apiConnection != request.connection {
			serverConnectionMu.Unlock()
			return bridgeErrorResponse(499, "CONNECTION_CHANGED", "账号连接已改变，请重新发起请求")
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
				if apiConnection.accountIdentity != accountIdentity {
					resetSshAccountIdentity(apiConnection)
				}
				apiConnection.authenticated = true
				apiConnection.accountIdentity = accountIdentity
				apiConnection.accessToken = strings.TrimPrefix(req.Header.Get("Authorization"), "Bearer ")
			}
			resp.Headers["X-Chisa-Connection-Version"] = strconv.FormatUint(apiConnection.version, 10)
			responseConnection = apiConnection
		}
		serverConnectionMu.Unlock()
	}
	serverConnectionMu.Lock()
	if apiConnection != responseConnection || responseConnection.ctx.Err() != nil {
		serverConnectionMu.Unlock()
		return bridgeErrorResponse(499, "CONNECTION_CHANGED", "账号连接已改变，请重新发起请求")
	}
	recordNativeRefreshedToken(responseConnection, up.Header, resp.Status)
	serverConnectionMu.Unlock()
	// A verified account/instance login is the only moment the desktop knows the
	// backend identity of the stored server paths, so legacy project entry
	// registration is attempted here, once per identity, off the request path.
	if resp.Status == http.StatusOK && (endpoint.Path == "/api/auth/login" || endpoint.Path == "/api/auth/user") {
		go registerLegacyProjects(responseConnection)
	}
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
	return bridgeErrorResponse(502, "LOGIN_CONNECTION_SAVE_FAILED", "登录成功，但无法保存对应服务连接；请重试")
}

// ConnectServer verifies the account service without SSH or a stored account token.
func (FrontendBridge) ConnectServer(rawURL string) map[string]any {
	u, err := normalizeServiceURL(rawURL)
	if err != nil {
		return map[string]any{"ok": false, "error": err.Error()}
	}
	serverConnectionMu.Lock()
	previous := apiConnection
	next, err := newServerConnection(u, u)
	serverConnectionMu.Unlock()
	if err != nil {
		return map[string]any{"ok": false, "error": err.Error()}
	}
	// Probe without holding the account lock so a slow server cannot freeze state reads.
	adopted := false
	defer func() {
		if !adopted {
			next.cancel()
			next.client.CloseIdleConnections()
		}
	}()
	ctx, cancel := context.WithTimeout(next.ctx, 15*time.Second)
	defer cancel()
	request, _ := http.NewRequestWithContext(ctx, "GET", u+"/api/auth/status", nil)
	response, err := next.client.Do(request)
	if err != nil {
		next.cancel()
		return map[string]any{"ok": false, "error": "账号服务连接失败，请检查 HTTPS 地址、网络和客户端证书"}
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return map[string]any{"ok": false, "error": fmt.Sprintf("账号服务返回 HTTP %d", response.StatusCode)}
	}
	// A generic website's HTTP 200 is not proof of a compatible account service.
	var status struct {
		IsAuthenticated *bool `json:"isAuthenticated"`
	}
	raw, err := io.ReadAll(io.LimitReader(response.Body, 64*1024+1))
	if err != nil || len(raw) > 64*1024 || json.Unmarshal(raw, &status) != nil || status.IsAuthenticated == nil {
		return map[string]any{"ok": false, "error": "服务器响应无效，请填写 ChisaCloudCode 账号服务地址"}
	}
	serverConnectionMu.Lock()
	defer serverConnectionMu.Unlock()
	if apiConnection != previous {
		return map[string]any{"ok": false, "error": "账号连接已改变，请重新连接服务器"}
	}
	if previous != nil && previous.loginURL == u {
		return map[string]any{"ok": true, "serverUrl": u, "changed": false}
	}
	cfg := store.config()
	cfg.LoginURL, cfg.APIURL, cfg.WorkspaceServerURL = u, u, ""
	if err := store.updateConfig(cfg); err != nil {
		next.cancel()
		return map[string]any{"ok": false, "error": "账号服务配置保存失败"}
	}
	replaceServerConnection(next)
	adopted = true
	return map[string]any{"ok": true, "serverUrl": u, "changed": true}
}

// GetState exposes cloud connection state. Old bindings remain inactive metadata.
func (FrontendBridge) GetState() map[string]any {
	serverConnectionMu.RLock()
	defer serverConnectionMu.RUnlock()
	cfg := store.config()
	return map[string]any{
		"mode": "cloud-only", "serverUrl": cfg.LoginURL,
		"localSyncEnabled": false, "localExecutionEnabled": false,
		"tunnel": false, "workspaceConnecting": false, "workspaceError": "",
		"mappings": []*Mapping{}, "inactiveMappings": store.mappings(),
		"sync": map[string]any{}, "syncOperations": map[string]any{}, "previews": []any{},
		"legacySyncRetirement": legacySyncRetirementSnapshot(),
		"executor":             map[string]any{"backend": "cloud"},
	}
}
