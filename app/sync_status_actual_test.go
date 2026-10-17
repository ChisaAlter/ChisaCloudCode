//go:build vpsqa

package main

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func syncVPSFixture(t *testing.T) (*Mapping, *Tunnel, func(string)) {
	t.Helper()
	if os.Getenv("CHISA_QA_VPS") != "1" {
		t.Fatal("isolated VPS synchronization QA requires explicit opt-in")
	}
	workspaceRoot := strings.TrimSpace(os.Getenv("CHISA_QA_WORKSPACE_ROOT"))
	if !path.IsAbs(workspaceRoot) || path.Clean(workspaceRoot) != workspaceRoot || workspaceRoot == "/" {
		t.Fatal("CHISA_QA_WORKSPACE_ROOT must be an explicit absolute, clean QA workspace root")
	}
	qaPrefix := path.Join(workspaceRoot, "local", "sync-status-qa-")
	raw, err := os.ReadFile(filepath.Join(dataDir(), "state.json"))
	if err != nil {
		t.Fatal("existing connection configuration unavailable")
	}
	var saved Store
	if err = json.Unmarshal(raw, &saved); err != nil {
		t.Fatal("existing connection configuration invalid")
	}
	if saved.Cfg.SSHHost == "" || saved.Cfg.SSHUser == "" || saved.Cfg.Token == "" {
		t.Fatal("existing connection configuration incomplete")
	}
	key := saved.keyPathOf()
	if _, err = os.Stat(key); err != nil || mutagenExe() == "" {
		t.Fatal("existing SSH key or bundled synchronization engine unavailable")
	}
	alias := syncSSHAlias(saved.Cfg)
	// Reuse the installed SSH alias without modifying any user SSH configuration.
	aliasContext, cancelAlias := context.WithTimeout(context.Background(), 5*time.Second)
	output, err := hideCommandWindow(exec.CommandContext(aliasContext, sshExe(), "-G", alias)).Output()
	cancelAlias()
	if err != nil {
		t.Fatal("existing synchronization SSH alias unavailable")
	}
	host, user := "", ""
	for _, line := range strings.Split(string(output), "\n") {
		parts := strings.Fields(line)
		if len(parts) < 2 {
			continue
		}
		if parts[0] == "hostname" {
			host = parts[1]
		} else if parts[0] == "user" {
			user = parts[1]
		}
	}
	if !strings.EqualFold(host, saved.Cfg.SSHHost) || user != saved.Cfg.SSHUser {
		t.Fatal("existing synchronization SSH alias does not match this server")
	}
	if _, err = exec.LookPath("git"); err != nil {
		t.Fatal("local Git executable unavailable")
	}
	temporary := t.TempDir()
	local := filepath.Join(temporary, "project with spaces")
	if err = os.Mkdir(local, 0700); err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(filepath.Join(local, "proof.txt"), []byte("sync status seed\n"), 0600); err != nil {
		t.Fatal(err)
	}
	previousStore, previousTunnel, previousConnection := store, tunnel, apiConnection
	store = &Store{path: filepath.Join(temporary, "state.json"), Cfg: saved.Cfg}
	tunnel = newTunnel(saved.Cfg, key, func() {})
	qaTunnel := tunnel
	t.Cleanup(func() {
		stopSyncMonitor(false)
		qaTunnel.stop()
		if apiConnection != nil {
			apiConnection.cancel()
		}
		store, tunnel = previousStore, previousTunnel
		apiConnection = previousConnection
	})
	// Use the normal account-authorized tunnel instead of racing it with a second manual SSH process.
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
	t.Cleanup(controller.Close)
	// Authenticate the isolated fixture through the real account gateway before using SSH for file sync.
	credentials, err := os.ReadFile(os.Getenv("CHISA_LOGIN_QA_CREDS"))
	if err != nil {
		t.Fatal("real account QA credentials unavailable")
	}
	store.Cfg.LoginURL, store.Cfg.APIURL = distributionService().LoginURL, distributionService().LoginURL
	if err = initializeServerConnection(); err != nil {
		t.Fatal(err)
	}
	bridge := FrontendBridge{}
	login := bridge.ServerRequest(bridge.BeginServerRequest(), "POST", "/api/auth/login", map[string]string{"Content-Type": "application/json"}, base64.StdEncoding.EncodeToString(credentials))
	if login.Status != http.StatusOK || !workspaceConnectionMatchesSession() {
		t.Fatal("real QA account did not authorize this file-sync instance")
	}
	connectionDeadline := time.Now().Add(35 * time.Second)
	for !qaTunnel.connected() {
		if !time.Now().Before(connectionDeadline) {
			t.Fatal("normal account login did not resume the authorized file-sync tunnel")
		}
		time.Sleep(100 * time.Millisecond)
	}
	for _, args := range [][]string{
		{"init", "-b", "main"}, {"config", "core.autocrlf", "false"}, {"add", "proof.txt"},
		{"-c", "user.name=Chisa QA", "-c", "user.email=qa@localhost", "commit", "-m", "Temporary sync proof"},
	} {
		if _, err = gitOutput(local, args...); err != nil {
			t.Fatal(err)
		}
	}
	epoch := randHex(16)
	remote := qaPrefix + epoch
	m := &Mapping{LocalPath: local, ServerPath: remote, SyncName: "chisa-sync-status-qa-" + epoch, BindingEpoch: epoch, ServerID: serverIdentity(saved.Cfg), Mode: "vps"}
	t.Logf("isolated QA remote=%s session=%s local=%s", remote, m.SyncName, local)
	if err = store.addMapping(m); err != nil {
		t.Fatal(err)
	}
	if _, err = qaTunnel.ExecRemote("test ! -e " + shellQuote(remote) + " && mkdir -- " + shellQuote(remote) + " && chown 1000:1000 -- " + shellQuote(remote)); err != nil {
		t.Fatal("unable to create isolated VPS QA project")
	}
	sessionCreated := false
	t.Cleanup(func() {
		if sessionCreated {
			if _, err := runMutagen("sync", "terminate", m.SyncName); err != nil {
				t.Error("unable to terminate isolated QA synchronization session")
			}
		}
		if remote != qaPrefix+epoch || len(epoch) != 32 {
			t.Error("refused invalid QA cleanup path")
			return
		}
		lease := remote + ".chisa-lease"
		cleanup := "test \"$(readlink -f -- " + shellQuote(remote) + ")\" = " + shellQuote(remote) +
			" && test \"$(readlink -f -- " + shellQuote(lease) + ")\" = " + shellQuote(lease) +
			" && rm -rf -- " + shellQuote(remote) + " " + shellQuote(lease)
		if _, err := qaTunnel.ExecRemote(cleanup); err != nil {
			t.Error("unable to remove verified isolated VPS QA project")
		} else {
			t.Logf("CLEANUP confirmed remote=%s lease=%s session=%s", remote, lease, m.SyncName)
		}
		syncStates.Delete(remote)
		cloudReservations.Delete(remote)
		workspaceLocks.Delete(remote)
	})
	if _, err = runMutagen("sync", "create", "--name", m.SyncName, "--mode", "two-way-safe", "--hash", "sha256", "--no-global-configuration", "--ignore-vcs", "--ignore", ".chisa-bridge.json", "--default-owner-beta", "id:1000", "--default-group-beta", "id:1000", local, alias+":"+remote); err != nil {
		t.Fatal("isolated synchronization session creation failed")
	}
	sessionCreated = true
	synchronize := func(phase string) {
		t.Helper()
		if result := (FrontendBridge{}).SyncProject(remote); result["ok"] != true {
			t.Fatalf("%s SyncProject failed: %v", phase, result["error"])
		}
		deadline := time.Now().Add(15 * time.Second)
		for {
			info := (FrontendBridge{}).GetProjectSync(remote)
			if info.Status == "ready" {
				if info.CheckedAt == "" || info.LocalPath != local || info.ServerPath != remote || info.EngineStatus != "watching" {
					t.Fatalf("%s status lost current sample or project binding", phase)
				}
				return
			}
			if (info.Status != "checking" && info.Status != "syncing") || !time.Now().Before(deadline) {
				t.Fatalf("%s live status = %s", phase, info.Status)
			}
			time.Sleep(100 * time.Millisecond)
		}
	}
	return m, qaTunnel, synchronize
}

func TestSyncStatusVPSActual(t *testing.T) {
	m, qaTunnel, synchronize := syncVPSFixture(t)
	remote, local, epoch := m.ServerPath, m.LocalPath, m.BindingEpoch
	var err error
	synchronize("initial")
	initial := observedProjectSync(remote)
	current := store.findMappingByServer(remote)
	localHead, err := gitOutput(local, "rev-parse", "HEAD")
	if err != nil {
		t.Fatal("temporary local Git HEAD unavailable")
	}
	remoteHead, err := qaTunnel.ExecRemote(serverGit(current, "rev-parse", "HEAD"))
	if err != nil || remoteHead != localHead {
		t.Fatal("initial synchronization did not preserve Git HEAD")
	}
	t.Log("PASS initial SyncProject and daemon observer ready; temporary Git HEAD matches")
	time.Sleep(750 * time.Millisecond)
	if idle := observedProjectSync(remote); idle.Status != "ready" || idle.Sequence != initial.Sequence {
		t.Fatal("idle daemon monitoring changed an unchanged project observation")
	}
	t.Log("PASS idle daemon monitor does not revise the unchanged project view")
	changed := []byte("new local content " + epoch + "\n")
	if err = os.WriteFile(filepath.Join(local, "proof.txt"), changed, 0600); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(15 * time.Second)
	for {
		info := observedProjectSync(remote)
		if info.Status == "ready" && info.Sequence > initial.Sequence {
			break
		}
		if !time.Now().Before(deadline) || info.Status == "blocked" || info.Status == "unavailable" {
			t.Fatalf("automatic watcher did not publish completion: %s", info.Status)
		}
		time.Sleep(25 * time.Millisecond)
	}
	t.Log("PASS local edit advances the daemon-driven observation without status queries")
	synchronize("manual confirmation")
	hashOutput, err := qaTunnel.ExecRemote("sha256sum -- " + shellQuote(remote+"/proof.txt"))
	parts := strings.Fields(hashOutput)
	if err != nil || len(parts) == 0 || parts[0] != fmt.Sprintf("%x", sha256.Sum256(changed)) {
		t.Fatal("new local bytes did not match VPS SHA256 after manual synchronization")
	}
	t.Log("PASS manual confirmation preserves new local content SHA256 on VPS")
	syncMonitor.Lock()
	process := syncMonitor.process
	syncMonitor.Unlock()
	if process == nil {
		t.Fatal("live observer process missing")
	}
	process.cancel()
	select {
	case <-process.done:
	case <-time.After(5 * time.Second):
		t.Fatal("observer child did not terminate after cancellation")
	}
	failed := observedProjectSync(remote)
	if failed.Status != "unavailable" {
		t.Fatal("observer loss retained a green project view")
	}
	time.Sleep(200 * time.Millisecond)
	syncMonitor.Lock()
	restarted := syncMonitor.process != nil
	syncMonitor.Unlock()
	if restarted {
		t.Fatal("failed observer restarted without an explicit user action")
	}
	_ = (FrontendBridge{}).GetProjectSync(remote)
	deadline = time.Now().Add(10 * time.Second)
	for {
		info := observedProjectSync(remote)
		if info.Status == "ready" && info.Sequence > failed.Sequence {
			break
		}
		if !time.Now().Before(deadline) || info.Status == "blocked" || info.Status == "unavailable" {
			t.Fatalf("explicit observer reconnect did not recover: %s", info.Status)
		}
		time.Sleep(25 * time.Millisecond)
	}
	t.Log("PASS observer child loss withdraws ready; no automatic restart; explicit refresh recovers")
}
