package main

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

type syncMonitorProcess struct {
	cancel context.CancelFunc
	done   chan struct{}
}

var syncMonitor = struct {
	sync.Mutex
	process   *syncMonitorProcess
	closed    bool
	sessions  []syncSession
	failure   error
	checkedAt string
	sequence  uint64
	views     map[string]SyncInfo
}{views: make(map[string]SyncInfo)}

func ensureSyncMonitor() {
	syncMonitor.Lock()
	if syncMonitor.closed || syncMonitor.process != nil {
		process, failed := syncMonitor.process, syncMonitor.failure != nil
		syncMonitor.Unlock()
		if process != nil && failed {
			<-process.done
			ensureSyncMonitor()
		}
		return
	}
	ctx, cancel := context.WithCancel(context.Background())
	process := &syncMonitorProcess{cancel: cancel, done: make(chan struct{})}
	syncMonitor.process = process
	syncMonitor.sessions, syncMonitor.failure, syncMonitor.checkedAt = nil, nil, ""
	syncMonitor.Unlock()
	publishAllProjectSync()
	go runSyncMonitor(ctx, process)
}

func runSyncMonitor(ctx context.Context, process *syncMonitorProcess) {
	defer func() {
		syncMonitor.Lock()
		if syncMonitor.process == process {
			syncMonitor.process = nil
		}
		syncMonitor.Unlock()
		close(process.done)
	}()
	binary := mutagenExe()
	if binary == "" {
		failSyncMonitor(process, fmt.Errorf("同步引擎未随应用分发"))
		return
	}
	sshPath, err := mutagenSSHPath()
	if err != nil {
		failSyncMonitor(process, err)
		return
	}
	cmd := hideCommandWindow(exec.CommandContext(ctx, binary, "sync", "monitor", "--template", "CHISA_SYNC_JSON:{{json .}}"))
	cmd.Env = append(os.Environ(), "MUTAGEN_DATA_DIRECTORY="+filepath.Join(dataDir(), "mutagen"), "MUTAGEN_SSH_PATH="+sshPath, "MUTAGEN_DISABLE_AUTOSTART=1")
	cmd.WaitDelay = time.Second
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		failSyncMonitor(process, fmt.Errorf("同步状态监视器无法读取"))
		return
	}
	if err = cmd.Start(); err != nil {
		failSyncMonitor(process, fmt.Errorf("同步状态监视器无法启动"))
		return
	}
	if err = readSyncMonitor(process, stdout); err != nil {
		failSyncMonitor(process, err)
	}
	process.cancel()
	_ = cmd.Wait()
}

func readSyncMonitor(process *syncMonitorProcess, output io.Reader) error {
	reader := bufio.NewReader(output)
	for {
		// A full daemon snapshot can exceed Scanner's 64 KiB token limit.
		line, readErr := reader.ReadBytes('\n')
		if len(line) > 0 {
			frame := strings.TrimSpace(string(line))
			var sessions []syncSession
			if !strings.HasPrefix(frame, "CHISA_SYNC_JSON:") || json.Unmarshal([]byte(strings.TrimPrefix(frame, "CHISA_SYNC_JSON:")), &sessions) != nil || sessions == nil {
				return fmt.Errorf("同步状态监视器返回无效数据")
			}
			syncMonitor.Lock()
			current := syncMonitor.process == process && !syncMonitor.closed
			if current {
				syncMonitor.sessions, syncMonitor.failure = sessions, nil
				syncMonitor.checkedAt = time.Now().UTC().Format(time.RFC3339Nano)
			}
			syncMonitor.Unlock()
			if current {
				publishAllProjectSync()
			}
		}
		if readErr != nil {
			message := "同步状态监视器已断开，请刷新状态重新连接"
			if readErr != io.EOF {
				message = "同步状态监视器读取失败，请刷新状态重新连接"
			}
			return fmt.Errorf("%s", message)
		}
	}
}

func failSyncMonitor(process *syncMonitorProcess, err error) {
	syncMonitor.Lock()
	current := syncMonitor.process == process && !syncMonitor.closed
	if current {
		syncMonitor.sessions, syncMonitor.failure = nil, err
		syncMonitor.checkedAt = time.Now().UTC().Format(time.RFC3339Nano)
	}
	syncMonitor.Unlock()
	if current {
		publishAllProjectSync()
	}
}

func stopSyncMonitor(closing bool) {
	syncMonitor.Lock()
	process := syncMonitor.process
	syncMonitor.process, syncMonitor.sessions = nil, nil
	syncMonitor.failure = fmt.Errorf("同步状态监视器未连接")
	syncMonitor.closed = closing
	syncMonitor.Unlock()
	if process != nil {
		process.cancel()
		<-process.done
	}
	if !closing {
		publishAllProjectSync()
	}
}

func sameSyncView(a, b SyncInfo) bool {
	a.CheckedAt, b.CheckedAt = "", ""
	a.Sequence, b.Sequence = 0, 0
	// Checking a daemon cycle is one neutral state, not multiple UI updates.
	if a.Status == "checking" && b.Status == "checking" {
		a.EngineStatus, b.EngineStatus = "", ""
	}
	return a == b
}

func observedProjectSync(serverPath string, override ...SyncInfo) SyncInfo {
	syncMonitor.Lock()
	defer syncMonitor.Unlock()
	owner := syncWorkspaceOwner(serverPath)
	store.mu.Lock()
	defer store.mu.Unlock()
	var m *Mapping
	for _, mapping := range store.Mappings {
		if mapping.ServerPath == serverPath {
			m = mapping
			break
		}
	}
	info := SyncInfo{Status: "unbound", Detail: "项目尚未绑定本地目录", ServerPath: serverPath}
	if m != nil {
		info = projectSyncInfo(m, store.Cfg, syncMonitor.sessions, syncMonitor.failure, syncMonitor.checkedAt, owner)
	}
	// Connection snapshots use the same sequence as engine observations, so a
	// disconnect or recovery response can supersede an earlier ready event.
	if len(override) > 0 && m != nil {
		info.Status, info.Detail = override[0].Status, override[0].Detail
		info.GitRecoveryRequired = false
	}
	previous, exists := syncMonitor.views[serverPath]
	if !exists || !sameSyncView(previous, info) {
		syncMonitor.sequence++
		info.Sequence = syncMonitor.sequence
		syncMonitor.views[serverPath] = info
		if m != nil || exists {
			_ = workspaceSyncStateChanged.Broadcast(info)
		}
		return info
	}
	info.Sequence = previous.Sequence
	syncMonitor.views[serverPath] = info
	return info
}

func publishProjectSync(m *Mapping) {
	if store != nil {
		observedProjectSync(m.ServerPath)
	}
}

func publishAllProjectSync() {
	if store == nil {
		return
	}
	paths := make(map[string]bool)
	for _, m := range store.mappings() {
		paths[m.ServerPath] = true
	}
	syncMonitor.Lock()
	for path := range syncMonitor.views {
		paths[path] = true
	}
	syncMonitor.Unlock()
	for path := range paths {
		observedProjectSync(path)
	}
}
