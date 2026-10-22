//go:build windows

package main

import (
	"context"
	"errors"
	"fmt"
	"testing"
)

func TestWorkspaceSnapshotPinsOnlyExactPreparedSession(t *testing.T) {
	for _, scenario := range []string{"pinned", "pause-failed", "not-paused", "replaced-session", "changed-lease"} {
		t.Run(scenario, func(t *testing.T) {
			fixture := newSyncPolicyGuardFixture(t)
			m := fixture.mapping
			id := "snapshot-exact-run"
			session := fixture.session()
			fixture.setSessions(session)
			pauseProjectSync = pauseProjectSyncContext
			prepared := false
			reconfirmations := 0
			remoteLeaseContext = func(_ context.Context, _ *Mapping, op, owner, actualID string) (map[string]any, error) {
				if op == "confirm" {
					reconfirmations++
					if !prepared || owner != "claude" || actualID != id {
						return nil, errors.New("snapshot lease reconfirmed out of order")
					}
					if scenario == "changed-lease" {
						return nil, errors.New("replacement owner must be preserved")
					}
				}
				return map[string]any{"ok": true, "lease": map[string]any{"id": id, "epoch": m.BindingEpoch, "owner": "claude"}}, nil
			}
			synchronizeProjectContext = func(ctx context.Context, actual *Mapping, reserve bool) error {
				if !reserve {
					return errors.New("snapshot was not a preparation")
				}
				if err := validateProjectSyncSessionContext(ctx, actual, session); err != nil {
					return err
				}
				prepared = true
				if scenario == "replaced-session" {
					replacement := session
					replacement.Identifier += "-replacement"
					fixture.setSessions(replacement)
				}
				return nil
			}
			if scenario == "pause-failed" {
				pauseProjectSync = func(context.Context, *Mapping) error { return &syncPauseError{errors.New("pause unconfirmed")} }
			}
			if scenario == "not-paused" {
				pauseProjectSync = func(context.Context, *Mapping) error { return nil }
			}
			response := synchronizationRPCContext(context.Background(), m, map[string]any{"op": "sync_begin", "runId": id, "snapshot": true})
			if scenario == "pinned" {
				if response["ok"] != true || response["snapshotPinned"] != true || response["bindingEpoch"] != m.BindingEpoch || reconfirmations != 1 {
					t.Fatalf("snapshot acknowledgement lacks complete evidence: %v confirms=%d", response, reconfirmations)
				}
			} else if response["ok"] == true || response["snapshotPinned"] != nil {
				t.Fatalf("unsafe %s snapshot acknowledged: %v", scenario, response)
			}
			if !prepared {
				t.Fatal("snapshot bypassed freshness preparation")
			}
			for _, args := range fixture.calls() {
				if len(args) > 1 && args[1] != "list" && args[len(args)-1] != session.Identifier {
					t.Fatalf("snapshot mutated a replacement session: %v", args)
				}
			}
			if reserved, ok := cloudReservations.Load(m.ServerPath); !ok || reserved != id {
				t.Fatal("snapshot lost exact source reservation")
			}
			t.Cleanup(func() { cloudReservations.Delete(m.ServerPath); cloudSyncRecovery.Delete(m.ServerPath) })
		})
	}
}

func TestWorkspaceAtomicReleaseReceiptDoesNotTouchNewOwner(t *testing.T) {
	m := isolateSyncRecovery(t)
	id := "finished-run"
	lease := map[string]any{"id": id, "epoch": m.BindingEpoch, "owner": "sync-needed"}
	releases := 0
	remoteLeaseContext = func(_ context.Context, _ *Mapping, op, owner, actualID string) (map[string]any, error) {
		if op == "release" {
			if actualID != id || owner != "sync-needed" {
				return nil, errors.New("release lost old identity")
			}
			releases++
			// Native atomic release permits the next owner before HTTP reply.
			lease = map[string]any{"id": "new-run", "epoch": m.BindingEpoch, "owner": "claude"}
			cloudReservations.Store(m.ServerPath, "new-run")
		} else if op != "read" {
			return nil, fmt.Errorf("unexpected operation %s", op)
		}
		return map[string]any{"ok": true, "lease": lease}, nil
	}
	synchronizeProjectContext = func(context.Context, *Mapping, bool) error { return nil }
	response := synchronizationRPCContext(context.Background(), m, map[string]any{"op": "sync_end", "runId": id})
	if response["ok"] != true || response["releasedRunId"] != id || response["bindingEpoch"] != m.BindingEpoch || releases != 1 {
		t.Fatalf("missing exact atomic handback receipt: %v releases=%d", response, releases)
	}
	if lease["id"] != "new-run" {
		t.Fatal("completed handback touched the legitimate next owner")
	}
	if reserved, ok := cloudReservations.Load(m.ServerPath); !ok || reserved != "new-run" {
		t.Fatal("completed handback cleared the next owner's native reservation")
	}
	t.Cleanup(func() { cloudReservations.Delete(m.ServerPath); cloudSyncRecovery.Delete(m.ServerPath) })
}
