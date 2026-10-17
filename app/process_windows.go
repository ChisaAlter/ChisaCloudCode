package main

import (
	"os/exec"
	"syscall"
)

// Background tools must not create console windows in the desktop client.
func hideCommandWindow(cmd *exec.Cmd) *exec.Cmd {
	if cmd.SysProcAttr == nil {
		cmd.SysProcAttr = &syscall.SysProcAttr{}
	}
	cmd.SysProcAttr.HideWindow = true
	cmd.SysProcAttr.CreationFlags |= 0x08000000 // CREATE_NO_WINDOW
	return cmd
}
