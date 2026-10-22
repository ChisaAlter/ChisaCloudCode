package main

import (
	"encoding/json"
	"fmt"
	"sync"
	"testing"
)

func TestSyncStatusLiveGate(t *testing.T) {
	ready := syncSession{
		Status: "watching", SuccessfulCycles: 1,
		Alpha: syncEndpoint{Connected: true, Scanned: true},
		Beta:  syncEndpoint{Connected: true, Scanned: true},
	}
	for _, tc := range []struct {
		name   string
		change func(*syncSession)
		want   string
	}{
		{"watching", func(*syncSession) {}, "ready"},
		{"scanning", func(s *syncSession) { s.Status = "scanning" }, "checking"},
		{"reconciling", func(s *syncSession) { s.Status = "reconciling" }, "checking"},
		{"empty staging", func(s *syncSession) { s.Status = "staging-beta" }, "checking"},
		{"transferring", func(s *syncSession) {
			s.Status = "staging-beta"
			s.Beta.StagingProgress = &struct {
				ExpectedFiles uint64 `json:"expectedFiles"`
			}{ExpectedFiles: 1}
		}, "syncing"},
		{"applying changes", func(s *syncSession) { s.Status = "transitioning" }, "syncing"},
		{"paused endpoint state omitted", func(s *syncSession) {
			s.Paused, s.SuccessfulCycles = true, 0
			s.Alpha, s.Beta = syncEndpoint{}, syncEndpoint{}
		}, "paused"},
		{"local disconnected", func(s *syncSession) { s.Alpha.Connected = false }, "disconnected"},
		{"vps disconnected", func(s *syncSession) { s.Beta.Connected = false }, "disconnected"},
		{"initial scan incomplete", func(s *syncSession) { s.Beta.Scanned = false }, "checking"},
		{"no completed transfer", func(s *syncSession) { s.SuccessfulCycles = 0 }, "checking"},
		{"engine error", func(s *syncSession) { s.LastError = "permission denied" }, "blocked"},
		{"conflict", func(s *syncSession) { s.Conflicts = []json.RawMessage{json.RawMessage(`{}`)} }, "blocked"},
		{"excluded conflict", func(s *syncSession) { s.ExcludedConflicts = 1 }, "blocked"},
		{"local scan error", func(s *syncSession) {
			s.Alpha.ScanProblems = []syncProblem{{Path: "source.txt", Error: "access denied"}}
		}, "blocked"},
		{"vps write error", func(s *syncSession) {
			s.Beta.TransitionProblems = []syncProblem{{Path: "source.txt", Error: "permission denied"}}
		}, "blocked"},
		{"excluded vps scan error", func(s *syncSession) { s.Beta.ExcludedScanProblems = 1 }, "blocked"},
		{"excluded local write error", func(s *syncSession) { s.Alpha.ExcludedTransitionProblems = 1 }, "blocked"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			session := ready
			tc.change(&session)
			info := syncSessionInfo(session)
			if info.Status != tc.want || info.EngineStatus != session.Status {
				t.Fatalf("status = %+v; want %s", info, tc.want)
			}
			if tc.want != "ready" && info.Detail == "" {
				t.Fatal("non-ready status lost its explanation")
			}
		})
	}
}

func TestSyncProblemDetails(t *testing.T) {
	for _, tc := range []struct {
		name, snapshot, want string
	}{
		{"local scan", `{"alpha":{"scanProblems":[{"path":"资料/计划.md","error":"unable to open file: access denied"}]}}`, "本地扫描失败（资料/计划.md）: unable to open file: access denied"},
		{"local write", `{"alpha":{"transitionProblems":[{"path":".nodetmp/node/bin/npm","error":"unable to create symbolic link: required privilege is not held"}]}}`, "本地写入失败（.nodetmp/node/bin/npm）: unable to create symbolic link: required privilege is not held"},
		{"VPS scan", `{"beta":{"scanProblems":[{"path":"runtime/npm","error":"invalid symbolic link: target is absolute"}]}}`, "VPS扫描失败（runtime/npm）: invalid symbolic link: target is absolute"},
		{"VPS write", `{"beta":{"transitionProblems":[{"path":"src/main.ts","error":"unable to create file: permission denied"}]}}`, "VPS写入失败（src/main.ts）: unable to create file: permission denied"},
		{"root path", `{"alpha":{"scanProblems":[{"path":"","error":"unable to read directory contents: access denied"}]}}`, "本地扫描失败（项目根目录）: unable to read directory contents: access denied"},
		{"count all phases and truncated entries", `{"alpha":{"scanProblems":[{"path":"a","error":"first"}],"excludedScanProblems":2,"transitionProblems":[{"path":"b","error":"second"}],"excludedTransitionProblems":3},"beta":{"scanProblems":[{"path":"c","error":"third"}],"excludedScanProblems":4,"transitionProblems":[{"path":"d","error":"fourth"},{"path":"e","error":"fifth"}],"excludedTransitionProblems":5}}`, "本地扫描失败（a）: first（另有 18 条同步错误）"},
		{"truncated entries without details remain blocked", `{"beta":{"excludedScanProblems":2}}`, "VPS扫描失败（共 2 条同步错误）"},
		{"prefer an actual problem", `{"alpha":{"excludedScanProblems":2},"beta":{"transitionProblems":[{"path":"file.txt","error":"permission denied"}],"excludedTransitionProblems":3}}`, "VPS写入失败（file.txt）: permission denied（另有 5 条同步错误）"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			session := syncSession{
				Status: "watching", SuccessfulCycles: 1,
				Alpha: syncEndpoint{Connected: true, Scanned: true},
				Beta:  syncEndpoint{Connected: true, Scanned: true},
			}
			if err := json.Unmarshal([]byte(tc.snapshot), &session); err != nil {
				t.Fatal(err)
			}
			info := syncSessionInfo(session)
			if info.Status != "blocked" || info.Detail != tc.want {
				t.Fatalf("sync status = %+v; want blocked with %q", info, tc.want)
			}
		})
	}
}

func TestSyncStatusCacheAndBinding(t *testing.T) {
	cfg := Config{ServerURL: "http://sync.test:8791", SSHHost: "sync.test", SSHUser: "root"}
	m := &Mapping{LocalPath: t.TempDir(), ServerPath: "/srv/sync-status-unit-" + randHex(8), SyncName: "unit-sync", BindingEpoch: "current", ServerID: serverIdentity(cfg), Mode: "vps"}
	session := syncSession{
		Name: m.SyncName, Mode: "two-way-safe", Status: "watching", SuccessfulCycles: 1,
		Alpha: syncEndpoint{Path: m.LocalPath, Connected: true, Scanned: true},
		Beta:  syncEndpoint{Protocol: "ssh", Host: syncSSHAlias(cfg), Path: m.ServerPath, Connected: true, Scanned: true},
	}
	session.Ignore.VCS, session.Ignore.Paths = true, []string{syncDynamicGitPolicyMarker}
	checkedAt := "2026-10-06T04:00:00Z"
	t.Cleanup(func() {
		syncStates.Delete(m.ServerPath)
		cloudReservations.Delete(m.ServerPath)
		workspaceLocks.Delete(m.ServerPath)
		syncActivities.Lock()
		delete(syncActivities.items, m.ServerPath)
		syncActivities.Unlock()
	})
	read := func(s syncSession) SyncInfo {
		return projectSyncInfo(m, cfg, []syncSession{s}, nil, checkedAt, syncWorkspaceOwner(m.ServerPath))
	}
	check := func(info SyncInfo, want string) {
		t.Helper()
		if info.Status != want || info.CheckedAt != checkedAt || info.LocalPath != m.LocalPath || info.ServerPath != m.ServerPath {
			t.Fatalf("status = %+v; want %s with current sample and paths", info, want)
		}
	}
	disconnected := session
	disconnected.Beta.Connected = false
	for _, cached := range []string{"ready", "syncing", "migrating", "reserved"} {
		syncStates.Store(m.ServerPath, SyncInfo{Status: cached, BindingEpoch: m.BindingEpoch})
		check(read(disconnected), "disconnected")
	}
	lock := &sync.Mutex{}
	workspaceLocks.Store(m.ServerPath, lock)
	lock.Lock()
	syncStates.Store(m.ServerPath, SyncInfo{Status: "syncing", BindingEpoch: m.BindingEpoch})
	active := read(disconnected)
	lock.Unlock()
	check(active, "disconnected")
	check(read(disconnected), "disconnected")
	syncActivities.Lock()
	syncActivities.items[m.ServerPath] = syncActivity{epoch: m.BindingEpoch, count: 1, phase: "syncing"}
	syncActivities.Unlock()
	check(read(disconnected), "syncing")
	syncActivities.Lock()
	delete(syncActivities.items, m.ServerPath)
	syncActivities.Unlock()

	syncStates.Store(m.ServerPath, SyncInfo{Status: "blocked", Detail: "old failure", BindingEpoch: "old"})
	check(read(session), "ready")
	syncStates.Store(m.ServerPath, SyncInfo{Status: "blocked", Detail: "resolved engine error", BindingEpoch: m.BindingEpoch, engineFailure: true})
	check(read(session), "ready")
	syncStates.Store(m.ServerPath, SyncInfo{Status: "blocked", Detail: "Git history diverged", BindingEpoch: m.BindingEpoch})
	check(read(session), "blocked")
	syncStates.Delete(m.ServerPath)

	wrongEndpoint := session
	wrongEndpoint.Beta.Path += "-other"
	check(read(wrongEndpoint), "unavailable")
	unsafeMode := session
	unsafeMode.Mode = "one-way-replica"
	check(read(unsafeMode), "blocked")
	unsafeGit := session
	unsafeGit.Ignore.VCS = false
	check(read(unsafeGit), "blocked")
	legacyPolicy := session
	legacyPolicy.Ignore.Paths = nil
	check(read(legacyPolicy), "needs-sync")
	wrongServer := cfg
	wrongServer.SSHHost = "other.test"
	check(projectSyncInfo(m, wrongServer, []syncSession{session}, nil, checkedAt, ""), "unavailable")
	check(projectSyncInfo(m, cfg, nil, nil, checkedAt, ""), "checking")
	check(projectSyncInfo(m, cfg, []syncSession{}, nil, checkedAt, ""), "needs-sync")
	check(projectSyncInfo(m, cfg, nil, fmt.Errorf("engine unavailable"), checkedAt, ""), "unavailable")
	for _, owner := range []string{"claude", "pi"} {
		info := projectSyncInfo(m, cfg, nil, fmt.Errorf("engine unavailable"), checkedAt, owner)
		check(info, "unavailable")
		if info.TaskOwner != owner {
			t.Fatalf("observer failure dropped the %s task ownership", owner)
		}
	}
	m.Mode = ""
	check(read(session), "needs-sync")
	m.Mode = "vps"

	paused := session
	paused.Paused = true
	syncStates.Store(m.ServerPath, SyncInfo{Status: "reserved", BindingEpoch: m.BindingEpoch})
	check(read(paused), "paused")
	cloudReservations.Store(m.ServerPath, "run")
	check(read(paused), "reserved")
	cloudReservations.Delete(m.ServerPath)
	piAgents.Lock()
	piAgents.owners[m.ServerPath] = "pi-sync-status-unit"
	piAgents.Unlock()
	info := read(paused)
	piAgents.Lock()
	delete(piAgents.owners, m.ServerPath)
	piAgents.Unlock()
	check(info, "reserved")
	check(read(paused), "paused")
}
