package main

import (
	"bytes"
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func syncGitObservationTestEnvironment(t *testing.T) {
	t.Helper()
	for _, entry := range os.Environ() {
		key, _, _ := strings.Cut(entry, "=")
		if strings.HasPrefix(strings.ToUpper(key), "GIT_") {
			t.Setenv(key, "")
		}
	}
	configuration := t.TempDir()
	t.Setenv("GIT_CONFIG_NOSYSTEM", "1")
	t.Setenv("GIT_CONFIG_GLOBAL", filepath.Join(configuration, "absent-global"))
	t.Setenv("GIT_AUTHOR_NAME", "Observation regression")
	t.Setenv("GIT_AUTHOR_EMAIL", "observation@localhost")
	t.Setenv("GIT_COMMITTER_NAME", "Observation regression")
	t.Setenv("GIT_COMMITTER_EMAIL", "observation@localhost")
	t.Setenv("GIT_TERMINAL_PROMPT", "0")
}

func syncGitObservationTestGit(t *testing.T, root string, args ...string) string {
	t.Helper()
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("Git is required")
	}
	command := exec.Command("git", append([]string{"-C", root, "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false"}, args...)...)
	out, err := command.CombinedOutput()
	if err != nil {
		t.Fatalf("git %v: %v\n%s", args, err, out)
	}
	return strings.TrimSpace(string(out))
}

func syncGitObservationTestWrite(t *testing.T, name, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(name), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(name, []byte(content), 0600); err != nil {
		t.Fatal(err)
	}
}

func syncGitObservationTestFingerprint(t *testing.T, m *Mapping, repository bool) string {
	t.Helper()
	token, actual, err := localSyncMetadataFingerprint(m)
	if err != nil || actual != repository || token == "" {
		t.Fatalf("fingerprint: repository=%v token=%q err=%v", actual, token, err)
	}
	return token
}

func TestSyncGitObservationFingerprintStableAndMetadataChanges(t *testing.T) {
	syncGitObservationTestEnvironment(t)
	m := &Mapping{LocalPath: t.TempDir()}
	syncGitObservationTestGit(t, m.LocalPath, "init", "-b", "main")
	syncGitObservationTestGit(t, m.LocalPath, "commit", "--allow-empty", "-m", "base")
	baseline := syncGitObservationTestFingerprint(t, m, true)
	if again := syncGitObservationTestFingerprint(t, m, true); again != baseline {
		t.Fatal("unchanged metadata fingerprint is not stable")
	}
	syncGitObservationTestWrite(t, filepath.Join(m.LocalPath, "ordinary.txt"), "first\n")
	if again := syncGitObservationTestFingerprint(t, m, true); again != baseline {
		t.Fatal("ordinary worktree content invalidated Git metadata")
	}
	grafts := filepath.Join(m.LocalPath, ".git", "info", "grafts")
	syncGitObservationTestWrite(t, grafts, "# graft input\n")
	changed := syncGitObservationTestFingerprint(t, m, true)
	if changed == baseline {
		t.Fatal("grafts creation did not invalidate Git metadata")
	}
	info, err := os.Stat(grafts)
	if err != nil {
		t.Fatal(err)
	}
	syncGitObservationTestWrite(t, grafts, "# graft other\n")
	if err := os.Chtimes(grafts, info.ModTime(), info.ModTime()); err != nil {
		t.Fatal(err)
	}
	if again := syncGitObservationTestFingerprint(t, m, true); again == changed {
		t.Fatal("same-size restored-mtime metadata edit reused evidence")
	}
	rebase := filepath.Join(m.LocalPath, ".git", "rebase-merge", "done")
	syncGitObservationTestWrite(t, rebase, "pick first\n")
	operation := syncGitObservationTestFingerprint(t, m, true)
	syncGitObservationTestWrite(t, rebase, "pick other\n")
	if again := syncGitObservationTestFingerprint(t, m, true); again == operation {
		t.Fatal("operation state edit reused evidence")
	}
}

func TestSyncGitObservationWorktreeConfigurationStaysLightweight(t *testing.T) {
	syncGitObservationTestEnvironment(t)
	m := &Mapping{LocalPath: t.TempDir()}
	syncGitObservationTestGit(t, m.LocalPath, "init", "-b", "main")
	syncGitObservationTestGit(t, m.LocalPath, "config", "extensions.worktreeConfig", "true")
	absent := syncGitObservationTestFingerprint(t, m, true)
	if again := syncGitObservationTestFingerprint(t, m, true); again != absent {
		t.Fatal("enabled worktreeConfig without file is unstable")
	}
	config := filepath.Join(m.LocalPath, ".git", "config.worktree")
	syncGitObservationTestWrite(t, config, "[core]\nfilemode = false\n")
	present := syncGitObservationTestFingerprint(t, m, true)
	if present == absent {
		t.Fatal("worktree config creation did not change proof")
	}
	if again := syncGitObservationTestFingerprint(t, m, true); again != present {
		t.Fatal("ordinary worktreeConfig cannot stay lightweight")
	}
	syncGitObservationTestWrite(t, config, "[core]\nfilemode = true\n")
	if again := syncGitObservationTestFingerprint(t, m, true); again == present {
		t.Fatal("worktree config edit did not change proof")
	}
}

func TestSyncGitObservationUnsupportedProofUsesFallback(t *testing.T) {
	syncGitObservationTestEnvironment(t)
	cases := []struct {
		name  string
		setup func(*testing.T, *Mapping)
	}{
		{"include-spacing", func(t *testing.T, m *Mapping) {
			syncGitObservationTestWrite(t, filepath.Join(m.LocalPath, ".git", "config"), "[ include ]\npath = elsewhere\n")
		}},
		{"includeif-spacing", func(t *testing.T, m *Mapping) {
			syncGitObservationTestWrite(t, filepath.Join(m.LocalPath, ".git", "config"), "[ includeIf \"gitdir:*/\" ]\npath = elsewhere\n")
		}},
		{"worktree-config-include", func(t *testing.T, m *Mapping) {
			syncGitObservationTestWrite(t, filepath.Join(m.LocalPath, ".git", "config.worktree"), "[ include ]\npath = elsewhere\n")
		}},
		{"includeif-dotted", func(t *testing.T, m *Mapping) {
			syncGitObservationTestWrite(t, filepath.Join(m.LocalPath, ".git", "config"), "[includeIf.gitdir:*/]\npath = elsewhere\n")
		}},
		{"reftable", func(t *testing.T, m *Mapping) {
			if err := os.Mkdir(filepath.Join(m.LocalPath, ".git", "reftable"), 0700); err != nil {
				t.Fatal(err)
			}
		}},
		{"loose-replace", func(t *testing.T, m *Mapping) {
			syncGitObservationTestWrite(t, filepath.Join(m.LocalPath, ".git", "refs", "replace", strings.Repeat("a", 40)), strings.Repeat("b", 40)+"\n")
		}},
		{"packed-replace", func(t *testing.T, m *Mapping) {
			syncGitObservationTestWrite(t, filepath.Join(m.LocalPath, ".git", "packed-refs"), strings.Repeat("a", 40)+" refs/replace/"+strings.Repeat("b", 40)+"\n")
		}},
		{"index-override", func(t *testing.T, m *Mapping) { t.Setenv("GIT_INDEX_FILE", filepath.Join(m.LocalPath, "other-index")) }},
		{"config-count", func(t *testing.T, m *Mapping) {
			t.Setenv("GIT_CONFIG_COUNT", "1")
			t.Setenv("GIT_CONFIG_KEY_0", "core.bare")
			t.Setenv("GIT_CONFIG_VALUE_0", "false")
		}},
		{"config-parameters", func(t *testing.T, m *Mapping) { t.Setenv("GIT_CONFIG_PARAMETERS", "'core.bare=false'") }},
	}
	for _, scenario := range cases {
		t.Run(scenario.name, func(t *testing.T) {
			m := &Mapping{LocalPath: t.TempDir()}
			syncGitObservationTestGit(t, m.LocalPath, "init", "-b", "main")
			scenario.setup(t, m)
			if token, _, err := localSyncMetadataFingerprint(m); err == nil || token != "" {
				t.Fatalf("unsupported proof accepted: %q %v", token, err)
			}
		})
	}
}

func TestSyncGitObservationNoGitRootAndBothEndpointProof(t *testing.T) {
	syncGitObservationTestEnvironment(t)
	m := isolatePi(t)
	baseline := syncGitObservationTestFingerprint(t, m, false)
	syncGitObservationTestWrite(t, filepath.Join(m.LocalPath, "ordinary.txt"), "content\n")
	if token := syncGitObservationTestFingerprint(t, m, false); token != baseline {
		t.Fatal("ordinary no-Git file changed Git proof")
	}
	previous := observeSyncGitRemoteMetadata
	remote := syncMetadataObservation{Git: "remote-absence", Repository: false}
	observations := 0
	observeSyncGitRemoteMetadata = func(context.Context, *Mapping) (syncMetadataObservation, error) { observations++; return remote, nil }
	t.Cleanup(func() { observeSyncGitRemoteMetadata = previous })
	ctx := context.Background()
	plan, err := prepareGitSyncContext(ctx, m)
	if err != nil {
		t.Fatal(err)
	}
	if observations != 1 || plan.git || plan.unborn || plan.localFingerprint == "" || plan.remoteFingerprint == "" {
		t.Fatalf("no-Git plan omitted endpoint evidence: %+v observations=%d", plan, observations)
	}
	if err := plan.verify(ctx, m); err != nil {
		t.Fatal(err)
	}
	remote.Git = "different-remote-root"
	if err := plan.verify(ctx, m); err == nil {
		t.Fatal("remote no-Git root replacement was accepted")
	}
	remote = syncMetadataObservation{Git: "remote-absence", Repository: true}
	if _, err := prepareGitSyncContext(ctx, m); err == nil {
		t.Fatal("local no-Git/remote Git mode mismatch was accepted")
	}
	remote = syncMetadataObservation{Git: "remote-absence"}
	syncGitObservationTestGit(t, m.LocalPath, "init", "-b", "main")
	if err := plan.verify(ctx, m); err == nil {
		t.Fatal("local repository creation was accepted by no-Git plan")
	}
	nested := filepath.Join(m.LocalPath, "child")
	if err := os.Mkdir(nested, 0700); err != nil {
		t.Fatal(err)
	}
	if token, _, err := localSyncMetadataFingerprint(&Mapping{LocalPath: nested}); err == nil || token != "" {
		t.Fatal("child of another Git root certified as no-Git")
	}
	unborn := &syncGitPlan{mapping: *m, key: syncGitObservationKey(ctx, m), unborn: true, localFingerprint: syncGitObservationTestFingerprint(t, m, true), remoteFingerprint: remote.Git}
	if err := unborn.verify(ctx, m); err != nil {
		t.Fatal(err)
	}
	remote.Repository = true
	if err := unborn.verify(ctx, m); err == nil {
		t.Fatal("remote repository creation was accepted by unborn plan")
	}
	remote.Repository = false
	unborn.localFingerprint = ""
	if err := unborn.verify(ctx, m); err == nil {
		t.Fatal("unborn plan accepted missing metadata proof")
	}
}

func TestSyncGitObservationMetadataReadBoundAndContentIdentity(t *testing.T) {
	syncGitObservationTestEnvironment(t)
	name := filepath.Join(t.TempDir(), "metadata")
	original := []byte("first-value\n")
	if err := os.WriteFile(name, original, 0600); err != nil {
		t.Fatal(err)
	}
	first, err := readSyncGitMetadataFile(name, true, 1024)
	if err != nil || !bytes.Equal(first.content, original) {
		t.Fatalf("captured metadata: %+v %v", first, err)
	}
	if _, err := readSyncGitMetadataFile(name, true, 2); err == nil {
		t.Fatal("oversize metadata accepted")
	}
	info, err := os.Stat(name)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(name, []byte("other-value\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Chtimes(name, info.ModTime(), info.ModTime()); err != nil {
		t.Fatal(err)
	}
	second, err := readSyncGitMetadataFile(name, true, 1024)
	if err != nil {
		t.Fatal(err)
	}
	if first.stamp == second.stamp || first.digest == second.digest {
		t.Fatal("restored-mtime edit retained stamp or content identity")
	}
}

func TestSyncGitObservationAncestorBareRepositoryRequiresFallback(t *testing.T) {
	syncGitObservationTestEnvironment(t)
	root := t.TempDir()
	syncGitObservationTestGit(t, root, "init", "--bare")
	child := filepath.Join(root, "child")
	if err := os.Mkdir(child, 0700); err != nil {
		t.Fatal(err)
	}
	if token, _, err := localSyncMetadataFingerprint(&Mapping{LocalPath: child}); err == nil || token != "" {
		t.Fatal("child of bare repository certified as no-Git")
	}
}

func TestSyncGitObservationSystemConfigBoolean(t *testing.T) {
	syncGitObservationTestEnvironment(t)
	for _, value := range []string{"", "0", "false", "no", "off", "unknown"} {
		t.Setenv("GIT_CONFIG_NOSYSTEM", value)
		if syncGitSystemConfigDisabled() {
			t.Fatalf("%q unexpectedly disables system config observation", value)
		}
	}
	for _, value := range []string{"1", "true", "yes", "on", "TRUE"} {
		t.Setenv("GIT_CONFIG_NOSYSTEM", value)
		if !syncGitSystemConfigDisabled() {
			t.Fatalf("%q unexpectedly enables system config observation", value)
		}
	}
	m := &Mapping{LocalPath: t.TempDir()}
	syncGitObservationTestGit(t, m.LocalPath, "init", "-b", "main")
	system := filepath.Join(t.TempDir(), "absent-system")
	t.Setenv("GIT_CONFIG_SYSTEM", system)
	for _, value := range []string{"0", "false"} {
		t.Setenv("GIT_CONFIG_NOSYSTEM", value)
		inputs, err := syncIgnoreGitConfigurationInputs(context.Background(), m)
		if err != nil || !inputs[system] {
			t.Fatalf("NOSYSTEM=%q missing system input: %v %v", value, inputs, err)
		}
	}
}

func TestSyncGitObservationDefaultSystemConfigPath(t *testing.T) {
	syncGitObservationTestEnvironment(t)
	t.Setenv("GIT_CONFIG_NOSYSTEM", "")
	expected := syncGitObservationTestGit(t, t.TempDir(), "var", "GIT_CONFIG_SYSTEM")
	actual, err := syncGitSystemConfigPath()
	if err != nil || !strings.EqualFold(filepath.Clean(expected), actual) {
		t.Fatalf("system config path: actual=%q expected=%q err=%v", actual, expected, err)
	}
	m := &Mapping{LocalPath: t.TempDir()}
	syncGitObservationTestGit(t, m.LocalPath, "init", "-b", "main")
	syncGitObservationTestFingerprint(t, m, true)
}
