package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/mutagen-io/mutagen/pkg/filesystem/locking"
)

var mutagenTransportMu sync.Mutex

// Account setup calls this before publishing readiness. Mutagen keeps its SSH
// path in the daemon's environment, so a transport change must restart only this
// application's daemon while preserving its stored sessions and project files.
func prepareMutagenTransport(ctx context.Context, connection *serverConnection) error {
	unlock, err := lockContext(ctx, &mutagenTransportMu)
	if err != nil {
		return err
	}
	defer unlock()
	serverConnectionMu.RLock()
	current := connection != nil && apiConnection == connection && connection.authenticated && connection.ctx.Err() == nil
	serverConnectionMu.RUnlock()
	if !current {
		return fmt.Errorf("文件同步账号或连接已改变")
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	sshPath, err := mutagenSSHPath()
	if err != nil {
		return err
	}
	marker := filepath.Join(dataDir(), "mutagen-ssh-transport")
	previous, err := os.ReadFile(marker)
	if err == nil && norm(strings.TrimSpace(string(previous))) == norm(sshPath) {
		return ctx.Err()
	}
	if err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("无法读取文件同步组件升级状态: %w", err)
	}

	// New native requests and account replacement wait for this transition. Pi
	// and synchronization also retain their admission locks through the restart,
	// including requests that had checked the account immediately beforehand.
	serverConnectionMu.Lock()
	defer serverConnectionMu.Unlock()
	if err := ctx.Err(); err != nil {
		return err
	}
	if connection == nil || apiConnection != connection || !connection.authenticated || connection.ctx.Err() != nil {
		return fmt.Errorf("文件同步账号或连接已改变")
	}
	if piRuntimeActive() || len(activeSyncOperations()) != 0 {
		return fmt.Errorf("请先结束 Pi 或文件同步任务，再更新文件同步组件")
	}
	reserved := false
	cloudReservations.Range(func(_, _ any) bool { reserved = true; return false })
	if reserved {
		return fmt.Errorf("请先结束服务器工作区任务，再更新文件同步组件")
	}
	stopSyncMonitor(false)
	piAgents.Lock()
	defer piAgents.Unlock()
	syncActivities.Lock()
	defer syncActivities.Unlock()
	for _, session := range piAgents.sessions {
		if session.process != nil || session.Running {
			return fmt.Errorf("请先结束 Pi，再更新文件同步组件")
		}
	}
	if len(syncActivities.items) != 0 {
		return fmt.Errorf("请先结束文件同步任务，再更新文件同步组件")
	}
	cloudReservations.Range(func(_, _ any) bool { reserved = true; return false })
	if reserved {
		return fmt.Errorf("请先结束服务器工作区任务，再更新文件同步组件")
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	binary := mutagenExe()
	if binary == "" {
		return fmt.Errorf("Mutagen 未随应用分发")
	}
	daemonDirectory := filepath.Join(dataDir(), "mutagen", "daemon")
	if err := os.MkdirAll(daemonDirectory, 0700); err != nil {
		return fmt.Errorf("无法准备文件同步组件目录: %w", err)
	}
	locker, err := locking.NewLocker(filepath.Join(daemonDirectory, "daemon.lock"), 0600)
	if err != nil {
		return fmt.Errorf("无法检查文件同步组件进程: %w", err)
	}
	defer locker.Close()

	// The daemon holds this OS lock for its lifetime. A leftover directory,
	// lock file, or socket does not mean that a daemon needs to be stopped.
	if err := locker.Lock(false); err != nil {
		if !mutagenDaemonLockBusy(err) {
			return fmt.Errorf("无法检查文件同步组件进程: %w", err)
		}
		bounded, cancel := context.WithTimeout(ctx, 15*time.Second)
		defer cancel()
		if _, err := runMutagenContext(bounded, "daemon", "stop"); err != nil {
			return fmt.Errorf("更新文件同步组件失败（stop）: %w", err)
		}
		// Stop acknowledges shutdown before the old daemon releases its lock.
		// Do not let the readiness query reconnect to that old SSH environment.
		ticker := time.NewTicker(50 * time.Millisecond)
		defer ticker.Stop()
		for {
			if err := bounded.Err(); err != nil {
				return fmt.Errorf("等待旧文件同步组件退出失败: %w", err)
			}
			if err := locker.Lock(false); err == nil {
				break
			} else if !mutagenDaemonLockBusy(err) {
				return fmt.Errorf("无法检查文件同步组件进程: %w", err)
			}
			select {
			case <-bounded.Done():
				return fmt.Errorf("等待旧文件同步组件退出失败: %w", bounded.Err())
			case <-ticker.C:
			}
		}
	}
	if err := locker.Unlock(); err != nil {
		return fmt.Errorf("无法释放文件同步组件进程锁: %w", err)
	}
	// Unlike daemon start, this returns only after the daemon serves requests.
	bounded, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	if _, err := runMutagenContext(bounded, "sync", "list"); err != nil {
		return fmt.Errorf("启动文件同步组件失败: %w", err)
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	if connection.ctx.Err() != nil {
		return fmt.Errorf("文件同步账号或连接已改变")
	}
	if err := os.WriteFile(marker+".tmp", []byte(sshPath+"\n"), 0600); err != nil {
		return fmt.Errorf("无法保存文件同步组件升级状态: %w", err)
	}
	if err := os.Rename(marker+".tmp", marker); err != nil {
		return fmt.Errorf("无法保存文件同步组件升级状态: %w", err)
	}
	return nil
}

func mutagenDaemonLockBusy(err error) bool {
	if runtime.GOOS == "windows" {
		return errors.Is(err, syscall.Errno(33)) // ERROR_LOCK_VIOLATION
	}
	return errors.Is(err, syscall.EAGAIN) || errors.Is(err, syscall.EACCES)
}
