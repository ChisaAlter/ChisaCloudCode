package main

import (
	"os"
	"path/filepath"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/svc"
	"golang.org/x/sys/windows/svc/mgr"
)

// Read-only prerequisite inspection. It never installs, starts or reconfigures
// OpenSSH, creates accounts or changes Windows Firewall rules.
func nativeSshPreflight() SshPreflight {
	result := SshPreflight{Platform: "win32", Issues: []SshPreflightIssue{}}
	root, rootErr := windows.GetWindowsDirectory()
	if rootErr != nil || root == "" {
		result.Issues = append(result.Issues, SshPreflightIssue{"SSH_CLIENT_MISSING", "无法定位系统 Windows OpenSSH 安装目录。"})
		return result
	}
	result.sshExecutable = filepath.Join(root, "System32", "OpenSSH", "ssh.exe")
	result.SSHAvailable = sshRegularExecutable(result.sshExecutable)
	result.SSHDAvailable = sshRegularExecutable(filepath.Join(root, "System32", "OpenSSH", "sshd.exe"))
	managerHandle, err := windows.OpenSCManager(nil, nil, windows.SC_MANAGER_CONNECT)
	if err == nil {
		defer windows.CloseServiceHandle(managerHandle)
		serviceName, _ := windows.UTF16PtrFromString("sshd")
		serviceHandle, serviceErr := windows.OpenService(managerHandle, serviceName, windows.SERVICE_QUERY_STATUS)
		if serviceErr == nil {
			service := &mgr.Service{Name: "sshd", Handle: serviceHandle}
			defer service.Close()
			result.SSHDServiceInstalled = true
			status, statusErr := service.Query()
			result.SSHDServiceRunning = statusErr == nil && status.State == svc.Running
		}
	}
	if !result.SSHAvailable {
		result.Issues = append(result.Issues, SshPreflightIssue{"SSH_CLIENT_MISSING", "未找到系统 Windows OpenSSH 客户端。"})
	}
	if !result.SSHDAvailable || !result.SSHDServiceInstalled {
		result.Issues = append(result.Issues, SshPreflightIssue{"SSH_SERVER_MISSING", "尚未安装 Windows OpenSSH Server；应用不会自动安装服务。"})
	} else if !result.SSHDServiceRunning {
		result.Issues = append(result.Issues, SshPreflightIssue{"SSH_SERVER_STOPPED", "Windows OpenSSH Server 未运行；请由管理员检查服务。"})
	}
	result.OK = len(result.Issues) == 0
	return result
}

func sshRegularExecutable(path string) bool {
	stats, err := os.Stat(path)
	return err == nil && stats.Mode().IsRegular()
}
