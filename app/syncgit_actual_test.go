//go:build windows && vpsqa

package main

import (
	"context"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

// Uses the installed transport and real Linux Git/Mutagen, only in a unique QA
// project. Credentials are referenced through the existing SSH identity file.
func TestGitSyncBranchesVPSActual(t *testing.T) {
	if os.Getenv("CHISA_QA_VPS") != "1" {
		t.Fatal("explicit VPS QA opt-in required")
	}
	host, key, known, root := os.Getenv("CHISA_QA_SSH_HOST"), os.Getenv("CHISA_QA_SSH_KEY"), os.Getenv("CHISA_QA_SSH_KNOWN"), os.Getenv("CHISA_QA_WORKSPACE_ROOT")
	if host == "" || key == "" || known == "" || !strings.HasPrefix(root, "/opt/") {
		t.Fatal("explicit existing SSH transport and workspace root required")
	}
	port, _ := strconv.Atoi(os.Getenv("CHISA_QA_SSH_PORT"))
	t.Setenv("APPDATA", t.TempDir())
	oldStore, oldTunnel := store, tunnel
	cfg := Config{SSHHost: host, SSHUser: "root", SSHPort: port, KeyPath: key, SSHKnownHostsPath: known, SSHHostKeyPinned: true, ServerURL: "http://sync-qa.invalid:8791"}
	local := t.TempDir()
	epoch := randHex(16)
	remote := root + "/local/git-sync-qa-" + epoch
	m := &Mapping{LocalPath: local, ServerPath: remote, BindingEpoch: epoch, ServerID: serverIdentity(cfg), Mode: "vps"}
	store = &Store{path: filepath.Join(dataDir(), "state.json"), Cfg: cfg, Mappings: []*Mapping{m}}
	tunnel = newTunnel(cfg, key, func() {})
	ctx, cancel := context.WithTimeout(context.Background(), 6*time.Minute)
	defer cancel()
	ctx = syncLeaseContext(ctx, epoch)
	command := func(s string) string {
		t.Helper()
		out, e := tunnel.ExecRemoteContext(ctx, s)
		if e != nil {
			t.Fatal(e)
		}
		return out
	}
	git := func(args ...string) string {
		t.Helper()
		out, e := gitOutputContext(ctx, local, args...)
		if e != nil {
			t.Fatal(e)
		}
		return out
	}
	command("test ! -e " + shellQuote(remote) + " && mkdir " + shellQuote(remote) + " && chown 1000:1000 " + shellQuote(remote))
	t.Cleanup(func() {
		stopSyncMonitor(false)
		if m.SyncName != "" {
			if _, e := runMutagen("sync", "terminate", m.SyncName); e != nil {
				t.Error(e)
			}
		}
		if _, e := runMutagen("daemon", "stop"); e != nil {
			t.Error(e)
		}
		if remote != root+"/local/git-sync-qa-"+epoch {
			t.Fatal("invalid cleanup target")
		}
		if _, e := tunnel.ExecRemote("test \"$(readlink -f -- " + shellQuote(remote) + ")\" = " + shellQuote(remote) + " && rm -rf -- " + shellQuote(remote) + " " + shellQuote(remote+".chisa-lease")); e != nil {
			t.Error(e)
		}
		store, tunnel = oldStore, oldTunnel
	})
	if _, e := remoteLeaseContext(ctx, m, "claim", "sync", epoch); e != nil {
		t.Fatal(e)
	}
	git("init", "-b", "main")
	git("config", "user.name", "QA")
	git("config", "user.email", "qa@localhost")
	git("config", "core.autocrlf", "false")
	write := func(name, body string) {
		t.Helper()
		if e := os.WriteFile(filepath.Join(local, name), []byte(body), 0600); e != nil {
			t.Fatal(e)
		}
	}
	write("file.txt", "base\n")
	git("add", ".")
	git("commit", "-m", "base")
	base := git("rev-parse", "HEAD")
	write("file.txt", "local commit\n")
	git("add", ".")
	git("commit", "-m", "local branch commit")
	main := git("rev-parse", "HEAD")
	sync := func(phase string) {
		t.Helper()
		if e := syncProjectContentsContext(ctx, m, true); e != nil {
			t.Fatalf("%s: %v", phase, e)
		}
		l, e := readLocalGitState(ctx, m)
		if e != nil {
			t.Fatal(e)
		}
		r, e := readRemoteGitState(ctx, m)
		if e != nil || l != r {
			t.Fatalf("%s mismatched Git: local=%+v remote=%+v err=%v", phase, l, r, e)
		}
		t.Log(phase, "branch", l.Branch, "HEAD", l.Head)
	}
	sync("initial")
	command("printf 'interrupted owned lock' > " + shellQuote(remote+"/.git/index.chisa-owned") + " && chown 1000:1000 " + shellQuote(remote+"/.git/index.chisa-owned") + " && ln " + shellQuote(remote+"/.git/index.chisa-owned") + " " + shellQuote(remote+"/.git/index.lock"))
	if _, e := readRemoteGitState(ctx, m); e != nil {
		t.Fatal("owned Linux index lock did not recover", e)
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
	if b, e := os.ReadFile(filepath.Join(local, "build", "source.txt")); e != nil || string(b) != "new tracked source\n" {
		t.Fatal("new branch tracked generated-directory source missing", e)
	}
	if _, e := os.Stat(filepath.Join(local, "build", "generated.txt")); !os.IsNotExist(e) {
		t.Fatal("generated runtime unexpectedly synchronized", e)
	}
	for name, want := range map[string]string{"file.txt": "unstaged cloud\n", "untracked.txt": "keep untracked\n"} {
		b, _ := os.ReadFile(filepath.Join(local, name))
		if string(b) != want {
			t.Fatalf("file %s not delivered: %q", name, b)
		}
	}
	// Reverse direction includes a new branch name at the same commit.
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
	// New edits on both sides must fail rather than picking an arbitrary winner.
	git("checkout", "-b", "local/concurrent")
	command(serverGit(m, "checkout", "-b", "remote/concurrent"))
	if e := syncProjectContentsContext(ctx, m, true); e == nil || !strings.Contains(e.Error(), "两端") {
		t.Fatal("concurrent changes not protected", e)
	}
	if git("branch", "--show-current") != "local/concurrent" || command(serverGit(m, "branch", "--show-current")) != "remote/concurrent" {
		t.Fatal("conflict changed branch")
	}
	t.Log("real two-sided conflict retained both branches and files")
}
