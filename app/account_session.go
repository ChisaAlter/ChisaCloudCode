package main

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"regexp"
	"strings"
)

// All fields and persistence below are guarded by serverConnectionMu. A handle
// identifies one login incarnation; token refresh never changes that identity.
type sessionTransition struct {
	PreviousSessionHandle string         `json:"previousSessionHandle"`
	PreviousTokenRevision uint64         `json:"previousTokenRevision"`
	Connection            map[string]any `json:"connection"`
}

var serverConnectionSwitching bool

func serverKey(loginURL, apiURL string) string {
	return fmt.Sprintf("%x", sha256.Sum256([]byte(loginURL+"\n"+apiURL)))
}

func connectionSnapshotLocked() map[string]any {
	result := map[string]any{
		"protocolVersion": 2, "configured": false, "sessionHandle": "", "sessionInstanceId": "",
		"generation": uint64(0), "version": uint64(0), "tokenRevision": uint64(0), "authenticated": false,
		"accessToken": "", "restorationToken": "", "serverKey": "", "loginUrl": "", "apiUrl": "",
		"httpProxyUrl": "", "webSocketUrl": "", "switching": serverConnectionSwitching,
	}
	if c := apiConnection; c != nil {
		result["configured"] = true
		result["sessionHandle"], result["sessionInstanceId"] = c.sessionHandle, c.sessionHandle
		result["generation"], result["version"], result["tokenRevision"] = c.version, c.version, c.tokenRevision
		result["authenticated"], result["serverKey"] = c.authenticated, c.serverKey
		result["loginUrl"], result["apiUrl"] = c.loginURL, c.baseURL
		if c.authenticated {
			result["accessToken"] = c.accessToken
			result["httpProxyUrl"] = fmt.Sprintf("http://127.0.0.1:%d/channel/%s", apiProxyPort, c.proxyCapability)
			result["webSocketUrl"] = fmt.Sprintf("ws://127.0.0.1:%d/channel/%s", apiProxyPort, c.proxyCapability)
		} else {
			result["restorationToken"] = c.restorationToken
		}
	}
	return result
}

func (FrontendBridge) GetApiConnection() map[string]any {
	serverConnectionMu.RLock()
	defer serverConnectionMu.RUnlock()
	return connectionSnapshotLocked()
}

// Legacy bridge admissions deliberately fail closed, including nonzero versions.
func (FrontendBridge) EndServerSession(uint64) {}

func (FrontendBridge) EndServerSessionV2(handle string, revision uint64) map[string]any {
	serverConnectionMu.Lock()
	c := apiConnection
	if serverConnectionSwitching {
		serverConnectionMu.Unlock()
		return map[string]any{"ok": false, "code": "SERVER_SWITCH_IN_PROGRESS"}
	}
	if c == nil || handle == "" || revision == 0 || c.sessionHandle != handle || c.tokenRevision != revision {
		serverConnectionMu.Unlock()
		return map[string]any{"ok": false, "code": "STALE_SERVER_SESSION"}
	}
	next, err := newServerConnection(c.loginURL, c.baseURL)
	if err != nil {
		serverConnectionMu.Unlock()
		return map[string]any{"ok": false, "code": "SESSION_SAVE_FAILED"}
	}
	// Durably clear + queue before revoking old capabilities. A write failure
	// preserves the exact predecessor so the renderer can safely retry logout.
	path, pending, err := queueAccountLogoutLocked(c)
	if err != nil {
		next.cancel()
		serverConnectionMu.Unlock()
		return map[string]any{"ok": false, "code": "SESSION_SAVE_FAILED"}
	}
	client := accountRevocationClient(c)
	replaceServerConnection(next)
	connection := connectionSnapshotLocked()
	serverConnectionMu.Unlock()

	status, queued := "not-required", false
	if client != nil {
		defer client.CloseIdleConnections()
	}
	if pending != nil {
		status, queued = performAccountRevocation(context.Background(), client, path, *pending)
	}
	return map[string]any{"ok": true, "connection": connection, "receipt": map[string]any{
		"localCleared": true, "remoteRevoked": status == "revoked", "pendingRevocation": queued, "remoteStatus": status,
	}}
}

func reservationErrorLocked(c *serverConnection, handle, token string, revision uint64, purpose, key string) string {
	if serverConnectionSwitching {
		return "SERVER_SWITCH_IN_PROGRESS"
	}
	if c == nil || c != apiConnection || c.ctx.Err() != nil || handle == "" || revision == 0 || key == "" ||
		c.sessionHandle != handle || c.tokenRevision != revision || c.serverKey != key {
		return "STALE_SERVER_SESSION"
	}
	switch purpose {
	case "api":
		if !c.authenticated {
			return "SESSION_NOT_AUTHENTICATED"
		}
		if token == "" || token != c.accessToken {
			return "STALE_SERVER_SESSION"
		}
	case "login":
		if c.authenticated || token != "" {
			return "INVALID_REQUEST_PURPOSE"
		}
	case "restore":
		if c.authenticated || token == "" || token != c.restorationToken {
			return "SESSION_NOT_AUTHENTICATED"
		}
	case "public-status":
		if token != "" {
			return "INVALID_REQUEST_PURPOSE"
		}
	default:
		return "INVALID_REQUEST_PURPOSE"
	}
	return ""
}

func purposeAllows(purpose, method, path string) bool {
	switch purpose {
	case "login":
		return method == "POST" && path == "/api/auth/login"
	case "restore":
		return method == "GET" && path == "/api/auth/user"
	case "public-status":
		return method == "GET" && path == "/api/auth/status"
	case "api":
		return path != "/api/auth/login" && path != "/api/auth/register"
	}
	return false
}

func credentialQueryKey(key string) bool {
	switch strings.ToLower(key) {
	case "token", "access_token", "accesstoken", "authorization", "auth", "jwt", "api_key", "apikey":
		return true
	}
	return false
}

func validateBridgeCredentials(headers map[string]string, endpoint *url.URL, token string) bool {
	for key, value := range headers {
		switch strings.ToLower(key) {
		case "authorization":
			if token == "" || value != "Bearer "+token {
				return false
			}
		case "cookie", "proxy-authorization":
			return false
		}
	}
	values, err := url.ParseQuery(endpoint.RawQuery)
	if err != nil {
		return false
	}
	for key := range values {
		if credentialQueryKey(key) {
			return false
		}
	}
	return true
}

func accountIdentity(raw json.RawMessage) string {
	var user struct {
		ID       any    `json:"id"`
		Username string `json:"username"`
	}
	if json.Unmarshal(raw, &user) != nil || user.ID == nil || strings.TrimSpace(user.Username) == "" {
		return ""
	}
	identity, _ := json.Marshal(user)
	return string(identity)
}

// JWT claims here provide an additional identity consistency check, not local
// signature verification: only this session's verified upstream can issue them.
func tokenAccountIdentity(token string) string {
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return ""
	}
	raw, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return ""
	}
	var claims struct {
		UserID   any    `json:"userId"`
		Username string `json:"username"`
	}
	if json.Unmarshal(raw, &claims) != nil || claims.UserID == nil || claims.Username == "" {
		return ""
	}
	user, _ := json.Marshal(map[string]any{"id": claims.UserID, "username": claims.Username})
	return accountIdentity(user)
}

func validSessionToken(token string) bool {
	return token != "" && len(token) <= 64*1024 && !strings.ContainsAny(token, " \t\r\n")
}

// Called with the account lock held. Return false on a late response, without
// ever touching the replacement credential or its durable tombstone.
func commitRefreshedTokenLocked(c *serverConnection, expectedToken string, revision uint64, token string) (bool, error) {
	if c == nil || apiConnection != c || !c.authenticated || c.ctx.Err() != nil || serverConnectionSwitching ||
		c.tokenRevision != revision || c.accessToken != expectedToken || token == c.accessToken {
		return false, nil
	}
	if !validSessionToken(token) || tokenAccountIdentity(token) == "" || tokenAccountIdentity(token) != c.accountIdentity {
		return false, fmt.Errorf("invalid refreshed account identity")
	}
	if err := saveAccountCredential(&persistedAccountCredential{ServerKey: c.serverKey, Token: token}); err != nil {
		return false, err
	}
	c.accessToken = token
	c.tokenRevision++
	return true, nil
}

// Native consumers and the proxy resynchronize through GetApiConnection. Call
// with serverConnectionMu held and propagate persistence errors to the caller.
func recordNativeRefreshedToken(c *serverConnection, headers http.Header, status int, expectedToken string, revision uint64) error {
	if status == http.StatusUnauthorized && (headers.Get("X-Auth-Error") == "invalid-token" || headers.Get("X-Auth-Error") == "session-expired") {
		_, err := revokeNativeSessionLocked(c, expectedToken, revision)
		return err
	}
	if status >= 200 && status < 300 && headers.Get("X-Auth-Error") == "" && headers.Get("X-Refreshed-Token") != "" {
		_, err := commitRefreshedTokenLocked(c, expectedToken, revision, strings.TrimSpace(headers.Get("X-Refreshed-Token")))
		return err
	}
	return nil
}

func revokeNativeSessionLocked(c *serverConnection, expectedToken string, revision uint64) (bool, error) {
	if c == nil || apiConnection != c || c.ctx.Err() != nil || serverConnectionSwitching || c.tokenRevision != revision || expectedToken == "" {
		return false, nil
	}
	if (c.authenticated && c.accessToken != expectedToken) || (!c.authenticated && c.restorationToken != expectedToken) {
		return false, nil
	}
	next, err := newServerConnection(c.loginURL, c.baseURL)
	if err != nil {
		return false, err
	}
	if err = saveAccountCredential(nil); err != nil {
		next.cancel()
		return false, err
	}
	replaceServerConnection(next)
	return true, nil
}

func transitionFor(request *bridgeRequest) *sessionTransition {
	return &sessionTransition{PreviousSessionHandle: request.sessionHandle, PreviousTokenRevision: request.tokenRevision, Connection: connectionSnapshotLocked()}
}

// A successful login/restore or changed verified account creates a new immutable
// incarnation. Same-account profile reads keep concurrent requests and sockets.
func commitBridgeAuthenticationLocked(request *bridgeRequest, endpoint string, headers http.Header, raw []byte) (*serverConnection, bool, error) {
	c := request.connection
	var payload struct {
		Token              string          `json:"token"`
		User               json.RawMessage `json:"user"`
		InstancePath       string          `json:"instancePath"`
		WorkspaceServerURL string          `json:"workspaceServerUrl"`
	}
	if json.Unmarshal(raw, &payload) != nil {
		return nil, false, fmt.Errorf("invalid authentication response")
	}
	identity := accountIdentity(payload.User)
	if identity == "" {
		return nil, false, fmt.Errorf("missing verified account identity")
	}
	if endpoint == "/api/auth/user" {
		payload.InstancePath = headers.Get("X-Chisa-Instance-Path")
		payload.WorkspaceServerURL = headers.Get("X-Chisa-Workspace-Server-Url")
	}
	token := request.accessToken
	if request.purpose == "login" {
		token = payload.Token
	}
	if !validSessionToken(token) {
		return nil, false, fmt.Errorf("invalid account credential")
	}
	// Opaque service tokens remain valid; JWT-shaped tokens must agree with the
	// service's verified user whenever they expose the standard identity claims.
	if claimed := tokenAccountIdentity(token); claimed != "" && claimed != identity {
		return nil, false, fmt.Errorf("account credential identity mismatch")
	}
	if refreshed := strings.TrimSpace(headers.Get("X-Refreshed-Token")); refreshed != "" {
		if !validSessionToken(refreshed) || tokenAccountIdentity(refreshed) != identity {
			return nil, false, fmt.Errorf("refreshed account identity mismatch")
		}
		token = refreshed
	}
	cfg := store.config()
	apiURL := c.baseURL
	workspaceURL := strings.TrimRight(strings.TrimSpace(payload.WorkspaceServerURL), "/")
	if workspaceURL != "" {
		u, parseErr := url.Parse(workspaceURL)
		if parseErr != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Hostname() == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
			return nil, false, fmt.Errorf("invalid verified workspace URL")
		}
	}
	if request.purpose == "login" {
		apiURL = c.loginURL
	}
	if payload.InstancePath != "" {
		if !regexp.MustCompile(`^/instances/[a-zA-Z0-9_-]+$`).MatchString(payload.InstancePath) {
			return nil, false, fmt.Errorf("invalid account instance")
		}
		u, _ := url.Parse(c.loginURL)
		u.Path, u.RawPath = payload.InstancePath, ""
		apiURL = u.String()
	}
	preserve := request.purpose == "api" && c.authenticated && identity == c.accountIdentity && apiURL == c.baseURL && workspaceURL == c.verifiedWorkspaceURL
	if preserve {
		changed, err := commitRefreshedTokenLocked(c, request.accessToken, request.tokenRevision, token)
		return c, changed, err
	}
	next, err := newServerConnection(c.loginURL, apiURL)
	if err != nil {
		return nil, false, err
	}
	previousConfig := cfg
	cfg.LoginURL, cfg.APIURL, cfg.WorkspaceServerURL = c.loginURL, apiURL, workspaceURL
	if err = store.updateConfig(cfg); err != nil {
		next.cancel()
		return nil, false, err
	}
	if err = saveAccountCredential(&persistedAccountCredential{ServerKey: next.serverKey, Token: token}); err != nil {
		next.cancel()
		if rollbackErr := store.updateConfig(previousConfig); rollbackErr != nil {
			return nil, false, fmt.Errorf("credential save and connection rollback failed: %w", rollbackErr)
		}
		return nil, false, err
	}
	next.authenticated, next.accountIdentity, next.accessToken = true, identity, token
	next.verifiedWorkspaceURL = workspaceURL
	replaceServerConnection(next)
	return next, true, nil
}

func cancelFrontendRequestsForSwitch() {
	frontendRequestsMu.Lock()
	defer frontendRequestsMu.Unlock()
	bridgeRequests.Range(func(_, value any) bool { value.(*bridgeRequest).cancel(); return true })
	for pending := range frontendProxyRequests {
		pending.cancel()
	}
}
