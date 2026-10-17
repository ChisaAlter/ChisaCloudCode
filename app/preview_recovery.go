package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"os/exec"
	"regexp"
)

type managedPreviewRecord struct {
	ID           string `json:"id"`
	ServerPath   string `json:"serverPath"`
	BindingEpoch string `json:"bindingEpoch"`
	RemoteHost   string `json:"remoteHost"`
	RemotePort   int    `json:"remotePort"`
}

var managedPreviewID = regexp.MustCompile(`^chisa-account-preview-[a-f0-9]{20}-[a-f0-9]{16}$`)

// Caller holds serverConnectionMu. Capabilities recovered from one account must
// not be used after the desktop changes its authenticated account or instance.
func managedPreviewScopeLocked() string {
	cfg := store.config()
	if apiConnection == nil || !apiConnection.authenticated || apiConnection.ctx.Err() != nil ||
		cfg.WorkspaceAccount == "" || cfg.WorkspaceAccount != apiConnection.accountIdentity || cfg.WorkspaceLoginURL != apiConnection.loginURL {
		return ""
	}
	return serverIdentity(cfg)
}

// Docker, not the desktop's process-local map, is authoritative after a crash.
// Discovery does not start/stop a preview or require a working SSH tunnel.
func recoverManagedPreviewsContext(ctx context.Context) error {
	unlock, err := lockContext(ctx, &previewOperations)
	if err != nil {
		return err
	}
	defer unlock()
	return recoverManagedPreviewsLockedContext(ctx)
}

func recoverPreviewsContext(ctx context.Context) error {
	unlock, err := lockContext(ctx, &previewOperations)
	if err != nil {
		return err
	}
	defer unlock()
	if store.config().WorkspaceAccount != "" {
		return recoverManagedPreviewsLockedContext(ctx)
	}
	return recoverManualPreviewsLockedContext(ctx)
}

func recoverManagedPreviewsLockedContext(ctx context.Context) error {
	serverConnectionMu.RLock()
	scope := managedPreviewScopeLocked()
	connection := apiConnection
	serverConnectionMu.RUnlock()
	if scope == "" {
		return nil
	}
	result, err := accountWorkspaceRPC(ctx, "/api/workspace-sync/preview", map[string]any{"op": "list"})
	if err != nil {
		return fmt.Errorf("无法恢复远端预览列表: %w", err)
	}
	rows, valid := result["previews"].([]any)
	if !valid {
		return fmt.Errorf("远端预览列表无效")
	}
	encoded, err := json.Marshal(rows)
	if err != nil {
		return fmt.Errorf("远端预览列表无效")
	}
	var records []managedPreviewRecord
	if err := json.Unmarshal(encoded, &records); err != nil {
		return fmt.Errorf("远端预览列表无效")
	}
	for _, record := range records {
		if !managedPreviewID.MatchString(record.ID) || record.ServerPath == "" {
			return fmt.Errorf("远端预览列表无效")
		}
	}
	serverConnectionMu.RLock()
	defer serverConnectionMu.RUnlock()
	if connection != apiConnection || managedPreviewScopeLocked() != scope || ctx.Err() != nil {
		return fmt.Errorf("预览账号连接已改变")
	}
	previews.Lock()
	defer previews.Unlock()
	seen := make(map[string]bool, len(records))
	for _, record := range records {
		seen[record.ID] = true
		item := previews.items[record.ID]
		if item.ID != "" && (!item.Managed || item.ServerID != scope) {
			return fmt.Errorf("预览标识属于其他连接")
		}
		item.ID, item.ServerPath, item.Managed, item.ServerID = record.ID, record.ServerPath, true, scope
		item.RemoteEpoch, item.RemoteHost, item.RemotePort = record.BindingEpoch, record.RemoteHost, record.RemotePort
		if mapping := store.findMappingByServer(record.ServerPath); workspaceMappingActiveLocked(mapping) {
			item.Epoch = mapping.BindingEpoch
		}
		previews.items[record.ID] = item
	}
	for id, item := range previews.items {
		if item.Managed && item.ServerID == scope && !seen[id] {
			if item.Forward != nil && item.Forward.Process != nil {
				_ = item.Forward.Process.Kill()
			}
			delete(previews.items, id)
		}
	}
	return nil
}

func forgetPreview(item Preview) {
	if item.Forward != nil && item.Forward.Process != nil {
		_ = item.Forward.Process.Kill()
	}
	previews.Lock()
	if current, ok := previews.items[item.ID]; ok && current.ServerID == item.ServerID && current.Epoch == item.Epoch {
		delete(previews.items, item.ID)
	}
	previews.Unlock()
}

// Only an explicit Open action rebuilds the localhost forward. Legacy previews
// lacking an epoch/port remain visible and stoppable, but cannot be adopted as
// if they belonged to a newer binding.
func restoreManagedPreviewForward(ctx context.Context, item Preview, mapping *Mapping) error {
	if item.RemoteEpoch == "" || item.RemoteEpoch != mapping.BindingEpoch {
		return fmt.Errorf("预览来自旧绑定；请停止后重新启动")
	}
	address := net.ParseIP(item.RemoteHost)
	if address == nil || address.To4() == nil || !address.IsPrivate() || item.RemotePort < 1024 || item.RemotePort > 65535 {
		return fmt.Errorf("预览连接信息已失效；请停止后重新启动")
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return fmt.Errorf("无法分配预览端口")
	}
	port := listener.Addr().(*net.TCPAddr).Port
	_ = listener.Close()
	serverConnectionMu.RLock()
	connection, transport := apiConnection, tunnel
	owned := item.ServerID == managedPreviewScopeLocked() && transport != nil
	serverConnectionMu.RUnlock()
	if !owned || ctx.Err() != nil {
		return fmt.Errorf("预览账号连接已改变")
	}
	forward := hideCommandWindow(exec.Command(sshExe(), append([]string{"-N", "-L", fmt.Sprintf("127.0.0.1:%d:%s:%d", port, item.RemoteHost, item.RemotePort)}, transport.baseArgs()...)...))
	if err := forward.Start(); err != nil {
		return fmt.Errorf("预览 SSH 通道启动失败")
	}
	serverConnectionMu.RLock()
	previews.Lock()
	current, exists := previews.items[item.ID]
	if !exists || connection != apiConnection || transport != tunnel || managedPreviewScopeLocked() != item.ServerID || current.ServerID != item.ServerID || current.Epoch != item.Epoch || ctx.Err() != nil {
		previews.Unlock()
		serverConnectionMu.RUnlock()
		_ = forward.Process.Kill()
		_ = forward.Wait()
		return fmt.Errorf("预览账号连接已改变")
	}
	if current.Forward != nil {
		previews.Unlock()
		serverConnectionMu.RUnlock()
		_ = forward.Process.Kill()
		_ = forward.Wait()
		return nil
	}
	current.Forward, current.Port = forward, port
	current.LocalURL = fmt.Sprintf("http://127.0.0.1:%d", port)
	previews.items[item.ID] = current
	previews.Unlock()
	serverConnectionMu.RUnlock()
	watchPreviewForward(item.ID, forward, connection.ctx)
	return nil
}

func watchPreviewForward(id string, forward *exec.Cmd, lifetime context.Context) {
	stop := func() bool { return false }
	if lifetime != nil {
		stop = context.AfterFunc(lifetime, func() { _ = forward.Process.Kill() })
	}
	go func() {
		_ = forward.Wait()
		stop()
		previews.Lock()
		if current, ok := previews.items[id]; ok && current.Forward == forward {
			current.Forward, current.LocalURL = nil, ""
			previews.items[id] = current
		}
		previews.Unlock()
	}()
}
