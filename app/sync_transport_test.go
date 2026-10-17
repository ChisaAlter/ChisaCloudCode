//go:build windows

package main

import (
	"context"
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
	if err := os.WriteFile(marker, []byte(sshPath+"\n"), 0600); err != nil {
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

func TestMutagenTransportFreshAndStaleDaemonReady(t *testing.T) {
	for _, state := range []string{"fresh", "empty-directory", "stale-lock-and-socket"} {
		t.Run(state, func(t *testing.T) {
			connection := accountWorkspaceFixture(t, func(http.ResponseWriter, *http.Request) { t.Error("transport startup used HTTP") })
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
			if err != nil || strings.TrimSpace(string(marker)) != sshPath {
				t.Fatal("ready daemon did not record its app-scoped SSH transport", err)
			}
			// A second CLI cannot hide premature readiness by auto-starting a daemon.
			t.Setenv("MUTAGEN_DISABLE_AUTOSTART", "1")
			if _, err := runMutagenContext(ctx, "sync", "list"); err != nil {
				t.Fatal("transport returned before the daemon served requests", err)
			}
		})
	}
}

func TestMutagenTransportLockFailureDoesNotRecordReadiness(t *testing.T) {
	connection := accountWorkspaceFixture(t, func(http.ResponseWriter, *http.Request) { t.Error("transport check used HTTP") })
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
