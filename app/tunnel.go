package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	apiLocalPort = 18791
	controlPort  = 18082
)

type Tunnel struct {
	mu                sync.Mutex
	proc              *exec.Cmd
	Cfg               Config
	keyPath           string
	stopped           bool
	bridgePort        int
	bridgeReady       bool
	onChange          func()
	registrationMu    sync.Mutex
	connectionContext context.Context
	connectionCancel  context.CancelFunc
}

func newTunnel(cfg Config, keyPath string, onChange func()) *Tunnel {
	return &Tunnel{Cfg: cfg, keyPath: keyPath, onChange: onChange}
}
func shellQuote(s string) string { return "'" + strings.ReplaceAll(s, "'", "'\"'\"'") + "'" }
func sshExe() string {
	p := `C:\Windows\System32\OpenSSH\ssh.exe`
	if _, err := os.Stat(p); err == nil {
		return p
	}
	return "ssh"
}
func (t *Tunnel) baseArgs() []string {
	return append(sshConnectionArgs(t.Cfg, t.keyPath), fmt.Sprintf("%s@%s", t.Cfg.SSHUser, t.Cfg.SSHHost))
}

func sshConnectionArgs(cfg Config, keyPath string) []string {
	strict := "accept-new"
	if cfg.SSHHostKeyPinned {
		strict = "yes"
	}
	args := []string{"-i", keyPath, "-o", "IdentitiesOnly=yes", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=" + strict, "-o", "ConnectTimeout=15", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=3", "-o", "ExitOnForwardFailure=yes"}
	if cfg.SSHPort > 0 {
		args = append(args, "-p", fmt.Sprint(cfg.SSHPort))
	}
	if cfg.SSHKnownHostsPath != "" {
		args = append(args, "-F", filepath.Join(filepath.Dir(cfg.SSHKnownHostsPath), "ssh_config"), "-o", "UserKnownHostsFile="+strconv.Quote(filepath.ToSlash(cfg.SSHKnownHostsPath)), "-o", "GlobalKnownHostsFile=none")
	}
	return args
}
func (t *Tunnel) start() error {
	t.mu.Lock()
	if t.stopped || t.Cfg.SSHHost == "" {
		t.mu.Unlock()
		return nil
	}
	if t.proc != nil {
		t.mu.Unlock()
		return t.PushToken(t.Cfg.Token)
	}
	port := "8791"
	if u, err := url.Parse(t.Cfg.ServerURL); err == nil && u.Port() != "" {
		port = u.Port()
	}
	apiHost, controlBind := "127.0.0.1", "127.0.0.1"
	if t.Cfg.WorkspaceAccount != "" {
		apiHost, controlBind = "host.docker.internal", "0.0.0.0"
	}
	args := append([]string{"-N", "-L", fmt.Sprintf("127.0.0.1:%d:%s:%s", apiLocalPort, apiHost, port), "-R", fmt.Sprintf("%s:0:127.0.0.1:%d", controlBind, controlPort)}, t.baseArgs()...)
	cmd := hideCommandWindow(exec.Command(sshExe(), args...))
	pipe, err := cmd.StderrPipe()
	if err != nil {
		t.mu.Unlock()
		return err
	}
	if err = cmd.Start(); err != nil {
		t.mu.Unlock()
		return err
	}
	t.proc = cmd
	t.bridgeReady = false
	t.connectionContext, t.connectionCancel = context.WithCancel(context.Background())
	t.mu.Unlock()
	registration := make(chan error, 1)
	go func() {
		allocated := false
		scanner := bufio.NewScanner(pipe)
		for scanner.Scan() {
			var assigned int
			if _, err := fmt.Sscanf(scanner.Text(), "Allocated port %d for remote forward", &assigned); err == nil && assigned > 0 {
				allocated = true
				t.mu.Lock()
				current := t.proc == cmd && !t.stopped
				if current {
					t.bridgePort = assigned
				}
				t.mu.Unlock()
				if !current {
					continue
				}
				err := t.PushToken(t.Cfg.Token)
				t.mu.Lock()
				if t.proc == cmd && !t.stopped {
					t.bridgeReady = err == nil
				}
				t.mu.Unlock()
				registration <- err
				t.onChange()
			}
		}
		if !allocated {
			registration <- fmt.Errorf("工作区通道未分配远程端口")
		}
		_ = cmd.Wait()
		t.mu.Lock()
		if t.proc == cmd {
			if t.connectionCancel != nil {
				t.connectionCancel()
			}
			t.proc = nil
			t.bridgePort = 0
			t.bridgeReady = false
		}
		stopped := t.stopped
		t.mu.Unlock()
		if !stopped {
			time.Sleep(5 * time.Second)
			_ = t.start()
		}
	}()
	// Existing workspace markers must use this connection's allocated port
	// before the startup page or connection button can issue server requests.
	select {
	case err := <-registration:
		if err != nil {
			return fmt.Errorf("工作区通道注册失败: %w", err)
		}
	case <-time.After(30 * time.Second):
		return fmt.Errorf("工作区通道注册超时")
	}
	// Verify actual API forwarding readiness after workspace registration.
	for i := 0; i < 30; i++ {
		if t.connected() {
			return nil
		}
		time.Sleep(100 * time.Millisecond)
	}
	return fmt.Errorf("服务器 API 通道尚未就绪")
}
func (t *Tunnel) stop() {
	t.mu.Lock()
	t.stopped = true
	cmd := t.proc
	t.proc = nil
	t.bridgePort = 0
	t.bridgeReady = false
	if t.connectionCancel != nil {
		t.connectionCancel()
	}
	t.mu.Unlock()
	if cmd != nil && cmd.Process != nil {
		_ = cmd.Process.Kill()
	}
	// Finish canceled registrations before a replacement tunnel writes its marker.
	t.registrationMu.Lock()
	t.registrationMu.Unlock()
}
func (t *Tunnel) connected() bool {
	t.mu.Lock()
	alive := t.proc != nil && t.bridgeReady && t.bridgePort > 0 && !t.stopped
	t.mu.Unlock()
	if !alive {
		return false
	}
	client := &http.Client{Timeout: 800 * time.Millisecond}
	response, err := client.Get(fmt.Sprintf("http://127.0.0.1:%d/api/auth/status", apiLocalPort))
	if err != nil {
		return false
	}
	response.Body.Close()
	return response.StatusCode == http.StatusOK
}
func (t *Tunnel) controlAlive() bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.proc != nil && t.bridgeReady && t.bridgePort > 0 && !t.stopped
}
func (t *Tunnel) ExecRemote(script string) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), workspaceSyncTimeout)
	defer cancel()
	return t.ExecRemoteContext(ctx, script)
}

func (t *Tunnel) ExecRemoteContext(ctx context.Context, script string) (string, error) {
	if err := ctx.Err(); err != nil {
		return "", err
	}
	args := append(t.baseArgs(), "bash -s")
	cmd := hideCommandWindow(exec.CommandContext(ctx, sshExe(), args...))
	cmd.WaitDelay = time.Second
	cmd.Stdin = strings.NewReader(script + "\n")
	var diagnostic bytes.Buffer
	cmd.Stderr = &diagnostic
	out, err := cmd.Output()
	if err != nil {
		if ctx.Err() != nil {
			err = ctx.Err()
		}
		err = fmt.Errorf("%w: %s", err, strings.TrimSpace(diagnostic.String()))
	}
	return strings.TrimSpace(string(out)), err
}
func (t *Tunnel) RegisterMapping(m *Mapping) error {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	return t.RegisterMappingContext(ctx, m)
}

func (t *Tunnel) RegisterMappingContext(ctx context.Context, m *Mapping) error {
	unlock, err := lockContext(ctx, &t.registrationMu)
	if err != nil {
		return err
	}
	defer unlock()
	return t.registerMappingContext(ctx, m)
}

func (t *Tunnel) registerMappingContext(ctx context.Context, m *Mapping) error {
	if m.ServerID != serverIdentity(t.Cfg) {
		return fmt.Errorf("项目绑定属于其他服务器")
	}
	t.mu.Lock()
	port, process, stopped, connection := t.bridgePort, t.proc, t.stopped, t.connectionContext
	t.mu.Unlock()
	if port == 0 || process == nil || stopped {
		return fmt.Errorf("工作区通道尚未就绪")
	}
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	if connection != nil {
		stop := context.AfterFunc(connection, cancel)
		defer stop()
	}
	protocol := 1
	if m.Mode == "vps" {
		protocol = 2
	}
	marker := map[string]any{"protocol": protocol, "readBatch": true, "port": port, "token": t.Cfg.Token, "bindingEpoch": m.BindingEpoch}
	if t.Cfg.WorkspaceAccount != "" {
		marker["controlHost"] = t.Cfg.ControlHost
	}
	raw, err := json.Marshal(marker)
	if err != nil {
		return err
	}
	script := "umask 077; printf '%s' " + shellQuote(string(raw)) + " > " + shellQuote(m.ServerPath+"/.chisa-bridge.json.tmp") + " && mv -- " + shellQuote(m.ServerPath+"/.chisa-bridge.json.tmp") + " " + shellQuote(m.ServerPath+"/.chisa-bridge.json")
	_, err = t.ExecRemoteContext(ctx, script)
	t.mu.Lock()
	current := t.proc == process && t.bridgePort == port && !t.stopped
	t.mu.Unlock()
	if !current {
		return fmt.Errorf("工作区通道在注册期间已改变，请重新连接")
	}
	return err
}

// Each workspace stores its own capability and an allocated reverse port.
func (t *Tunnel) PushToken(_ string) error {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	unlock, lockErr := lockContext(ctx, &t.registrationMu)
	if lockErr != nil {
		return lockErr
	}
	defer unlock()
	t.mu.Lock()
	process, port := t.proc, t.bridgePort
	t.mu.Unlock()
	var failures []error
	for _, m := range store.mappings() {
		if m.ServerID != serverIdentity(t.Cfg) {
			continue
		}
		if err := t.registerMappingContext(ctx, m); err != nil {
			failures = append(failures, err)
		}
	}
	err := errors.Join(failures...)
	t.mu.Lock()
	if t.proc == process && t.bridgePort == port && process != nil && port > 0 && !t.stopped {
		t.bridgeReady = err == nil
	} else {
		err = fmt.Errorf("工作区通道已改变，请重新连接")
	}
	t.mu.Unlock()
	return err
}
