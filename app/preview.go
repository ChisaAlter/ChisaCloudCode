package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"os/exec"
	"path"
	"strconv"
	"strings"
	"sync"
	"time"
)

type Preview struct {
	ID          string    `json:"id"`
	ServerPath  string    `json:"serverPath"`
	LocalURL    string    `json:"localUrl"`
	Port        int       `json:"-"`
	Epoch       string    `json:"-"`
	Forward     *exec.Cmd `json:"-"`
	Managed     bool      `json:"-"`
	ServerID    string    `json:"-"`
	RemoteEpoch string    `json:"-"`
	RemoteHost  string    `json:"-"`
	RemotePort  int       `json:"-"`
}

var previews = struct {
	sync.Mutex
	items map[string]Preview
}{items: make(map[string]Preview)}

// Inventory and remote mutations share one ordering: an inventory obtained
// before a successful stop must never recreate the removed capability.
var previewOperations sync.Mutex

var previewDockerOutputContext = dockerOutputForTunnelContext

func dockerOutput(timeout time.Duration, args ...string) ([]byte, error) {
	return dockerOutputContext(context.Background(), timeout, args...)
}

func dockerOutputContext(parent context.Context, timeout time.Duration, args ...string) ([]byte, error) {
	return dockerOutputForTunnelContext(parent, timeout, tunnel, args...)
}

func dockerOutputForTunnelContext(parent context.Context, timeout time.Duration, transport *Tunnel, args ...string) ([]byte, error) {
	if transport == nil {
		return nil, fmt.Errorf("工作区 SSH 通道尚未连接")
	}
	ctx, cancel := context.WithTimeout(parent, timeout)
	defer cancel()
	quoted := make([]string, len(args))
	for i, arg := range args {
		quoted[i] = shellQuote(arg)
	}
	cmd := hideCommandWindow(exec.CommandContext(ctx, sshExe(), append(transport.baseArgs(), "docker "+strings.Join(quoted, " "))...))
	cmd.WaitDelay = time.Second
	return cmd.Output()
}

func previewRPC(m *Mapping, q map[string]any) map[string]any {
	ctx, cancel := context.WithTimeout(context.Background(), workspaceSyncTimeout)
	defer cancel()
	return previewRPCContext(ctx, m, q)
}

func previewRPCContext(ctx context.Context, m *Mapping, q map[string]any) map[string]any {
	if err := ctx.Err(); err != nil {
		return map[string]any{"error": "预览请求已取消", "code": "WORKSPACE_UNAVAILABLE"}
	}
	unlock, err := lockContext(ctx, &previewOperations)
	if err != nil {
		return map[string]any{"error": "预览请求已取消", "code": "WORKSPACE_UNAVAILABLE"}
	}
	defer unlock()
	serverConnectionMu.RLock()
	current := store.findMappingByServer(m.ServerPath)
	owned := current != nil && current.BindingEpoch == m.BindingEpoch && workspaceMappingActiveLocked(current)
	serverConnectionMu.RUnlock()
	if !owned {
		return map[string]any{"ok": false, "error": "此项目预览属于其他账号", "code": "WORKSPACE_UNAVAILABLE"}
	}
	if store.config().WorkspaceAccount != "" {
		return managedPreviewRPC(ctx, m, q)
	}
	serverConnectionMu.RLock()
	scope, transport := manualPreviewScopeLocked(), tunnel
	serverConnectionMu.RUnlock()
	if scope == "" {
		return map[string]any{"error": "工作区 SSH 连接已改变", "code": "WORKSPACE_UNAVAILABLE"}
	}
	op, _ := q["op"].(string)
	if op == "preview_start" {
		if m.Mode != "vps" {
			return map[string]any{"error": "工作区不可用", "code": "WORKSPACE_UNAVAILABLE"}
		}
		command, _ := q["command"].(string)
		number, _ := q["port"].(float64)
		port := int(number)
		cwd, _ := q["path"].(string)
		if cwd == "" {
			cwd = "/workspace"
		}
		cwd = path.Clean(cwd)
		if strings.TrimSpace(command) == "" || number != float64(port) || port < 1024 || port > 65535 || (cwd != "/workspace" && !strings.HasPrefix(cwd, "/workspace/")) {
			return map[string]any{"error": "无效的预览命令、目录或端口", "code": "INVALID_REQUEST"}
		}
		root := m.ServerPath
		listener, err := net.Listen("tcp", "127.0.0.1:0")
		if err != nil {
			return map[string]any{"error": "无法分配预览端口"}
		}
		localPort := listener.Addr().(*net.TCPAddr).Port
		listener.Close()
		remotePortText, err := transport.ExecRemoteContext(ctx, "python3 -c "+shellQuote("import socket;s=socket.socket();s.bind(('127.0.0.1',0));print(s.getsockname()[1]);s.close()"))
		remotePort, parseErr := strconv.Atoi(remotePortText)
		if err != nil || parseErr != nil || remotePort < 1024 {
			return map[string]any{"error": "无法分配服务器预览端口"}
		}
		id := "chisa-preview-" + randHex(8)
		args := append([]string{"run", "--detach", "--name", id, "--label", "chisa.project=" + m.ServerPath, "--label", "chisa.preview.scope=" + scope, "--label", "chisa.preview.epoch=" + m.BindingEpoch, "--label", "chisa.preview.port=" + strconv.Itoa(port), "--publish", fmt.Sprintf("127.0.0.1:%d:%d", remotePort, port)}, workspaceContainerArgs(root)...)
		args = append(args, "--workdir", cwd, workspaceImage, "bash", "-c", command)
		if _, err = previewDockerOutputContext(ctx, 30*time.Second, transport, args...); err != nil {
			return map[string]any{"error": "预览启动失败，请检查命令与执行环境", "code": "PREVIEW_START_FAILED"}
		}
		forward := hideCommandWindow(exec.Command(sshExe(), append([]string{"-N", "-L", fmt.Sprintf("127.0.0.1:%d:127.0.0.1:%d", localPort, remotePort)}, transport.baseArgs()...)...))
		if err := forward.Start(); err != nil {
			_, _ = previewDockerOutputContext(ctx, 15*time.Second, transport, "rm", "--force", id)
			return map[string]any{"error": "预览 SSH 通道启动失败"}
		}
		serverConnectionMu.RLock()
		if transport != tunnel || scope != manualPreviewScopeLocked() || ctx.Err() != nil {
			serverConnectionMu.RUnlock()
			_ = forward.Process.Kill()
			_ = forward.Wait()
			return map[string]any{"error": "工作区 SSH 连接已改变", "code": "WORKSPACE_UNAVAILABLE"}
		}
		previews.Lock()
		previews.items[id] = Preview{ID: id, ServerPath: m.ServerPath, Epoch: m.BindingEpoch, Port: localPort, LocalURL: fmt.Sprintf("http://127.0.0.1:%d", localPort), Forward: forward, ServerID: scope, RemoteEpoch: m.BindingEpoch, RemoteHost: "127.0.0.1", RemotePort: remotePort}
		previews.Unlock()
		serverConnectionMu.RUnlock()
		watchPreviewForward(id, forward, manualPreviewConnectionContext(transport))
		return map[string]any{"ok": true, "previewId": id, "status": "starting"}
	}
	id, _ := q["previewId"].(string)
	previews.Lock()
	item, exists := previews.items[id]
	previews.Unlock()
	if !exists || item.Managed || item.ServerID != scope || item.ServerPath != m.ServerPath || item.Epoch != m.BindingEpoch {
		return map[string]any{"error": "预览不存在或绑定已失效", "code": "PREVIEW_NOT_FOUND"}
	}
	if op == "preview_stop" {
		if _, err := previewDockerOutputContext(ctx, 15*time.Second, transport, "rm", "--force", id); err != nil {
			return map[string]any{"error": "预览停止失败"}
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
		raw, err := previewDockerOutputContext(ctx, 10*time.Second, transport, "inspect", "--format", "{{json .State}}", id)
		if err != nil {
			return map[string]any{"error": "无法读取预览状态"}
		}
		var state struct {
			Running  bool
			ExitCode int
		}
		if json.Unmarshal(raw, &state) != nil {
			return map[string]any{"error": "预览状态无效"}
		}
		logCtx, cancelLogs := context.WithTimeout(ctx, 10*time.Second)
		logCmd := hideCommandWindow(exec.CommandContext(logCtx, sshExe(), append(transport.baseArgs(), "docker logs --tail 100 "+shellQuote(id))...))
		var errorLogs bytes.Buffer
		logCmd.Stderr = &errorLogs
		logs, _ := logCmd.Output()
		cancelLogs()
		ready := state.Running && previewHTTPReady(ctx, item.LocalURL)
		return map[string]any{"ok": true, "running": state.Running, "ready": ready && state.Running, "exitCode": state.ExitCode, "stdout": string(logs), "stderr": errorLogs.String()}
	}
	return map[string]any{"error": "不支持的预览操作", "code": "INVALID_REQUEST"}
}

func previewHTTPReady(ctx context.Context, localURL string) bool {
	probeCtx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	request, err := http.NewRequestWithContext(probeCtx, http.MethodGet, localURL, nil)
	if err != nil {
		return false
	}
	client := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	response, err := client.Do(request)
	if err != nil {
		return false
	}
	response.Body.Close()
	return true
}

func previewList() []Preview {
	previews.Lock()
	defer previews.Unlock()
	items := make([]Preview, 0, len(previews.items))
	for _, item := range previews.items {
		items = append(items, item)
	}
	return items
}

func stopProjectPreviews(serverPath string) error {
	ctx, cancel := context.WithTimeout(context.Background(), workspaceSyncTimeout)
	defer cancel()
	return stopProjectPreviewsContext(ctx, serverPath)
}

func stopProjectPreviewsContext(ctx context.Context, serverPath string) error {
	if err := recoverPreviewsContext(ctx); err != nil {
		return err
	}
	unlock, err := lockContext(ctx, &previewOperations)
	if err != nil {
		return err
	}
	defer unlock()
	for _, item := range previewList() {
		if serverPath != "" && serverPath != item.ServerPath {
			continue
		}
		if item.Managed {
			serverConnectionMu.RLock()
			owned := item.ServerID != "" && item.ServerID == managedPreviewScopeLocked()
			serverConnectionMu.RUnlock()
			if !owned {
				continue
			}
			if _, err := accountWorkspaceRPC(ctx, "/api/workspace-sync/preview", map[string]any{"op": "remove", "id": item.ID}); err != nil {
				return err
			}
		} else {
			serverConnectionMu.RLock()
			owned := item.ServerID != "" && item.ServerID == manualPreviewScopeLocked()
			serverConnectionMu.RUnlock()
			if !owned {
				continue
			}
			if err := removeManualPreviewContext(ctx, item); err != nil {
				return err
			}
		}
		forgetPreview(item)
	}
	return nil
}

// OpenPreview accepts a registered capability, never an arbitrary URL.
func (FrontendBridge) OpenPreview(id string) map[string]any {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := recoverPreviewsContext(ctx); err != nil {
		return map[string]any{"ok": false, "error": err.Error()}
	}
	previews.Lock()
	item, exists := previews.items[id]
	previews.Unlock()
	if !exists {
		return map[string]any{"ok": false, "error": "预览不存在"}
	}
	serverConnectionMu.RLock()
	scope := manualPreviewScopeLocked()
	if item.Managed {
		scope = managedPreviewScopeLocked()
	}
	owned := item.ServerID != "" && item.ServerID == scope
	serverConnectionMu.RUnlock()
	if !owned {
		return map[string]any{"ok": false, "error": "预览属于其他连接"}
	}
	m := store.findMappingByServer(item.ServerPath)
	if m == nil || m.BindingEpoch != item.Epoch {
		return map[string]any{"ok": false, "error": "预览绑定已失效"}
	}
	if item.RemoteEpoch == "" || item.RemoteEpoch != m.BindingEpoch {
		return map[string]any{"ok": false, "error": "预览来自旧绑定；请停止后重新启动"}
	}
	if item.LocalURL == "" {
		restore := restoreManualPreviewForward
		if item.Managed {
			restore = restoreManagedPreviewForward
		}
		if err := restore(ctx, item, m); err != nil {
			return map[string]any{"ok": false, "error": err.Error()}
		}
		previews.Lock()
		item = previews.items[id]
		previews.Unlock()
	}
	status := previewRPC(m, map[string]any{"op": "preview_status", "previewId": id})
	if ready, _ := status["ready"].(bool); !ready {
		return map[string]any{"ok": false, "error": "预览尚未监听端口，请检查启动日志"}
	}
	if err := exec.Command("rundll32.exe", "url.dll,FileProtocolHandler", item.LocalURL).Start(); err != nil {
		return map[string]any{"ok": false, "error": "打开预览失败"}
	}
	return map[string]any{"ok": true}
}

func (FrontendBridge) StopPreview(id string) map[string]any {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	if err := recoverPreviewsContext(ctx); err != nil {
		return map[string]any{"ok": false, "error": err.Error()}
	}
	unlock, err := lockContext(ctx, &previewOperations)
	if err != nil {
		return map[string]any{"ok": false, "error": err.Error()}
	}
	defer unlock()
	previews.Lock()
	item, exists := previews.items[id]
	previews.Unlock()
	if !exists {
		return map[string]any{"ok": false, "error": "预览不存在"}
	}
	if item.Managed {
		serverConnectionMu.RLock()
		owned := item.ServerID != "" && item.ServerID == managedPreviewScopeLocked()
		serverConnectionMu.RUnlock()
		if !owned {
			return map[string]any{"ok": false, "error": "预览属于其他账号"}
		}
		if _, err := accountWorkspaceRPC(ctx, "/api/workspace-sync/preview", map[string]any{"op": "remove", "id": id}); err != nil {
			return map[string]any{"ok": false, "error": err.Error()}
		}
		forgetPreview(item)
		return map[string]any{"ok": true, "status": "stopped"}
	}
	if err := removeManualPreviewContext(ctx, item); err != nil {
		return map[string]any{"ok": false, "error": err.Error()}
	}
	return map[string]any{"ok": true, "status": "stopped"}
}
