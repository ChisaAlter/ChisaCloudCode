package main

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func TestPiHandoffSynchronizesActiveWatcherOnceAndIsIdempotent(t *testing.T) {
	for _, scenario := range []string{"unchanged", "legacy-baseline", "partial-failed-shell-write", "restarted-no-baseline", "release-pending", "stale-binding", "stale-local-path", "stale-sync-name", "stale-baseline-epoch", "stale-baseline-server-path"} {
		t.Run(scenario, func(t *testing.T) {
			m, session := piWorkspaceFixture(t)
			session.Paused = false
			piWorkspaceWrite(t, m.LocalPath, "source.txt", "before")
			s, writer := seedPi(m, "handoff-path")
			t.Cleanup(func() { _ = writer.Close() })
			s.Running, s.LeaseID = false, "exact-pi-lease"
			s.LastResult = map[string]any{"status": "completed", "content": "model response"}
			s.workspaceBaseline = &piWorkspaceSnapshot{
				localPath: m.LocalPath, serverPath: m.ServerPath, serverID: m.ServerID,
				epoch: m.BindingEpoch, syncName: m.SyncName,
			}
			switch scenario {
			case "legacy-baseline":
				s.workspaceBaseline.session = *session
				s.workspaceBaseline.session.Paused = true
				s.workspaceBaseline.files = map[string]piWorkspaceFile{"source.txt": {size: 6}}
			case "partial-failed-shell-write":
				// No edit/write event exists. A failed PowerShell call can still
				// leave a real synchronized file change that must be handed back.
				piWorkspaceWrite(t, m.LocalPath, "source.txt", "partially written before exit 9")
				piHandleEvent(s, s.process, map[string]any{"type": "tool_execution_end", "toolName": "powershell", "toolCallId": "partial", "isError": true})
			case "restarted-no-baseline":
				s.workspaceBaseline = nil
			case "release-pending":
				s.HandoffPhase = piHandoffReleasePending
			case "stale-binding":
				m.BindingEpoch = "replacement-binding"
			case "stale-local-path":
				m.LocalPath = t.TempDir()
			case "stale-sync-name":
				m.SyncName = "replacement-sync-session"
			case "stale-baseline-epoch":
				s.workspaceBaseline.epoch = "another-binding"
			case "stale-baseline-server-path":
				s.workspaceBaseline.serverPath = "/srv/another-project"
			}
			observations := 0
			piWorkspaceSyncSessions = func(context.Context, string) ([]syncSession, error) {
				observations++
				return []syncSession{*session}, nil
			}
			operations := []string{}
			synchronizeProjectContext = func(ctx context.Context, actual *Mapping, pause bool) error {
				if actual == nil || *actual != *m || ctx.Value(syncLeaseContextKey{}) != "exact-pi-lease" || pause || session.Paused {
					t.Fatal("handback lost the active watcher, mapping or exact Pi lease")
				}
				operations = append(operations, "sync")
				return nil
			}
			piWorkspaceResumeSync = func(context.Context, string) error {
				t.Fatal("handback resumed through the retired snapshot shortcut")
				return nil
			}
			remoteLeaseContext = func(_ context.Context, actual *Mapping, op, owner, id string) (map[string]any, error) {
				if actual == nil || *actual != *m || op != "release" || owner != "pi" || id != "exact-pi-lease" {
					t.Fatal("handback lost its exact Pi lease or bypassed unified synchronization")
				}
				if durable := readPiRepairState(t, s.SessionID); durable.HandoffPhase != piHandoffReleasePending || durable.LeaseID != id {
					t.Fatal("lease release preceded its durable recovery phase")
				}
				operations = append(operations, op)
				return map[string]any{"ok": true}, nil
			}
			err := piReleaseWorkspace(s, s.runID)
			if observations != 0 || session.Paused {
				t.Fatal("Pi handback observed the full-tree snapshot or paused the watcher")
			}
			if strings.HasPrefix(scenario, "stale-") {
				if err == nil || len(operations) != 0 || s.Owner != "pi" || s.LeaseID == "" || s.LastResult["workspaceStatus"] != "failed" {
					t.Fatal("stale binding was synchronized or released")
				}
				return
			}
			want := []string{"sync", "release"}
			if scenario == "release-pending" {
				want = []string{"release"}
			}
			if err != nil || !reflect.DeepEqual(operations, want) || s.Owner != "claude" || s.LeaseID != "" || s.HandoffPhase != "" || s.LastResult["workspaceStatus"] != "released" {
				t.Fatalf("wrong handback path: operations=%v want=%v error=%v", operations, want, err)
			}
			before, _ := json.Marshal(s.LastResult)
			cursor := s.Cursor
			if err := piReleaseWorkspace(s, s.runID); err != nil {
				t.Fatal(err)
			}
			after, _ := json.Marshal(s.LastResult)
			if string(before) != string(after) || cursor != s.Cursor || !reflect.DeepEqual(operations, want) || observations != 0 {
				t.Fatal("duplicate handback replayed synchronization or rewrote the result")
			}
		})
	}
}

func TestPiAbortHandbackFailureReturnsAuthoritativeSnapshot(t *testing.T) {
	m := isolatePi(t)
	s, _ := seedPi(m, "abort-failed-handback")
	s.Running, s.LeaseID = false, "retained-pi-lease"
	s.LastResult = map[string]any{"status": "completed", "content": "prior model response"}
	synchronizeProjectContext = func(context.Context, *Mapping, bool) error { return errors.New("return sync failed") }
	view := (FrontendBridge{}).PiAbort(m.ServerPath, s.SessionID)
	last, _ := view["lastResult"].(map[string]any)
	if view["ok"] != false || view["code"] != "PI_STOP_FAILED" || view["owner"] != "pi" || view["running"] != false || view["runtimeActive"] != false || last["workspaceStatus"] != "failed" || last["content"] != "prior model response" || s.LeaseID == "" {
		t.Fatalf("failed stop response hid retained ownership or existing outcome: %v", view)
	}
}

func TestPiAbortRunningTaskKeepsStoppedResultAcrossFailedHandbackAndRecovery(t *testing.T) {
	m := isolatePi(t)
	s, _ := seedPi(m, "abort-active-failed-handback")
	s.LeaseID = "active-exact-pi-lease"
	piHandleEvent(s, s.process, map[string]any{"type": "message_start", "message": map[string]any{"role": "assistant", "content": "已经读到一部分，命令尚未结束。"}})
	piHandleEvent(s, s.process, map[string]any{"type": "tool_execution_start", "toolCallId": "read", "toolName": "read"})
	piHandleEvent(s, s.process, map[string]any{"type": "tool_execution_end", "toolCallId": "read", "toolName": "read", "isError": false})
	piHandleEvent(s, s.process, map[string]any{"type": "tool_execution_start", "toolCallId": "shell-pending", "toolName": "powershell"})
	synchronizeProjectContext = func(context.Context, *Mapping, bool) error {
		return errors.New("handback failed after confirmed shutdown")
	}
	stopped := (FrontendBridge{}).PiAbort(m.ServerPath, s.SessionID)
	last, _ := stopped["lastResult"].(map[string]any)
	if stopped["ok"] != false || stopped["running"] != false || stopped["runtimeActive"] != false || stopped["owner"] != "pi" || last["status"] != "aborted" || last["content"] != "已经读到一部分，命令尚未结束。" || last["toolCalls"] != 2 || last["successfulToolCalls"] != 1 || last["failedToolCalls"] != 0 || last["stopReason"] != "" || last["workspaceStatus"] != "failed" {
		t.Fatalf("failed handback replaced confirmed stop or lost partial/tool evidence: %v", stopped)
	}
	raw, err := os.ReadFile(filepath.Join(piSessionDirectory(s.SessionID), "state.json"))
	var durable piSession
	if err != nil || json.Unmarshal(raw, &durable) != nil || durable.LastResult["status"] != "aborted" || durable.LastResult["content"] != last["content"] || durable.LastResult["toolCalls"] != float64(2) {
		t.Fatal("confirmed stop and evidence were not durable before failed handback")
	}
	synchronizeProjectContext = func(context.Context, *Mapping, bool) error { return nil }
	recovered := (FrontendBridge{}).PiRecoverSession(m.ServerPath, s.SessionID)
	last, _ = recovered["lastResult"].(map[string]any)
	if recovered["ok"] != true || recovered["owner"] != "claude" || last["status"] != "aborted" || last["workspaceStatus"] != "released" || last["content"] != "已经读到一部分，命令尚未结束。" || last["toolCalls"] != 2 || last["successfulToolCalls"] != 1 {
		t.Fatalf("recovery erased or relabelled the stopped turn: %v", recovered)
	}
}

func TestPiPreparedRequestRejectionAlwaysHandsBackOrRetainsRecovery(t *testing.T) {
	for _, scenario := range []string{"reference-file-failure", "attachment-failure", "cancelled-after-preparation", "reference-failure-and-release-fails"} {
		t.Run(scenario, func(t *testing.T) {
			m, session := piWorkspaceFixture(t)
			session.Paused = false
			observations := 0
			piWorkspaceSyncSessions = func(context.Context, string) ([]syncSession, error) {
				observations++
				return []syncSession{*session}, nil
			}
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			const sessionID = "rejected-after-prepare"
			attachments := []piAttachmentInput{}
			if scenario == "attachment-failure" {
				attachments = append(attachments, piAttachmentInput{Name: "bad.txt", DataBase64: "not base64!"})
			} else if scenario != "cancelled-after-preparation" {
				if err := os.MkdirAll(filepath.Join(piSessionDirectory(sessionID), "claude-reference.txt"), 0700); err != nil {
					t.Fatal(err)
				}
			}
			prepared, handbacks, released := 0, 0, 0
			leaseID := ""
			synchronizeProjectContext = func(syncCtx context.Context, actual *Mapping, pause bool) error {
				if actual == nil || *actual != *m || leaseID == "" || syncCtx.Value(syncLeaseContextKey{}) != leaseID || session.Paused {
					t.Fatal("prepared rejection lost the active watcher or exact lease")
				}
				if pause {
					prepared++
					if scenario == "cancelled-after-preparation" {
						cancel()
					}
				} else {
					handbacks++
				}
				return nil
			}
			piWorkspaceResumeSync = func(context.Context, string) error {
				t.Fatal("prepared rejection used the retired snapshot shortcut")
				return nil
			}
			remoteLeaseContext = func(_ context.Context, actual *Mapping, op, owner, id string) (map[string]any, error) {
				if actual == nil || *actual != *m || owner != "pi" || id == "" {
					t.Fatal("prepared rejection touched another project or lease")
				}
				switch op {
				case "claim":
					leaseID = id
				case "release":
					if id != leaseID || handbacks != 1 {
						t.Fatal("prepared rejection dropped its lease without unified handback")
					}
					released++
					if scenario == "reference-failure-and-release-fails" {
						return nil, errors.New("exact release unconfirmed")
					}
				default:
					t.Fatalf("prepared rejection used an unexpected lease operation: %s", op)
				}
				return map[string]any{"ok": true, "lease": map[string]any{"id": id, "epoch": m.BindingEpoch, "owner": "pi"}}, nil
			}
			view := piStartLockedContext(ctx, m, sessionID, "must not start a model", "Claude reference", attachments)
			last, _ := view["lastResult"].(map[string]any)
			if prepared != 1 || handbacks != 1 || observations != 0 || session.Paused || view["ok"] != false || view["running"] != false || view["runtimeActive"] != false || last["status"] != "error" || last["toolCalls"] != 0 || released != 1 {
				t.Fatalf("rejected request did not use authoritative active handback: %v prepare=%d handback=%d observations=%d release=%d", view, prepared, handbacks, observations, released)
			}
			if scenario == "reference-failure-and-release-fails" {
				if view["owner"] != "pi" || view["code"] != "PI_HANDOFF_FAILED" || last["workspaceStatus"] != "failed" || !piWorkspaceOwned(m.ServerPath) {
					t.Fatal("unconfirmed prepared rejection lost its recovery reservation")
				}
			} else if view["owner"] != "claude" || last["workspaceStatus"] != "released" || piWorkspaceOwned(m.ServerPath) {
				t.Fatal("rejected request retained its workspace reservation")
			}
		})
	}
}
