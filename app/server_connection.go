package main

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	_ "embed"
	"encoding/json"
	"fmt"
	"log"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"regexp"
	"strings"
	"sync"
	"time"
)

// Distribution configuration contains only a public service address and its public certificate.
//
//go:embed resources/service.json
var serviceConfiguration []byte

// Assigned by the loopback listener at startup so dev/reload instances coexist.
var apiProxyPort int

type serviceDefaults struct {
	LoginURL      string `json:"loginUrl"`
	CACertificate string `json:"caCertificate"`
}

type serverConnection struct {
	baseURL             string
	loginURL            string
	client              *http.Client
	ctx                 context.Context
	cancel              context.CancelFunc
	version             uint64
	authenticated       bool
	accountIdentity     string
	accessToken         string
	sessionHandle       string
	serverKey           string
	tokenRevision       uint64
	proxyCapability     string
	restorationToken    string
	revocationRetryOnce sync.Once
	// Set only from a verified login/profile response, never restored from Config.
	verifiedWorkspaceURL string
	// SSH has its own account-identity context so an identity refresh can revoke
	// queued SSH work without changing the existing cloud transport lifecycle.
	sshContext context.Context
	sshCancel  context.CancelFunc
}

var apiConnection *serverConnection
var apiConnectionVersion uint64

// Compatibility name for tests; never admitted by the v2 proxy.
var apiProxyKey = randHex(24)

func distributionService() serviceDefaults {
	var defaults serviceDefaults
	if err := json.Unmarshal(serviceConfiguration, &defaults); err != nil {
		panic("invalid public service configuration")
	}
	return defaults
}

func normalizeServiceURL(raw string) (string, error) {
	u, err := url.Parse(strings.TrimRight(strings.TrimSpace(raw), "/"))
	if err != nil || u.Hostname() == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return "", fmt.Errorf("请输入完整的 HTTPS 服务地址")
	}
	loopback := u.Hostname() == "localhost" || net.ParseIP(u.Hostname()).IsLoopback()
	if u.Scheme != "https" && !(u.Scheme == "http" && loopback) {
		return "", fmt.Errorf("账号服务必须使用 HTTPS；仅本机开发服务允许 HTTP")
	}
	if u.Path != "" && !regexp.MustCompile(`^/instances/[a-zA-Z0-9_-]+$`).MatchString(u.Path) {
		return "", fmt.Errorf("服务地址不能包含 API 路径")
	}
	return u.String(), nil
}

func newServerConnection(loginURL, baseURL string) (*serverConnection, error) {
	if baseURL == "" {
		baseURL = loginURL
	}
	if loginURL == "" {
		return nil, nil
	}
	var err error
	if loginURL, err = normalizeServiceURL(loginURL); err != nil {
		return nil, err
	}
	if baseURL, err = normalizeServiceURL(baseURL); err != nil {
		return nil, err
	}
	login, _ := url.Parse(loginURL)
	base, _ := url.Parse(baseURL)
	if login.Scheme != base.Scheme || login.Host != base.Host {
		return nil, fmt.Errorf("账号实例必须属于当前服务")
	}
	transport := http.DefaultTransport.(*http.Transport).Clone()
	// Retire idle sockets before the gateway's advertised five-second boundary.
	transport.IdleConnTimeout = 4 * time.Second
	// The deployed gateway intermittently stalls during H2 negotiation or on
	// shared H2 streams. Keep verified TLS and H1 keep-alive; independent H1
	// connections allow polls and task streams to progress without sharing that
	// failure. Select the protocol before sending, never replay an HTTP operation.
	transport.Protocols = new(http.Protocols)
	transport.Protocols.SetHTTP1(true)
	defaults := distributionService()
	if defaults.CACertificate != "" {
		roots, err := x509.SystemCertPool()
		if err != nil {
			roots = x509.NewCertPool()
		}
		if !roots.AppendCertsFromPEM([]byte(defaults.CACertificate)) {
			return nil, fmt.Errorf("服务证书配置无效")
		}
		transport.TLSClientConfig = &tls.Config{RootCAs: roots, MinVersion: tls.VersionTLS12}
	}
	ctx, cancel := context.WithCancel(context.Background())
	sshContext, sshCancel := context.WithCancel(ctx)
	apiConnectionVersion++
	version := apiConnectionVersion
	// Explicit diagnostic H2 clients retain PING/ACK liveness. This setting
	// does not enable H2 for product traffic and adds no request deadline.
	transport.HTTP2 = &http.HTTP2Config{
		SendPingTimeout: 15 * time.Second,
		PingTimeout:     15 * time.Second,
	}
	return &serverConnection{baseURL: baseURL, loginURL: loginURL, ctx: ctx, cancel: cancel, version: version, sshContext: sshContext, sshCancel: sshCancel,
		sessionHandle: randHex(24), serverKey: serverKey(loginURL, baseURL), tokenRevision: 1, proxyCapability: randHex(32),
		client: &http.Client{Transport: &serverTLSRecoveryTransport{transport: transport, account: ctx}, CheckRedirect: func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse }}}, nil
}

func replaceServerConnection(next *serverConnection) {
	previous := apiConnection
	// Account transitions revoke only this application's optional SSH forward.
	// The manager never waits for a child or takes the account lock here.
	if previous != next {
		stopDesktopSshTunnels(false)
	}
	apiConnection = next
	if previous != nil {
		previous.cancel()
		previous.client.CloseIdleConnections()
	}
	startAccountRevocationRetry(next, false)
}

func initializeServerConnection() error {
	cfg := store.config()
	if cfg.LoginURL == "" {
		cfg.LoginURL = distributionService().LoginURL
	}
	next, err := newServerConnection(cfg.LoginURL, cfg.APIURL)
	if err != nil {
		return err
	}
	if err = store.updateConfig(cfg); err != nil {
		if next != nil {
			next.cancel()
		}
		return err
	}
	if next != nil {
		// Unavailable or mismatched credentials leave initialization signed out.
		// A corrupt/inaccessible envelope also blocks future credential writes;
		// it must be repaired before a login can be committed durably.
		next.restorationToken, err = loadAccountCredential(next.serverKey)
		if err != nil {
			log.Printf("[account-session] saved credential unavailable; profile repair required before authentication can be saved")
			next.restorationToken = ""
		}
	}
	apiConnection = next
	startAccountRevocationRetry(next, true)
	return nil
}

type frontendProxyRequest struct {
	cancel context.CancelFunc
	done   chan struct{}
}

// Protected by frontendRequestsMu so a queued proxy handler cannot escape the
// same closed-window gate as FrontendBridge.ServerRequest reservations.
var frontendProxyRequests = map[*frontendProxyRequest]struct{}{}

func reserveFrontendProxy(parent context.Context) (context.Context, *frontendProxyRequest, bool) {
	frontendRequestsMu.Lock()
	defer frontendRequestsMu.Unlock()
	if frontendRequestsClosed {
		return nil, nil, false
	}
	ctx, cancel := context.WithCancel(parent)
	pending := &frontendProxyRequest{cancel: cancel, done: make(chan struct{})}
	frontendProxyRequests[pending] = struct{}{}
	return ctx, pending, true
}
func finishFrontendProxy(pending *frontendProxyRequest) {
	pending.cancel()
	frontendRequestsMu.Lock()
	defer frontendRequestsMu.Unlock()
	delete(frontendProxyRequests, pending)
	close(pending.done)
}
func cancelFrontendProxyRequests() {
	frontendRequestsMu.Lock()
	defer frontendRequestsMu.Unlock()
	for pending := range frontendProxyRequests {
		pending.cancel()
	}
}
func waitFrontendProxyRequests(ctx context.Context) error {
	frontendRequestsMu.Lock()
	pending := make([]*frontendProxyRequest, 0, len(frontendProxyRequests))
	for request := range frontendProxyRequests {
		pending = append(pending, request)
	}
	frontendRequestsMu.Unlock()
	for _, request := range pending {
		select {
		case <-request.done:
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	return nil
}

// Only the current service connection can proxy chat, shell and plugin upgrades.
func StartAPIProxy() error {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return err
	}
	apiProxyPort = listener.Addr().(*net.TCPAddr).Port
	log.Printf("[app-start] api_proxy_port=%d", apiProxyPort)
	handler := http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		// Resolve the capability and capture token under the admission lock.
		// No request can turn an old capability into a new global connection.
		serverConnectionMu.RLock()
		connection := apiConnection
		if serverConnectionSwitching {
			serverConnectionMu.RUnlock()
			http.Error(w, "SERVER_SWITCH_IN_PROGRESS", http.StatusConflict)
			return
		}
		if connection == nil || !connection.authenticated || connection.ctx.Err() != nil {
			serverConnectionMu.RUnlock()
			http.Error(w, "SESSION_NOT_AUTHENTICATED", http.StatusUnauthorized)
			return
		}
		prefix := "/channel/" + connection.proxyCapability
		if !strings.HasPrefix(request.URL.Path, prefix+"/") || request.URL.RawPath != "" {
			serverConnectionMu.RUnlock()
			http.NotFound(w, request)
			return
		}
		token, revision := connection.accessToken, connection.tokenRevision
		windowContext, pending, open := reserveFrontendProxy(request.Context())
		serverConnectionMu.RUnlock()
		if !open {
			http.Error(w, "桌面窗口已关闭", http.StatusServiceUnavailable)
			return
		}
		defer finishFrontendProxy(pending)
		path := strings.TrimPrefix(request.URL.Path, prefix)
		if strings.HasPrefix(path, "/api/auth/") || strings.Contains(path, "/../") || strings.Contains(path, "/./") || strings.Contains(path, "\\") {
			http.Error(w, "INVALID_REQUEST_PURPOSE", http.StatusForbidden)
			return
		}
		apiPath := strings.HasPrefix(path, "/api/")
		if !apiPath && path != "/ws" && path != "/shell" && path != "/desktop-notifications" && !strings.HasPrefix(path, "/plugin-ws/") {
			http.NotFound(w, request)
			return
		}
		if !apiPath && !strings.EqualFold(request.Header.Get("Upgrade"), "websocket") {
			http.NotFound(w, request)
			return
		}
		if retiredWorkspaceSyncPath(path) {
			jsonResp(w, http.StatusGone, map[string]any{"error": map[string]string{"code": cloudOnlyCode, "message": cloudOnlyMessage}})
			return
		}
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS")
		if request.Method == "OPTIONS" {
			w.WriteHeader(204)
			return
		}
		target, _ := url.Parse(connection.baseURL)
		proxy := httputil.NewSingleHostReverseProxy(target)
		proxy.Transport = connection.client.Transport
		proxy.FlushInterval = -1
		// This loopback boundary owns browser CORS. ReverseProxy adds upstream
		// headers, so remove upstream CORS values before they can be duplicated.
		credentialSaveFailed := false
		proxy.ModifyResponse = func(response *http.Response) error {
			response.Header.Del("Access-Control-Allow-Origin")
			response.Header.Del("Access-Control-Allow-Headers")
			response.Header.Del("Access-Control-Allow-Methods")
			serverConnectionMu.Lock()
			defer serverConnectionMu.Unlock()
			if apiConnection != connection || connection.ctx.Err() != nil || serverConnectionSwitching || windowContext.Err() != nil {
				return fmt.Errorf("stale proxy session")
			}
			err := recordNativeRefreshedToken(connection, response.Header, response.StatusCode, token, revision)
			// Renderer credentials can only be adopted from the native snapshot.
			response.Header.Del("X-Refreshed-Token")
			credentialSaveFailed = err != nil
			return err
		}
		proxy.ErrorHandler = func(w http.ResponseWriter, _ *http.Request, _ error) {
			if credentialSaveFailed {
				w.Header().Set("X-Chisa-Error", "SESSION_SAVE_FAILED")
				http.Error(w, "SESSION_SAVE_FAILED", http.StatusBadGateway)
				return
			}
			http.Error(w, "聊天服务连接失败", http.StatusBadGateway)
		}
		copy := request.Clone(windowContext)
		// Route HTTPS virtual hosts to the account service, not the local proxy host.
		copy.Host = target.Host
		copy.URL.Path = path
		copy.URL.RawPath = ""
		copy.Header.Del("Cookie")
		copy.Header.Del("Proxy-Authorization")
		copy.Header.Set("Authorization", "Bearer "+token)
		// Native WS authentication uses the captured bearer and service origin;
		// renderer-controlled origins and query credentials cannot cross here.
		if strings.EqualFold(copy.Header.Get("Upgrade"), "websocket") {
			copy.Header.Set("Origin", target.Scheme+"://"+target.Host)
		}
		query, queryErr := url.ParseQuery(copy.URL.RawQuery)
		if queryErr != nil {
			http.Error(w, "invalid query", http.StatusBadRequest)
			return
		}
		for key := range query {
			if credentialQueryKey(key) {
				query.Del(key)
			}
		}
		copy.URL.RawQuery = query.Encode()
		ctx, cancel := context.WithCancel(copy.Context())
		stop := context.AfterFunc(connection.ctx, cancel)
		defer stop()
		defer cancel()
		proxy.ServeHTTP(w, copy.WithContext(ctx))
	})
	server := &http.Server{Handler: handler, ReadHeaderTimeout: 10 * time.Second}
	go server.Serve(listener)
	return nil
}
