package main

import (
	"context"
	"fmt"
	"net/http"
	"testing"
	"time"
)

func preserveDesktopSshManager(t *testing.T, manager *sshTunnelManager) {
	t.Helper()
	desktopSshMu.Lock()
	previous, closed := desktopSshManager, desktopSshClosed
	desktopSshManager, desktopSshClosed = manager, false
	desktopSshMu.Unlock()
	t.Cleanup(func() {
		manager.stopAll(true)
		desktopSshMu.Lock()
		desktopSshManager, desktopSshClosed = previous, closed
		desktopSshMu.Unlock()
	})
}

func TestSshNativeAccountLogoutStopsOwnedTunnelAndPreservesCloudContract(t *testing.T) {
	connection := accountWorkspaceFixture(t, func(http.ResponseWriter, *http.Request) {})
	manager, runtime := sshTestManager(t)
	preserveDesktopSshManager(t, manager)
	scope, err := currentSshAccount()
	if err != nil {
		t.Fatal(err)
	}
	profile, err := manager.save(scope, sshTestProfile(t))
	if err != nil {
		t.Fatal(err)
	}
	bridge := FrontendBridge{}
	if response := bridge.StartSshTunnel(profile.ID); response["ok"] != true {
		t.Fatal(response)
	}
	started := <-runtime.starts
	bridge.EndServerSession(connection.version + 1)
	if connection.ctx.Err() != nil {
		t.Fatal("stale logout canceled authenticated account")
	}
	select {
	case <-started.process.killed:
		t.Fatal("stale logout stopped current SSH tunnel")
	default:
	}
	bridge.EndServerSession(connection.version)
	select {
	case <-started.process.killed:
	case <-time.After(time.Second):
		t.Fatal("logout did not stop owned SSH process")
	}
	waitSshState(t, manager, scope, profile.ID, "stopped")
	if apiConnection == connection || apiConnection.authenticated || connection.ctx.Err() != context.Canceled {
		t.Fatal("logout changed existing cloud authentication contract")
	}
	if response := bridge.GetSshTunnelProfiles(); response["ok"] != false || response["code"] != "SSH_ACCOUNT_REQUIRED" {
		t.Fatal("signed-out native call exposed account profile", response)
	}
	if response := bridge.SelectLocalFolder(); response["ok"] != false || response["code"] != cloudOnlyCode {
		t.Fatal("new feature reactivated legacy RPC", response)
	}
}

func TestSshAccountIdentityRefreshWithoutReplacementRevokesTunnel(t *testing.T) {
	connection := accountWorkspaceFixture(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		// A self-hosted auth response may have no instancePath. Its verified user
		// identity still must revoke a prior account's tunnel on the same transport.
		fmt.Fprint(w, `{"user":{"id":99,"username":"different-account"}}`)
	})
	manager, runtime := sshTestManager(t)
	preserveDesktopSshManager(t, manager)
	scope, err := currentSshAccount()
	if err != nil {
		t.Fatal(err)
	}
	profile, _ := manager.save(scope, sshTestProfile(t))
	if _, err := manager.start(scope, profile.ID); err != nil {
		t.Fatal(err)
	}
	started := <-runtime.starts
	bridge := FrontendBridge{}
	response := bridge.ServerRequest(bridge.BeginServerRequest(), "GET", "/api/auth/user", map[string]string{"Authorization": "Bearer test-token"}, "")
	if response.Status != 200 || apiConnection != connection {
		t.Fatal("fixture did not exercise same-transport identity refresh", response)
	}
	select {
	case <-started.process.killed:
	case <-time.After(time.Second):
		t.Fatal("new native identity retained former account SSH tunnel")
	}
	waitSshState(t, manager, scope, profile.ID, "stopped")
	if scope.ctx.Err() != context.Canceled {
		t.Fatal("same-transport identity refresh did not revoke queued SSH scope")
	}
	if _, err := manager.start(scope, profile.ID); err == nil {
		t.Fatal("stale native account scope restarted a former account tunnel")
	}
	profiles := bridge.GetSshTunnelProfiles()
	if profiles["ok"] != true || len(profiles["profiles"].([]SshTunnelProfile)) != 0 {
		t.Fatal("new identity saw former account profile", profiles)
	}
}

func TestSshWindowCloseDoesNotAcquireCloudAccountLockOrStartAfterClose(t *testing.T) {
	connection := accountWorkspaceFixture(t, func(http.ResponseWriter, *http.Request) {})
	manager, runtime := sshTestManager(t)
	preserveDesktopSshManager(t, manager)
	scope, err := currentSshAccount()
	if err != nil {
		t.Fatal(err)
	}
	profile, _ := manager.save(scope, sshTestProfile(t))
	if _, err := manager.start(scope, profile.ID); err != nil {
		t.Fatal(err)
	}
	started := <-runtime.starts
	serverConnectionMu.Lock()
	closed := make(chan struct{})
	go func() { stopDesktopSshTunnels(true); close(closed) }()
	select {
	case <-closed:
	case <-time.After(time.Second):
		serverConnectionMu.Unlock()
		t.Fatal("SSH window close waited for cloud account lock")
	}
	serverConnectionMu.Unlock()
	<-started.process.killed
	waitSshState(t, manager, scope, profile.ID, "stopped")
	if connection.ctx.Err() != nil {
		t.Fatal("optional SSH close canceled native cloud account")
	}
	if response := (FrontendBridge{}).StartSshTunnel(profile.ID); response["ok"] != false || response["code"] != "SSH_DESKTOP_CLOSED" {
		t.Fatal("closed desktop accepted queued SSH start", response)
	}
}
