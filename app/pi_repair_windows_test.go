package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"testing"
)

func savePiRepairState(t *testing.T, s *piSession) {
	t.Helper()
	piAgents.Lock()
	err := piSaveLocked(s)
	piAgents.Unlock()
	if err != nil {
		t.Fatal(err)
	}
}

// A real Windows handle makes only this private session's atomic replacement
// fail. Reads remain allowed, and closing it restores the original filesystem.
func blockPiRepairReplacement(t *testing.T, s *piSession) func() {
	t.Helper()
	path, err := syscall.UTF16PtrFromString(filepath.Join(piSessionDirectory(s.SessionID), "state.json"))
	if err != nil {
		t.Fatal(err)
	}
	handle, err := syscall.CreateFile(path, syscall.GENERIC_READ, syscall.FILE_SHARE_READ|syscall.FILE_SHARE_WRITE, nil, syscall.OPEN_EXISTING, 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	closeHandle := func() {
		if handle != 0 {
			if err := syscall.CloseHandle(handle); err != nil {
				t.Error(err)
			}
			handle = 0
		}
	}
	t.Cleanup(closeHandle)
	return closeHandle
}

func readPiRepairState(t *testing.T, id string) piSession {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join(piSessionDirectory(id), "state.json"))
	if err != nil {
		t.Fatal(err)
	}
	var state piSession
	if err := json.Unmarshal(raw, &state); err != nil {
		t.Fatal(err)
	}
	return state
}

func restartPiRepairState() {
	piAgents.Lock()
	defer piAgents.Unlock()
	piAgents.loaded, piAgents.loadErr = false, nil
	piAgents.sessions, piAgents.owners = map[string]*piSession{}, map[string]string{}
}

func TestPiRepairSnapshotRemainsIndependentDuringHandoffEncoding(t *testing.T) {
	m := isolatePi(t)
	s, writer := seedPi(m, "snapshot-repair")
	t.Cleanup(func() { _ = writer.Close() })
	s.Running = false
	s.LastResult = map[string]any{"status": "completed", "content": "本轮实际答复", "workspaceStatus": "releasing", "workspaceError": "previous failure"}
	view := (FrontendBridge{}).PiGetSession(m.ServerPath, s.SessionID)
	last := view["lastResult"].(map[string]any)
	piHandoffStatus(s, s.runID, "released", nil)
	if last["workspaceStatus"] != "releasing" || last["workspaceError"] != "previous failure" {
		t.Fatal("a returned bridge snapshot changed with the later native handoff")
	}
	var workers sync.WaitGroup
	workers.Add(2)
	go func() {
		defer workers.Done()
		for range 1000 {
			if _, err := json.Marshal(view); err != nil {
				t.Error(err)
				return
			}
		}
	}()
	go func() {
		defer workers.Done()
		for i := range 32 {
			piHandoffStatus(s, s.runID, fmt.Sprintf("handoff-%d", i), errors.New("new failure"))
		}
	}()
	workers.Wait()
	if last["workspaceStatus"] != "releasing" || last["workspaceError"] != "previous failure" {
		t.Fatal("concurrent bridge encoding observed native result mutations")
	}
}

func TestPiRepairRequiresDurableReleasePhaseBeforeRemoteRelease(t *testing.T) {
	m := isolatePi(t)
	s, writer := seedPi(m, "release-phase-save-fails")
	t.Cleanup(func() { _ = writer.Close() })
	s.Running, s.LeaseID = false, "original-exact-lease"
	s.LastResult = map[string]any{"status": "completed", "content": "finished model response"}
	savePiRepairState(t, s)
	var unblock func()
	syncs, releases := 0, 0
	synchronizeProjectContext = func(context.Context, *Mapping, bool) error {
		syncs++
		if syncs == 1 {
			unblock = blockPiRepairReplacement(t, s)
		}
		return nil
	}
	remoteLeaseContext = func(_ context.Context, _ *Mapping, op, owner, id string) (map[string]any, error) {
		if op != "release" || owner != "pi" || id != "original-exact-lease" {
			t.Fatal("handback changed the original Pi reservation")
		}
		releases++
		return map[string]any{"ok": true}, nil
	}
	if err := piReleaseWorkspace(s, s.runID); err == nil {
		t.Fatal("failed durable release checkpoint was reported as success")
	}
	if releases != 0 || s.Owner != "pi" || s.LeaseID == "" || s.HandoffPhase != "" {
		t.Fatal("remote release passed an uncommitted checkpoint or ownership was dropped")
	}
	if durable := readPiRepairState(t, s.SessionID); durable.HandoffPhase != "" || durable.LeaseID != "original-exact-lease" {
		t.Fatal("failed checkpoint changed the last durable reservation")
	}
	unblock()
	view := (FrontendBridge{}).PiRecoverSession(m.ServerPath, s.SessionID)
	if view["ok"] != true || view["owner"] != "claude" || syncs != 2 || releases != 1 {
		t.Fatalf("original lease could not recover after storage became writable: %v syncs=%d releases=%d", view, syncs, releases)
	}
}

func TestPiRepairRestartAfterRemoteReleaseFinishesOnlyOriginalRelease(t *testing.T) {
	for _, scene := range []string{"final-save-fails", "release-response-lost", "replacement-lease"} {
		t.Run(scene, func(t *testing.T) {
			m := isolatePi(t)
			s, writer := seedPi(m, "release-restart")
			s.Running, s.LeaseID = false, "exact-original-lease"
			s.LastResult = map[string]any{"status": "completed", "content": "preserved current answer"}
			savePiRepairState(t, s)
			syncs, releases := 0, 0
			synchronizeProjectContext = func(context.Context, *Mapping, bool) error { syncs++; return nil }
			var unblock func()
			remoteLeaseContext = func(_ context.Context, actual *Mapping, op, owner, id string) (map[string]any, error) {
				if actual.ServerPath != m.ServerPath || actual.BindingEpoch != m.BindingEpoch || op != "release" || owner != "pi" || id != "exact-original-lease" {
					t.Fatalf("recovery operated on a different reservation: %s/%s/%s", op, owner, id)
				}
				releases++
				if durable := readPiRepairState(t, s.SessionID); durable.HandoffPhase != piHandoffReleasePending || durable.LeaseID != id {
					t.Fatal("remote release ran before its recovery phase was durable")
				}
				if releases == 1 {
					if scene == "final-save-fails" {
						unblock = blockPiRepairReplacement(t, s)
						return map[string]any{"ok": true}, nil
					}
					return nil, errors.New("release reply interrupted")
				}
				if scene == "replacement-lease" {
					return nil, errors.New("Workspace reservation changed")
				}
				// lease.py's exact release is idempotent when the old lease is absent.
				return map[string]any{"ok": true}, nil
			}
			if err := piReleaseWorkspace(s, s.runID); err == nil {
				t.Fatal("interrupted local commit/release was reported as a complete handback")
			}
			if s.Owner != "pi" || s.HandoffPhase != piHandoffReleasePending {
				t.Fatal("interruption lost its retryable release checkpoint")
			}
			if unblock != nil {
				unblock()
			}
			_ = writer.Close()
			restartPiRepairState()
			view := (FrontendBridge{}).PiGetSession(m.ServerPath, s.SessionID)
			last := view["lastResult"].(map[string]any)
			if view["owner"] != "pi" || view["runtimeActive"] != false || last["content"] != "preserved current answer" {
				t.Fatalf("restart lost the retained original handback: %v", view)
			}
			view = (FrontendBridge{}).PiRecoverSession(m.ServerPath, s.SessionID)
			if syncs != 1 || releases != 2 {
				t.Fatalf("release recovery repeated synchronization: syncs=%d releases=%d", syncs, releases)
			}
			state := readPiRepairState(t, s.SessionID)
			if scene == "replacement-lease" {
				if view["ok"] != false || view["owner"] != "pi" || state.LeaseID != "exact-original-lease" || state.HandoffPhase != piHandoffReleasePending {
					t.Fatal("replacement reservation was treated as the old lease or dropped the checkpoint")
				}
				return
			}
			if view["ok"] != true || view["owner"] != "claude" || state.LeaseID != "" || state.HandoffPhase != "" || state.LastResult["workspaceStatus"] != "released" || state.LastResult["content"] != "preserved current answer" {
				t.Fatalf("released reservation did not commit atomically after restart: %+v", state)
			}
		})
	}
}

func TestPiRepairStopAllContinuesEveryProjectBeforeHandback(t *testing.T) {
	first := isolatePi(t)
	items := []*piSession{}
	for i, name := range []string{"sync-fails", "release-fails", "finishes"} {
		m := first
		if i != 0 {
			m = &Mapping{LocalPath: t.TempDir(), ServerPath: "/srv/" + name, BindingEpoch: "epoch-" + name, ServerID: first.ServerID, Mode: "vps"}
			store.Mappings = append(store.Mappings, m)
			t.Cleanup(func() { workspaceLocks.Delete(m.ServerPath); syncStates.Delete(m.ServerPath) })
		}
		s, writer := seedPi(m, name)
		t.Cleanup(func() { _ = writer.Close() })
		s.LeaseID = "lease-" + name
		s.Messages = []piMessage{{Role: "assistant", Content: "partial-" + name}}
		s.assistant = 0
		items = append(items, s)
		savePiRepairState(t, s)
	}
	synced, released := map[string]bool{}, map[string]bool{}
	synchronizeProjectContext = func(_ context.Context, m *Mapping, pause bool) error {
		for _, s := range items {
			if s.process != nil || s.Running {
				t.Fatal("network handback started before every selected runtime stopped")
			}
			if durable := readPiRepairState(t, s.SessionID); durable.LastResult["status"] != "aborted" || durable.LastResult["content"] != "partial-"+s.SessionID {
				t.Fatal("network handback started before every stopped result was durable")
			}
		}
		synced[m.ServerPath] = true
		if m.ServerPath == first.ServerPath {
			return errors.New("first project synchronization failed")
		}
		return nil
	}
	remoteLeaseContext = func(_ context.Context, m *Mapping, op, owner, id string) (map[string]any, error) {
		if op != "release" || owner != "pi" || id != "lease-"+strings.TrimPrefix(m.ServerPath, "/srv/") {
			t.Fatal("shutdown changed the exact project reservation")
		}
		released[m.ServerPath] = true
		if strings.HasSuffix(m.ServerPath, "release-fails") {
			return nil, errors.New("second project release failed")
		}
		return map[string]any{"ok": true}, nil
	}
	err := stopAllPi()
	if err == nil || !strings.Contains(err.Error(), "sync-fails") || !strings.Contains(err.Error(), "release-fails") || len(synced) != 3 || len(released) != 2 {
		t.Fatalf("one project skipped another cleanup or hid an error: %v sync=%v release=%v", err, synced, released)
	}
	if items[0].Owner != "pi" || items[1].Owner != "pi" || items[2].Owner != "claude" {
		t.Fatal("failed project cleanup changed another project's handback")
	}
}
