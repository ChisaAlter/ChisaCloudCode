package main

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestPiClaudeReferenceStaysOutsideEveryPrompt(t *testing.T) {
	isolatePi(t)
	history := strings.Repeat("Claude 工具：old-output\n", 20000) + "开发完成了？26/26"
	path, err := piWriteClaudeReference("external-context", history)
	if err != nil {
		t.Fatal(err)
	}
	fields, err := piPromptFields("按 docs/features/projects-steward-acceptance.md 在本机走一遍", path, nil)
	if err != nil {
		t.Fatal(err)
	}
	prompt := fields["message"].(string)
	if len(prompt) > 5000 || strings.Contains(prompt, "old-output") || strings.Contains(prompt, "26/26") || !strings.HasSuffix(prompt, "按 docs/features/projects-steward-acceptance.md 在本机走一遍") {
		t.Fatal("Claude history was reinjected or displaced the current request")
	}
	raw, err := os.ReadFile(path)
	if err != nil || !bytes.HasSuffix(raw, []byte(history)) {
		t.Fatal("the full UTF-8 reference was not retained")
	}
	updated, err := piWriteClaudeReference("external-context", "最新上下文")
	if err != nil || updated != path {
		t.Fatal("next turn did not update the same private reference")
	}
	raw, err = os.ReadFile(path)
	if err != nil || strings.Contains(string(raw), "old-output") || !strings.Contains(string(raw), "最新上下文") {
		t.Fatal("reference accumulated duplicate or stale Claude history")
	}
}

func piLegacySessionFixture(t *testing.T, root string) (string, []byte) {
	t.Helper()
	path := filepath.Join(root, "legacy.jsonl")
	legacy := func(request string) string {
		return "当前用户请求：\n" + request + "\n\n本轮任务范围：\n只处理当前请求。\n" + piLegacyClaudeMarker + strings.Repeat("CLAUDE_LEGACY_REFERENCE_ONLY\n", 10000)
	}
	entries := []map[string]any{
		{"type": "session", "version": 3, "id": "legacy-session", "timestamp": "2026-10-16T00:00:00Z", "cwd": root},
		{"type": "message", "id": "user1", "parentId": nil, "timestamp": "2026-10-16T00:00:01Z", "message": map[string]any{"role": "user", "content": legacy("PI_REQUEST_ONE"), "timestamp": 1792108801000}},
		{"type": "message", "id": "toolcall", "parentId": "user1", "timestamp": "2026-10-16T00:00:02Z", "message": map[string]any{"role": "assistant", "content": []any{map[string]any{"type": "toolCall", "id": "read-call", "name": "read", "arguments": map[string]any{"path": "marker.txt"}}}, "stopReason": "toolUse", "timestamp": 1792108802000}},
		{"type": "message", "id": "toolresult", "parentId": "toolcall", "timestamp": "2026-10-16T00:00:03Z", "message": map[string]any{"role": "toolResult", "toolCallId": "read-call", "toolName": "read", "content": []any{map[string]any{"type": "text", "text": "PI_TOOL_RESULT_PRESERVED"}}, "isError": false, "timestamp": 1792108803000}},
		{"type": "message", "id": "assistant1", "parentId": "toolresult", "timestamp": "2026-10-16T00:00:04Z", "message": map[string]any{"role": "assistant", "content": []any{map[string]any{"type": "text", "text": "PI_ASSISTANT_PRESERVED"}}, "stopReason": "stop", "timestamp": 1792108804000}},
		{"type": "message", "id": "user2", "parentId": "assistant1", "timestamp": "2026-10-16T00:00:05Z", "message": map[string]any{"role": "user", "content": []any{map[string]any{"type": "text", "text": legacy("PI_REQUEST_TWO")}, map[string]any{"type": "image", "mimeType": "image/png", "data": "PI_IMAGE_BLOCK_PRESERVED"}}, "timestamp": 1792108805000}},
		{"type": "message", "id": "assistant2", "parentId": "user2", "timestamp": "2026-10-16T00:00:06Z", "message": map[string]any{"role": "assistant", "content": []any{map[string]any{"type": "text", "text": "PI_LAST_ANSWER_PRESERVED"}}, "stopReason": "stop", "timestamp": 1792108806000}},
	}
	var raw bytes.Buffer
	for _, entry := range entries {
		if err := json.NewEncoder(&raw).Encode(entry); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(path, raw.Bytes(), 0600); err != nil {
		t.Fatal(err)
	}
	return path, raw.Bytes()
}

func TestPiLegacyContextEditRetainsRawSessionAndIsIdempotent(t *testing.T) {
	path, original := piLegacySessionFixture(t, t.TempDir())
	count, err := piExternalizeLegacyContext(path)
	if err != nil || count != 2 {
		t.Fatalf("legacy context migration: edits=%d error=%v", count, err)
	}
	raw, err := os.ReadFile(path)
	if err != nil || !bytes.HasPrefix(raw, original) {
		t.Fatal("migration rewrote the original user, assistant, or tool history")
	}
	if count, err := piExternalizeLegacyContext(path); err != nil || count != 0 {
		t.Fatalf("migration appended duplicate replacements: edits=%d error=%v", count, err)
	}
	for _, line := range bytes.Split(bytes.TrimSpace(raw[len(original):]), []byte{'\n'}) {
		var edit map[string]any
		if json.Unmarshal(line, &edit) != nil || edit["type"] != "context_edit" || strings.Contains(string(line), "CLAUDE_LEGACY_REFERENCE_ONLY") {
			t.Fatal("replacement did not externalize only the repeated Claude reference")
		}
	}
}

func TestPiToolEvidenceIncludesIncompleteCallsWithoutDoubleCounting(t *testing.T) {
	m := isolatePi(t)
	s, writer := seedPi(m, "tool-evidence")
	t.Cleanup(func() { _ = writer.Close() })
	for _, id := range []string{"read-ok", "shell-error", "interrupted"} {
		piHandleEvent(s, s.process, map[string]any{"type": "tool_execution_start", "toolCallId": id, "toolName": "read"})
	}
	for range 2 {
		piHandleEvent(s, s.process, map[string]any{"type": "tool_execution_end", "toolCallId": "read-ok", "toolName": "read", "isError": false})
		piHandleEvent(s, s.process, map[string]any{"type": "tool_execution_end", "toolCallId": "shell-error", "toolName": "powershell", "isError": true})
	}
	finishPi(s, "这只是本轮观察，不表示验收通过。", "stop", "")
	waitPi(t, func() bool { return (FrontendBridge{}).PiGetSession(m.ServerPath, s.SessionID)["owner"] == "claude" })
	last := (FrontendBridge{}).PiGetSession(m.ServerPath, s.SessionID)["lastResult"].(map[string]any)
	if last["toolCalls"] != 3 || last["successfulToolCalls"] != 1 || last["failedToolCalls"] != 1 || len(last["observedToolFailures"].([]map[string]any)) != 1 {
		t.Fatalf("tool evidence invented outcomes or duplicated events: %v", last)
	}
	if response := (FrontendBridge{}).PiPrompt(m.ServerPath, s.SessionID, "只回答这个问题", "Claude 旧数字26/26", nil); response["accepted"] != true {
		t.Fatal("next turn was not accepted")
	}
	// This private fake rejects the prompt RPC, so the next turn fails before
	// model execution. The failed run must still have its own zero-call evidence.
	waitPi(t, func() bool { return (FrontendBridge{}).PiGetSession(m.ServerPath, s.SessionID)["owner"] == "claude" })
	last = (FrontendBridge{}).PiGetSession(m.ServerPath, s.SessionID)["lastResult"].(map[string]any)
	if last["toolCalls"] != 0 || last["successfulToolCalls"] != 0 || last["failedToolCalls"] != 0 || last["stopReason"] != "" {
		t.Fatal("new turn inherited the previous run's tool or stop evidence")
	}
}
