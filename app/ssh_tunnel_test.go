package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"
)

type fakeSshProcess struct {
	finish chan error
	once   sync.Once
	killed chan struct{}
}

func newFakeSshProcess() *fakeSshProcess {
	return &fakeSshProcess{finish: make(chan error, 1), killed: make(chan struct{})}
}
func (p *fakeSshProcess) Wait() error { return <-p.finish }
func (p *fakeSshProcess) Kill() error {
	p.once.Do(func() { close(p.killed); p.finish <- errors.New("killed") })
	return nil
}
func (p *fakeSshProcess) exit(err error) { p.once.Do(func() { p.finish <- err }) }

type fakeSshStart struct {
	executable string
	args       []string
	output     io.Writer
	process    *fakeSshProcess
}

type fakeSshRuntime struct {
	starts  chan fakeSshStart
	timeout chan time.Time
	err     error
}

func (r *fakeSshRuntime) dependencies() sshTunnelDependencies {
	return sshTunnelDependencies{
		preflight: func() SshPreflight { return SshPreflight{OK: true, sshExecutable: "system-ssh.exe"} },
		after:     func(time.Duration) <-chan time.Time { return r.timeout },
		start: func(ctx context.Context, executable string, args []string, output io.Writer) (sshOwnedProcess, error) {
			if r.err != nil {
				return nil, r.err
			}
			p := newFakeSshProcess()
			r.starts <- fakeSshStart{executable, append([]string{}, args...), output, p}
			return p, nil
		},
	}
}

func sshTestScope(t *testing.T, identity string) sshAccountScope {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	return sshAccountScope{binding: sshAccountBinding("https://test.invalid", "https://test.invalid/instances/a", identity), serviceURL: "https://test.invalid", ctx: ctx}
}

func sshTestProfile(t *testing.T) SshTunnelProfileInput {
	t.Helper()
	directory := t.TempDir()
	key := filepath.Join(directory, "identity with spaces")
	hosts := filepath.Join(directory, "known_hosts")
	if err := os.WriteFile(key, []byte("test-only-not-real-private-key"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(hosts, []byte("test-only-pinned-public-key"), 0600); err != nil {
		t.Fatal(err)
	}
	return SshTunnelProfileInput{Name: "Windows project", SSHHost: "vps.invalid", SSHUser: "forward-user", SSHPort: 22, KeyPath: key, KnownHostsPath: hosts, RemotePort: 18765, LocalPort: 22}
}

func sshTestManager(t *testing.T) (*sshTunnelManager, *fakeSshRuntime) {
	t.Helper()
	runtime := &fakeSshRuntime{starts: make(chan fakeSshStart, 8), timeout: make(chan time.Time, 8)}
	manager, err := newSshTunnelManager(t.TempDir(), runtime.dependencies())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { manager.stopAll(true) })
	return manager, runtime
}

func waitSshState(t *testing.T, manager *sshTunnelManager, scope sshAccountScope, id, state string) SshTunnelStatus {
	t.Helper()
	deadline := time.After(2 * time.Second)
	ticker := time.NewTicker(time.Millisecond)
	defer ticker.Stop()
	for {
		status, err := manager.getStatus(scope, id)
		if err != nil {
			t.Fatal(err)
		}
		if status.State == state {
			return status
		}
		select {
		case <-deadline:
			t.Fatalf("expected SSH state %s, got %+v", state, status)
		case <-ticker.C:
		}
	}
}

func TestSshProfilesSeparateFromLegacyAccountScopedAndLoadedStopped(t *testing.T) {
	manager, runtime := sshTestManager(t)
	scope := sshTestScope(t, "account-a")
	profile, err := manager.save(scope, sshTestProfile(t))
	if err != nil {
		t.Fatal(err)
	}
	if profile.ID == "" || profile.AccountBinding != scope.binding || profile.ServiceURL != scope.serviceURL {
		t.Fatal("profile lost native account ownership")
	}
	other := sshTestScope(t, "account-b")
	profiles, _ := manager.list(other)
	if len(profiles) != 0 {
		t.Fatal("another account saw profile references")
	}
	if _, err := manager.start(other, profile.ID); err == nil {
		t.Fatal("another account started the profile")
	}
	changed := profile.SshTunnelProfileInput
	changed.Name = "hijack"
	if _, err := manager.save(other, changed); err == nil {
		t.Fatal("another account adopted a profile ID")
	}
	raw, err := os.ReadFile(manager.path)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(raw), "test-only-not-real-private-key") || strings.Contains(string(raw), "generation") || strings.Contains(string(raw), "forwarding") {
		t.Fatal("secret contents or live state persisted")
	}
	if _, err := os.Stat(filepath.Join(filepath.Dir(manager.path), "state.json")); !os.IsNotExist(err) {
		t.Fatal("SSH profile storage touched legacy state")
	}
	reloaded, err := newSshTunnelManager(filepath.Dir(manager.path), runtime.dependencies())
	if err != nil {
		t.Fatal(err)
	}
	status, err := reloaded.getStatus(scope, profile.ID)
	if err != nil || status.State != "stopped" || status.Generation != 0 || status.OuterConnected || status.Verified {
		t.Fatal("loaded profiles did not remain stopped", status, err)
	}
	select {
	case <-runtime.starts:
		t.Fatal("saving/loading implicitly started SSH")
	default:
	}
}

func TestSshTunnelEnvironmentRetainsRequiredWindowsProgramData(t *testing.T) {
	t.Setenv("ProgramData", `C:\ProgramData`)
	if !strings.Contains(strings.ToLower(strings.Join(sshTunnelEnvironment(), "\n")), "programdata=c:\\programdata") {
		t.Fatal("Windows OpenSSH initialization requires the nonsecret ProgramData environment value even with -F NUL")
	}
}

func TestSshProfileSaveFailureDoesNotAdoptConfiguration(t *testing.T) {
	manager, _ := sshTestManager(t)
	scope := sshTestScope(t, "account")
	profile, err := manager.save(scope, sshTestProfile(t))
	if err != nil {
		t.Fatal(err)
	}
	blockingFile := filepath.Join(t.TempDir(), "not-directory")
	if err := os.WriteFile(blockingFile, []byte("x"), 0600); err != nil {
		t.Fatal(err)
	}
	manager.path = filepath.Join(blockingFile, "ssh-tunnels.json")
	input := profile.SshTunnelProfileInput
	input.Name = "unsaved change"
	if _, err := manager.save(scope, input); err == nil {
		t.Fatal("save failure reported success")
	}
	profiles, _ := manager.list(scope)
	if len(profiles) != 1 || profiles[0].Name != profile.Name {
		t.Fatal("failed save adopted unsaved memory state")
	}
}

func TestSshReverseTunnelAcknowledgesOuterOnlyAndStopsOwnedProcess(t *testing.T) {
	manager, runtime := sshTestManager(t)
	scope := sshTestScope(t, "account")
	profile, err := manager.save(scope, sshTestProfile(t))
	if err != nil {
		t.Fatal(err)
	}
	initial, err := manager.start(scope, profile.ID)
	if err != nil || initial.State != "starting" || initial.OuterConnected || initial.Verified {
		t.Fatal(initial, err)
	}
	started := <-runtime.starts
	if started.executable != "system-ssh.exe" || !reflect.DeepEqual(started.args, sshTunnelArguments(profile)) {
		t.Fatal("SSH executable/argv escaped explicit command contract")
	}
	joined := strings.Join(started.args, "\n")
	for _, required := range []string{"BatchMode=yes", "IdentitiesOnly=yes", "StrictHostKeyChecking=yes", "ExitOnForwardFailure=yes", "PermitLocalCommand=no", "ControlMaster=no", "127.0.0.1:18765:127.0.0.1:22"} {
		if !strings.Contains(joined, required) {
			t.Fatal("missing SSH restriction", required)
		}
	}
	if strings.Contains(joined, "test-only-not-real-private-key") || strings.Contains(joined, "StrictHostKeyChecking=no") {
		t.Fatal("SSH argument leaked contents or disabled trust")
	}
	if !strings.Contains(joined, "UserKnownHostsFile=\""+filepath.ToSlash(profile.KnownHostsPath)+"\"") {
		t.Fatal("known_hosts reference with spaces was not quoted for OpenSSH option parsing")
	}
	percentProfile := profile
	percentProfile.KeyPath = filepath.Join(filepath.Dir(profile.KeyPath), "identity%h")
	percentProfile.KnownHostsPath = filepath.Join(filepath.Dir(profile.KeyPath), "hosts%p")
	if args := strings.Join(sshTunnelArguments(percentProfile), "\n"); !strings.Contains(args, "identity%%h") || !strings.Contains(args, "hosts%%p") {
		t.Fatal("literal percent in file reference was expanded as an SSH token")
	}
	// Authentication/child presence are not proof that the listener exists.
	_, _ = io.WriteString(started.output, "Authenticated to vps.invalid\n")
	status, _ := manager.getStatus(scope, profile.ID)
	if status.State != "starting" || status.OuterConnected {
		t.Fatal("claimed forwarding before actual listener acknowledgement")
	}
	_, _ = io.WriteString(started.output, "debug1: remote forward success for: listen 127.0.0.1:18765, connect 127.0.0.1:22\n")
	ready := waitSshState(t, manager, scope, profile.ID, "forwarding")
	if !ready.OuterConnected || ready.Verified {
		t.Fatal("outer forwarding incorrectly represented full local readiness")
	}
	if _, err := manager.start(scope, profile.ID); err != nil {
		t.Fatal("idempotent start failed", err)
	}
	select {
	case <-runtime.starts:
		t.Fatal("idempotent start created another child")
	default:
	}
	if _, err := manager.stop(scope, profile.ID); err != nil {
		t.Fatal(err)
	}
	<-started.process.killed
	stopped := waitSshState(t, manager, scope, profile.ID, "stopped")
	if stopped.OuterConnected || stopped.Verified {
		t.Fatal(stopped)
	}
	if _, err := manager.stop(scope, profile.ID); err != nil {
		t.Fatal("stop not idempotent")
	}
}

func TestSshTunnelFailureTypedBoundedAndDoesNotReconnect(t *testing.T) {
	manager, runtime := sshTestManager(t)
	scope := sshTestScope(t, "account")
	profile, _ := manager.save(scope, sshTestProfile(t))
	if _, err := manager.start(scope, profile.ID); err != nil {
		t.Fatal(err)
	}
	started := <-runtime.starts
	_, _ = io.WriteString(started.output, "PRIVATE PATH C:\\secret-identity\nHost key verification failed.\n")
	started.process.exit(errors.New("raw error containing secret"))
	status := waitSshState(t, manager, scope, profile.ID, "error")
	if status.Code != "SSH_HOST_KEY_REJECTED" || strings.Contains(status.Message, "secret") {
		t.Fatal("typed SSH failure lost or leaked details", status)
	}
	select {
	case <-runtime.starts:
		t.Fatal("failed SSH connection automatically retried")
	default:
	}
	output := newSshTunnelOutput(profile)
	bytes := strings.Repeat("secret", 100000)
	if n, err := output.Write([]byte(bytes)); err != nil || n != len(bytes) || output.total > 64*1024 || len(output.line) > 4096 {
		t.Fatal("SSH output retention not bounded")
	}
}

func TestSshStartupTimeoutAndAccountCancellationCannotLeaveReady(t *testing.T) {
	manager, runtime := sshTestManager(t)
	scope := sshTestScope(t, "account")
	profile, _ := manager.save(scope, sshTestProfile(t))
	if _, err := manager.start(scope, profile.ID); err != nil {
		t.Fatal(err)
	}
	started := <-runtime.starts
	runtime.timeout <- time.Now()
	status := waitSshState(t, manager, scope, profile.ID, "error")
	if status.Code != "SSH_START_TIMEOUT" {
		t.Fatal(status)
	}
	<-started.process.killed
	initial, err := manager.start(scope, profile.ID)
	if err != nil {
		t.Fatal(err)
	}
	second := <-runtime.starts
	manager.stopAll(false)
	_, _ = io.WriteString(second.output, "debug1: remote forward success for: listen 127.0.0.1:18765, connect 127.0.0.1:22\n")
	waitSshState(t, manager, scope, profile.ID, "stopped")
	if initial.Generation <= status.Generation {
		t.Fatal("generation did not advance across explicit restarts")
	}
	manager.stopAll(true)
	if _, err := manager.start(scope, profile.ID); err == nil {
		t.Fatal("closed desktop accepted new SSH start")
	}
}

func TestSshCancelledAccountAndMissingPrerequisitesNeverSpawn(t *testing.T) {
	manager, runtime := sshTestManager(t)
	scope := sshTestScope(t, "account")
	profile, _ := manager.save(scope, sshTestProfile(t))
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	cancelled := scope
	cancelled.ctx = ctx
	if _, err := manager.start(cancelled, profile.ID); err == nil {
		t.Fatal("cancelled account started SSH")
	}
	manager.deps.preflight = func() SshPreflight {
		return SshPreflight{Issues: []SshPreflightIssue{{"SSH_SERVER_MISSING", "missing server"}}}
	}
	if _, err := manager.start(scope, profile.ID); err != nil {
		t.Fatal(err)
	}
	if status := waitSshState(t, manager, scope, profile.ID, "error"); status.Code != "SSH_SERVER_MISSING" {
		t.Fatal("missing prerequisite not reported", status)
	}
	select {
	case <-runtime.starts:
		t.Fatal("invalid scope/preflight spawned a process")
	default:
	}
}

func TestSshProfileValidationRejectsOptionsAndSecretMaterial(t *testing.T) {
	base := sshTestProfile(t)
	for _, mutate := range []func(*SshTunnelProfileInput){
		func(p *SshTunnelProfileInput) { p.SSHHost = "-oProxyCommand=bad" },
		func(p *SshTunnelProfileInput) { p.SSHUser = "user@other" },
		func(p *SshTunnelProfileInput) { p.KeyPath = "-----BEGIN OPENSSH PRIVATE KEY-----" },
		func(p *SshTunnelProfileInput) { p.KnownHostsPath = "relative-hosts" },
		func(p *SshTunnelProfileInput) { p.KnownHostsPath = filepath.Join(t.TempDir(), "${HOME}-hosts") },
		func(p *SshTunnelProfileInput) { p.KeyPath = filepath.Join(t.TempDir(), "quoted\"key") },
		func(p *SshTunnelProfileInput) { p.RemotePort = 22 },
	} {
		input := base
		mutate(&input)
		if _, err := normalizeSshTunnelInput(input); err == nil {
			t.Fatal("invalid profile accepted", input.Name)
		}
	}
}

func TestSshHelperInstallationIsExplicitVersionedAndPreservesChangedPayload(t *testing.T) {
	directory := t.TempDir()
	payload := []byte("# test helper, no secrets\r\n")
	path, digest, err := installSshWorkspaceHelper(directory, payload)
	if err != nil || !strings.Contains(path, digest) || len(digest) != 64 {
		t.Fatal(path, digest, err)
	}
	again, digestAgain, err := installSshWorkspaceHelper(directory, payload)
	if err != nil || again != path || digestAgain != digest {
		t.Fatal("helper install not idempotent", err)
	}
	if err := os.WriteFile(path, []byte("changed"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, _, err := installSshWorkspaceHelper(directory, payload); err == nil || sshErrorResponse(err)["code"] != "SSH_HELPER_CONTENT_CHANGED" {
		t.Fatal("modified helper overwritten", err)
	}
}

func TestSshProfileStoreRejectsMalformedWithoutOverwrite(t *testing.T) {
	directory := t.TempDir()
	path := filepath.Join(directory, "ssh-tunnels.json")
	body := []byte(`{"version":1,"profiles":[{"id":"bad"}]}`)
	if err := os.WriteFile(path, body, 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := newSshTunnelManager(directory, defaultSshTunnelDependencies()); err == nil {
		t.Fatal("invalid profile file accepted")
	}
	after, err := os.ReadFile(path)
	if err != nil || !reflect.DeepEqual(after, body) {
		t.Fatal("invalid store was changed")
	}
	var parsed any
	if json.Unmarshal(after, &parsed) != nil {
		t.Fatal("fixture malformed")
	}
}
