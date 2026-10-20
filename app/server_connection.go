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
	baseURL               string
	loginURL              string
	client                *http.Client
	ctx                   context.Context
	cancel                context.CancelFunc
	version               uint64
	authenticated         bool
	accountIdentity       string
	accessToken           string
	workspaceSetup        *accountWorkspaceSetup
	workspaceRecoveryOnly bool
}

var apiConnection *serverConnection
var apiConnectionVersion uint64
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
	// Clone initializes DefaultTransport's HTTP/2 support and copies its ALPN
	// list. Start with a fresh verified TLS config even without a custom CA,
	// otherwise H2 can still be negotiated by an HTTP/1-only transport.
	transport.TLSClientConfig = &tls.Config{MinVersion: tls.VersionTLS12}
	defaults := distributionService()
	if defaults.CACertificate != "" {
		roots, err := x509.SystemCertPool()
		if err != nil {
			roots = x509.NewCertPool()
		}
		if !roots.AppendCertsFromPEM([]byte(defaults.CACertificate)) {
			return nil, fmt.Errorf("服务证书配置无效")
		}
		transport.TLSClientConfig.RootCAs = roots
	}
	ctx, cancel := context.WithCancel(context.Background())
	apiConnectionVersion++
	version := apiConnectionVersion
	// Explicit diagnostic H2 clients retain PING/ACK liveness. This setting
	// does not enable H2 for product traffic and adds no request deadline.
	transport.HTTP2 = &http.HTTP2Config{
		SendPingTimeout: 15 * time.Second,
		PingTimeout:     15 * time.Second,
	}
	return &serverConnection{baseURL: baseURL, loginURL: loginURL, ctx: ctx, cancel: cancel, version: version,
		client: &http.Client{Transport: &serverTLSRecoveryTransport{transport: transport, account: ctx}, CheckRedirect: func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse }}}, nil
}

func replaceServerConnection(next *serverConnection) {
	previous := apiConnection
	apiConnection = next
	if previous != nil {
		previous.cancel()
		previous.client.CloseIdleConnections()
	}
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
	apiConnection = next
	return nil
}

func (FrontendBridge) GetApiConnection() map[string]any {
	serverConnectionMu.RLock()
	defer serverConnectionMu.RUnlock()
	result := map[string]any{"configured": apiConnection != nil, "webSocketUrl": fmt.Sprintf("ws://127.0.0.1:%d/channel/%s", apiProxyPort, apiProxyKey)}
	if apiConnection != nil {
		result["loginUrl"], result["apiUrl"], result["version"] = apiConnection.loginURL, apiConnection.baseURL, apiConnection.version
	}
	return result
}

func (FrontendBridge) EndServerSession(version uint64) {
	serverConnectionMu.Lock()
	defer serverConnectionMu.Unlock()
	if apiConnection == nil || apiConnection.version != version {
		return
	}
	next, err := newServerConnection(apiConnection.loginURL, apiConnection.baseURL)
	if err != nil {
		return
	}
	replaceServerConnection(next)
	if tunnel != nil {
		tunnel.stop()
	}
	stopSyncMonitor(false)
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
		prefix := "/channel/" + apiProxyKey
		if !strings.HasPrefix(request.URL.Path, prefix+"/") {
			http.NotFound(w, request)
			return
		}
		path := strings.TrimPrefix(request.URL.Path, prefix)
		apiPath := strings.HasPrefix(path, "/api/")
		if !apiPath && path != "/ws" && path != "/shell" && path != "/desktop-notifications" && !strings.HasPrefix(path, "/plugin-ws/") {
			http.NotFound(w, request)
			return
		}
		if !apiPath && !strings.EqualFold(request.Header.Get("Upgrade"), "websocket") {
			http.NotFound(w, request)
			return
		}
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS")
		if request.Method == "OPTIONS" {
			w.WriteHeader(204)
			return
		}
		serverConnectionMu.RLock()
		connection := apiConnection
		ready := connection != nil && connection.authenticated
		serverConnectionMu.RUnlock()
		if !ready {
			http.Error(w, "请先登录账号服务", http.StatusUnauthorized)
			return
		}
		target, _ := url.Parse(connection.baseURL)
		proxy := httputil.NewSingleHostReverseProxy(target)
		proxy.Transport = connection.client.Transport
		proxy.FlushInterval = -1
		proxy.ErrorHandler = func(w http.ResponseWriter, _ *http.Request, _ error) {
			http.Error(w, "聊天服务连接失败", http.StatusBadGateway)
		}
		copy := request.Clone(request.Context())
		// Route HTTPS virtual hosts to the account service, not the local proxy host.
		copy.Host = target.Host
		copy.URL.Path = path
		copy.URL.RawPath = ""
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

func workspaceConnectionMatchesSession() bool {
	if apiConnection == nil || !apiConnection.authenticated {
		return false
	}
	cfg := store.config()
	if cfg.WorkspaceAccount != "" && (cfg.WorkspaceAccount != apiConnection.accountIdentity || cfg.WorkspaceLoginURL != apiConnection.loginURL) {
		return false
	}
	return cfg.WorkspaceServerURL != "" && strings.TrimRight(cfg.WorkspaceServerURL, "/") == strings.TrimRight(cfg.ServerURL, "/")
}

func resumeAuthorizedWorkspace(version uint64) {
	serverConnectionMu.RLock()
	if apiConnection == nil || apiConnection.version != version {
		serverConnectionMu.RUnlock()
		return
	}
	connection := apiConnection
	serverConnectionMu.RUnlock()
	if err := waitAccountWorkspace(connection, false); err != nil && connection.ctx.Err() == nil {
		log.Println("[workspace-connection]", err)
	}
}
