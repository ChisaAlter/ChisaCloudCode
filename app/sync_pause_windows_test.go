//go:build windows

package main

import (
	"bytes"
	"context"
	"encoding/json"
	"log"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestWorkspacePauseTimeoutRetainsBarrierWithoutRepeatedCleanup(t *testing.T) {
	m := isolateSyncRecovery(t)
	t.Cleanup(func() {
		cloudReservations.Delete(m.ServerPath)
		forgetSyncIgnoreObservation(m)
	})
	previousGitObservation := observeSyncGitRemoteMetadata
	previousPolicyObservation := observeSyncIgnoreRemoteMetadata
	// Git preflight must certify that both endpoints are plain directories before
	// the policy migration reaches the real bounded daemon pause below.
	observeSyncGitRemoteMetadata = func(context.Context, *Mapping) (syncMetadataObservation, error) {
		return syncMetadataObservation{Git: "plain-remote-directory"}, nil
	}
	observeSyncIgnoreRemoteMetadata = func(context.Context, *Mapping) (syncMetadataObservation, error) {
		return syncMetadataObservation{Ignore: "stable-remote-policy"}, nil
	}
	t.Cleanup(func() {
		observeSyncGitRemoteMetadata = previousGitObservation
		observeSyncIgnoreRemoteMetadata = previousPolicyObservation
	})
	session := syncSession{Name: m.SyncName, Identifier: "private-test-session", Mode: "two-way-safe", Status: "watching", SuccessfulCycles: 1}
	session.Ignore.VCS = true
	session.Alpha = syncEndpoint{Path: m.LocalPath, Connected: true, Scanned: true}
	session.Beta = syncEndpoint{Protocol: "ssh", Host: syncSSHAlias(store.config()), Path: m.ServerPath, Connected: true, Scanned: true}
	encoded, err := json.Marshal([]syncSession{session})
	if err != nil {
		t.Fatal(err)
	}
	calls := privateConnectionTool(t, string(encoded))
	t.Setenv("CHISA_CONNECTION_TEST_SYNC_MODE", "pause-hang")
	id := "pause-timeout-run"
	lease := map[string]any{"id": id, "epoch": m.BindingEpoch, "owner": "claude"}
	remoteLeaseContext = func(_ context.Context, _ *Mapping, op, _, _ string) (map[string]any, error) {
		if op != "read" && op != "confirm" {
			t.Fatalf("unconfirmed daemon pause released or replaced the task lease: %s", op)
		}
		return map[string]any{"ok": true, "lease": lease}, nil
	}
	cleanupPauses := 0
	pauseProjectSync = func(context.Context, *Mapping) error {
		cleanupPauses++
		return nil
	}
	// The policy is now computed before the engine is touched, so that an
	// unchanged rule set never pauses a warm session. This test keeps its
	// contract (a hung pause blocks flush and rule migration) by producing a
	// rule set that differs from the session's.
	previousIgnoreConfig := projectSyncIgnoreConfigurationContext
	projectSyncIgnoreConfigurationContext = func(context.Context, *Mapping) (string, error) {
		path := filepath.Join(t.TempDir(), "ignore.yml")
		return path, os.WriteFile(path, []byte("sync:\n  defaults:\n    ignore:\n      paths:\n        - \"node_modules\"\n"), 0600)
	}
	t.Cleanup(func() { projectSyncIgnoreConfigurationContext = previousIgnoreConfig })
	synchronizeProjectContext = syncProjectContentsContext
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	var output bytes.Buffer
	previousLogWriter := log.Writer()
	log.SetOutput(&output)
	t.Cleanup(func() { log.SetOutput(previousLogWriter) })
	started := time.Now()
	result := synchronizationRPCContext(ctx, m, map[string]any{"op": "sync_begin", "runId": id})
	elapsed := time.Since(started)
	log.SetOutput(previousLogWriter)
	if result["code"] != "SYNC_PAUSE_UNCONFIRMED" || !strings.Contains(result["error"].(string), "同步暂停尚未确认") {
		t.Fatalf("pause failure lost its distinct recoverable response: %v", result)
	}
	// The RPC also performs Git/session preflight and computes the ignore policy.
	// Only runMutagenContext's command-level timing measures the pause budget.
	pauseEvents := 0
	pauseEvent := ""
	for _, line := range strings.Split(output.String(), "\n") {
		if _, event, found := strings.Cut(line, "[sync-engine] operation=pause "); found {
			pauseEvents++
			pauseEvent = event
		}
	}
	const timeoutEvent = "outcome=timeout elapsed="
	if pauseEvents != 1 || !strings.HasPrefix(pauseEvent, timeoutEvent) {
		t.Fatalf("expected one timed-out daemon pause: pipeline=%s logs=%s", elapsed, output.String())
	}
	pauseElapsed, err := time.ParseDuration(strings.TrimPrefix(pauseEvent, timeoutEvent))
	if err != nil {
		t.Fatalf("pause timing evidence is invalid: %q (%v)", pauseEvent, err)
	}
	t.Logf("pipeline=%s pause=%s parent=%v", elapsed, pauseElapsed, ctx.Err())
	if pauseElapsed < workspaceSyncPauseTimeout-500*time.Millisecond || pauseElapsed > workspaceSyncPauseTimeout+5*time.Second || ctx.Err() != nil {
		t.Fatalf("pause consumed the transfer budget rather than its own ten-second budget: pause=%s pipeline=%s parent=%v", pauseElapsed, elapsed, ctx.Err())
	}
	if cleanupPauses != 0 {
		t.Fatalf("failed main pause was repeated during cleanup: %d", cleanupPauses)
	}
	if value, ok := syncStopUnconfirmed.Load(m.ServerPath); !ok || value != (unconfirmedSyncStop{m.BindingEpoch, m.SyncName}) {
		t.Fatalf("unconfirmed pause lost the exact binding barrier: %v", value)
	}
	if value, ok := cloudReservations.Load(m.ServerPath); !ok || value != id || lease["owner"] != "claude" {
		t.Fatal("unconfirmed pause cleared task ownership")
	}
	if info := observedProjectSync(m.ServerPath); info.Status != "blocked" || info.TaskOwner != "claude" {
		t.Fatalf("unconfirmed pause appeared ready: %+v", info)
	}
	raw, err := os.ReadFile(calls)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Count(string(raw), `"pause"`) != 1 || strings.Count(string(raw), `"flush"`) != 0 || strings.Contains(string(raw), `"update-ignores"`) {
		t.Fatalf("unconfirmed initial pause must block rule migration and old-rule flush without a second pause: %s", raw)
	}
}

func TestUnchangedIgnorePolicyKeepsSyncEngineWarm(t *testing.T) {
	m := isolateSyncRecovery(t)
	t.Cleanup(func() { forgetSyncIgnoreObservation(m) })
	previousObservation := observeSyncIgnoreRemoteMetadata
	remoteToken := "first-remote-policy"
	observeSyncIgnoreRemoteMetadata = func(context.Context, *Mapping) (syncMetadataObservation, error) {
		return syncMetadataObservation{Ignore: remoteToken}, nil
	}
	t.Cleanup(func() { observeSyncIgnoreRemoteMetadata = previousObservation })
	session := syncSession{Name: m.SyncName, Identifier: "private-test-session", Mode: "two-way-safe", Status: "watching", SuccessfulCycles: 1}
	session.Ignore.VCS = true
	session.Ignore.Paths = []string{"node_modules", ".git"}
	session.Alpha = syncEndpoint{Path: m.LocalPath, Connected: true, Scanned: true}
	session.Beta = syncEndpoint{Protocol: "ssh", Host: syncSSHAlias(store.config()), Path: m.ServerPath, Connected: true, Scanned: true}
	encoded, err := json.Marshal([]syncSession{session})
	if err != nil {
		t.Fatal(err)
	}
	calls := privateConnectionTool(t, string(encoded))
	previousIgnoreConfig := projectSyncIgnoreConfigurationContext
	inventories := 0
	projectSyncIgnoreConfigurationContext = func(context.Context, *Mapping) (string, error) {
		inventories++
		path := filepath.Join(t.TempDir(), "ignore.yml")
		return path, os.WriteFile(path, []byte("sync:\n  defaults:\n    ignore:\n      paths:\n        - \"node_modules\"\n        - \".git\"\n"), 0600)
	}
	t.Cleanup(func() { projectSyncIgnoreConfigurationContext = previousIgnoreConfig })

	changed, err := refreshSyncIgnoreContext(context.Background(), m)
	if err != nil {
		t.Fatalf("unchanged policy failed: %v", err)
	}
	if changed {
		t.Fatal("unchanged policy reported a rule migration")
	}
	raw, err := os.ReadFile(calls)
	if err != nil {
		t.Fatal(err)
	}
	// Pausing a warm session forces a cold rescan of both endpoints on the next
	// flush, which is the difference between seconds and minutes on a large
	// project. An unchanged rule set must therefore only query the live session.
	if strings.Contains(string(raw), `"pause"`) || strings.Contains(string(raw), `"update-ignores"`) {
		t.Fatalf("unchanged rule set disturbed a warm session: %s", raw)
	}
	// Cached endpoint evidence still has to be checked against the live session:
	// another controller can replace that session or change its effective rules.
	before := len(raw)
	changed, err = refreshSyncIgnoreContext(context.Background(), m)
	if err != nil || changed {
		t.Fatalf("cached policy failed: changed=%t err=%v", changed, err)
	}
	after, err := os.ReadFile(calls)
	if err != nil {
		t.Fatal(err)
	}
	validationCalls := strings.Split(strings.TrimSpace(string(after[before:])), "\n")
	if inventories != 1 || len(after) <= before {
		t.Fatalf("cached policy skipped live validation or repeated inventory: inventories=%d calls=%s", inventories, string(after[before:]))
	}
	for _, line := range validationCalls {
		var args []string
		if err := json.Unmarshal([]byte(line), &args); err != nil || len(args) < 2 || args[0] != "sync" || args[1] != "list" {
			t.Fatalf("cached policy should only validate the live session: %q (%v)", line, err)
		}
	}
	// Only the remote half changes; it must invalidate the local stamp without
	// pausing the engine when the resulting pattern set remains equal.
	remoteToken = "changed-remote-policy"
	changed, err = refreshSyncIgnoreContext(context.Background(), m)
	if err != nil || changed || inventories != 2 {
		t.Fatalf("remote policy was not rechecked: changed=%t inventories=%d err=%v", changed, inventories, err)
	}
	remoteToken = ""
	for pass := 0; pass < 2; pass++ {
		beforeInventory := inventories
		if changed, err = refreshSyncIgnoreContext(context.Background(), m); err != nil || changed || inventories != beforeInventory+2 {
			t.Fatalf("untrusted remote evidence reused stamp: inventories=%d err=%v", inventories, err)
		}
	}
	raw, err = os.ReadFile(calls)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(raw), `"pause"`) || strings.Contains(string(raw), `"update-ignores"`) {
		t.Fatalf("unchanged rules disturbed engine during remote invalidation: %s", raw)
	}
}

func TestWorkspacePauseBudgetDoesNotShortenFileFlush(t *testing.T) {
	privateConnectionTool(t, "[]")
	t.Setenv("CHISA_CONNECTION_TEST_SYNC_MODE", "flush-slow")
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	started := time.Now()
	if _, err := runMutagenContext(ctx, "sync", "flush", "private-test-session"); err != nil {
		t.Fatalf("file flush was incorrectly limited to the pause budget: %v", err)
	}
	if elapsed := time.Since(started); elapsed < 11*time.Second || ctx.Err() != nil {
		t.Fatalf("the slow flush did not retain its caller's budget: %s, %v", elapsed, ctx.Err())
	}
	if _, err := runMutagenContext(ctx, "sync", "pause", "private-test-session"); err != nil {
		t.Fatalf("normal pause failed after a successful longer flush: %v", err)
	}
}
