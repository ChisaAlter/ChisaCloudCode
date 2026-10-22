package main

import (
	"bytes"
	"context"
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"os/exec"
	"strings"
	"sync"
	"time"
)

//go:embed resources/workspace.py
var workspaceWorker string

const workspaceImage = "localhost/chisa-workspace:3"

var workspaceLocks sync.Map

// Files and commands use one isolated project mount, with no host home or keys.
func workspaceCommand(m *Mapping, request map[string]any) (*exec.Cmd, error) {
	if m.Mode != "vps" {
		return nil, fmt.Errorf("项目尚未完成 VPS 迁移，请在设置中同步")
	}
	root := m.ServerPath
	payload, err := json.Marshal(request)
	if err != nil {
		return nil, err
	}
	args := workspaceContainerArgs(root)
	args = append([]string{"run", "--rm", "--name", request["containerName"].(string)}, args...)
	args = append(args, workspaceImage, "python3", "/opt/chisa/workspace.py")
	quoted := make([]string, len(args))
	for i, arg := range args {
		quoted[i] = shellQuote(arg)
	}
	cmd := hideCommandWindow(exec.Command(sshExe(), append(tunnel.baseArgs(), "docker "+strings.Join(quoted, " "))...))
	cmd.Stdin = bytes.NewReader(payload)
	return cmd, nil
}

func workspaceContainerArgs(root string) []string {
	return []string{
		"--interactive",
		"--user=1000:1000", "--cap-drop=ALL", "--security-opt=no-new-privileges",
		"--pids-limit=256", "--memory=2g", "--hostname=workspace", "--workdir=/workspace", "--read-only",
		"--tmpfs=/tmp:rw,size=512m", "--tmpfs=/home/chisa:rw,size=512m",
		"--volume", root + ":/workspace:rw", "--env=HOME=/home/chisa", "--env=TZ=UTC",
		// Commands must not read the native capability token. The host retains
		// the real marker; the unprivileged container sees an empty masked file.
		"--mount", "type=bind,src=/dev/null,dst=/workspace/.chisa-bridge.json,readonly",
	}
}

func workspaceRPC(m *Mapping, request map[string]any) map[string]any {
	ctx, cancel := context.WithTimeout(context.Background(), workspaceSyncTimeout)
	defer cancel()
	return workspaceRPCContext(ctx, m, request)
}

func workspaceRPCContext(ctx context.Context, m *Mapping, request map[string]any) (response map[string]any) {
	started := time.Now()
	op, _ := request["op"].(string)
	traceOp := op
	switch op {
	case "stat", "lstat", "list", "batch", "realpath", "read", "write", "mkdir", "rename", "copy", "remove", "search", "grep", "exec", "git_read", "git_branch", "preview_start", "preview_status", "preview_stop", "sync_begin", "sync_end", "sync_released":
	default:
		traceOp = "unknown"
	}
	items := 1
	if op == "batch" {
		requests, _ := request["requests"].([]any)
		items = len(requests)
	}
	var waiting, preparation, running, cleanup time.Duration
	succeeded := false
	defer func() {
		log.Printf("[workspace] op=%s items=%d ok=%t wait=%s prepare=%s run=%s cleanup=%s total=%s", traceOp, items, succeeded, waiting, preparation, running, cleanup, time.Since(started))
	}()
	if traceOp == "unknown" {
		return map[string]any{"ok": false, "error": "Unsupported workspace operation", "code": "INVALID_REQUEST"}
	}
	waitStarted := time.Now()
	unlock, err := lockWorkspace(ctx, m.ServerPath)
	waiting = time.Since(waitStarted)
	if err != nil {
		return map[string]any{"ok": false, "error": "工作区请求已取消或超时", "code": "WORKSPACE_UNAVAILABLE"}
	}
	defer unlock()
	if current := store.findMappingByServer(m.ServerPath); current == nil || current.BindingEpoch != m.BindingEpoch {
		return map[string]any{"ok": false, "error": "工作区绑定已失效", "code": "STALE_BINDING"}
	}
	serverConnectionMu.RLock()
	owned := workspaceMappingActiveLocked(m)
	serverConnectionMu.RUnlock()
	if !owned {
		return map[string]any{"ok": false, "error": "此项目未连接当前账号", "code": "WORKSPACE_UNAVAILABLE"}
	}
	if op == "git_read" {
		runStarted := time.Now()
		response := localGitReadRPC(ctx, m, request)
		running = time.Since(runStarted)
		succeeded = response["ok"] == true
		return response
	}
	if op == "git_branch" {
		runStarted := time.Now()
		response := localGitBranchRPC(ctx, m, request)
		running = time.Since(runStarted)
		succeeded = response["ok"] == true
		return response
	}
	if op == "sync_begin" || op == "sync_end" || op == "sync_released" {
		response := synchronizationRPCContext(ctx, m, request)
		succeeded = response["ok"] == true
		return response
	}
	switch op {
	case "write", "mkdir", "rename", "copy", "remove", "exec", "preview_start":
		if piWorkspaceOwned(m.ServerPath) {
			return map[string]any{"ok": false, "error": "Workspace is busy", "code": "WORKSPACE_BUSY"}
		}
	}
	if strings.HasPrefix(op, "preview_") {
		runStarted := time.Now()
		response := previewRPCContext(ctx, m, request)
		running = time.Since(runStarted)
		succeeded = response["ok"] == true
		return response
	}
	if store.config().WorkspaceAccount != "" {
		runStarted := time.Now()
		result, err := accountWorkspaceRPC(ctx, "/api/workspace-sync/worker", map[string]any{"serverPath": m.ServerPath, "bindingEpoch": m.BindingEpoch, "request": request})
		running = time.Since(runStarted)
		if err != nil {
			code := "WORKSPACE_UNAVAILABLE"
			var accountError *accountWorkspaceError
			if errors.As(err, &accountError) {
				code = accountError.Code
			}
			if code == "WORKSPACE_CLEANUP_FAILED" {
				setSyncInfo(m, "blocked", "工作区运行容器清理未确认，请保留同步屏障并恢复工作区")
			}
			return map[string]any{"ok": false, "error": err.Error(), "code": code}
		}
		if result["code"] == "WORKSPACE_CLEANUP_FAILED" {
			setSyncInfo(m, "blocked", "工作区运行容器清理未确认，请保留同步屏障并恢复工作区")
		}
		succeeded = result["ok"] == true
		return result
	}
	prepareStarted := time.Now()
	name := "chisa-rpc-" + randHex(8)
	request["containerName"] = name
	cmd, err := workspaceCommand(m, request)
	preparation = time.Since(prepareStarted)
	if err != nil {
		return map[string]any{"error": err.Error(), "code": "WORKSPACE_UNAVAILABLE"}
	}
	// Removing containers at the end also stops descendants of completed commands.
	bounded := exec.CommandContext(ctx, cmd.Path, cmd.Args[1:]...)
	bounded.WaitDelay = time.Second
	bounded.SysProcAttr = cmd.SysProcAttr
	bounded.Stdin = cmd.Stdin
	cmd = bounded
	defer func() {
		cleanupStarted := time.Now()
		cleanupCtx, done := context.WithTimeout(context.Background(), 10*time.Second)
		defer done()
		script := "if docker rm --force " + shellQuote(name) + " >/dev/null 2>&1; then exit 0; fi\nout=$(docker ps --all --format '{{.Names}}' --filter " + shellQuote("name=^/"+name+"$") + "); code=$?\n[ \"$code\" -eq 0 ] && [ -z \"$out\" ]"
		command := hideCommandWindow(exec.CommandContext(cleanupCtx, sshExe(), append(tunnel.baseArgs(), script)...))
		command.WaitDelay = time.Second
		if err := command.Run(); err != nil {
			succeeded = false
			setSyncInfo(m, "blocked", "工作区运行容器清理未确认，请保留同步屏障并恢复工作区")
			response = map[string]any{"error": "工作区运行容器清理未确认", "code": "WORKSPACE_CLEANUP_FAILED"}
		}
		cleanup = time.Since(cleanupStarted)
	}()
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	runStarted := time.Now()
	out, err := cmd.Output()
	running = time.Since(runStarted)
	if err != nil {
		log.Printf("workspace startup: %v: %s", err, stderr.String())
		return map[string]any{"error": "VPS 工作区启动失败，请检查服务器执行环境", "code": "WORKSPACE_UNAVAILABLE"}
	}
	if err := json.Unmarshal(out, &response); err != nil {
		return map[string]any{"error": "工作区响应无效", "code": "INVALID_RESPONSE"}
	}
	succeeded = response["ok"] == true
	return response
}

func executeLocal(serverCWD, command string) map[string]any {
	m := store.findMappingByServer(serverCWD)
	if m == nil {
		return map[string]any{"error": "工作区未绑定", "code": "WORKSPACE_NOT_BOUND"}
	}
	return workspaceRPC(m, map[string]any{"op": "exec", "command": command})
}
