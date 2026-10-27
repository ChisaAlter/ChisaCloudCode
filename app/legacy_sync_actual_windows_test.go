package main

import (
	"context"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"
)

// Only the test's copied ssh.exe takes this path. A real SSH process/network is
// never involved in the isolated legacy daemon interoperability fixture.
func init() {
	if os.Getenv("CHISA_RETIREMENT_FAKE_SSH") == "1" && filepath.Base(os.Args[0]) == "ssh.exe" {
		os.Exit(42)
	}
}

func TestCloudOnlyRetirementActualLegacyDaemonIsolated(t *testing.T) {
	binary := os.Getenv("CHISA_RETIREMENT_QA_BINARY")
	if binary == "" {
		t.Skip("isolated legacy binary not explicitly supplied")
	}
	absolute, err := filepath.Abs(binary)
	if err != nil {
		t.Fatal(err)
	}
	profile := t.TempDir()
	transport := filepath.Join(profile, "fake-ssh")
	if err := os.MkdirAll(transport, 0700); err != nil {
		t.Fatal(err)
	}
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	input, err := os.Open(executable)
	if err != nil {
		t.Fatal(err)
	}
	output, err := os.Create(filepath.Join(transport, "ssh.exe"))
	if err != nil {
		input.Close()
		t.Fatal(err)
	}
	_, copyErr := io.Copy(output, input)
	input.Close()
	output.Close()
	if copyErr != nil {
		t.Fatal(copyErr)
	}
	environment := []string{}
	for _, entry := range os.Environ() {
		if len(entry) >= 8 && entry[:8] == "MUTAGEN_" {
			continue
		}
		environment = append(environment, entry)
	}
	environment = append(environment, "MUTAGEN_DATA_DIRECTORY="+filepath.Join(profile, "mutagen"), "MUTAGEN_SSH_PATH="+transport, "CHISA_RETIREMENT_FAKE_SSH=1")
	run := func(args ...string) string {
		t.Helper()
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		command := hideCommandWindow(exec.CommandContext(ctx, absolute, args...))
		command.Env = environment
		raw, err := command.CombinedOutput()
		if err != nil {
			t.Fatalf("isolated legacy fixture %v failed: %v %s", args, err, raw)
		}
		return string(raw)
	}
	run("daemon", "start")
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		command := hideCommandWindow(exec.CommandContext(ctx, absolute, "daemon", "stop"))
		command.Env = environment
		if raw, err := command.CombinedOutput(); err != nil {
			t.Errorf("private fixture daemon cleanup: %v %s", err, raw)
		}
	})
	mapping, _ := legacyRetirementFixture(t)
	run("sync", "create", "--paused", "--name", mapping.SyncName, "--no-global-configuration", "--ignore", "/.chisa-sync-policy/git-v1", mapping.LocalPath, legacySyncAlias(mapping)+":"+mapping.ServerPath)
	foreignLocal, foreignRemote := t.TempDir(), t.TempDir()
	run("sync", "create", "--paused", "--name", "unrelated-fixture", "--no-global-configuration", foreignLocal, foreignRemote)
	// The fake SSH endpoint fails immediately. Legacy Resume still persists
	// Paused=false and starts its retry controller before returning that error.
	resumeContext, cancelResume := context.WithTimeout(context.Background(), 10*time.Second)
	resume := hideCommandWindow(exec.CommandContext(resumeContext, absolute, "sync", "resume", mapping.SyncName))
	resume.Env = environment
	_, _ = resume.CombinedOutput()
	cancelResume()
	beforeRunner := newLegacySyncRunner(profile)
	before, beforeErr := beforeRunner.list(context.Background())
	beforeRunner.(*legacySyncIPCRunner).Close()
	if beforeErr != nil {
		t.Fatal(beforeErr)
	}
	active := false
	for _, session := range before {
		if session.Name == mapping.SyncName && !session.Paused {
			active = true
		}
	}
	if !active {
		t.Fatal("private legacy fixture did not enter an unpaused retry state")
	}
	run("sync", "resume", "unrelated-fixture")
	runner := newLegacySyncRunner(profile)
	result := retireLegacySync(context.Background(), &Store{Mappings: []*Mapping{mapping}}, runner)
	if result.Paused != 1 || result.Unverified != 1 || result.Error != "" {
		t.Fatal("actual legacy daemon retirement failed", result)
	}
	verify := newLegacySyncRunner(profile)
	defer verify.(*legacySyncIPCRunner).Close()
	sessions, err := verify.list(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	for _, session := range sessions {
		if session.Name == mapping.SyncName && !session.Paused {
			t.Fatal("owned session still runs")
		}
		if session.Name == "unrelated-fixture" && session.Paused {
			t.Fatal("unrelated session paused")
		}
	}
}
