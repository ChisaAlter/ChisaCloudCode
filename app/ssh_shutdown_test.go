package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"sync"
	"testing"
	"time"
)

func TestSshDesktopShutdownPreservesLateServerCleanupThenWaitsSupervisor(t *testing.T) {
	preserveFrontendRequestLifecycle(t)
	started, cleanup := make(chan struct{}), make(chan error, 1)
	var agent *localWorkspaceAgent
	root := t.TempDir()
	connection := accountWorkspaceFixture(t, func(w http.ResponseWriter, r *http.Request) {
		close(started)
		<-r.Context().Done()
		// The server's independent cleanup begins after the cancelled frontend
		// HTTP call has already settled. It still needs the existing Agent.
		timer := time.NewTimer(40 * time.Millisecond)
		defer timer.Stop()
		<-timer.C
		payload, _ := json.Marshal(map[string]any{"protocol": 1, "rootPath": root, "expectedRootIdentity": "shutdown-root", "generation": "shutdown-generation", "request": map[string]any{"op": "operation_cancel", "operationId": "99999999-9999-4999-8999-999999999999"}})
		request, _ := http.NewRequest(http.MethodPost, fmt.Sprintf("http://127.0.0.1:%d/v1/workspace", agent.port), bytes.NewReader(payload))
		request.Header.Set("X-Chisa-Agent-Token", agent.token)
		response, err := http.DefaultClient.Do(request)
		if err == nil {
			raw, _ := io.ReadAll(response.Body)
			response.Body.Close()
			if response.StatusCode != 200 || !bytes.Contains(raw, []byte(`"cleanupConfirmed":true`)) {
				err = errors.New("late native cleanup was not confirmed")
			}
		}
		cleanup <- err
	})
	manager, runtime := sshTestManager(t)
	preserveDesktopSshManager(t, manager)
	agents := testAgentDependencies(t, manager)
	manager.deps.registerAgent = func(context.Context, sshAccountScope, SshTunnelProfile, string) error { return nil }
	scope := mustSshScope(t)
	profile := testAgentProfile(t, manager, scope)
	_, err := manager.start(scope, profile.ID)
	if err != nil {
		t.Fatal(err)
	}
	agent = <-agents
	start := <-runtime.starts
	acknowledgeAgent(t, start)
	waitRegistration(t, manager, scope, profile.ID, "registered")
	bridge := FrontendBridge{}
	frontendDone := make(chan BridgeResponse, 1)
	go func() {
		frontendDone <- bridge.ServerRequest(bridge.BeginServerRequest(), http.MethodGet, "/api/wait-before-close", nil, "")
	}()
	<-started
	// The UI callback must not wait for the account lock or cancel its shared
	// native account connection before cleanup can use it.
	serverConnectionMu.Lock()
	callbackDone := make(chan struct{})
	go func() { beginDesktopShutdown(); close(callbackDone) }()
	select {
	case <-callbackDone:
	case <-time.After(time.Second):
		serverConnectionMu.Unlock()
		t.Fatal("window callback blocked on account lock")
	}
	serverConnectionMu.Unlock()
	if connection.ctx.Err() != nil || agent.ctx.Err() != nil {
		t.Fatal("window callback cancelled native recovery transport")
	}
	if response := bridge.StartSshTunnel(profile.ID); response["code"] != "SSH_DESKTOP_CLOSED" {
		t.Fatal("closed window admitted restart", response)
	}
	select {
	case response := <-frontendDone:
		if response.Status != 499 {
			t.Fatal(response)
		}
	case <-time.After(time.Second):
		t.Fatal("frontend cancellation did not settle")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if err := drainDesktopSshShutdown(ctx, 150*time.Millisecond); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-cleanup:
		if err != nil {
			t.Fatal(err)
		}
	default:
		t.Fatal("supervisor stopped before late server cleanup")
	}
	select {
	case <-agent.closed:
	default:
		t.Fatal("shutdown returned before Agent.Close completed")
	}
	status, _ := manager.getStatus(scope, profile.ID)
	if status.State != "stopped" {
		t.Fatal(status)
	}
	if connection.ctx.Err() != nil {
		t.Fatal("drain cancelled account before caller's account shutdown stage")
	}
}

type shutdownHeldProcess struct {
	killed  chan struct{}
	release chan struct{}
	once    sync.Once
}

func (p *shutdownHeldProcess) Wait() error { <-p.release; return errors.New("stopped") }
func (p *shutdownHeldProcess) Kill() error { p.once.Do(func() { close(p.killed) }); return nil }
func TestSshShutdownStopAndWaitHonorsActualSupervisorDoneAndDeadline(t *testing.T) {
	manager, _ := sshTestManager(t)
	scope := sshTestScope(t, "shutdown")
	profile, err := manager.save(scope, sshTestProfile(t))
	if err != nil {
		t.Fatal(err)
	}
	process := &shutdownHeldProcess{killed: make(chan struct{}), release: make(chan struct{})}
	spawned := make(chan struct{})
	manager.deps.start = func(context.Context, string, []string, io.Writer) (sshOwnedProcess, error) {
		close(spawned)
		return process, nil
	}
	_, err = manager.start(scope, profile.ID)
	if err != nil {
		t.Fatal(err)
	}
	<-spawned
	entries := manager.closeAdmission()
	ctx, cancel := context.WithTimeout(context.Background(), 25*time.Millisecond)
	defer cancel()
	err = manager.stopAndWait(ctx, entries)
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatal("hung supervisor shutdown was not bounded", err)
	}
	select {
	case <-process.killed:
	default:
		t.Fatal("deadline path did not cancel owned process")
	}
	status, _ := manager.getStatus(scope, profile.ID)
	if status.State != "stopping" {
		t.Fatal("timeout published false terminal cleanup", status)
	}
	if _, err := manager.start(scope, profile.ID); err == nil {
		t.Fatal("shutdown admission fence permitted replacement")
	}
	close(process.release)
	ctx2, cancel2 := context.WithTimeout(context.Background(), time.Second)
	defer cancel2()
	if err := manager.stopAndWait(ctx2, entries); err != nil {
		t.Fatal(err)
	}
	select {
	case <-entries[0].done:
	default:
		t.Fatal("shutdown returned before exact generation finished")
	}
}
