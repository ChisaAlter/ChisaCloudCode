//go:build windows

package main

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
)

func syncGitRecoverySessionTestSessions(t *testing.T, sessions ...syncSession) {
	t.Helper()
	if sessions == nil {
		sessions = []syncSession{}
	}
	encoded, err := json.Marshal(sessions)
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("CHISA_CONNECTION_TEST_SESSIONS", string(encoded))
}

func TestSyncGitRecoverySessionRejectsChangedPreviewBeforeMutation(t *testing.T) {
	f := syncGitPreviewConsent(t)
	m := f.mapping
	local, remote := syncSeedSnapshot(t, m.LocalPath, false), syncSeedSnapshot(t, f.remote, false)
	data := syncSeedSnapshot(t, dataDir(), false)
	changed := func(change func(*syncSession)) []syncSession {
		session := f.session
		change(&session)
		return []syncSession{session}
	}
	for _, test := range []struct {
		name     string
		sessions []syncSession
	}{
		{name: "missing"},
		{name: "same-name-replacement", sessions: changed(func(s *syncSession) { s.Identifier = "recreated-session" })},
		{name: "duplicate", sessions: append([]syncSession{f.session}, changed(func(s *syncSession) { s.Identifier = "duplicate-session" })...)},
		{name: "empty-identifier", sessions: changed(func(s *syncSession) { s.Identifier = "" })},
		{name: "unsafe-mode", sessions: changed(func(s *syncSession) { s.Mode = "two-way-resolved" })},
		{name: "vcs-enabled", sessions: changed(func(s *syncSession) { s.Ignore.VCS = false })},
		{name: "changed-local-endpoint", sessions: changed(func(s *syncSession) { s.Alpha.Path += "-other" })},
		{name: "changed-remote-endpoint", sessions: changed(func(s *syncSession) { s.Beta.Path += "-other" })},
		{name: "changed-remote-host", sessions: changed(func(s *syncSession) { s.Beta.Host += "-other" })},
	} {
		t.Run(test.name, func(t *testing.T) {
			syncGitRecoverySessionTestSessions(t, test.sessions...)
			result := (FrontendBridge{}).RecoverProjectGit(m.ServerPath, m.BindingEpoch, f.consent.view.Token, "local")
			if result["ok"] != false || result["code"] != "GIT_RECOVERY_STALE" {
				t.Errorf("changed session escaped recovery admission: %v", result)
			}
			if f.leaseWrites != 0 || f.pauses != 0 || f.synchronizes != 0 {
				t.Errorf("changed session reached a mutation: lease=%d pause=%d sync=%d", f.leaseWrites, f.pauses, f.synchronizes)
			}
			if actual, ok := syncGitRecoveryPreviews.Load(m.ServerPath); !ok || actual != f.consent {
				t.Error("rejected session consumed or replaced the current preview")
			}
		})
	}
	// The same Git evidence and token remain usable when the original exact
	// session is observed again; a different stale prerequisite cannot mask this test.
	if err := validateSyncGitRecovery(f.ctx, m, f.consent); err != nil {
		t.Fatal("unchanged original session rejected:", err)
	}
	if _, ok := syncGitRecoveryPreviews.Load(m.ServerPath); ok {
		t.Error("valid session did not consume the preview")
	}
	queries := &syncPolicyGuardFixture{t: t, logPath: f.calls}
	queries.requireQueriesOnly()
	if len(queries.calls()) == 0 {
		t.Error("recovery never queried the daemon session")
	}
	syncGitPreviewUnchanged(t, m.LocalPath, local)
	syncGitPreviewUnchanged(t, f.remote, remote)
	syncGitPreviewUnchanged(t, dataDir(), data)
}

func TestSyncGitRecoveryOuterSessionPinSurvivesInnerPipeline(t *testing.T) {
	fixture := newSyncPolicyGuardFixture(t)
	m := fixture.mapping
	original := fixture.session()
	fixture.setSessions(original)
	var outerPin *syncSessionIdentity
	prepareCalls, pauseCalls := 0, 0
	prepareProjectSyncSession = func(ctx context.Context, mapping *Mapping) error {
		prepareCalls++
		pinned, _ := ctx.Value(syncSessionIdentityKey{}).(*syncSessionIdentity)
		if pinned == nil || outerPin != nil && pinned != outerPin {
			return errors.New("admission lost the outer session identity")
		}
		outerPin = pinned
		if err := prepareProjectSyncSessionContext(ctx, mapping); err != nil {
			return err
		}
		if pinned.identifier != original.Identifier {
			return errors.New("outer admission did not pin its exact session")
		}
		// Recreate the same valid name/binding immediately after admission.
		// The inner pipeline must not treat it as a fresh first observation.
		replacement := original
		replacement.Identifier = "replacement-after-outer-admission"
		fixture.setSessions(replacement)
		return nil
	}
	pauseProjectSync = func(ctx context.Context, mapping *Mapping) error {
		pauseCalls++
		return pauseProjectSyncContext(ctx, mapping)
	}
	claims, confirms, releases := 0, 0, 0
	claimedID := ""
	var lease map[string]any
	remoteLeaseContext = func(ctx context.Context, mapping *Mapping, op, owner, id string) (map[string]any, error) {
		switch op {
		case "recover":
			claims++
			claimedID = id
			if outerPin == nil || outerPin.identifier != original.Identifier || ctx.Value(syncSessionIdentityKey{}) != outerPin {
				return nil, errors.New("lease claim lost the admitted session identity")
			}
			lease = map[string]any{"owner": owner, "id": id, "epoch": mapping.BindingEpoch}
		case "confirm":
			confirms++
			if ctx.Value(syncSessionIdentityKey{}) != outerPin || outerPin == nil || outerPin.identifier != original.Identifier {
				return nil, errors.New("inner pipeline replaced the outer session identity")
			}
		case "read":
		case "release":
			releases++
			lease = nil
		default:
			return nil, errors.New("unexpected lease operation: " + op)
		}
		return map[string]any{"ok": true, "lease": lease}, nil
	}
	previousObserver := observeSyncGitRemoteMetadata
	observeSyncGitRemoteMetadata = func(context.Context, *Mapping) (syncMetadataObservation, error) {
		return syncMetadataObservation{Git: "stable-non-git-remote"}, nil
	}
	t.Cleanup(func() { observeSyncGitRemoteMetadata = previousObserver })
	synchronizeProjectContext = syncProjectContentsContext
	result := syncProjectWithEmptyConfirmationContext(context.Background(), m.ServerPath, "")
	message, _ := result["error"].(string)
	if result["ok"] != false || !strings.Contains(message, "会话已被替换") {
		t.Errorf("inner pipeline did not reject the recreated session: %v", result)
	}
	if claims != 1 || confirms != 1 || releases != 0 || prepareCalls != 1 || pauseCalls != 1 {
		t.Errorf("unexpected handoff after session replacement: claims=%d confirms=%d releases=%d admissionChecks=%d pauseChecks=%d", claims, confirms, releases, prepareCalls, pauseCalls)
	}
	if outerPin == nil || outerPin.identifier != original.Identifier {
		t.Errorf("outer session identity was lost: %+v", outerPin)
	}
	if fixture.inventories != 0 {
		t.Errorf("recreated session reached policy inventory: %d", fixture.inventories)
	}
	pauses := 0
	for _, args := range fixture.calls() {
		if len(args) >= 2 && args[0] == "sync" && args[1] == "list" {
			continue
		}
		if len(args) == 3 && args[0] == "sync" && args[1] == "pause" && args[2] == original.Identifier {
			pauses++
			continue
		}
		t.Errorf("replacement reached an engine mutation: %q", args)
	}
	if pauses != 0 {
		t.Errorf("read-only admission or rejected cleanup mutated a replaced session: %d", pauses)
	}
	pending, ok := pendingSyncReleases.Load(m.ServerPath)
	if !ok {
		t.Error("unconfirmed original session stop lost its release journal")
	} else if value := pending.(pendingSyncRelease); value.id != claimedID || value.epoch != m.BindingEpoch || !value.needsPause {
		t.Errorf("release recovery lost the original operation: %+v", value)
	}
	if record, err := loadSyncRelease(m); err != nil || record == nil || record.ID != claimedID {
		t.Errorf("durable release journal was not retained: %+v %v", record, err)
	}
}
