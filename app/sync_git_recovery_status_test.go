package main

import (
	"errors"
	"testing"
)

// A cached Git direction failure exposes recovery only for the exact currently
// observed session. Ownership and active operations must still gate the action.
func TestGitRecoveryStatusEligibility(t *testing.T) {
	for _, name := range []string{
		"eligible-paused", "eligible-watching", "missing-session", "duplicate-session",
		"wrong-local", "wrong-remote", "wrong-server", "missing-name", "query-failed",
		"pi-owned", "claude-owned", "active-operation", "old-binding", "engine-failure", "ordinary-failure",
	} {
		t.Run(name, func(t *testing.T) {
			cfg := Config{ServerURL: "http://sync.test:8791", SSHHost: "sync.test", SSHUser: "root"}
			m := &Mapping{LocalPath: t.TempDir(), ServerPath: "/srv/git-recovery-status-" + randHex(8), SyncName: "recovery-session", BindingEpoch: "current", ServerID: serverIdentity(cfg), Mode: "vps"}
			session := syncSession{
				Name: m.SyncName, Identifier: "exact-session", Paused: true, Status: "watching", SuccessfulCycles: 1,
				Alpha: syncEndpoint{Path: m.LocalPath, Connected: true, Scanned: true},
				Beta:  syncEndpoint{Protocol: "ssh", Host: syncSSHAlias(cfg), Path: m.ServerPath, Connected: true, Scanned: true},
			}
			sessions := []syncSession{session}
			operation := SyncInfo{Status: "blocked", Detail: "initial Git direction required", BindingEpoch: m.BindingEpoch, GitRecoveryRequired: true}
			var queryErr error
			owner := ""
			want := name == "eligible-paused" || name == "eligible-watching"
			switch name {
			case "eligible-watching":
				sessions[0].Paused = false
			case "missing-session":
				sessions = nil
			case "duplicate-session":
				sessions = append(sessions, session)
			case "wrong-local":
				sessions[0].Alpha.Path += "-other"
			case "wrong-remote":
				sessions[0].Beta.Path += "-other"
			case "wrong-server":
				cfg.SSHHost = "other.test"
			case "missing-name":
				m.SyncName = ""
			case "query-failed":
				queryErr = errors.New("daemon unavailable")
			case "pi-owned":
				owner = "pi"
			case "claude-owned":
				owner = "claude"
			case "active-operation":
				syncActivities.Lock()
				syncActivities.items[m.ServerPath] = syncActivity{epoch: m.BindingEpoch, count: 1, phase: "syncing"}
				syncActivities.Unlock()
			case "old-binding":
				operation.BindingEpoch = "previous"
			case "engine-failure":
				operation.engineFailure = true
			case "ordinary-failure":
				operation.GitRecoveryRequired = false
			}
			syncStates.Store(m.ServerPath, operation)
			t.Cleanup(func() {
				syncStates.Delete(m.ServerPath)
				syncActivities.Lock()
				delete(syncActivities.items, m.ServerPath)
				syncActivities.Unlock()
			})
			info := projectSyncInfo(m, cfg, sessions, queryErr, "current-observation", owner)
			if info.GitRecoveryRequired != want || info.TaskOwner != owner {
				t.Fatalf("recovery action eligibility=%v want=%v status=%+v", info.GitRecoveryRequired, want, info)
			}
			if want && (info.Status != "blocked" || info.Detail != operation.Detail || info.BindingEpoch != m.BindingEpoch) {
				t.Fatalf("eligible direction failure lost its authoritative explanation: %+v", info)
			}
		})
	}
}
