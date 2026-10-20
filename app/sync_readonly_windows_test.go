package main

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

type readOnlySyncFixture struct {
	mapping      *Mapping
	session      *syncSession
	lease        map[string]any
	events       []string
	observations int
}

func readOnlySyncTestFixture(t *testing.T) *readOnlySyncFixture {
	t.Helper()
	m := isolateSyncRecovery(t)
	f := &readOnlySyncFixture{mapping: m, session: &syncSession{Name: m.SyncName, Identifier: "original-read-only-engine", Paused: true}}
	f.session.Alpha.Path = m.LocalPath
	f.session.Beta.Path, f.session.Beta.Protocol, f.session.Beta.Host = m.ServerPath, "ssh", syncSSHAlias(store.config())
	f.session.Ignore.VCS = true
	f.lease = map[string]any{"id": "git-read-run", "epoch": m.BindingEpoch, "owner": "claude"}
	if err := os.WriteFile(filepath.Join(m.LocalPath, "source.txt"), []byte("local dirty source"), 0600); err != nil {
		t.Fatal(err)
	}
	previousSessions, previousResume := piWorkspaceSyncSessions, resumeReadOnlyProjectSync
	piWorkspaceSyncSessions = func(context.Context, string) ([]syncSession, error) {
		f.observations++
		return []syncSession{*f.session}, nil
	}
	resumeReadOnlyProjectSync = func(context.Context, string) error {
		t.Fatal("read-only entrypoint used the retired snapshot/resume shortcut")
		return nil
	}
	synchronizeProjectContext = func(ctx context.Context, actual *Mapping, prepare bool) error {
		if actual != m || f.lease == nil || ctx.Value(syncLeaseContextKey{}) != f.lease["id"] || f.session.Paused {
			t.Fatal("synchronization lost the active watcher, mapping or exact lease")
		}
		expectedOwner, event := "sync-needed", "sync-handback"
		if prepare {
			expectedOwner, event = "claude", "sync-prepare"
		}
		if f.lease["owner"] != expectedOwner {
			t.Fatal("synchronization ran outside its exact task phase")
		}
		f.events = append(f.events, event)
		return nil
	}
	remoteLeaseContext = func(_ context.Context, actual *Mapping, op, owner, id string) (map[string]any, error) {
		if actual != m {
			t.Fatal("lease operation touched another mapping")
		}
		if op != "read" && op != "release" {
			t.Fatalf("read-only entrypoint bypassed unified synchronization: %s", op)
		}
		if op == "release" {
			if f.lease == nil || f.lease["id"] != id || f.lease["epoch"] != actual.BindingEpoch || f.lease["owner"] != owner || owner != "sync-needed" {
				t.Fatalf("operation=%s mismatched lease id=%q owner=%q actual=%v", op, id, owner, f.lease)
			}
			f.events = append(f.events, op+":"+id)
			f.lease = nil
		}
		var lease any
		if f.lease != nil {
			lease = f.lease
		}
		return map[string]any{"ok": true, "lease": lease}, nil
	}
	t.Cleanup(func() {
		piWorkspaceSyncSessions, resumeReadOnlyProjectSync = previousSessions, previousResume
		readOnlySyncPreparations.Delete(m.ServerPath)
		cloudReservations.Delete(m.ServerPath)
		cloudSyncRecovery.Delete(m.ServerPath)
	})
	return f
}

func (f *readOnlySyncFixture) prepare(t *testing.T, readOnly bool) {
	t.Helper()
	// Legacy observation-helper tests retain a paused fixture; real task
	// preparation must leave the continuous watcher active.
	f.session.Paused = false
	result := synchronizationRPCContext(context.Background(), f.mapping, map[string]any{"op": "sync_begin", "runId": "git-read-run", "readOnly": readOnly})
	if result["ok"] != true || !reflect.DeepEqual(f.events, []string{"sync-prepare"}) || f.observations != 0 || f.session.Paused {
		t.Fatalf("initial read must synchronize once without a snapshot: result=%v events=%v observations=%d", result, f.events, f.observations)
	}
	if _, captured := readOnlySyncPreparations.Load(f.mapping.ServerPath); captured {
		t.Fatal("active preparation captured a full-tree read-only baseline")
	}
	f.lease["owner"] = "sync-needed"
	f.events = nil
}

func TestReadOnlyPreparedHandbackSynchronizesActiveWatcherAndReleases(t *testing.T) {
	f := readOnlySyncTestFixture(t)
	f.prepare(t, true)
	result := synchronizationRPCContext(context.Background(), f.mapping, map[string]any{"op": "sync_end", "runId": "git-read-run", "changed": false})
	want := []string{"sync-handback", "release:git-read-run"}
	if result["ok"] != true || !reflect.DeepEqual(f.events, want) || f.lease != nil || f.observations != 0 || f.session.Paused {
		t.Fatalf("read-only handback skipped unified synchronization or exact release: result=%v events=%v lease=%v observations=%d", result, f.events, f.lease, f.observations)
	}
	result = synchronizationRPCContext(context.Background(), f.mapping, map[string]any{"op": "sync_released", "runId": "git-read-run"})
	if _, reserved := cloudReservations.Load(f.mapping.ServerPath); result["ok"] != true || reserved {
		t.Fatalf("released read retained its task reservation: %v", result)
	}
}

func TestReadOnlyHandbackAlwaysUsesUnifiedSynchronization(t *testing.T) {
	for _, scenario := range []string{"local-write", "missing-baseline", "legacy-baseline", "not-read-only", "changed-true", "changed-absent", "binding-replaced", "session-replaced", "observation-failed"} {
		t.Run(scenario, func(t *testing.T) {
			f := readOnlySyncTestFixture(t)
			f.prepare(t, scenario != "not-read-only")
			request := map[string]any{"op": "sync_end", "runId": "git-read-run", "changed": false}
			switch scenario {
			case "local-write":
				if err := os.WriteFile(filepath.Join(f.mapping.LocalPath, "source.txt"), []byte("external local editor changed this source"), 0600); err != nil {
					t.Fatal(err)
				}
			case "missing-baseline":
				readOnlySyncPreparations.Delete(f.mapping.ServerPath)
			case "legacy-baseline":
				readOnlySyncPreparations.Store(f.mapping.ServerPath, readOnlySyncPreparation{
					mapping: *f.mapping, leaseID: "git-read-run", baseline: &piWorkspaceSnapshot{},
				})
			case "changed-true":
				request["changed"] = true
			case "changed-absent":
				delete(request, "changed")
			case "binding-replaced":
				f.mapping.BindingEpoch = "replacement-binding"
				f.lease["epoch"] = f.mapping.BindingEpoch
			case "session-replaced":
				f.session.Identifier = "replacement-engine"
			case "observation-failed":
				piWorkspaceSyncSessions = func(context.Context, string) ([]syncSession, error) {
					f.observations++
					return nil, errors.New("daemon observation failed")
				}
			}
			result := synchronizationRPCContext(context.Background(), f.mapping, request)
			want := []string{"sync-handback", "release:git-read-run"}
			if result["ok"] != true || !reflect.DeepEqual(f.events, want) || f.observations != 0 || f.session.Paused {
				t.Fatalf("read-only handback bypassed active synchronization: result=%v events=%v observations=%d", result, f.events, f.observations)
			}
		})
	}
}

func TestReadOnlyHandbackDoesNotSynchronizeMissingOrReplacementLease(t *testing.T) {
	for _, scenario := range []string{"missing", "different-id", "different-owner", "different-epoch"} {
		t.Run(scenario, func(t *testing.T) {
			f := readOnlySyncTestFixture(t)
			f.prepare(t, true)
			switch scenario {
			case "missing":
				f.lease = nil
			case "different-id":
				f.lease["id"] = "replacement-run"
			case "different-owner":
				f.lease["owner"] = "claude"
			case "different-epoch":
				f.lease["epoch"] = "replacement-binding"
			}
			result := synchronizationRPCContext(context.Background(), f.mapping, map[string]any{"op": "sync_end", "runId": "git-read-run", "changed": false})
			if result["code"] != "WORKSPACE_BUSY" || len(f.events) != 0 {
				t.Fatalf("read-only handback touched an unowned lease: result=%v events=%v", result, f.events)
			}
		})
	}
}

func TestReadOnlyHandbackFailureKeepsLeaseAndRecoveryBarrier(t *testing.T) {
	for _, phase := range []string{"synchronize", "cancelled", "release"} {
		t.Run(phase, func(t *testing.T) {
			f := readOnlySyncTestFixture(t)
			f.prepare(t, true)
			leaseOperation, synchronize := remoteLeaseContext, synchronizeProjectContext
			releases := 0
			remoteLeaseContext = func(ctx context.Context, m *Mapping, op, owner, id string) (map[string]any, error) {
				if op == "release" {
					releases++
					if phase == "release" {
						return nil, errors.New("handback release failed")
					}
				}
				return leaseOperation(ctx, m, op, owner, id)
			}
			synchronizeProjectContext = func(ctx context.Context, m *Mapping, prepare bool) error {
				if err := synchronize(ctx, m, prepare); err != nil {
					return err
				}
				switch phase {
				case "synchronize":
					return errors.New("handback synchronization failed")
				case "cancelled":
					return context.Canceled
				}
				return nil
			}
			result := synchronizationRPCContext(context.Background(), f.mapping, map[string]any{"op": "sync_end", "runId": "git-read-run", "changed": false})
			reservation, reserved := cloudReservations.Load(f.mapping.ServerPath)
			recovery, pending := cloudSyncRecovery.Load(f.mapping.ServerPath)
			if result["error"] == nil || f.lease == nil || f.lease["id"] != "git-read-run" || f.lease["owner"] != "sync-needed" || !reserved || reservation != "git-read-run" || !pending || recovery != "git-read-run" || f.observations != 0 || f.session.Paused {
				t.Fatalf("failed handback dropped its exact recovery barrier: result=%v lease=%v reservation=%v recovery=%v", result, f.lease, reservation, recovery)
			}
			if (phase == "release" && releases != 1) || (phase != "release" && releases != 0) {
				t.Fatal("handback released before successful synchronization")
			}
			if _, captured := readOnlySyncPreparations.Load(f.mapping.ServerPath); captured {
				t.Fatal("failed active handback captured a full-tree baseline")
			}
			remoteLeaseContext, synchronizeProjectContext = leaseOperation, synchronize
			f.events = nil
			result = synchronizationRPCContext(context.Background(), f.mapping, map[string]any{"op": "sync_end", "runId": "git-read-run", "changed": false})
			if result["ok"] != true || f.lease != nil || !reflect.DeepEqual(f.events, []string{"sync-handback", "release:git-read-run"}) || f.observations != 0 {
				t.Fatalf("recovery did not synchronize and release its retained lease: result=%v events=%v", result, f.events)
			}
		})
	}
}
