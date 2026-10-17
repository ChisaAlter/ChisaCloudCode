//go:build windows

package main

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func isolateSyncRecovery(t *testing.T) *Mapping {
	t.Helper()
	m := isolatePi(t)
	m.SyncName = "recovery-session"
	previousTunnel, previousPause := tunnel, pauseProjectSync
	// Only admission readiness is simulated; each test supplies the lease/daemon observations.
	tunnel = newTunnel(store.config(), store.keyPathOf(), func() {})
	tunnel.proc, tunnel.bridgeReady, tunnel.bridgePort = &exec.Cmd{}, true, 1
	pauseProjectSync = func(context.Context, *Mapping) error { return nil }
	t.Cleanup(func() {
		tunnel, pauseProjectSync = previousTunnel, previousPause
		pendingSyncReleases.Delete(m.ServerPath)
		syncStopUnconfirmed.Delete(m.ServerPath)
		syncStates.Delete(m.ServerPath)
	})
	return m
}

func TestVPSOnlyProjectWithoutSSHCanSend(t *testing.T) {
	m := isolatePi(t)
	store.Cfg.WorkspaceServerURL = ""
	remote := "/srv/workspaces/qa/vps-only"
	info := (FrontendBridge{}).GetProjectSync(remote)
	if info.Status != "unbound" || info.LocalPath != "" || info.ServerPath != remote || info.Sequence == 0 {
		t.Fatalf("VPS-only project was incorrectly gated on local synchronization: %+v", info)
	}
	if bound := (FrontendBridge{}).GetProjectSync(m.ServerPath); bound.Status != "disconnected" {
		t.Fatalf("bound project lost its disconnected synchronization barrier: %+v", bound)
	}
}

func TestSyncReleaseSurvivesClientRestart(t *testing.T) {
	m := isolateSyncRecovery(t)
	var events, claimed []string
	pauseProjectSync = func(_ context.Context, actual *Mapping) error {
		if actual.SyncName != m.SyncName || actual.ServerPath != m.ServerPath || actual.BindingEpoch != m.BindingEpoch {
			t.Fatal("paused a different synchronization session")
		}
		events = append(events, "pause")
		return nil
	}
	var lease map[string]any
	failRelease := true
	remoteLeaseContext = func(_ context.Context, actual *Mapping, op, owner, id string) (map[string]any, error) {
		if actual.ServerPath != m.ServerPath || actual.BindingEpoch != m.BindingEpoch {
			t.Fatal("lease operation changed its project binding")
		}
		events = append(events, op+":"+id)
		switch op {
		case "read":
			return map[string]any{"ok": true, "lease": lease}, nil
		case "recover":
			record, err := loadSyncRelease(m)
			if err != nil || record == nil || record.ID != id || record.SyncName != m.SyncName {
				t.Fatal("remote claim preceded durable ownership record")
			}
			claimed = append(claimed, id)
			lease = map[string]any{"owner": "sync", "id": id, "epoch": m.BindingEpoch}
		case "release":
			if owner != "sync" || lease["id"] != id || lease["epoch"] != m.BindingEpoch || lease["owner"] != owner {
				t.Fatal("attempted an unowned release")
			}
			if failRelease {
				return nil, errors.New("SSH release reply lost")
			}
			lease = nil
		}
		return map[string]any{"ok": true}, nil
	}
	synchronizeProjectContext = func(context.Context, *Mapping, bool) error {
		return errors.New("stop before unrelated project registration")
	}
	if result := (FrontendBridge{}).SyncProject(m.ServerPath); result["code"] != "WORKSPACE_RELEASE_FAILED" {
		t.Fatalf("release failure was hidden: %v", result)
	}
	pendingSyncReleases.Delete(m.ServerPath)
	record, err := loadSyncRelease(m)
	if len(claimed) != 1 || err != nil || record == nil || record.ID != claimed[0] {
		t.Fatal("restart lost the exact old lease")
	}
	failRelease, events = false, nil
	(FrontendBridge{}).SyncProject(m.ServerPath)
	want := []string{"read:", "pause", "read:", "release:" + claimed[0]}
	if len(events) < len(want) || !reflect.DeepEqual(events[:len(want)], want) || len(claimed) != 2 {
		t.Fatalf("restart did not confirm, pause and release its old lease before a new claim: %v", events)
	}
	if record, err := loadSyncRelease(m); err != nil || record != nil || lease != nil {
		t.Fatalf("confirmed release retained ownership: %+v %v lease=%v", record, err, lease)
	}
}

func TestSyncReleaseRecordFailureDoesNotClaim(t *testing.T) {
	m := isolateSyncRecovery(t)
	blocker := filepath.Join(t.TempDir(), "not-a-directory")
	if err := os.WriteFile(blocker, []byte("preserve"), 0600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("APPDATA", blocker)
	claims := 0
	remoteLeaseContext = func(context.Context, *Mapping, string, string, string) (map[string]any, error) {
		claims++
		return map[string]any{"ok": true}, nil
	}
	result := (FrontendBridge{}).SyncProject(m.ServerPath)
	if result["ok"] != false || claims != 0 {
		t.Fatalf("unrecorded remote ownership was allowed: %v calls=%d", result, claims)
	}
}

func TestSyncRecoveryDoesNotReleaseForeignOrMissingLease(t *testing.T) {
	for name, lease := range map[string]any{
		"missing":         nil,
		"different-id":    map[string]any{"owner": "sync", "id": "other-task", "epoch": "epoch"},
		"different-owner": map[string]any{"owner": "claude", "id": "our-old-lease", "epoch": "epoch"},
		"different-epoch": map[string]any{"owner": "sync", "id": "our-old-lease", "epoch": "other-binding"},
	} {
		t.Run(name, func(t *testing.T) {
			m := isolateSyncRecovery(t)
			if err := saveSyncRelease(m, "our-old-lease"); err != nil {
				t.Fatal(err)
			}
			pendingSyncReleases.Store(m.ServerPath, pendingSyncRelease{id: "our-old-lease", epoch: m.BindingEpoch})
			releases, claims := 0, 0
			remoteLeaseContext = func(_ context.Context, _ *Mapping, op, _, id string) (map[string]any, error) {
				switch op {
				case "read":
					return map[string]any{"ok": true, "lease": lease}, nil
				case "release":
					releases++
				case "recover":
					claims++
					record, err := loadSyncRelease(m)
					if err != nil || record == nil || record.ID == "our-old-lease" || record.ID != id {
						t.Fatal("stale ownership was retained for a new claim")
					}
					if _, exists := pendingSyncReleases.Load(m.ServerPath); exists {
						t.Fatal("stale in-memory ownership was retained")
					}
				}
				return nil, errors.New("Workspace is reserved by another task")
			}
			result := (FrontendBridge{}).SyncProject(m.ServerPath)
			if result["ok"] != false || releases != 0 || claims != 1 || !strings.Contains(result["error"].(string), "reserved by another task") {
				t.Fatalf("foreign reservation was released or recovery barrier was ignored: %v releases=%d claims=%d", result, releases, claims)
			}
		})
	}
}

func TestSyncRecoveryUnconfirmedReadKeepsJournal(t *testing.T) {
	cases := []struct {
		name  string
		state map[string]any
		err   error
	}{
		{"read-failed", nil, errors.New("SSH read reply lost")},
		{"lease-absent", map[string]any{"ok": true}, nil},
		{"lease-malformed", map[string]any{"ok": true, "lease": "invalid"}, nil},
		{"id-absent", map[string]any{"ok": true, "lease": map[string]any{"owner": "sync", "epoch": "epoch"}}, nil},
		{"owner-absent", map[string]any{"ok": true, "lease": map[string]any{"id": "our-old-lease", "epoch": "epoch"}}, nil},
		{"epoch-invalid", map[string]any{"ok": true, "lease": map[string]any{"id": "our-old-lease", "owner": "sync", "epoch": 7}}, nil},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			m := isolateSyncRecovery(t)
			if err := saveSyncRelease(m, "our-old-lease"); err != nil {
				t.Fatal(err)
			}
			pauses, changes := 0, 0
			pauseProjectSync = func(context.Context, *Mapping) error { pauses++; return nil }
			remoteLeaseContext = func(_ context.Context, _ *Mapping, op, _, _ string) (map[string]any, error) {
				if op != "read" {
					changes++
				}
				return test.state, test.err
			}
			result := (FrontendBridge{}).SyncProject(m.ServerPath)
			record, err := loadSyncRelease(m)
			if result["ok"] != false || record == nil || record.ID != "our-old-lease" || err != nil || pauses != 0 || changes != 0 {
				t.Fatalf("unconfirmed identity discarded ownership or changed a task: %v record=%+v error=%v pauses=%d changes=%d", result, record, err, pauses, changes)
			}
		})
	}
}

func TestSyncReleaseCleanupUnconfirmedReadKeepsJournal(t *testing.T) {
	m := isolateSyncRecovery(t)
	var claimed string
	releases := 0
	remoteLeaseContext = func(_ context.Context, _ *Mapping, op, _, id string) (map[string]any, error) {
		switch op {
		case "recover":
			claimed = id
			return map[string]any{"ok": true}, nil
		case "read":
			return nil, errors.New("cleanup identity reply lost")
		case "release":
			releases++
		}
		return map[string]any{"ok": true}, nil
	}
	synchronizeProjectContext = func(context.Context, *Mapping, bool) error { return errors.New("stop after claim") }
	result := (FrontendBridge{}).SyncProject(m.ServerPath)
	record, err := loadSyncRelease(m)
	if result["code"] != "WORKSPACE_RELEASE_FAILED" || releases != 0 || claimed == "" || record == nil || record.ID != claimed || err != nil {
		t.Fatalf("cleanup released without confirming its identity: result=%v record=%+v error=%v releases=%d", result, record, err, releases)
	}
}

func TestSyncGitSelectedDirectoryDoesNotUseParentRepository(t *testing.T) {
	isolatePi(t)
	parent := t.TempDir()
	selected := filepath.Join(parent, "selected files")
	if err := os.Mkdir(selected, 0700); err != nil {
		t.Fatal(err)
	}
	for file, content := range map[string]string{"parent-only.txt": "parent repository private canary\n", "selected files/proof.txt": "selected files\n"} {
		if err := os.WriteFile(filepath.Join(parent, file), []byte(content), 0600); err != nil {
			t.Fatal(err)
		}
	}
	for _, args := range [][]string{{"init", "-b", "main"}, {"add", "parent-only.txt", "selected files/proof.txt"}, {"-c", "user.name=QA", "-c", "user.email=qa@localhost", "commit", "-m", "Owned parent fixture"}} {
		if _, err := gitOutput(parent, args...); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(parent, "parent-only.txt"), []byte("staged parent change\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := gitOutput(parent, "add", "parent-only.txt"); err != nil {
		t.Fatal(err)
	}
	indexFile := filepath.Join(parent, ".git", "index")
	before, err := os.ReadFile(indexFile)
	if err != nil {
		t.Fatal(err)
	}
	if repository, err := localGitRepository(context.Background(), selected); err != nil || repository {
		t.Fatalf("selected subdirectory claimed the parent Git repository: %t %v", repository, err)
	}
	if err := syncGitContext(context.Background(), &Mapping{LocalPath: selected}); err != nil {
		t.Fatal("selected files attempted parent Git synchronization:", err)
	}
	after, err := os.ReadFile(indexFile)
	if err != nil || !reflect.DeepEqual(before, after) {
		t.Fatal("selected-directory sync modified the parent index")
	}
	for _, local := range []string{parent, strings.ToUpper(parent)} {
		if repository, err := localGitRepository(context.Background(), local); err != nil || !repository {
			t.Fatalf("actual Windows Git root was rejected: %t %v", repository, err)
		}
	}
	junction := filepath.Join(t.TempDir(), "root junction")
	if output, err := exec.Command("cmd", "/c", "mklink", "/J", junction, parent).CombinedOutput(); err != nil {
		t.Fatalf("owned junction fixture could not be created: %v %s", err, output)
	}
	if repository, err := localGitRepository(context.Background(), junction); err != nil || !repository {
		t.Fatalf("junction pointing to the exact Git root was rejected: %t %v", repository, err)
	}
}
