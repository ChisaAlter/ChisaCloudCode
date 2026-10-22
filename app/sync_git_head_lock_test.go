package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// A private child of the Go test executable stops only after a real lock/CAS or
// rename has finished. The parent kills that exact child, bypassing all defers.
// No init hook, worker stdin interception, app process, or user project is used.
func TestSyncGitHeadCrashChild(t *testing.T) {
	if len(os.Args) < 5 || os.Args[len(os.Args)-4] != "chisa-head-crash-fixture" {
		return
	}
	fixturePath, stage, ready := os.Args[len(os.Args)-3], os.Args[len(os.Args)-2], os.Args[len(os.Args)-1]
	input, err := os.ReadFile(fixturePath)
	if err != nil {
		t.Fatal(err)
	}
	var fixture struct {
		Root            string
		Before, Desired syncGitState
		Old             string
	}
	if err := json.Unmarshal(input, &fixture); err != nil {
		t.Fatal(err)
	}
	// Build only an empty process-private store; never load profile state.
	t.Setenv("CHISA_DATA_DIR", t.TempDir())
	store = &Store{}
	m := &Mapping{LocalPath: fixture.Root}
	ctx := context.WithValue(context.Background(), syncGitHeadLockStageKey{}, func(actual string) {
		if actual == stage {
			if err := os.WriteFile(ready, []byte(actual), 0600); err != nil {
				t.Fatal(err)
			}
			for {
				time.Sleep(10 * time.Millisecond)
			}
		}
	})
	if err := applyLocalGitHead(ctx, m, fixture.Before, fixture.Desired, fixture.Old); err != nil {
		t.Fatal(err)
	}
	t.Fatal("child did not reach requested crash boundary")
}

func syncGitCrashChild(t *testing.T, tools *syncSeedTestTools, m *Mapping, before, desired syncGitState, old, stage, kind string) {
	t.Helper()
	private := t.TempDir()
	ready, log := filepath.Join(private, "ready"), filepath.Join(private, "child.log")
	request := map[string]any{"root": m.LocalPath, "before": before, "desired": desired, "backup": "refs/chisa/recovery/crash-fixture"}
	var command *exec.Cmd
	if kind == "go" {
		input, err := json.Marshal(map[string]any{"Root": m.LocalPath, "Before": before, "Desired": desired, "Old": old})
		if err != nil {
			t.Fatal(err)
		}
		fixture := filepath.Join(private, "fixture.json")
		if err := os.WriteFile(fixture, input, 0600); err != nil {
			t.Fatal(err)
		}
		executable, err := os.Executable()
		if err != nil {
			t.Fatal(err)
		}
		command = exec.Command(executable, "-test.run=^TestSyncGitHeadCrashChild$", "--", "chisa-head-crash-fixture", fixture, stage, ready)
	} else {
		input, err := json.Marshal(request)
		if err != nil {
			t.Fatal(err)
		}
		// JSON remains the worker's normal stdin; instrumentation lives only in
		// this bootstrap, after real completed Git/filesystem operations.
		command = exec.Command(tools.python, "-c", syncGitHeadCrashWorkerBootstrap, syncGitApplyWorker, stage, ready)
		command.Stdin = strings.NewReader(string(input))
	}
	command.Env = tools.env
	output, err := os.Create(log)
	if err != nil {
		t.Fatal(err)
	}
	defer output.Close()
	command.Stdout, command.Stderr = output, output
	if err := command.Start(); err != nil {
		t.Fatal(err)
	}
	wait := make(chan error, 1)
	go func() { wait <- command.Wait() }()
	defer func() {
		if command.ProcessState == nil {
			command.Process.Kill()
			<-wait
		}
	}()
	deadline := time.NewTimer(20 * time.Second)
	defer deadline.Stop()
	ticker := time.NewTicker(10 * time.Millisecond)
	defer ticker.Stop()
	for {
		select {
		case err := <-wait:
			content, _ := os.ReadFile(log)
			t.Fatalf("child exited before crash boundary: %v\n%s", err, content)
		case <-deadline.C:
			command.Process.Kill()
			<-wait
			content, _ := os.ReadFile(log)
			t.Fatalf("child did not reach crash boundary\n%s", content)
		case <-ticker.C:
			if _, err := os.Stat(ready); err != nil {
				if !os.IsNotExist(err) {
					t.Fatal(err)
				}
				continue
			}
			if err := command.Process.Kill(); err != nil {
				t.Fatal(err)
			}
			if err := <-wait; err == nil {
				t.Fatal("task-owned child exited normally instead of being killed")
			}
			return
		}
	}
}

const syncGitHeadCrashWorkerBootstrap = `import os, pathlib, subprocess, sys, time, types
try:
    import fcntl
except ImportError:
    sys.modules['fcntl'] = types.SimpleNamespace(LOCK_EX=2, LOCK_NB=4, flock=lambda *args: None)
stage, ready = sys.argv[2], pathlib.Path(sys.argv[3])
def stop(actual):
    if actual == stage:
        ready.write_text(actual, encoding='ascii')
        while True: time.sleep(0.01)
link, replace, lstat = os.link, os.replace, pathlib.Path.lstat
def linked(source, destination, *args, **kwargs):
    result = link(source, destination, *args, **kwargs)
    if pathlib.Path(destination).name == 'HEAD.lock': stop('locked')
    return result
def checked(path, *args, **kwargs):
    if path.name == 'HEAD.lock': stop('cas')
    return lstat(path, *args, **kwargs)
def replaced(source, destination, *args, **kwargs):
    result = replace(source, destination, *args, **kwargs)
    if pathlib.Path(source).name == 'HEAD.lock': stop('published')
    return result
os.link, os.replace, pathlib.Path.lstat = linked, replaced, checked
exec(compile(sys.argv[1], 'embedded-sync-git-head-crash.py', 'exec'), {'__name__':'__main__'})
`

func syncGitAssertOwnedHeadLock(t *testing.T, head string, lockPresent bool) {
	t.Helper()
	marker, err := os.Lstat(head + ".chisa-owned")
	if err != nil {
		t.Fatal("durable ownership proof missing", err)
	}
	other := head
	if lockPresent {
		other += ".lock"
	}
	current, err := os.Lstat(other)
	if err != nil || !os.SameFile(marker, current) {
		t.Fatal("ownership marker does not prove exact HEAD inode", err)
	}
}

func syncGitAssertNoHeadMarker(t *testing.T, head string) {
	t.Helper()
	for _, suffix := range []string{".lock", ".chisa-owned"} {
		if _, err := os.Lstat(head + suffix); !os.IsNotExist(err) {
			t.Fatalf("owned HEAD artifact survived recovery: %s: %v", suffix, err)
		}
	}
}

func TestSyncGitHeadCrashRecoveryBeforeAndAfterCAS(t *testing.T) {
	for _, kind := range []string{"go", "python"} {
		for _, stage := range []string{"locked", "cas", "published"} {
			for _, attachment := range []string{"same-branch", "branch-switch"} {
				t.Run(kind+"/"+stage+"/"+attachment, func(t *testing.T) {
					tools, m, before, next := syncGitHeadFixture(t)
					desired := before
					desired.Head = next
					if attachment == "branch-switch" {
						desired.Branch = "refs/heads/feature"
					}
					head := syncGitHeadPath(t, tools, m)
					syncGitCrashChild(t, tools, m, before, desired, before.Head, stage, kind)
					syncGitAssertOwnedHeadLock(t, head, stage != "published")
					// Durable Pending, not guessed state equality, chooses the retry.
					journal := &syncGitCheckpoint{Version: 2, Pending: &syncGitPending{Local: before, Remote: desired, Desired: desired}}
					var actual syncGitState
					if kind == "go" {
						var err error
						actual, err = readLocalGitState(context.Background(), m)
						if err != nil {
							t.Fatal(err)
						}
					} else {
						actual = syncGitWorkerRead(t, tools, m.LocalPath)
					}
					syncGitAssertNoHeadMarker(t, head)
					selected, err := selectGitState(context.Background(), m, journal, actual, desired)
					if err != nil || selected != desired {
						t.Fatalf("crash prefix no longer resumable: %+v %v", actual, err)
					}
					if actual != desired {
						if kind == "go" {
							err = applyLocalGitState(context.Background(), m, actual, desired)
						} else {
							_, err = syncGitWorker(t, tools, map[string]any{"root": m.LocalPath, "before": actual, "desired": desired, "backup": "refs/chisa/recovery/resumed"}, "")
						}
						if err != nil {
							t.Fatal(err)
						}
					}
					syncGitExpectHead(t, tools, m, desired)
					syncGitAssertNoHeadMarker(t, head)
				})
			}
		}
	}
}

func TestSyncGitHeadCrashRecoveryPreservesForeignReplacement(t *testing.T) {
	for _, kind := range []string{"go", "python"} {
		t.Run(kind, func(t *testing.T) {
			tools, m, before, next := syncGitHeadFixture(t)
			desired := before
			desired.Head = next
			head := syncGitHeadPath(t, tools, m)
			syncGitCrashChild(t, tools, m, before, desired, before.Head, "locked", kind)
			syncGitAssertOwnedHeadLock(t, head, true)
			if err := os.Remove(head + ".lock"); err != nil {
				t.Fatal(err)
			}
			foreign := []byte("external replacement must survive\n")
			if err := os.WriteFile(head+".lock", foreign, 0600); err != nil {
				t.Fatal(err)
			}
			var err error
			if kind == "go" {
				_, err = readLocalGitState(context.Background(), m)
			} else {
				_, err = syncGitWorker(t, tools, map[string]any{"root": m.LocalPath, "op": "read"}, "")
			}
			if err == nil {
				t.Fatal("foreign replacement lock was ignored")
			}
			if raw, err := os.ReadFile(head + ".lock"); err != nil || string(raw) != string(foreign) {
				t.Fatalf("external replaced lock was touched: %q %v", raw, err)
			}
			if tools.gitRun(t, m.LocalPath, "rev-parse", "HEAD") != before.Head {
				t.Fatal("foreign lock recovery moved HEAD")
			}
		})
	}
}

func TestSyncGitHeadRecoveryAlreadyDesiredAndPreviewReadOnly(t *testing.T) {
	for _, kind := range []string{"go", "python"} {
		for _, markerOnly := range []bool{false, true} {
			t.Run(fmt.Sprintf("%s/marker-only=%v", kind, markerOnly), func(t *testing.T) {
				tools, m, desired, _ := syncGitHeadFixture(t)
				head := syncGitHeadPath(t, tools, m)
				if markerOnly {
					if err := os.Link(head, head+".chisa-owned"); err != nil {
						t.Fatal(err)
					}
				} else {
					if err := os.WriteFile(head+".chisa-owned", []byte("interrupted own lock\n"), 0600); err != nil {
						t.Fatal(err)
					}
					if err := os.Link(head+".chisa-owned", head+".lock"); err != nil {
						t.Fatal(err)
					}
				}
				before := syncSeedSnapshot(t, m.LocalPath, false)
				_, _ = syncGitPreviewState(t, tools, m, map[bool]string{true: "local", false: "worker"}[kind == "go"])
				syncGitPreviewUnchanged(t, m.LocalPath, before)
				if token, _, err := localSyncMetadataFingerprint(m); err == nil || token != "" {
					t.Fatal("ownership marker passed warm-cache proof")
				}
				var actual syncGitState
				if kind == "go" {
					var err error
					actual, err = readLocalGitState(context.Background(), m)
					if err != nil {
						t.Fatal(err)
					}
				} else {
					actual = syncGitWorkerRead(t, tools, m.LocalPath)
				}
				if actual != desired {
					t.Fatalf("already desired metadata changed: %+v", actual)
				}
				syncGitAssertNoHeadMarker(t, head)
				syncGitExpectHead(t, tools, m, desired)
			})
		}
	}
}

func TestSyncGitHeadLockCleanupPreservesReplacedLiveLock(t *testing.T) {
	tools, m, before, next := syncGitHeadFixture(t)
	desired := before
	desired.Head = next
	head := syncGitHeadPath(t, tools, m)
	ctx := context.WithValue(context.Background(), syncGitHeadLockStageKey{}, func(stage string) {
		if stage != "locked" {
			return
		}
		if err := os.Remove(head + ".lock"); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(head+".lock", []byte("external live replacement\n"), 0600); err != nil {
			t.Fatal(err)
		}
	})
	if err := applyLocalGitHead(ctx, m, before, desired, before.Head); err == nil {
		t.Fatal("live replacement HEAD lock was published")
	}
	if raw, err := os.ReadFile(head + ".lock"); err != nil || string(raw) != "external live replacement\n" {
		t.Fatalf("cleanup removed foreign replacement: %q %v", raw, err)
	}
}

func TestSyncGitHeadCleanupPreservesReplacedMarkerAndLock(t *testing.T) {
	for _, kind := range []string{"go", "python"} {
		t.Run(kind, func(t *testing.T) {
			tools, m, before, next := syncGitHeadFixture(t)
			desired := before
			desired.Head = next
			head := syncGitHeadPath(t, tools, m)
			if kind == "go" {
				ctx := context.WithValue(context.Background(), syncGitHeadLockStageKey{}, func(stage string) {
					if stage != "published" {
						return
					}
					if err := os.Remove(head + ".chisa-owned"); err != nil {
						t.Fatal(err)
					}
					if err := os.WriteFile(head+".chisa-owned", []byte("foreign marker and lock\n"), 0600); err != nil {
						t.Fatal(err)
					}
					if err := os.Link(head+".chisa-owned", head+".lock"); err != nil {
						t.Fatal(err)
					}
				})
				if err := applyLocalGitHead(ctx, m, before, desired, before.Head); err != nil {
					t.Fatal(err)
				}
			} else {
				request, err := json.Marshal(map[string]any{"root": m.LocalPath, "before": before, "desired": desired, "backup": "refs/chisa/recovery/marker-replaced"})
				if err != nil {
					t.Fatal(err)
				}
				_, stderr, err := tools.command(t, request, tools.python, "-c", syncGitHeadMarkerReplaceBootstrap, syncGitApplyWorker)
				if err == nil || !strings.Contains(stderr, "marker replaced") {
					t.Fatalf("worker cleanup accepted foreign marker pair: %v %s", err, stderr)
				}
			}
			for _, suffix := range []string{".lock", ".chisa-owned"} {
				if raw, err := os.ReadFile(head + suffix); err != nil || string(raw) != "foreign marker and lock\n" {
					t.Fatalf("foreign replacement pair changed: %s %q %v", suffix, raw, err)
				}
			}
		})
	}
}

const syncGitHeadMarkerReplaceBootstrap = `import os, pathlib, sys, types
try:
    import fcntl
except ImportError:
    sys.modules['fcntl'] = types.SimpleNamespace(LOCK_EX=2, LOCK_NB=4, flock=lambda *args: None)
replace = os.replace
def replaced(source, destination, *args, **kwargs):
    result = replace(source, destination, *args, **kwargs)
    if pathlib.Path(source).name == 'HEAD.lock':
        marker = pathlib.Path(str(destination) + '.chisa-owned')
        marker.unlink()
        marker.write_bytes(b'foreign marker and lock\n')
        os.link(marker, source)
    return result
os.replace = replaced
exec(compile(sys.argv[1], 'embedded-sync-git-marker-replaced.py', 'exec'), {'__name__':'__main__'})
`

func TestSyncGitHeadObserverDeclinesMarkerOnly(t *testing.T) {
	tools, m, _, _ := syncGitHeadFixture(t)
	head := syncGitHeadPath(t, tools, m)
	if err := os.Link(head, head+".chisa-owned"); err != nil {
		t.Fatal(err)
	}
	before := syncSeedSnapshot(t, m.LocalPath, false)
	workerPath := filepath.Join(t.TempDir(), "sync_observe.py")
	if err := os.WriteFile(workerPath, []byte(syncObserveWorker), 0600); err != nil {
		t.Fatal(err)
	}
	const bootstrap = `import pathlib,sys
namespace={'__name__':'sync_head_marker_observer'}
exec(compile(pathlib.Path(sys.argv[1]).read_bytes(),'<sync-observe>','exec'),namespace)
try:
    namespace['fingerprint'](sys.argv[2])
except namespace['ObservationError'] as error:
    assert 'owned lock' in str(error), error
else:
    raise AssertionError('marker-only crash was accepted as a warm observation')
`
	_, stderr, err := tools.command(t, nil, tools.python, "-c", bootstrap, workerPath, m.LocalPath)
	if err != nil {
		t.Fatal(err, stderr)
	}
	syncGitPreviewUnchanged(t, m.LocalPath, before)
}
