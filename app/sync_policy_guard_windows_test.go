//go:build windows

package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// A copied test executable acts as a private daemon CLI. Its session snapshot
// lives outside the project, so tests can recreate a session or change its
// policy without generating endpoint metadata events. No real daemon is used.
func init() {
	if os.Getenv("CHISA_CONNECTION_TEST_TOOL") != "policy-guard" {
		return
	}
	fail := func(err error) {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(93)
	}
	args := os.Args[1:]
	encoded, err := json.Marshal(args)
	if err != nil {
		fail(err)
	}
	log, err := os.OpenFile(os.Getenv("CHISA_CONNECTION_TEST_TOOL_LOG"), os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0600)
	if err != nil {
		fail(err)
	}
	_, err = fmt.Fprintln(log, string(encoded))
	if closeErr := log.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		fail(err)
	}
	if len(args) == 1 && args[0] == "version" {
		fmt.Println(workspaceSyncEngineVersion)
		os.Exit(0)
	}
	statePath := os.Getenv("CHISA_POLICY_GUARD_SESSIONS")
	raw, err := os.ReadFile(statePath)
	if err != nil {
		fail(err)
	}
	var sessions []syncSession
	if err := json.Unmarshal(raw, &sessions); err != nil {
		fail(err)
	}
	if len(args) >= 2 && args[0] == "sync" && args[1] == "list" {
		fmt.Println("CHISA_SYNC_JSON:" + string(raw))
		os.Exit(0)
	}
	if len(args) < 3 || args[0] != "sync" || len(sessions) != 1 || args[len(args)-1] != sessions[0].Identifier {
		fail(fmt.Errorf("unexpected or non-identifier command: %q", args))
	}
	switch args[1] {
	case "pause":
		sessions[0].Paused = true
	case "resume":
		sessions[0].Paused = false
	case "flush":
		if sessions[0].Paused {
			fail(fmt.Errorf("flush reached a paused session"))
		}
	case "update-ignores":
		if !sessions[0].Paused || len(args) != 5 || args[2] != "--configuration-file" {
			fail(fmt.Errorf("policy update must use the paused exact session: %q", args))
		}
		contents, err := os.ReadFile(args[3])
		if err != nil {
			fail(err)
		}
		sessions[0].Ignore.Paths = nil
		for _, line := range strings.Split(string(contents), "\n") {
			if item, ok := strings.CutPrefix(strings.TrimSpace(line), "- "); ok {
				var pattern string
				if err := json.Unmarshal([]byte(item), &pattern); err != nil {
					fail(err)
				}
				sessions[0].Ignore.Paths = append(sessions[0].Ignore.Paths, pattern)
			}
		}
	default:
		fail(fmt.Errorf("unexpected engine mutation: %q", args))
	}
	encoded, err = json.Marshal(sessions)
	if err == nil {
		err = os.WriteFile(statePath, encoded, 0600)
	}
	if err != nil {
		fail(err)
	}
	os.Exit(0)
}

type syncPolicyGuardFixture struct {
	t             *testing.T
	mapping       *Mapping
	statePath     string
	logPath       string
	configuration string
	remoteToken   string
	patterns      []string
	inventories   int
	onInventory   func(int)
}

func newSyncPolicyGuardFixture(t *testing.T) *syncPolicyGuardFixture {
	t.Helper()
	m := isolateSyncRecovery(t)
	root := t.TempDir()
	fixture := &syncPolicyGuardFixture{
		t: t, mapping: m, statePath: filepath.Join(root, "sessions.json"),
		configuration: filepath.Join(root, "ignore.yml"), remoteToken: "stable-remote-policy",
		patterns: []string{"node_modules", ".git", syncDynamicGitPolicyMarker},
	}
	fixture.logPath = privateConnectionTool(t, "[]")
	t.Setenv("CHISA_CONNECTION_TEST_TOOL", "policy-guard")
	t.Setenv("CHISA_POLICY_GUARD_SESSIONS", fixture.statePath)
	fixture.setSessions()
	previousObservation := observeSyncIgnoreRemoteMetadata
	previousInventory := projectSyncIgnoreConfigurationContext
	observeSyncIgnoreRemoteMetadata = func(context.Context, *Mapping) (syncMetadataObservation, error) {
		return syncMetadataObservation{Ignore: fixture.remoteToken}, nil
	}
	projectSyncIgnoreConfigurationContext = func(context.Context, *Mapping) (string, error) {
		fixture.inventories++
		if fixture.onInventory != nil {
			fixture.onInventory(fixture.inventories)
		}
		var contents strings.Builder
		contents.WriteString("sync:\n  defaults:\n    ignore:\n      paths:\n")
		for _, pattern := range fixture.patterns {
			encoded, err := json.Marshal(pattern)
			if err != nil {
				return "", err
			}
			fmt.Fprintf(&contents, "        - %s\n", encoded)
		}
		return fixture.configuration, os.WriteFile(fixture.configuration, []byte(contents.String()), 0600)
	}
	t.Cleanup(func() {
		observeSyncIgnoreRemoteMetadata = previousObservation
		projectSyncIgnoreConfigurationContext = previousInventory
		forgetSyncIgnoreObservation(m)
	})
	return fixture
}

func (fixture *syncPolicyGuardFixture) session() syncSession {
	m := fixture.mapping
	session := syncSession{Name: m.SyncName, Identifier: "policy-guard-original", Mode: "two-way-safe", Status: "watching", SuccessfulCycles: 1}
	session.Ignore.VCS, session.Ignore.Paths = true, append([]string(nil), fixture.patterns...)
	session.Alpha = syncEndpoint{Path: m.LocalPath, Connected: true, Scanned: true}
	session.Beta = syncEndpoint{Protocol: "ssh", Host: syncSSHAlias(store.config()), Path: m.ServerPath, Connected: true, Scanned: true}
	return session
}

func (fixture *syncPolicyGuardFixture) setSessions(sessions ...syncSession) {
	fixture.t.Helper()
	if sessions == nil {
		sessions = []syncSession{}
	}
	encoded, err := json.Marshal(sessions)
	if err == nil {
		err = os.WriteFile(fixture.statePath, encoded, 0600)
	}
	if err != nil {
		fixture.t.Fatal(err)
	}
}

func (fixture *syncPolicyGuardFixture) calls() [][]string {
	fixture.t.Helper()
	raw, err := os.ReadFile(fixture.logPath)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		fixture.t.Fatal(err)
	}
	var calls [][]string
	for _, line := range strings.Split(strings.TrimSpace(string(raw)), "\n") {
		if line == "" {
			continue
		}
		var args []string
		if err := json.Unmarshal([]byte(line), &args); err != nil {
			fixture.t.Fatal(err)
		}
		calls = append(calls, args)
	}
	return calls
}

func (fixture *syncPolicyGuardFixture) requireQueriesOnly() {
	fixture.t.Helper()
	for _, args := range fixture.calls() {
		if len(args) < 2 || args[0] != "sync" || args[1] != "list" {
			fixture.t.Fatalf("guard allowed an engine mutation: %q", args)
		}
	}
}

func (fixture *syncPolicyGuardFixture) requireNoStamp() {
	fixture.t.Helper()
	if _, err := os.Stat(syncIgnoreStampPath(fixture.mapping)); !os.IsNotExist(err) {
		fixture.t.Fatalf("unproven inventory wrote a reusable stamp: %v", err)
	}
}

func TestSyncDynamicPolicyMigrationGuardsResumeUntilAcknowledged(t *testing.T) {
	fixture := newSyncPolicyGuardFixture(t)
	legacy := fixture.session()
	legacy.Paused = true
	legacy.Ignore.Paths = []string{"node_modules", ".git"}
	fixture.setSessions(legacy)
	if err := ensureSyncWatchingContext(context.Background(), fixture.mapping); err == nil {
		t.Fatal("legacy literal policy resumed without dynamic admission")
	}
	fixture.requireQueriesOnly()
	if changed, err := refreshSyncIgnoreContext(context.Background(), fixture.mapping); err != nil || !changed {
		t.Fatalf("policy migration failed: changed=%t err=%v", changed, err)
	}
	if err := ensureSyncWatchingContext(context.Background(), fixture.mapping); err != nil {
		t.Fatalf("acknowledged dynamic policy could not resume: %v", err)
	}
}

func TestSyncIgnoreDynamicEngineRevalidatesIdentityWithoutInventories(t *testing.T) {
	fixture := newSyncPolicyGuardFixture(t)
	session := fixture.session()
	fixture.setSessions(session)
	for pass := 0; pass < 3; pass++ {
		if changed, err := refreshSyncIgnoreContext(context.Background(), fixture.mapping); err != nil || changed || fixture.inventories != 0 {
			t.Fatalf("dynamic engine policy did native inventory: changed=%t inventories=%d err=%v", changed, fixture.inventories, err)
		}
		session.Identifier = fmt.Sprintf("policy-guard-recreated-%d", pass)
		fixture.setSessions(session)
	}
	fixture.requireQueriesOnly()
}

func TestSyncIgnoreDynamicEngineIgnoresLegacyLiteralsAndMigratesRemovedMarker(t *testing.T) {
	fixture := newSyncPolicyGuardFixture(t)
	session := fixture.session()
	session.Ignore.Paths = append(session.Ignore.Paths, "tracked-source.txt")
	fixture.setSessions(session)
	if changed, err := refreshSyncIgnoreContext(context.Background(), fixture.mapping); err != nil || changed || fixture.inventories != 0 {
		t.Fatalf("legacy literals disturbed authoritative engine policy: changed=%t inventories=%d err=%v", changed, fixture.inventories, err)
	}
	session.Ignore.Paths = []string{"node_modules", ".git", "tracked-source.txt"}
	fixture.setSessions(session)
	if changed, err := refreshSyncIgnoreContext(context.Background(), fixture.mapping); err != nil || !changed || fixture.inventories != 1 {
		t.Fatalf("removed capability bypassed migration: changed=%t inventories=%d err=%v", changed, fixture.inventories, err)
	}
	if changed, err := refreshSyncIgnoreContext(context.Background(), fixture.mapping); err != nil || changed || fixture.inventories != 1 {
		t.Fatalf("migrated policy did not stay warm: changed=%t inventories=%d err=%v", changed, fixture.inventories, err)
	}
	counts := map[string]int{}
	for _, args := range fixture.calls() {
		counts[args[1]]++
		if args[1] != "list" && args[len(args)-1] != session.Identifier {
			t.Fatalf("rule repair targeted a name instead of the exact session: %q", args)
		}
	}
	if counts["pause"] != 1 || counts["update-ignores"] != 1 || counts["resume"] != 0 || counts["flush"] != 0 {
		t.Fatalf("external policy repair disturbed more than one migration: %v", counts)
	}
}

func TestSyncIgnoreCacheRejectsExternalModeOrVCSTamper(t *testing.T) {
	for _, kind := range []string{"mode", "vcs"} {
		t.Run(kind, func(t *testing.T) {
			fixture := newSyncPolicyGuardFixture(t)
			session := fixture.session()
			fixture.setSessions(session)
			if _, err := refreshSyncIgnoreContext(context.Background(), fixture.mapping); err != nil {
				t.Fatal(err)
			}
			if kind == "mode" {
				session.Mode = "one-way-replica"
			} else {
				session.Ignore.VCS = false
			}
			fixture.setSessions(session)
			if _, err := refreshSyncIgnoreContext(context.Background(), fixture.mapping); err == nil {
				t.Fatal("cached policy accepted externally changed mode/VCS settings")
			}
			if err := flushSyncContext(context.Background(), fixture.mapping, false); err == nil {
				t.Fatal("unsafe live session was allowed to flush")
			}
			if fixture.inventories != 0 {
				t.Fatalf("invalid session should fail before policy inventory: %d", fixture.inventories)
			}
			fixture.requireQueriesOnly()
		})
	}
}

func TestSyncIgnoreGuardRejectsEndpointChangeDuringInventory(t *testing.T) {
	for _, operation := range []string{"first-create", "migration"} {
		for _, endpoint := range []string{"remote", "local"} {
			t.Run(operation+"/"+endpoint, func(t *testing.T) {
				fixture := newSyncPolicyGuardFixture(t)
				if operation == "migration" {
					session := fixture.session()
					session.Ignore.Paths = []string{"old-policy"}
					fixture.setSessions(session)
				}
				fixture.onInventory = func(int) {
					if endpoint == "remote" {
						fixture.remoteToken = "changed-during-inventory"
					} else {
						invalidateSyncIgnoreObservation(fixture.mapping)
					}
				}
				before, beforeErr := syncIgnoreEndpointSignatureContext(context.Background(), fixture.mapping)
				_, _, _, err := guardedSyncIgnoreConfigurationContext(context.Background(), fixture.mapping, before, beforeErr)
				if err == nil || !strings.Contains(err.Error(), "读取期间发生改变") || fixture.inventories != 1 {
					t.Fatalf("endpoint drift reached engine: inventories=%d err=%v", fixture.inventories, err)
				}
				fixture.requireQueriesOnly()
				fixture.requireNoStamp()
			})
		}
	}
}

func TestSyncIgnoreGuardRejectsUnsupportedInventoryMismatch(t *testing.T) {
	for _, operation := range []string{"first-create", "migration"} {
		t.Run(operation, func(t *testing.T) {
			fixture := newSyncPolicyGuardFixture(t)
			fixture.remoteToken = ""
			if operation == "migration" {
				session := fixture.session()
				session.Ignore.Paths = []string{"old-policy"}
				fixture.setSessions(session)
			}
			fixture.onInventory = func(pass int) {
				if pass == 2 {
					fixture.patterns = append(fixture.patterns, "newly-ignored")
				}
			}
			before, beforeErr := syncIgnoreEndpointSignatureContext(context.Background(), fixture.mapping)
			_, _, _, err := guardedSyncIgnoreConfigurationContext(context.Background(), fixture.mapping, before, beforeErr)
			if err == nil || !strings.Contains(err.Error(), "持续变化") || fixture.inventories != 2 {
				t.Fatalf("unsupported observation accepted inconsistent inventories: inventories=%d err=%v", fixture.inventories, err)
			}
			fixture.requireQueriesOnly()
			fixture.requireNoStamp()
		})
	}
}

func TestSyncIgnoreGuardRejectsSessionChangeDuringInventory(t *testing.T) {
	for _, kind := range []string{"replacement", "rules"} {
		t.Run(kind, func(t *testing.T) {
			fixture := newSyncPolicyGuardFixture(t)
			session := fixture.session()
			session.Ignore.Paths = []string{"legacy-policy"}
			fixture.setSessions(session)
			fixture.onInventory = func(int) {
				if kind == "replacement" {
					session.Identifier = "policy-guard-replaced-during-inventory"
				} else {
					session.Ignore.Paths = []string{"externally-changed-during-inventory"}
				}
				fixture.setSessions(session)
			}
			if _, err := refreshSyncIgnoreContext(context.Background(), fixture.mapping); err == nil || !strings.Contains(err.Error(), "同步会话已改变") {
				t.Fatalf("session changed during inventory was accepted: %v", err)
			}
			fixture.requireQueriesOnly()
			fixture.requireNoStamp()
		})
	}
}

func TestSyncWatchingRejectsMissingReplacedOrUnsafeSession(t *testing.T) {
	for _, kind := range []string{"missing", "duplicate", "wrong-binding", "replaced", "mode", "vcs", "disconnected", "no-cycle", "error"} {
		t.Run(kind, func(t *testing.T) {
			fixture := newSyncPolicyGuardFixture(t)
			session := fixture.session()
			ctx := context.Background()
			sessions := []syncSession{session}
			switch kind {
			case "missing":
				sessions = nil
			case "duplicate":
				duplicate := session
				duplicate.Identifier = "policy-guard-duplicate"
				sessions = append(sessions, duplicate)
			case "wrong-binding":
				sessions[0].Beta.Path = "/srv/unrelated-project"
			case "replaced":
				ctx = context.WithValue(ctx, syncSessionIdentityKey{}, &syncSessionIdentity{identifier: "earlier-session-id"})
			case "mode":
				sessions[0].Mode = "one-way-replica"
			case "vcs":
				sessions[0].Ignore.VCS = false
			case "disconnected":
				sessions[0].Alpha.Connected = false
			case "no-cycle":
				sessions[0].SuccessfulCycles = 0
			case "error":
				sessions[0].LastError = "controlled endpoint failure"
			}
			fixture.setSessions(sessions...)
			if err := ensureSyncWatchingContext(ctx, fixture.mapping); err == nil {
				t.Fatal("final watching check accepted an unconfirmed session")
			}
			fixture.requireQueriesOnly()
		})
	}
}

func TestSyncWatchingResumesAndFlushesExactSession(t *testing.T) {
	fixture := newSyncPolicyGuardFixture(t)
	session := fixture.session()
	session.Paused = true
	fixture.setSessions(session)
	ctx := context.WithValue(context.Background(), syncSessionIdentityKey{}, &syncSessionIdentity{identifier: session.Identifier})
	if err := ensureSyncWatchingContext(ctx, fixture.mapping); err != nil {
		t.Fatal(err)
	}
	counts := map[string]int{}
	for _, args := range fixture.calls() {
		counts[args[1]]++
		if args[1] != "list" && args[len(args)-1] != session.Identifier {
			t.Fatalf("watcher command did not use the pinned session: %q", args)
		}
	}
	if counts["resume"] != 1 || counts["flush"] != 1 || counts["pause"] != 0 || fixture.inventories != 0 {
		t.Fatalf("resume did not wait for one exact file cycle: commands=%v inventories=%d", counts, fixture.inventories)
	}
}
