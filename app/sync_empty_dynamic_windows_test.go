//go:build windows

package main

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestDynamicEmptyConfirmationRequiresFreshSnapshot(t *testing.T) {
	fixture := newSyncPolicyGuardFixture(t)
	session := fixture.session()
	session.Paused = true
	session.Status = "halted-on-root-emptied"
	session.Alpha = syncEndpoint{Path: fixture.mapping.LocalPath, Connected: true, Scanned: true, Directories: 1}
	session.Beta.Connected, session.Beta.Scanned, session.Beta.Directories, session.Beta.Files = true, true, 1, 1
	fixture.setSessions(session)
	if err := os.WriteFile(filepath.Join(fixture.mapping.LocalPath, "future.log"), []byte("local ignored bytes"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := projectEmptySession(context.Background(), fixture.mapping); err != nil {
		t.Fatalf("dynamic preview used live marker as static policy: %v", err)
	}
	pendingEmptyConfirmations.Store(fixture.mapping.ServerPath, pendingEmptyConfirmation{epoch: fixture.mapping.BindingEpoch, session: session})
	t.Cleanup(func() { pendingEmptyConfirmations.Delete(fixture.mapping.ServerPath) })
	if _, valid := pendingProjectEmpty(fixture.mapping, session); !valid {
		t.Fatal("dynamic pending consent was discarded using stale static rules")
	}
	previous := confirmedEmptyIgnorePatterns
	defer func() { confirmedEmptyIgnorePatterns = previous }()
	calls := 0
	confirmedEmptyIgnorePatterns = func(context.Context, *Mapping) ([]string, error) {
		calls++
		return []string{".git", "node_modules", ".env"}, nil
	}
	if err := os.WriteFile(filepath.Join(fixture.mapping.LocalPath, "new-source.txt"), []byte("keep"), 0600); err != nil {
		t.Fatal(err)
	}
	result, err := clearConfirmedProject(context.Background(), fixture.mapping, session)
	if err == nil || result.ClearState != "not-started" || calls != 1 {
		t.Fatalf("clear bypassed fresh snapshot/local-content barrier: %+v %v snapshots=%d", result, err, calls)
	}
	fixture.requireQueriesOnly()
}

func TestDynamicClearWorkerRechecksReceiverIgnorePolicyBeforeQuarantine(t *testing.T) {
	for _, kind := range []string{"newly-ignored", "one-index-force", "locked", "protected"} {
		t.Run(kind, func(t *testing.T) {
			tools, m, _, _ := syncGitHeadFixture(t)
			if err := os.WriteFile(filepath.Join(m.LocalPath, ".gitignore"), []byte("*.log\n"), 0600); err != nil {
				t.Fatal(err)
			}
			name := "future.log"
			if kind == "protected" {
				name = ".env"
			}
			if err := os.WriteFile(filepath.Join(m.LocalPath, name), []byte("preserve-or-quarantine"), 0600); err != nil {
				t.Fatal(err)
			}
			if kind == "locked" {
				if err := os.WriteFile(filepath.Join(m.LocalPath, ".git", "index.lock"), []byte("foreign lock"), 0600); err != nil {
					t.Fatal(err)
				}
			}
			request := map[string]any{"root": m.LocalPath, "op": "list", "directories": []string{""}}
			input, _ := json.Marshal(request)
			stdout, stderr, err := tools.command(t, input, tools.python, "-c", confirmEmptyWorker)
			if err != nil {
				t.Fatal(err, stderr)
			}
			var inventory struct {
				Entries     []syncEmptyEntry    `json:"entries"`
				Directories map[string][]string `json:"directories"`
			}
			if err := json.Unmarshal([]byte(stdout), &inventory); err != nil {
				t.Fatal(err)
			}
			var selected []syncEmptyEntry
			for _, entry := range inventory.Entries {
				if entry.Path == name {
					selected = append(selected, entry)
				}
			}
			if len(selected) != 1 {
				t.Fatal("fixture candidate missing")
			}
			tracked := []string{}
			if kind == "one-index-force" {
				tracked = []string{name}
			}
			id := "ab12cd34"
			request = map[string]any{"root": m.LocalPath, "op": "move", "id": id, "epoch": "private-fixture", "entries": selected, "directories": inventory.Directories, "gitPolicy": true, "tracked": tracked}
			input, _ = json.Marshal(request)
			stdout, stderr, err = tools.command(t, input, tools.python, "-c", confirmEmptyWorker)
			if err != nil {
				t.Fatal(err, stderr)
			}
			var moved syncEmptyResult
			if err := json.Unmarshal([]byte(stdout), &moved); err != nil {
				t.Fatal(err, stdout)
			}
			if kind == "one-index-force" {
				if moved.ClearState != "completed" || moved.Error != "" {
					t.Fatalf("explicit force-track was not respected: %+v", moved)
				}
				data, err := os.ReadFile(filepath.Join(m.LocalPath+".chisa-sync-backups", id, "files", name))
				if err != nil || string(data) != "preserve-or-quarantine" {
					t.Fatal("quarantine lost bytes", err)
				}
				t.Cleanup(func() {
					owned := m.LocalPath + ".chisa-sync-backups"
					if !strings.HasPrefix(owned, filepath.Dir(m.LocalPath)+string(filepath.Separator)) {
						t.Error("unexpected fixture backup path")
						return
					}
					if err := os.RemoveAll(owned); err != nil {
						t.Error(err)
					}
				})
			} else {
				if moved.ClearState != "not-started" || moved.Error == "" {
					t.Fatalf("unsafe clear accepted %s: %+v", kind, moved)
				}
				if data, err := os.ReadFile(filepath.Join(m.LocalPath, name)); err != nil || string(data) != "preserve-or-quarantine" {
					t.Fatal("protected bytes changed", err)
				}
				if kind == "locked" {
					if data, err := os.ReadFile(filepath.Join(m.LocalPath, ".git", "index.lock")); err != nil || string(data) != "foreign lock" {
						t.Fatal("foreign lock changed", err)
					}
				}
			}
		})
	}
}
