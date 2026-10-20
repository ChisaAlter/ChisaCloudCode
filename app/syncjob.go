package main

import (
	"bytes"
	"compress/zlib"
	"context"
	_ "embed"
	"encoding/base64"
	"fmt"
	"io"
	"os/exec"
	"strconv"
	"strings"
	"time"
)

//go:embed resources/sync_job.py
var syncJobWorker string

type syncLeaseContextKey struct{}

type workspaceSyncConnectionKey struct{}

// Only exact-owner recovery and an existing task's handback can use a legacy
// transport while its account network is waiting to migrate.
type workspaceRecoveryContextKey struct{}

type workspaceSyncConnection struct {
	connection    *serverConnection
	tunnel        *Tunnel
	cfg           Config
	keyPath       string
	allowRecovery bool
}

// A sync keeps its account and SSH transport even while login settings change.
func bindWorkspaceSyncConnection(parent context.Context) (context.Context, context.CancelFunc, error) {
	serverConnectionMu.RLock()
	snapshot, _ := parent.Value(workspaceSyncConnectionKey{}).(*workspaceSyncConnection)
	if snapshot == nil {
		snapshot = &workspaceSyncConnection{connection: apiConnection, tunnel: tunnel, cfg: store.config(), keyPath: store.keyPathOf()}
	}
	if allowed, _ := parent.Value(workspaceRecoveryContextKey{}).(bool); allowed && !snapshot.allowRecovery {
		copy := *snapshot
		copy.allowRecovery = true
		snapshot = &copy
	}
	if parent.Err() != nil || !snapshot.currentLocked() {
		serverConnectionMu.RUnlock()
		return nil, nil, fmt.Errorf("文件同步账号或连接已改变，请重新打开工作目录")
	}
	ctx, cancel := context.WithCancel(parent)
	stop := context.AfterFunc(snapshot.connection.ctx, cancel)
	serverConnectionMu.RUnlock()
	return context.WithValue(ctx, workspaceSyncConnectionKey{}, snapshot), func() { stop(); cancel() }, nil
}

// Call while holding serverConnectionMu; no network operation runs under this lock.
func (snapshot *workspaceSyncConnection) currentLocked() bool {
	return snapshot.connection != nil && snapshot.connection == apiConnection && snapshot.connection.authenticated && snapshot.connection.ctx.Err() == nil &&
		(!snapshot.connection.workspaceRecoveryOnly || snapshot.allowRecovery) &&
		snapshot.tunnel != nil && snapshot.tunnel == tunnel && snapshot.tunnel.controlAlive() && workspaceConnectionMatchesSession() &&
		serverIdentity(snapshot.cfg) == serverIdentity(store.config()) && snapshot.keyPath == store.keyPathOf()
}

func workspaceSyncCurrent(ctx context.Context) error {
	serverConnectionMu.RLock()
	defer serverConnectionMu.RUnlock()
	if err := ctx.Err(); err != nil {
		return err
	}
	if snapshot, _ := ctx.Value(workspaceSyncConnectionKey{}).(*workspaceSyncConnection); snapshot != nil && !snapshot.currentLocked() {
		return fmt.Errorf("文件同步账号或连接已改变，请重新打开工作目录")
	}
	return nil
}

func workspaceSyncConfig(ctx context.Context) Config {
	if snapshot, _ := ctx.Value(workspaceSyncConnectionKey{}).(*workspaceSyncConnection); snapshot != nil {
		return snapshot.cfg
	}
	return store.config()
}

func workspaceSyncTunnel(ctx context.Context, m *Mapping) (*Tunnel, error) {
	serverConnectionMu.RLock()
	defer serverConnectionMu.RUnlock()
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	current := tunnel
	if snapshot, _ := ctx.Value(workspaceSyncConnectionKey{}).(*workspaceSyncConnection); snapshot != nil {
		if !snapshot.currentLocked() {
			return nil, fmt.Errorf("文件同步账号或连接已改变")
		}
		current = snapshot.tunnel
	}
	if current == nil || m.ServerID != serverIdentity(current.Cfg) {
		return nil, fmt.Errorf("工作区绑定属于其他同步连接")
	}
	return current, nil
}

func syncLeaseContext(ctx context.Context, id string) context.Context {
	return context.WithValue(ctx, syncLeaseContextKey{}, id)
}

func syncRemoteJobCommand(ctx context.Context, m *Mapping, mode, command string) (string, error) {
	id, _ := ctx.Value(syncLeaseContextKey{}).(string)
	if id == "" {
		return "", fmt.Errorf("同步操作缺少匹配的工作区租约")
	}
	if err := ctx.Err(); err != nil {
		return "", err
	}
	deadline, ok := ctx.Deadline()
	if !ok {
		return "", fmt.Errorf("同步操作缺少总截止时间")
	}
	if mode == "shell" {
		var err error
		command, err = compactSyncRemoteShellCommand(command)
		if err != nil {
			return "", err
		}
	}
	args := []string{m.ServerPath, m.BindingEpoch, id, randHex(16), strconv.FormatFloat(float64(deadline.UnixMilli())/1000, 'f', 3, 64), mode}
	if mode != "receive-pack" {
		args = append(args, command)
	}
	remote := "python3 -c " + shellQuote(syncJobWorker)
	for _, argument := range args {
		remote += " " + shellQuote(argument)
	}
	return remote, nil
}

// Compact only the command, leaving stdin available for JSON or Git streams.
func compactSyncRemoteShellCommand(command string) (string, error) {
	if len(command) <= 8192 {
		return command, nil
	}
	var compressed bytes.Buffer
	writer := zlib.NewWriter(&compressed)
	if _, err := writer.Write([]byte(command)); err != nil {
		return "", err
	}
	if err := writer.Close(); err != nil {
		return "", err
	}
	bootstrap := "import base64,os,zlib;os.execlp('bash','bash','-c',zlib.decompress(base64.b64decode('" + base64.StdEncoding.EncodeToString(compressed.Bytes()) + "')).decode('utf-8'))"
	return "python3 -c " + shellQuote(bootstrap), nil
}

func syncRemoteScript(ctx context.Context, m *Mapping, script string, input io.Reader) (string, error) {
	remote, err := syncRemoteJobCommand(ctx, m, "shell", script)
	if err != nil {
		return "", err
	}
	transport, err := workspaceSyncTunnel(ctx, m)
	if err != nil {
		return "", err
	}
	cmd := hideCommandWindow(exec.CommandContext(ctx, sshExe(), append(transport.baseArgs(), remote)...))
	cmd.WaitDelay = time.Second
	cmd.Stdin = input
	var diagnostic bytes.Buffer
	cmd.Stderr = &diagnostic
	out, err := cmd.Output()
	if err != nil {
		if ctx.Err() != nil {
			err = ctx.Err()
		}
		return "", fmt.Errorf("远端同步未确认: %w: %s", err, strings.TrimSpace(diagnostic.String()))
	}
	return strings.TrimSpace(string(out)), nil
}
