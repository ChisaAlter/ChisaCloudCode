//go:build !windows

package main

import "os/exec"

func hideCommandWindow(cmd *exec.Cmd) *exec.Cmd { return cmd }
