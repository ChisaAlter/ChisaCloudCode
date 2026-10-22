package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"testing"
	"time"
)

// A real child process exercises framing, cancellation and unknown outcomes
// without SSH or a user profile. It records each received mutation once.
func TestSyncRemoteLeaseChild(t *testing.T) {
	if os.Getenv("CHISA_LEASE_TEST_CHILD") != "1" {
		return
	}
	mode, nonce := os.Getenv("CHISA_LEASE_TEST_MODE"), os.Getenv("CHISA_LEASE_TEST_NONCE")
	encoder := json.NewEncoder(os.Stdout)
	_ = encoder.Encode(map[string]any{"version": 1, "nonce": nonce, "seq": 0, "ready": true, "clockMs": time.Now().UnixMilli()})
	scanner := bufio.NewScanner(os.Stdin)
	scanner.Buffer(make([]byte, 4096), 2*syncRemoteLeaseRequestLimit)
	for scanner.Scan() {
		var frame struct {
			Version int            `json:"version"`
			Nonce   string         `json:"nonce"`
			Seq     uint64         `json:"seq"`
			Request map[string]any `json:"request"`
		}
		if json.Unmarshal(scanner.Bytes(), &frame) != nil {
			os.Exit(3)
		}
		if logPath := os.Getenv("CHISA_LEASE_TEST_LOG"); logPath != "" {
			file, err := os.OpenFile(logPath, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0600)
			if err != nil {
				os.Exit(4)
			}
			_, _ = fmt.Fprintln(file, frame.Seq)
			_ = file.Close()
		}
		if mode == "eof" {
			os.Exit(0)
		}
		if mode == "wait" {
			time.Sleep(10 * time.Second)
			os.Exit(0)
		}
		if mode == "large" {
			fmt.Fprintln(os.Stdout, strings.Repeat("x", syncRemoteLeaseResponseLimit+1))
			continue
		}
		seq, responseNonce := frame.Seq, frame.Nonce
		if mode == "wrong-sequence" {
			seq++
		}
		if mode == "wrong-nonce" {
			responseNonce = "replaced"
		}
		_ = encoder.Encode(map[string]any{"version": 1, "nonce": responseNonce, "seq": seq, "clockMs": time.Now().UnixMilli(), "result": map[string]any{"ok": true, "workerPid": os.Getpid()}})
	}
	os.Exit(0)
}

func newTestSyncRemoteLease(t *testing.T, mode, logPath string) *syncRemoteLease {
	t.Helper()
	self, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	worker, err := newSyncRemoteLease(context.Background(), "fixture-nonce", func(ctx context.Context) *exec.Cmd {
		cmd := exec.CommandContext(ctx, self, "-test.run=^TestSyncRemoteLeaseChild$")
		cmd.Env = append(os.Environ(), "CHISA_LEASE_TEST_CHILD=1", "CHISA_LEASE_TEST_NONCE=fixture-nonce", "CHISA_LEASE_TEST_MODE="+mode, "CHISA_LEASE_TEST_LOG="+logPath)
		return cmd
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		worker.close()
		select {
		case <-worker.done:
		case <-time.After(5 * time.Second):
			t.Error("lease child did not exit")
		}
	})
	return worker
}

func TestSyncRemoteLeaseReusesProcessAndExactFrames(t *testing.T) {
	worker := newTestSyncRemoteLease(t, "echo", "")
	var pid any
	for i := 0; i < 5; i++ {
		result, err := worker.request(context.Background(), map[string]any{"op": "read"})
		if err != nil || result["ok"] != true {
			t.Fatal(result, err)
		}
		if i == 0 {
			pid = result["workerPid"]
		} else if result["workerPid"] != pid {
			t.Fatal("lease worker was replaced between requests")
		}
	}
	if worker.sequence != 5 {
		t.Fatal("request sequence was not exact")
	}
}

func TestSyncRemoteLeaseUnknownResponseNeverReplays(t *testing.T) {
	for _, mode := range []string{"eof", "wrong-sequence", "wrong-nonce", "large", "wait"} {
		t.Run(mode, func(t *testing.T) {
			logPath := filepath.Join(t.TempDir(), "operations.log")
			worker := newTestSyncRemoteLease(t, mode, logPath)
			ctx, cancel := context.WithTimeout(context.Background(), 300*time.Millisecond)
			defer cancel()
			if _, err := worker.request(ctx, map[string]any{"op": "release"}); err == nil {
				t.Fatal("unknown mutation outcome was accepted")
			}
			if !worker.closed.Load() {
				t.Fatal("ambiguous stream remained reusable")
			}
			if _, err := worker.request(context.Background(), map[string]any{"op": "release"}); err == nil {
				t.Fatal("closed channel was reused")
			}
			data, err := os.ReadFile(logPath)
			if err != nil || strings.TrimSpace(string(data)) != "1" {
				t.Fatalf("mutation replayed or not received: %q %v", data, err)
			}
		})
	}
}

func TestSyncRemoteLeaseCanceledBeforeWriteDoesNotPoisonOtherRequest(t *testing.T) {
	worker := newTestSyncRemoteLease(t, "echo", "")
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := worker.request(ctx, map[string]any{"op": "claim"}); err == nil {
		t.Fatal("canceled request was sent")
	}
	if worker.sequence != 0 || worker.closed.Load() {
		t.Fatal("canceled unsent request changed the stream")
	}
	if _, err := worker.request(context.Background(), map[string]any{"op": "read"}); err != nil {
		t.Fatal(err)
	}
}

// Real lease.py operations and the real persistent Python protocol run on
// Windows with a kernel file-lock adapter. Linux uses native flock unchanged.
const syncLeasePythonBootstrap = `import os,sys,types
try:
 import fcntl
except ImportError:
 import msvcrt
 def flock(fd,mode):
  if not isinstance(fd,int):fd=fd.fileno()
  position=os.lseek(fd,0,os.SEEK_CUR);os.lseek(fd,0,os.SEEK_SET)
  try:msvcrt.locking(fd,msvcrt.LK_NBLCK if mode&4 else msvcrt.LK_LOCK,1)
  finally:os.lseek(fd,position,os.SEEK_SET)
 sys.modules['fcntl']=types.SimpleNamespace(LOCK_EX=2,LOCK_NB=4,flock=flock)
 os.fchmod=lambda *args:None
 # Windows select accepts sockets rather than inherited stdio handles. The
 # native Go deadline owns this test pipe; Linux keeps its real idle select.
 import select
 select.select=lambda readers,writers,errors,timeout:(readers,[],[])
ns={'__name__':'sync_lease_test'}
exec(compile(open(sys.argv[1],encoding='utf-8').read(),'<lease-test>','exec'),ns)
ns['serve'](sys.argv[2],sys.argv[3],sys.argv[4])
`

func newPythonSyncRemoteLease(t *testing.T, root string) *syncRemoteLease {
	t.Helper()
	tools := syncSeedTools(t)
	source := filepath.Join(t.TempDir(), "lease.py")
	if err := os.WriteFile(source, []byte(leaseWorker), 0600); err != nil {
		t.Fatal(err)
	}
	worker, err := newSyncRemoteLease(context.Background(), "python-nonce", func(ctx context.Context) *exec.Cmd {
		cmd := exec.CommandContext(ctx, tools.python, "-B", "-u", "-c", syncLeasePythonBootstrap, source, root, "binding", "python-nonce")
		cmd.Env = tools.env
		return cmd
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		worker.close()
		select {
		case <-worker.done:
		case <-time.After(5 * time.Second):
			t.Error("Python lease worker did not exit")
		}
	})
	return worker
}

func leasePythonRequest(root, op, id string) map[string]any {
	return map[string]any{"root": root, "epoch": "binding", "op": op, "owner": "sync", "id": id}
}

func TestSyncRemoteLeasePythonExactOwnershipAndReadOnlyPreview(t *testing.T) {
	root := filepath.Join(t.TempDir(), "project")
	if err := os.Mkdir(root, 0700); err != nil {
		t.Fatal(err)
	}
	worker := newPythonSyncRemoteLease(t, root)
	if result, err := worker.request(context.Background(), leasePythonRequest(root, "read", "")); err != nil || result["ok"] != true || result["lease"] != nil {
		t.Fatal(result, err)
	}
	for _, name := range []string{root + ".chisa-lease", root + ".chisa-lease.guard"} {
		if _, err := os.Stat(name); !os.IsNotExist(err) {
			t.Fatal("read-only preview created ownership metadata", name, err)
		}
	}
	if result, err := worker.request(context.Background(), leasePythonRequest(root, "claim", "first")); err != nil || result["ok"] != true {
		t.Fatal(result, err)
	}
	before, err := os.ReadFile(filepath.Join(root+".chisa-lease", "state.json"))
	if err != nil {
		t.Fatal(err)
	}
	if result, err := worker.request(context.Background(), leasePythonRequest(root, "release", "foreign")); err != nil || result["ok"] != false {
		t.Fatal("foreign owner was released", result, err)
	}
	after, _ := os.ReadFile(filepath.Join(root+".chisa-lease", "state.json"))
	if !bytes.Equal(before, after) {
		t.Fatal("foreign release changed exact ownership")
	}
	if result, err := worker.request(context.Background(), leasePythonRequest(root, "confirm", "first")); err != nil || result["ok"] != true {
		t.Fatal(result, err)
	}
	if result, err := worker.request(context.Background(), leasePythonRequest(root, "release", "first")); err != nil || result["ok"] != true {
		t.Fatal(result, err)
	}
	if result, err := worker.request(context.Background(), leasePythonRequest(root, "read", "")); err != nil || result["lease"] != nil {
		t.Fatal(result, err)
	}
}

func TestSyncRemoteLeasePythonRejectsChangedRootAndEpoch(t *testing.T) {
	for _, scenario := range []string{"request-root", "request-epoch", "root-inode"} {
		t.Run(scenario, func(t *testing.T) {
			root := filepath.Join(t.TempDir(), "project")
			if err := os.Mkdir(root, 0700); err != nil {
				t.Fatal(err)
			}
			worker := newPythonSyncRemoteLease(t, root)
			if _, err := worker.request(context.Background(), leasePythonRequest(root, "read", "")); err != nil {
				t.Fatal(err)
			}
			request := leasePythonRequest(root, "claim", "new")
			switch scenario {
			case "request-root":
				request["root"] = root + "-foreign"
			case "request-epoch":
				request["epoch"] = "foreign"
			case "root-inode":
				if err := os.Rename(root, root+"-old"); err != nil {
					t.Fatal(err)
				}
				if err := os.Mkdir(root, 0700); err != nil {
					t.Fatal(err)
				}
			}
			if _, err := worker.request(context.Background(), request); err == nil {
				t.Fatal("changed binding was accepted")
			}
			if _, err := os.Stat(root + ".chisa-lease"); !os.IsNotExist(err) {
				t.Fatal("invalid request acquired lease", err)
			}
		})
	}
}

func TestSyncRemoteLeasePythonLockDeadlineNeverRunsLate(t *testing.T) {
	tools := syncSeedTools(t)
	root := filepath.Join(t.TempDir(), "project")
	if err := os.Mkdir(root, 0700); err != nil {
		t.Fatal(err)
	}
	// A real separate process holds the same persistent lock inode.
	lock := exec.Command(tools.python, "-u", "-c", `import os,sys,time
f=open(sys.argv[1],'a+b')
try:
 import fcntl
 fcntl.flock(f,fcntl.LOCK_EX)
except ImportError:
 import msvcrt
 msvcrt.locking(f.fileno(),msvcrt.LK_LOCK,1)
print('locked',flush=True)
time.sleep(1.5)`, root+".chisa-lease.guard")
	out, err := lock.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := lock.Start(); err != nil {
		t.Fatal(err)
	}
	if line, _ := bufio.NewReader(out).ReadString('\n'); strings.TrimSpace(line) != "locked" {
		t.Fatal("external lease lock was not held")
	}
	worker := newPythonSyncRemoteLease(t, root)
	ctx, cancel := context.WithTimeout(context.Background(), 800*time.Millisecond)
	defer cancel()
	started := time.Now()
	result, requestErr := worker.request(ctx, leasePythonRequest(root, "claim", "expired"))
	if requestErr == nil && result["ok"] != false {
		t.Fatal("lock wait unexpectedly acquired lease", result)
	}
	if time.Since(started) > time.Second {
		t.Fatal("lease deadline was not bounded")
	}
	if err := lock.Wait(); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(root + ".chisa-lease"); !os.IsNotExist(err) {
		t.Fatal("expired request executed after external lock released", err)
	}
}

// Opt-in WAN check for the production persistent constructor/protocol. It owns
// only one new lease-only directory under the explicit task manifest root; it
// does not create a Store, connect an app GUI, or start Mutagen.
func TestSyncRemoteLeasePoolRetiresReboundAuthority(t *testing.T) {
	worker := newTestSyncRemoteLease(t, "echo", "")
	oldConnection, replacement := &serverConnection{}, &serverConnection{}
	oldKey := syncRemoteLeaseKey{connection: oldConnection, root: "/owned/project", epoch: "old", keyPath: "old-key"}
	syncRemoteLeasePool.Lock()
	previous := syncRemoteLeasePool.workers
	syncRemoteLeasePool.workers = map[syncRemoteLeaseKey]*syncRemoteLease{oldKey: worker}
	syncRemoteLeasePool.Unlock()
	t.Cleanup(func() {
		syncRemoteLeasePool.Lock()
		syncRemoteLeasePool.workers = previous
		syncRemoteLeasePool.Unlock()
	})
	current := newTestSyncRemoteLease(t, "echo", "")
	key := syncRemoteLeaseKey{connection: replacement, root: "/owned/project", epoch: "new", keyPath: "new-key"}
	syncRemoteLeasePool.Lock()
	syncRemoteLeasePool.workers[key] = current
	syncRemoteLeasePool.Unlock()
	found, err := remoteSyncLeaseFor(key, context.Background())
	if err != nil || found != current || !worker.closed.Load() {
		t.Fatal("rebound authority retained its old lease process", err)
	}
	select {
	case <-worker.done:
	case <-time.After(5 * time.Second):
		t.Fatal("retired lease authority remained alive")
	}
}

func TestVPSPersistentLeaseRPC(t *testing.T) {
	if os.Getenv("CHISA_QA_LEASE_VPS") != "1" {
		t.Skip("explicit lease-only VPS opt-in required")
	}
	filename := os.Getenv("CHISA_QA_E2E_MANIFEST")
	if !filepath.IsAbs(filename) {
		t.Fatal("explicit task manifest required")
	}
	raw, err := os.ReadFile(filename)
	if err != nil {
		t.Fatal(err)
	}
	var manifest struct {
		Version        int    `json:"version"`
		RunID          string `json:"runId"`
		AllowRoot      string `json:"allowRoot"`
		SSHHost        string `json:"sshHost"`
		SSHUser        string `json:"sshUser"`
		SSHPort        int    `json:"sshPort"`
		KeyPath        string `json:"keyPath"`
		KnownHostsPath string `json:"knownHostsPath"`
	}
	if err := json.Unmarshal(raw, &manifest); err != nil {
		t.Fatal(err)
	}
	if manifest.Version != 1 || !regexp.MustCompile(`^[a-f0-9]{32}$`).MatchString(manifest.RunID) || manifest.AllowRoot != "/opt/chisacloudcode/workspaces/.qa-sync-e2e-"+manifest.RunID {
		t.Fatal("lease-only manifest root is not exact")
	}
	if !filepath.IsAbs(manifest.KeyPath) || !filepath.IsAbs(manifest.KnownHostsPath) || manifest.SSHPort < 1 || manifest.SSHPort > 65535 {
		t.Fatal("explicit lease-only transport required")
	}
	private := t.TempDir()
	known := filepath.Join(private, "ssh", "known_hosts")
	if err := os.MkdirAll(filepath.Dir(known), 0700); err != nil {
		t.Fatal(err)
	}
	knownBytes, err := os.ReadFile(manifest.KnownHostsPath)
	if err != nil {
		t.Fatal("pinned host-key reference unavailable")
	}
	if err := os.WriteFile(known, knownBytes, 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(filepath.Dir(known), "ssh_config"), nil, 0600); err != nil {
		t.Fatal(err)
	}
	transport := newTunnel(Config{SSHHost: manifest.SSHHost, SSHUser: manifest.SSHUser, SSHPort: manifest.SSHPort, SSHKnownHostsPath: known, SSHHostKeyPinned: true}, manifest.KeyPath, func() {})
	root := manifest.AllowRoot + "/workspaces/lease-only-project"
	epoch := randHex(16)
	setup := `import os,pathlib,sys
root=pathlib.Path(sys.argv[1]);assert root.resolve()==root and (root/'.native-qa-owner').read_text()==sys.argv[2]+'\n'
project=root/'workspaces/lease-only-project';assert project.parent.resolve()==project.parent and not project.exists() and not project.is_symlink()
project.mkdir(mode=0o755);print('owned-lease-only-project-ready')`
	ctx, cancel := context.WithTimeout(context.Background(), 40*time.Second)
	defer cancel()
	if out, err := transport.ExecRemoteContext(ctx, "python3 -c "+shellQuote(setup)+" "+shellQuote(manifest.AllowRoot)+" "+shellQuote(manifest.RunID)); err != nil || out != "owned-lease-only-project-ready" {
		t.Fatal("task-only project setup", out, err)
	}
	nonce := randHex(24)
	command, err := syncRemoteLeaseCommand(root, epoch, nonce)
	if err != nil {
		t.Fatal(err)
	}
	worker, err := newSyncRemoteLease(context.Background(), nonce, func(ctx context.Context) *exec.Cmd {
		return hideCommandWindow(exec.CommandContext(ctx, sshExe(), append(transport.baseArgs(), command)...))
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		worker.close()
		select {
		case <-worker.done:
		case <-time.After(5 * time.Second):
			t.Error("owned WAN lease worker did not exit")
		}
	})
	request := func(op, id string) map[string]any {
		return map[string]any{"root": root, "epoch": epoch, "op": op, "owner": "sync", "id": id}
	}
	call := func(op, id string) time.Duration {
		t.Helper()
		started := time.Now()
		result, err := worker.request(context.Background(), request(op, id))
		if err != nil || result["ok"] != true {
			t.Fatal("actual persistent lease operation", op, result, err)
		}
		return time.Since(started)
	}
	cold := call("read", "")
	var warm []time.Duration
	for i := 0; i < 12; i++ {
		warm = append(warm, call("read", ""))
	}
	call("claim", "lease-only-owned")
	call("confirm", "lease-only-owned")
	call("release", "lease-only-owned")
	if result, err := worker.request(context.Background(), request("read", "")); err != nil || result["lease"] != nil {
		t.Fatal("lease-only exact release", result, err)
	}
	// Compare the old one-shot transport under identical SSH/config/root inputs.
	var fresh []time.Duration
	for i := 0; i < 3; i++ {
		encoded, _ := json.Marshal(request("read", ""))
		started := time.Now()
		cmd := hideCommandWindow(exec.Command(sshExe(), append(transport.baseArgs(), "python3 -B -c "+shellQuote(leaseWorker))...))
		cmd.Stdin = bytes.NewReader(encoded)
		out, err := cmd.Output()
		if err != nil {
			t.Fatal(err)
		}
		var result map[string]any
		if json.Unmarshal(out, &result) != nil || result["ok"] != true {
			t.Fatal("one-shot comparison failed")
		}
		fresh = append(fresh, time.Since(started))
	}
	// Keep the worker warm, hold the real remote flock longer than its request
	// deadline, and prove a later unlock cannot execute the expired claim.
	holdSource := `import fcntl,pathlib,time,sys
p=pathlib.Path(sys.argv[1]);f=open(str(p)+'.chisa-lease.guard','a+b');fcntl.flock(f,fcntl.LOCK_EX)
(p/'lease-lock-held').write_text('held');print('locked',flush=True);time.sleep(3)`
	holder := hideCommandWindow(exec.Command(sshExe(), append(transport.baseArgs(), "python3 -B -u -c "+shellQuote(holdSource)+" "+shellQuote(root))...))
	holderOut, err := holder.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := holder.Start(); err != nil {
		t.Fatal(err)
	}
	if line, _ := bufio.NewReader(holderOut).ReadString('\n'); strings.TrimSpace(line) != "locked" {
		t.Fatal("actual remote lease lock was not acquired")
	}
	lockCtx, stopLock := context.WithTimeout(context.Background(), 1500*time.Millisecond)
	started := time.Now()
	result, requestErr := worker.request(lockCtx, request("claim", "must-not-run-late"))
	stopLock()
	elapsed := time.Since(started)
	if requestErr == nil && result["ok"] != false {
		t.Fatal("external remote lock bypassed", result)
	}
	if elapsed > 2*time.Second {
		t.Fatal("actual remote lock deadline exceeded", elapsed)
	}
	if err := holder.Wait(); err != nil {
		t.Fatal(err)
	}
	verify := `import pathlib,sys
p=pathlib.Path(sys.argv[1]);assert p.resolve()==p and not pathlib.Path(str(p)+'.chisa-lease').exists()
print('no-late-lease-mutation')`
	if out, err := transport.ExecRemoteContext(ctx, "python3 -c "+shellQuote(verify)+" "+shellQuote(root)); err != nil || out != "no-late-lease-mutation" {
		t.Fatal("actual delayed mutation verification", out, err)
	}
	sort.Slice(warm, func(i, j int) bool { return warm[i] < warm[j] })
	sort.Slice(fresh, func(i, j int) bool { return fresh[i] < fresh[j] })
	t.Logf("PASS actual lease-only WAN cold=%s warm_p50=%s warm_p95=%s old_fresh_p50=%s lock_deadline=%s no_late_mutation=true task=%s", cold, warm[len(warm)/2], warm[len(warm)-1], fresh[len(fresh)/2], elapsed, manifest.RunID)
}
