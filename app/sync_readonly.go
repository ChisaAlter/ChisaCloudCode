package main

import (
	"context"
	"fmt"
	"sync"

	"github.com/mutagen-io/mutagen/pkg/synchronization/core/ignore"
)

// Only the process that completed an explicitly read-only preparation can
// establish this baseline. A client restart keeps the full handback path.
type readOnlySyncPreparation struct {
	mapping  Mapping
	leaseID  string
	baseline *piWorkspaceSnapshot
	ignores  *ignore.IgnoreCache
}

var readOnlySyncPreparations sync.Map

var resumeReadOnlyProjectSync = func(ctx context.Context, identifier string) error {
	_, err := runMutagenContext(ctx, "sync", "resume", identifier)
	return err
}

func captureReadOnlySyncPreparation(ctx context.Context, m *Mapping, id string) {
	session, err := piWorkspaceSession(ctx, m)
	if err != nil {
		return
	}
	baseline, ignores, err := captureReadOnlyWorkspaceSession(ctx, m, session, nil)
	if err == nil {
		readOnlySyncPreparations.Store(m.ServerPath, readOnlySyncPreparation{mapping: *m, leaseID: id, baseline: baseline, ignores: &ignores})
	}
}

// The server's changed:false assertion is necessary, but cannot prove that a
// local editor left the tree alone. Reuse Pi's file-identity and Git observation
// before resuming the exact paused engine session without repeating file or Git
// synchronization.
func resumeUnchangedReadOnlySync(ctx context.Context, m *Mapping, id string, unchanged bool) (bool, error) {
	value, present := readOnlySyncPreparations.LoadAndDelete(m.ServerPath)
	if !present || !unchanged {
		return false, nil
	}
	prepared := value.(readOnlySyncPreparation)
	if prepared.mapping != *m || prepared.leaseID != id || prepared.baseline == nil {
		return false, nil
	}
	if _, pending := syncStopUnconfirmed.Load(m.ServerPath); pending {
		return false, nil
	}
	var ignores ignore.IgnoreCache
	if prepared.ignores != nil {
		ignores = *prepared.ignores
	}
	changed, err := readOnlyWorkspaceChanged(ctx, m, prepared.baseline, ignores)
	if err != nil || changed {
		return false, nil
	}
	finish := beginSyncOperation(m, "syncing")
	defer finish()
	// confirm checks cleanupPending and the durable sync-job process identity.
	// The existing release below still atomically rechecks both under its flock.
	state, err := remoteLeaseContext(ctx, m, "confirm", "sync-needed", id)
	if err != nil {
		return false, err
	}
	lease, _ := state["lease"].(map[string]any)
	if lease["id"] != id || lease["epoch"] != m.BindingEpoch || lease["owner"] != "sync-needed" {
		return false, fmt.Errorf("只读工作区原任务租约已改变")
	}
	if err := workspaceSyncCurrent(ctx); err != nil {
		return false, err
	}
	if err := resumeReadOnlyProjectSync(ctx, prepared.baseline.session.Identifier); err != nil {
		setSyncFailure(m, err)
		return false, err
	}
	setSyncInfo(m, "ready", "")
	ensureSyncMonitor()
	return true, nil
}
