package main

import (
	"context"
	"fmt"
	"net"
	"os/exec"
	"path"
	"strings"
)

// Account previews keep SSH port forwarding, while sandbox creation stays on the authenticated server.
func managedPreviewRPC(ctx context.Context, m *Mapping, q map[string]any) map[string]any {
	op, _ := q["op"].(string)
	if op == "preview_start" {
		serverConnectionMu.RLock()
		scope, connection, transport := managedPreviewScopeLocked(), apiConnection, tunnel
		recoveryOnly := connection != nil && connection.workspaceRecoveryOnly
		serverConnectionMu.RUnlock()
		if recoveryOnly {
			return map[string]any{"error": "文件同步正在恢复，请先完成工作区交还", "code": "WORKSPACE_BUSY"}
		}
		if scope == "" || transport == nil {
			return map[string]any{"error": "工作区账号连接已改变", "code": "WORKSPACE_UNAVAILABLE"}
		}
		command, _ := q["command"].(string)
		number, _ := q["port"].(float64)
		port := int(number)
		cwd, _ := q["path"].(string)
		if cwd == "" {
			cwd = "/workspace"
		}
		cwd = path.Clean(cwd)
		if m.Mode != "vps" || strings.TrimSpace(command) == "" || number != float64(port) || port < 1024 || port > 65535 || (cwd != "/workspace" && !strings.HasPrefix(cwd, "/workspace/")) {
			return map[string]any{"error": "无效的预览命令、目录或端口", "code": "INVALID_REQUEST"}
		}
		listener, err := net.Listen("tcp", "127.0.0.1:0")
		if err != nil {
			return map[string]any{"error": "无法分配预览端口"}
		}
		localPort := listener.Addr().(*net.TCPAddr).Port
		listener.Close()
		created, err := accountWorkspaceRPC(ctx, "/api/workspace-sync/preview", map[string]any{"op": "start", "serverPath": m.ServerPath, "bindingEpoch": m.BindingEpoch, "command": command, "cwd": cwd, "port": port})
		if err != nil {
			return map[string]any{"error": err.Error(), "code": "PREVIEW_START_FAILED"}
		}
		id, _ := created["id"].(string)
		remote, _ := created["remotePort"].(float64)
		remoteHost, _ := created["remoteHost"].(string)
		address := net.ParseIP(remoteHost)
		if id == "" || address == nil || address.To4() == nil || !address.IsPrivate() || remote != float64(int(remote)) || remote < 1024 || remote > 65535 {
			return map[string]any{"error": "预览服务返回了无效的连接信息", "code": "INVALID_RESPONSE"}
		}
		forward := hideCommandWindow(exec.Command(sshExe(), append([]string{"-N", "-L", fmt.Sprintf("127.0.0.1:%d:%s:%d", localPort, remoteHost, int(remote))}, transport.baseArgs()...)...))
		if err := forward.Start(); err != nil {
			if _, cleanupErr := accountWorkspaceRPC(ctx, "/api/workspace-sync/preview", map[string]any{"op": "remove", "id": id}); cleanupErr != nil {
				return map[string]any{"error": "预览清理未确认", "code": "WORKSPACE_CLEANUP_FAILED"}
			}
			return map[string]any{"error": "预览 SSH 通道启动失败"}
		}
		serverConnectionMu.RLock()
		if scope != managedPreviewScopeLocked() || connection != apiConnection || transport != tunnel || ctx.Err() != nil {
			serverConnectionMu.RUnlock()
			_ = forward.Process.Kill()
			_ = forward.Wait()
			return map[string]any{"error": "工作区账号连接已改变", "code": "WORKSPACE_UNAVAILABLE"}
		}
		previews.Lock()
		previews.items[id] = Preview{ID: id, ServerPath: m.ServerPath, Epoch: m.BindingEpoch, Port: localPort, LocalURL: fmt.Sprintf("http://127.0.0.1:%d", localPort), Forward: forward, Managed: true, ServerID: scope, RemoteEpoch: m.BindingEpoch, RemoteHost: remoteHost, RemotePort: int(remote)}
		previews.Unlock()
		serverConnectionMu.RUnlock()
		watchPreviewForward(id, forward, connection.ctx)
		return map[string]any{"ok": true, "previewId": id, "status": "starting"}
	}
	id, _ := q["previewId"].(string)
	previews.Lock()
	item, exists := previews.items[id]
	previews.Unlock()
	serverConnectionMu.RLock()
	owned := item.ServerID != "" && item.ServerID == managedPreviewScopeLocked()
	serverConnectionMu.RUnlock()
	if !exists || !item.Managed || !owned || item.ServerPath != m.ServerPath || item.Epoch != m.BindingEpoch {
		return map[string]any{"error": "预览不存在或绑定已失效", "code": "PREVIEW_NOT_FOUND"}
	}
	if op == "preview_stop" {
		if _, err := accountWorkspaceRPC(ctx, "/api/workspace-sync/preview", map[string]any{"op": "remove", "id": id}); err != nil {
			return map[string]any{"error": err.Error()}
		}
		if item.Forward != nil && item.Forward.Process != nil {
			_ = item.Forward.Process.Kill()
		}
		previews.Lock()
		delete(previews.items, id)
		previews.Unlock()
		return map[string]any{"ok": true, "status": "stopped"}
	}
	if op == "preview_status" {
		state, err := accountWorkspaceRPC(ctx, "/api/workspace-sync/preview", map[string]any{"op": "inspect", "id": id})
		if err != nil {
			return map[string]any{"error": err.Error()}
		}
		logs, err := accountWorkspaceRPC(ctx, "/api/workspace-sync/preview", map[string]any{"op": "logs", "id": id})
		if err != nil {
			return map[string]any{"error": err.Error()}
		}
		running, _ := state["Running"].(bool)
		return map[string]any{"ok": true, "running": running, "ready": running && previewHTTPReady(ctx, item.LocalURL), "exitCode": state["ExitCode"], "stdout": logs["stdout"], "stderr": logs["stderr"]}
	}
	return map[string]any{"error": "不支持的预览操作", "code": "INVALID_REQUEST"}
}
