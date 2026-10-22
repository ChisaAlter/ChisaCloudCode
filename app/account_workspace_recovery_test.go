//go:build windows

package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
)

// Exercise the real setup -> durable recovery -> manual-sync call chain. Only
// transport readiness and remote lease/file work are simulated; no user daemon,
// SSH host, profile, installed application or production lease is touched.
func TestAccountWorkspaceNormalSetupAttemptsDurableHandback(t *testing.T) {
	m := currentConnectionMapping(t)
	connection := apiConnection
	connection.accessToken = "test.payload.signature"
	keyPath, _, err := managedWorkspaceKey(context.Background(), connection, connection.accountIdentity)
	if err != nil {
		t.Fatal(err)
	}
	cfg := store.config()
	cfg.SSHHost, cfg.SSHUser, cfg.SSHPort, cfg.KeyPath = "127.0.0.1", "root", 32768, keyPath
	cfg.ControlHost, cfg.WorkspaceRoot = "172.18.0.2", "/srv/recovery"
	if err := store.updateConfig(cfg); err != nil {
		t.Fatal(err)
	}
	m.ServerID = serverIdentity(cfg)
	privateConnectionTool(t, `[]`)
	sshPath, err := mutagenSSHPath()
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dataDir(), "mutagen-ssh-transport"), []byte(workspaceSyncEngineVersion+"\n"+norm(sshPath)+"\n"), 0600); err != nil {
		t.Fatal(err)
	}
	previousTunnel := tunnel
	transport := cfg
	transport.SSHHost = "" // start does not launch a process in this readiness fixture.
	tunnel = newTunnel(transport, keyPath, func() {})
	tunnel.proc, tunnel.bridgeReady, tunnel.bridgePort = &exec.Cmd{}, true, 1
	t.Cleanup(func() { tunnel = previousTunnel })
	syncMonitor.Lock()
	wasClosed := syncMonitor.closed
	syncMonitor.closed = true
	syncMonitor.Unlock()
	t.Cleanup(func() { syncMonitor.Lock(); syncMonitor.closed = wasClosed; syncMonitor.Unlock() })
	connection.client.Transport = reviewRoundTrip(func(request *http.Request) (*http.Response, error) {
		body := `{"previews":[]}`
		if request.URL.Path == "/api/workspace-sync/enroll" {
			encoded, _ := json.Marshal(accountWorkspaceEnrollment{SSHHost: cfg.SSHHost, SSHUser: cfg.SSHUser, SSHPort: cfg.SSHPort,
				WorkspaceServerURL: cfg.WorkspaceServerURL, WorkspaceRoot: cfg.WorkspaceRoot, ControlHost: cfg.ControlHost,
				HostKey: "ssh-ed25519 " + base64.StdEncoding.EncodeToString([]byte("synthetic-host-key")), RecoveryOnly: false})
			body = string(encoded)
		} else if request.URL.Path != "/api/workspace-sync/preview" {
			t.Fatal("unexpected setup HTTP request", request.URL.Path)
		}
		return &http.Response{StatusCode: 200, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(body))}, nil
	})
	// The existing native readiness probe uses the default transport. Observe
	// that probe here instead of depending on an installed app's fixed port.
	previousDefaultTransport := http.DefaultTransport
	http.DefaultTransport = reviewRoundTrip(func(request *http.Request) (*http.Response, error) {
		if request.URL.Host != "127.0.0.1:18791" || request.URL.Path != "/api/auth/status" {
			t.Fatal("unexpected native readiness request", request.URL.Path)
		}
		return &http.Response{StatusCode: http.StatusOK, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(`{}`))}, nil
	})
	t.Cleanup(func() { http.DefaultTransport = previousDefaultTransport })
	previousLease, previousPause, previousSync := remoteLeaseContext, pauseProjectSync, synchronizeProjectContext
	t.Cleanup(func() {
		remoteLeaseContext, pauseProjectSync, synchronizeProjectContext = previousLease, previousPause, previousSync
		syncStates.Delete(m.ServerPath)
	})
	lease := map[string]any{"id": "stopped-before-desktop-restart", "epoch": m.BindingEpoch, "owner": "sync-needed", "mayWrite": true, "cleanupPending": []any{}}
	var events []string
	remoteLeaseContext = func(_ context.Context, actual *Mapping, op, owner, id string) (map[string]any, error) {
		if actual.ServerPath != m.ServerPath || actual.BindingEpoch != m.BindingEpoch {
			t.Fatal("startup changed the durable binding")
		}
		events = append(events, op)
		switch op {
		case "read":
			return map[string]any{"ok": true, "lease": lease}, nil
		case "recover":
			if lease["owner"] != "sync-needed" {
				t.Fatal("recovery took an active lease")
			}
			lease = map[string]any{"id": id, "epoch": m.BindingEpoch, "owner": owner}
		case "release":
			if lease["id"] != id || lease["owner"] != owner {
				t.Fatal("released another reservation")
			}
			lease = nil
		}
		return map[string]any{"ok": true}, nil
	}
	pauseProjectSync = func(context.Context, *Mapping) error { events = append(events, "pause"); return nil }
	synchronizeProjectContext = func(context.Context, *Mapping, bool) error {
		events = append(events, "synchronize")
		return errors.New("controlled file failure before unrelated marker registration")
	}
	if err := setupAccountWorkspace(connection); err != nil {
		t.Fatal("a project recovery error disabled the normal account transport", err)
	}
	if want := []string{"read", "recover", "synchronize", "read", "release"}; !reflect.DeepEqual(events, want) {
		t.Fatal("normal enrollment did not enter exact-owner durable recovery", events)
	}
	if state := syncOperationInfo(m); state.Status != "blocked" || !strings.Contains(state.Detail, "controlled file failure") {
		t.Fatal("failed automatic handback was hidden or advertised ready", state)
	}
}

func TestAccountWorkspacePendingRecoverySkipsActiveAndForeignMappings(t *testing.T) {
	m := currentConnectionMapping(t)
	isolateWorkspaceSyncTransport(t)
	previousLease, previousPause, previousSync := remoteLeaseContext, pauseProjectSync, synchronizeProjectContext
	t.Cleanup(func() {
		remoteLeaseContext, pauseProjectSync, synchronizeProjectContext = previousLease, previousPause, previousSync
		syncStates.Delete(m.ServerPath)
	})
	for _, identity := range []string{"pi", "claude", "foreign-epoch", "foreign-account", "local-pi", "preview"} {
		t.Run(identity, func(t *testing.T) {
			other := &Mapping{LocalPath: t.TempDir(), ServerPath: "/srv/active-" + identity, BindingEpoch: "other-epoch", ServerID: m.ServerID, Mode: "vps"}
			if identity == "foreign-account" {
				other.ServerID = "foreign-account"
			}
			store.Mappings = []*Mapping{other, m}
			if identity == "local-pi" {
				piAgents.owners[other.ServerPath] = "active-pi-session"
			}
			if identity == "preview" {
				previews.items["startup-preview"] = Preview{ID: "startup-preview", ServerPath: other.ServerPath, Epoch: other.BindingEpoch}
			}
			t.Cleanup(func() {
				delete(piAgents.owners, other.ServerPath)
				delete(previews.items, "startup-preview")
				workspaceLocks.Delete(other.ServerPath)
			})
			var recovered []string
			leases := map[string]map[string]any{
				m.ServerPath:     {"id": "stopped-run", "epoch": m.BindingEpoch, "owner": "sync-needed"},
				other.ServerPath: {"id": "active-run", "epoch": other.BindingEpoch, "owner": "pi"},
			}
			if identity == "claude" {
				leases[other.ServerPath]["owner"] = "claude"
			}
			if identity == "foreign-epoch" {
				leases[other.ServerPath]["epoch"] = "stale-epoch"
				leases[other.ServerPath]["owner"] = "sync-needed"
			}
			remoteLeaseContext = func(_ context.Context, actual *Mapping, op, owner, id string) (map[string]any, error) {
				if actual.ServerPath == other.ServerPath && identity == "foreign-account" {
					t.Fatal("foreign account was contacted")
				}
				if op == "read" {
					return map[string]any{"ok": true, "lease": leases[actual.ServerPath]}, nil
				}
				if actual.ServerPath != m.ServerPath || actual.BindingEpoch != m.BindingEpoch {
					t.Fatal("startup mutated an active or foreign lease", identity, op)
				}
				if op == "recover" {
					leases[m.ServerPath] = map[string]any{"id": id, "epoch": m.BindingEpoch, "owner": owner}
					recovered = append(recovered, actual.ServerPath)
				}
				if op == "release" {
					leases[m.ServerPath] = nil
				}
				return map[string]any{"ok": true}, nil
			}
			pauseProjectSync = func(_ context.Context, actual *Mapping) error {
				if actual.ServerPath != m.ServerPath || actual.BindingEpoch != m.BindingEpoch {
					t.Fatal("startup paused an active mapping", identity)
				}
				return nil
			}
			synchronizeProjectContext = func(context.Context, *Mapping, bool) error {
				return errors.New("controlled stop after entering recovery")
			}
			if err := recoverAccountWorkspaceTransport(context.Background(), apiConnection, true); err != nil {
				t.Fatal("unrelated active mapping disabled normal recovery", err)
			}
			if !reflect.DeepEqual(recovered, []string{m.ServerPath}) {
				t.Fatal("stopped mapping was not recovered independently", recovered)
			}
			if leases[other.ServerPath]["id"] != "active-run" {
				t.Fatal("active lease changed")
			}
		})
	}
}

func TestAccountWorkspaceStaleJournalCannotClearConcurrentManualRecovery(t *testing.T) {
	m := currentConnectionMapping(t)
	isolateWorkspaceSyncTransport(t)
	if err := saveSyncRelease(m, "old-release-reply-lost"); err != nil {
		t.Fatal(err)
	}
	previousLease, previousPause, previousSync := remoteLeaseContext, pauseProjectSync, synchronizeProjectContext
	t.Cleanup(func() {
		remoteLeaseContext, pauseProjectSync, synchronizeProjectContext = previousLease, previousPause, previousSync
		pendingSyncReleases.Delete(m.ServerPath)
		syncStates.Delete(m.ServerPath)
	})
	firstRead, continueRead, manualClaimed, finishManual := make(chan struct{}), make(chan struct{}), make(chan struct{}), make(chan struct{})
	var reads, pauses atomic.Int32
	var mu sync.Mutex
	var lease map[string]any
	var manualID string
	remoteLeaseContext = func(_ context.Context, _ *Mapping, op, owner, id string) (map[string]any, error) {
		if op == "read" && reads.Add(1) == 1 {
			close(firstRead)
			<-continueRead
			return map[string]any{"ok": true, "lease": nil}, nil
		}
		mu.Lock()
		switch op {
		case "read":
			observed := any(lease)
			if lease == nil {
				observed = nil
			}
			mu.Unlock()
			return map[string]any{"ok": true, "lease": observed}, nil
		case "recover":
			manualID = id
			lease = map[string]any{"id": id, "epoch": m.BindingEpoch, "owner": owner}
			mu.Unlock()
			close(manualClaimed)
			<-finishManual
			return map[string]any{"ok": true}, nil
		case "release":
			mu.Unlock()
			return nil, errors.New("controlled missing release acknowledgement")
		}
		mu.Unlock()
		return nil, errors.New("unexpected lease operation")
	}
	pauseProjectSync = func(context.Context, *Mapping) error { pauses.Add(1); return nil }
	synchronizeProjectContext = func(context.Context, *Mapping, bool) error { return errors.New("controlled file failure") }
	automatic := make(chan error, 1)
	go func() { automatic <- recoverAccountWorkspaceTransport(context.Background(), apiConnection, true) }()
	<-firstRead
	manual := make(chan map[string]any, 1)
	go func() { manual <- (FrontendBridge{}).SyncProject(m.ServerPath) }()
	<-manualClaimed
	close(continueRead)
	close(finishManual)
	if result := <-manual; result["code"] != "WORKSPACE_RELEASE_FAILED" {
		t.Fatal("manual fixture did not preserve its new durable record", result)
	}
	if err := <-automatic; err != nil {
		t.Fatal(err)
	}
	record, err := loadSyncRelease(m)
	if err != nil || record == nil || record.ID != manualID || record.ID == "old-release-reply-lost" {
		t.Fatal("stale startup observation cleared a newer same-epoch journal", record, err)
	}
	if lease["id"] != manualID || pauses.Load() != 0 {
		t.Fatal("stale cleanup paused the warm session or replaced manual recovery", lease, pauses.Load())
	}
}
