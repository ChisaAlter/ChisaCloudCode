package main

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func TestPiHandoffChoosesObservedChangePathAndIsIdempotent(t *testing.T) {
	for _, scenario := range []string{"unchanged", "partial-failed-shell-write", "observation-failed", "restarted-no-baseline", "stale-binding"} {
		t.Run(scenario, func(t *testing.T) {
			m, _ := piWorkspaceFixture(t)
			piWorkspaceWrite(t, m.LocalPath, "source.txt", "before")
			s, writer := seedPi(m, "handoff-path")
			t.Cleanup(func() { _ = writer.Close() })
			s.Running, s.LeaseID = false, "exact-pi-lease"
			s.LastResult = map[string]any{"status": "completed", "content": "model response"}
			s.workspaceBaseline = piWorkspaceCapture(t, m)
			switch scenario {
			case "partial-failed-shell-write":
				// No edit/write event exists. A failed PowerShell call can still
				// leave a real synchronized file change that must be handed back.
				piWorkspaceWrite(t, m.LocalPath, "source.txt", "partially written before exit 9")
				piHandleEvent(s, s.process, map[string]any{"type": "tool_execution_end", "toolName": "powershell", "toolCallId": "partial", "isError": true})
			case "observation-failed":
				piWorkspaceSyncSessions = func(context.Context, string) ([]syncSession, error) { return nil, errors.New("snapshot unavailable") }
			case "restarted-no-baseline":
				s.workspaceBaseline = nil
			case "stale-binding":
				m.BindingEpoch = "replacement-binding"
			}
			operations := []string{}
			synchronizeProjectContext = func(_ context.Context, actual *Mapping, pause bool) error {
				if actual.ServerPath != m.ServerPath || actual.BindingEpoch != m.BindingEpoch || pause {
					t.Fatal("handback synchronized the wrong mapping")
				}
				operations = append(operations, "sync")
				return nil
			}
			piWorkspaceResumeSync = func(context.Context, string) error { operations = append(operations, "resume"); return nil }
			remoteLeaseContext = func(_ context.Context, actual *Mapping, op, owner, id string) (map[string]any, error) {
				if actual.ServerPath != m.ServerPath || actual.BindingEpoch != m.BindingEpoch || owner != "pi" || id != "exact-pi-lease" {
					t.Fatal("handback lost its exact Pi lease")
				}
				operations = append(operations, op)
				return map[string]any{"ok": true, "lease": map[string]any{"owner": "pi", "id": id, "epoch": m.BindingEpoch}}, nil
			}
			err := piReleaseWorkspace(s, s.runID)
			if scenario == "stale-binding" {
				if err == nil || len(operations) != 0 || s.Owner != "pi" || s.LeaseID == "" {
					t.Fatal("stale binding was synchronized or released")
				}
				return
			}
			want := []string{"sync", "release"}
			if scenario == "unchanged" {
				want = []string{"confirm", "resume", "release"}
			}
			if err != nil || !reflect.DeepEqual(operations, want) || s.Owner != "claude" || s.LeaseID != "" || s.LastResult["workspaceStatus"] != "released" {
				t.Fatalf("wrong handback path: operations=%v want=%v error=%v", operations, want, err)
			}
			before, _ := json.Marshal(s.LastResult)
			cursor := s.Cursor
			if err := piReleaseWorkspace(s, s.runID); err != nil {
				t.Fatal(err)
			}
			after, _ := json.Marshal(s.LastResult)
			if string(before) != string(after) || cursor != s.Cursor || !reflect.DeepEqual(operations, want) {
				t.Fatal("duplicate handback replayed sync/release or rewrote the result")
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
			m, _ := piWorkspaceFixture(t)
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
			prepared, full, resumed, released := 0, 0, 0, 0
			synchronizeProjectContext = func(_ context.Context, _ *Mapping, pause bool) error {
				if pause {
					prepared++
					if scenario == "cancelled-after-preparation" {
						cancel()
					}
				} else {
					full++
				}
				return nil
			}
			piWorkspaceResumeSync = func(context.Context, string) error { resumed++; return nil }
			remoteLeaseContext = func(_ context.Context, _ *Mapping, op, owner, id string) (map[string]any, error) {
				if op == "release" {
					if owner != "pi" {
						t.Fatal("prepared rejection dropped its lease without Pi handback")
					}
					released++
					if scenario == "reference-failure-and-release-fails" {
						return nil, errors.New("exact release unconfirmed")
					}
				}
				return map[string]any{"ok": true, "lease": map[string]any{"id": id, "epoch": m.BindingEpoch, "owner": "pi"}}, nil
			}
			view := piStartLockedContext(ctx, m, sessionID, "must not start a model", "Claude reference", attachments)
			last, _ := view["lastResult"].(map[string]any)
			if prepared != 1 || view["ok"] != false || view["running"] != false || view["runtimeActive"] != false || last["status"] != "error" || last["toolCalls"] != 0 || released != 1 {
				t.Fatalf("rejected request did not use authoritative handback: %v prepare=%d resume=%d full=%d release=%d", view, prepared, resumed, full, released)
			}
			if scenario == "cancelled-after-preparation" {
				if resumed != 0 || full != 1 {
					t.Fatal("cancelled baseline observation did not keep full recovery")
				}
			} else if resumed != 1 || full != 0 {
				t.Fatal("unchanged rejected request unnecessarily resynchronized")
			}
			if scenario == "reference-failure-and-release-fails" {
				if view["owner"] != "pi" || view["code"] != "PI_HANDOFF_FAILED" || last["workspaceStatus"] != "failed" || !piWorkspaceOwned(m.ServerPath) {
					t.Fatal("unconfirmed prepared rejection lost its recovery reservation")
				}
			} else if view["owner"] != "claude" || last["workspaceStatus"] != "released" || piWorkspaceOwned(m.ServerPath) {
				t.Fatal("rejected request left synchronization paused without visible ownership")
			}
		})
	}
}
