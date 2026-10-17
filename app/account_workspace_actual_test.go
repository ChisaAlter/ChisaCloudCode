//go:build windows && vpsqa

package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// This opt-in fixture exercises the same fresh-profile login and selected-folder
// implementation as the desktop. It owns only temporary accounts and directories.
func TestAccountWorkspaceLiveFreshSyncWorkerPreview(t *testing.T) {
	credentialsPath, serviceURL := os.Getenv("CHISA_ACCOUNT_SYNC_QA_CREDS"), os.Getenv("CHISA_ACCOUNT_SYNC_QA_URL")
	if credentialsPath == "" || serviceURL == "" {
		t.Fatal("real account sync QA requires explicit credentials and gateway URL")
	}
	credentials, err := os.ReadFile(credentialsPath)
	if err != nil {
		t.Fatal("isolated account credentials unavailable")
	}
	profile := os.Getenv("CHISA_ACCOUNT_SYNC_QA_PROFILE")
	if profile == "" {
		profile = t.TempDir()
	}
	for name, relative := range map[string]string{"APPDATA": "roaming", "LOCALAPPDATA": "local", "USERPROFILE": "profile", "MUTAGEN_DATA_DIRECTORY": "mutagen"} {
		value := filepath.Join(profile, relative)
		if err := os.MkdirAll(value, 0700); err != nil {
			t.Fatal(err)
		}
		t.Setenv(name, value)
	}
	if mutagenExe() == "" {
		t.Fatal("bundled Mutagen unavailable")
	}
	previousStore, previousConnection, previousTunnel := store, apiConnection, tunnel
	store = loadStore(dataDir())
	cfg := store.config()
	cfg.LoginURL, cfg.APIURL = serviceURL, serviceURL
	cfg.KeyPath = migrateBridgeKey(filepath.Join(dataDir(), "bridge-key"))
	if err := store.updateConfig(cfg); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(cfg.KeyPath); !os.IsNotExist(err) {
		t.Fatal("fresh profile unexpectedly has a manual SSH key")
	}
	tunnel = newTunnel(cfg, cfg.KeyPath, func() {})
	if err := initializeServerConnection(); err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	registerFSEndpoints(mux)
	listener, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", controlPort))
	if err != nil {
		t.Fatal("native workspace control port unavailable")
	}
	controller := httptest.NewUnstartedServer(mux)
	controller.Listener.Close()
	controller.Listener = listener
	controller.Start()
	local := filepath.Join(profile, "first local project "+randHex(4))
	if err := os.MkdirAll(local, 0700); err != nil {
		t.Fatal(err)
	}
	seed := []byte("first local project from account login\n")
	if err := os.WriteFile(filepath.Join(local, "proof.txt"), seed, 0600); err != nil {
		t.Fatal(err)
	}
	var mapping *Mapping
	t.Cleanup(func() {
		stopSyncMonitor(false)
		if mapping == nil {
			mapping = store.findMappingByLocal(local)
		}
		if mapping != nil {
			if err := stopProjectPreviews(mapping.ServerPath); err != nil {
				t.Error("QA preview cleanup unconfirmed", err)
			}
			if mapping.SyncName != "" {
				sessions, err := syncSessions(mapping.SyncName)
				if err != nil {
					t.Error("QA Mutagen cleanup inventory unavailable", err)
				} else if len(sessions) > 0 {
					if _, err := runMutagen("sync", "terminate", mapping.SyncName); err != nil {
						t.Error("QA Mutagen session cleanup unconfirmed", err)
					}
				}
			}
			root := store.config().WorkspaceRoot
			remote := mapping.ServerPath
			if root == "" || !strings.HasPrefix(remote, root+"/local/") || !strings.Contains(filepath.Base(local), "first local project ") {
				t.Error("refused cleanup outside this temporary QA project")
			} else if tunnel != nil {
				lease := remote + ".chisa-lease"
				command := "test \"$(readlink -f -- " + shellQuote(remote) + ")\" = " + shellQuote(remote) + " && rm -rf -- " + shellQuote(remote) + " " + shellQuote(lease)
				if _, err := tunnel.ExecRemote(command); err != nil {
					t.Error("QA remote project cleanup unconfirmed", err)
				} else {
					t.Log("CLEANUP temporary remote project and lease confirmed")
				}
			}
		}
		if _, err := runMutagen("daemon", "stop"); err != nil {
			t.Error("QA Mutagen daemon cleanup unconfirmed", err)
		}
		if apiConnection != nil {
			apiConnection.cancel()
			apiConnection.client.CloseIdleConnections()
		}
		if tunnel != nil {
			tunnel.stop()
		}
		controller.Close()
		store, apiConnection, tunnel = previousStore, previousConnection, previousTunnel
	})
	bridge := FrontendBridge{}
	legacyDaemon := os.Getenv("CHISA_ACCOUNT_SYNC_QA_LEGACY_DAEMON") == "1"
	if legacyDaemon {
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		command := hideCommandWindow(exec.CommandContext(ctx, mutagenExe(), "sync", "list"))
		command.Env = append(os.Environ(), "MUTAGEN_DATA_DIRECTORY="+filepath.Join(dataDir(), "mutagen"), "MUTAGEN_SSH_PATH="+filepath.Dir(sshExe()))
		output, err := command.CombinedOutput()
		cancel()
		if err != nil {
			t.Fatalf("could not start the isolated legacy daemon: %v %s", err, output)
		}
		t.Log("Started an isolated pre-upgrade Mutagen daemon using Windows system SSH")
	}
	login := bridge.ServerRequest(bridge.BeginServerRequest(), "POST", "/api/auth/login", map[string]string{"Content-Type": "application/json"}, base64.StdEncoding.EncodeToString(credentials))
	if login.Status != 200 {
		body, _ := base64.StdEncoding.DecodeString(login.BodyB64)
		t.Fatalf("fresh login HTTP=%d body=%s", login.Status, body)
	}
	connection := apiConnection
	if !strings.HasSuffix(connection.baseURL, "/instances/main") || !connection.authenticated {
		t.Fatal("fresh account did not select its assigned instance")
	}
	opened := prepareLocalProject(local)
	if opened["ok"] != true {
		t.Fatalf("first folder open failed: %v", opened["error"])
	}
	mapping = store.findMappingByLocal(local)
	cfg = store.config()
	if mapping == nil || mapping.Mode != "vps" || mapping.SyncName == "" || cfg.WorkspaceAccount == "" || cfg.SSHPort == 22 || !cfg.SSHHostKeyPinned || cfg.ControlHost == "" || !tunnel.connected() {
		t.Fatal("fresh folder open did not finish its managed account sync setup")
	}
	if !strings.HasPrefix(cfg.KeyPath, filepath.Join(dataDir(), "account-sync")+string(filepath.Separator)) {
		t.Fatal("fresh setup used a manual SSH private key")
	}
	t.Logf("PASS fresh login + selected-folder pipeline; instance=main remote=%s managedSSHPort=%d", mapping.ServerPath, cfg.SSHPort)
	remoteHash, err := tunnel.ExecRemote("sha256sum -- " + shellQuote(mapping.ServerPath+"/proof.txt"))
	if err != nil || !strings.HasPrefix(remoteHash, fmt.Sprintf("%x", sha256.Sum256(seed))) {
		t.Fatal("first folder open returned before matching local bytes reached the server", err)
	}
	t.Log("PASS first synchronization exact SHA256")
	if legacyDaemon {
		return
	}
	localChanged := []byte("new local edit through real Mutagen\n")
	if err := os.WriteFile(filepath.Join(local, "proof.txt"), localChanged, 0600); err != nil {
		t.Fatal(err)
	}
	if result := bridge.SyncProject(mapping.ServerPath); result["ok"] != true {
		t.Fatal("local edit synchronization failed", result["error"])
	}
	read := workspaceRPC(mapping, map[string]any{"op": "read", "path": "proof.txt"})
	encoded, _ := read["b64"].(string)
	serverBytes, err := base64.StdEncoding.DecodeString(encoded)
	if read["ok"] != true || err != nil || !bytes.Equal(serverBytes, localChanged) {
		t.Fatal("authenticated managed worker did not read synchronized local edit", read)
	}
	t.Log("PASS local edit -> Mutagen -> authenticated sandbox worker")
	remoteChanged := []byte("server worker change handed back locally\n")
	written := workspaceRPC(mapping, map[string]any{"op": "write", "path": "proof.txt", "b64": base64.StdEncoding.EncodeToString(remoteChanged), "expectedHash": read["hash"]})
	if written["ok"] != true {
		t.Fatal("managed worker write failed", written)
	}
	if result := bridge.SyncProject(mapping.ServerPath); result["ok"] != true {
		t.Fatal("server edit handback failed", result["error"])
	}
	localBytes, err := os.ReadFile(filepath.Join(local, "proof.txt"))
	if err != nil || !bytes.Equal(localBytes, remoteChanged) {
		t.Fatal("server worker write was not handed back exactly", err)
	}
	t.Log("PASS authenticated sandbox worker write -> Mutagen -> exact local handback")
	execution := workspaceRPC(mapping, map[string]any{"op": "exec", "command": "printf account-managed-worker", "path": "."})
	if execution["ok"] != true || execution["exitCode"] != float64(0) || execution["stdout"] != "account-managed-worker" {
		t.Fatal("managed sandbox exec failed", execution)
	}
	folderBody, _ := json.Marshal(map[string]string{"path": mapping.ServerPath + "/server-callback-folder"})
	folder := bridge.ServerRequest(bridge.BeginServerRequest(), "POST", "/api/file-tree/create-folder", map[string]string{"Authorization": "Bearer " + connection.accessToken, "Content-Type": "application/json"}, base64.StdEncoding.EncodeToString(folderBody))
	if folder.Status != 200 {
		body, _ := base64.StdEncoding.DecodeString(folder.BodyB64)
		t.Fatalf("real server file-tree mutation/callback failed HTTP=%d body=%s", folder.Status, body)
	}
	if info, err := os.Stat(filepath.Join(local, "server-callback-folder")); err != nil || !info.IsDir() {
		t.Fatal("server callback did not complete its task handback to the local folder", err)
	}
	browse := bridge.ServerRequest(bridge.BeginServerRequest(), "GET", "/api/file-tree/browse-filesystem?path="+url.QueryEscape(mapping.ServerPath), map[string]string{"Authorization": "Bearer " + connection.accessToken}, "")
	if browse.Status != 200 {
		body, _ := base64.StdEncoding.DecodeString(browse.BodyB64)
		t.Fatalf("real server file-tree browse failed HTTP=%d body=%s", browse.Status, body)
	}
	t.Log("PASS managed sandbox exec and real server file-tree callback")
	index := []byte("<!doctype html><title>Account sync preview proof</title><p>account-preview-verified</p>")
	if err := os.WriteFile(filepath.Join(local, "index.html"), index, 0600); err != nil {
		t.Fatal(err)
	}
	if result := bridge.SyncProject(mapping.ServerPath); result["ok"] != true {
		t.Fatal("preview source synchronization failed", result["error"])
	}
	started := workspaceRPC(mapping, map[string]any{"op": "preview_start", "command": "python3 -m http.server 8080 --bind 0.0.0.0", "port": float64(8080), "path": "/workspace"})
	id, _ := started["previewId"].(string)
	if started["ok"] != true || id == "" {
		t.Fatal("managed preview start failed", started)
	}
	deadline := time.Now().Add(20 * time.Second)
	for {
		state := workspaceRPC(mapping, map[string]any{"op": "preview_status", "previewId": id})
		if state["ok"] != true {
			t.Fatal("managed preview status failed", state)
		}
		if state["ready"] == true {
			break
		}
		if !time.Now().Before(deadline) {
			t.Fatal("managed preview never became HTTP-ready", state)
		}
		time.Sleep(200 * time.Millisecond)
	}
	previews.Lock()
	preview := previews.items[id]
	previews.Unlock()
	client := &http.Client{Timeout: 5 * time.Second}
	response, err := client.Get(preview.LocalURL)
	if err != nil {
		t.Fatal("managed SSH preview URL could not connect", err)
	}
	body, err := io.ReadAll(response.Body)
	response.Body.Close()
	if err != nil || response.StatusCode != 200 || !bytes.Contains(body, []byte("account-preview-verified")) {
		t.Fatal("real preview URL returned the wrong page", err)
	}
	stopped := workspaceRPC(mapping, map[string]any{"op": "preview_stop", "previewId": id})
	if stopped["ok"] != true {
		t.Fatal("managed preview stop failed", stopped)
	}
	if _, err := accountWorkspaceRPC(context.Background(), "/api/workspace-sync/preview", map[string]any{"op": "inspect", "id": id}); err == nil {
		t.Fatal("removed preview container remained available")
	}
	t.Log("PASS managed preview real HTTP page, stop and container removal")
	bridge.EndServerSession(connection.version)
	if tunnel.controlAlive() || apiConnection.authenticated {
		t.Fatal("logout retained the authenticated sync capability")
	}
	if err := waitAccountWorkspace(apiConnection, false); err == nil {
		t.Fatal("logged-out account could reopen a local workspace")
	}
	// Keep the original authenticated connection for strictly scoped fixture cleanup.
	serverConnectionMu.Lock()
	apiConnection = connection
	serverConnectionMu.Unlock()
}

// The same temporary profile starts an actual old daemon before the new app
// login. A successful folder open must use the new app-scoped SSH configuration.
func TestAccountWorkspaceLiveLegacyDaemonRebind(t *testing.T) {
	t.Setenv("CHISA_ACCOUNT_SYNC_QA_LEGACY_DAEMON", "1")
	TestAccountWorkspaceLiveFreshSyncWorkerPreview(t)
}

func TestAccountWorkspaceLiveMigratedEndpointReconnect(t *testing.T) {
	oldProfile := os.Getenv("CHISA_ACCOUNT_SYNC_QA_OLD_PROFILE")
	credentialsPath, serviceURL := os.Getenv("CHISA_ACCOUNT_SYNC_QA_CREDS"), os.Getenv("CHISA_ACCOUNT_SYNC_QA_URL")
	if oldProfile == "" || credentialsPath == "" || serviceURL == "" {
		t.Fatal("migrated endpoint QA requires an explicit owned profile, credentials and gateway")
	}
	raw, err := os.ReadFile(filepath.Join(oldProfile, "state.json"))
	if err != nil {
		t.Fatal("owned pre-migration profile unavailable")
	}
	var original Store
	if err := json.Unmarshal(raw, &original); err != nil {
		t.Fatal(err)
	}
	if len(original.Mappings) != 0 || original.Cfg.WorkspaceAccount == "" || !original.Cfg.SSHHostKeyPinned {
		t.Fatal("QA requires an idle managed profile with its existing host pin")
	}
	credentials, err := os.ReadFile(credentialsPath)
	if err != nil {
		t.Fatal("owned QA credentials unavailable")
	}
	profile := os.Getenv("CHISA_ACCOUNT_SYNC_QA_PROFILE")
	if profile == "" {
		t.Fatal("migrated endpoint QA requires an ACL-compatible owned profile")
	}
	for name, relative := range map[string]string{"APPDATA": "roaming", "LOCALAPPDATA": "local", "USERPROFILE": "profile"} {
		value := filepath.Join(profile, relative)
		if err := os.MkdirAll(value, 0700); err != nil {
			t.Fatal(err)
		}
		t.Setenv(name, value)
	}
	previousStore, previousConnection, previousTunnel := store, apiConnection, tunnel
	store = loadStore(dataDir())
	cfg := original.Cfg
	cfg.LoginURL, cfg.APIURL, cfg.Token = serviceURL, serviceURL, randHex(24)
	relative, err := filepath.Rel(oldProfile, cfg.KeyPath)
	if err != nil || strings.HasPrefix(relative, "..") || filepath.IsAbs(relative) {
		t.Fatal("owned QA key is outside its profile")
	}
	cfg.KeyPath = filepath.Join(dataDir(), relative)
	cfg.SSHKnownHostsPath = filepath.Join(filepath.Dir(cfg.KeyPath), "known_hosts")
	if err := os.MkdirAll(filepath.Dir(cfg.KeyPath), 0700); err != nil {
		t.Fatal(err)
	}
	for _, filename := range []string{"id_ed25519", "id_ed25519.pub", "known_hosts", "ssh_config"} {
		bytes, err := os.ReadFile(filepath.Join(filepath.Dir(original.Cfg.KeyPath), filename))
		if err != nil {
			t.Fatal("owned QA key or host pin unavailable")
		}
		if err := os.WriteFile(filepath.Join(filepath.Dir(cfg.KeyPath), filename), bytes, 0600); err != nil {
			t.Fatal(err)
		}
	}
	priorKey, _ := os.ReadFile(cfg.KeyPath)
	priorPin, _ := os.ReadFile(cfg.SSHKnownHostsPath)
	if err := store.updateConfig(cfg); err != nil {
		t.Fatal(err)
	}
	tunnel = newTunnel(cfg, cfg.KeyPath, func() {})
	if err := initializeServerConnection(); err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	registerFSEndpoints(mux)
	listener, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", controlPort))
	if err != nil {
		t.Fatal("native QA control port unavailable")
	}
	controller := httptest.NewUnstartedServer(mux)
	controller.Listener.Close()
	controller.Listener = listener
	controller.Start()
	t.Cleanup(func() {
		stopSyncMonitor(false)
		if _, err := os.Stat(filepath.Join(dataDir(), "mutagen-ssh-transport")); err == nil {
			if _, err := runMutagen("daemon", "stop"); err != nil {
				t.Error("owned QA daemon cleanup unconfirmed", err)
			}
		}
		if apiConnection != nil {
			apiConnection.cancel()
			apiConnection.client.CloseIdleConnections()
		}
		if tunnel != nil {
			tunnel.stop()
		}
		controller.Close()
		store, apiConnection, tunnel = previousStore, previousConnection, previousTunnel
	})
	bridge := FrontendBridge{}
	login := bridge.ServerRequest(bridge.BeginServerRequest(), "POST", "/api/auth/login", map[string]string{"Content-Type": "application/json"}, base64.StdEncoding.EncodeToString(credentials))
	if login.Status != http.StatusOK {
		t.Fatalf("owned native login HTTP=%d", login.Status)
	}
	if result := bridge.ConnectAccountWorkspace(); result["ok"] != true {
		t.Fatal("normal native reconnect did not recover the migrated endpoint", result["error"])
	}
	next := store.config()
	key, _ := os.ReadFile(next.KeyPath)
	pin, _ := os.ReadFile(next.SSHKnownHostsPath)
	oldPin := strings.Fields(string(priorPin))
	newPin := strings.Fields(string(pin))
	if next.SSHPort == cfg.SSHPort || next.ControlHost == cfg.ControlHost || next.WorkspaceRoot != cfg.WorkspaceRoot ||
		serverIdentity(next) != serverIdentity(cfg) || !bytes.Equal(key, priorKey) || len(oldPin) < 3 || len(newPin) < 3 ||
		oldPin[1] != newPin[1] || oldPin[2] != newPin[2] || !tunnel.connected() {
		t.Fatal("endpoint rediscovery changed ownership, device key or host key, or did not restore SSH")
	}
	proof, err := tunnel.ExecRemote("printf migrated-native-reconnect-ok")
	if err != nil || proof != "migrated-native-reconnect-ok" {
		t.Fatal("rediscovered pinned managed SSH did not execute its exact canary", err)
	}
	t.Logf("PASS old managed endpoint %d -> %d through native login/reconnect; unchanged account, device key and host key; real pinned SSH canary", cfg.SSHPort, next.SSHPort)
}
