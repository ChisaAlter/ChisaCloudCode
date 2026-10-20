//go:build windows && vpsqa

package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// Only copies of this test executable inside the disposable fixture enter this
// branch. They record arguments (never the environment) and run the real tools.
func init() {
	if os.Getenv("CHISA_VPS_QA_TOOL_PROXY") != "1" {
		return
	}
	// exec.Command("git", ...) supplies argv[0] without .exe on Windows.
	// Identify the copied image itself instead of depending on that spelling.
	executable, err := os.Executable()
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(93)
	}
	name := strings.ToLower(filepath.Base(executable))
	tool, target := "", ""
	switch name {
	case "git.exe":
		tool, target = "git", os.Getenv("CHISA_VPS_QA_REAL_GIT")
	case "mutagen.exe":
		tool, target = "mutagen", os.Getenv("CHISA_VPS_QA_REAL_MUTAGEN")
	default:
		return
	}
	fail := func(err error) {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(93)
	}
	if !filepath.IsAbs(target) || strings.EqualFold(filepath.Clean(os.Args[0]), target) {
		fail(fmt.Errorf("invalid private QA proxy target"))
	}
	encoded, err := json.Marshal(vpsQAToolCommand{Tool: tool, Args: os.Args[1:]})
	if err != nil {
		fail(err)
	}
	log, err := os.OpenFile(os.Getenv("CHISA_VPS_QA_TOOL_LOG"), os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0600)
	if err != nil {
		fail(err)
	}
	_, err = log.Write(append(encoded, '\n'))
	if closeErr := log.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		fail(err)
	}
	command := exec.Command(target, os.Args[1:]...)
	command.Stdin, command.Stdout, command.Stderr = os.Stdin, os.Stdout, os.Stderr
	if err := command.Run(); err != nil {
		if exit, ok := err.(*exec.ExitError); ok {
			os.Exit(exit.ExitCode())
		}
		fail(err)
	}
	os.Exit(0)
}

type vpsQAToolCommand struct {
	Tool string   `json:"tool"`
	Args []string `json:"args"`
}

func TestVPSQARealToolProxy(t *testing.T) {
	realGit, err := exec.LookPath("git")
	if err != nil {
		t.Fatal(err)
	}
	realGit, err = filepath.Abs(realGit)
	if err != nil {
		t.Fatal(err)
	}
	self, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	private := t.TempDir()
	copyVPSQAResource(t, self, filepath.Join(private, "git.exe"))
	log := filepath.Join(private, "commands.jsonl")
	t.Setenv("CHISA_VPS_QA_TOOL_PROXY", "1")
	t.Setenv("CHISA_VPS_QA_REAL_GIT", realGit)
	t.Setenv("CHISA_VPS_QA_TOOL_LOG", log)
	t.Setenv("PATH", private+string(os.PathListSeparator)+os.Getenv("PATH"))
	out, err := exec.Command("git", "--version").CombinedOutput()
	if err != nil || !strings.HasPrefix(string(out), "git version ") {
		t.Fatalf("real bare-name proxy failed: %s: %v", out, err)
	}
	commands := readVPSQAToolCommands(t, log)
	if len(commands) != 1 || commands[0].Tool != "git" || !reflect.DeepEqual(commands[0].Args, []string{"--version"}) {
		t.Fatalf("proxy failed to record exact real command: %+v", commands)
	}
}

// Uses the installed transport and real Linux Git/Mutagen, only in a unique QA
// project. Credentials are referenced through the existing SSH identity file.
func TestGitSyncBranchesVPSActual(t *testing.T) {
	if os.Getenv("CHISA_QA_VPS") != "1" {
		t.Fatal("explicit VPS QA opt-in required")
	}
	host, key, known, root := os.Getenv("CHISA_QA_SSH_HOST"), os.Getenv("CHISA_QA_SSH_KEY"), os.Getenv("CHISA_QA_SSH_KNOWN"), strings.TrimRight(os.Getenv("CHISA_QA_WORKSPACE_ROOT"), "/")
	if host == "" || !filepath.IsAbs(key) || !filepath.IsAbs(known) || !strings.HasPrefix(root, "/opt/") || strings.Contains(root, "/../") {
		t.Fatal("explicit existing SSH transport and workspace root required")
	}
	port, err := strconv.Atoi(os.Getenv("CHISA_QA_SSH_PORT"))
	if err != nil || port < 1 || port > 65535 {
		t.Fatal("explicit SSH port required")
	}
	for _, path := range []string{key, known} {
		if info, err := os.Stat(path); err != nil || !info.Mode().IsRegular() {
			t.Fatalf("required existing SSH file unavailable: %s: %v", path, err)
		}
	}

	// Resolve resources before changing cwd, then use only this isolated copy.
	installed := filepath.Join(os.Getenv("LOCALAPPDATA"), "Programs", "ChisaCloudCode")
	binary := filepath.Join(installed, "mutagen.exe")
	if _, err := os.Stat(binary); err != nil {
		binary = mutagenExe()
	}
	if binary == "" {
		t.Fatal("installed Mutagen required")
	}
	binary, err = filepath.Abs(binary)
	if err != nil {
		t.Fatal(err)
	}
	sshSource := filepath.Join(installed, "sync-ssh")
	if _, err := os.Stat(filepath.Join(sshSource, "ssh.exe")); err != nil {
		sshSource, err = mutagenSSHPath()
		if err != nil {
			t.Fatal(err)
		}
	}
	private := t.TempDir()
	for _, item := range [][2]string{
		{binary, filepath.Join(private, "resources", "mutagen.exe")},
		{filepath.Join(filepath.Dir(binary), "mutagen-agents.tar.gz"), filepath.Join(private, "resources", "mutagen-agents.tar.gz")},
		{filepath.Join(sshSource, "ssh.exe"), filepath.Join(private, "resources", "windows-amd64", "sync-ssh", "ssh.exe")},
		{filepath.Join(sshSource, "scp.exe"), filepath.Join(private, "resources", "windows-amd64", "sync-ssh", "scp.exe")},
	} {
		copyVPSQAResource(t, item[0], item[1])
	}
	profile := t.TempDir()
	t.Setenv("APPDATA", profile)
	// Keep the override equal to the default profile path so older installed SSH
	// wrappers, which predate CHISA_DATA_DIR support, use the same private config.
	t.Setenv("CHISA_DATA_DIR", filepath.Join(profile, "ChisaCloudCode"))
	t.Setenv("MUTAGEN_DATA_DIRECTORY", filepath.Join(dataDir(), "mutagen"))
	t.Setenv("MUTAGEN_DISABLE_AUTOSTART", "")
	// User/system Git settings must not alter the deterministic ignore fixture.
	// Both overrides are process-local and leave the installed files untouched.
	gitGlobal := filepath.Join(private, "qa-gitconfig")
	if err := os.WriteFile(gitGlobal, nil, 0600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("GIT_CONFIG_GLOBAL", gitGlobal)
	t.Setenv("GIT_CONFIG_NOSYSTEM", "1")
	t.Chdir(private)
	resolved, err := filepath.Abs(mutagenExe())
	if err != nil || resolved != filepath.Join(private, "resources", "mutagen.exe") {
		t.Fatalf("QA must use the copied Mutagen: %s: %v", resolved, err)
	}
	resolvedSSH, err := mutagenSSHPath()
	if err != nil || resolvedSSH != filepath.Join(private, "resources", "windows-amd64", "sync-ssh") {
		t.Fatalf("QA must use the copied SSH wrappers: %s: %v", resolvedSSH, err)
	}

	oldStore, oldTunnel, oldConnection := store, tunnel, apiConnection
	epoch := randHex(16)
	local := t.TempDir()
	remote := root + "/local/git-sync-qa-" + epoch
	var recoveryChecks atomic.Int64
	// Only the account's confirmation boundary is private HTTP. File transport,
	// lease recovery and both exact lease comparisons still run on the real VPS.
	account := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/api/workspace-sync/lease-recovery" || r.Header.Get("Authorization") != "Bearer disposable-qa-token" {
			t.Errorf("unexpected private account request: %s %s", r.Method, r.URL.Path)
			http.Error(w, "unexpected request", http.StatusBadRequest)
			return
		}
		var request map[string]string
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil || len(request) != 2 || request["serverPath"] != remote || request["bindingEpoch"] != epoch {
			t.Errorf("private account recovery lost exact binding: %+v: %v", request, err)
			http.Error(w, "invalid binding", http.StatusBadRequest)
			return
		}
		recoveryChecks.Add(1)
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, `{"ok":true,"lease":null}`)
	}))
	t.Cleanup(account.Close)
	cfg := Config{SSHHost: host, SSHUser: "root", SSHPort: port, KeyPath: key, SSHKnownHostsPath: known, SSHHostKeyPinned: true,
		ServerURL: account.URL, LoginURL: account.URL, WorkspaceServerURL: account.URL,
		WorkspaceLoginURL: account.URL, WorkspaceAccount: "disposable-qa-" + epoch, WorkspaceRoot: root}
	m := &Mapping{LocalPath: local, ServerPath: remote, BindingEpoch: epoch, ServerID: serverIdentity(cfg), Mode: "vps"}
	connection, err := newServerConnection(cfg.WorkspaceLoginURL, cfg.ServerURL)
	if err != nil {
		t.Fatal(err)
	}
	connection.authenticated, connection.accountIdentity, connection.accessToken = true, cfg.WorkspaceAccount, "disposable-qa-token"
	qaTunnel := newTunnel(cfg, key, func() {})
	// SSH commands use the real transport. The bridge readiness proof belongs to
	// this private authenticated connection; account confirmation uses HTTP above.
	qaTunnel.proc, qaTunnel.bridgeReady, qaTunnel.bridgePort = &exec.Cmd{}, true, 1
	serverConnectionMu.Lock()
	store = &Store{path: filepath.Join(dataDir(), "state.json"), Cfg: cfg, Mappings: []*Mapping{m}}
	tunnel, apiConnection = qaTunnel, connection
	serverConnectionMu.Unlock()
	created := false
	t.Cleanup(func() {
		defer func() {
			connection.cancel()
			connection.client.CloseIdleConnections()
			qaTunnel.stop()
			serverConnectionMu.Lock()
			store, tunnel, apiConnection = oldStore, oldTunnel, oldConnection
			serverConnectionMu.Unlock()
		}()
		stopSyncMonitor(false)
		forgetSyncIgnoreObservation(m)
		syncRemoteObservationPool.Lock()
		for key, observer := range syncRemoteObservationPool.observers {
			if key.transport == qaTunnel {
				delete(syncRemoteObservationPool.observers, key)
				observer.close()
			}
		}
		syncRemoteObservationPool.Unlock()
		syncGitObservations.Range(func(key, _ any) bool {
			if key.(syncGitCacheKey).transport == qaTunnel {
				syncGitObservations.Delete(key)
			}
			return true
		})
		if m.SyncName != "" {
			if _, err := runMutagenTimeout(30*time.Second, "sync", "terminate", m.SyncName); err != nil {
				t.Error(err)
			}
		}
		if _, err := runMutagenTimeout(15*time.Second, "daemon", "stop"); err != nil {
			t.Error(err)
		}
		if created {
			if remote != root+"/local/git-sync-qa-"+epoch {
				t.Error("invalid cleanup target")
				return
			}
			if _, err := qaTunnel.ExecRemote("test \"$(readlink -f -- " + shellQuote(remote) + ")\" = " + shellQuote(remote) + " && rm -rf -- " + shellQuote(remote) + " " + shellQuote(remote+".chisa-lease") + " " + shellQuote(remote+".chisa-lease.guard")); err != nil {
				t.Error(err)
			}
		}
	})
	parent, cancel := context.WithTimeout(context.Background(), 18*time.Minute)
	defer cancel()
	ctx, unbind, err := bindWorkspaceSyncConnection(parent)
	if err != nil {
		t.Fatal(err)
	}
	defer unbind()
	ctx = syncLeaseContext(ctx, epoch)
	command := func(s string) string {
		t.Helper()
		out, err := qaTunnel.ExecRemoteContext(ctx, s)
		if err != nil {
			t.Fatal(err)
		}
		return out
	}
	git := func(args ...string) string {
		t.Helper()
		out, err := gitOutputContext(ctx, local, args...)
		if err != nil {
			t.Fatal(err)
		}
		return out
	}
	command("test ! -e " + shellQuote(remote) + " && mkdir " + shellQuote(remote) + " && chown 1000:1000 " + shellQuote(remote))
	created = true
	if _, err := remoteLeaseContext(ctx, m, "claim", "sync", epoch); err != nil {
		t.Fatal(err)
	}
	t.Logf("isolated authenticated fixture: profile=%s project=%s; installed transport copied; no production mappings loaded", dataDir(), remote)
	git("init", "-b", "main")
	git("config", "user.name", "QA")
	git("config", "user.email", "qa@localhost")
	git("config", "core.autocrlf", "false")
	write := func(name, body string) {
		t.Helper()
		if err := os.WriteFile(filepath.Join(local, name), []byte(body), 0600); err != nil {
			t.Fatal(err)
		}
	}
	write("file.txt", "base\n")
	write("content.txt", "content base\n")
	git("add", ".")
	git("commit", "-m", "base")
	base := git("rev-parse", "HEAD")
	write("file.txt", "local commit\n")
	git("add", ".")
	git("commit", "-m", "local branch commit")
	main := git("rev-parse", "HEAD")
	write("policy-data.txt", "existing policy fixture\n") // deliberately untracked
	sync := func(phase string) {
		t.Helper()
		started := time.Now()
		if err := syncProjectContentsContext(ctx, m, true); err != nil {
			t.Fatalf("%s: %v", phase, err)
		}
		elapsed := time.Since(started)
		l, err := readLocalGitState(ctx, m)
		if err != nil {
			t.Fatal(err)
		}
		r, err := readRemoteGitState(ctx, m)
		if err != nil || l != r {
			t.Fatalf("%s mismatched Git: local=%+v remote=%+v err=%v", phase, l, r, err)
		}
		t.Logf("%s: elapsed=%s branch=%s HEAD=%s", phase, elapsed, l.Branch, l.Head)
	}
	sync("initial")

	// Prime once after the correctness reader's temporary Git guards, then record
	// five message pairs without full state readers or a worktree inventory.
	if err := syncProjectContentsContext(ctx, m, false); err != nil {
		t.Fatal("warm baseline", err)
	}
	type warmEvidence struct {
		observer  *syncRemoteObserver
		lastUsed  int64
		ignore    *syncIgnoreObservation
		ignoreUse uint64
		pair      string
		cache     syncGitObservationCache
		session   syncSession
	}
	capture := func() warmEvidence {
		t.Helper()
		var evidence warmEvidence
		evidence.pair, err = syncIgnoreEndpointSignatureContext(ctx, m)
		if err != nil || evidence.pair == "" {
			t.Fatalf("paired live ignore token missing: %v", err)
		}
		key := syncGitObservationKey(ctx, m)
		cached, ok := syncGitObservations.Load(key)
		if !ok {
			t.Fatal("authenticated Git cache not populated")
		}
		evidence.cache = cached.(syncGitObservationCache)
		plan, err := prepareGitSyncContext(ctx, m)
		if err != nil || plan == nil {
			t.Fatalf("warm cached plan failed: %v", err)
		}
		if !plan.git || plan.localFingerprint != evidence.cache.local || plan.remoteFingerprint != evidence.cache.remote || plan.local != evidence.cache.state || plan.remote != evidence.cache.state || plan.desired != evidence.cache.state {
			t.Fatalf("warm plan did not retain completed Git cache: %+v", plan)
		}
		syncRemoteObservationPool.Lock()
		for observerKey, observer := range syncRemoteObservationPool.observers {
			if observerKey.mapping == *m && observerKey.connection == connection && observerKey.transport == qaTunnel {
				evidence.observer, evidence.lastUsed = observer, observer.lastUsed.Load()
			}
		}
		syncRemoteObservationPool.Unlock()
		if evidence.observer == nil || evidence.observer.closed.Load() {
			t.Fatal("persistent authenticated observer missing")
		}
		syncIgnoreObservations.Lock()
		evidence.ignore = syncIgnoreObservations.entries[syncIgnoreObservationKey(m)]
		if evidence.ignore != nil {
			evidence.ignoreUse = evidence.ignore.used
		}
		syncIgnoreObservations.Unlock()
		if evidence.ignore == nil {
			t.Fatal("local native ignore watcher missing")
		}
		evidence.ignore.mu.Lock()
		watching := !evidence.ignore.closed && evidence.ignore.watchFailure == nil && len(evidence.ignore.watchers) > 0 && evidence.ignore.signature != ""
		evidence.ignore.mu.Unlock()
		if !watching {
			t.Fatal("local ignore cache has no healthy watcher proof")
		}
		sessions, err := syncSessionsContext(ctx, m.SyncName)
		if err != nil || len(sessions) != 1 {
			t.Fatalf("warm session unavailable: %v: %+v", err, sessions)
		}
		evidence.session = sessions[0]
		if evidence.session.Paused || !evidence.session.Alpha.Connected || !evidence.session.Beta.Connected || evidence.session.SuccessfulCycles == 0 {
			t.Fatalf("warm session lost active endpoints: %+v", evidence.session)
		}
		return evidence
	}
	baseline := capture()
	stamps := map[string]vpsQAFileState{}
	for _, path := range []string{syncGitCheckpointPath(m), syncIgnoreStampPath(m), filepath.Join(dataDir(), "sync-config", epoch+".yml")} {
		stamps[path] = readVPSQAFileState(t, path)
	}
	var inventories, discoveries, configurations atomic.Int64
	originalInventory := projectSyncIgnoreConfigurationContext
	projectSyncIgnoreConfigurationContext = func(ctx context.Context, mapping *Mapping) (string, error) {
		inventories.Add(1)
		return originalInventory(ctx, mapping)
	}
	t.Cleanup(func() { projectSyncIgnoreConfigurationContext = originalInventory })
	baseline.ignore.mu.Lock()
	originalDiscovery := baseline.ignore.discoverRules
	baseline.ignore.discoverRules = func(root string) (map[string][32]byte, error) {
		discoveries.Add(1)
		return originalDiscovery(root)
	}
	originalConfiguration := baseline.ignore.resolveConfiguration
	baseline.ignore.resolveConfiguration = func() (map[string]bool, error) {
		configurations.Add(1)
		return originalConfiguration()
	}
	baseline.ignore.mu.Unlock()
	previous := baseline
	var prepTotal, handbackTotal time.Duration
	for round := 1; round <= 5; round++ {
		for _, phase := range []struct {
			name    string
			reserve bool
		}{{"preparation", true}, {"handback", false}} {
			started := time.Now()
			if err := syncProjectContentsContext(ctx, m, phase.reserve); err != nil {
				t.Fatalf("warm round %d %s: %v", round, phase.name, err)
			}
			elapsed := time.Since(started)
			if phase.reserve {
				prepTotal += elapsed
			} else {
				handbackTotal += elapsed
			}
			current := capture()
			if current.observer != baseline.observer || current.lastUsed <= previous.lastUsed || current.ignore != baseline.ignore || current.ignoreUse <= previous.ignoreUse || current.pair != baseline.pair || current.cache != baseline.cache {
				t.Fatalf("warm round %d %s replaced or invalidated persistent evidence: observer=%p/%p ignore=%p/%p pair=%v cache=%v", round, phase.name, current.observer, baseline.observer, current.ignore, baseline.ignore, current.pair == baseline.pair, current.cache == baseline.cache)
			}
			if current.session.Identifier != baseline.session.Identifier || current.session.SuccessfulCycles <= previous.session.SuccessfulCycles {
				t.Fatalf("warm session/cycles changed unexpectedly: before=%+v after=%+v", previous.session, current.session)
			}
			for path, before := range stamps {
				if after := readVPSQAFileState(t, path); after != before {
					t.Fatalf("warm round %d %s rewrote %s: before=%+v after=%+v", round, phase.name, filepath.Base(path), before.identity, after.identity)
				}
			}
			if inventories.Load() != 0 || discoveries.Load() != 0 || configurations.Load() != 0 {
				t.Fatalf("warm round rescanned policy: inventories=%d discoveries=%d configurations=%d", inventories.Load(), discoveries.Load(), configurations.Load())
			}
			t.Logf("warm round=%d phase=%s elapsed=%s observer=%p observer-use=%d ignore=%p ignore-use=%d git-local=%.12s git-remote=%.12s pair=%.12s cycles=%d->%d paused=false connected=true/true status=%s stamps-unchanged=true inventory=0 discovery=0 configuration=0", round, phase.name, elapsed, current.observer, current.lastUsed, current.ignore, current.ignoreUse, current.cache.local, current.cache.remote, current.pair, previous.session.SuccessfulCycles, current.session.SuccessfulCycles, current.session.Status)
			previous = current
		}
	}
	t.Logf("five warm message pairs: preparation-total=%s preparation-mean=%s handback-total=%s handback-mean=%s; sampled live state stayed unpaused/connected; command-log unit tests cover transient pause/resume absence", prepTotal, prepTotal/5, handbackTotal, handbackTotal/5)
	// Mutagen may replace a file while delivering new content. These rounds are
	// outside the unchanged measurement and verify that content still flows.
	write("content.txt", "local content upload\n")
	sync("local content upload after warm pairs")
	if command("cat "+shellQuote(remote+"/content.txt")) != "local content upload" {
		t.Fatal("local warm content did not upload")
	}
	command("printf 'remote content handback\\n' > " + shellQuote(remote+"/content.txt"))
	sync("remote content handback after warm pairs")
	if stringMustReadVPSQA(t, filepath.Join(local, "content.txt")) != "remote content handback\n" {
		t.Fatal("remote warm content did not arrive")
	}
	git("add", "content.txt")
	git("commit", "-m", "warm content delivery")
	sync("commit content-delivery fixture before branch tests")
	main = git("rev-parse", "HEAD")

	// Only remote info/exclude changes: no HEAD, index, branch, or worktree edit.
	policyBefore, err := readRemoteGitState(ctx, m)
	if err != nil {
		t.Fatal(err)
	}
	pairBefore, err := syncIgnoreEndpointSignatureContext(ctx, m)
	if err != nil {
		t.Fatal(err)
	}
	command("printf '\\npolicy-data.txt\\n' >> " + shellQuote(remote+"/.git/info/exclude"))
	pairAfter, err := syncIgnoreEndpointSignatureContext(ctx, m)
	if err != nil || pairAfter == pairBefore {
		t.Fatalf("remote-only ignore edit did not invalidate pair token: %v", err)
	}
	policyAfter, err := readRemoteGitState(ctx, m)
	if err != nil || policyAfter != policyBefore {
		t.Fatalf("ignore-only fixture changed portable Git state: %v", err)
	}
	sync("remote ignore-only policy invalidation")
	configuration, err := os.ReadFile(filepath.Join(dataDir(), "sync-config", epoch+".yml"))
	if err != nil || !strings.Contains(string(configuration), `"/policy-data.txt"`) {
		t.Fatalf("remote-only ignore did not reach live policy: %s: %v", configuration, err)
	}
	if stringMustReadVPSQA(t, filepath.Join(local, "policy-data.txt")) != "existing policy fixture\n" || command("cat "+shellQuote(remote+"/policy-data.txt")) != "existing policy fixture" {
		t.Fatal("ignore migration deleted existing endpoint data")
	}
	command("printf 'remote ignored edit\\n' > " + shellQuote(remote+"/policy-data.txt"))
	sync("remote ignored content remains excluded")
	if stringMustReadVPSQA(t, filepath.Join(local, "policy-data.txt")) != "existing policy fixture\n" {
		t.Fatal("remote ignored file leaked through updated policy")
	}

	command("printf 'interrupted owned lock' > " + shellQuote(remote+"/.git/index.chisa-owned") + " && chown 1000:1000 " + shellQuote(remote+"/.git/index.chisa-owned") + " && ln " + shellQuote(remote+"/.git/index.chisa-owned") + " " + shellQuote(remote+"/.git/index.lock"))
	if _, err := readRemoteGitState(ctx, m); err != nil {
		t.Fatal("owned Linux index lock did not recover", err)
	}
	command(serverGit(m, "checkout", "-b", "cloud/feature", base) + " && printf 'cloud commit\\n' > " + shellQuote(remote+"/file.txt") + " && " + serverGit(m, "add", "file.txt") + " && " + serverGit(m, "-c", "user.name=QA", "-c", "user.email=qa@localhost", "commit", "-m", "cloud divergent branch"))
	command("printf 'staged cloud\\n' > " + shellQuote(remote+"/file.txt") + " && " + serverGit(m, "add", "file.txt") + " && printf 'unstaged cloud\\n' > " + shellQuote(remote+"/file.txt") + " && printf 'keep untracked\\n' > " + shellQuote(remote+"/untracked.txt") + " && chown 1000:1000 " + shellQuote(remote+"/untracked.txt"))
	command("mkdir -p " + shellQuote(remote+"/build") + " && printf 'new tracked source\\n' > " + shellQuote(remote+"/build/source.txt") + " && printf 'generated ignored\\n' > " + shellQuote(remote+"/build/generated.txt") + " && chown -R 1000:1000 " + shellQuote(remote+"/build") + " && " + serverGit(m, "add", "build/source.txt"))
	sync("cloud divergent branch and staged/unstaged handback")
	if git("rev-parse", "refs/heads/main") != main {
		t.Fatal("main was overwritten by branch switch")
	}
	if git("show", ":file.txt") != "staged cloud" {
		t.Fatal("staged content lost")
	}
	if stringMustReadVPSQA(t, filepath.Join(local, "build", "source.txt")) != "new tracked source\n" {
		t.Fatal("new branch tracked generated-directory source missing")
	}
	if _, err := os.Stat(filepath.Join(local, "build", "generated.txt")); !os.IsNotExist(err) {
		t.Fatal("generated runtime unexpectedly synchronized", err)
	}
	for name, want := range map[string]string{"file.txt": "unstaged cloud\n", "untracked.txt": "keep untracked\n"} {
		if got := stringMustReadVPSQA(t, filepath.Join(local, name)); got != want {
			t.Fatalf("file %s not delivered: %q", name, got)
		}
	}
	git("checkout", "-b", "local/next")
	write("local-only.txt", "next round\n")
	git("add", "local-only.txt")
	sync("local branch and staged file upload")
	if got := command("cat " + shellQuote(remote+"/local-only.txt")); got != "next round" {
		t.Fatal("local file not uploaded", got)
	}
	git("commit", "-m", "local staged changes")
	sync("local new commit upload")
	command(serverGit(m, "checkout", "--detach", "HEAD"))
	sync("cloud detached HEAD handback")

	// Deliberately stop this disposable engine before constructing concurrent
	// branch + content edits; the failure must retain both exact endpoint states.
	if err := pauseSyncSessionContext(ctx, m, m.SyncName); err != nil {
		t.Fatal(err)
	}
	git("checkout", "-b", "local/concurrent")
	write("file.txt", "local conflict\n")
	command(serverGit(m, "checkout", "-b", "remote/concurrent") + " && printf 'remote conflict\\n' > " + shellQuote(remote+"/file.txt"))
	localConflict, err := readLocalGitState(ctx, m)
	if err != nil {
		t.Fatal(err)
	}
	remoteConflict, err := readRemoteGitState(ctx, m)
	if err != nil {
		t.Fatal(err)
	}
	checkpoint := readVPSQAFileState(t, syncGitCheckpointPath(m))
	if err := syncProjectContentsContext(ctx, m, true); err == nil || !strings.Contains(err.Error(), "两端") {
		t.Fatal("concurrent changes not protected", err)
	}
	localAfter, localErr := readLocalGitState(ctx, m)
	remoteAfter, remoteErr := readRemoteGitState(ctx, m)
	if localErr != nil || remoteErr != nil || localAfter != localConflict || remoteAfter != remoteConflict {
		t.Fatalf("conflict changed Git state: local=%+v remote=%+v errors=%v/%v", localAfter, remoteAfter, localErr, remoteErr)
	}
	if stringMustReadVPSQA(t, filepath.Join(local, "file.txt")) != "local conflict\n" || command("cat "+shellQuote(remote+"/file.txt")) != "remote conflict" {
		t.Fatal("conflict overwrote endpoint content")
	}
	if readVPSQAFileState(t, syncGitCheckpointPath(m)) != checkpoint {
		t.Fatal("failed conflict advanced the durable Git checkpoint")
	}
	t.Log("real two-sided conflict retained both branches, staged states, file contents, and checkpoint")

	// Reuse only this paused, disposable fixture for initial direction recovery.
	// Keep the same commit on two different branches, a clean receiving index,
	// and nonconflicting worktree edits that must survive selecting remote Git.
	// Restore the last flushed worktree value, not HEAD's staged blob: the
	// engine archive still contains "unstaged cloud" from the preceding case.
	write("file.txt", "unstaged cloud\n")
	command("printf 'unstaged cloud\\n' > " + shellQuote(remote+"/file.txt"))
	git("checkout", "-b", "local/recovery")
	command(serverGit(m, "checkout", "-b", "remote/recovery"))
	write("file.txt", "recovery local unstaged\n")
	command("printf 'recovery remote unstaged\\n' > " + shellQuote(remote+"/content.txt") +
		" && printf 'recovery staged cloud\\n' > " + shellQuote(remote+"/local-only.txt") +
		" && " + serverGit(m, "add", "local-only.txt") +
		" && printf 'recovery unstaged staged-file\\n' > " + shellQuote(remote+"/local-only.txt") +
		" && printf '%s\\n' " + shellQuote(base) + " > " + shellQuote(remote+"/.git/CHERRY_PICK_HEAD") +
		" && printf 'QA interrupted cherry-pick\\n' > " + shellQuote(remote+"/.git/MERGE_MSG") +
		" && chown 1000:1000 " + shellQuote(remote+"/.git/CHERRY_PICK_HEAD") + " " + shellQuote(remote+"/.git/MERGE_MSG"))
	localRecovery, err := readLocalGitState(ctx, m)
	if err != nil {
		t.Fatal(err)
	}
	remoteRecovery, err := readRemoteGitState(ctx, m)
	if err != nil {
		t.Fatal(err)
	}
	if localRecovery.Head != remoteRecovery.Head || localRecovery.Branch == remoteRecovery.Branch || localRecovery.Index != git("rev-parse", "HEAD^{tree}") || remoteRecovery.Index == localRecovery.Index {
		t.Fatalf("invalid initial direction fixture: local=%+v remote=%+v", localRecovery, remoteRecovery)
	}
	operations, err := decodeGitOperations(remoteRecovery.Operations)
	if err != nil || operations["CHERRY_PICK_HEAD"].content != base+"\n" {
		t.Fatalf("remote cherry-pick fixture missing: %+v: %v", operations, err)
	}
	// Validate the exact absolute private checkpoint before deleting just it.
	recoveryCheckpoint, err := filepath.Abs(syncGitCheckpointPath(m))
	if err != nil {
		t.Fatal(err)
	}
	privateCheckpoints, err := filepath.Abs(filepath.Join(profile, "ChisaCloudCode", "sync-git"))
	if err != nil || filepath.Dir(recoveryCheckpoint) != privateCheckpoints || m.LocalPath != local || m.ServerPath != root+"/local/git-sync-qa-"+epoch || m.BindingEpoch != epoch {
		t.Fatalf("invalid disposable checkpoint target: %s: %v", recoveryCheckpoint, err)
	}
	if err := os.Remove(recoveryCheckpoint); err != nil {
		t.Fatal(err)
	}
	syncGitObservations.Range(func(key, _ any) bool {
		if key.(syncGitCacheKey).mapping == *m {
			syncGitObservations.Delete(key)
		}
		return true
	})
	if checkpoint, err := loadGitCheckpoint(m); err != nil || !syncGitRecoveryInitial(checkpoint) {
		t.Fatalf("fixture still has a Git baseline: %+v: %v", checkpoint, err)
	}
	if _, err := remoteLeaseContext(ctx, m, "release", "sync", epoch); err != nil {
		t.Fatal(err)
	}

	localSnapshot := readVPSQARepositorySnapshot(t, local)
	remoteSnapshot := remoteVPSQARepositorySnapshot(command, remote)
	preview := (FrontendBridge{}).GetProjectGitRecovery(remote, epoch)
	if after := readVPSQARepositorySnapshot(t, local); !reflect.DeepEqual(after, localSnapshot) {
		t.Fatalf("public recovery preview changed local repository files/metadata/objects: %s; response=%+v", describeVPSQASnapshotChanges(localSnapshot, after), preview)
	}
	if after := remoteVPSQARepositorySnapshot(command, remote); after != remoteSnapshot {
		t.Fatal("public recovery preview changed remote repository files/metadata/objects")
	}
	if _, err := os.Lstat(recoveryCheckpoint); !os.IsNotExist(err) {
		t.Fatalf("public preview created a durable baseline: %v", err)
	}
	view, ok := preview["recovery"].(syncGitRecoveryView)
	if preview["ok"] != true || !ok || view.Token == "" || view.LocalAllowed || view.LocalReason == "" || !view.RemoteAllowed || view.RemoteReason != "" {
		t.Fatalf("public recovery directions incorrect: %+v", preview)
	}
	if view.Local.Branch != "local/recovery" || view.Remote.Branch != "remote/recovery" || view.Local.Head != localRecovery.Head || view.Remote.Head != remoteRecovery.Head || view.Local.Staged || !view.Remote.Staged || !strings.Contains(view.Remote.Operation, "CHERRY_PICK_HEAD") {
		t.Fatalf("public recovery summary lost branch/staging/operation: %+v", view)
	}
	t.Log("public initial recovery preview: local denied, remote allowed; both complete repository snapshots including objects unchanged")

	result := (FrontendBridge{}).RecoverProjectGit(remote, epoch, view.Token, "remote")
	if result["ok"] != true {
		t.Fatalf("public remote recovery failed: %+v", result)
	}
	if checks := recoveryChecks.Load(); checks != 1 {
		t.Fatalf("public recovery did not confirm the exact account binding once: %d", checks)
	}
	localRecovered, localErr := readLocalGitState(ctx, m)
	// Recovery has released its exact random lease; verify remote metadata
	// through the read-only preview route, never the old fixture lease.
	remoteRecovered, remoteErr := readRemoteGitState(context.WithValue(ctx, syncGitPreviewKey{}, true), m)
	if localErr != nil || remoteErr != nil || localRecovered != remoteRecovery || remoteRecovered != remoteRecovery {
		t.Fatalf("public recovery lost chosen branch/HEAD/index/operation: want=%+v local=%+v remote=%+v errors=%v/%v", remoteRecovery, localRecovered, remoteRecovered, localErr, remoteErr)
	}
	if git("show", ":local-only.txt") != "recovery staged cloud" || command(serverGit(m, "show", ":local-only.txt")) != "recovery staged cloud" {
		t.Fatal("public recovery lost staged blob")
	}
	for name, want := range map[string]string{"file.txt": "recovery local unstaged\n", "content.txt": "recovery remote unstaged\n", "local-only.txt": "recovery unstaged staged-file\n"} {
		if got := stringMustReadVPSQA(t, filepath.Join(local, name)); got != want {
			t.Fatalf("public recovery lost local worktree %s: %q", name, got)
		}
		if got := command("cat " + shellQuote(remote+"/"+name)); got != strings.TrimSuffix(want, "\n") {
			t.Fatalf("public recovery lost remote worktree %s: %q", name, got)
		}
	}
	completed, err := loadGitCheckpoint(m)
	if err != nil || completed.Version != 2 || completed.Pending != nil || completed.State != remoteRecovery {
		t.Fatalf("public recovery did not durably finish chosen state: %+v: %v", completed, err)
	}
	if lease, err := remoteLeaseContext(ctx, m, "read", "", ""); err != nil || lease["lease"] != nil {
		t.Fatalf("public recovery did not release its own lease: %+v: %v", lease, err)
	}
	if record, err := loadSyncRelease(m); err != nil || record != nil {
		t.Fatalf("public recovery left a durable release journal: %+v: %v", record, err)
	}
	if sessions, err := syncSessionsContext(ctx, m.SyncName); err != nil || len(sessions) != 1 || sessions[0].Paused || syncSessionInfo(sessions[0]).Status != "ready" || sessions[0].Status != "watching" {
		t.Fatalf("public recovery did not restore watching: %+v: %v", sessions, err)
	}
	t.Logf("public remote recovery complete: branch=%s HEAD=%s staged=true cherry-pick retained; both unstaged edits delivered; durable Pending=nil; watching=true own-lease-released=true", remoteRecovery.Branch, remoteRecovery.Head)

	// The public operation released its random lease. Claim the private fixture
	// lease again before direct task preparation/handback measurements.
	if _, err := remoteLeaseContext(ctx, m, "claim", "sync", epoch); err != nil {
		t.Fatal(err)
	}
	// Instrument only subsequent calls, forwarding every invocation to the real
	// executable. Existing preview/snapshot commands cannot enter this window.
	realGit, err := exec.LookPath("git")
	if err != nil {
		t.Fatal(err)
	}
	realGit, err = filepath.Abs(realGit)
	if err != nil {
		t.Fatal(err)
	}
	self, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	realMutagen := resolved
	proxyDirectory := filepath.Join(private, "tool-proxies")
	copyVPSQAResource(t, self, filepath.Join(proxyDirectory, "git.exe"))
	instrumented := filepath.Join(private, "instrumented")
	proxyMutagen := filepath.Join(instrumented, "resources", "mutagen.exe")
	copyVPSQAResource(t, self, proxyMutagen)
	for _, name := range []string{"ssh.exe", "scp.exe"} {
		copyVPSQAResource(t, filepath.Join(resolvedSSH, name), filepath.Join(instrumented, "resources", "windows-amd64", "sync-ssh", name))
	}
	// Resolve the proxy from another private cwd; keep the existing real monitor
	// and daemon running from their original binaries on Windows.
	t.Chdir(instrumented)
	if actual, err := filepath.Abs(mutagenExe()); err != nil || actual != proxyMutagen {
		t.Fatalf("private Mutagen proxy was not selected: %s: %v", actual, err)
	}
	toolLog := filepath.Join(private, "qa-tool-commands.jsonl")
	// Registered before Setenv's LIFO restorations, so cleanup has the original
	// cwd/tools back before stopping the shared private monitor/daemon.
	t.Cleanup(func() {
		if err := os.Chdir(private); err != nil {
			t.Error(err)
		}
	})
	t.Setenv("CHISA_VPS_QA_TOOL_PROXY", "1")
	t.Setenv("CHISA_VPS_QA_REAL_GIT", realGit)
	t.Setenv("CHISA_VPS_QA_REAL_MUTAGEN", realMutagen)
	t.Setenv("CHISA_VPS_QA_TOOL_LOG", toolLog)
	t.Setenv("PATH", proxyDirectory+string(os.PathListSeparator)+os.Getenv("PATH"))
	if got := git("rev-parse", "HEAD"); got != remoteRecovery.Head {
		t.Fatal("real Git proxy changed output", got)
	}
	// Re-prime after correctness reads and the forced public policy refresh.
	if err := syncProjectContentsContext(ctx, m, false); err != nil {
		t.Fatal("post-recovery warm baseline", err)
	}
	baseline = capture()
	if baseline.ignore.discoverRules == nil || baseline.ignore.resolveConfiguration == nil {
		t.Fatal("post-recovery ignore watcher lacks instrumentation points")
	}
	// Recovery may have replaced the watcher; attach counts to the live one.
	if baseline.ignore != previous.ignore {
		baseline.ignore.mu.Lock()
		discover := baseline.ignore.discoverRules
		configure := baseline.ignore.resolveConfiguration
		baseline.ignore.discoverRules = func(root string) (map[string][32]byte, error) {
			discoveries.Add(1)
			return discover(root)
		}
		baseline.ignore.resolveConfiguration = func() (map[string]bool, error) {
			configurations.Add(1)
			return configure()
		}
		baseline.ignore.mu.Unlock()
	}
	for path := range stamps {
		stamps[path] = readVPSQAFileState(t, path)
	}
	inventories.Store(0)
	discoveries.Store(0)
	configurations.Store(0)
	previous = baseline
	prepTotal, handbackTotal = 0, 0
	logged := readVPSQAToolCommands(t, toolLog)
	if !hasVPSQAToolCommand(logged, "git", "rev-parse") || !hasVPSQAToolCommand(logged, "mutagen", "flush") {
		t.Fatal("private proxies did not record forwarded real Git/Mutagen commands")
	}
	for round := 1; round <= 5; round++ {
		for _, phase := range []struct {
			name    string
			reserve bool
		}{{"preparation", true}, {"handback", false}} {
			started := time.Now()
			// Match actual message callbacks: handback permits draining a legacy
			// recovery transport while preparation does not. A healthy connection
			// must keep the same observer and policy evidence across both contexts.
			callback, cancelCallback, bindErr := bindWorkspaceSyncConnection(context.WithValue(ctx, workspaceRecoveryContextKey{}, !phase.reserve))
			if bindErr != nil {
				t.Fatal(bindErr)
			}
			syncErr := syncProjectContentsContext(callback, m, phase.reserve)
			cancelCallback()
			if syncErr != nil {
				t.Fatalf("post-recovery warm round %d %s: %v", round, phase.name, syncErr)
			}
			elapsed := time.Since(started)
			if phase.reserve {
				prepTotal += elapsed
			} else {
				handbackTotal += elapsed
			}
			current := capture()
			if current.observer != baseline.observer || current.lastUsed <= previous.lastUsed || current.ignore != baseline.ignore || current.ignoreUse <= previous.ignoreUse || current.pair != baseline.pair || current.cache != baseline.cache {
				t.Fatalf("post-recovery warm round %d %s invalidated persistent evidence", round, phase.name)
			}
			if current.session.Identifier != baseline.session.Identifier || current.session.SuccessfulCycles <= previous.session.SuccessfulCycles || current.session.Status != "watching" {
				t.Fatalf("post-recovery warm session/cycles changed: before=%+v after=%+v", previous.session, current.session)
			}
			for path, before := range stamps {
				if after := readVPSQAFileState(t, path); after != before {
					t.Fatalf("post-recovery warm round %d %s rewrote %s", round, phase.name, filepath.Base(path))
				}
			}
			if inventories.Load() != 0 || discoveries.Load() != 0 || configurations.Load() != 0 {
				t.Fatalf("post-recovery warm rescanned policy: inventories=%d discoveries=%d configurations=%d", inventories.Load(), discoveries.Load(), configurations.Load())
			}
			commands := readVPSQAToolCommands(t, toolLog)
			if len(commands) < len(logged) {
				t.Fatal("QA tool command log shrank")
			}
			window := commands[len(logged):]
			if !hasVPSQAToolCommand(window, "mutagen", "flush") {
				t.Fatal("warm measurement did not invoke real Mutagen flush")
			}
			for _, invocation := range window {
				if invocation.Tool != "mutagen" || len(invocation.Args) < 2 || invocation.Args[0] != "sync" || (invocation.Args[1] != "list" && invocation.Args[1] != "flush" && invocation.Args[1] != "monitor") {
					t.Fatalf("post-recovery warm launched full Git read or engine mutation: %+v", invocation)
				}
			}
			t.Logf("post-recovery warm round=%d phase=%s elapsed=%s observer=%p git-cache-unchanged=true pair-unchanged=true cycles=%d->%d watching=true inventory=0 discovery=0 configuration=0 Git-processes=0 pause=0 resume=0 config-rewrite=0 commands=%d", round, phase.name, elapsed, current.observer, previous.session.SuccessfulCycles, current.session.SuccessfulCycles, len(window))
			logged, previous = commands, current
		}
	}
	t.Logf("five post-recovery warm pairs: preparation-total=%s preparation-mean=%s handback-total=%s handback-mean=%s; real forwarded command log excludes Git reads/pause/resume/policy update; durable/config file identities unchanged", prepTotal, prepTotal/5, handbackTotal, handbackTotal/5)
}

func remoteVPSQARepositorySnapshot(command func(string) string, root string) string {
	const script = `import hashlib, json, os, stat, sys
root = sys.argv[1]
paths = [root]
for parent, directories, files in os.walk(root, followlinks=False):
    paths.extend(os.path.join(parent, name) for name in directories + files)
entries = []
for path in sorted(paths):
    info = os.lstat(path)
    content = ''
    if stat.S_ISREG(info.st_mode):
        with open(path, 'rb') as stream:
            content = hashlib.sha256(stream.read()).hexdigest()
    elif stat.S_ISLNK(info.st_mode):
        content = os.readlink(path)
    entries.append([os.path.relpath(path, root), info.st_mode, info.st_dev,
                    info.st_ino, info.st_size, info.st_mtime_ns,
                    info.st_ctime_ns, content])
print(json.dumps(entries, separators=(',', ':')))
`
	return command("python3 -c " + shellQuote(script) + " " + shellQuote(root))
}

func readVPSQAToolCommands(t *testing.T, path string) []vpsQAToolCommand {
	t.Helper()
	log, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer log.Close()
	var result []vpsQAToolCommand
	decoder := json.NewDecoder(log)
	for {
		var command vpsQAToolCommand
		if err := decoder.Decode(&command); err == io.EOF {
			break
		} else if err != nil {
			t.Fatal(err)
		}
		result = append(result, command)
	}
	return result
}

func hasVPSQAToolCommand(commands []vpsQAToolCommand, tool, operation string) bool {
	for _, command := range commands {
		if command.Tool != tool {
			continue
		}
		for _, argument := range command.Args {
			if argument == operation {
				return true
			}
		}
	}
	return false
}

func readVPSQAFileState(t *testing.T, path string) vpsQAFileState {
	t.Helper()
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	state := vpsQAFileState{identity: piWorkspaceFile{mode: info.Mode(), size: info.Size(), modified: info.ModTime().UnixNano()}, body: stringMustReadVPSQA(t, path)}
	if err := piWorkspaceFileIdentity(path, &state.identity); err != nil {
		t.Fatal(err)
	}
	return state
}

func stringMustReadVPSQA(t *testing.T, path string) string {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return string(data)
}

func copyVPSQAResource(t *testing.T, source, target string) {
	t.Helper()
	input, err := os.Open(source)
	if err != nil {
		t.Fatal(err)
	}
	defer input.Close()
	if err := os.MkdirAll(filepath.Dir(target), 0700); err != nil {
		t.Fatal(err)
	}
	output, err := os.OpenFile(target, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0700)
	if err != nil {
		t.Fatal(err)
	}
	_, copyErr := io.Copy(output, input)
	closeErr := output.Close()
	if copyErr != nil || closeErr != nil {
		t.Fatal(fmt.Errorf("copy QA transport: %v / %v", copyErr, closeErr))
	}
}
