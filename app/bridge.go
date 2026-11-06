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
	"strconv"
	"strings"
	"sync"
	"time"
)

// FrontendBridge exposes cloud account connections and restricted API forwarding
// to the app-owned page. Retired local capabilities return inert migration errors.
type FrontendBridge struct{}

type BridgeResponse struct {
	Status            int                `json:"status"`
	Headers           map[string]string  `json:"headers"`
	BodyB64           string             `json:"bodyB64"`
	SessionTransition *sessionTransition `json:"sessionTransition,omitempty"`
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
	ctx           context.Context
	cancel        context.CancelFunc
	connection    *serverConnection
	sessionHandle string
	serverKey     string
	tokenRevision uint64
	accessToken   string
	purpose       string
	consumed      bool // protected by frontendRequestsMu
}

var bridgeRequests sync.Map
var frontendRequestsMu sync.Mutex
var frontendRequestsClosed bool

// Old callers cannot bind a renderer identity and deliberately fail closed.
func (FrontendBridge) BeginServerRequest() string { return "" }

// Reserve before sending so cancellation also works before HTTP forwarding.
// Identity and credential expectations are captured atomically, never inferred
// later from whichever connection happens to be globally current.
func (FrontendBridge) BeginServerRequestV2(handle, token string, revision uint64, purpose, key string) map[string]any {
	serverConnectionMu.RLock()
	defer serverConnectionMu.RUnlock()
	frontendRequestsMu.Lock()
	defer frontendRequestsMu.Unlock()
	if frontendRequestsClosed {
		return map[string]any{"ok": false, "code": "FRONTEND_CLOSED"}
	}
	if code := reservationErrorLocked(apiConnection, handle, token, revision, purpose, key); code != "" {
		return map[string]any{"ok": false, "code": code}
	}
	ctx, cancel := context.WithTimeout(apiConnection.ctx, serverRequestTimeout)
	id := randHex(24)
	bridgeRequests.Store(id, &bridgeRequest{ctx: ctx, cancel: cancel, connection: apiConnection,
		sessionHandle: handle, serverKey: key, tokenRevision: revision, accessToken: token, purpose: purpose})
	context.AfterFunc(ctx, func() { bridgeRequests.Delete(id) })
	return map[string]any{"ok": true, "requestId": id}
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
// path is an API-relative URL. Native owns the captured bearer credential.
func (FrontendBridge) ServerRequest(id, method, path string, headers map[string]string, bodyB64 string) BridgeResponse {
	started := time.Now()
	resp := BridgeResponse{Status: 502, Headers: map[string]string{}, BodyB64: ""}
	pending, ok := bridgeRequests.Load(id)
	if !ok {
		return bridgeErrorResponse(499, "REQUEST_CANCELED", "请求已取消")
	}
	request := pending.(*bridgeRequest)
	frontendRequestsMu.Lock()
	if request.consumed || frontendRequestsClosed {
		frontendRequestsMu.Unlock()
		return bridgeErrorResponse(499, "REQUEST_CANCELED", "请求已使用或窗口已关闭")
	}
	request.consumed = true
	frontendRequestsMu.Unlock()
	defer request.cancel()
	defer bridgeRequests.Delete(id)
	if request.ctx.Err() != nil {
		return bridgeInterruptedResponse(request.ctx)
	}
	if !strings.HasPrefix(path, "/") {
		path = "/" + path
	}
	endpoint, err := url.Parse(path)
	if err != nil || endpoint.Host != "" || endpoint.Scheme != "" || endpoint.Fragment != "" || endpoint.RawPath != "" || !strings.HasPrefix(endpoint.Path, "/api/") || strings.Contains(endpoint.Path, "\\") || strings.Contains(endpoint.Path, "/../") || strings.Contains(endpoint.Path, "/./") {
		resp.Status = 400
		return resp
	}
	method = strings.ToUpper(method)
	if !purposeAllows(request.purpose, method, endpoint.Path) {
		return bridgeErrorResponse(403, "INVALID_REQUEST_PURPOSE", "请求用途不匹配")
	}
	if !validateBridgeCredentials(headers, endpoint, request.accessToken) {
		return bridgeErrorResponse(403, "STALE_SERVER_SESSION", "请求凭据不匹配")
	}
	serverConnectionMu.RLock()
	code := reservationErrorLocked(request.connection, request.sessionHandle, request.accessToken, request.tokenRevision, request.purpose, request.serverKey)
	serverConnectionMu.RUnlock()
	if code != "" {
		return bridgeErrorResponse(409, code, "账号会话已改变")
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
		if strings.EqualFold(k, "Host") || strings.EqualFold(k, "Authorization") || strings.EqualFold(k, "Cookie") || strings.EqualFold(k, "Proxy-Authorization") {
			continue
		}
		req.Header.Set(k, v)
	}
	if request.accessToken != "" {
		req.Header.Set("Authorization", "Bearer "+request.accessToken)
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
	serverConnectionMu.Lock()
	if apiConnection != responseConnection || responseConnection.ctx.Err() != nil || serverConnectionSwitching || request.ctx.Err() != nil {
		serverConnectionMu.Unlock()
		return bridgeErrorResponse(499, "STALE_SERVER_SESSION", "账号连接已改变，请重新发起请求")
	}
	// A late response may finish its read, but cannot establish identity or
	// replace credentials after another response has advanced the revision.
	currentRevision := responseConnection.tokenRevision == request.tokenRevision
	if resp.Status == http.StatusUnauthorized && (up.Header.Get("X-Auth-Error") == "invalid-token" || up.Header.Get("X-Auth-Error") == "session-expired") {
		changed, revokeErr := revokeNativeSessionLocked(responseConnection, request.accessToken, request.tokenRevision)
		if revokeErr != nil {
			serverConnectionMu.Unlock()
			return bridgeErrorResponse(502, "SESSION_SAVE_FAILED", "账号失效凭据未清除，请重试")
		}
		if changed {
			resp.SessionTransition = transitionFor(request)
		}
	}
	if resp.Status == http.StatusOK && (endpoint.Path == "/api/auth/login" || endpoint.Path == "/api/auth/user") {
		if !currentRevision {
			serverConnectionMu.Unlock()
			return bridgeErrorResponse(409, "STALE_SERVER_SESSION", "账号凭据已刷新，请重新验证")
		}
		var changed bool
		responseConnection, changed, err = commitBridgeAuthenticationLocked(request, endpoint.Path, up.Header, raw)
		if err != nil {
			serverConnectionMu.Unlock()
			return loginConnectionError()
		}
		if changed {
			resp.SessionTransition = transitionFor(request)
		}
		resp.Headers["X-Chisa-Connection-Version"] = strconv.FormatUint(responseConnection.version, 10)
	} else if resp.Status >= 200 && resp.Status < 300 && up.Header.Get("X-Auth-Error") == "" {
		token := strings.TrimSpace(up.Header.Get("X-Refreshed-Token"))
		if endpoint.Path == "/api/auth/refresh" {
			var payload struct {
				Token string `json:"token"`
			}
			if json.Unmarshal(raw, &payload) != nil || !validSessionToken(payload.Token) {
				serverConnectionMu.Unlock()
				return bridgeErrorResponse(502, "INVALID_REFRESH_RESPONSE", "账号刷新响应无效")
			}
			token = payload.Token
		}
		if token != "" {
			changed, refreshErr := commitRefreshedTokenLocked(responseConnection, request.accessToken, request.tokenRevision, token)
			if refreshErr != nil {
				serverConnectionMu.Unlock()
				return bridgeErrorResponse(502, "SESSION_SAVE_FAILED", "账号凭据刷新未保存，请重试")
			}
			if changed {
				resp.SessionTransition = transitionFor(request)
			}
		}
	}
	// Renderer must adopt only a native transition; a bare response header or
	// explicit refresh payload cannot become a late credential writeback.
	if resp.SessionTransition == nil {
		delete(resp.Headers, "X-Refreshed-Token")
	}
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

func loginConnectionError() BridgeResponse {
	return bridgeErrorResponse(502, "LOGIN_CONNECTION_SAVE_FAILED", "登录成功，但无法保存对应服务连接；请重试")
}

// ConnectServer verifies the account service without SSH or a stored account token.
func (FrontendBridge) ConnectServer(rawURL string) (result map[string]any) {
	u, err := normalizeServiceURL(rawURL)
	if err != nil {
		return map[string]any{"ok": false, "error": err.Error()}
	}
	serverConnectionMu.Lock()
	if serverConnectionSwitching {
		serverConnectionMu.Unlock()
		return map[string]any{"ok": false, "code": "SERVER_SWITCH_IN_PROGRESS", "error": "服务切换正在进行"}
	}
	previous := apiConnection
	next, err := newServerConnection(u, u)
	if err == nil {
		serverConnectionSwitching = true
		cancelFrontendRequestsForSwitch()
	}
	serverConnectionMu.Unlock()
	if err != nil {
		return map[string]any{"ok": false, "error": err.Error()}
	}
	defer func() {
		serverConnectionMu.Lock()
		serverConnectionSwitching = false
		if result != nil {
			result["connection"] = connectionSnapshotLocked()
		}
		serverConnectionMu.Unlock()
	}()
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
	// Save metadata first: if its replacement fails, the predecessor's durable
	// credential must remain intact. A crash before the credential tombstone is
	// safe because the old credential cannot restore under the new server key.
	previousConfig := store.config()
	cfg := previousConfig
	cfg.LoginURL, cfg.APIURL, cfg.WorkspaceServerURL = u, u, ""
	if err := store.updateConfig(cfg); err != nil {
		return map[string]any{"ok": false, "code": "SESSION_SAVE_FAILED", "error": "账号服务配置保存失败，请重试"}
	}
	if err := saveAccountCredential(nil); err != nil {
		if rollbackErr := store.updateConfig(previousConfig); rollbackErr != nil {
			return map[string]any{"ok": false, "code": "SESSION_SAVE_FAILED", "error": "账号凭据清除及配置回滚失败，请重试"}
		}
		return map[string]any{"ok": false, "code": "SESSION_SAVE_FAILED", "error": "账号凭据清除失败，请重试"}
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
