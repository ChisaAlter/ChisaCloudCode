package main

import (
	"context"
	"os/exec"
	"testing"
)

func TestRemoteSyncObserverSurvivesHealthyBeginAndHandback(t *testing.T) {
	m := isolateSyncRecovery(t)
	tools := syncSeedTools(t)
	observer, err := newSyncRemoteObserver(apiConnection.ctx, func(ctx context.Context) *exec.Cmd {
		return exec.CommandContext(ctx, tools.python, "-B", "-u", "-c", "import json,sys;[(print(json.dumps({'git':'a'*64,'ignore':'b'*64,'repository':True}),flush=True)) for line in sys.stdin]")
	})
	if err != nil {
		t.Fatal(err)
	}
	key := syncRemoteObservationKey{mapping: *m, connection: apiConnection, transport: tunnel,
		account: apiConnection.accountIdentity + "\x00" + store.config().WorkspaceAccount, keyPath: store.keyPathOf()}
	syncRemoteObservationPool.Lock()
	syncRemoteObservationPool.observers[key] = observer
	syncRemoteObservationPool.Unlock()
	t.Cleanup(func() {
		observer.close()
		syncRemoteObservationPool.Lock()
		if syncRemoteObservationPool.observers[key] == observer {
			delete(syncRemoteObservationPool.observers, key)
		}
		syncRemoteObservationPool.Unlock()
	})
	for _, recovery := range []bool{false, true, true, false, true} {
		parent := context.WithValue(context.Background(), workspaceRecoveryContextKey{}, recovery)
		ctx, cancel, err := bindWorkspaceSyncConnection(parent)
		if err != nil {
			t.Fatal(err)
		}
		value, observeErr := observeRemoteSyncMetadata(ctx, m)
		cancel()
		if observeErr != nil || value.Ignore == "" || observer.closed.Load() {
			t.Fatalf("callback recovery permission %v replaced the live observer: %v", recovery, observeErr)
		}
	}
}

func TestSyncObservationKeysReuseHealthyHandoffButSeparateRecoveryTransport(t *testing.T) {
	m := isolateSyncRecovery(t)
	begin, cancelBegin, err := bindWorkspaceSyncConnection(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer cancelBegin()
	handback, cancelHandback, err := bindWorkspaceSyncConnection(context.WithValue(context.Background(), workspaceRecoveryContextKey{}, true))
	if err != nil {
		t.Fatal(err)
	}
	defer cancelHandback()
	before := syncGitObservationKey(begin, m)
	if got := syncGitObservationKey(handback, m); got != before {
		t.Fatal("healthy task handback changed observation identity and discarded warm evidence")
	}

	serverConnectionMu.Lock()
	apiConnection.workspaceRecoveryOnly = true
	serverConnectionMu.Unlock()
	if err := workspaceSyncCurrent(begin); err == nil {
		t.Fatal("normal task admitted after transport entered recovery-only mode")
	}
	if err := workspaceSyncCurrent(handback); err != nil {
		t.Fatalf("existing authorized handback lost recovery transport: %v", err)
	}
	if got := syncGitObservationKey(handback, m); got == before || !got.recovery {
		t.Fatal("actual recovery-only transport reused healthy-mode evidence")
	}
}
