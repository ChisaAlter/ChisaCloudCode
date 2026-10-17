//go:build windows

package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func isolateWorkspaceSyncTransport(t *testing.T) {
	t.Helper()
	previous := tunnel
	cfg := store.config()
	if cfg.WorkspaceServerURL == "" {
		cfg.WorkspaceServerURL = cfg.ServerURL
		store.Cfg = cfg
	}
	tunnel = newTunnel(cfg, store.keyPathOf(), func() {})
	tunnel.proc, tunnel.bridgePort, tunnel.bridgeReady = &exec.Cmd{}, 1, true
	t.Cleanup(func() { tunnel = previous })
}

func accountWorkspaceFixture(t *testing.T, handler http.HandlerFunc) *serverConnection {
	t.Helper()
	t.Setenv("APPDATA", t.TempDir())
	previousStore, previousConnection, previousTunnel := store, apiConnection, tunnel
	server := httptest.NewServer(handler)
	connection, err := newServerConnection(server.URL, server.URL)
	if err != nil {
		t.Fatal(err)
	}
	connection.authenticated, connection.accountIdentity, connection.accessToken = true, "fresh-account", "header.payload.signature"
	apiConnection, tunnel = connection, nil
	store = loadStore(dataDir())
	t.Cleanup(func() {
		serverConnectionMu.Lock()
		connection.cancel()
		setup := connection.workspaceSetup
		serverConnectionMu.Unlock()
		if setup != nil {
			select {
			case <-setup.done:
			case <-time.After(3 * time.Second):
				t.Error("account setup did not stop")
			}
		}
		server.Close()
		store, apiConnection, tunnel = previousStore, previousConnection, previousTunnel
	})
	return connection
}

func TestAccountWorkspaceFreshAndMissingManualKeyEnrollWithLocalOpenSSH(t *testing.T) {
	for _, missingManual := range []bool{false, true} {
		t.Run(fmt.Sprintf("missing-manual=%t", missingManual), func(t *testing.T) {
			requests := 0
			connection := accountWorkspaceFixture(t, func(w http.ResponseWriter, r *http.Request) {
				requests++
				if r.URL.Path != "/api/workspace-sync/enroll" || r.Header.Get("Authorization") != "Bearer header.payload.signature" {
					t.Error("enrollment lost its authenticated route")
				}
				var body map[string]string
				if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
					t.Error(err)
				}
				if len(body) != 1 || !strings.HasPrefix(body["publicKey"], "ssh-ed25519 ") || strings.Contains(body["publicKey"], "PRIVATE KEY") {
					t.Error("enrollment must upload only an Ed25519 public key")
				}
				w.WriteHeader(http.StatusServiceUnavailable)
				fmt.Fprint(w, `{"error":{"code":"WORKSPACE_UNAVAILABLE","message":"服务器需要更新同步镜像"}}`)
			})
			if missingManual {
				cfg := store.config()
				cfg.ServerURL, cfg.WorkspaceServerURL = connection.baseURL, connection.baseURL
				cfg.SSHHost, cfg.KeyPath = "127.0.0.1", filepath.Join(t.TempDir(), "missing-key")
				if err := store.updateConfig(cfg); err != nil {
					t.Fatal(err)
				}
			}
			err := waitAccountWorkspace(connection, false)
			if err == nil || !strings.Contains(err.Error(), "服务器需要更新同步镜像") || requests != 1 {
				t.Fatalf("automatic enrollment did not report its server result: requests=%d err=%v", requests, err)
			}
			keys, err := filepath.Glob(filepath.Join(dataDir(), "account-sync", "*", "id_ed25519"))
			if err != nil || len(keys) != 1 {
				t.Fatalf("local managed key was not generated: count=%d err=%v", len(keys), err)
			}
			publicKey, err := exec.Command(filepath.Join(filepath.Dir(sshExe()), "ssh-keygen.exe"), "-y", "-f", keys[0]).Output()
			if err != nil || !strings.HasPrefix(string(publicKey), "ssh-ed25519 ") {
				t.Fatal("Windows OpenSSH cannot read the generated local key", err)
			}
			if len(store.mappings()) != 0 || tunnel != nil {
				t.Fatal("failed enrollment exposed a project or started SSH")
			}
		})
	}
}

func TestAccountWorkspaceConcurrentSetupSharesEnrollment(t *testing.T) {
	started, release := make(chan struct{}), make(chan struct{})
	var requests atomic.Int32
	connection := accountWorkspaceFixture(t, func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		close(started)
		select {
		case <-release:
		case <-r.Context().Done():
			return
		}
		w.WriteHeader(503)
		fmt.Fprint(w, `{"error":{"message":"fixture service unavailable"}}`)
	})
	results := make(chan error, 2)
	go func() { results <- waitAccountWorkspace(connection, false) }()
	select {
	case <-started:
	case <-time.After(5 * time.Second):
		t.Fatal("enrollment did not start")
	}
	go func() { results <- waitAccountWorkspace(connection, false) }()
	close(release)
	for i := 0; i < 2; i++ {
		select {
		case err := <-results:
			if err == nil || !strings.Contains(err.Error(), "fixture service unavailable") {
				t.Fatal(err)
			}
		case <-time.After(3 * time.Second):
			t.Fatal("shared setup waiter did not settle")
		}
	}
	if requests.Load() != 1 {
		t.Fatal("concurrent local folder/login setup enrolled more than once")
	}
}

func TestAccountWorkspaceAccountReplacementCancelsWaiter(t *testing.T) {
	started := make(chan struct{})
	connection := accountWorkspaceFixture(t, func(w http.ResponseWriter, r *http.Request) {
		// Drain the POST body so net/http can observe the client closing the connection.
		_, _ = io.Copy(io.Discard, r.Body)
		close(started)
		<-r.Context().Done()
	})
	result := make(chan error, 1)
	go func() { result <- waitAccountWorkspace(connection, false) }()
	select {
	case <-started:
	case <-time.After(5 * time.Second):
		t.Fatal("enrollment did not start")
	}
	serverConnectionMu.Lock()
	connection.cancel()
	apiConnection = nil
	serverConnectionMu.Unlock()
	select {
	case err := <-result:
		if err == nil || !strings.Contains(err.Error(), "账号连接已改变") {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("old account setup waiter remained pending")
	}
	if len(store.mappings()) != 0 || tunnel != nil {
		t.Fatal("canceled account setup exposed a workspace")
	}
}

type accountWorkspaceReadHook struct {
	io.Reader
	once sync.Once
	hook func()
}

func (reader *accountWorkspaceReadHook) Read(p []byte) (int, error) {
	reader.once.Do(reader.hook)
	return reader.Reader.Read(p)
}

func TestAccountWorkspaceRPCRejectsReplacementDuringDecode(t *testing.T) {
	connection := accountWorkspaceFixture(t, func(http.ResponseWriter, *http.Request) { t.Error("custom response unexpectedly used HTTP") })
	cfg := store.config()
	cfg.WorkspaceAccount, cfg.WorkspaceLoginURL = connection.accountIdentity, connection.loginURL
	if err := store.updateConfig(cfg); err != nil {
		t.Fatal(err)
	}
	connection.client.Transport = reviewRoundTrip(func(*http.Request) (*http.Response, error) {
		reader := &accountWorkspaceReadHook{Reader: strings.NewReader(`{"ok":true}`), hook: func() { serverConnectionMu.Lock(); apiConnection = nil; serverConnectionMu.Unlock() }}
		return &http.Response{StatusCode: 200, Header: http.Header{"X-Refreshed-Token": []string{"new.payload.signature"}}, Body: io.NopCloser(reader)}, nil
	})
	if result, err := accountWorkspaceRPC(context.Background(), "/api/workspace-sync/worker", nil); err == nil || result != nil {
		t.Fatalf("stale response decoded as success: result=%v err=%v", result, err)
	}
	if connection.accessToken != "header.payload.signature" {
		t.Fatal("stale response refreshed the original account token")
	}
}

func TestAccountWorkspaceRPCPreservesCleanupErrorAndRefreshedToken(t *testing.T) {
	var requests atomic.Int32
	connection := accountWorkspaceFixture(t, func(w http.ResponseWriter, r *http.Request) {
		if requests.Add(1) == 1 {
			w.Header().Set("X-Refreshed-Token", "new.payload.signature")
			fmt.Fprint(w, `{"ok":true}`)
			return
		}
		if r.Header.Get("Authorization") != "Bearer new.payload.signature" {
			t.Error("native RPC reused the expired JWT")
		}
		w.WriteHeader(500)
		fmt.Fprint(w, `{"success":false,"error":{"code":"WORKSPACE_CLEANUP_FAILED","message":"container cleanup unconfirmed"}}`)
	})
	cfg := store.config()
	cfg.ServerURL, cfg.WorkspaceServerURL = connection.baseURL, connection.baseURL
	cfg.WorkspaceAccount, cfg.WorkspaceLoginURL = connection.accountIdentity, connection.loginURL
	if err := store.updateConfig(cfg); err != nil {
		t.Fatal(err)
	}
	isolateWorkspaceSyncTransport(t)
	ctx, cancel, err := bindWorkspaceSyncConnection(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer cancel()
	settled := make(chan error, 1)
	go func() {
		_, err := accountWorkspaceRPC(ctx, "/api/workspace-sync/worker", nil)
		if err == nil {
			_, err = accountWorkspaceRPC(ctx, "/api/workspace-sync/worker", nil)
		}
		settled <- err
	}()
	select {
	case err := <-settled:
		var accountError *accountWorkspaceError
		if !errors.As(err, &accountError) || accountError.Code != "WORKSPACE_CLEANUP_FAILED" || accountError.Message != "container cleanup unconfirmed" {
			t.Fatalf("server AppError was lost: %v", err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("RPC response deadlocked on the sync connection lock")
	}
}

func TestAccountWorkspaceLeaseRecoveryChecksServerState(t *testing.T) {
	python := os.Getenv("CHISA_QA_PYTHON_PATH")
	if python == "" {
		python = "python3"
	}
	for _, changed := range []bool{false, true} {
		t.Run(fmt.Sprintf("changed=%t", changed), func(t *testing.T) {
			root := filepath.Join(t.TempDir(), "project")
			leaseDir := root + ".chisa-lease"
			if err := os.MkdirAll(leaseDir, 0700); err != nil {
				t.Fatal(err)
			}
			current := map[string]any{"owner": "claude", "id": "task", "epoch": "binding", "pid": 123456, "cleanupPending": []string{"chisa-rpc-0123456789abcdef"}}
			checked := map[string]any{}
			for k, v := range current {
				checked[k] = v
			}
			if changed {
				checked["pid"] = 123455
			}
			raw, _ := json.Marshal(current)
			if err := os.WriteFile(filepath.Join(leaseDir, "state.json"), raw, 0600); err != nil {
				t.Fatal(err)
			}
			request, _ := json.Marshal(map[string]any{"root": root, "op": "recover", "owner": "sync", "id": "new-sync", "epoch": "binding", "serverChecked": true, "checkedLease": checked})
			cmd := exec.Command(python, "-c", leaseWorker)
			cmd.Stdin = bytes.NewReader(request)
			out, err := cmd.CombinedOutput()
			if err != nil {
				t.Fatal(string(out), err)
			}
			var result map[string]any
			if err := json.Unmarshal(out, &result); err != nil {
				t.Fatal(err)
			}
			if changed {
				if result["ok"] != false || !strings.Contains(fmt.Sprint(result["error"]), "reservation changed after server confirmation") {
					t.Fatal(result)
				}
				after, _ := os.ReadFile(filepath.Join(leaseDir, "state.json"))
				if !bytes.Equal(after, raw) {
					t.Fatal("changed reservation was modified")
				}
			} else if result["ok"] != true {
				t.Fatal(result)
			}
		})
	}
}

func TestAccountWorkspaceMappingOwnershipSurvivesTransportPortChange(t *testing.T) {
	connection := accountWorkspaceFixture(t, func(http.ResponseWriter, *http.Request) {
		t.Error("disconnected storage check unexpectedly contacted HTTP")
	})
	cfg := store.config()
	cfg.ServerURL, cfg.WorkspaceServerURL = connection.baseURL, connection.baseURL
	cfg.WorkspaceAccount, cfg.WorkspaceLoginURL = connection.accountIdentity, connection.loginURL
	cfg.WorkspaceRoot, cfg.SSHHost, cfg.SSHUser, cfg.SSHPort = "/srv/account-projects", "sync.example", "root", 32001
	if err := store.updateConfig(cfg); err != nil {
		t.Fatal(err)
	}
	mapping := &Mapping{LocalPath: t.TempDir(), ServerPath: cfg.WorkspaceRoot + "/local/project", BindingEpoch: "binding", ServerID: serverIdentity(cfg)}
	if err := store.addMapping(mapping); err != nil {
		t.Fatal(err)
	}
	cfg.SSHPort = 32002
	if err := store.updateConfig(cfg); err != nil {
		t.Fatal(err)
	}
	if result := (FrontendBridge{}).GetProjectStorage(mapping.ServerPath)[mapping.ServerPath]; result.ServerError != "服务器未连接" {
		t.Fatalf("same account mapping was misclassified after transport replacement: %v", result)
	}
	cfg.WorkspaceRoot += "-other"
	if err := store.updateConfig(cfg); err != nil {
		t.Fatal(err)
	}
	if result := (FrontendBridge{}).GetProjectStorage(mapping.ServerPath); len(result) != 0 {
		t.Fatalf("different workspace root inherited the previous mapping: %v", result)
	}
}
