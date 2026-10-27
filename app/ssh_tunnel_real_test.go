//go:build windows

package main

import (
	"context"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"testing"
	"time"
)

// TestSshRealNativeTunnelProcess is deliberately opt-in. It exercises the real
// system ssh.exe, production argv, process launcher, Job Object, acknowledgement
// parser and stop/reap path. Only the service prerequisite is injected so a
// separately owned portable Windows sshd can be used without installing a service.
// It uses a synthetic account scope; it does not validate native cloud login,
// dialogs, the shipped preflight or a VPS-to-Windows project/helper probe.
//
// Required: CHISA_SSH_REAL_HOST, CHISA_SSH_REAL_USER, CHISA_SSH_REAL_KEY,
// CHISA_SSH_REAL_KNOWN_HOSTS, CHISA_SSH_REAL_REMOTE_PORT, CHISA_SSH_REAL_LOCAL_PORT.
// Optional: CHISA_SSH_REAL_HOLD_SECONDS (0..60) leaves the acknowledged forwarding
// alive for an independent VPS probe before the test stops its own process.
// CHISA_SSH_REAL_PROBE=1 additionally uses the fixed, explicitly provisioned VPS
// test key/known-host references to run whoami through that listener, comparing
// CHISA_SSH_REAL_EXPECTED_IDENTITY without exposing the returned identity.
// Private keys are only passed as absolute references and never read or logged.
func TestSshRealNativeTunnelProcess(t *testing.T) {
	if os.Getenv("CHISA_SSH_REAL_HOST") == "" {
		t.Skip("opt-in real SSH process test: CHISA_SSH_REAL_HOST is unset")
	}
	required := func(name string) string {
		t.Helper()
		value := os.Getenv(name)
		if value == "" {
			t.Fatalf("real SSH configuration requires %s", name)
		}
		return value
	}
	port := func(name string, minimum int) int {
		t.Helper()
		value, err := strconv.Atoi(required(name))
		if err != nil || value < minimum || value > 65535 {
			t.Fatalf("%s must be an integer in %d..65535", name, minimum)
		}
		return value
	}
	holdSeconds := 0
	if configured := os.Getenv("CHISA_SSH_REAL_HOLD_SECONDS"); configured != "" {
		value, err := strconv.Atoi(configured)
		if err != nil || value < 0 || value > 60 {
			t.Fatal("CHISA_SSH_REAL_HOLD_SECONDS must be an integer in 0..60")
		}
		holdSeconds = value
	}
	input := SshTunnelProfileInput{
		Name:           "Explicit real native SSH process test",
		SSHHost:        required("CHISA_SSH_REAL_HOST"),
		SSHPort:        22,
		SSHUser:        required("CHISA_SSH_REAL_USER"),
		KeyPath:        required("CHISA_SSH_REAL_KEY"),
		KnownHostsPath: required("CHISA_SSH_REAL_KNOWN_HOSTS"),
		RemotePort:     port("CHISA_SSH_REAL_REMOTE_PORT", 1024),
		LocalPort:      port("CHISA_SSH_REAL_LOCAL_PORT", 1),
	}
	actualPreflight := nativeSshPreflight()
	if !actualPreflight.SSHAvailable || actualPreflight.sshExecutable == "" {
		t.Fatal("the real system Windows OpenSSH client is required")
	}
	t.Logf("Production prerequisite observation: sshClient=%t sshdExecutable=%t sshdServiceInstalled=%t sshdServiceRunning=%t", actualPreflight.SSHAvailable, actualPreflight.SSHDAvailable, actualPreflight.SSHDServiceInstalled, actualPreflight.SSHDServiceRunning)
	t.Log("Test-only prerequisite override; synthetic account scope; this is not a shipped desktop-start or project-readiness test")
	deps := defaultSshTunnelDependencies()
	deps.preflight = func() SshPreflight {
		return SshPreflight{OK: true, Platform: actualPreflight.Platform, SSHAvailable: true, sshExecutable: actualPreflight.sshExecutable}
	}
	manager, err := newSshTunnelManager(t.TempDir(), deps)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	scope := sshAccountScope{binding: sshAccountBinding("https://real-process-test.invalid", "isolated-instance", "synthetic-test-account"), serviceURL: "https://real-process-test.invalid", ctx: ctx}
	t.Cleanup(func() {
		cancel()
		manager.stopAll(true)
		manager.mu.Lock()
		done := make([]<-chan struct{}, 0, len(manager.entries))
		for _, entry := range manager.entries {
			done = append(done, entry.done)
		}
		manager.mu.Unlock()
		deadline := time.NewTimer(10 * time.Second)
		defer deadline.Stop()
		for _, reaped := range done {
			select {
			case <-reaped:
			case <-deadline.C:
				t.Error("owned SSH run loop did not finish cleanup within 10 seconds")
				return
			}
		}
	})
	profile, err := manager.save(scope, input)
	if err != nil {
		t.Fatal(err)
	}
	initial, err := manager.start(scope, profile.ID)
	if err != nil {
		t.Fatal(err)
	}
	if initial.State != "starting" || initial.OuterConnected || initial.Verified || initial.Generation == 0 {
		t.Fatalf("unexpected initial status: state=%s outerConnected=%t verified=%t generation=%d", initial.State, initial.OuterConnected, initial.Verified, initial.Generation)
	}
	forwarding := sshRealAwaitState(t, manager, scope, profile.ID, "forwarding", 30*time.Second)
	if !forwarding.OuterConnected || forwarding.Verified || forwarding.Generation != initial.Generation {
		t.Fatal("real forwarding acknowledgement was lost or incorrectly marked project-verified")
	}
	t.Logf("Real production SSH process acknowledged loopback reverse listener: remotePort=%d localPort=%d generation=%d outerConnected=true verified=false", input.RemotePort, input.LocalPort, forwarding.Generation)
	manager.mu.Lock()
	reaped := manager.entries[profile.ID].done
	manager.mu.Unlock()
	select {
	case <-reaped:
		t.Fatal("owned process exited immediately after forwarding acknowledgement")
	default:
	}
	if probe := os.Getenv("CHISA_SSH_REAL_PROBE"); probe != "" {
		if probe != "1" {
			t.Fatal("CHISA_SSH_REAL_PROBE must be 1 when configured")
		}
		sshRealProbeWindowsIdentity(t, ctx, actualPreflight.sshExecutable, profile, required("CHISA_SSH_REAL_EXPECTED_IDENTITY"))
	}
	if holdSeconds > 0 {
		t.Logf("Holding acknowledged listener for %d seconds for an independent VPS probe", holdSeconds)
		timer := time.NewTimer(time.Duration(holdSeconds) * time.Second)
		select {
		case <-timer.C:
		case <-reaped:
			timer.Stop()
			t.Fatal("owned SSH process exited during independent-probe hold")
		case <-ctx.Done():
			timer.Stop()
			t.Fatal("real test context expired during independent-probe hold")
		}
	}
	beforeStop, err := manager.getStatus(scope, profile.ID)
	if err != nil || beforeStop.State != "forwarding" || !beforeStop.OuterConnected || beforeStop.Verified {
		t.Fatal("forwarding did not remain active before explicit stop")
	}
	stopping, err := manager.stop(scope, profile.ID)
	if err != nil || (stopping.State != "stopping" && stopping.State != "stopped") || stopping.OuterConnected || stopping.Verified {
		t.Fatal("explicit stop did not revoke forwarding readiness")
	}
	select {
	case <-reaped:
	case <-time.After(10 * time.Second):
		t.Fatal("real owned SSH child was not reaped within 10 seconds of stop")
	}
	stopped := sshRealAwaitState(t, manager, scope, profile.ID, "stopped", time.Second)
	if stopped.OuterConnected || stopped.Verified || stopped.Generation != initial.Generation {
		t.Fatal("stopped real tunnel retained readiness or changed generation")
	}
	if again, err := manager.stop(scope, profile.ID); err != nil || again.State != "stopped" {
		t.Fatal("second stop was not idempotent")
	}
	manager.stopAll(true)
	if _, err := manager.start(scope, profile.ID); err == nil {
		t.Fatal("closed manager restarted a real SSH process")
	}
	t.Log("Explicit stop completed production Kill/Wait cleanup, closed the process owner, and reaped the owned run loop; second stop was idempotent; closed manager rejected restart")
}

// sshRealProbeWindowsIdentity checks the actual inner authentication while the
// native-owned listener is live. All remote words except the validated integer
// port are fixed references in the explicitly provisioned real-test environment.
// No private key, raw SSH stderr or actual identity is printed.
func sshRealProbeWindowsIdentity(t *testing.T, ctx context.Context, executable string, profile SshTunnelProfile, expected string) {
	t.Helper()
	args := []string{}
	production := sshTunnelArguments(profile)
	for index := 0; index < len(production); index++ {
		switch production[index] {
		case "-N", "-v":
			continue
		case "-R":
			index++
			continue
		default:
			args = append(args, production[index])
		}
	}
	remoteCommand := "ssh -F /dev/null -T -a -p " + strconv.Itoa(profile.RemotePort) + " -l 48818 -i /tmp/chisa-ssh-real-20261025/execution_ed25519 -o BatchMode=yes -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=/tmp/chisa-ssh-real-20261025/native_known_hosts -o GlobalKnownHostsFile=/dev/null -o UpdateHostKeys=no -o ConnectTimeout=10 -o ConnectionAttempts=1 -o NumberOfPasswordPrompts=0 -- 127.0.0.1 whoami"
	args = append(args, remoteCommand)
	probeContext, cancel := context.WithTimeout(ctx, 25*time.Second)
	defer cancel()
	command := hideCommandWindow(exec.CommandContext(probeContext, executable, args...))
	command.Env = sshTunnelEnvironment()
	command.WaitDelay = 2 * time.Second
	stdout, err := command.Output()
	if err != nil {
		if failure, ok := err.(*exec.ExitError); ok {
			t.Fatalf("VPS-to-Windows identity probe failed with exit code %d; raw output withheld", failure.ExitCode())
		}
		t.Fatal("VPS-to-Windows identity probe failed before a verified reply; raw output withheld")
	}
	if !strings.EqualFold(strings.TrimSpace(string(stdout)), strings.TrimSpace(expected)) {
		t.Fatal("VPS-to-Windows identity probe returned an unexpected identity; raw output withheld")
	}
	t.Log("Independent VPS-to-Windows public-key identity probe matched the expected Windows account through the native-owned reverse listener; project/helper readiness was not inferred")
}

func sshRealAwaitState(t *testing.T, manager *sshTunnelManager, scope sshAccountScope, id, wanted string, timeout time.Duration) SshTunnelStatus {
	t.Helper()
	ticker := time.NewTicker(25 * time.Millisecond)
	defer ticker.Stop()
	deadline := time.NewTimer(timeout)
	defer deadline.Stop()
	for {
		status, err := manager.getStatus(scope, id)
		if err != nil {
			t.Fatal(err)
		}
		if status.State == wanted {
			return status
		}
		if status.State == "error" {
			t.Fatalf("real tunnel failed: code=%s message=%s", status.Code, status.Message)
		}
		select {
		case <-ticker.C:
		case <-deadline.C:
			t.Fatalf("real tunnel did not reach %s within %s; state=%s code=%s", wanted, timeout, status.State, status.Code)
		}
	}
}
