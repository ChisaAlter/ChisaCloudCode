//go:build windows

package main

import (
	"context"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestMutagenTransportUpgradePreservesActiveTasks(t *testing.T) {
	for _, activity := range []string{"pi", "sync", "cloud"} {
		t.Run(activity, func(t *testing.T) {
			connection := accountWorkspaceFixture(t, func(http.ResponseWriter, *http.Request) { t.Error("transport migration used an account HTTP endpoint") })
			switch activity {
			case "pi":
				piAgents.Lock()
				_ = piLoadLocked()
				piAgents.sessions["transport-upgrade-qa"] = &piSession{Running: true}
				piAgents.Unlock()
				t.Cleanup(func() { piAgents.Lock(); delete(piAgents.sessions, "transport-upgrade-qa"); piAgents.Unlock() })
			case "sync":
				syncActivities.Lock()
				syncActivities.items["transport-upgrade-qa"] = syncActivity{count: 1}
				syncActivities.Unlock()
				t.Cleanup(func() {
					syncActivities.Lock()
					delete(syncActivities.items, "transport-upgrade-qa")
					syncActivities.Unlock()
				})
			case "cloud":
				cloudReservations.Store("transport-upgrade-qa", "server-run")
				t.Cleanup(func() { cloudReservations.Delete("transport-upgrade-qa") })
			}
			if err := prepareMutagenTransport(context.Background(), connection); err == nil || !strings.Contains(err.Error(), "任务") {
				t.Fatalf("active %s task did not block daemon migration: %v", activity, err)
			}
			if _, err := os.Stat(filepath.Join(dataDir(), "mutagen-ssh-transport")); !os.IsNotExist(err) {
				t.Fatal("blocked migration recorded completion")
			}
		})
	}
}

func TestMutagenTransportAlreadyCurrentDoesNotRestartActiveTask(t *testing.T) {
	connection := accountWorkspaceFixture(t, func(http.ResponseWriter, *http.Request) { t.Error("transport check used HTTP") })
	sshPath, err := mutagenSSHPath()
	if err != nil {
		t.Fatal(err)
	}
	marker := filepath.Join(dataDir(), "mutagen-ssh-transport")
	if err := os.WriteFile(marker, []byte(workspaceSyncEngineVersion+"\n"+norm(sshPath)+"\n"), 0600); err != nil {
		t.Fatal(err)
	}
	oldTime := time.Unix(1_700_000_000, 0)
	if err := os.Chtimes(marker, oldTime, oldTime); err != nil {
		t.Fatal(err)
	}
	cloudReservations.Store("transport-upgrade-qa", "server-run")
	t.Cleanup(func() { cloudReservations.Delete("transport-upgrade-qa") })
	if err := prepareMutagenTransport(context.Background(), connection); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(marker)
	if err != nil || !info.ModTime().Equal(oldTime) {
		t.Fatal("current transport marker was rewritten instead of returning unchanged", err)
	}
	connection.cancel()
	if err := prepareMutagenTransport(context.Background(), connection); err == nil {
		t.Fatal("current marker hid a canceled account connection")
	}
}

// These daemon tests can select an explicit tagged test artifact while keeping
// the daemon, copied executable, data and SSH resources entirely task-private.
// Ordinary source runs retain their usual bundled-resource selection.
func isolateMutagenTransportRuntime(t *testing.T) {
	t.Helper()
	source := os.Getenv("CHISA_SYNC_TEST_MUTAGEN_PATH")
	if source == "" {
		return
	}
	if !filepath.IsAbs(source) {
		t.Fatal("CHISA_SYNC_TEST_MUTAGEN_PATH must name an explicit absolute tagged engine")
	}
	sshSource, err := mutagenSSHPath()
	if err != nil {
		t.Fatal(err)
	}
	private := t.TempDir()
	resources := filepath.Join(private, "app", "resources")
	sshDestination := filepath.Join(resources, "windows-amd64", "sync-ssh")
	if err := os.MkdirAll(sshDestination, 0700); err != nil {
		t.Fatal(err)
	}
	copyResource := func(source, target string) {
		input, err := os.Open(source)
		if err != nil {
			t.Fatal(err)
		}
		defer input.Close()
		info, err := input.Stat()
		if err != nil || !info.Mode().IsRegular() {
			t.Fatal("explicit test resource must be a regular file", err)
		}
		output, err := os.OpenFile(target, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0700)
		if err != nil {
			t.Fatal(err)
		}
		_, copyErr := io.Copy(output, input)
		closeErr := output.Close()
		if copyErr != nil || closeErr != nil {
			t.Fatal(copyErr, closeErr)
		}
	}
	engine := filepath.Join(resources, "mutagen.exe")
	copyResource(source, engine)
	for _, name := range []string{"ssh.exe", "scp.exe"} {
		copyResource(filepath.Join(sshSource, name), filepath.Join(sshDestination, name))
	}
	t.Chdir(filepath.Dir(resources))
	selected, err := filepath.Abs(mutagenExe())
	if err != nil || selected != engine {
		t.Fatal("daemon test did not select its private tagged artifact", selected, err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	version, err := runMutagenContext(ctx, "version")
	if err != nil || strings.TrimSpace(version) != workspaceSyncEngineVersion {
		t.Fatal("explicit daemon test artifact is not the required tagged engine", err)
	}
	t.Logf("isolated exact tagged engine artifact=%s version=%s", source, strings.TrimSpace(version))
}

func TestMutagenTransportFreshAndStaleDaemonReady(t *testing.T) {
	for _, state := range []string{"fresh", "empty-directory", "stale-lock-and-socket"} {
		t.Run(state, func(t *testing.T) {
			connection := accountWorkspaceFixture(t, func(http.ResponseWriter, *http.Request) { t.Error("transport startup used HTTP") })
			isolateMutagenTransportRuntime(t)
			daemonDirectory := filepath.Join(dataDir(), "mutagen", "daemon")
			if state != "fresh" {
				if err := os.MkdirAll(daemonDirectory, 0700); err != nil {
					t.Fatal(err)
				}
			}
			if state == "stale-lock-and-socket" {
				for _, name := range []string{"daemon.lock", "daemon.sock"} {
					if err := os.WriteFile(filepath.Join(daemonDirectory, name), []byte("stale daemon artifact"), 0600); err != nil {
						t.Fatal(err)
					}
				}
			}
			started := false
			t.Cleanup(func() {
				if !started {
					return
				}
				ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
				defer cancel()
				if _, err := runMutagenContext(ctx, "daemon", "stop"); err != nil {
					t.Error("isolated Mutagen daemon cleanup failed", err)
				}
			})
			ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
			defer cancel()
			if err := prepareMutagenTransport(ctx, connection); err != nil {
				t.Fatal("fresh profile could not prepare its daemon", err)
			}
			started = true
			sshPath, err := mutagenSSHPath()
			if err != nil {
				t.Fatal(err)
			}
			marker, err := os.ReadFile(filepath.Join(dataDir(), "mutagen-ssh-transport"))
			if err != nil || strings.TrimSpace(string(marker)) != workspaceSyncEngineVersion+"\n"+norm(sshPath) {
				t.Fatal("ready daemon did not record its tagged engine and app-scoped SSH transport", err)
			}
			// A second CLI cannot hide premature readiness by auto-starting a daemon.
			t.Setenv("MUTAGEN_DISABLE_AUTOSTART", "1")
			if _, err := runMutagenContext(ctx, "sync", "list"); err != nil {
				t.Fatal("transport returned before the daemon served requests", err)
			}
		})
	}
}

func TestMutagenTransportLegacyIdentityWaitsForActiveTask(t *testing.T) {
	connection := accountWorkspaceFixture(t, func(http.ResponseWriter, *http.Request) { t.Error("transport check used HTTP") })
	sshPath, err := mutagenSSHPath()
	if err != nil {
		t.Fatal(err)
	}
	marker := filepath.Join(dataDir(), "mutagen-ssh-transport")
	if err := os.WriteFile(marker, []byte(sshPath+"\n"), 0600); err != nil {
		t.Fatal(err)
	}
	cloudReservations.Store("legacy-engine-qa", "server-run")
	t.Cleanup(func() { cloudReservations.Delete("legacy-engine-qa") })
	if err := prepareMutagenTransport(context.Background(), connection); err == nil || !strings.Contains(err.Error(), "任务") {
		t.Fatalf("a same-path legacy engine skipped the active-task upgrade gate: %v", err)
	}
	if value, err := os.ReadFile(marker); err != nil || strings.TrimSpace(string(value)) != sshPath {
		t.Fatal("blocked engine upgrade rewrote its legacy identity", err)
	}
}

func TestMutagenTransportRejectsUntaggedRuntime(t *testing.T) {
	connection := accountWorkspaceFixture(t, func(http.ResponseWriter, *http.Request) { t.Error("transport check used HTTP") })
	calls := privateConnectionTool(t, "[]")
	t.Setenv("CHISA_CONNECTION_TEST_VERSION", "0.18.1")
	if err := prepareMutagenTransport(context.Background(), connection); err == nil || !strings.Contains(err.Error(), workspaceSyncEngineVersion) {
		t.Fatalf("untagged runtime was activated as a patched engine: %v", err)
	}
	if _, err := os.Stat(filepath.Join(dataDir(), "mutagen-ssh-transport")); !os.IsNotExist(err) {
		t.Fatal("untagged runtime recorded readiness", err)
	}
	if raw, err := os.ReadFile(calls); err != nil || strings.Contains(string(raw), `"daemon"`) || strings.Contains(string(raw), `"list"`) {
		t.Fatal("wrong-version rejection started or stopped a daemon", err)
	}
}

func TestMutagenTransportLockFailureDoesNotRecordReadiness(t *testing.T) {
	connection := accountWorkspaceFixture(t, func(http.ResponseWriter, *http.Request) { t.Error("transport check used HTTP") })
	isolateMutagenTransportRuntime(t)
	if err := os.MkdirAll(filepath.Join(dataDir(), "mutagen", "daemon", "daemon.lock"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := prepareMutagenTransport(context.Background(), connection); err == nil || !strings.Contains(err.Error(), "无法检查") {
		t.Fatal("invalid lock path was treated as an absent daemon", err)
	}
	if _, err := os.Stat(filepath.Join(dataDir(), "mutagen-ssh-transport")); !os.IsNotExist(err) {
		t.Fatal("failed daemon check recorded readiness", err)
	}
}
