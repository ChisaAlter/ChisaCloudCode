package main

import (
	"bytes"
	"crypto/sha256"
	_ "embed"
	"encoding/hex"
	"os"
	"path/filepath"
)

//go:embed resources/ssh-workspace.ps1
var sshWorkspaceHelper []byte

// InstallSshWorkspaceHelper is an explicit user action, independent of tunnel
// start and cloud login. It writes no key, account, firewall or service state.
func (FrontendBridge) InstallSshWorkspaceHelper() map[string]any {
	scope, err := currentSshAccount()
	if err != nil {
		return sshErrorResponse(err)
	}
	path, digest, err := installSshWorkspaceHelper(dataDir(), sshWorkspaceHelper)
	if err != nil {
		return sshErrorResponse(err)
	}
	if scope.ctx.Err() != nil {
		return sshErrorResponse(sshFailure("SSH_ACCOUNT_CHANGED", "账号连接已改变；辅助脚本已写入本机，请重新打开 SSH 设置。"))
	}
	return map[string]any{"ok": true, "path": path, "sha256": digest, "accessNotice": "脚本位于当前桌面账户的应用数据目录。专用 Windows SSH 账户必须实际验证可读取此路径；应用未修改 ACL。请由管理员授予必要的读取/执行权限并保护脚本及其父目录。相同账户下不提供脚本与构建代码之间的权限隔离。"}
}

func installSshWorkspaceHelper(directory string, payload []byte) (string, string, error) {
	if len(payload) == 0 || len(payload) > 2*1024*1024 {
		return "", "", sshFailure("SSH_HELPER_PAYLOAD_INVALID", "安装包中的 SSH 辅助脚本无效。")
	}
	absoluteDirectory, err := filepath.Abs(directory)
	if err != nil {
		return "", "", sshFailure("SSH_HELPER_PATH_UNSAFE", "无法解析本机应用数据目录。")
	}
	directory = absoluteDirectory
	sum := sha256.Sum256(payload)
	digest := hex.EncodeToString(sum[:])
	root := filepath.Join(directory, "ssh-workspace-helper", digest)
	path := filepath.Join(root, "ssh-workspace.ps1")
	// Inspect existing ancestors before creating anything so a saved application
	// data junction cannot silently redirect installation into another tree.
	for current := root; ; current = filepath.Dir(current) {
		stats, err := os.Lstat(current)
		if err == nil && (!stats.IsDir() || stats.Mode()&os.ModeSymlink != 0) {
			return "", "", sshFailure("SSH_HELPER_PATH_UNSAFE", "辅助脚本目录不是正常目录，请检查本机应用数据路径。")
		}
		if err != nil && !os.IsNotExist(err) {
			return "", "", sshFailure("SSH_HELPER_PATH_UNSAFE", "无法检查辅助脚本目录。")
		}
		if current == filepath.Dir(current) {
			break
		}
	}
	if err := os.MkdirAll(root, 0700); err != nil {
		return "", "", sshFailure("SSH_HELPER_INSTALL_FAILED", "无法创建辅助脚本目录。")
	}
	// Refuse link/redirection paths and changed existing payloads. Repeated
	// installation is idempotent; it never overwrites an unexpectedly edited file.
	for current := root; ; current = filepath.Dir(current) {
		stats, err := os.Lstat(current)
		if err != nil || !stats.IsDir() || stats.Mode()&os.ModeSymlink != 0 {
			return "", "", sshFailure("SSH_HELPER_PATH_UNSAFE", "辅助脚本目录不是正常目录，请检查本机应用数据路径。")
		}
		if current == filepath.Clean(directory) || current == filepath.Dir(current) {
			break
		}
	}
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if os.IsExist(err) {
		stats, statErr := os.Lstat(path)
		if statErr != nil || !stats.Mode().IsRegular() || stats.Size() != int64(len(payload)) {
			return "", "", sshFailure("SSH_HELPER_CONTENT_CHANGED", "已安装的辅助脚本发生变化，应用不会覆盖该文件。")
		}
		existing, readErr := os.ReadFile(path)
		if readErr != nil || !bytes.Equal(existing, payload) {
			return "", "", sshFailure("SSH_HELPER_CONTENT_CHANGED", "已安装的辅助脚本发生变化，应用不会覆盖该文件。")
		}
		return path, digest, nil
	}
	if err != nil {
		return "", "", sshFailure("SSH_HELPER_INSTALL_FAILED", "无法写入辅助脚本。")
	}
	_, err = file.Write(payload)
	if err == nil {
		err = file.Sync()
	}
	closeErr := file.Close()
	if err == nil {
		err = closeErr
	}
	if err != nil {
		return "", "", sshFailure("SSH_HELPER_INSTALL_FAILED", "辅助脚本写入未完成，请检查本机应用数据目录。")
	}
	return path, digest, nil
}
