package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func localGitReadFixture(t *testing.T) (*Mapping, func(...string) string) {
	t.Helper()
	m := isolateSyncRecovery(t)
	t.Setenv("HOME", t.TempDir())
	git := func(args ...string) string {
		t.Helper()
		fixed := []string{"--no-pager", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-C", m.LocalPath}
		cmd := hideCommandWindow(exec.Command("git", append(fixed, args...)...))
		out, err := cmd.CombinedOutput()
		if err != nil {
			t.Fatalf("private Git fixture %v: %v %s", args, err, out)
		}
		return string(out)
	}
	git("init", "-b", "main")
	git("config", "user.name", "Local read QA")
	git("config", "user.email", "local-read@localhost")
	piWorkspaceWrite(t, m.LocalPath, "plain.txt", "baseline\n")
	piWorkspaceWrite(t, m.LocalPath, "中文 空格.txt", "中文 baseline\n")
	git("add", ".")
	git("commit", "-m", "baseline")
	git("remote", "add", "origin", "https://example.invalid/private-read-only-fixture.git")
	git("config", "branch.main.remote", "origin")
	git("config", "branch.main.merge", "refs/heads/main")
	git("update-ref", "refs/remotes/origin/main", strings.TrimSpace(git("rev-parse", "HEAD")))
	remoteLeaseContext = func(context.Context, *Mapping, string, string, string) (map[string]any, error) {
		t.Fatal("local Git read contacted the remote lease/SSH path")
		return nil, nil
	}
	synchronizeProjectContext = func(context.Context, *Mapping, bool) error {
		t.Fatal("local Git read performed synchronization")
		return nil
	}
	return m, git
}

func localGitReadTestRPC(m *Mapping, action string, args ...string) map[string]any {
	request := map[string]any{"op": "git_read", "action": action}
	if action != "prepare" {
		request["path"] = "/workspace"
	}
	if action == "command" {
		request["argv"] = append([]string{"git", "--no-optional-locks"}, args...)
	} else if len(args) != 0 {
		request["path"] = args[0]
	}
	return workspaceRPCContext(context.Background(), m, request)
}

func TestLocalGitReadRPCRealSnapshotCommandsAndFilesNeverSynchronize(t *testing.T) {
	m, git := localGitReadFixture(t)
	git("branch", "中文分支")
	piWorkspaceWrite(t, m.LocalPath, "plain.txt", "changed worktree\n")
	piWorkspaceWrite(t, m.LocalPath, "staged.txt", "staged addition\n")
	git("add", "staged.txt")
	piWorkspaceWrite(t, m.LocalPath, "-中文 新文件.txt", "untracked body\n")
	index := filepath.Join(m.LocalPath, ".git", "index")
	beforeIndex, err := os.ReadFile(index)
	if err != nil {
		t.Fatal(err)
	}
	beforeInfo, _ := os.Stat(index)
	beforeRefs := git("show-ref")
	if result := localGitReadTestRPC(m, "prepare"); result["ok"] != true || result["localGitRead"] != true {
		t.Fatalf("exact bound repository unavailable: %v", result)
	}
	forms := [][]string{
		{"rev-parse", "--is-inside-work-tree"}, {"rev-parse", "--show-toplevel"}, {"rev-parse", "--verify", "HEAD"},
		{"rev-parse", "--verify", "HEAD^{commit}"}, {"rev-parse", "--abbrev-ref", "HEAD"}, {"symbolic-ref", "HEAD"}, {"symbolic-ref", "--short", "HEAD"},
		{"status", "--porcelain=v1", "-z"}, {"status", "--porcelain"}, {"status", "--porcelain", "--", "-中文 新文件.txt"},
		{"branch", "-a"}, {"remote"}, {"rev-parse", "--abbrev-ref", "main@{upstream}"},
		{"rev-list", "--count", "--left-right", "origin/main...HEAD"}, {"diff", "--", "plain.txt"},
		{"diff", "--cached", "--", "staged.txt"}, {"diff", "HEAD", "--", "plain.txt"}, {"show", "HEAD:中文 空格.txt"}, {"show", "HEAD"},
		{"log", "--branches", "--remotes", "--tags", "--topo-order", "--shortstat", localGitLogFormat, "--date=iso-strict", "-n", "10"},
	}
	for _, args := range forms {
		result := localGitReadTestRPC(m, "command", args...)
		if result["ok"] != true || result["exitCode"] != 0 || result["truncated"] != false {
			t.Fatalf("read form %v failed: %v", args, result)
		}
		out := result["stdout"].(string)
		if args[0] == "rev-parse" && args[1] == "--show-toplevel" && out != "/workspace\n" {
			t.Fatalf("native Git root leaked instead of virtual root: %q", out)
		}
		if args[0] == "rev-list" && strings.TrimSpace(out) != "0\t0" {
			t.Fatalf("local upstream status not used: %q", out)
		}
		if args[0] == "branch" && !strings.Contains(out, "中文分支") {
			t.Fatal("Unicode branch missing")
		}
	}
	if result := localGitReadTestRPC(m, "stat", "/workspace/-中文 新文件.txt"); result["ok"] != true || result["dir"] != false || result["size"] != int64(15) {
		t.Fatalf("local stat shape mismatch: %v", result)
	}
	if result := localGitReadTestRPC(m, "realpath", "/workspace/中文 空格.txt"); result["ok"] != true || result["path"] != "/workspace/中文 空格.txt" {
		t.Fatalf("local realpath not virtual: %v", result)
	}
	read := localGitReadTestRPC(m, "read", "/workspace/-中文 新文件.txt")
	data, decodeErr := base64.StdEncoding.DecodeString(stringValue(read["b64"]))
	if read["ok"] != true || decodeErr != nil || string(data) != "untracked body\n" {
		t.Fatalf("local read shape mismatch: %v", read)
	}
	afterIndex, _ := os.ReadFile(index)
	afterInfo, _ := os.Stat(index)
	if !bytes.Equal(beforeIndex, afterIndex) || !beforeInfo.ModTime().Equal(afterInfo.ModTime()) || beforeRefs != git("show-ref") {
		t.Fatal("read-only SCM changed index or refs")
	}
}

func stringValue(value any) string {
	text, _ := value.(string)
	return text
}

func TestLocalGitReadWhitelistAndRootEscape(t *testing.T) {
	m, _ := localGitReadFixture(t)
	root, err := os.OpenRoot(m.LocalPath)
	if err != nil {
		t.Fatal(err)
	}
	defer root.Close()
	for _, args := range [][]string{
		{"add", "."}, {"config", "core.hooksPath", "elsewhere"}, {"-c", "alias.status=!anything", "status"},
		{"diff", "--output=outside", "--", "plain.txt"}, {"diff", "--ext-diff", "--", "plain.txt"},
		{"diff", "--no-index", "outside", "plain.txt"}, {"diff", "--", ":(top,glob)**"},
		{"diff", "--", "../outside.txt"}, {"diff", "--", "plain.txt:stream"},
		{"show", "/outside.txt"}, {"show", "HEAD:../outside.txt"}, {"show", "HEAD:./plain.txt"},
		{"show", "--output=outside"}, {"show", "HEAD", "plain.txt"},
		{"rev-parse", "--abbrev-ref", "--bad@{upstream}"}, {"rev-list", "--count", "--left-right", "--bad...HEAD"},
		{"log", "--all"},
	} {
		if _, err := localGitReadArguments(root, ".", args); err == nil {
			t.Fatalf("unsafe native Git arguments admitted: %v", args)
		}
	}
	outside := t.TempDir()
	piWorkspaceWrite(t, outside, "private.txt", "outside contents must not be returned")
	junction := filepath.Join(m.LocalPath, "outside")
	if out, err := hideCommandWindow(exec.Command("cmd.exe", "/c", "mklink", "/J", junction, outside)).CombinedOutput(); err != nil {
		t.Fatalf("private junction fixture failed: %v %s", err, out)
	}
	for _, action := range []string{"stat", "lstat", "realpath", "read"} {
		for _, name := range []string{"/workspace/outside/private.txt", "/workspace/../private.txt", "/workspace/.chisa-bridge.json", "/workspace/plain.txt:stream"} {
			if result := localGitReadTestRPC(m, action, name); result["ok"] == true {
				t.Fatalf("%s escaped the exact local root: %v", action, result)
			}
		}
	}
	if result := localGitReadTestRPC(m, "command", "diff", "--", "outside/private.txt"); result["ok"] == true {
		t.Fatal("Git file argument followed an outside junction")
	}
	for _, key := range []string{"env", "command", "timeoutSeconds", "readOnly"} {
		result := workspaceRPCContext(context.Background(), m, map[string]any{"op": "git_read", "action": "prepare", key: "untrusted"})
		if result["code"] != "INVALID_REQUEST" {
			t.Fatalf("request option %s was accepted: %v", key, result)
		}
	}
	large, err := os.Create(filepath.Join(m.LocalPath, "large.txt"))
	if err != nil {
		t.Fatal(err)
	}
	if err := large.Truncate(localGitReadLimit + 1); err != nil {
		t.Fatal(err)
	}
	large.Close()
	if result := localGitReadTestRPC(m, "read", "/workspace/large.txt"); result["ok"] == true {
		t.Fatal("oversized local file was read")
	}
}

func TestLocalGitReadDoesNotRunExternalDiffTextconvFsmonitorOrFilters(t *testing.T) {
	m, git := localGitReadFixture(t)
	marker := filepath.Join(m.LocalPath, "helper-executed.txt")
	helper := filepath.Join(m.LocalPath, "helper.cmd")
	if err := os.WriteFile(helper, []byte("@echo off\r\necho executed>\""+marker+"\"\r\n"), 0600); err != nil {
		t.Fatal(err)
	}
	git("config", "diff.external", filepath.ToSlash(helper))
	git("config", "diff.probe.textconv", filepath.ToSlash(helper))
	git("config", "core.fsmonitor", filepath.ToSlash(helper))
	git("config", "filter.probe.clean", filepath.ToSlash(helper))
	git("config", "filter.probe.process", filepath.ToSlash(helper))
	piWorkspaceWrite(t, m.LocalPath, ".gitattributes", "plain.txt diff=probe\n")
	piWorkspaceWrite(t, m.LocalPath, "plain.txt", "changed\n")
	if result := localGitReadTestRPC(m, "prepare"); result["localGitRead"] != true {
		t.Fatalf("unused registered filter incorrectly disabled local SCM: %v", result)
	}
	if result := localGitReadTestRPC(m, "command", "diff", "--", "plain.txt"); result["ok"] != true || result["exitCode"] != 0 || !strings.Contains(stringValue(result["stdout"]), "+changed") {
		t.Fatalf("safe diff failed: %v", result)
	}
	filters, unsupported, err := localGitReadSafety(context.Background(), m.LocalPath)
	if err != nil || unsupported != "" {
		t.Fatalf("inactive helper probe failed: %q %v", unsupported, err)
	}
	piWorkspaceWrite(t, m.LocalPath, ".gitattributes", "plain.txt filter=probe\n")
	if result := localGitReadTestRPC(m, "prepare"); result["ok"] != true || result["localGitRead"] != false || result["reason"] != "external-filter" {
		t.Fatalf("active filter was not an explicit unsupported capability: %v", result)
	}
	if result := localGitReadTestRPC(m, "command", "status", "--porcelain=v1", "-z"); result["code"] != "WORKSPACE_GIT_CHANGED" {
		t.Fatalf("filter activation after prepare did not fail explicitly: %v", result)
	}
	// Known helpers remain disabled if attributes activate after the precheck.
	// Git can still return a raw-byte comparison successfully; the actual result
	// postcondition must reject it rather than exposing that as accurate status.
	output, err := runLocalGitReadInput(context.Background(), m.LocalPath, m.LocalPath, []string{"status", "--porcelain=v1", "-z"}, nil, filters)
	if err != nil || output.exitCode != 0 {
		t.Fatalf("controlled raw-comparison counterexample did not execute: %+v %v", output, err)
	}
	if err := confirmLocalGitReadResult(context.Background(), m.LocalPath, []string{"status", "--porcelain=v1", "-z"}); err == nil {
		t.Fatal("postcondition admitted a raw comparison after filter activation")
	}
	if _, err := os.Stat(marker); !os.IsNotExist(err) {
		t.Fatal("an external Git helper ran")
	}
	piWorkspaceWrite(t, m.LocalPath, ".gitattributes", "plain.txt diff=probe\n")
	head := strings.TrimSpace(git("rev-parse", "HEAD"))
	git("update-index", "--add", "--cacheinfo", "160000,"+head+",private-submodule")
	if result := localGitReadTestRPC(m, "prepare"); result["localGitRead"] != false || result["reason"] != "submodule" {
		t.Fatalf("gitlink did not preserve safe legacy routing: %v", result)
	}
}

func TestLocalGitReadBindingAccountBusyCancelAndEnvironment(t *testing.T) {
	m, _ := localGitReadFixture(t)
	t.Setenv("GIT_DIR", filepath.Join(t.TempDir(), "not-the-bound-repository"))
	t.Setenv("GIT_WORK_TREE", t.TempDir())
	t.Setenv("GIT_INDEX_FILE", filepath.Join(t.TempDir(), "wrong-index"))
	t.Setenv("GIT_CONFIG_COUNT", "1")
	t.Setenv("GIT_CONFIG_KEY_0", "alias.status")
	t.Setenv("GIT_CONFIG_VALUE_0", "!do-not-run")
	if result := localGitReadTestRPC(m, "command", "symbolic-ref", "--short", "HEAD"); result["ok"] != true || strings.TrimSpace(stringValue(result["stdout"])) != "main" {
		t.Fatalf("inherited Git environment changed the read target: %v", result)
	}
	cloudReservations.Store(m.ServerPath, "other-run")
	if result := localGitReadTestRPC(m, "prepare"); result["code"] != "WORKSPACE_BUSY" {
		t.Fatalf("cloud reservation ignored: %v", result)
	}
	cloudReservations.Delete(m.ServerPath)
	piAgents.Lock()
	piAgents.owners[m.ServerPath] = "other-pi"
	piAgents.Unlock()
	if result := localGitReadTestRPC(m, "prepare"); result["code"] != "WORKSPACE_BUSY" {
		t.Fatalf("Pi owner ignored: %v", result)
	}
	piAgents.Lock()
	delete(piAgents.owners, m.ServerPath)
	piAgents.Unlock()
	finish := beginSyncOperation(m, "syncing")
	if result := localGitReadTestRPC(m, "prepare"); result["code"] != "WORKSPACE_BUSY" {
		t.Fatalf("active sync ignored: %v", result)
	}
	finish()
	stale := *m
	stale.BindingEpoch = "old-binding"
	if result := localGitReadTestRPC(&stale, "prepare"); result["code"] != "STALE_BINDING" {
		t.Fatalf("stale epoch was admitted: %v", result)
	}
	originalID := m.ServerID
	m.ServerID = "another-account"
	if result := localGitReadTestRPC(m, "prepare"); result["code"] != "WORKSPACE_UNAVAILABLE" {
		t.Fatalf("foreign account binding admitted: %v", result)
	}
	m.ServerID = originalID
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if result := workspaceRPCContext(ctx, m, map[string]any{"op": "git_read", "action": "prepare"}); result["ok"] == true {
		t.Fatal("canceled read was admitted")
	}
	ctx, cancel = context.WithTimeout(context.Background(), time.Millisecond)
	defer cancel()
	if _, err := runLocalGitRead(ctx, m.LocalPath, m.LocalPath, []string{"status", "--porcelain=v1", "-z"}); err == nil {
		t.Fatal("real Git startup ignored caller cancellation")
	}
	apiConnection.cancel()
	if result := localGitReadTestRPC(m, "prepare"); result["ok"] == true {
		t.Fatal("closed account connection admitted a read")
	}
}

func TestLocalGitReadOutputLimitIncludesIOCopyAndRealGitPipe(t *testing.T) {
	input := strings.Repeat("x", localGitReadLimit+4096)
	var bounded localGitReadBuffer
	// Hiding WriterTo exercises io.Copy's destination-interface selection, which
	// previously reached an embedded bytes.Buffer.ReadFrom and bypassed Write.
	n, err := io.Copy(&bounded, struct{ io.Reader }{strings.NewReader(input)})
	if err != nil || n != int64(len(input)) || len(bounded.String()) != localGitReadLimit || !bounded.truncated {
		t.Fatalf("io.Copy bypassed the output bound: copied=%d bytes=%d truncated=%t error=%v", n, len(bounded.String()), bounded.truncated, err)
	}
	m, git := localGitReadFixture(t)
	piWorkspaceWrite(t, m.LocalPath, "large-output.txt", input)
	git("add", "large-output.txt")
	git("commit", "-m", "private bounded output fixture")
	result := localGitReadTestRPC(m, "command", "show", "HEAD:large-output.txt")
	if result["ok"] != true || result["exitCode"] != 0 || result["truncated"] != true || len(stringValue(result["stdout"])) != localGitReadLimit {
		t.Fatalf("real Git pipe bypassed the output bound: ok=%v exit=%v truncated=%v bytes=%d", result["ok"], result["exitCode"], result["truncated"], len(stringValue(result["stdout"])))
	}
}
