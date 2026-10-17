package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"os/exec"
	"path"
	"regexp"
	"strconv"
	"strings"
	"time"
)

var manualPreviewID = regexp.MustCompile(`^chisa-preview-[a-f0-9]{16}$`)

// Caller holds serverConnectionMu. Manual SSH remains independent of managed
// account enrollment, but a capability is valid only for this exact SSH scope.
func manualPreviewScopeLocked() string {
	cfg := store.config()
	if cfg.WorkspaceAccount != "" || cfg.SSHHost == "" || tunnel == nil ||
		tunnel.Cfg.WorkspaceAccount != "" || serverIdentity(tunnel.Cfg) != serverIdentity(cfg) {
		return ""
	}
	return serverIdentity(cfg)
}

func manualPreviewConnectionContext(transport *Tunnel) context.Context {
	transport.mu.Lock()
	defer transport.mu.Unlock()
	return transport.connectionContext
}

type manualPreviewInspect struct {
	Name   string
	Config struct{ Labels map[string]string }
	Mounts []struct {
		Type, Source, Destination string
		RW                        bool
	}
	HostConfig struct {
		PortBindings map[string][]struct{ HostIP, HostPort string }
	}
}

func recoverManualPreviewsLockedContext(ctx context.Context) error {
	serverConnectionMu.RLock()
	scope, transport := manualPreviewScopeLocked(), tunnel
	serverConnectionMu.RUnlock()
	if scope == "" {
		return nil
	}
	mappings := make(map[string]*Mapping)
	ids := make(map[string]bool)
	for _, mapping := range store.mappings() {
		if mapping.ServerID != scope {
			continue
		}
		mappings[mapping.ServerPath] = mapping
		raw, err := previewDockerOutputContext(ctx, 10*time.Second, transport, "ps", "--all", "--quiet", "--filter", "label=chisa.project="+mapping.ServerPath)
		if err != nil {
			return fmt.Errorf("无法恢复远端预览列表: %w", err)
		}
		for _, id := range strings.Fields(string(raw)) {
			ids[id] = true
		}
	}
	var details []manualPreviewInspect
	if len(ids) != 0 {
		args := []string{"inspect"}
		for id := range ids {
			args = append(args, id)
		}
		raw, err := previewDockerOutputContext(ctx, 10*time.Second, transport, args...)
		if err != nil {
			return fmt.Errorf("无法恢复远端预览列表: %w", err)
		}
		if err := json.Unmarshal(raw, &details); err != nil {
			return fmt.Errorf("远端预览列表无效")
		}
	}
	serverConnectionMu.RLock()
	defer serverConnectionMu.RUnlock()
	if transport != tunnel || manualPreviewScopeLocked() != scope || ctx.Err() != nil {
		return fmt.Errorf("预览 SSH 连接已改变")
	}
	previews.Lock()
	defer previews.Unlock()
	seen := make(map[string]bool)
	for _, detail := range details {
		id := strings.TrimPrefix(detail.Name, "/")
		labels := detail.Config.Labels
		mapping := mappings[labels["chisa.project"]]
		if !manualPreviewID.MatchString(id) || mapping == nil ||
			(labels["chisa.preview.scope"] != "" && labels["chisa.preview.scope"] != scope) {
			continue
		}
		// Recheck the mapping after SSH returns; path equality alone cannot
		// adopt a container into a newly selected project or connection.
		currentMapping := store.findMappingByServer(mapping.ServerPath)
		if currentMapping == nil || currentMapping.ServerID != scope || currentMapping.BindingEpoch != mapping.BindingEpoch {
			continue
		}
		mounted := false
		for _, mount := range detail.Mounts {
			if mount.Type == "bind" && mount.Destination == "/workspace" && mount.RW && path.Clean(mount.Source) == path.Clean(mapping.ServerPath) {
				mounted = true
			}
		}
		if !mounted {
			continue
		}
		item := previews.items[id]
		if item.ID != "" && (item.Managed || (item.ServerID != "" && item.ServerID != scope) || item.ServerPath != mapping.ServerPath) {
			return fmt.Errorf("预览标识属于其他连接")
		}
		seen[id] = true
		item.ID, item.ServerPath, item.ServerID, item.Epoch = id, mapping.ServerPath, scope, mapping.BindingEpoch
		item.RemoteEpoch, item.RemoteHost, item.RemotePort = labels["chisa.preview.epoch"], "", 0
		containerPort, err := strconv.Atoi(labels["chisa.preview.port"])
		if err == nil && containerPort >= 1024 && containerPort <= 65535 {
			bindings := detail.HostConfig.PortBindings[strconv.Itoa(containerPort)+"/tcp"]
			if len(bindings) == 1 && bindings[0].HostIP == "127.0.0.1" {
				if port, err := strconv.Atoi(bindings[0].HostPort); err == nil && port >= 1024 && port <= 65535 {
					item.RemoteHost, item.RemotePort = "127.0.0.1", port
				}
			}
		}
		previews.items[id] = item
	}
	for id, item := range previews.items {
		if !item.Managed && item.ServerID == scope && !seen[id] {
			if item.Forward != nil && item.Forward.Process != nil {
				_ = item.Forward.Process.Kill()
			}
			delete(previews.items, id)
		}
	}
	return nil
}

func restoreManualPreviewForward(ctx context.Context, item Preview, mapping *Mapping) error {
	if item.RemoteEpoch == "" || item.RemoteEpoch != mapping.BindingEpoch {
		return fmt.Errorf("预览来自旧绑定；请停止后重新启动")
	}
	if item.RemoteHost != "127.0.0.1" || item.RemotePort < 1024 || item.RemotePort > 65535 {
		return fmt.Errorf("预览连接信息已失效；请停止后重新启动")
	}
	serverConnectionMu.RLock()
	scope, transport := manualPreviewScopeLocked(), tunnel
	serverConnectionMu.RUnlock()
	if item.Managed || item.ServerID == "" || item.ServerID != scope || ctx.Err() != nil {
		return fmt.Errorf("预览 SSH 连接已改变")
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return fmt.Errorf("无法分配预览端口")
	}
	port := listener.Addr().(*net.TCPAddr).Port
	_ = listener.Close()
	forward := hideCommandWindow(exec.Command(sshExe(), append([]string{"-N", "-L", fmt.Sprintf("127.0.0.1:%d:127.0.0.1:%d", port, item.RemotePort)}, transport.baseArgs()...)...))
	if err := forward.Start(); err != nil {
		return fmt.Errorf("预览 SSH 通道启动失败")
	}
	serverConnectionMu.RLock()
	previews.Lock()
	current, exists := previews.items[item.ID]
	if !exists || transport != tunnel || manualPreviewScopeLocked() != item.ServerID || current.ServerID != item.ServerID || current.Epoch != item.Epoch || ctx.Err() != nil {
		previews.Unlock()
		serverConnectionMu.RUnlock()
		_ = forward.Process.Kill()
		_ = forward.Wait()
		return fmt.Errorf("预览 SSH 连接已改变")
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
	watchPreviewForward(item.ID, forward, manualPreviewConnectionContext(transport))
	return nil
}

func removeManualPreviewContext(ctx context.Context, item Preview) error {
	serverConnectionMu.RLock()
	scope, transport := manualPreviewScopeLocked(), tunnel
	serverConnectionMu.RUnlock()
	if item.Managed || item.ServerID == "" || item.ServerID != scope {
		return fmt.Errorf("预览属于其他 SSH 连接")
	}
	if _, err := previewDockerOutputContext(ctx, 15*time.Second, transport, "rm", "--force", item.ID); err != nil {
		return fmt.Errorf("预览停止失败: %w", err)
	}
	forgetPreview(item)
	return nil
}
