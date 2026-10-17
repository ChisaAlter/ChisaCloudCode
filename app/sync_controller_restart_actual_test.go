//go:build windows && vpsqa

package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/http/httptrace"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

type controllerRestartObservation struct {
	PID                 int    `json:"pid"`
	Remote              string `json:"remote"`
	Epoch               string `json:"epoch"`
	SyncName            string `json:"syncName"`
	LeaseID             string `json:"leaseId"`
	SeedSHA256          string `json:"seedSHA256"`
	TransferSHA256      string `json:"transferSHA256"`
	InterruptedCode     string `json:"interruptedCode,omitempty"`
	JournalRetained     bool   `json:"journalRetained"`
	JournalCleared      bool   `json:"journalCleared"`
	DaemonPaused        bool   `json:"daemonPaused"`
	LeaseCleared        bool   `json:"leaseCleared"`
	ControllerCall      bool   `json:"controllerCall"`
	StableFiles         bool   `json:"stableFiles"`
	Cleanup             bool   `json:"cleanup"`
	ParentIndexSHA256   string `json:"parentIndexSHA256"`
	ParentFileSHA256    string `json:"parentFileSHA256"`
	SelectedGitBoundary bool   `json:"selectedGitBoundary"`
	TransferObserved    string `json:"transferObserved,omitempty"`
}

type controllerQACallback struct {
	op, root, epoch, id string
	ok                  bool
}

type controllerQATransport struct {
	base http.RoundTripper
	t    *testing.T
}

func (transport controllerQATransport) CloseIdleConnections() {
	if closer, ok := transport.base.(interface{ CloseIdleConnections() }); ok {
		closer.CloseIdleConnections()
	}
}

func (transport controllerQATransport) RoundTrip(request *http.Request) (*http.Response, error) {
	started := time.Now()
	trace := &httptrace.ClientTrace{GotConn: func(connection httptrace.GotConnInfo) {
		transport.t.Logf("HTTP path=%s reused=%t idle=%t idleFor=%s", request.URL.Path, connection.Reused, connection.WasIdle, connection.IdleTime)
	}}
	response, err := transport.base.RoundTrip(request.WithContext(httptrace.WithClientTrace(request.Context(), trace)))
	status := 0
	if response != nil {
		status = response.StatusCode
	}
	// RoundTripper errors do not contain request headers or response bodies.
	transport.t.Logf("HTTP method=%s path=%s status=%d elapsed=%s transportError=%v", request.Method, request.URL.Path, status, time.Since(started), err)
	return response, err
}

// No window or model runs. Both children use the normal native login, controller,
// lease, SyncProject and Mutagen implementations; their only interruption is the
// real EndServerSession entry while an owned project is synchronizing.
func TestSyncControllerRestartActual(t *testing.T) {
	if os.Getenv("CHISA_NATIVE_CONTROLLER_QA") != "1" {
		t.Skip("explicit owned native controller QA opt-in required")
	}
	root, err := filepath.Abs(filepath.Join("build", "qa", "native-controller-run"))
	if err != nil || norm(os.Getenv("CHISA_NATIVE_CONTROLLER_QA_ROOT")) != norm(root) {
		t.Fatal("QA root must be this checkout's app/build/qa/native-controller-run")
	}
	serviceURL, err := normalizeServiceURL(os.Getenv("CHISA_ACCOUNT_SYNC_QA_URL"))
	if err != nil || !strings.HasPrefix(serviceURL, "https://") || norm(os.Getenv("CHISA_ACCOUNT_SYNC_QA_CREDS")) != norm(filepath.Join(root, "credentials.json")) {
		t.Fatal("owned QA requires an HTTPS gateway and credentials.json inside its QA root")
	}
	if phase := os.Getenv("CHISA_NATIVE_CONTROLLER_QA_PHASE"); phase != "" {
		runControllerRestartChild(t, root, phase)
		return
	}
	run := "run-" + randHex(8)
	profile := filepath.Join(root, run)
	if err := os.MkdirAll(profile, 0700); err != nil {
		t.Fatal(err)
	}
	// Generated OpenSSH keys must inherit only the current user's QA ACL.
	identity := os.Getenv("USERDOMAIN") + `\` + os.Getenv("USERNAME")
	if err := exec.Command("icacls", profile, "/inheritance:r", "/grant:r", identity+":(OI)(CI)F", "*S-1-5-18:(OI)(CI)F", "*S-1-5-32-544:(OI)(CI)F").Run(); err != nil {
		t.Fatal("could not restrict the owned QA profile ACL")
	}
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	child := func(phase string) bool {
		t.Helper()
		ctx, cancel := context.WithTimeout(context.Background(), 4*time.Minute)
		defer cancel()
		command := hideCommandWindow(exec.CommandContext(ctx, executable, "-test.run=^TestSyncControllerRestartActual$", "-test.v", "-test.timeout=3m"))
		command.Env = append(os.Environ(), "CHISA_NATIVE_CONTROLLER_QA_PHASE="+phase, "CHISA_NATIVE_CONTROLLER_QA_PROFILE="+profile)
		output, err := command.CombinedOutput()
		if saveErr := os.WriteFile(filepath.Join(profile, phase+".log"), output, 0600); saveErr != nil {
			t.Error("could not retain owned QA phase output")
		}
		if err != nil {
			t.Errorf("%s child failed; inspect the task-owned %s.log (no login response bodies are logged)", phase, phase)
			return false
		}
		return true
	}
	cleaned := false
	t.Cleanup(func() {
		if !cleaned {
			child("cleanup")
		}
	})
	if !child("interrupt") || !child("recover") {
		return
	}
	read := func(name string) controllerRestartObservation {
		t.Helper()
		raw, err := os.ReadFile(filepath.Join(profile, name+".json"))
		var observed controllerRestartObservation
		if err != nil || json.Unmarshal(raw, &observed) != nil {
			t.Fatalf("missing sanitized %s child observation", name)
		}
		return observed
	}
	first, second := read("interrupt"), read("recover")
	if first.PID == second.PID || first.Remote != second.Remote || first.Epoch != second.Epoch || first.LeaseID != second.LeaseID || !first.JournalRetained || !first.DaemonPaused || !first.StableFiles || !first.SelectedGitBoundary || first.TransferObserved == "" || !second.JournalCleared || !second.LeaseCleared || !second.ControllerCall || !second.StableFiles || !second.SelectedGitBoundary || !second.Cleanup {
		t.Fatal("two-process controller restart evidence is incomplete")
	}
	cleaned = true
	t.Logf("PASS independent Go processes %d -> %d: account interruption retains exact journal/lease and pauses daemon; fresh login recovers, HTTP controller callback completes, 64MiB SHA256=%s, files remain stable for 1.2s, owned session/project/lease cleanup confirmed; evidence=%s", first.PID, second.PID, second.TransferSHA256, profile)
}

func runControllerRestartChild(t *testing.T, root, phase string) {
	t.Helper()
	profile := os.Getenv("CHISA_NATIVE_CONTROLLER_QA_PROFILE")
	if filepath.Dir(profile) != root || !strings.HasPrefix(filepath.Base(profile), "run-") || len(filepath.Base(profile)) != 20 {
		t.Fatal("refused a profile outside the task-owned run directory")
	}
	for name, relative := range map[string]string{"APPDATA": "roaming", "LOCALAPPDATA": "local", "USERPROFILE": "profile"} {
		directory := filepath.Join(profile, relative)
		if err := os.MkdirAll(directory, 0700); err != nil {
			t.Fatal(err)
		}
		t.Setenv(name, directory)
	}
	if mutagenExe() == "" {
		t.Fatal("bundled Mutagen unavailable beside the QA binary")
	}
	// The operator supplies the QA gateway's public CA in the task-owned directory.
	publicService, err := os.ReadFile(filepath.Join(root, "service.json"))
	var defaults serviceDefaults
	if err != nil || json.Unmarshal(publicService, &defaults) != nil || defaults.CACertificate == "" {
		t.Fatal("QA public service CA must be supplied in the task-owned QA root")
	}
	serviceConfiguration = publicService
	store = loadStore(dataDir())
	cfg := store.config()
	cfg.LoginURL, cfg.APIURL = os.Getenv("CHISA_ACCOUNT_SYNC_QA_URL"), os.Getenv("CHISA_ACCOUNT_SYNC_QA_URL")
	if err := store.updateConfig(cfg); err != nil {
		t.Fatal("owned profile configuration could not be saved")
	}
	tunnel = newTunnel(cfg, store.keyPathOf(), func() {})
	if err := initializeServerConnection(); err != nil {
		t.Fatal("owned profile account connection could not be initialized")
	}
	mux := http.NewServeMux()
	registerFSEndpoints(mux)
	callbacks := make(chan controllerQACallback, 16)
	listener, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", controlPort))
	if err != nil {
		t.Fatal("native control port is occupied; no other process will be stopped")
	}
	controller := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/workspace/rpc" {
			mux.ServeHTTP(w, r)
			return
		}
		body, err := io.ReadAll(io.LimitReader(r.Body, 16*1024*1024+1))
		if err != nil {
			t.Error("QA callback observation could not read the request")
			return
		}
		r.Body = io.NopCloser(bytes.NewReader(body))
		var request map[string]any
		_ = json.Unmarshal(body, &request)
		op, _ := request["op"].(string)
		if op != "sync_begin" && op != "sync_end" && op != "sync_released" {
			mux.ServeHTTP(w, r)
			return
		}
		response := httptest.NewRecorder()
		mux.ServeHTTP(response, r)
		var result map[string]any
		_ = json.Unmarshal(response.Body.Bytes(), &result)
		id, _ := request["runId"].(string)
		callbacks <- controllerQACallback{op, r.Header.Get("X-Cwd"), r.Header.Get("X-Binding-Epoch"), id, response.Code == http.StatusOK && result["ok"] == true}
		for key, values := range response.Header() {
			w.Header()[key] = values
		}
		w.WriteHeader(response.Code)
		_, _ = w.Write(response.Body.Bytes())
	}))
	controller.Listener.Close()
	controller.Listener = listener
	controller.Start()
	t.Cleanup(func() {
		stopSyncMonitor(true)
		if tunnel != nil {
			tunnel.stop()
		}
		if apiConnection != nil {
			apiConnection.cancel()
			apiConnection.client.CloseIdleConnections()
		}
		controller.Close()
	})
	credentials, err := os.ReadFile(os.Getenv("CHISA_ACCOUNT_SYNC_QA_CREDS"))
	if err != nil {
		t.Fatal("owned QA credential input unavailable")
	}
	var expectedAccount struct {
		Username string `json:"username"`
	}
	if json.Unmarshal(credentials, &expectedAccount) != nil || expectedAccount.Username == "" {
		t.Fatal("confirmed owned QA credential input is invalid")
	}
	bridge := FrontendBridge{}
	login := bridge.ServerRequest(bridge.BeginServerRequest(), http.MethodPost, "/api/auth/login", map[string]string{"Content-Type": "application/json"}, base64.StdEncoding.EncodeToString(credentials))
	if login.Status != http.StatusOK {
		t.Fatalf("owned QA login returned HTTP %d; response body omitted", login.Status)
	}
	var authenticatedAccount struct {
		Username string `json:"username"`
	}
	if json.Unmarshal([]byte(apiConnection.accountIdentity), &authenticatedAccount) != nil || authenticatedAccount.Username != expectedAccount.Username || !strings.HasSuffix(apiConnection.baseURL, "/instances/main") || !apiConnection.authenticated {
		t.Fatal("owned QA account must route to main")
	}
	if err := waitAccountWorkspace(apiConnection, false); err != nil {
		t.Fatal("normal account-authorized QA workspace setup failed")
	}
	if store.config().WorkspaceRoot != "/srv/workspaces/chisa-controller-qa" {
		t.Fatal("refused workspace enrollment outside the dedicated controller QA root")
	}
	apiConnection.client.Transport = controllerQATransport{apiConnection.client.Transport, t}
	local := filepath.Join(profile, "controller-restart-"+strings.TrimPrefix(filepath.Base(profile), "run-"))
	hashFile := func(file string) string {
		t.Helper()
		input, err := os.Open(file)
		if err != nil {
			t.Fatal("owned canary/index missing")
		}
		defer input.Close()
		hash := sha256.New()
		if _, err := io.Copy(hash, input); err != nil {
			t.Fatal("owned canary/index could not be hashed")
		}
		return fmt.Sprintf("%x", hash.Sum(nil))
	}
	var parentIndexSHA, parentFileSHA string
	if phase == "interrupt" {
		if err := os.Mkdir(local, 0700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(local, "proof.txt"), []byte("controller restart canary\n"), 0600); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(profile, "parent-only.txt"), []byte("owned parent repository canary\n"), 0600); err != nil {
			t.Fatal(err)
		}
		for _, args := range [][]string{{"init", "-b", "main"}, {"config", "core.autocrlf", "false"}, {"add", "parent-only.txt", filepath.Base(local) + "/proof.txt"}, {"-c", "user.name=QA", "-c", "user.email=qa@localhost", "commit", "-m", "Owned selected-directory boundary"}} {
			if _, err := gitOutput(profile, args...); err != nil {
				t.Fatal("owned parent Git fixture failed", err)
			}
		}
		if err := os.WriteFile(filepath.Join(profile, "parent-only.txt"), []byte("staged owned parent change\n"), 0600); err != nil {
			t.Fatal(err)
		}
		if _, err := gitOutput(profile, "add", "parent-only.txt"); err != nil {
			t.Fatal(err)
		}
		parentIndexSHA, parentFileSHA = hashFile(filepath.Join(profile, ".git", "index")), hashFile(filepath.Join(profile, "parent-only.txt"))
		if opened := prepareLocalProject(local); opened["ok"] != true {
			t.Fatal("normal native selected-folder pipeline failed", opened["error"])
		}
	}
	m := store.findMappingByLocal(local)
	if m == nil {
		if phase == "cleanup" && len(store.mappings()) == 0 {
			if _, err := runMutagen("daemon", "stop"); err != nil {
				t.Fatal("owned QA daemon cleanup failed")
			}
			return
		}
		t.Fatal("owned QA project mapping missing")
	}
	if !strings.HasPrefix(m.ServerPath, store.config().WorkspaceRoot+"/local/"+filepath.Base(local)+"-") || len(store.mappings()) != 1 {
		t.Fatal("refused a project outside this run's exclusive mapping")
	}
	qaTunnel := tunnel
	observed := controllerRestartObservation{PID: os.Getpid(), Remote: m.ServerPath, Epoch: m.BindingEpoch, SyncName: m.SyncName, ParentIndexSHA256: parentIndexSHA, ParentFileSHA256: parentFileSHA}
	writeObservation := func(name string) {
		t.Helper()
		raw, err := json.MarshalIndent(observed, "", "  ")
		if err != nil || os.WriteFile(filepath.Join(profile, name+".json"), raw, 0600) != nil {
			t.Fatal("could not retain sanitized controller observation")
		}
	}
	fileDigest := func(file string) string {
		t.Helper()
		return hashFile(filepath.Join(local, file))
	}
	parentBoundary := func() bool {
		t.Helper()
		_, err := qaTunnel.ExecRemote("test ! -e " + shellQuote(m.ServerPath+"/.git") + " && test ! -e " + shellQuote(m.ServerPath+"/parent-only.txt"))
		return err == nil && hashFile(filepath.Join(profile, ".git", "index")) == observed.ParentIndexSHA256 && hashFile(filepath.Join(profile, "parent-only.txt")) == observed.ParentFileSHA256
	}
	remoteDigests := func() string {
		t.Helper()
		output, err := qaTunnel.ExecRemote("sha256sum -- " + shellQuote(m.ServerPath+"/proof.txt") + "; if [ -f " + shellQuote(m.ServerPath+"/transfer.bin") + " ]; then sha256sum -- " + shellQuote(m.ServerPath+"/transfer.bin") + "; fi")
		if err != nil {
			t.Fatal("owned remote canary observation failed")
		}
		return output
	}
	if phase == "interrupt" {
		if !parentBoundary() {
			t.Fatal("selected-folder synchronization crossed the parent Git/index/file boundary")
		}
		if _, err := runMutagen("sync", "pause", m.SyncName); err != nil {
			t.Fatal("owned QA session could not be paused before the canary edit")
		}
		file, err := os.OpenFile(filepath.Join(local, "transfer.bin"), os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
		if err != nil {
			t.Fatal(err)
		}
		_, copyErr := io.CopyN(file, rand.Reader, 64*1024*1024)
		closeErr := file.Close()
		if copyErr != nil || closeErr != nil {
			t.Fatal("could not prepare the owned 64MiB transfer canary")
		}
		observed.SeedSHA256, observed.TransferSHA256 = fileDigest("proof.txt"), fileDigest("transfer.bin")
		completed := make(chan map[string]any, 1)
		go func() { completed <- bridge.SyncProject(m.ServerPath) }()
		deadline := time.Now().Add(30 * time.Second)
		for observed.LeaseID == "" {
			select {
			case <-completed:
				t.Fatal("synchronization ended before a matching real lease could be interrupted")
			default:
			}
			record, err := loadSyncRelease(m)
			if err != nil {
				t.Fatal("owned journal could not be observed")
			}
			if record != nil {
				state, err := executeRemoteLease(m, "read", "", "")
				lease, _ := state["lease"].(map[string]any)
				if err == nil && lease["id"] == record.ID && lease["epoch"] == record.Epoch && lease["owner"] == "sync" {
					observed.LeaseID = record.ID
					break
				}
			}
			if !time.Now().Before(deadline) {
				t.Fatal("matching real synchronization lease was not observed within 30s")
			}
			time.Sleep(20 * time.Millisecond)
		}
		deadline = time.Now().Add(20 * time.Second)
		for observed.TransferObserved == "" {
			select {
			case <-completed:
				t.Fatal("SyncProject completed before a resumed canary transfer could be interrupted")
			default:
			}
			sessions, err := syncSessions(m.SyncName)
			if err != nil || len(sessions) != 1 || !syncSessionMatchesMapping(sessions[0], m, store.config()) {
				t.Fatal("owned canary transfer session could not be observed")
			}
			if !sessions[0].Paused && syncSessionInfo(sessions[0]).Status == "syncing" {
				observed.TransferObserved = sessions[0].Status
				break
			}
			if !time.Now().Before(deadline) {
				t.Fatal("resumed real canary transfer was not observed within 20s")
			}
			time.Sleep(20 * time.Millisecond)
		}
		bridge.EndServerSession(apiConnection.version)
		select {
		case result := <-completed:
			if result["ok"] == true {
				t.Fatal("account interruption was reported as synchronization success")
			}
			observed.InterruptedCode, _ = result["code"].(string)
		case <-time.After(20 * time.Second):
			t.Fatal("normal account cancellation did not return within 20s")
		}
		record, err := loadSyncRelease(m)
		observed.JournalRetained = err == nil && record != nil && record.ID == observed.LeaseID
		sessions, err := syncSessions(m.SyncName)
		observed.DaemonPaused = err == nil && len(sessions) == 1 && sessions[0].Paused
		state, err := executeRemoteLease(m, "read", "", "")
		lease, _ := state["lease"].(map[string]any)
		if err != nil || lease["id"] != observed.LeaseID || lease["epoch"] != m.BindingEpoch || lease["owner"] != "sync" || !observed.JournalRetained || !observed.DaemonPaused {
			t.Fatal("interrupted synchronization lost its exact journal/lease or daemon pause")
		}
		before := remoteDigests()
		time.Sleep(1200 * time.Millisecond)
		observed.StableFiles = before == remoteDigests() && fileDigest("proof.txt") == observed.SeedSHA256 && fileDigest("transfer.bin") == observed.TransferSHA256 && strings.HasPrefix(before, observed.SeedSHA256)
		if strings.Contains(before, "transfer.bin") && !strings.Contains(before, observed.TransferSHA256) {
			t.Fatal("interruption published an incomplete transfer canary")
		}
		if !observed.StableFiles {
			t.Fatal("canary files changed after confirmed cancellation/pause")
		}
		observed.SelectedGitBoundary = parentBoundary()
		if !observed.SelectedGitBoundary {
			t.Fatal("cancellation changed the owned parent repository boundary")
		}
		writeObservation(phase)
		t.Log("PASS normal account cancellation retains exact durable lease/journal, pauses real daemon and preserves stable canary bytes")
		return
	}
	if phase != "recover" && phase != "cleanup" {
		t.Fatal("unsupported QA child phase")
	}
	if phase == "recover" {
		raw, err := os.ReadFile(filepath.Join(profile, "interrupt.json"))
		var first controllerRestartObservation
		if err != nil || json.Unmarshal(raw, &first) != nil || first.Remote != m.ServerPath || first.Epoch != m.BindingEpoch || first.PID == os.Getpid() {
			t.Fatal("fresh process did not load the interrupted owned profile")
		}
		observed.LeaseID, observed.SeedSHA256, observed.TransferSHA256 = first.LeaseID, first.SeedSHA256, first.TransferSHA256
		observed.ParentIndexSHA256, observed.ParentFileSHA256 = first.ParentIndexSHA256, first.ParentFileSHA256
		record, err := loadSyncRelease(m)
		if err != nil || record == nil || record.ID != first.LeaseID {
			t.Fatal("fresh Go process did not retain the exact interrupted journal")
		}
		state, err := executeRemoteLease(m, "read", "", "")
		lease, _ := state["lease"].(map[string]any)
		if err != nil || lease["id"] != first.LeaseID || lease["epoch"] != m.BindingEpoch || lease["owner"] != "sync" {
			t.Fatal("fresh login changed the interrupted reservation before explicit recovery")
		}
	}
	if record, err := loadSyncRelease(m); err != nil || record != nil || phase == "recover" {
		if result := bridge.SyncProject(m.ServerPath); result["ok"] != true {
			t.Fatal("normal SyncProject did not recover the owned interrupted project", result["error"])
		}
	}
	// SyncProject persists a new copy when it first creates the daemon session.
	m = store.findMappingByLocal(local)
	observed.SyncName = m.SyncName
	record, err := loadSyncRelease(m)
	observed.JournalCleared = err == nil && record == nil
	state, err := executeRemoteLease(m, "read", "", "")
	observed.LeaseCleared = err == nil && state["lease"] == nil
	if !observed.JournalCleared || !observed.LeaseCleared {
		t.Fatal("successful explicit recovery did not confirm journal and lease removal")
	}
	if phase == "recover" {
		if fileDigest("proof.txt") != observed.SeedSHA256 || fileDigest("transfer.bin") != observed.TransferSHA256 {
			t.Fatal("restart changed owned local file bytes")
		}
		digests := remoteDigests()
		if !strings.Contains(digests, observed.SeedSHA256) || !strings.Contains(digests, observed.TransferSHA256) {
			t.Fatal("restart recovery did not transfer the exact local canaries")
		}
		// The real server mutation must call this fresh process's HTTP sync handlers.
		folderBody, _ := json.Marshal(map[string]string{"path": m.ServerPath + "/controller-callback"})
		folder := bridge.ServerRequest(bridge.BeginServerRequest(), http.MethodPost, "/api/file-tree/create-folder", map[string]string{"Authorization": "Bearer " + apiConnection.accessToken, "Content-Type": "application/json"}, base64.StdEncoding.EncodeToString(folderBody))
		info, statErr := os.Stat(filepath.Join(local, "controller-callback"))
		observed.ControllerCall = folder.Status == http.StatusOK && statErr == nil && info.IsDir()
		seen := map[string]bool{}
		runID := ""
		for len(callbacks) > 0 {
			callback := <-callbacks
			if callback.root != m.ServerPath || callback.epoch != m.BindingEpoch || callback.id == "" || !callback.ok || (runID != "" && runID != callback.id) {
				observed.ControllerCall = false
			}
			runID = callback.id
			seen[callback.op] = true
		}
		observed.ControllerCall = observed.ControllerCall && seen["sync_begin"] && seen["sync_end"] && seen["sync_released"]
		if !observed.ControllerCall {
			t.Fatalf("real server -> fresh HTTP controller -> local handback failed (HTTP %d)", folder.Status)
		}
		state, err := executeRemoteLease(m, "read", "", "")
		if err != nil || state["lease"] != nil {
			t.Fatal("HTTP controller callback retained a server task lease")
		}
		before := remoteDigests()
		time.Sleep(1200 * time.Millisecond)
		observed.StableFiles = before == remoteDigests() && fileDigest("proof.txt") == observed.SeedSHA256 && fileDigest("transfer.bin") == observed.TransferSHA256
		if !observed.StableFiles {
			t.Fatal("owned canaries changed after confirmed restart handback")
		}
		observed.SelectedGitBoundary = parentBoundary()
		if !observed.SelectedGitBoundary {
			t.Fatal("fresh process recovery/callback crossed the owned parent repository boundary")
		}
	}
	stopSyncMonitor(true)
	sessions, err := syncSessions(m.SyncName)
	if err != nil || (phase == "recover" && len(sessions) != 1) {
		t.Fatal("owned synchronization session cleanup inventory failed", err)
	}
	if len(sessions) > 0 {
		if _, err := runMutagen("sync", "terminate", m.SyncName); err != nil {
			t.Fatal("owned synchronization session could not be terminated", err)
		}
	}
	sessions, err = syncSessions(m.SyncName)
	if err != nil || len(sessions) != 0 {
		t.Fatal("owned synchronization session cleanup unconfirmed")
	}
	// Both absolute targets are derived from this run's sole verified mapping.
	remote := m.ServerPath
	cleanup := "test \"$(readlink -f -- " + shellQuote(remote) + ")\" = " + shellQuote(remote) + " && test ! -e " + shellQuote(remote+".chisa-lease") + " && rm -rf -- " + shellQuote(remote) + " && test ! -e " + shellQuote(remote)
	if _, err := qaTunnel.ExecRemote(cleanup); err != nil {
		t.Fatal("verified exact owned QA project cleanup unconfirmed")
	}
	if _, err := runMutagen("daemon", "stop"); err != nil {
		t.Fatal("owned Mutagen daemon cleanup unconfirmed")
	}
	observed.Cleanup = true
	writeObservation(phase)
	if phase == "recover" {
		t.Log("PASS fresh process normal recovery, observed server HTTP controller callbacks, exact canaries and owned project/session/lease cleanup")
	} else {
		t.Log("PASS exact owned project/session/lease/journal/daemon cleanup")
	}
}
