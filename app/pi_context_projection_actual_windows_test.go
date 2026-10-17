//go:build actualpi

package main

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// Offline protocol check against the exact installed Pi parser. No prompt is
// submitted, no credentials are read, and only a synthetic private session is edited.
func TestPiLegacyProjectionOfflineActual(t *testing.T) {
	binary, err := piBinaryPath()
	if err != nil {
		t.Fatal(err)
	}
	root := t.TempDir()
	path, original := piLegacySessionFixture(t, root)
	count, err := piExternalizeLegacyContext(path)
	if err != nil || count != 2 {
		t.Fatalf("context migration: edits=%d error=%v", count, err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	cmd := hideCommandWindow(exec.CommandContext(ctx, binary, "--mode", "rpc", "--session", path, "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes"))
	cmd.Dir = root
	cmd.Env = append(os.Environ(), "PI_CODING_AGENT_DIR="+filepath.Join(root, "agent"))
	cmd.Stdin = strings.NewReader("{\"id\":\"state\",\"type\":\"get_state\"}\n{\"id\":\"messages\",\"type\":\"get_messages\"}\n{\"id\":\"entries\",\"type\":\"get_entries\"}\n")
	output, err := cmd.Output()
	if err != nil {
		t.Fatalf("installed Pi offline RPC failed: %v", err)
	}
	responses := map[string]map[string]any{}
	for _, line := range bytes.Split(bytes.TrimSpace(output), []byte{'\n'}) {
		var event map[string]any
		if json.Unmarshal(line, &event) != nil {
			t.Fatal("installed Pi returned invalid RPC output")
		}
		if event["type"] == "response" {
			id, _ := event["id"].(string)
			if event["success"] != true {
				t.Fatalf("installed Pi rejected offline %s", id)
			}
			responses[id], _ = event["data"].(map[string]any)
		}
	}
	if !piStateIdle(responses["state"]) {
		t.Fatal("offline session did not remain idle")
	}
	projected, _ := json.Marshal(responses["messages"]["messages"])
	if len(projected) < 100 {
		t.Fatalf("installed Pi projection response missing messages: %s", output)
	}
	if len(projected) > 10000 || bytes.Contains(projected, []byte("CLAUDE_LEGACY_REFERENCE_ONLY")) {
		t.Fatalf("actual Pi projection retained repeated history: bytes=%d", len(projected))
	}
	for _, marker := range []string{"PI_REQUEST_ONE", "PI_REQUEST_TWO", "PI_TOOL_RESULT_PRESERVED", "PI_ASSISTANT_PRESERVED", "PI_LAST_ANSWER_PRESERVED", "PI_IMAGE_BLOCK_PRESERVED", "read-call"} {
		if !bytes.Contains(projected, []byte(marker)) {
			t.Fatalf("actual Pi projection lost %s; synthetic projection=%s", marker, projected)
		}
	}
	entries, _ := json.Marshal(responses["entries"]["entries"])
	if !bytes.Contains(entries, []byte("CLAUDE_LEGACY_REFERENCE_ONLY")) || !bytes.Contains(entries, []byte("context_edit")) {
		t.Fatal("raw Pi entries lost original history or replacement metadata")
	}
	raw, err := os.ReadFile(path)
	if err != nil || !bytes.HasPrefix(raw, original) {
		t.Fatal("installed Pi or migration rewrote raw original entries")
	}
	t.Logf("installed Pi %s: originalBytes=%d projectedBytes=%d edits=%d; user/assistant/tool/image history retained; modelCalls=0", piVersion, len(original), len(projected), count)
}
