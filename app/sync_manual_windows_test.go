//go:build windows

package main

import (
	"context"
	"errors"
	"fmt"
	"path/filepath"
	"strings"
	"testing"
)

func TestManualSyncRejectsUnsafeSessionBeforeClaim(t *testing.T) {
	for _, kind := range []string{"mode", "vcs", "duplicate", "endpoint"} {
		t.Run(kind, func(t *testing.T) {
			fixture := newSyncPolicyGuardFixture(t)
			m := fixture.mapping
			session := fixture.session()
			switch kind {
			case "mode":
				session.Mode = "one-way-replica"
			case "vcs":
				session.Ignore.VCS = false
			case "endpoint":
				session.Beta.Path += "-replacement"
			}
			fixture.setSessions(session)
			if kind == "duplicate" {
				replacement := session
				replacement.Identifier += "-duplicate"
				fixture.setSessions(session, replacement)
			}
			prepareProjectSyncSession = prepareProjectSyncSessionContext
			claims := 0
			remoteLeaseContext = func(context.Context, *Mapping, string, string, string) (map[string]any, error) {
				claims++
				return nil, errors.New("unsafe session reached lease admission")
			}
			result := (FrontendBridge{}).SyncProject(m.ServerPath)
			if result["ok"] != false || claims != 0 {
				t.Fatalf("unsafe session escaped admission: %v leaseCalls=%d", result, claims)
			}
			fixture.requireQueriesOnly()
			if record, err := loadSyncRelease(m); err != nil || record != nil {
				t.Fatalf("unsafe admission created a recovery journal: %+v %v", record, err)
			}
		})
	}
}

func TestManualSyncKeepsUnchangedSessionWarmThroughPublicEntry(t *testing.T) {
	fixture := newSyncPolicyGuardFixture(t)
	m := fixture.mapping
	session := fixture.session()
	fixture.setSessions(session)
	pauseProjectSync = pauseProjectSyncContext
	prepareProjectSyncSession = prepareProjectSyncSessionContext
	previousGitObserver := observeSyncGitRemoteMetadata
	observeSyncGitRemoteMetadata = func(context.Context, *Mapping) (syncMetadataObservation, error) {
		return syncMetadataObservation{Git: "stable-plain-remote-directory"}, nil
	}
	t.Cleanup(func() { observeSyncGitRemoteMetadata = previousGitObserver })
	// Registration is outside the file/Git synchronization contract under test.
	// Stop there, after the complete real pipeline, without opening SSH.
	registrationBoundary := errors.New("private registration boundary")
	pipelineDone := false
	var claimed string
	var lease map[string]any
	remoteLeaseContext = func(ctx context.Context, actual *Mapping, op, owner, id string) (map[string]any, error) {
		if actual.ServerPath != m.ServerPath || actual.BindingEpoch != m.BindingEpoch {
			return nil, fmt.Errorf("lease changed its binding")
		}
		switch op {
		case "recover":
			pinned, _ := ctx.Value(syncSessionIdentityKey{}).(*syncSessionIdentity)
			if pinned == nil || pinned.identifier != session.Identifier {
				return nil, fmt.Errorf("manual admission did not pin the exact warm session")
			}
			record, err := loadSyncRelease(m)
			if err != nil || record == nil || record.ID != id {
				return nil, fmt.Errorf("lease preceded its durable release journal")
			}
			claimed = id
			lease = map[string]any{"owner": owner, "id": id, "epoch": m.BindingEpoch}
		case "confirm":
			if lease == nil || id != claimed {
				return nil, fmt.Errorf("pipeline lost its exact lease")
			}
		case "read":
		case "release":
			if !pipelineDone || id != claimed || owner != "sync" {
				return nil, fmt.Errorf("released before verified synchronization")
			}
			lease = nil
		default:
			return nil, fmt.Errorf("unexpected lease operation: %s", op)
		}
		return map[string]any{"ok": true, "lease": lease}, nil
	}
	synchronizeProjectContext = func(ctx context.Context, actual *Mapping, pause bool) error {
		if err := syncProjectContentsContext(ctx, actual, pause); err != nil {
			return err
		}
		pipelineDone = true
		return registrationBoundary
	}
	// GetProjectSync must not spawn a separate monitor against the private CLI.
	syncMonitor.Lock()
	previousClosed := syncMonitor.closed
	syncMonitor.closed = true
	syncMonitor.Unlock()
	t.Cleanup(func() {
		syncMonitor.Lock()
		syncMonitor.closed = previousClosed
		syncMonitor.Unlock()
	})
	// isolatePi supplies a private in-memory store; ensure ordinary mapping
	// persistence can run while the public entry performs its normal admission.
	store.path = filepath.Join(t.TempDir(), "state.json")
	result := (FrontendBridge{}).SyncProject(m.ServerPath)
	if !pipelineDone || result["ok"] != false || !strings.Contains(fmt.Sprint(result["error"]), registrationBoundary.Error()) {
		t.Fatalf("public manual synchronization failed before registration: %v pipelineDone=%t", result, pipelineDone)
	}
	counts := map[string]int{}
	for _, args := range fixture.calls() {
		if len(args) < 2 || args[0] != "sync" {
			t.Fatalf("unexpected engine command: %q", args)
		}
		counts[args[1]]++
		if args[1] != "list" && args[len(args)-1] != session.Identifier {
			t.Fatalf("engine command lost its pinned identity: %q", args)
		}
	}
	if counts["pause"] != 0 || counts["resume"] != 0 || counts["update-ignores"] != 0 || counts["flush"] != 1 {
		t.Fatalf("ordinary manual sync disconnected warm endpoints: %v", counts)
	}
	if claimed == "" || lease != nil {
		t.Fatalf("verified manual sync did not release its exact lease: claimed=%q lease=%v", claimed, lease)
	}
	if record, err := loadSyncRelease(m); err != nil || record != nil {
		t.Fatalf("verified release retained the recovery journal: %+v %v", record, err)
	}
	if fixture.inventories != 0 {
		t.Fatalf("live engine policy repeated native inventories on a warm manual sync: %d", fixture.inventories)
	}
}
