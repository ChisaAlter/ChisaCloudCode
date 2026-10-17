//go:build windows

package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"unicode/utf8"
)

// The copied test executable impersonates only Mutagen's list/terminate CLI.
// It never starts a daemon, opens SSH or reads the user's profile.
func init() {
	if os.Getenv("CHISA_CONNECTION_TEST_TOOL") != "mutagen" {
		return
	}
	args := os.Args[1:]
	encoded, _ := json.Marshal(args)
	file, err := os.OpenFile(os.Getenv("CHISA_CONNECTION_TEST_TOOL_LOG"), os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0600)
	if err != nil {
		os.Exit(91)
	}
	_, _ = fmt.Fprintln(file, string(encoded))
	_ = file.Close()
	if len(args) >= 2 && args[0] == "sync" && args[1] == "list" {
		fmt.Println("CHISA_SYNC_JSON:" + os.Getenv("CHISA_CONNECTION_TEST_SESSIONS"))
		os.Exit(0)
	}
	if len(args) == 3 && args[0] == "sync" && args[1] == "terminate" {
		fmt.Fprintln(os.Stderr, "controlled termination failure")
		os.Exit(42)
	}
	os.Exit(92)
}

func privateConnectionTool(t *testing.T, sessions string) string {
	t.Helper()
	root := t.TempDir()
	working := filepath.Join(root, "app")
	if err := os.MkdirAll(filepath.Join(working, "resources", "windows-amd64", "sync-ssh"), 0700); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"ssh.exe", "scp.exe"} {
		if err := os.WriteFile(filepath.Join(working, "resources", "windows-amd64", "sync-ssh", name), nil, 0600); err != nil {
			t.Fatal(err)
		}
	}
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	input, err := os.Open(executable)
	if err != nil {
		t.Fatal(err)
	}
	defer input.Close()
	output, err := os.Create(filepath.Join(root, "mutagen.exe"))
	if err != nil {
		t.Fatal(err)
	}
	_, copyErr := io.Copy(output, input)
	closeErr := output.Close()
	if copyErr != nil || closeErr != nil {
		t.Fatal(copyErr, closeErr)
	}
	t.Chdir(working)
	selected, err := filepath.Abs(mutagenExe())
	if err != nil || selected != filepath.Join(root, "mutagen.exe") {
		t.Fatal("test must use its private proxy executable, never a real daemon", selected, err)
	}
	log := filepath.Join(root, "calls.jsonl")
	t.Setenv("CHISA_CONNECTION_TEST_TOOL", "mutagen")
	t.Setenv("CHISA_CONNECTION_TEST_TOOL_LOG", log)
	t.Setenv("CHISA_CONNECTION_TEST_SESSIONS", sessions)
	return log
}

func currentConnectionMapping(t *testing.T) *Mapping {
	t.Helper()
	m := isolateInactiveMapping(t)
	apiConnection.accountIdentity, apiConnection.loginURL = store.Cfg.WorkspaceAccount, store.Cfg.WorkspaceLoginURL
	apiConnection.client.Transport = reviewRoundTrip(func(request *http.Request) (*http.Response, error) {
		if request.URL.Path != "/api/workspace-sync/preview" {
			t.Fatalf("unexpected account request: %s", request.URL.Path)
		}
		return &http.Response{StatusCode: 200, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(`{"previews":[]}`))}, nil
	})
	return m
}

func TestConnectionRepairSameAccountRestartAdmitsSavedRecovery(t *testing.T) {
	for _, ownership := range []string{"sync-journal", "idle-pi-lease", "foreign-journal", "running-pi"} {
		t.Run(ownership, func(t *testing.T) {
			m := currentConnectionMapping(t)
			cfg := store.config()
			if ownership == "foreign-journal" {
				m.ServerID = "foreign-account"
			}
			if ownership == "sync-journal" || ownership == "foreign-journal" {
				if err := saveSyncRelease(m, "persisted-exact-owner"); err != nil {
					t.Fatal(err)
				}
			}
			if ownership == "idle-pi-lease" || ownership == "running-pi" {
				piAgents.sessions["saved"] = &piSession{ServerPath: m.ServerPath, BindingEpoch: m.BindingEpoch, Owner: "pi", LeaseID: "persisted-pi-owner", Running: ownership == "running-pi"}
			}
			if err := store.flush(); err != nil {
				t.Fatal(err)
			}
			store = loadStore(filepath.Dir(store.path))
			// A fresh process has no SSH process. An intentionally absent SSH host
			// stops at the readiness boundary without launching any external tool.
			tunnel = newTunnel(cfg, "", func() {})
			err := startAccountWorkspace(apiConnection, cfg)
			if err == nil {
				t.Fatal("a fixture without SSH must not report a ready transport")
			}
			if ownership == "sync-journal" || ownership == "idle-pi-lease" {
				if !strings.Contains(err.Error(), "文件同步通道尚未就绪") {
					t.Fatal("same-account recovery was blocked before transport startup", err)
				}
			} else if !strings.Contains(err.Error(), "尚在使用") && !strings.Contains(err.Error(), "请先停止 Pi") {
				t.Fatal("foreign ownership or a live task reached transport startup", err)
			}
			if mapping := store.findMappingByServer(m.ServerPath); mapping == nil || mapping.BindingEpoch != m.BindingEpoch || mapping.ServerID != m.ServerID {
				t.Fatal("transport admission discarded or changed a project binding", mapping)
			}
			if ownership == "sync-journal" {
				if record, err := loadSyncRelease(m); err != nil || record == nil || record.ID != "persisted-exact-owner" {
					t.Fatal("transport startup consumed the exact recovery journal", record, err)
				}
			}
		})
	}
}

func TestConnectionRepairActiveRevokeRetainsBindingAfterExactTerminationFailure(t *testing.T) {
	m := currentConnectionMapping(t)
	m.SyncName = "project-sync-name"
	if err := store.flush(); err != nil {
		t.Fatal(err)
	}
	log := privateConnectionTool(t, `[{"Name":"project-sync-name","Identifier":"exact-session-identifier"},{"Name":"unrelated","Identifier":"leave-this-session"}]`)
	before := *m
	result := (FrontendBridge{}).Revoke(m.ServerPath)
	if result["ok"] != false || !strings.Contains(fmt.Sprint(result["error"]), "停止项目同步失败") {
		t.Fatal("unconfirmed termination was reported as a completed removal", result)
	}
	if current := store.findMappingByServer(m.ServerPath); current == nil || !reflect.DeepEqual(*current, before) {
		t.Fatal("termination failure removed or rewrote the recovery entry", current)
	}
	if restored := loadStore(filepath.Dir(store.path)).findMappingByServer(m.ServerPath); restored == nil || !reflect.DeepEqual(*restored, before) {
		t.Fatal("termination failure discarded the persisted recovery entry", restored)
	}
	data, err := os.ReadFile(log)
	if err != nil {
		t.Fatal(err)
	}
	lines := strings.Split(strings.TrimSpace(string(data)), "\n")
	if len(lines) != 2 || lines[1] != `["sync","terminate","exact-session-identifier"]` {
		t.Fatal("revocation must terminate the unique identifier, not its name or another session", string(data))
	}
}

func TestConnectionRepairUnicodeDirectoryJSONRoundTrip(t *testing.T) {
	for _, input := range []string{strings.Repeat("汉", 17), strings.Repeat("目录", 20), strings.Repeat("🚀", 14), strings.Repeat("a", 49) + "汉"} {
		name := sanitizeName(input)
		if !utf8.ValidString(name) || len(name) > 50 || !strings.HasPrefix(input, name) {
			t.Fatal("directory truncation broke UTF-8 or changed its prefix", input, name, len(name))
		}
		original := Mapping{ServerPath: "/srv/local/" + name + "-abc123", BindingEpoch: "unicode"}
		encoded, err := json.Marshal(original)
		if err != nil {
			t.Fatal(err)
		}
		var restored Mapping
		if err := json.Unmarshal(encoded, &restored); err != nil || restored.ServerPath != original.ServerPath {
			t.Fatal("the created directory and persisted/request path diverged", original.ServerPath, restored.ServerPath, err)
		}
	}
}

func TestConnectionRepairRecoveryEnrollmentAndAdmission(t *testing.T) {
	m := currentConnectionMapping(t)
	connection := apiConnection
	connection.accessToken = "test.payload.signature"
	keyPath := filepath.Join(t.TempDir(), "test-key")
	connection.client.Transport = reviewRoundTrip(func(request *http.Request) (*http.Response, error) {
		if request.URL.Path != "/api/workspace-sync/enroll" {
			t.Fatalf("unexpected enrollment endpoint: %s", request.URL.Path)
		}
		body, _ := json.Marshal(accountWorkspaceEnrollment{SSHHost: "127.0.0.1", SSHUser: "root", SSHPort: 32768, WorkspaceServerURL: store.Cfg.WorkspaceServerURL, WorkspaceRoot: "/srv/recovery", ControlHost: "172.17.0.2", HostKey: "ssh-ed25519 " + base64.StdEncoding.EncodeToString([]byte("synthetic-host-key")), RecoveryOnly: true})
		return &http.Response{StatusCode: 200, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(string(body)))}, nil
	})
	next, recoveryOnly, err := enrollAccountWorkspace(connection, keyPath, "synthetic-device-public-key")
	if err != nil || !recoveryOnly || next.ControlHost != "172.17.0.2" || next.WorkspaceAccount != connection.accountIdentity {
		t.Fatal("legacy transport recovery metadata was lost", next, recoveryOnly, err)
	}
	isolateWorkspaceSyncTransport(t)
	connection.workspaceRecoveryOnly = true
	if _, _, err := bindWorkspaceSyncConnection(context.Background()); err == nil {
		t.Fatal("ordinary synchronization entered a recovery-only transport")
	}
	requests := 0
	connection.client.Transport = reviewRoundTrip(func(*http.Request) (*http.Response, error) {
		requests++
		return &http.Response{StatusCode: 200, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(`{"ok":true}`))}, nil
	})
	if _, err := accountWorkspaceRPC(context.Background(), "/api/workspace-sync/worker", nil); err == nil || requests != 0 {
		t.Fatal("ordinary worker traffic bypassed recovery-only admission", requests, err)
	}
	ctx, cancel, err := bindWorkspaceSyncConnection(context.WithValue(context.Background(), workspaceRecoveryContextKey{}, true))
	if err != nil {
		t.Fatal(err)
	}
	defer cancel()
	// Cleanup deliberately starts from Background and retains only its bound
	// snapshot, matching the existing durable hand-back defer.
	cleanup := context.WithValue(context.Background(), workspaceSyncConnectionKey{}, ctx.Value(workspaceSyncConnectionKey{}))
	if _, err := accountWorkspaceRPC(cleanup, "/api/workspace-sync/worker", nil); err != nil || requests != 1 {
		t.Fatal("the exact recovery snapshot lost cleanup permission", requests, err)
	}
	if status := (FrontendBridge{}).GetProjectSync(m.ServerPath); status.Status != "blocked" || status.BindingEpoch != m.BindingEpoch {
		t.Fatal("recovery-only transport was advertised as ordinary ready", status)
	}
}
