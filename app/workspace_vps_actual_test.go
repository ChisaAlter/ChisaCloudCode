//go:build vpsqa

package main

import (
	"bufio"
	"fmt"
	"io"
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

// One opt-in run exercises production synchronization, server tools, previews and Pi.
// Every mutation is confined to its own temporary project and unique Pi session.
func TestVPSWorkspaceActual(t *testing.T) {
	runVPSWorkspaceQA(t, true, false)
}

func TestVPSWorkspaceModelsActual(t *testing.T) {
	if os.Getenv("CHISA_QA_REAL_MODEL") != "1" {
		t.Fatal("Model QA requires explicit opt-in")
	}
	runVPSWorkspaceQA(t, false, true)
}

func TestVPSWorkspaceGitActual(t *testing.T) {
	runVPSWorkspaceQA(t, false, false)
}

func runVPSWorkspaceQA(t *testing.T, core, models bool) {
	if os.Getenv("CHISA_QA_VPS") != "1" {
		t.Fatal("VPS QA requires explicit opt-in")
	}
	workspaceRoot := strings.TrimSpace(os.Getenv("CHISA_QA_WORKSPACE_ROOT"))
	if !path.IsAbs(workspaceRoot) || path.Clean(workspaceRoot) != workspaceRoot || workspaceRoot == "/" {
		t.Fatal("CHISA_QA_WORKSPACE_ROOT must be an explicit absolute, clean QA workspace root")
	}
	qaPrefix := path.Join(workspaceRoot, "local", "chisa-vps-qa-")
	saved := loadStore(dataDir())
	previousStore, previousTunnel := store, tunnel
	t.Cleanup(func() { store, tunnel = previousStore, previousTunnel })
	temporary := t.TempDir()
	local := filepath.Join(temporary, "project with spaces")
	if err := os.MkdirAll(filepath.Join(local, "build"), 0700); err != nil {
		t.Fatal(err)
	}
	for name, content := range map[string]string{"state.txt": "local seed", "build/asset.txt": "tracked asset", "build/generated.bin": "generated", "windows.txt": "Windows checkout\r\n"} {
		if err := os.WriteFile(filepath.Join(local, name), []byte(content), 0600); err != nil {
			t.Fatal(err)
		}
	}
	_ = os.MkdirAll(filepath.Join(local, "node_modules"), 0700)
	_ = os.WriteFile(filepath.Join(local, "node_modules", "excluded.txt"), []byte("excluded"), 0600)
	store = &Store{path: filepath.Join(temporary, "state.json"), Cfg: saved.config()}
	tunnel = newTunnel(store.config(), saved.keyPathOf(), func() {})
	for _, args := range [][]string{{"init", "-b", "main"}, {"remote", "add", "origin", "https://example.invalid/chisa-qa.git"}, {"config", "core.autocrlf", "true"}, {"add", "state.txt", "build/asset.txt", "windows.txt", "node_modules/excluded.txt"}, {"update-index", "--chmod=+x", "build/asset.txt"}, {"-c", "user.name=Chisa QA", "-c", "user.email=qa@localhost", "commit", "-m", "QA seed"}} {
		if _, err := gitOutput(local, args...); err != nil {
			t.Fatal(err)
		}
	}
	epoch := randHex(16)
	remote := qaPrefix + epoch
	m := &Mapping{LocalPath: local, ServerPath: remote, BindingEpoch: epoch}
	if err := store.addMapping(m); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		terminateSync(store.findMappingByServer(remote).SyncName)
		_ = stopProjectPreviews(remote)
		if remote != qaPrefix+epoch || len(epoch) != 32 {
			t.Error("invalid QA cleanup target")
			return
		}
		_, err := tunnel.ExecRemote("test \"$(readlink -f -- " + shellQuote(remote) + ")\" = " + shellQuote(remote) + " && rm -rf -- " + shellQuote(remote) + " " + shellQuote(remote+".chisa-lease"))
		if err != nil {
			t.Errorf("QA project cleanup: %v", err)
		}
	})
	mux := http.NewServeMux()
	registerFSEndpoints(mux)
	controller := httptest.NewServer(mux)
	defer controller.Close()
	address := strings.TrimPrefix(controller.URL, "http://")
	cmd := hideCommandWindow(exec.Command(sshExe(), append([]string{"-N", "-R", "127.0.0.1:0:" + address}, tunnel.baseArgs()...)...))
	stderr, err := cmd.StderrPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err = cmd.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() { _ = cmd.Process.Kill(); _ = cmd.Wait() }()
	allocated := make(chan int, 1)
	go func() {
		scanner := bufio.NewScanner(stderr)
		for scanner.Scan() {
			var port int
			if _, err := fmt.Sscanf(scanner.Text(), "Allocated port %d for remote forward", &port); err == nil {
				allocated <- port
				return
			}
		}
		allocated <- 0
	}()
	select {
	case tunnel.bridgePort = <-allocated:
	case <-time.After(20 * time.Second):
		t.Fatal("QA reverse tunnel timeout")
	}
	if tunnel.bridgePort < 1024 {
		t.Fatal("QA reverse tunnel failed")
	}
	result := (FrontendBridge{}).SyncProject(remote)
	if result["ok"] != true {
		t.Fatalf("initial sync: %v", result)
	}
	m = store.findMappingByServer(remote)
	status, err := tunnel.ExecRemote(serverGit(m, "status", "--porcelain"))
	if err != nil || status != "" {
		t.Fatalf("Windows checkout produced false Git edits: %s %v", status, err)
	}
	if _, err = tunnel.ExecRemote("test -x " + shellQuote(remote+"/build/asset.txt")); err != nil {
		t.Fatal("Git executable bit was not restored on VPS")
	}
	if origin, err := tunnel.ExecRemote(serverGit(m, "remote", "get-url", "origin")); err != nil || origin != "https://example.invalid/chisa-qa.git" {
		t.Fatalf("Git origin was not preserved: %s %v", origin, err)
	}
	t.Log("CRLF and Windows file mode produced a clean VPS Git worktree")
	runPhase := func(phase string) {
		t.Helper()
		out, err := tunnel.ExecRemote("WORKSPACES_ROOT=" + shellQuote(workspaceRoot) + " /opt/node/bin/node /tmp/chisa-vps-backend-qa/qa.mjs " + shellQuote(remote) + " " + shellQuote(phase))
		if err != nil {
			t.Fatalf("server %s: %v; %s", phase, err, out)
		}
		t.Log(out)
	}
	var content []byte
	var remoteText string
	var deadline time.Time
	if core {
		runPhase("files")
		content, err = os.ReadFile(filepath.Join(local, "state.txt"))
		if err != nil || string(content) != "server edit" {
			t.Fatalf("server edit did not arrive: %q %v", content, err)
		}
		if err = os.WriteFile(filepath.Join(local, "state.txt"), []byte("local again"), 0600); err != nil {
			t.Fatal(err)
		}
		for _, args := range [][]string{{"add", "state.txt"}, {"-c", "user.name=Chisa QA", "-c", "user.email=qa@localhost", "commit", "-m", "Local QA edit"}} {
			if _, err = gitOutput(local, args...); err != nil {
				t.Fatal(err)
			}
		}
		result = (FrontendBridge{}).SyncProject(remote)
		if result["ok"] != true {
			t.Fatalf("local sync: %v", result)
		}
		remoteText, err = tunnel.ExecRemote("cat " + shellQuote(remote+"/state.txt"))
		if err != nil || remoteText != "local again" {
			t.Fatalf("local edit did not arrive: %q %v", remoteText, err)
		}
		localHead, _ := gitOutput(local, "rev-parse", "HEAD")
		remoteHead, _ := tunnel.ExecRemote(serverGit(m, "rev-parse", "HEAD"))
		if localHead != remoteHead {
			t.Fatal("Git HEAD did not synchronize")
		}
		if _, err = remoteLease(m, "claim", "pi", "ownership-qa"); err != nil {
			t.Fatal(err)
		}
		runPhase("busy")
		if _, err = remoteLease(m, "release", "", "ownership-qa"); err != nil {
			t.Fatal(err)
		}
		preview := previewRPC(m, map[string]any{"op": "preview_start", "command": "python3 -m http.server 8000 --bind 0.0.0.0", "port": float64(8000)})
		if preview["ok"] != true {
			t.Fatalf("preview: %v", preview)
		}
		previewID := preview["previewId"].(string)
		var item Preview
		for _, value := range previewList() {
			if value.ID == previewID {
				item = value
			}
		}
		deadline = time.Now().Add(10 * time.Second)
		ready := false
		client := &http.Client{Timeout: time.Second}
		for time.Now().Before(deadline) {
			response, err := client.Get(item.LocalURL)
			if err == nil {
				body, _ := io.ReadAll(response.Body)
				response.Body.Close()
				if response.StatusCode == 200 && strings.Contains(string(body), "state.txt") {
					ready = true
					break
				}
			}
			time.Sleep(100 * time.Millisecond)
		}
		if !ready {
			t.Fatal("VPS preview was not reachable through the local SSH forward")
		}
		status := previewRPC(m, map[string]any{"op": "preview_status", "previewId": previewID})
		if status["ready"] != true {
			t.Fatalf("preview status: %v", status)
		}
		stopped := previewRPC(m, map[string]any{"op": "preview_stop", "previewId": previewID})
		if stopped["ok"] != true {
			t.Fatalf("preview stop: %v", stopped)
		}
		if _, err = runMutagen("sync", "pause", m.SyncName); err != nil {
			t.Fatal(err)
		}
		_ = os.WriteFile(filepath.Join(local, "state.txt"), []byte("local conflict"), 0600)
		if _, err = tunnel.ExecRemote("printf '%s' 'server conflict' > " + shellQuote(remote+"/state.txt")); err != nil {
			t.Fatal(err)
		}
		result = (FrontendBridge{}).SyncProject(remote)
		if result["ok"] == true {
			t.Fatal("two-way conflict was incorrectly accepted")
		}
		content, _ = os.ReadFile(filepath.Join(local, "state.txt"))
		remoteText, _ = tunnel.ExecRemote("cat " + shellQuote(remote+"/state.txt"))
		if string(content) != "local conflict" || remoteText != "server conflict" {
			t.Fatal("a conflicting edit was overwritten")
		}
		_ = os.WriteFile(filepath.Join(local, "state.txt"), []byte("resolved"), 0600)
		_, _ = tunnel.ExecRemote("printf '%s' 'resolved' > " + shellQuote(remote+"/state.txt"))
		result = (FrontendBridge{}).SyncProject(remote)
		if result["ok"] != true {
			t.Fatalf("conflict recovery: %v", result)
		}
		if connections, err := net.DialTimeout("tcp", fmt.Sprintf("127.0.0.1:%d", item.Port), time.Second); err == nil {
			connections.Close()
			t.Fatal("preview forward remained after stop")
		}
		t.Log("VPS kernel, tracked build assets, CAS, bidirectional Git/files, ownership, preview and conflicts passed")
	}
	if models {
		sessionID := "vps-handoff-" + epoch
		defer func() { _ = (FrontendBridge{}).PiAbort(remote, sessionID) }()
		prompt := "Read state.txt and append a new line containing exactly Pi Windows handoff proof. Use your local file tools. Do not modify other files."
		result = (FrontendBridge{}).PiPrompt(remote, sessionID, prompt, "", nil)
		if result["accepted"] != true {
			t.Fatalf("Pi handoff: %v", result)
		}
		deadline = time.Now().Add(180 * time.Second)
		for time.Now().Before(deadline) {
			state := (FrontendBridge{}).PiGetSession(remote, sessionID)
			if state["running"] == false && state["owner"] == "claude" {
				break
			}
			time.Sleep(300 * time.Millisecond)
		}
		state := (FrontendBridge{}).PiGetSession(remote, sessionID)
		if state["running"] != false || state["owner"] != "claude" {
			t.Fatalf("Pi did not finish synchronization: %v", state["lastResult"])
		}
		content, _ = os.ReadFile(filepath.Join(local, "state.txt"))
		remoteText, _ = tunnel.ExecRemote("cat " + shellQuote(remote+"/state.txt"))
		if !strings.Contains(string(content), "Pi Windows handoff proof") || remoteText != strings.TrimSpace(string(content)) {
			t.Fatal("Pi's native change did not synchronize to VPS")
		}
		runPhase("cloud")
		if proof, err := os.ReadFile(filepath.Join(local, "claude-proof.txt")); err != nil || string(proof) != "VPS Claude proof" {
			t.Fatal("Claude's server change did not synchronize to Windows")
		}
	}
}
