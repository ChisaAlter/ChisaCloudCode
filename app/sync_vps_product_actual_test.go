//go:build windows && vpsqa

package main

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"regexp"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// This fixture seeds an explicit manual connection in the test process. It
// exercises product migration, SSH, both .3 endpoints and real HTTP callbacks;
// it does not claim to test account login, an installed GUI or a provider model.
type productVPSManifest struct {
	Version                int    `json:"version"`
	RunID                  string `json:"runId"`
	AllowRoot              string `json:"allowRoot"`
	SSHHost                string `json:"sshHost"`
	SSHUser                string `json:"sshUser"`
	SSHPort                int    `json:"sshPort"`
	KeyPath                string `json:"keyPath"`
	KnownHostsPath         string `json:"knownHostsPath"`
	MutagenPath            string `json:"mutagenPath"`
	AgentBundlePath        string `json:"agentBundlePath"`
	RemoteAgentSHA256      string `json:"remoteAgentSHA256"`
	NodeCommandFile        string `json:"nodeCommandFile,omitempty"`
	CallbackTimeoutSeconds int    `json:"callbackTimeoutSeconds,omitempty"`
	RemoteControlBind      string `json:"remoteControlBind,omitempty"`
	ControlHost            string `json:"controlHost,omitempty"`
	KeepRemote             bool   `json:"keepRemote"`
	TrackedFiles           int    `json:"scaleTrackedFiles,omitempty"`
	SaveSamples            int    `json:"scaleSaveSamples,omitempty"`
	IdleSeconds            int    `json:"scaleIdleSeconds,omitempty"`
	EvidencePath           string `json:"scaleEvidencePath,omitempty"`
}

func readProductVPSManifest(t *testing.T) productVPSManifest {
	t.Helper()
	if os.Getenv("CHISA_QA_E2E") != "1" {
		t.Skip("explicit task-owned VPS product fixture opt-in required")
	}
	filename := os.Getenv("CHISA_QA_E2E_MANIFEST")
	if !filepath.IsAbs(filename) {
		t.Fatal("CHISA_QA_E2E_MANIFEST must identify the explicit task manifest")
	}
	input, err := os.ReadFile(filename)
	if err != nil {
		t.Fatal("task manifest unavailable", err)
	}
	var manifest productVPSManifest
	decoder := json.NewDecoder(strings.NewReader(string(input)))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&manifest); err != nil {
		t.Fatal("invalid task manifest", err)
	}
	if manifest.Version != 1 || !regexp.MustCompile(`^[a-f0-9]{32}$`).MatchString(manifest.RunID) ||
		manifest.AllowRoot != "/opt/chisacloudcode/workspaces/.qa-sync-e2e-"+manifest.RunID {
		t.Fatal("manifest does not authorize one exact task root")
	}
	if !regexp.MustCompile(`^[a-zA-Z0-9_.-]+$`).MatchString(manifest.SSHHost) ||
		!regexp.MustCompile(`^[a-zA-Z0-9_.-]+$`).MatchString(manifest.SSHUser) || manifest.SSHPort < 1 || manifest.SSHPort > 65535 ||
		!regexp.MustCompile(`^[a-f0-9]{64}$`).MatchString(manifest.RemoteAgentSHA256) {
		t.Fatal("manifest transport or agent proof is invalid")
	}
	for _, filename := range []string{manifest.KeyPath, manifest.KnownHostsPath, manifest.MutagenPath, manifest.AgentBundlePath} {
		if !filepath.IsAbs(filename) {
			t.Fatal("task resources must be explicit absolute paths")
		}
		info, err := os.Stat(filename)
		if err != nil || !info.Mode().IsRegular() {
			t.Fatal("an explicit task resource is unavailable")
		}
	}
	if manifest.RemoteControlBind == "" {
		manifest.RemoteControlBind = "127.0.0.1"
	}
	if manifest.ControlHost == "" {
		manifest.ControlHost = "127.0.0.1"
	}
	controlIP := net.ParseIP(manifest.ControlHost)
	if manifest.RemoteControlBind != "127.0.0.1" && manifest.RemoteControlBind != "0.0.0.0" || controlIP == nil || !(controlIP.IsLoopback() || controlIP.IsPrivate()) {
		t.Fatal("callback binds must be explicit loopback or task private-network endpoints")
	}
	if manifest.RemoteControlBind == "0.0.0.0" && (!controlIP.IsPrivate() || controlIP.To4() == nil) {
		t.Fatal("managed wildcard callback requires an explicit private IPv4 control host")
	}
	if manifest.CallbackTimeoutSeconds == 0 {
		manifest.CallbackTimeoutSeconds = 600
	}
	if manifest.CallbackTimeoutSeconds < 30 || manifest.CallbackTimeoutSeconds > 1800 {
		t.Fatal("callback timeout must be between 30 and 1800 seconds")
	}
	if manifest.NodeCommandFile != "" && (path.Clean(manifest.NodeCommandFile) != manifest.NodeCommandFile || !strings.HasPrefix(manifest.NodeCommandFile, manifest.AllowRoot+"/tools/")) {
		t.Fatal("optional Node command must be a task-owned tools script")
	}
	return manifest
}

// The helper is a test tool, built into the private fixture resources. Only
// Mutagen's exact synchronizer command is forwarded. Automatic installer/SCP
// fallback is forbidden, and both remote cwd and data directory stay task-owned.
const productVPSAgentSSHHelper = `package main
import (
 "fmt"
 "os"
 "os/exec"
 "path/filepath"
 "regexp"
 "strings"
 "syscall"
 "unsafe"
 "golang.org/x/sys/windows"
)
func quote(s string) string { return "'"+strings.ReplaceAll(s,"'","'\"'\"'")+"'" }
func main() {
 fail:=func(message string){fmt.Fprintln(os.Stderr,message);os.Exit(125)}
 if strings.ToLower(filepath.Base(os.Args[0]))!="ssh.exe" {fail("fixture disables automatic SCP/agent installation")}
 args:=append([]string(nil),os.Args[1:]...)
 alias,home:=os.Getenv("CHISA_QA_E2E_ALIAS"),os.Getenv("CHISA_QA_E2E_AGENT_HOME")
 if len(args)<2 || args[len(args)-2]!=alias || alias=="" || home=="" {fail("unexpected fixture SSH target")}
 command:=args[len(args)-1]
 if !regexp.MustCompile(` + "`" + `^\.mutagen/agents/0\.18\.1-chisa\.3/mutagen-agent synchronizer --log-level=[a-z]+$` + "`" + `).MatchString(command) {fail("fixture only admits the staged .3 synchronizer")}
 args[len(args)-1]="cd "+quote(home)+" && env HOME="+quote(home)+" MUTAGEN_DATA_DIRECTORY="+quote(home+"/.mutagen")+" "+command
 config:=filepath.Join(os.Getenv("CHISA_DATA_DIR"),"sync-ssh.conf")
 tool:=filepath.Join(os.Getenv("WINDIR"),"System32","OpenSSH","ssh.exe")
 cmd:=exec.Command(tool,append([]string{"-F",config},args...)...)
 cmd.Stdin,cmd.Stdout,cmd.Stderr=os.Stdin,os.Stdout,os.Stderr
 cmd.SysProcAttr=&syscall.SysProcAttr{HideWindow:true,CreationFlags:0x08000000}
 job,err:=windows.CreateJobObject(nil,nil);if err!=nil {fail("cannot own fixture SSH child")}
 limits:=windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION{}
 limits.BasicLimitInformation.LimitFlags=windows.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
 if _,err=windows.SetInformationJobObject(job,windows.JobObjectExtendedLimitInformation,uintptr(unsafe.Pointer(&limits)),uint32(unsafe.Sizeof(limits)));err!=nil {fail("cannot bound fixture SSH child")}
 if err=windows.AssignProcessToJobObject(job,windows.CurrentProcess());err!=nil {fail("cannot assign fixture SSH child")}
 if err=cmd.Run();err!=nil {if exit,ok:=err.(*exec.ExitError);ok {os.Exit(exit.ExitCode())};fail("fixture SSH failed")}
}
`

type productVPSFixture struct {
	manifest       productVPSManifest
	mapping        *Mapping
	transport      *Tunnel
	connection     *serverConnection
	private        string
	callbacks      atomic.Int64
	dropNextEnd    atomic.Bool
	events         chan map[string]any
	forward        *exec.Cmd
	forwardWait    chan error
	projectCreated bool
}

func newProductVPSFixture(t *testing.T, manifest productVPSManifest) *productVPSFixture {
	t.Helper()
	originalDirectory, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	buildEnvironment := os.Environ() // Resolve the already-available app-module cache before private profile overrides.
	private := t.TempDir()
	profile := filepath.Join(private, "profile")
	for name, relative := range map[string]string{"APPDATA": "roaming", "LOCALAPPDATA": "local", "USERPROFILE": "user", "HOME": "user", "XDG_CONFIG_HOME": "xdg"} {
		value := filepath.Join(profile, relative)
		if err := os.MkdirAll(value, 0700); err != nil {
			t.Fatal(err)
		}
		t.Setenv(name, value)
	}
	t.Setenv("CHISA_DATA_DIR", filepath.Join(profile, "data"))
	t.Setenv("MUTAGEN_DATA_DIRECTORY", filepath.Join(dataDir(), "mutagen"))
	t.Setenv("MUTAGEN_DISABLE_AUTOSTART", "")
	for _, entry := range os.Environ() {
		key, _, _ := strings.Cut(entry, "=")
		if strings.HasPrefix(strings.ToUpper(key), "GIT_") {
			t.Setenv(key, "") // Register restoration before removing an inherited redirect.
			if err := os.Unsetenv(key); err != nil {
				t.Fatal(err)
			}
		}
	}
	gitConfig := filepath.Join(private, "gitconfig")
	if err := os.WriteFile(gitConfig, []byte("[user]\n name = Product fixture\n email = fixture@localhost\n[commit]\n gpgSign = false\n[core]\n autocrlf = false\n"), 0600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("GIT_CONFIG_NOSYSTEM", "1")
	t.Setenv("GIT_CONFIG_GLOBAL", gitConfig)
	t.Setenv("GIT_TERMINAL_PROMPT", "0")
	if err := os.MkdirAll(filepath.Join(private, "resources", "windows-amd64", "sync-ssh"), 0700); err != nil {
		t.Fatal(err)
	}
	binary := filepath.Join(private, "resources", "mutagen.exe")
	copyVPSQAResource(t, manifest.MutagenPath, binary)
	copyVPSQAResource(t, manifest.AgentBundlePath, filepath.Join(private, "resources", "mutagen-agents.tar.gz"))
	known := filepath.Join(private, "ssh", "known_hosts")
	copyVPSQAResource(t, manifest.KnownHostsPath, known)
	if err := os.WriteFile(filepath.Join(filepath.Dir(known), "ssh_config"), nil, 0600); err != nil {
		t.Fatal(err)
	}
	helperSource := filepath.Join(private, "agent_ssh_fixture.go")
	if err := os.WriteFile(helperSource, []byte(productVPSAgentSSHHelper), 0600); err != nil {
		t.Fatal(err)
	}
	helper := filepath.Join(private, "resources", "windows-amd64", "sync-ssh", "ssh.exe")
	buildContext, cancelBuild := context.WithTimeout(context.Background(), 60*time.Second)
	build := exec.CommandContext(buildContext, "go", "build", "-o", helper, helperSource)
	build.Dir = originalDirectory
	build.Env = append(buildEnvironment, "GOWORK=off", "GOPROXY=off", "GOSUMDB=off") // The fixture helper must build from existing dependencies without a network fetch.
	output, err := build.CombinedOutput()
	cancelBuild()
	if err != nil {
		t.Fatalf("private test transport helper build: %v\n%s", err, output)
	}
	copyVPSQAResource(t, helper, filepath.Join(filepath.Dir(helper), "scp.exe"))
	t.Chdir(private)
	resolved, err := filepath.Abs(mutagenExe())
	if err != nil || resolved != binary {
		t.Fatal("fixture did not select its explicitly copied engine")
	}
	sshPath, err := mutagenSSHPath()
	if err != nil || sshPath != filepath.Dir(helper) {
		t.Fatal("fixture did not select its owned SSH helper")
	}
	versionContext, cancelVersion := context.WithTimeout(context.Background(), 5*time.Second)
	version, err := runMutagenContext(versionContext, "version")
	cancelVersion()
	if err != nil || strings.TrimSpace(version) != workspaceSyncEngineVersion {
		t.Fatal("explicit engine is not the required current .3 version")
	}
	f := &productVPSFixture{manifest: manifest, private: private, events: make(chan map[string]any, 128)}
	productMux := http.NewServeMux()
	registerFSEndpoints(productMux)
	mux := http.NewServeMux()
	mux.HandleFunc("/workspace/rpc", func(w http.ResponseWriter, r *http.Request) {
		body, err := io.ReadAll(io.LimitReader(r.Body, 16*1024*1024+1))
		if err != nil || len(body) > 16*1024*1024 {
			http.Error(w, "request unavailable", http.StatusBadRequest)
			return
		}
		var request map[string]any
		_ = json.Unmarshal(body, &request)
		r.Body = io.NopCloser(bytes.NewReader(body))
		response := httptest.NewRecorder()
		productMux.ServeHTTP(response, r)
		var result map[string]any
		_ = json.Unmarshal(response.Body.Bytes(), &result)
		operation, _ := request["op"].(string)
		if operation == "sync_begin" || operation == "sync_end" {
			event := map[string]any{"op": operation, "runId": request["runId"], "ok": result["ok"], "snapshotPinned": result["snapshotPinned"], "releasedRunId": result["releasedRunId"], "bindingEpoch": result["bindingEpoch"]}
			select {
			case f.events <- event:
			default:
			}
			t.Logf("actual native event op=%s run=%v ok=%v pinned=%v released=%v", operation, request["runId"], result["ok"], result["snapshotPinned"], result["releasedRunId"])
		}
		if operation == "sync_end" && result["ok"] == true && f.dropNextEnd.CompareAndSwap(true, false) {
			// Failure injection happens only after the real product release has
			// completed. Never synthesize a receipt or replay a mutating request.
			if hijack, ok := w.(http.Hijacker); ok {
				connection, _, err := hijack.Hijack()
				if err == nil {
					connection.Close()
					return
				}
			}
			http.Error(w, "fixture dropped completed release reply", http.StatusServiceUnavailable)
			return
		}
		for key, values := range response.Header() {
			w.Header()[key] = values
		}
		w.WriteHeader(response.Code)
		_, _ = w.Write(response.Body.Bytes())
	})
	mux.HandleFunc("/_fixture/control/"+manifest.RunID, func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "method", http.StatusMethodNotAllowed)
			return
		}
		if store == nil || r.Header.Get("X-Bridge-Token") != store.config().Token {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		f.dropNextEnd.Store(true)
		jsonResp(w, http.StatusOK, map[string]any{"ok": true, "armed": "drop-next-completed-sync-end-reply"})
	})
	mux.HandleFunc("/_fixture/ready/"+manifest.RunID, func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			http.Error(w, "method", http.StatusMethodNotAllowed)
			return
		}
		f.callbacks.Add(1)
		fmt.Fprint(w, manifest.RunID)
	})
	controller := httptest.NewServer(mux)
	t.Cleanup(controller.Close)
	cfg := Config{SSHHost: manifest.SSHHost, SSHUser: manifest.SSHUser, SSHPort: manifest.SSHPort,
		KeyPath: manifest.KeyPath, SSHKnownHostsPath: known, SSHHostKeyPinned: true, Token: randHex(24),
		ServerURL: controller.URL, WorkspaceServerURL: controller.URL, LoginURL: controller.URL, WorkspaceLoginURL: controller.URL,
		WorkspaceRoot: manifest.AllowRoot + "/workspaces", ControlHost: manifest.ControlHost}
	connection, err := newServerConnection(controller.URL, controller.URL)
	if err != nil {
		t.Fatal(err)
	}
	connection.authenticated = true // Explicit seeded manual transport; no account login claim.
	f.connection, f.transport = connection, newTunnel(cfg, manifest.KeyPath, func() {})
	project := filepath.Join(private, "local project")
	if err := os.Mkdir(project, 0700); err != nil {
		t.Fatal(err)
	}
	m := &Mapping{LocalPath: project, ServerPath: manifest.AllowRoot + "/workspaces/native-project", BindingEpoch: randHex(16), ServerID: serverIdentity(cfg)}
	f.mapping = m
	oldStore, oldTunnel, oldConnection := store, tunnel, apiConnection
	serverConnectionMu.Lock()
	store = &Store{path: filepath.Join(dataDir(), "state.json"), Cfg: cfg, Mappings: []*Mapping{m}}
	tunnel, apiConnection = f.transport, connection
	serverConnectionMu.Unlock()
	t.Cleanup(func() {
		stopSyncMonitor(false)
		forgetSyncIgnoreObservation(m)
		syncRemoteObservationPool.Lock()
		for key, observer := range syncRemoteObservationPool.observers {
			if key.transport == f.transport {
				delete(syncRemoteObservationPool.observers, key)
				observer.close()
			}
		}
		syncRemoteObservationPool.Unlock()
		if current := store.findMappingByServer(m.ServerPath); current != nil && current.SyncName != "" {
			if _, err := runMutagenTimeout(20*time.Second, "sync", "terminate", current.SyncName); err != nil {
				t.Error("owned session cleanup", err)
			}
		}
		if _, err := runMutagenTimeout(15*time.Second, "daemon", "stop"); err != nil {
			t.Error("private daemon cleanup", err)
		}
		if f.projectCreated && !manifest.KeepRemote {
			cleanup, stopCleanup := context.WithTimeout(context.Background(), 30*time.Second)
			payload, _ := json.Marshal(map[string]string{"root": manifest.AllowRoot, "id": manifest.RunID})
			_, cleanupErr := f.transport.ExecRemoteContext(cleanup, "python3 -c "+shellQuote(`import json,pathlib,shutil,sys
q=json.loads(sys.argv[1]);root=pathlib.Path(q['root']);assert root.resolve()==root and (root/'.native-qa-owner').read_text()==q['id']+'\n'
for name in ('workspaces/native-project','workspaces/native-project.chisa-lease'):
 target=root/name
 if target.exists():
  assert target.resolve()==target
  shutil.rmtree(target)
for name in ('workspaces/native-project.chisa-lease.guard','control/native.json'):
 target=root/name
 if target.exists():
  assert target.resolve()==target
  target.unlink()
print('owned-native-project-removed')`)+" "+shellQuote(string(payload)))
			stopCleanup()
			if cleanupErr != nil {
				t.Error("exact task project cleanup", cleanupErr)
			}
		}
		connection.cancel()
		connection.client.CloseIdleConnections()
		f.transport.stop()
		if f.forward != nil {
			_ = f.forward.Process.Kill()
			select {
			case <-f.forwardWait:
			case <-time.After(5 * time.Second):
				t.Error("owned reverse SSH process did not confirm exit")
			}
		}
		serverConnectionMu.Lock()
		store, tunnel, apiConnection = oldStore, oldTunnel, oldConnection
		serverConnectionMu.Unlock()
		for _, table := range []interface{ Delete(any) }{&syncStates, &cloudReservations, &cloudSyncRecovery, &workspaceLocks, &pendingSyncReleases} {
			table.Delete(m.ServerPath)
		}
	})
	alias, err := prepareSyncSSH(cfg, manifest.KeyPath)
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("CHISA_QA_E2E_ALIAS", alias)
	t.Setenv("CHISA_QA_E2E_AGENT_HOME", manifest.AllowRoot+"/tools/home")
	// No remote command has run before this point: manifest/resource checks and
	// the helper build are entirely local and task-owned.
	parent, cancel := context.WithTimeout(context.Background(), 40*time.Second)
	defer cancel()
	request, _ := json.Marshal(map[string]any{"root": manifest.AllowRoot, "id": manifest.RunID, "sha256": manifest.RemoteAgentSHA256, "version": workspaceSyncEngineVersion})
	probe := `import hashlib,json,os,pathlib,sys
q=json.loads(sys.argv[1]);root=pathlib.Path(q['root'])
assert root.resolve()==root and root.is_dir()
assert (root/'.native-qa-owner').read_text()==q['id']+'\n'
home=root/'tools/home';agent=home/'.mutagen/agents'/q['version']/'mutagen-agent'
assert agent.resolve()==agent and agent.is_file() and os.access(agent,os.X_OK)
assert hashlib.sha256(agent.read_bytes()).hexdigest()==q['sha256']
workspaces=root/'workspaces';assert workspaces.resolve()==workspaces and workspaces.is_dir()
project=workspaces/'native-project'
assert not project.exists() and not project.is_symlink()
config=home/'.gitconfig';assert not config.exists() and not config.is_symlink()
config.write_text('[safe]\n directory = '+str(project)+'\n');os.chmod(config,0o600)
project.mkdir(mode=0o755);os.chown(project,1000,1000)
print('fixture-root-and-agent-verified')`
	if output, err := f.transport.ExecRemoteContext(parent, "python3 -c "+shellQuote(probe)+" "+shellQuote(string(request))); err != nil || output != "fixture-root-and-agent-verified" {
		t.Fatal("task root/pre-staged agent proof failed", err)
	}
	f.projectCreated = true
	address := strings.TrimPrefix(controller.URL, "http://")
	forward := hideCommandWindow(exec.Command(sshExe(), append([]string{"-N", "-R", manifest.RemoteControlBind + ":0:" + address}, f.transport.baseArgs()...)...))
	stderr, err := forward.StderrPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := forward.Start(); err != nil {
		t.Fatal(err)
	}
	wait := make(chan error, 1)
	f.forward, f.forwardWait = forward, wait
	go func() { wait <- forward.Wait() }()
	allocated := make(chan int, 1)
	go func() {
		scanner := bufio.NewScanner(stderr)
		for scanner.Scan() {
			var port int
			if _, err := fmt.Sscanf(scanner.Text(), "Allocated port %d for remote forward", &port); err == nil && port > 0 {
				select {
				case allocated <- port:
				default:
				}
			}
		}
	}()
	var remotePort int
	select {
	case remotePort = <-allocated:
	case err := <-wait:
		f.forward = nil
		t.Fatal("owned SSH forward exited before allocation", err)
	case <-time.After(20 * time.Second):
		t.Fatal("owned reverse SSH allocation timed out")
	}
	if remotePort < 1024 || remotePort > 65535 {
		t.Fatal("invalid task callback port")
	}
	ready := fmt.Sprintf("http://127.0.0.1:%d/_fixture/ready/%s", remotePort, manifest.RunID)
	proof := "import urllib.request;print(urllib.request.urlopen(" + fmt.Sprintf("%q", ready) + ",timeout=10).read().decode())"
	if output, err := f.transport.ExecRemoteContext(parent, "python3 -c "+shellQuote(proof)); err != nil || output != manifest.RunID || f.callbacks.Load() != 1 {
		t.Fatal("real remote TCP callback did not reach the owned native listener", err)
	}
	f.transport.mu.Lock()
	f.transport.proc, f.transport.bridgePort, f.transport.bridgeReady = forward, remotePort, true
	f.transport.connectionContext, f.transport.connectionCancel = context.WithCancel(context.Background())
	f.transport.mu.Unlock()
	// Confirm that the effective alias belongs to this private profile; do not
	// consult or mutate the user's SSH aliases or default known-hosts database.
	if !filepath.IsAbs(sshPath) || net.ParseIP(strings.Split(address, ":")[0]) == nil {
		t.Fatal("fixture transport was not bound to an explicit local endpoint")
	}
	t.Logf("manual fixture ready: task=%s callback-port=%d private-profile=%s", manifest.RunID, remotePort, dataDir())
	return f
}

func (f *productVPSFixture) remote(t *testing.T, script string) string {
	t.Helper()
	return f.remoteTimeout(t, 40*time.Second, script)
}

func (f *productVPSFixture) remoteTimeout(t *testing.T, timeout time.Duration, script string) string {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	output, err := f.transport.ExecRemoteContext(ctx, script)
	if err != nil {
		t.Fatal("owned remote operation failed", err)
	}
	return output
}

// RPC data uses the marker's normal token, epoch and actual callback port. The
// token remains on disk/on the authenticated wire and is never emitted in logs.
func (f *productVPSFixture) callback(t *testing.T, operation, id string) map[string]any {
	t.Helper()
	q, _ := json.Marshal(map[string]string{"root": f.mapping.ServerPath, "operation": operation, "id": id})
	worker := `import json,pathlib,sys,urllib.request
q=json.loads(sys.argv[1]);root=pathlib.Path(q['root']);m=json.loads((root/'.chisa-bridge.json').read_text())
body=json.dumps({'op':q['operation'],'runId':q['id']}).encode()
request=urllib.request.Request('http://'+m.get('controlHost','127.0.0.1')+':'+str(m['port'])+'/workspace/rpc',body,{'Content-Type':'application/json','X-Cwd':str(root),'X-Bridge-Token':m['token'],'X-Binding-Epoch':m['bindingEpoch']})
print(urllib.request.urlopen(request,timeout=600).read().decode())`
	output := f.remoteTimeout(t, time.Duration(f.manifest.CallbackTimeoutSeconds)*time.Second, "python3 -c "+shellQuote(worker)+" "+shellQuote(string(q)))
	var result map[string]any
	if err := json.Unmarshal([]byte(output), &result); err != nil || result["ok"] != true {
		t.Fatalf("actual callback %s failed: %v %s", operation, err, output)
	}
	return result
}

func TestVPSProductNativeMigrationAndHandback(t *testing.T) {
	manifest := readProductVPSManifest(t)
	fixture := newProductVPSFixture(t, manifest)
	m := fixture.mapping
	for _, args := range [][]string{{"init", "-b", "main"}, {"config", "core.autocrlf", "false"}} {
		if _, err := gitOutputContext(context.Background(), m.LocalPath, args...); err != nil {
			t.Fatal(err)
		}
	}
	seed := []byte("native product seed " + manifest.RunID + "\n")
	if err := os.WriteFile(filepath.Join(m.LocalPath, "proof.txt"), seed, 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(m.LocalPath, "source-boundary-sentinel.txt"), []byte("native source boundary "+manifest.RunID+"\n"), 0600); err != nil {
		t.Fatal(err)
	}
	for _, args := range [][]string{{"add", "proof.txt", "source-boundary-sentinel.txt"}, {"commit", "-m", "task-owned initial native import"}} {
		if _, err := gitOutputContext(context.Background(), m.LocalPath, args...); err != nil {
			t.Fatal(err)
		}
	}
	defer func() {
		var events []map[string]any
		for {
			select {
			case event := <-fixture.events:
				events = append(events, event)
			default:
				t.Logf("actual native callback events=%v", events)
				return
			}
		}
	}()
	started := time.Now()
	ctx, cancel := context.WithTimeout(context.Background(), 35*time.Minute)
	defer cancel()
	if result := syncProjectWithEmptyConfirmationContext(ctx, m.ServerPath, ""); result["ok"] != true {
		t.Fatalf("real product migration failed: %v", result["error"])
	}
	m = store.findMappingByServer(m.ServerPath)
	fixture.mapping = m
	if m == nil || m.Mode != "vps" || m.SyncName == "" {
		t.Fatal("real import did not persist the migrated mapping")
	}
	sessions, err := syncSessions(m.SyncName)
	if err != nil || len(sessions) != 1 || !syncSessionHasDynamicGitPolicy(sessions[0]) || !sessions[0].Alpha.Connected || !sessions[0].Beta.Connected {
		t.Fatal("current .3 real endpoints/dynamic policy not confirmed", err)
	}
	publish, _ := json.Marshal(map[string]any{"root": manifest.AllowRoot, "runId": manifest.RunID, "sourceRoot": m.ServerPath, "workspacesRoot": manifest.AllowRoot + "/workspaces", "bindingEpoch": m.BindingEpoch,
		"controlHost": manifest.ControlHost, "controlPort": fixture.transport.bridgePort, "markerPath": m.ServerPath + "/.chisa-bridge.json", "dropCompletedSyncEndReplyURL": fmt.Sprintf("http://%s:%d/_fixture/control/%s", manifest.ControlHost, fixture.transport.bridgePort, manifest.RunID)})
	fixture.remote(t, "python3 -c "+shellQuote(`import json,os,pathlib,sys
q=json.loads(sys.argv[1]);root=pathlib.Path(q['root']);assert root.resolve()==root and (root/'.native-qa-owner').read_text()==q['runId']+'\n'
control=root/'control';control.mkdir(mode=0o700,exist_ok=True);assert control.resolve()==control
# Manual fixture registration writes the actual native token/port/epoch first.
# Only the task marker gains the explicit managed network callback address.
marker=pathlib.Path(q['markerPath']);m=json.loads(marker.read_text());assert marker.resolve()==marker and m['bindingEpoch']==q['bindingEpoch'] and m['port']==q['controlPort']
m['controlHost']=q['controlHost'];temporary=marker.with_name(marker.name+'.qa-tmp');temporary.write_text(json.dumps(m));os.chmod(temporary,0o600);os.chown(temporary,1000,1000);os.replace(temporary,marker)
file=control/'native.json';temporary=control/'native.json.tmp';temporary.write_text(json.dumps(q));os.chmod(temporary,0o600);os.chown(temporary,1000,1000);os.replace(temporary,file)
print('native-callback-manifest-ready')`)+" "+shellQuote(string(publish)))
	if manifest.NodeCommandFile != "" {
		// An explicit task-owned script can invoke the actual TS admission and
		// Docker layer after reading control/native.json and the normal marker.
		fixture.remoteTimeout(t, time.Duration(manifest.CallbackTimeoutSeconds)*time.Second, "test -f "+shellQuote(manifest.NodeCommandFile)+" && bash "+shellQuote(manifest.NodeCommandFile)+" "+shellQuote(manifest.AllowRoot+"/control/native.json"))
	}
	id := randHex(16)
	if _, err := remoteLeaseContext(ctx, m, "claim", "claude", id); err != nil {
		t.Fatal(err)
	}
	fixture.callback(t, "sync_begin", id)
	changed := []byte("native actual remote handback " + manifest.RunID + "\n")
	q, _ := json.Marshal(map[string]string{"root": m.ServerPath, "content": string(changed), "id": id, "epoch": m.BindingEpoch})
	fixture.remote(t, "python3 -c "+shellQuote(`import fcntl,json,os,pathlib,sys
q=json.loads(sys.argv[1]);root=pathlib.Path(q['root']);lock=pathlib.Path(str(root)+'.chisa-lease');guard=pathlib.Path(str(root)+'.chisa-lease.guard')
with guard.open('a+b') as held:
 fcntl.flock(held,fcntl.LOCK_EX)
 state=json.loads((lock/'state.json').read_text());assert state['id']==q['id'] and state['epoch']==q['epoch'] and state['owner']=='claude'
 (root/'proof.txt').write_text(q['content']);os.chown(root/'proof.txt',1000,1000)
 state.update(owner='sync-needed',mayWrite=True);temporary=lock/'state.json.tmp';temporary.write_text(json.dumps(state));os.chmod(temporary,0o600);os.replace(temporary,lock/'state.json')
print('remote-fixture-edited')`)+" "+shellQuote(string(q)))
	receipt := fixture.callback(t, "sync_end", id)
	if receipt["releasedRunId"] != id || receipt["bindingEpoch"] != m.BindingEpoch {
		t.Fatal("handback did not return exact release identity")
	}
	actual, err := os.ReadFile(filepath.Join(m.LocalPath, "proof.txt"))
	if err != nil || sha256.Sum256(actual) != sha256.Sum256(changed) {
		t.Fatal("real handback did not converge exact local bytes", err)
	}
	lease, err := remoteLeaseContext(ctx, m, "read", "", "")
	if err != nil || lease["lease"] != nil {
		t.Fatal("real handback left a workspace lease", err)
	}
	verificationID := randHex(16)
	if _, err := remoteLeaseContext(ctx, m, "claim", "sync", verificationID); err != nil {
		t.Fatal("could not reserve exact metadata verification", err)
	}
	defer func() {
		cleanup, stop := context.WithTimeout(context.Background(), 30*time.Second)
		defer stop()
		if _, err := remoteLeaseContext(cleanup, m, "release", "sync", verificationID); err != nil {
			t.Error("exact verification lease release", err)
		}
	}()
	verificationContext := syncLeaseContext(ctx, verificationID)
	local, err := readLocalGitState(verificationContext, m)
	if err != nil {
		t.Fatal(err)
	}
	remote, err := readRemoteGitState(verificationContext, m)
	if err != nil || local != remote {
		t.Fatal("real native handback left divergent Git metadata", err)
	}
	digest := sha256.Sum256(actual)
	t.Logf("PASS actual manual native migration+SSH callback+sync_begin/end: elapsed=%s bytes-sha256=%s session=%s task=%s", time.Since(started), hex.EncodeToString(digest[:]), m.SyncName, manifest.RunID)
}
