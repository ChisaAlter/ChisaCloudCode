//go:build vpsqa

package main

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestWorkspacePreviewVPSActual(t *testing.T) {
	if os.Getenv("CHISA_QA_VPS") != "1" {
		t.Fatal("isolated actual preview QA requires explicit opt-in")
	}
	workspaceRoot := strings.TrimSpace(os.Getenv("CHISA_QA_WORKSPACE_ROOT"))
	if !path.IsAbs(workspaceRoot) || path.Clean(workspaceRoot) != workspaceRoot || workspaceRoot == "/" {
		t.Fatal("CHISA_QA_WORKSPACE_ROOT must be an explicit absolute, clean QA workspace root")
	}
	qaPrefix := path.Join(workspaceRoot, "local", "preview-qa-")
	raw, err := os.ReadFile(filepath.Join(dataDir(), "state.json"))
	if err != nil {
		t.Fatal("existing connection configuration unavailable")
	}
	var saved Store
	if err = json.Unmarshal(raw, &saved); err != nil || saved.Cfg.SSHHost == "" || saved.Cfg.SSHUser == "" {
		t.Fatal("existing connection configuration invalid")
	}
	key := saved.keyPathOf()
	if _, err = os.Stat(key); err != nil {
		t.Fatal("existing SSH key unavailable")
	}
	temporary := t.TempDir()
	epoch := randHex(16)
	remote := qaPrefix + epoch
	m := &Mapping{LocalPath: temporary, ServerPath: remote, BindingEpoch: epoch, ServerID: serverIdentity(saved.Cfg), Mode: "vps"}
	previousStore, previousTunnel := store, tunnel
	store = &Store{path: filepath.Join(temporary, "state.json"), Cfg: saved.Cfg, Mappings: []*Mapping{m}}
	qaTunnel := newTunnel(saved.Cfg, key, func() {})
	tunnel = qaTunnel
	t.Cleanup(func() {
		store, tunnel = previousStore, previousTunnel
		workspaceLocks.Delete(remote)
	})
	canary := "Chisa exact Docker SSH HTTP preview proof " + epoch + "\n"
	binding, _ := json.Marshal(map[string]any{"protocol": 2, "port": 1, "bindingEpoch": epoch, "token": "isolated-preview-no-control"})
	prepare := "test ! -e " + shellQuote(remote) + " && mkdir -- " + shellQuote(remote) +
		" && printf '%s' " + shellQuote(canary) + " > " + shellQuote(remote+"/index.html") +
		" && printf '%s' " + shellQuote(string(binding)) + " > " + shellQuote(remote+"/.chisa-bridge.json") +
		" && chown -R 1000:1000 -- " + shellQuote(remote)
	if _, err = qaTunnel.ExecRemote(prepare); err != nil {
		t.Fatal("unable to prepare isolated actual preview directory")
	}
	t.Logf("isolated preview remote=%s local=%s", remote, temporary)
	t.Cleanup(func() {
		if remote != qaPrefix+epoch || len(epoch) != 32 {
			t.Error("refused invalid preview cleanup path")
			return
		}
		cleanup := "test \"$(readlink -f -- " + shellQuote(remote) + ")\" = " + shellQuote(remote) +
			" && rm -rf -- " + shellQuote(remote) + " && test ! -e " + shellQuote(remote)
		if _, err := qaTunnel.ExecRemote(cleanup); err != nil {
			t.Error("isolated preview directory cleanup not confirmed")
		} else {
			t.Logf("CLEANUP confirmed remote=%s absent", remote)
		}
	})
	start := previewRPC(m, map[string]any{"op": "preview_start", "command": "python3 -u -m http.server 8000 --bind 0.0.0.0", "port": float64(8000)})
	if start["ok"] != true {
		t.Fatalf("actual preview startup failed: %v", start)
	}
	id := start["previewId"].(string)
	var item Preview
	for _, candidate := range previewList() {
		if candidate.ID == id {
			item = candidate
		}
	}
	if item.Forward == nil || item.LocalURL == "" || item.ServerPath != remote || item.Epoch != epoch {
		t.Fatal("preview did not register its exact localhost forward capability")
	}
	t.Logf("preview container=%s localURL=%s forwardPID=%d", id, item.LocalURL, item.Forward.Process.Pid)
	t.Cleanup(func() {
		previews.Lock()
		_, retained := previews.items[id]
		previews.Unlock()
		if retained {
			if result := previewRPC(m, map[string]any{"op": "preview_stop", "previewId": id}); result["ok"] != true {
				t.Error("isolated preview fallback cleanup failed")
			}
		}
	})
	readyCtx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	for {
		status := previewRPCContext(readyCtx, m, map[string]any{"op": "preview_status", "previewId": id})
		if status["ok"] != true || status["running"] != true {
			t.Fatalf("actual preview application did not remain running: %v", status)
		}
		if status["ready"] == true {
			break
		}
		if readyCtx.Err() != nil {
			t.Fatal("actual preview HTTP gate did not become ready within 20 seconds")
		}
		time.Sleep(100 * time.Millisecond)
	}
	client := &http.Client{Timeout: 2 * time.Second}
	response, err := client.Get(item.LocalURL + "/index.html")
	if err != nil {
		t.Fatal("ready preview URL did not reach the actual HTTP application")
	}
	body, readErr := io.ReadAll(response.Body)
	response.Body.Close()
	if readErr != nil || response.StatusCode != http.StatusOK || string(body) != canary {
		t.Fatal("ready preview forwarded a listener but not the deterministic application response")
	}
	t.Logf("PASS actual Docker -> SSH forward -> registered localhost HTTP URL returns exact canary SHA256=%x; production ready=true", sha256.Sum256(body))
	if stop := (FrontendBridge{}).StopPreview(id); stop["ok"] != true {
		t.Fatalf("actual preview stop failed: %v", stop)
	}
	output, err := qaTunnel.ExecRemote("docker ps --all --format '{{.Names}}' --filter " + shellQuote("name=^/"+id+"$"))
	if err != nil || output != "" {
		t.Fatal("preview stop did not confirm its exact Docker container absent")
	}
	deadline := time.Now().Add(2 * time.Second)
	for {
		connection, err := net.DialTimeout("tcp", fmt.Sprintf("127.0.0.1:%d", item.Port), 100*time.Millisecond)
		if err != nil {
			break
		}
		connection.Close()
		if !time.Now().Before(deadline) {
			t.Fatal("preview stop left the localhost SSH forward accepting connections")
		}
		time.Sleep(25 * time.Millisecond)
	}
	previews.Lock()
	_, exists := previews.items[id]
	previews.Unlock()
	if exists {
		t.Fatal("stopped preview capability remained registered")
	}
	t.Logf("PASS StopPreview removes exact container=%s, registered capability and localhost forward port=%d", id, item.Port)
}

func TestWorkspaceLifecycleVPSActual(t *testing.T) {
	m, qaTunnel, synchronize := syncVPSFixture(t)
	binary := make([]byte, 8192)
	for i := range binary {
		binary[i] = byte(i * 37)
	}
	if err := os.WriteFile(filepath.Join(m.LocalPath, "binary.bin"), binary, 0600); err != nil {
		t.Fatal(err)
	}
	commit := func(message string) {
		t.Helper()
		for _, args := range [][]string{{"add", "binary.bin"}, {"-c", "user.name=Chisa QA", "-c", "user.email=qa@localhost", "commit", "-m", message}} {
			if _, err := gitOutput(m.LocalPath, args...); err != nil {
				t.Fatal(err)
			}
		}
	}
	verifyGit := func(phase string) {
		t.Helper()
		localHead, err := gitOutput(m.LocalPath, "rev-parse", "HEAD^{commit}")
		if err != nil {
			t.Fatal(err)
		}
		remoteHead, err := qaTunnel.ExecRemote(serverGit(m, "rev-parse", "--verify", "HEAD^{commit}"))
		if err != nil || localHead != remoteHead {
			t.Fatalf("%s Git HEAD mismatch", phase)
		}
		hash, err := qaTunnel.ExecRemote("set -o pipefail\n" + serverGit(m, "show", "HEAD:binary.bin") + " | sha256sum")
		fields := strings.Fields(hash)
		if err != nil || len(fields) == 0 || fields[0] != fmt.Sprintf("%x", sha256.Sum256(binary)) {
			t.Fatalf("%s Git object binary transport lost bytes", phase)
		}
		if _, err = qaTunnel.ExecRemote("test ! -e " + shellQuote(m.ServerPath+".chisa-lease")); err != nil {
			t.Fatalf("%s successful manual synchronization retained its lease", phase)
		}
		t.Logf("PASS %s local/VPS HEAD=%s binary SHA256=%x; marker and lease released", phase, localHead, sha256.Sum256(binary))
	}
	commit("Binary bundle proof")
	synchronize("binary bundle")
	verifyGit("binary bundle")
	binary = append(binary, 0, 255, 13, 10, 128)
	if err := os.WriteFile(filepath.Join(m.LocalPath, "binary.bin"), binary, 0600); err != nil {
		t.Fatal(err)
	}
	commit("Binary receive-pack proof")
	synchronize("receive-pack")
	verifyGit("receive-pack")
	invalid := *m
	invalid.ServerPath += "-uncreated"
	store.mu.Lock()
	store.Mappings = []*Mapping{&invalid, m}
	store.mu.Unlock()
	if _, err := qaTunnel.ExecRemote("printf '%s' '{}' > " + shellQuote(m.ServerPath+"/.chisa-bridge.json")); err != nil {
		t.Fatal(err)
	}
	if err := qaTunnel.PushToken(""); err == nil || qaTunnel.controlAlive() {
		t.Fatal("failed project registration was hidden behind a ready tunnel")
	}
	output, err := qaTunnel.ExecRemote("cat -- " + shellQuote(m.ServerPath+"/.chisa-bridge.json"))
	var binding struct {
		Port  int    `json:"port"`
		Epoch string `json:"bindingEpoch"`
	}
	if err != nil || json.Unmarshal([]byte(output), &binding) != nil || binding.Port != qaTunnel.bridgePort || binding.Epoch != m.BindingEpoch {
		t.Fatal("first failed mapping prevented another project from refreshing its binding")
	}
	store.mu.Lock()
	store.Mappings = []*Mapping{m}
	store.mu.Unlock()
	if err := qaTunnel.PushToken(""); err != nil || !qaTunnel.controlAlive() {
		t.Fatal("explicit registration retry did not recover the existing SSH process")
	}
	t.Log("PASS one failed mapping does not suppress other marker refreshes; explicit same-process registration retry restores control readiness")
	if err := pauseProjectSyncContext(context.Background(), m); err != nil {
		t.Fatal("unable to pause only the isolated QA session")
	}
	leaseID := "qa-job-" + randHex(8)
	if _, err := executeRemoteLease(m, "recover", "sync", leaseID); err != nil {
		t.Fatal("unable to claim isolated remote job lease")
	}
	operationCtx, cancel := context.WithTimeout(syncLeaseContext(context.Background(), leaseID), 6*time.Second)
	defer cancel()
	result := make(chan error, 1)
	go func() {
		_, err := syncRemoteScript(operationCtx, m, "printf started > "+shellQuote(m.ServerPath+"/job-started")+"; sleep 30; printf late > "+shellQuote(m.ServerPath+"/late-write"), nil)
		result <- err
	}()
	deadline := time.Now().Add(4 * time.Second)
	var marker map[string]any
	for {
		output, err := qaTunnel.ExecRemote("cat -- " + shellQuote(m.ServerPath+".chisa-lease/sync-job.json"))
		if err == nil && json.Unmarshal([]byte(output), &marker) == nil && marker["childPid"] != nil {
			break
		}
		if !time.Now().Before(deadline) {
			t.Fatal("real remote job did not register wrapper and child process identity")
		}
		time.Sleep(50 * time.Millisecond)
	}
	if marker["leaseId"] != leaseID || marker["epoch"] != m.BindingEpoch || marker["startTime"] == "" || marker["childStartTime"] == "" {
		t.Fatal("real marker lost exact lease or PID start-time identity")
	}
	if _, err := executeRemoteLease(m, "release", "", leaseID); err == nil {
		t.Fatal("lease release succeeded while a marked remote writer was live")
	}
	cancel()
	select {
	case err := <-result:
		if err == nil {
			t.Fatal("canceling local SSH reported remote job success")
		}
	case <-time.After(3 * time.Second):
		t.Fatal("total cancellation failed to bound local SSH")
	}
	deadline = time.Now().Add(12 * time.Second)
	for {
		if _, err := executeRemoteLease(m, "release", "", leaseID); err == nil {
			break
		}
		if !time.Now().Before(deadline) {
			t.Fatal("remote group cleanup remained unconfirmed after its absolute deadline")
		}
		time.Sleep(100 * time.Millisecond)
	}
	if _, err := qaTunnel.ExecRemote("test ! -e " + shellQuote(m.ServerPath+"/late-write") + " && test ! -e " + shellQuote(m.ServerPath+".chisa-lease")); err != nil {
		t.Fatal("canceled remote job wrote late or retained the released lease")
	}
	t.Log("PASS marked live remote writer blocks release; SSH cancellation plus absolute deadline ends its exact process group, no late write, lease released")
	leaseID = "qa-pid-" + randHex(8)
	if _, err := executeRemoteLease(m, "recover", "sync", leaseID); err != nil {
		t.Fatal(err)
	}
	if _, err := executeRemoteLease(m, "recover", "sync", "unrelated-operation"); err == nil {
		t.Fatal("generic recovery stole a same-epoch unfinished sync owner")
	}
	leaseDirectory := m.ServerPath + ".chisa-lease"
	writeMarker := func(epoch string, stale bool) {
		t.Helper()
		suffix := ""
		if stale {
			suffix = "+'-stale'"
		}
		script := "import json,pathlib\np=pathlib.Path(" + fmt.Sprintf("%q", leaseDirectory) + ")\nstart=pathlib.Path('/proc/1/stat').read_text().rsplit(')',1)[1].split()[19]" + suffix + "\n(p/'sync-job.json').write_text(json.dumps({'jobId':'qa-pid','leaseId':" + fmt.Sprintf("%q", leaseID) + ",'epoch':" + fmt.Sprintf("%q", epoch) + ",'pid':1,'startTime':start}))"
		if _, err := qaTunnel.ExecRemote("python3 -c " + shellQuote(script)); err != nil {
			t.Fatal("unable to create isolated process identity fixture")
		}
	}
	writeMarker(m.BindingEpoch, false)
	if _, err := executeRemoteLease(m, "release", "", leaseID); err == nil {
		t.Fatal("live matching PID/starttime marker was ignored")
	}
	writeMarker("other-binding", true)
	if _, err := executeRemoteLease(m, "release", "", leaseID); err == nil {
		t.Fatal("cross-binding marker was cleared")
	}
	writeMarker(m.BindingEpoch, true)
	if _, err := executeRemoteLease(m, "release", "", leaseID); err != nil {
		t.Fatal("stale PID identity could not be confirmed/released:", err)
	}
	t.Log("PASS same-epoch unfinished owner and live matching PID are not stolen; mismatched binding is retained; stale PID start-time marker can be confirmed and released")
	leaseID = "qa-docker-" + randHex(8)
	if _, err := executeRemoteLease(m, "recover", "sync", leaseID); err != nil {
		t.Fatal(err)
	}
	container := "chisa-rpc-" + randHex(8)
	t.Cleanup(func() {
		_, _ = qaTunnel.ExecRemote("docker rm --force " + shellQuote(container) + " >/dev/null 2>&1")
		output, err := qaTunnel.ExecRemote("docker ps --all --format '{{.Names}}' --filter " + shellQuote("name=^/"+container+"$"))
		if err != nil || output != "" {
			t.Error("isolated QA container cleanup not confirmed")
		} else {
			t.Logf("CLEANUP confirmed container=%s absent", container)
		}
	})
	if _, err := qaTunnel.ExecRemote("docker run --detach --network none --name " + shellQuote(container) + " --entrypoint sleep " + shellQuote(workspaceImage) + " 120"); err != nil {
		t.Fatal("installed workspace Docker image unavailable for isolated cleanup QA")
	}
	record := "import json,pathlib\np=pathlib.Path(" + fmt.Sprintf("%q", leaseDirectory+"/state.json") + ")\ns=json.loads(p.read_text());s.update(owner='sync-needed',cleanupPending=[" + fmt.Sprintf("%q", container) + "]);p.write_text(json.dumps(s))"
	if _, err := qaTunnel.ExecRemote("python3 -c " + shellQuote(record)); err != nil {
		t.Fatal("unable to record isolated cleanup reservation")
	}
	if _, err := executeRemoteLease(m, "release", "", leaseID); err == nil {
		t.Fatal("pending Docker cleanup silently released the reservation")
	}
	newLease := "qa-recovered-" + randHex(8)
	if _, err := executeRemoteLease(m, "recover", "sync", newLease); err != nil {
		t.Fatal("explicit exact-container recovery failed:", err)
	}
	output, err = qaTunnel.ExecRemote("docker ps --all --format '{{.Names}}' --filter " + shellQuote("name=^/"+container+"$"))
	if err != nil || output != "" {
		t.Fatal("manual recovery cleared pending without confirming exact container absent")
	}
	if _, err := executeRemoteLease(m, "release", "", newLease); err != nil {
		t.Fatal("recovered isolated lease could not be released")
	}
	t.Logf("PASS real cleanupPending blocks lease release; explicit recovery confirms exact container=%s absent before replacing and releasing lease", container)
}
