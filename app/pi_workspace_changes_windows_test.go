package main

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func piWorkspaceFixture(t *testing.T) (*Mapping, *syncSession) {
	t.Helper()
	m := isolatePi(t)
	m.SyncName = "pi-private-sync"
	session := &syncSession{Name: m.SyncName, Identifier: "private-engine-id", Mode: "two-way-safe", Paused: true}
	session.Alpha.Path = m.LocalPath
	session.Beta.Path, session.Beta.Protocol, session.Beta.Host = m.ServerPath, "ssh", syncSSHAlias(store.config())
	session.Ignore.Paths = []string{"node_modules", "build", "!/build", "/build/*", "!/build/source.txt", ".git", ".env", ".env.*", "!.env.example"}
	session.Ignore.VCS = true
	previousSessions, previousResume := piWorkspaceSyncSessions, piWorkspaceResumeSync
	piWorkspaceSyncSessions = func(context.Context, string) ([]syncSession, error) { return []syncSession{*session}, nil }
	t.Cleanup(func() {
		piWorkspaceSyncSessions, piWorkspaceResumeSync = previousSessions, previousResume
		syncStates.Delete(m.ServerPath)
	})
	return m, session
}

func piWorkspaceWrite(t *testing.T, root, relative, content string) {
	t.Helper()
	name := filepath.Join(root, relative)
	if err := os.MkdirAll(filepath.Dir(name), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(name, []byte(content), 0600); err != nil {
		t.Fatal(err)
	}
}

func piWorkspaceCapture(t *testing.T, m *Mapping) *piWorkspaceSnapshot {
	t.Helper()
	snapshot, err := capturePiWorkspace(context.Background(), m)
	if err != nil {
		t.Fatal(err)
	}
	return snapshot
}

func piWorkspaceExpectChanged(t *testing.T, snapshot *piWorkspaceSnapshot, m *Mapping, want bool) {
	t.Helper()
	changed, err := snapshot.changed(context.Background(), m)
	if err != nil || changed != want {
		t.Fatalf("workspace changed=%t, want=%t, error=%v", changed, want, err)
	}
}

func piWorkspaceShell(t *testing.T, m *Mapping, command string, wantFailure bool) {
	t.Helper()
	cmd := hideCommandWindow(exec.Command(filepath.Join(os.Getenv("SystemRoot"), "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command))
	cmd.Dir = m.LocalPath
	output, err := cmd.CombinedOutput()
	if (err != nil) != wantFailure {
		t.Fatalf("PowerShell failure=%t want=%t: %s, %v", err != nil, wantFailure, output, err)
	}
}

func TestPiWorkspaceUnchangedChatReadAndReadOnlyShell(t *testing.T) {
	m, _ := piWorkspaceFixture(t)
	piWorkspaceWrite(t, m.LocalPath, "source.txt", "current project")
	snapshot := piWorkspaceCapture(t, m)
	piWorkspaceExpectChanged(t, snapshot, m, false) // Pure chat did not touch the tree.
	if _, err := os.ReadFile(filepath.Join(m.LocalPath, "source.txt")); err != nil {
		t.Fatal(err)
	}
	piWorkspaceExpectChanged(t, snapshot, m, false)
	piWorkspaceShell(t, m, "[IO.File]::ReadAllText((Join-Path (Get-Location) 'source.txt'))", false)
	piWorkspaceExpectChanged(t, snapshot, m, false)
}

func TestPiWorkspaceDetectsWritesDeletesRenamesAndRestoredMtime(t *testing.T) {
	for _, operation := range []string{"shell-write", "partial-shell-failure", "delete", "rename", "same-size-restored-mtime"} {
		t.Run(operation, func(t *testing.T) {
			m, _ := piWorkspaceFixture(t)
			piWorkspaceWrite(t, m.LocalPath, "source.txt", "before")
			snapshot := piWorkspaceCapture(t, m)
			name := filepath.Join(m.LocalPath, "source.txt")
			switch operation {
			case "shell-write":
				piWorkspaceShell(t, m, "[IO.File]::WriteAllText((Join-Path (Get-Location) 'new.txt'),'actual shell write')", false)
			case "partial-shell-failure":
				piWorkspaceShell(t, m, "[IO.File]::WriteAllText((Join-Path (Get-Location) 'source.txt'),'partial write'); exit 9", true)
			case "delete":
				if err := os.Remove(name); err != nil {
					t.Fatal(err)
				}
			case "rename":
				if err := os.Rename(name, filepath.Join(m.LocalPath, "renamed.txt")); err != nil {
					t.Fatal(err)
				}
			case "same-size-restored-mtime":
				before, err := os.Stat(name)
				if err != nil {
					t.Fatal(err)
				}
				piWorkspaceWrite(t, m.LocalPath, "source.txt", "after!")
				if err := os.Chtimes(name, before.ModTime(), before.ModTime()); err != nil {
					t.Fatal(err)
				}
			}
			piWorkspaceExpectChanged(t, snapshot, m, true)
		})
	}
}

func TestPiWorkspaceIgnoresGeneratedSecretsAndVCSButKeepsExceptions(t *testing.T) {
	m, _ := piWorkspaceFixture(t)
	piWorkspaceWrite(t, m.LocalPath, "source.txt", "keep")
	// Keep the exception directory present before the baseline: its existence
	// is synchronized even though its untracked generated children are not.
	if err := os.Mkdir(filepath.Join(m.LocalPath, "build"), 0700); err != nil {
		t.Fatal(err)
	}
	snapshot := piWorkspaceCapture(t, m)
	for _, name := range []string{"node_modules/dep/cache.txt", "build/output.txt", ".env", ".env.private", ".hg/metadata"} {
		piWorkspaceWrite(t, m.LocalPath, name, "ignored")
	}
	piWorkspaceExpectChanged(t, snapshot, m, false)
	piWorkspaceWrite(t, m.LocalPath, "build/source.txt", "tracked exception")
	piWorkspaceExpectChanged(t, snapshot, m, true)
	snapshot = piWorkspaceCapture(t, m)
	piWorkspaceWrite(t, m.LocalPath, ".env.example", "public example")
	piWorkspaceExpectChanged(t, snapshot, m, true)
}

func TestPiWorkspaceDetectsGitHeadBranchAndIndex(t *testing.T) {
	for _, operation := range []string{"head", "branch", "index"} {
		t.Run(operation, func(t *testing.T) {
			m, _ := piWorkspaceFixture(t)
			git := func(args ...string) string {
				t.Helper()
				output, err := gitOutputContext(context.Background(), m.LocalPath, args...)
				if err != nil {
					t.Fatal(err)
				}
				return output
			}
			git("init", "-b", "main")
			git("config", "user.name", "Pi QA")
			git("config", "user.email", "pi-qa@localhost")
			piWorkspaceWrite(t, m.LocalPath, "source.txt", "base")
			git("add", "source.txt")
			git("commit", "-m", "baseline")
			snapshot := piWorkspaceCapture(t, m)
			// A read-only Git query may refresh the index's stat cache but does
			// not change the synchronized HEAD/branch/index tree.
			git("status", "--porcelain")
			piWorkspaceExpectChanged(t, snapshot, m, false)
			switch operation {
			case "head":
				git("commit", "--allow-empty", "-m", "new HEAD")
			case "branch":
				git("checkout", "-b", "same-tree-new-branch")
			case "index":
				git("update-index", "--chmod=+x", "source.txt")
			}
			piWorkspaceExpectChanged(t, snapshot, m, true)
		})
	}
}

func TestPiWorkspaceUnavailableBaselineAndFailedObservationsRequireFullSync(t *testing.T) {
	m, session := piWorkspaceFixture(t)
	piWorkspaceWrite(t, m.LocalPath, "source.txt", "base")
	var absent *piWorkspaceSnapshot
	piWorkspaceExpectChanged(t, absent, m, true)
	snapshot := piWorkspaceCapture(t, m)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if changed, err := snapshot.changed(ctx, m); !changed || !errors.Is(err, context.Canceled) {
		t.Fatalf("cancelled observation became unchanged: changed=%t error=%v", changed, err)
	}
	session.Paused = false
	if changed, err := snapshot.changed(context.Background(), m); !changed || err == nil {
		t.Fatal("unpaused synchronization admitted the no-change fast path")
	}
	session.Paused = true
	if err := os.Rename(m.LocalPath, m.LocalPath+"-moved"); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Rename(m.LocalPath+"-moved", m.LocalPath) })
	if changed, err := snapshot.changed(context.Background(), m); !changed || err == nil {
		t.Fatal("unscannable project became unchanged")
	}
}

func TestPiWorkspaceReparsePointsAreNotTraversed(t *testing.T) {
	m, _ := piWorkspaceFixture(t)
	outside := t.TempDir()
	piWorkspaceWrite(t, outside, "private.txt", "outside")
	junction := filepath.Join(m.LocalPath, "junction")
	cmd := hideCommandWindow(exec.Command("cmd.exe", "/c", "mklink", "/J", junction, outside))
	if output, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("cannot create local junction fixture: %s %v", output, err)
	}
	// A junction may be represented as a link or an unsupported reparse point.
	// Either a stable link snapshot or an explicit observation error is safe;
	// traversing its target would incorrectly include unrelated private files.
	snapshot, err := capturePiWorkspace(context.Background(), m)
	if err != nil {
		return
	}
	for name := range snapshot.files {
		if strings.HasPrefix(name, "junction/") {
			t.Fatalf("snapshot traversed reparse target: %s", name)
		}
	}
	piWorkspaceWrite(t, outside, "private.txt", "outside changed")
	piWorkspaceExpectChanged(t, snapshot, m, false)
	if err := os.Remove(junction); err != nil {
		t.Fatal(err)
	}
	piWorkspaceExpectChanged(t, snapshot, m, true)
}

func TestPiWorkspaceResumeOnlyConfirmsExactLeaseAndOriginalEngineID(t *testing.T) {
	m, session := piWorkspaceFixture(t)
	resumed := []string{}
	piWorkspaceResumeSync = func(_ context.Context, identifier string) error {
		resumed = append(resumed, identifier)
		return nil
	}
	operations := []string{}
	remoteLeaseContext = func(_ context.Context, actual *Mapping, operation, owner, id string) (map[string]any, error) {
		if actual != m || operation != "confirm" || owner != "pi" || id != "exact-pi-lease" {
			t.Fatalf("unexpected fast-release lease operation: %s/%s/%s", operation, owner, id)
		}
		operations = append(operations, operation)
		return map[string]any{"ok": true, "lease": map[string]any{"id": id, "epoch": m.BindingEpoch, "owner": owner}}, nil
	}
	if err := resumePiWorkspace(context.Background(), m, "exact-pi-lease"); err != nil {
		t.Fatal(err)
	}
	if len(operations) != 1 || len(resumed) != 1 || resumed[0] != session.Identifier {
		t.Fatalf("fast release did more than confirm+resume exact engine: operations=%v resumed=%v", operations, resumed)
	}
	remoteLeaseContext = func(context.Context, *Mapping, string, string, string) (map[string]any, error) {
		return map[string]any{"ok": true, "lease": map[string]any{"id": "replacement", "epoch": m.BindingEpoch, "owner": "pi"}}, nil
	}
	if err := resumePiWorkspace(context.Background(), m, "exact-pi-lease"); err == nil || len(resumed) != 1 {
		t.Fatal("replacement reservation resumed synchronization")
	}
}
