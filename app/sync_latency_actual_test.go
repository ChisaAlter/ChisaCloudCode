//go:build windows

package main

import (
	"os"
	"testing"
	"time"
)

// Opt-in end-to-end check: runs the shipping manual synchronization path (the
// same one the client's "Sync now" action uses) against the real server.
//
//	CHISA_SYNC_CHECK=1 CHISA_SYNC_PROJECT=C:\path\to\project go test . -run TestManualSyncLatency -v
//
// It performs a normal, idempotent synchronization: no task lease is taken and
// no project content is deleted.
func TestManualSyncLatency(t *testing.T) {
	if os.Getenv("CHISA_SYNC_CHECK") != "1" {
		t.Skip("set CHISA_SYNC_CHECK=1 to run a real manual synchronization")
	}
	store = loadStore(dataDir())
	cfg := store.config()
	tunnel = newTunnel(cfg, cfg.KeyPath, func() {})
	defer func() {
		if tunnel != nil {
			tunnel.stop()
		}
	}()
	if err := initializeServerConnection(); err != nil {
		t.Fatalf("server connection: %v", err)
	}
	// The desktop frontend normally performs this authentication through its
	// login request; the manual sync path only needs the resulting session state.
	if apiConnection != nil {
		apiConnection.authenticated = true
		apiConnection.accessToken = cfg.Token
		apiConnection.accountIdentity = cfg.WorkspaceAccount
	}
	if err := tunnel.start(); err != nil {
		t.Fatalf("tunnel: %v", err)
	}
	local := os.Getenv("CHISA_SYNC_PROJECT")
	var target *Mapping
	for _, candidate := range store.mappings() {
		if local == "" || candidate.LocalPath == local {
			target = candidate
			break
		}
	}
	if target == nil {
		t.Fatalf("no mapping for %q", local)
	}
	started := time.Now()
	result := syncProject(target.ServerPath)
	elapsed := time.Since(started)
	if result["ok"] != true {
		t.Fatalf("manual synchronization failed: %v", result)
	}
	t.Logf("manual sync %s -> %s took %s", target.LocalPath, target.ServerPath, elapsed)
	if elapsed > 60*time.Second {
		t.Fatalf("a manual synchronization still blocks for %s", elapsed)
	}
}
