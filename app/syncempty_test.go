package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func TestRootEmptyDirectionIncludesSymbolicLinks(t *testing.T) {
	var session syncSession
	if err := json.Unmarshal([]byte(`{"status":"halted-on-root-emptied","alpha":{"connected":true,"scanned":true,"directories":1,"symbolicLinks":1},"beta":{"connected":true,"scanned":true,"directories":1}}`), &session); err != nil {
		t.Fatal(err)
	}
	if info := syncSessionInfo(session); info.EmptySide != "vps" {
		t.Fatalf("wrong deletion direction: %+v", info)
	}
}

func TestConfirmedEmptyPlanPreservesExcludedAndRuntimeEntries(t *testing.T) {
	session := syncSession{}
	session.Ignore.Paths = []string{"node_modules", ".env", ".env.*", "!.env.example", "build", "!/build", "/build/*", "!/build/tracked.txt"}
	session.Ignore.VCS = true
	entries := []syncEmptyEntry{
		{Path: ".git", Directory: true, Mode: 0040755}, {Path: ".git/config", Mode: 0100644},
		{Path: ".env", Mode: 0100600}, {Path: ".env.example", Mode: 0100644},
		{Path: "build", Directory: true, Mode: 0040755}, {Path: "build/generated.bin", Mode: 0100644}, {Path: "build/tracked.txt", Mode: 0100644},
		{Path: "src", Directory: true, Mode: 0040755}, {Path: "src/main.go", Mode: 0100644},
		{Path: "src/node_modules", Directory: true, Mode: 0040755}, {Path: "src/node_modules/a.js", Mode: 0100644},
		{Path: "runtime.sock", Mode: 0140755}, {Path: "runtime.pipe", Mode: 0010644}, {Path: "link", Mode: 0120777},
	}
	selected, err := syncEmptyPlan(entries, session)
	if err != nil {
		t.Fatal(err)
	}
	names := []string{}
	for _, entry := range selected {
		names = append(names, entry.Path)
	}
	want := []string{".env.example", "build", "build/tracked.txt", "src", "src/main.go", "link"}
	if !reflect.DeepEqual(names, want) {
		t.Fatalf("selected=%v want=%v", names, want)
	}
}

func TestNewLocalContentInvalidatesEmptyConfirmation(t *testing.T) {
	m := &Mapping{LocalPath: t.TempDir()}
	session := syncSession{}
	session.Ignore.Paths = []string{".git"}
	if err := os.Mkdir(filepath.Join(m.LocalPath, ".git"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := localSyncRootEmpty(m, session); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(m.LocalPath, "new.txt"), []byte("keep"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := localSyncRootEmpty(m, session); err == nil {
		t.Fatal("new local content did not cancel destructive confirmation")
	}
}

func TestPausedEmptyFailureRetainsExactConfirmation(t *testing.T) {
	previous := store
	cfg := Config{ServerURL: "http://sync.test:8791", SSHHost: "sync.test", SSHUser: "root"}
	m := &Mapping{LocalPath: t.TempDir(), ServerPath: "/srv/empty-pending-unit", SyncName: "empty-pending", BindingEpoch: "current", ServerID: serverIdentity(cfg), Mode: "vps"}
	store = &Store{Cfg: cfg, Mappings: []*Mapping{m}}
	t.Cleanup(func() {
		store = previous
		pendingEmptyConfirmations.Delete(m.ServerPath)
		syncStates.Delete(m.ServerPath)
	})
	session := syncSession{Identifier: "exact", Name: m.SyncName, Paused: true, Status: "disconnected", Alpha: syncEndpoint{Path: m.LocalPath}, Beta: syncEndpoint{Protocol: "ssh", Host: syncSSHAlias(cfg), Path: m.ServerPath}}
	pendingEmptyConfirmations.Store(m.ServerPath, pendingEmptyConfirmation{epoch: m.BindingEpoch, session: session})
	syncStates.Store(m.ServerPath, SyncInfo{Status: "blocked", BindingEpoch: m.BindingEpoch, Detail: "remote list failed"})
	info := projectSyncInfo(m, cfg, []syncSession{session}, nil, "now", "")
	if info.EmptySide != "local" || info.Status != "blocked" || info.EngineStatus != "disconnected" {
		t.Fatalf("retry consent lost or native state falsified: %+v", info)
	}
	if err := os.WriteFile(filepath.Join(m.LocalPath, "restored.txt"), []byte("keep"), 0600); err != nil {
		t.Fatal(err)
	}
	if info := projectSyncInfo(m, cfg, []syncSession{session}, nil, "now", ""); info.EmptySide != "" {
		t.Fatal("restored local files stayed trapped in clear confirmation")
	}
	if _, found := pendingEmptyConfirmations.Load(m.ServerPath); found {
		t.Fatal("restoring local content did not revoke pending clear")
	}
	pendingEmptyConfirmations.Store(m.ServerPath, pendingEmptyConfirmation{epoch: m.BindingEpoch, session: session})
	session.Identifier = "replacement"
	if _, valid := pendingProjectEmpty(m, session); valid {
		t.Fatal("confirmation crossed session replacement")
	}
}
