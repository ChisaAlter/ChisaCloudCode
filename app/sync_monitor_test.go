package main

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"testing"
)

func isolateSyncObserver(t *testing.T) (*Mapping, syncSession, *syncMonitorProcess) {
	t.Helper()
	previousStore := store
	cfg := Config{ServerURL: "http://sync.test:8791", SSHHost: "sync.test", SSHUser: "root"}
	m := &Mapping{LocalPath: t.TempDir(), ServerPath: "/srv/sync-observer-unit-" + randHex(8), SyncName: "unit-observer", BindingEpoch: "current", ServerID: serverIdentity(cfg), Mode: "vps"}
	store = &Store{Cfg: cfg, Mappings: []*Mapping{m}}
	_, cancel := context.WithCancel(context.Background())
	process := &syncMonitorProcess{cancel: cancel, done: make(chan struct{})}
	syncMonitor.Lock()
	previousProcess, previousClosed, previousSessions, previousFailure, previousChecked, previousViews := syncMonitor.process, syncMonitor.closed, syncMonitor.sessions, syncMonitor.failure, syncMonitor.checkedAt, syncMonitor.views
	syncMonitor.process, syncMonitor.closed, syncMonitor.failure = process, false, nil
	syncMonitor.sessions, syncMonitor.views = nil, make(map[string]SyncInfo)
	syncMonitor.Unlock()
	t.Cleanup(func() {
		cancel()
		syncMonitor.Lock()
		syncMonitor.process, syncMonitor.closed, syncMonitor.sessions, syncMonitor.failure, syncMonitor.checkedAt, syncMonitor.views = previousProcess, previousClosed, previousSessions, previousFailure, previousChecked, previousViews
		syncMonitor.Unlock()
		store = previousStore
		syncStates.Delete(m.ServerPath)
		syncActivities.Lock()
		delete(syncActivities.items, m.ServerPath)
		syncActivities.Unlock()
	})
	return m, syncSession{
		Name: m.SyncName, Status: "watching", SuccessfulCycles: 1,
		Alpha: syncEndpoint{Path: m.LocalPath, Connected: true, Scanned: true},
		Beta:  syncEndpoint{Protocol: "ssh", Host: syncSSHAlias(cfg), Path: m.ServerPath, Connected: true, Scanned: true},
	}, process
}

func TestSyncMonitorVersionsAndOperations(t *testing.T) {
	m, session, _ := isolateSyncObserver(t)
	syncMonitor.Lock()
	syncMonitor.sessions = []syncSession{session}
	syncMonitor.checkedAt = "2026-10-06T04:00:00Z"
	syncMonitor.Unlock()
	first := observedProjectSync(m.ServerPath)
	if first.Status != "ready" || first.Sequence == 0 || first.BindingEpoch != m.BindingEpoch {
		t.Fatal(first)
	}
	syncMonitor.Lock()
	syncMonitor.sessions[0].SuccessfulCycles++
	syncMonitor.checkedAt = "2026-10-06T05:00:00Z"
	syncMonitor.Unlock()
	duplicate := observedProjectSync(m.ServerPath)
	if duplicate.Sequence != first.Sequence || duplicate.CheckedAt == first.CheckedAt {
		t.Fatal("a same-state cycle changed the view version, or lost its sampling time")
	}
	outer := beginSyncOperation(m, "migrating")
	inner := beginSyncOperation(m, "syncing")
	setSyncInfo(m, "ready", "")
	inner()
	if len(activeSyncOperations()) != 1 || observedProjectSync(m.ServerPath).Status != "syncing" {
		t.Fatal("flush completion ended the still-active outer Git/registration operation")
	}
	outer()
	if len(activeSyncOperations()) != 0 || observedProjectSync(m.ServerPath).Status != "ready" {
		t.Fatal("completed outer operation did not release its busy state")
	}
	store.mu.Lock()
	store.Mappings[0].BindingEpoch = "replacement"
	store.mu.Unlock()
	replacement := observedProjectSync(m.ServerPath)
	if replacement.BindingEpoch != "replacement" || replacement.Sequence <= duplicate.Sequence {
		t.Fatal("replacement binding did not advance the global observation sequence")
	}
	publishProjectSync(&Mapping{ServerPath: m.ServerPath, BindingEpoch: "current"})
	if latest := observedProjectSync(m.ServerPath); latest.BindingEpoch != "replacement" || latest.Sequence != replacement.Sequence {
		t.Fatal("late old-binding publication replaced the current view")
	}
	secondPath := "/srv/sync-observer-second-" + randHex(8)
	if other := observedProjectSync(secondPath); other.Sequence <= replacement.Sequence {
		t.Fatal("observation sequence is not global across project paths")
	}
}

func TestSyncMonitorFrameAndFailure(t *testing.T) {
	m, session, process := isolateSyncObserver(t)
	padding := syncSession{Name: strings.Repeat("x", 80*1024)}
	encoded, err := json.Marshal([]syncSession{session, padding})
	if err != nil {
		t.Fatal(err)
	}
	readErr := readSyncMonitor(process, strings.NewReader("CHISA_SYNC_JSON:"+string(encoded)+"\n"))
	ready := observedProjectSync(m.ServerPath)
	if readErr == nil || ready.Status != "ready" {
		t.Fatal("large complete frame was truncated, or stream EOF was accepted as live")
	}
	failSyncMonitor(process, readErr)
	failed := observedProjectSync(m.ServerPath)
	if failed.Status != "unavailable" || failed.Sequence <= ready.Sequence {
		t.Fatal("stream EOF retained the last green state")
	}
	syncMonitor.Lock()
	if syncMonitor.process != process || syncMonitor.failure == nil {
		syncMonitor.Unlock()
		t.Fatal("failure implicitly started another observer")
	}
	syncMonitor.Unlock()
	readErr = readSyncMonitor(process, strings.NewReader("CHISA_SYNC_JSON:[]\n"))
	if readErr == nil || observedProjectSync(m.ServerPath).Status != "needs-sync" {
		t.Fatal("empty daemon snapshot did not remove the missing session")
	}
	readErr = readSyncMonitor(process, strings.NewReader("CHISA_SYNC_JSON:{broken}\n"))
	failSyncMonitor(process, readErr)
	if observedProjectSync(m.ServerPath).Status != "unavailable" {
		t.Fatal("invalid daemon frame retained a usable state")
	}
	syncMonitor.Lock()
	old := syncMonitor.process
	syncMonitor.process = &syncMonitorProcess{}
	syncMonitor.failure = nil
	syncMonitor.sessions = []syncSession{session}
	syncMonitor.Unlock()
	recovered := observedProjectSync(m.ServerPath)
	failSyncMonitor(old, fmt.Errorf("late failure from replaced observer"))
	if latest := observedProjectSync(m.ServerPath); latest.Status != "ready" || latest.Sequence != recovered.Sequence {
		t.Fatal("old observer generation invalidated its replacement")
	}
}
