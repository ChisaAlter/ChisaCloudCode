package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

const syncGitRecoveryLeaseBootstrap = `import os, sys, types
try:
    import fcntl
except ImportError:
    import msvcrt
    def flock(guard, mode):
        guard.seek(0)
        msvcrt.locking(guard.fileno(), msvcrt.LK_LOCK, 1)
    sys.modules['fcntl'] = types.SimpleNamespace(LOCK_EX=2, flock=flock)
    os.fchmod = lambda *args: None
exec(compile(sys.argv[1], 'embedded-lease.py', 'exec'), {'__name__': '__main__'})
`

// Run the actual lease worker to exercise the final guarded comparison. A new
// account-server observation must not authorize replacing the preview's lease.
func TestGitRecoveryLeaseCAS(t *testing.T) {
	tools := syncSeedTools(t)
	lease := func(id string) map[string]any {
		return map[string]any{"owner": "sync-needed", "id": id, "epoch": "binding"}
	}
	for _, tc := range []struct {
		name     string
		expected any
		current  any
		allowed  bool
	}{
		{"still-absent", nil, nil, true},
		{"still-same", lease("old"), lease("old"), true},
		{"new-lease-after-absent-preview", nil, lease("new"), false},
		{"replaced-same-epoch", lease("old"), lease("new"), false},
		{"released-after-preview", lease("old"), nil, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			root := filepath.Join(t.TempDir(), "project")
			leaseDir := root + ".chisa-lease"
			stateFile := filepath.Join(leaseDir, "state.json")
			var before []byte
			if tc.current != nil {
				if err := os.MkdirAll(leaseDir, 0700); err != nil {
					t.Fatal(err)
				}
				before, _ = json.Marshal(tc.current)
				if err := os.WriteFile(stateFile, before, 0600); err != nil {
					t.Fatal(err)
				}
			}
			request, _ := json.Marshal(map[string]any{"root": root, "op": "recover", "owner": "sync", "id": "recovery", "epoch": "binding",
				"recoveryLease": tc.expected, "serverChecked": true, "checkedLease": tc.current})
			cmd := exec.Command(tools.python, "-c", syncGitRecoveryLeaseBootstrap, leaseWorker)
			cmd.Env, cmd.Stdin = tools.env, bytes.NewReader(request)
			out, err := cmd.CombinedOutput()
			if err != nil {
				t.Fatalf("lease worker: %v\n%s", err, out)
			}
			var result map[string]any
			if err := json.Unmarshal(out, &result); err != nil {
				t.Fatalf("lease response: %v\n%s", err, out)
			}
			if result["ok"] != tc.allowed {
				t.Fatalf("unexpected lease result: %v", result)
			}
			after, readErr := os.ReadFile(stateFile)
			if !tc.allowed {
				if result["code"] != "GIT_RECOVERY_STALE" {
					t.Fatalf("stale lease lost typed result: %v", result)
				}
				if tc.current == nil {
					if !os.IsNotExist(readErr) {
						t.Fatalf("absent lease was created: %v", readErr)
					}
				} else if readErr != nil || !bytes.Equal(before, after) {
					t.Fatalf("replacement lease was modified: %v\n%s", readErr, after)
				}
				return
			}
			var claimed map[string]any
			if readErr != nil || json.Unmarshal(after, &claimed) != nil || claimed["id"] != "recovery" || claimed["owner"] != "sync" {
				t.Fatalf("matching lease did not complete guarded claim: %v %s", readErr, after)
			}
			if tc.current != nil && fmt.Sprint(claimed["gitSource"]) != "remote" {
				t.Fatalf("handback source was lost: %v", claimed)
			}
		})
	}
}
