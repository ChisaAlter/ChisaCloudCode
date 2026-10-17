//go:build !windows

package main

import (
	"errors"
	"os"
	"os/exec"
	"sync"
)

type piProcessGuard struct {
	mu      sync.Mutex
	process *os.Process
}

func preparePiProcess(cmd *exec.Cmd) { hideCommandWindow(cmd) }
func attachPiProcess(cmd *exec.Cmd) (*piProcessGuard, error) {
	return &piProcessGuard{process: cmd.Process}, nil
}
func (g *piProcessGuard) close() error {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.process == nil {
		return nil
	}
	err := g.process.Kill()
	if err == nil || errors.Is(err, os.ErrProcessDone) {
		g.process = nil
		return nil
	}
	return err
}
