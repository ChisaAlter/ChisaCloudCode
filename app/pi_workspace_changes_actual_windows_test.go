//go:build vpsqa

package main

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// This engine check is local/local. Its private APPDATA creates a separate
// daemon and no configured user project, SSH key, VPS or installed app is used.
func TestPiWorkspaceLocalEngineResume(t *testing.T) {
	m, fakeSession := piWorkspaceFixture(t)
	remote := t.TempDir()
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	if mutagenExe() == "" {
		t.Fatal("the explicit local-engine check requires bundled Mutagen beside the test executable")
	}
	t.Cleanup(func() {
		cleanup, stop := context.WithTimeout(context.Background(), 10*time.Second)
		defer stop()
		if _, err := runMutagenContext(cleanup, "daemon", "stop"); err != nil {
			t.Errorf("private engine daemon did not stop: %v", err)
		}
	})
	piWorkspaceWrite(t, m.LocalPath, "source.txt", "private engine baseline")
	if _, err := runMutagenContext(ctx, "sync", "create", "--name", m.SyncName, "--mode", "two-way-safe", "--no-global-configuration", "--ignore-vcs", "--ignore", "node_modules", m.LocalPath, remote); err != nil {
		t.Fatal(err)
	}
	if _, err := runMutagenContext(ctx, "sync", "flush", m.SyncName); err != nil {
		t.Fatal(err)
	}
	if _, err := runMutagenContext(ctx, "sync", "pause", m.SyncName); err != nil {
		t.Fatal(err)
	}
	sessions, err := listSyncSessionsContext(ctx)
	if err != nil || len(sessions) != 1 || !sessions[0].Paused {
		t.Fatalf("real isolated session was not paused: %+v %v", sessions, err)
	}
	fakeSession.Identifier = sessions[0].Identifier
	snapshot := piWorkspaceCapture(t, m)
	piWorkspaceExpectChanged(t, snapshot, m, false)
	remoteLeaseContext = func(_ context.Context, _ *Mapping, operation, owner, id string) (map[string]any, error) {
		if operation != "confirm" || owner != "pi" || id != "private-engine-lease" {
			t.Fatalf("resume changed the private lease contract: %s/%s/%s", operation, owner, id)
		}
		return map[string]any{"ok": true, "lease": map[string]any{"id": id, "owner": owner, "epoch": m.BindingEpoch}}, nil
	}
	if err := resumePiWorkspace(ctx, m, "private-engine-lease"); err != nil {
		t.Fatal(err)
	}
	sessions, err = listSyncSessionsContext(ctx)
	if err != nil || len(sessions) != 1 || sessions[0].Paused || sessions[0].Identifier != fakeSession.Identifier {
		t.Fatalf("resume-only handback did not resume the same real engine session: %+v %v", sessions, err)
	}
	if content, err := os.ReadFile(filepath.Join(remote, "source.txt")); err != nil || string(content) != "private engine baseline" {
		t.Fatalf("existing synchronized contents changed: %q %v", content, err)
	}
	t.Log("real private local/local Mutagen session: prepared+paused, unchanged metadata, exact-session resume-only; no handback flush or Git synchronization")
}
