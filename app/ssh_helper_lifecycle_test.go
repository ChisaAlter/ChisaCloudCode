package main

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func helperTestAgent(t *testing.T) *localWorkspaceAgent {
	t.Helper()
	t.Setenv("LOCALAPPDATA", t.TempDir())
	raw, err := os.ReadFile(filepath.Join("resources", "ssh-workspace.ps1"))
	if err != nil {
		t.Fatal(err)
	}
	// GetFolderPath uses the Windows known-folder API rather than LOCALAPPDATA.
	// Redirect only the copied test helper's job store into this test directory.
	jobBase := filepath.Join(os.Getenv("LOCALAPPDATA"), "ChisaCloudCode", "ssh-workspace-jobs", "v1")
	raw = []byte(strings.Replace(string(raw), "$script:JobBase=[IO.Path]::Combine([Environment]::GetFolderPath('LocalApplicationData'),'ChisaCloudCode','ssh-workspace-jobs','v1')", "$script:JobBase='"+strings.ReplaceAll(jobBase, "'", "''")+"'", 1))
	path := filepath.Join(t.TempDir(), "ssh-workspace.ps1")
	if err := os.WriteFile(path, raw, 0600); err != nil {
		t.Fatal(err)
	}
	a, err := startLocalWorkspaceAgentWithHelper(0, path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { a.Close() })
	return a
}
func helperCall(t *testing.T, a *localWorkspaceAgent, root string, request any) map[string]any {
	t.Helper()
	payload, _ := json.Marshal(map[string]any{"protocol": 1, "rootPath": root, "generation": "test-generation", "request": request})
	raw, err := a.runHelper(context.Background(), payload)
	if err != nil {
		t.Fatal(err)
	}
	var result map[string]any
	if err := json.Unmarshal(raw, &result); err != nil {
		t.Fatal(string(raw), err)
	}
	return result
}
func TestSshHelperInvalidCommandRefusalDoesNotWedgeClaim(t *testing.T) {
	a := helperTestAgent(t)
	root := t.TempDir()
	id := "a1111111-1111-4111-8111-111111111111"
	r := helperCall(t, a, root, map[string]any{"op": "exec", "jobId": id, "path": "/workspace/missing", "command": "Write-Output 'must not run'"})
	if r["ok"] != false || r["rootIdentity"] == nil {
		t.Fatal(r)
	}
	claim := filepath.Join(os.Getenv("LOCALAPPDATA"), "ChisaCloudCode", "ssh-workspace-jobs", "v1", id, "claimed")
	if _, err := os.Stat(claim); !os.IsNotExist(err) {
		t.Fatal("refused invalid cwd left permanent claim", err)
	}
	r = helperCall(t, a, root, map[string]any{"op": "job_cancel", "jobId": id})
	if r["cleanupConfirmed"] != true || r["state"] != "cancelled" {
		t.Fatal(r)
	}
	r = helperCall(t, a, root, map[string]any{"op": "exec", "jobId": id, "path": "/workspace", "command": "Write-Output 'must not replay'"})
	if r["ok"] != false || r["code"] != "SSH_JOB_EXISTS" {
		t.Fatal(r)
	}
}
func TestSshHelperDeadV2ClaimRecoversButOldUnmarkedClaimStaysUncertain(t *testing.T) {
	a := helperTestAgent(t)
	root := t.TempDir()
	probe := helperCall(t, a, root, map[string]any{"op": "probe"})
	identity, ok := probe["rootIdentity"].(string)
	if !ok || identity == "" {
		t.Fatal(probe)
	}
	for i, id := range []string{"a2222222-2222-4222-8222-222222222222", "a3333333-3333-4333-8333-333333333333"} {
		dir := filepath.Join(os.Getenv("LOCALAPPDATA"), "ChisaCloudCode", "ssh-workspace-jobs", "v1", id)
		if err := os.MkdirAll(dir, 0700); err != nil {
			t.Fatal(err)
		}
		marker := ""
		if i == 0 {
			marker = "claim-v2:" + identity
		}
		if err := os.WriteFile(filepath.Join(dir, "claimed"), []byte(marker), 0600); err != nil {
			t.Fatal(err)
		}
		r := helperCall(t, a, root, map[string]any{"op": "job_cancel", "jobId": id})
		if i == 0 {
			if r["cleanupConfirmed"] != true || r["state"] != "interrupted" {
				t.Fatal(r)
			}
		} else if r["cleanupConfirmed"] != false {
			t.Fatal("unmarked old claim assumed dead", r)
		}
	}
}
func TestSshHelperExecPostClaimFailureHasTerminalReceipt(t *testing.T) {
	a := helperTestAgent(t)
	root := t.TempDir()
	id := "a4444444-4444-4444-8444-444444444444"
	// An unavailable command fails in the owned child after the claim. It must
	// remain recoverable even though the operation did not return exit zero.
	r := helperCall(t, a, root, map[string]any{"op": "exec", "jobId": id, "path": "/workspace", "argv": []string{"definitely-no-such-chisa-executable"}, "timeoutSeconds": 5})
	if r["ok"] != true || r["cleanupConfirmed"] != true || r["exitCode"] == float64(0) {
		t.Fatal(r)
	}
	r = helperCall(t, a, root, map[string]any{"op": "job_status", "jobId": id})
	if r["cleanupConfirmed"] != true || r["state"] != "completed" {
		t.Fatal(r)
	}
}
