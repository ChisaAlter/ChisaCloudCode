package main

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
)

// Mutagen invokes these helpers as ssh.exe and scp.exe. Each forwards only to
// its corresponding Windows OpenSSH tool with this application's configuration.
func main() {
	tool := strings.ToLower(filepath.Base(os.Args[0]))
	if tool != "ssh.exe" && tool != "scp.exe" {
		fmt.Fprintln(os.Stderr, "invalid synchronization transport executable")
		os.Exit(1)
	}
	configDirectory, err := os.UserConfigDir()
	if err != nil {
		fail(err)
	}
	config := filepath.Join(configDirectory, "ChisaCloudCode", "sync-ssh.conf")
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
	if err := command.Run(); err != nil {
		var exitError *exec.ExitError
		if errors.As(err, &exitError) {
			os.Exit(exitError.ExitCode())
		}
		fail(err)
	}
}

func fail(err error) {
	fmt.Fprintln(os.Stderr, "synchronization SSH transport:", err)
	os.Exit(1)
}
