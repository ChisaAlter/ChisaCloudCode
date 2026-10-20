package main

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
)

// Mutagen invokes these helpers as ssh.exe and scp.exe. Each forwards only to
// its corresponding Windows OpenSSH tool with this application's configuration.
func main() {
	tool := strings.ToLower(filepath.Base(os.Args[0]))
	if tool != "ssh.exe" && tool != "scp.exe" {
		fmt.Fprintln(os.Stderr, "invalid synchronization transport executable")
		os.Exit(1)
	}
	config, err := syncSSHConfigPath()
	if err != nil {
		fail(err)
	}
	if _, err := os.Stat(config); err != nil {
		fail(err)
	}
	windows := os.Getenv("WINDIR")
	if windows == "" {
		windows = `C:\Windows`
	}
	command := exec.Command(filepath.Join(windows, "System32", "OpenSSH", tool), append([]string{"-F", config}, os.Args[1:]...)...)
	command.Stdin, command.Stdout, command.Stderr = os.Stdin, os.Stdout, os.Stderr
	command.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x08000000}
	if err := ownTransportChildren(); err != nil {
		fail(err)
	}
	if err := command.Run(); err != nil {
		var exitError *exec.ExitError
		if errors.As(err, &exitError) {
			os.Exit(exitError.ExitCode())
		}
		fail(err)
	}
}

func syncSSHConfigPath() (string, error) {
	// Match the application's dataDir override so SSH reads the profile that
	// prepareSyncSSH wrote, including native QA profiles.
	if dir := os.Getenv("CHISA_DATA_DIR"); dir != "" {
		return filepath.Join(filepath.Clean(dir), "sync-ssh.conf"), nil
	}
	base, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(base, "ChisaCloudCode", "sync-ssh.conf"), nil
}

// Mutagen owns this wrapper process. Put it in a private job before launching
// OpenSSH so its child inherits the same lifetime, including forced wrapper exit.
func ownTransportChildren() error {
	job, err := windows.CreateJobObject(nil, nil)
	if err != nil {
		return fmt.Errorf("create transport job: %w", err)
	}
	limits := windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION{}
	limits.BasicLimitInformation.LimitFlags = windows.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
	if _, err := windows.SetInformationJobObject(job, windows.JobObjectExtendedLimitInformation, uintptr(unsafe.Pointer(&limits)), uint32(unsafe.Sizeof(limits))); err != nil {
		windows.CloseHandle(job)
		return fmt.Errorf("configure transport job: %w", err)
	}
	if err := windows.AssignProcessToJobObject(job, windows.CurrentProcess()); err != nil {
		windows.CloseHandle(job)
		return fmt.Errorf("assign transport job: %w", err)
	}
	// Windows closes the handle on wrapper exit. Closing it here would also
	// terminate this wrapper because it belongs to the job it owns.
	return nil
}

func fail(err error) {
	fmt.Fprintln(os.Stderr, "synchronization SSH transport:", err)
	os.Exit(1)
}
