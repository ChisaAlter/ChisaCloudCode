package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"testing"
	"time"
)

// The embedded worker, subprocesses, Git transport, reference updates and
// connectivity checks run for real. The account shim lets Windows and ordinary
// unprivileged Linux tests execute them; optional hooks interrupt only after a
// real metadata operation succeeds, before the worker can save the new state.
const syncSeedPythonBootstrap = `import os, subprocess, sys
real_run = subprocess.run
mode = sys.argv[2] if len(sys.argv) > 2 else ''
account_prefix = ['setpriv', '--reuid=1000', '--regid=1000', '--clear-groups', 'env', 'HOME=/nonexistent']
def run(args, *positional, **keyword):
    account = isinstance(args, list) and args and args[0] == 'setpriv'
    if account:
        assert args[:len(account_prefix)] == account_prefix, args
        args = args[len(account_prefix):]
    result = real_run(args, *positional, **keyword)
    if account and result.returncode == 0:
        command = args[args.index('-C') + 2:]
        head = command[:2] == ['symbolic-ref', 'HEAD'] or command[:3] == ['update-ref', '--no-deref', 'HEAD']
        reset = command[:2] == ['reset', '--mixed']
        if (mode == 'interrupt-after-head' and head) or (mode == 'interrupt-after-reset' and reset):
            raise SystemExit(124)
    return result
subprocess.run = run
os.chown = lambda *args, **kwargs: None
if mode == 'interrupt-after-install':
    real_rename = os.rename
    def rename(source, destination, *args, **kwargs):
        real_rename(source, destination, *args, **kwargs)
        if os.path.basename(os.fspath(source)) == '.git' and os.path.basename(os.fspath(destination)) == '.git':
            raise SystemExit(124)
    os.rename = rename
exec(compile(sys.argv[1], 'embedded-sync-git-seed.py', 'exec'), {'__name__': '__main__'})
`

type syncSeedTestTools struct {
	git, python string
	env         []string
}

func syncSeedTools(t *testing.T) *syncSeedTestTools {
	t.Helper()
	git, err := exec.LookPath("git")
	if err != nil {
		t.Skip("Git is required for the embedded seed worker regression")
	}
	tools := &syncSeedTestTools{git: git}
	for _, entry := range os.Environ() {
		name := strings.ToUpper(strings.SplitN(entry, "=", 2)[0])
		if strings.HasPrefix(name, "GIT_") || name == "LC_ALL" || name == "LANG" || name == "PYTHONUTF8" {
			continue
		}
		tools.env = append(tools.env, entry)
	}
	configuration := t.TempDir()
	template := filepath.Join(configuration, "empty-template")
	if err := os.Mkdir(template, 0700); err != nil {
		t.Fatal(err)
	}
	tools.env = append(tools.env,
		"GIT_CONFIG_NOSYSTEM=1", "GIT_CONFIG_GLOBAL="+filepath.Join(configuration, "no-global-config"),
		"GIT_TEMPLATE_DIR="+template, "GIT_TERMINAL_PROMPT=0", "GIT_ALLOW_PROTOCOL=file",
		"GIT_AUTHOR_NAME=Seed regression", "GIT_AUTHOR_EMAIL=seed@localhost",
		"GIT_COMMITTER_NAME=Seed regression", "GIT_COMMITTER_EMAIL=seed@localhost",
		"LC_ALL=C", "LANG=C", "PYTHONUTF8=1")
	for _, candidate := range []string{os.Getenv("CHISA_QA_PYTHON_PATH"), "python3", "python"} {
		if candidate == "" {
			continue
		}
		python, err := exec.LookPath(candidate)
		if err != nil {
			continue
		}
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		cmd := exec.CommandContext(ctx, python, "-c", "import sys; assert sys.version_info >= (3, 11)")
		cmd.Env = tools.env
		err = cmd.Run()
		cancel()
		if err == nil {
			tools.python = python
			return tools
		}
	}
	t.Skip("Python 3.11+ is required by the embedded seed worker; set CHISA_QA_PYTHON_PATH or install python3/python on PATH")
	return nil
}

func (tools *syncSeedTestTools) command(t *testing.T, input []byte, executable string, args ...string) (string, string, error) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, executable, args...)
	cmd.Env = tools.env
	cmd.Stdin = bytes.NewReader(input)
	var stdout, stderr bytes.Buffer
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	err := cmd.Run()
	if ctx.Err() != nil {
		t.Fatalf("command timed out: %s %q: %v", executable, args, ctx.Err())
	}
	return stdout.String(), stderr.String(), err
}

func (tools *syncSeedTestTools) gitInput(t *testing.T, directory string, input []byte, args ...string) string {
	t.Helper()
	arguments := append([]string{"-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-C", directory}, args...)
	stdout, stderr, err := tools.command(t, input, tools.git, arguments...)
	if err != nil {
		t.Fatalf("git %q failed: %v\n%s\n%s", args, err, stdout, stderr)
	}
	return strings.TrimSpace(stdout)
}

func (tools *syncSeedTestTools) gitRun(t *testing.T, directory string, args ...string) string {
	t.Helper()
	return tools.gitInput(t, directory, nil, args...)
}

func syncSeedWrite(t *testing.T, root, name, contents string) {
	t.Helper()
	path := filepath.Join(root, filepath.FromSlash(name))
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(contents), 0600); err != nil {
		t.Fatal(err)
	}
}

func syncSeedSnapshot(t *testing.T, root string, skipGit bool) map[string]string {
	t.Helper()
	files := map[string]string{}
	err := filepath.WalkDir(root, func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		relative, err := filepath.Rel(root, path)
		if err != nil {
			return err
		}
		if relative == "." {
			return nil
		}
		if skipGit && relative == ".git" {
			return filepath.SkipDir
		}
		if entry.IsDir() {
			files[filepath.ToSlash(relative)+"/"] = ""
			return nil
		}
		contents, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		files[filepath.ToSlash(relative)] = string(contents)
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	return files
}

func (tools *syncSeedTestTools) orphanRef(t *testing.T, repository, ref, label string) string {
	t.Helper()
	blob := tools.gitInput(t, repository, []byte(label+" unique object\n"), "hash-object", "-w", "--stdin")
	tree := tools.gitInput(t, repository, []byte("100644 blob "+blob+"\t"+label+".txt\n"), "mktree")
	commit := tools.gitInput(t, repository, []byte(label+" unique commit\n"), "commit-tree", tree)
	tools.gitRun(t, repository, "update-ref", ref, commit)
	return commit
}

func (tools *syncSeedTestTools) fixture(t *testing.T, objectFormat string, shallow bool) string {
	t.Helper()
	base := t.TempDir()
	upstream := filepath.Join(base, "upstream")
	if err := os.Mkdir(upstream, 0700); err != nil {
		t.Fatal(err)
	}
	stdout, stderr, err := tools.command(t, nil, tools.git, "-C", upstream, "init", "--object-format="+objectFormat, "-b", "main")
	if err != nil {
		if objectFormat == "sha256" && (strings.Contains(stderr, "unknown option") || strings.Contains(stderr, "unknown hash") || strings.Contains(stderr, "unsupported")) {
			t.Skipf("Git does not support SHA-256 repositories: %s", stderr)
		}
		t.Fatalf("init %s fixture: %v\n%s\n%s", objectFormat, err, stdout, stderr)
	}
	tools.gitRun(t, upstream, "config", "core.autocrlf", "false")
	for n := 0; n < 4; n++ {
		syncSeedWrite(t, upstream, "tracked.txt", fmt.Sprintf("main commit %d\n", n))
		syncSeedWrite(t, upstream, "deleted.txt", "this tracked deletion must stay deleted\n")
		tools.gitRun(t, upstream, "add", ".")
		tools.gitRun(t, upstream, "commit", "-m", fmt.Sprintf("main-%d", n))
	}
	source := upstream
	if shallow {
		source = filepath.Join(base, "shallow source")
		tools.gitRun(t, base, "clone", "--no-local", "--depth=2", "--no-tags", "--single-branch", "--branch", "main", upstream, source)
		tools.gitRun(t, source, "remote", "remove", "origin")
		tools.gitRun(t, source, "config", "core.autocrlf", "false")
		if got := tools.gitRun(t, source, "rev-list", "--count", "HEAD"); got != "2" {
			t.Fatalf("fixture is not genuinely shallow: got %s main commits, want 2", got)
		}
		missing := tools.gitRun(t, upstream, "rev-parse", "HEAD~2")
		_, _, err := tools.command(t, nil, tools.git, "-C", source, "cat-file", "-e", missing+"^{commit}")
		if err == nil {
			t.Fatal("shallow fixture unexpectedly contains the missing ancestor")
		}
	}
	tools.gitRun(t, source, "branch", "feature", "HEAD~1")
	tools.gitRun(t, source, "tag", "-a", "v1", "-m", "annotated tag", "HEAD~1")
	tools.orphanRef(t, source, "refs/archive/only", "archive")
	tools.orphanRef(t, source, "refs/remotes/custom/only", "custom")
	// This source has no origin configuration. Removing a temporary bundle
	// remote must still preserve the source's real refs/remotes/origin/* refs.
	tools.orphanRef(t, source, "refs/remotes/origin/preserved", "origin")
	syncSeedWrite(t, source, "tracked.txt", "stash-only contents\n")
	tools.gitRun(t, source, "stash", "push", "-m", "unique stash")
	ordinary := "\n" + tools.gitRun(t, source, "rev-list", "--branches", "--tags") + "\n"
	for _, ref := range []string{"refs/archive/only", "refs/stash", "refs/remotes/custom/only", "refs/remotes/origin/preserved"} {
		commit := tools.gitRun(t, source, "rev-parse", ref+"^{commit}")
		if strings.Contains(ordinary, "\n"+commit+"\n") {
			t.Fatalf("fixture %s does not provide a uniquely reachable commit", ref)
		}
	}
	// Stage one version and deliver another. Seeding must leave the delivered
	// worktree bytes alone while initializing its index from the requested HEAD.
	syncSeedWrite(t, source, "tracked.txt", "staged source version\n")
	syncSeedWrite(t, source, "staged-only.txt", "staged new file\n")
	tools.gitRun(t, source, "add", "tracked.txt", "staged-only.txt")
	syncSeedWrite(t, source, "tracked.txt", "unstaged source version\r\nsecond line\n")
	syncSeedWrite(t, source, "nested/untracked.bin", "untracked\x00bytes\n")
	syncSeedWrite(t, source, ".chisa-bridge.json", "{\"fixture\":true}\n")
	if err := os.Remove(filepath.Join(source, "deleted.txt")); err != nil {
		t.Fatal(err)
	}
	if tools.gitRun(t, source, "write-tree") == tools.gitRun(t, source, "rev-parse", "HEAD^{tree}") {
		t.Fatal("fixture has no staged changes")
	}
	return source
}

func (tools *syncSeedTestTools) request(t *testing.T, source, root string) map[string]any {
	t.Helper()
	branch, stderr, err := tools.command(t, nil, tools.git, "-C", source, "symbolic-ref", "--quiet", "HEAD")
	if err != nil {
		if exit, ok := err.(*exec.ExitError); !ok || exit.ExitCode() != 1 {
			t.Fatalf("read source branch: %v: %s", err, stderr)
		}
	}
	shallowPath := tools.gitRun(t, source, "rev-parse", "--path-format=absolute", "--git-path", "shallow")
	shallow, err := os.ReadFile(shallowPath)
	if err != nil && !os.IsNotExist(err) {
		t.Fatal(err)
	}
	return map[string]any{
		"root": root, "epoch": "seed-regression-binding", "head": tools.gitRun(t, source, "rev-parse", "HEAD"),
		"branch": strings.TrimSpace(branch), "origin": "", "shallow": string(shallow),
		"objectFormat": tools.gitRun(t, source, "rev-parse", "--show-object-format"),
	}
}

func (tools *syncSeedTestTools) bundle(t *testing.T, source, root string, request map[string]any) {
	t.Helper()
	// Stale shallow boundaries can have no refs pointing at them. They must
	// still be packed because the destination receives the complete shallow file.
	args := []string{"bundle", "create", root + ".bundle", "--all"}
	args = append(args, strings.Fields(request["shallow"].(string))...)
	tools.gitRun(t, source, args...)
}

func (tools *syncSeedTestTools) worker(t *testing.T, request map[string]any, mode ...string) (string, string, error) {
	t.Helper()
	input, err := json.Marshal(request)
	if err != nil {
		t.Fatal(err)
	}
	args := append([]string{"-c", syncSeedPythonBootstrap, syncGitSeedWorker}, mode...)
	return tools.command(t, input, tools.python, args...)
}

func (tools *syncSeedTestTools) runWorker(t *testing.T, request map[string]any) {
	t.Helper()
	stdout, stderr, err := tools.worker(t, request)
	if err != nil {
		t.Fatalf("embedded Git seed worker failed: %v\nstdout: %s\nstderr: %s", err, stdout, stderr)
	}
	var result struct {
		OK bool `json:"ok"`
	}
	if err := json.Unmarshal([]byte(stdout), &result); err != nil || !result.OK {
		t.Fatalf("unexpected worker response %q: %v", stdout, err)
	}
}

func syncSeedSortedLines(value string) []string {
	lines := strings.Fields(value)
	sort.Strings(lines)
	return lines
}

func (tools *syncSeedTestTools) assertReplica(t *testing.T, source, root string, request map[string]any, worktree map[string]string) {
	t.Helper()
	manifest := tools.gitRun(t, source, "for-each-ref", "--format=%(refname) %(objectname)")
	if got := tools.gitRun(t, root, "for-each-ref", "--format=%(refname) %(objectname)"); got != manifest {
		t.Fatalf("reference manifest changed (including invented origin refs):\nwant:\n%s\ngot:\n%s", manifest, got)
	}
	for _, args := range [][]string{{"rev-list", "--all", "HEAD"}, {"rev-list", "--objects", "--no-object-names", "--all", "HEAD"}} {
		want := syncSeedSortedLines(tools.gitRun(t, source, args...))
		got := syncSeedSortedLines(tools.gitRun(t, root, args...))
		if !reflect.DeepEqual(got, want) {
			t.Fatalf("reachable commit/object set differs for %q:\nwant %v\ngot %v", args, want, got)
		}
	}
	tools.gitRun(t, root, "fsck", "--connectivity-only", "--no-dangling")
	if got := tools.gitRun(t, root, "rev-parse", "HEAD"); got != request["head"] {
		t.Fatalf("HEAD = %s, want %s", got, request["head"])
	}
	head, err := os.ReadFile(filepath.Join(root, ".git", "HEAD"))
	if err != nil {
		t.Fatal(err)
	}
	wantHead := request["head"].(string)
	if branch := request["branch"].(string); branch != "" {
		wantHead = "ref: " + branch
	}
	if strings.TrimSpace(string(head)) != wantHead {
		t.Fatalf("HEAD attachment = %q, want %q", head, wantHead)
	}
	if got, want := tools.gitRun(t, root, "write-tree"), tools.gitRun(t, source, "rev-parse", "HEAD^{tree}"); got != want {
		t.Fatalf("seed index tree = %s, want HEAD tree %s", got, want)
	}
	if got := tools.gitRun(t, root, "rev-parse", "--show-object-format"); got != request["objectFormat"] {
		t.Fatalf("object format = %s, want %s", got, request["objectFormat"])
	}
	shallow, err := os.ReadFile(filepath.Join(root, ".git", "shallow"))
	if err != nil && !os.IsNotExist(err) {
		t.Fatal(err)
	}
	// Python's text files use CRLF on Windows; Git treats both newline forms
	// identically. Compare the complete boundary list without changing worker IO.
	if got, want := strings.Fields(string(shallow)), strings.Fields(request["shallow"].(string)); !reflect.DeepEqual(got, want) {
		t.Fatalf("shallow boundary = %q, want %q", shallow, request["shallow"])
	}
	if got := tools.gitRun(t, root, "rev-parse", "--is-shallow-repository"); got != fmt.Sprint(request["shallow"] != "") {
		t.Fatalf("shallow repository flag = %s", got)
	}
	if got := syncSeedSnapshot(t, root, true); !reflect.DeepEqual(got, worktree) {
		t.Fatalf("delivered worktree changed:\nwant %#v\ngot %#v", worktree, got)
	}
	if got := tools.gitRun(t, root, "remote"); got != "" {
		t.Fatalf("temporary bundle remote survived: %s", got)
	}
	for _, path := range []string{root + ".bundle", root + ".chisa-git-seed.json", root + ".git-seed"} {
		if _, err := os.Lstat(path); !os.IsNotExist(err) {
			t.Fatalf("successful seed left temporary path %s: %v", path, err)
		}
	}
	if matches, err := filepath.Glob(filepath.Join(root, ".git", "shallow.chisa-*")); err != nil || len(matches) != 0 {
		t.Fatalf("temporary shallow metadata survived: %v, %v", matches, err)
	}
}

func (tools *syncSeedTestTools) installedJournal(t *testing.T, request map[string]any) {
	t.Helper()
	// Use Python's actual device/inode values, including on Windows. This is
	// the journal state after .git installation but before final cleanup.
	const prepare = `import json, pathlib, sys
q = json.load(sys.stdin)
root = pathlib.Path(q['root'])
seed = pathlib.Path(str(root) + '.git-seed')
seed.mkdir()
allocation = seed.stat(follow_symlinks=False)
metadata = (root / '.git').stat(follow_symlinks=False)
record = {'root': str(root), 'epoch': q['epoch'], 'source': str(root) + '.bundle',
          'device': metadata.st_dev, 'inode': metadata.st_ino,
          'seedDevice': allocation.st_dev, 'seedInode': allocation.st_ino,
          'seedGitDevice': metadata.st_dev, 'seedGitInode': metadata.st_ino}
pathlib.Path(str(root) + '.chisa-git-seed.json').write_text(json.dumps(record))
`
	input, err := json.Marshal(request)
	if err != nil {
		t.Fatal(err)
	}
	stdout, stderr, err := tools.command(t, input, tools.python, "-c", prepare)
	if err != nil {
		t.Fatalf("prepare owned installed journal: %v\n%s\n%s", err, stdout, stderr)
	}
}

func TestSyncGitSeedWorkerAllRefs(t *testing.T) {
	tools := syncSeedTools(t)
	for _, test := range []struct {
		name, objectFormat string
		shallow            bool
	}{{"full", "sha1", false}, {"shallow", "sha1", true}, {"sha256", "sha256", false}} {
		t.Run(test.name, func(t *testing.T) {
			source := tools.fixture(t, test.objectFormat, test.shallow)
			sourceWorktree := syncSeedSnapshot(t, source, true)
			sourceIndex := tools.gitRun(t, source, "write-tree")
			root := filepath.Join(t.TempDir(), "replica with spaces")
			for name, contents := range sourceWorktree {
				if !strings.HasSuffix(name, "/") {
					syncSeedWrite(t, root, name, contents)
				}
			}
			request := tools.request(t, source, root)
			if test.shallow && request["shallow"] == "" {
				t.Fatal("shallow fixture supplied no actual boundary")
			}
			tools.bundle(t, source, root, request)
			tools.runWorker(t, request)
			tools.assertReplica(t, source, root, request, sourceWorktree)

			// An installed but unfinished owned journal must fetch all refs again.
			// Both a new custom ref and a forced update need new, unique objects;
			// merely accepting the old installed HEAD cannot satisfy this retry.
			tools.orphanRef(t, source, "refs/archive/resume-only", "resume-new")
			tools.orphanRef(t, source, "refs/archive/only", "resume-force")
			tools.orphanRef(t, source, "refs/remotes/custom/only", "resume-remote")
			head := tools.gitRun(t, source, "rev-parse", "HEAD")
			tools.gitRun(t, source, "update-ref", "--no-deref", "HEAD", head)
			request = tools.request(t, source, root)
			tools.bundle(t, source, root, request)
			tools.installedJournal(t, request)
			tools.runWorker(t, request)
			tools.assertReplica(t, source, root, request, sourceWorktree)
			if got := tools.gitRun(t, source, "write-tree"); got != sourceIndex {
				t.Fatalf("source staged index changed: %s -> %s", sourceIndex, got)
			}
			if got := syncSeedSnapshot(t, source, true); !reflect.DeepEqual(got, sourceWorktree) {
				t.Fatal("source worktree changed during seeding or resume")
			}
		})
	}
}

func TestSyncGitSeedWorkerInstalledState(t *testing.T) {
	tools := syncSeedTools(t)
	source := tools.fixture(t, "sha1", false)
	worktree := syncSeedSnapshot(t, source, true)
	for _, window := range []struct {
		name, mode string
		detached   bool
	}{
		{"install", "interrupt-after-install", false},
		{"symbolic-HEAD", "interrupt-after-head", false},
		{"detached-HEAD", "interrupt-after-head", true},
		{"mixed-reset", "interrupt-after-reset", false},
	} {
		for _, change := range []string{"unchanged", "HEAD", "index"} {
			t.Run(window.name+"/"+change, func(t *testing.T) {
				root := filepath.Join(t.TempDir(), "interrupted replica")
				for name, contents := range worktree {
					if !strings.HasSuffix(name, "/") {
						syncSeedWrite(t, root, name, contents)
					}
				}
				request := tools.request(t, source, root)
				if window.detached {
					request["branch"] = ""
				}
				tools.bundle(t, source, root, request)
				bundle, err := os.ReadFile(root + ".bundle")
				if err != nil {
					t.Fatal(err)
				}
				stdout, stderr, err := tools.worker(t, request, window.mode)
				if exit, ok := err.(*exec.ExitError); !ok || exit.ExitCode() != 124 {
					t.Fatalf("worker did not interrupt immediately after %s: %v\n%s\n%s", window.name, err, stdout, stderr)
				}
				journal, err := os.ReadFile(root + ".chisa-git-seed.json")
				if err != nil {
					t.Fatal(err)
				}
				var record struct {
					RefsImported string            `json:"refsImported"`
					State        map[string]string `json:"state"`
				}
				if err := json.Unmarshal(journal, &record); err != nil {
					t.Fatal(err)
				}
				if record.RefsImported == "" || record.State["HEAD"] == "" {
					t.Fatalf("interruption did not preserve the worker's authentic fingerprint/state journal: %s", journal)
				}
				switch change {
				case "unchanged":
					tools.runWorker(t, request)
					tools.assertReplica(t, source, root, request, worktree)
					return
				case "HEAD":
					tools.gitRun(t, root, "symbolic-ref", "HEAD", "refs/heads/feature")
				case "index":
					// This creates an index before reset or modifies the existing
					// one afterward. Neither state belongs to the pending seed.
					tools.gitRun(t, root, "read-tree", "refs/heads/feature")
				}
				before := syncSeedSnapshot(t, root, false)
				stdout, stderr, err = tools.worker(t, request)
				if exit, ok := err.(*exec.ExitError); !ok || exit.ExitCode() != 125 || !strings.Contains(stderr, "preserved") {
					t.Fatalf("edited installed %s was not rejected after %s: %v\n%s\n%s", change, window.name, err, stdout, stderr)
				}
				if got := syncSeedSnapshot(t, root, false); !reflect.DeepEqual(got, before) {
					t.Fatalf("rejected resume after %s overwrote edited %s or another Git/worktree file", window.name, change)
				}
				if got, err := os.ReadFile(root + ".bundle"); err != nil || !bytes.Equal(got, bundle) {
					t.Fatalf("same-fingerprint bundle changed during rejection: %v", err)
				}
				if _, err := os.Stat(root + ".chisa-git-seed.json"); err != nil {
					t.Fatalf("rejection removed the resumable journal: %v", err)
				}
			})
		}
	}
}

func TestSyncGitSeedWorkerUnreferencedShallowBoundary(t *testing.T) {
	tools := syncSeedTools(t)
	source := tools.fixture(t, "sha1", true)
	boundary := tools.orphanRef(t, source, "refs/archive/temporary-boundary", "stale-boundary")
	tools.gitRun(t, source, "update-ref", "-d", "refs/archive/temporary-boundary")
	shallowPath := tools.gitRun(t, source, "rev-parse", "--path-format=absolute", "--git-path", "shallow")
	shallow, err := os.ReadFile(shallowPath)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(shallowPath, append(shallow, []byte(boundary+"\n")...), 0600); err != nil {
		t.Fatal(err)
	}
	tools.gitRun(t, source, "cat-file", "-e", boundary+"^{commit}")
	if reachable := "\n" + tools.gitRun(t, source, "rev-list", "--all", "HEAD") + "\n"; strings.Contains(reachable, "\n"+boundary+"\n") {
		t.Fatal("stale boundary is unexpectedly reachable through a source ref")
	}
	worktree := syncSeedSnapshot(t, source, true)
	root := filepath.Join(t.TempDir(), "stale-boundary replica")
	for name, contents := range worktree {
		if !strings.HasSuffix(name, "/") {
			syncSeedWrite(t, root, name, contents)
		}
	}
	request := tools.request(t, source, root)
	tools.bundle(t, source, root, request)

	// Supplement an existing object store without updating any of its refs.
	// An ordinary --all bundle reproduces the old missing-boundary contents.
	repair := filepath.Join(t.TempDir(), "existing replica")
	if err := os.Mkdir(repair, 0700); err != nil {
		t.Fatal(err)
	}
	tools.gitRun(t, repair, "init", "-b", "main")
	syncSeedWrite(t, repair, ".git/shallow", request["shallow"].(string))
	ordinaryBundle := repair + ".bundle"
	tools.gitRun(t, source, "bundle", "create", ordinaryBundle, "--all")
	tools.gitRun(t, repair, "bundle", "unbundle", ordinaryBundle)
	for _, line := range strings.Split(tools.gitRun(t, source, "for-each-ref", "--format=%(objectname) %(refname)"), "\n") {
		parts := strings.Fields(line)
		tools.gitRun(t, repair, "update-ref", parts[1], parts[0])
	}
	_, _, missing := tools.command(t, nil, tools.git, "-C", repair, "cat-file", "-e", boundary+"^{commit}")
	if missing == nil {
		t.Fatal("ordinary --all bundle unexpectedly included the unreferenced boundary")
	}
	before := tools.gitRun(t, repair, "for-each-ref", "--format=%(refname) %(objectname)")
	tools.gitRun(t, repair, "bundle", "unbundle", root+".bundle")
	tools.gitRun(t, repair, "cat-file", "-e", boundary+"^{commit}")
	tools.gitRun(t, repair, "fsck", "--connectivity-only", "--no-dangling")
	if got := tools.gitRun(t, repair, "for-each-ref", "--format=%(refname) %(objectname)"); got != before {
		t.Fatalf("supplementary unbundle changed refs:\nwant %s\ngot %s", before, got)
	}
	t.Log("git bundle unbundle <enhanced-bundle> repairs the missing boundary object without changing refs")
	for _, line := range strings.Split(tools.gitRun(t, source, "bundle", "list-heads", root+".bundle"), "\n") {
		if strings.HasPrefix(line, boundary+" ") {
			t.Fatalf("raw shallow revision unexpectedly became an advertised ref: %q", line)
		}
	}
	tools.runWorker(t, request)
	tools.assertReplica(t, source, root, request, worktree)
	tools.gitRun(t, root, "cat-file", "-e", boundary+"^{commit}")
	t.Logf("bundle create <bundle> --all %s packs the unreferenced boundary without advertising a ref", strings.Join(strings.Fields(request["shallow"].(string)), " "))
}

func TestSyncGitSeedWorkerDetachedWithoutRefs(t *testing.T) {
	tools := syncSeedTools(t)
	source := tools.fixture(t, "sha1", false)
	head := tools.gitRun(t, source, "rev-parse", "HEAD")
	tools.gitRun(t, source, "update-ref", "--no-deref", "HEAD", head)
	for _, ref := range strings.Fields(tools.gitRun(t, source, "for-each-ref", "--format=%(refname)")) {
		tools.gitRun(t, source, "update-ref", "-d", ref)
	}
	if got := tools.gitRun(t, source, "for-each-ref"); got != "" {
		t.Fatalf("detached-only fixture still has refs: %s", got)
	}
	worktree := syncSeedSnapshot(t, source, true)
	root := filepath.Join(t.TempDir(), "detached-only replica")
	for name, contents := range worktree {
		if !strings.HasSuffix(name, "/") {
			syncSeedWrite(t, root, name, contents)
		}
	}
	request := tools.request(t, source, root)
	tools.bundle(t, source, root, request)
	if got := tools.gitRun(t, source, "bundle", "list-heads", root+".bundle"); got != head+" HEAD" {
		t.Fatalf("expected bundle advertising only detached HEAD, got %q", got)
	}
	tools.runWorker(t, request)
	tools.assertReplica(t, source, root, request, worktree)

	// A new parentless commit advertised solely as HEAD also needs fetching
	// when the destination already contains owned installed Git metadata.
	next := tools.orphanRef(t, source, "refs/archive/temporary", "detached-resume")
	tools.gitRun(t, source, "update-ref", "--no-deref", "HEAD", next)
	tools.gitRun(t, source, "update-ref", "-d", "refs/archive/temporary")
	request = tools.request(t, source, root)
	tools.bundle(t, source, root, request)
	if got := tools.gitRun(t, source, "bundle", "list-heads", root+".bundle"); got != next+" HEAD" {
		t.Fatalf("retry bundle must advertise only detached HEAD, got %q", got)
	}
	tools.installedJournal(t, request)
	tools.runWorker(t, request)
	tools.assertReplica(t, source, root, request, worktree)
}

func TestSyncGitSeedWorkerRejectsUnknownDestination(t *testing.T) {
	tools := syncSeedTools(t)
	source := tools.fixture(t, "sha1", false)
	root := filepath.Join(t.TempDir(), "independent destination")
	syncSeedWrite(t, root, "independent.txt", "independent committed contents\n")
	tools.gitRun(t, root, "init", "-b", "unrelated")
	tools.gitRun(t, root, "add", ".")
	tools.gitRun(t, root, "commit", "-m", "independent history")
	syncSeedWrite(t, root, "independent.txt", "independent staged contents\n")
	tools.gitRun(t, root, "add", "independent.txt")
	syncSeedWrite(t, root, "independent.txt", "independent unstaged contents\n")
	syncSeedWrite(t, root, "untracked.txt", "keep this too\n")
	request := tools.request(t, source, root)
	tools.bundle(t, source, root, request)
	before := syncSeedSnapshot(t, root, false)
	bundle, err := os.ReadFile(root + ".bundle")
	if err != nil {
		t.Fatal(err)
	}
	stdout, stderr, err := tools.worker(t, request)
	if exit, ok := err.(*exec.ExitError); !ok || exit.ExitCode() != 125 || !strings.Contains(stderr, "Git metadata already exists") {
		t.Fatalf("unknown destination was not rejected: %v\nstdout: %s\nstderr: %s", err, stdout, stderr)
	}
	if got := syncSeedSnapshot(t, root, false); !reflect.DeepEqual(got, before) {
		t.Fatal("unknown destination Git metadata/index/worktree was modified")
	}
	if got, err := os.ReadFile(root + ".bundle"); err != nil || !bytes.Equal(got, bundle) {
		t.Fatalf("rejected seed consumed or modified the bundle: %v", err)
	}
	for _, path := range []string{root + ".chisa-git-seed.json", root + ".git-seed"} {
		if _, err := os.Lstat(path); !os.IsNotExist(err) {
			t.Fatalf("rejected seed created %s: %v", path, err)
		}
	}
}
