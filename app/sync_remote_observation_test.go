package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"os/exec"
	"strings"
	"sync"
	"testing"
	"time"
)

// All filesystem/Git/inotify calls below are real. No fake event backend hides
// registration races or the kernel's synchronous delivery before a query.
const syncObservePythonTests = `import hashlib, json, os, pathlib, shutil, subprocess, sys
q = json.load(sys.stdin)
ns = {'__name__': 'sync_observe_test'}
exec(compile(q['worker'], '<sync-observe-test>', 'exec'), ns)
root = pathlib.Path(q['root'])
root.mkdir(exist_ok=True)
def git(*args, directory=root):
    p = subprocess.run(['git', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-C', str(directory), *args], capture_output=True)
    assert p.returncode == 0, p.stderr
    return p.stdout.strip().decode()
def write(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(data)
def snap(directory):
    return {str(p.relative_to(directory)): ('dir' if p.is_dir() else hashlib.sha256(p.read_bytes()).hexdigest())
            for p in directory.rglob('*') if not p.is_symlink()}
def fails(call, text):
    try: call()
    except ns['ObservationError'] as e: assert text in str(e), str(e)
    else: raise AssertionError('observation unexpectedly succeeded: ' + text)
git('init', '-b', 'main')
git('config', 'user.name', 'Observer test')
git('config', 'user.email', 'observer@localhost')
git('config', 'core.autocrlf', 'false')
write(root / 'tracked.txt', 'base\n')
git('add', '.')
git('commit', '-m', 'base')
metadata = root / '.git'
fingerprint = ns['fingerprint']
if q['scenario'] == 'metadata':
    before = snap(root)
    first = fingerprint(str(root))
    assert first['repository']
    assert fingerprint(str(root))['git'] == first['git']
    assert snap(root) == before, 'observer wrote repository metadata'
    write(root / 'tracked.txt', 'ordinary content\n')
    write(root / 'untracked.txt', 'new content\n')
    assert fingerprint(str(root))['git'] == first['git'], 'Git digest depends on worktree content'
    # No subprocess is available to the observer even on its first metadata read.
    real_run = subprocess.run
    subprocess.run = lambda *args, **kw: (_ for _ in ()).throw(AssertionError('observer ran a subprocess'))
    assert fingerprint(str(root))['git'] == first['git']
    subprocess.run = real_run
    oid = git('rev-parse', 'HEAD')
    write(metadata / 'FETCH_HEAD', oid + '\n')
    write(metadata / 'refs/chisa/recovery/private', oid + '\n')
    assert fingerprint(str(root))['git'] == first['git'], 'private transfer metadata invalidated token'
    packed = metadata / 'packed-refs'
    write(packed, '# pack-refs with: peeled fully-peeled sorted\n' + oid + ' refs/heads/main\n')
    packed_before = fingerprint(str(root))['git']
    write(packed, packed.read_text() + oid + ' refs/chisa/recovery/one\n' + oid + ' refs/chisa/transfer/two\n')
    assert fingerprint(str(root))['git'] == packed_before, 'packed private refs invalidated token'
    packed.unlink()
    branch_before = fingerprint(str(root))['git']
    write(metadata / 'HEAD', 'ref: refs/alias/current\n')
    write(metadata / 'refs/alias/current', 'ref: refs/heads/main\n')
    assert fingerprint(str(root))['git'] != branch_before, 'symbolic ref chain ignored'
    sym_before = fingerprint(str(root))['git']
    write(metadata / 'refs/alias/current', 'ref: refs/heads/other\n')
    write(metadata / 'refs/heads/other', oid + '\n')
    assert fingerprint(str(root))['git'] != sym_before, 'same-commit branch switch ignored'
    lock = metadata / 'index.lock'
    lock.write_bytes(b'foreign lock must remain')
    locked = snap(root)
    fails(lambda: fingerprint(str(root)), 'index.lock')
    assert snap(root) == locked, 'index.lock fallback changed metadata'
    lock.unlink()
    for name in ns['OPERATION_FILES']:
        old = fingerprint(str(root))['git']
        write(metadata / name, 'operation\n')
        assert fingerprint(str(root))['git'] != old, name
        (metadata / name).unlink()
    for name in ns['OPERATION_DIRECTORIES']:
        old = fingerprint(str(root))['git']
        write(metadata / name / 'nested' / 'file', 'operation\n')
        assert fingerprint(str(root))['git'] != old, name
        changed = fingerprint(str(root))['git']
        write(metadata / name / 'nested' / 'file', 'changed operation\n')
        assert fingerprint(str(root))['git'] != changed, name
        shutil.rmtree(metadata / name)
    old = fingerprint(str(root))
    write(metadata / 'sharedindex.012345', 'split index\n')
    assert fingerprint(str(root))['git'] != old['git']
    assert fingerprint(str(root))['policy'] != old['policy']
    old = fingerprint(str(root))['git']
    write(metadata / 'config.lock', '')
    assert fingerprint(str(root))['git'] != old, 'lock presence ignored'
    (metadata / 'config.lock').unlink()
    old = fingerprint(str(root))['policy']
    write(metadata / 'info/exclude', '*.private\n')
    assert fingerprint(str(root))['policy'] != old, 'exclude content ignored'
    config = metadata / 'config'
    baseline_config = config.read_text()
    for header in ('[include]', '[ include ]', '[ includeIf "gitdir:*/" ]', '[includeIf.gitdir:*/]'):
        config.write_text(baseline_config + '\n' + header + '\n path = /external/config\n')
        fails(lambda: fingerprint(str(root)), 'External Git')
    config.write_text(baseline_config + '\n[core]\n excludesFile = /external/ignore\n')
    fails(lambda: fingerprint(str(root)), 'External Git')
    config.write_text(baseline_config)
    write(packed, oid + ' refs/replace/' + oid + '\n')
    fails(lambda: fingerprint(str(root)), 'replace references')
    bare = root.parent / (root.name + '-bare')
    git('init', '--bare', str(bare))
    (bare / 'child').mkdir()
    fails(lambda: fingerprint(str(bare / 'child')), 'Bare Git repository')
elif q['scenario'] == 'linked':
    linked = root.parent / (root.name + '-linked')
    git('worktree', 'add', '-b', 'linked', str(linked))
    before = snap(root)
    first = fingerprint(str(linked))
    assert first['repository']
    assert fingerprint(str(linked))['git'] == first['git']
    assert snap(root) == before
    gitdir = pathlib.Path(git('rev-parse', '--absolute-git-dir', directory=linked))
    lock = gitdir / 'index.lock'
    lock.write_text('foreign linked lock')
    fails(lambda: fingerprint(str(linked)), 'index.lock')
    assert lock.read_text() == 'foreign linked lock'
    lock.unlink()
    write(metadata / 'info/exclude', '*.private\n')
    assert fingerprint(str(linked))['policy'] != first['policy'], 'common exclude ignored'
    old = fingerprint(str(linked))['git']
    write(gitdir / 'MERGE_HEAD', git('rev-parse', 'HEAD') + '\n')
    assert fingerprint(str(linked))['git'] != old, 'per-worktree operation ignored'
    git('worktree', 'remove', '--force', str(linked))
elif q['scenario'] == 'inotify':
    if not sys.platform.startswith('linux'):
        print('SKIP Linux inotify')
        raise SystemExit(0)
    write(root / 'src/build/.gitignore', '*.nested\n')
    write(root / 'node_modules/large/ignore-me', 'dependency\n')
    observer = ns['Observer'](str(root))
    try:
        before = snap(root)
        first = observer.observe()
        assert snap(root) == before, 'inotify observation wrote files'
        assert observer.observe() == first, 'steady tokens changed'
        assert not any('/node_modules/' in p or p.endswith('/node_modules') for p in observer.paths)
        # Warm queries may enumerate Git metadata, never project directories.
        scans = []
        real_scandir = os.scandir
        def counted(path):
            scans.append(os.fspath(path))
            return real_scandir(path)
        os.scandir = counted
        assert observer.observe() == first
        os.scandir = real_scandir
        assert all(p.startswith(str(metadata)) for p in scans), scans
        write(root / 'tracked.txt', 'ordinary content write\n')
        assert observer.observe() == first, 'ordinary write invalidated ignore token'
        write(root / 'named ignored.private', 'one\n')
        named = observer.observe()
        assert named['ignore'] != first['ignore'] and named['git'] == first['git']
        write(root / 'named ignored.private', 'two\n')
        assert observer.observe() == named, 'ignored content write invalidated token'
        write(root / 'src/build/.gitignore', '*.changed\n')
        nested = observer.observe()
        assert nested['ignore'] != named['ignore'], 'nested ignore was pruned'
        write(root / 'new/deep/.gitignore', '*.arrived\n')
        arrived = observer.observe()
        assert arrived['ignore'] != nested['ignore']
        write(root / 'new/deep/.gitignore', '*.after-registration\n')
        registered = observer.observe()
        assert registered['ignore'] != arrived['ignore'], 'new deep ignore not watched'
        moved = root.parent / (root.name + '-incoming')
        write(moved / 'deep/.gitignore', '*.moved\n')
        moved.rename(root / 'moved')
        moved_token = observer.observe()
        write(root / 'moved/deep/.gitignore', '*.moved-again\n')
        assert observer.observe()['ignore'] != moved_token['ignore'], 'moved populated tree not watched'
        old = observer.observe()
        write(metadata / 'info/exclude', '*.metadata-ignore\n')
        assert observer.observe()['ignore'] != old['ignore']
        old = observer.observe()
        observer.event(-1, ns['IN_Q_OVERFLOW'], '')
        overflow = observer.observe()
        assert overflow['ignore'] != old['ignore'], 'overflow did not renew nonce'
        assert overflow['git'] == old['git']
        assert observer.observe() == overflow, 'overflow rescan never stabilized'
        restarted = ns['Observer'](str(root))
        try:
            fresh = restarted.observe()
            assert fresh['ignore'] != overflow['ignore'] and fresh['git'] == overflow['git']
        finally: restarted.close()
        old = observer.observe()
        (root / 'new').rename(root / 'renamed')
        rename_token = observer.observe()
        assert rename_token['ignore'] != old['ignore']
        write(root / 'renamed/deep/.gitignore', '*.after-rename\n')
        assert observer.observe()['ignore'] != rename_token['ignore']
        old = observer.observe()
        observer.lost = True
        original_add = observer.libc.inotify_add_watch
        observer.libc.inotify_add_watch = lambda *args: -1
        fails(observer.observe, 'registration failed')
        observer.libc.inotify_add_watch = original_add
        assert observer.observe()['ignore'] != old['ignore'], 'failed watch evidence reused'
    finally:
        os.scandir = real_scandir if 'real_scandir' in locals() else os.scandir
        observer.close()
else:
    raise AssertionError(q['scenario'])
print('PASS ' + q['scenario'])
`

func TestRemoteSyncObservationPython(t *testing.T) {
	tools := syncSeedTools(t)
	for _, scenario := range []string{"metadata", "linked", "inotify"} {
		t.Run(scenario, func(t *testing.T) {
			input, err := json.Marshal(map[string]string{"worker": syncObserveWorker, "scenario": scenario, "root": t.TempDir()})
			if err != nil {
				t.Fatal(err)
			}
			stdout, stderr, err := tools.command(t, input, tools.python, "-B", "-c", syncObservePythonTests)
			if err != nil {
				t.Fatalf("actual Python %s failed: %v\n%s\n%s", scenario, err, stdout, stderr)
			}
			if strings.Contains(stdout, "SKIP Linux") {
				t.Skip("actual inotify coverage requires Linux; metadata and linked-worktree tests run on this host")
			}
			if !strings.Contains(stdout, "PASS "+scenario) {
				t.Fatalf("Python worker did not report success: %s %s", stdout, stderr)
			}
		})
	}
}

func TestRemoteSyncObservationLineBound(t *testing.T) {
	for _, text := range []string{"{}\n", strings.Repeat("x", 10000) + "\n"} {
		line, err := readSyncRemoteObservationLine(bufio.NewReaderSize(strings.NewReader(text), 16))
		if err != nil || string(line) != text {
			t.Fatalf("line framing: %d bytes, %v", len(line), err)
		}
	}
	if _, err := readSyncRemoteObservationLine(bufio.NewReader(strings.NewReader(strings.Repeat("x", syncRemoteObservationLimit)))); err == nil {
		t.Fatal("unterminated response accepted")
	}
	if _, err := readSyncRemoteObservationLine(bufio.NewReader(strings.NewReader(strings.Repeat("x", syncRemoteObservationLimit) + "\n"))); err == nil {
		t.Fatal("oversized response accepted")
	}
}

func TestRemoteSyncObservationProcess(t *testing.T) {
	tools := syncSeedTools(t)
	const worker = `import json, os, sys, time
for line in sys.stdin:
    q = json.loads(line)
    if q.get('sleep'): time.sleep(60)
    print(json.dumps({'git': 'a' * 64, 'ignore': 'b' * 64, 'repository': True}), flush=True)
`
	lifetime, cancel := context.WithCancel(context.Background())
	observer, err := newSyncRemoteObserver(lifetime, func(ctx context.Context) *exec.Cmd {
		cmd := exec.CommandContext(ctx, tools.python, "-B", "-u", "-c", worker)
		cmd.Env = tools.env
		return cmd
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { cancel(); observer.close() })
	pid := observer.command.Process.Pid
	var wait sync.WaitGroup
	failures := make(chan error, 8)
	for range 8 {
		wait.Add(1)
		go func() {
			defer wait.Done()
			value, err := observer.observe(context.Background())
			if err == nil && (!value.Repository || value.Git != strings.Repeat("a", 64)) {
				err = errors.New("unexpected protocol response")
			}
			failures <- err
		}()
	}
	wait.Wait()
	close(failures)
	for err := range failures {
		if err != nil {
			t.Fatal(err)
		}
	}
	if observer.command.Process.Pid != pid {
		t.Fatal("steady requests replaced their process")
	}
	// A caller cancelled while waiting for the requests mutex returns promptly
	// and leaves the healthy shared observer available to the next request.
	observer.requests <- struct{}{}
	ctx, stop := context.WithCancel(context.Background())
	stop()
	if _, err := observer.observe(ctx); !errors.Is(err, context.Canceled) {
		t.Fatalf("queued request cancellation lost: %v", err)
	}
	<-observer.requests
	if observer.closed.Load() {
		t.Fatal("waiting cancellation killed a healthy shared observer")
	}
	cancel()
	select {
	case <-observer.done:
	case <-time.After(5 * time.Second):
		t.Fatal("old connection did not close observer process")
	}
}

func TestRemoteSyncObservationRequestCancellation(t *testing.T) {
	tools := syncSeedTools(t)
	observer, err := newSyncRemoteObserver(context.Background(), func(ctx context.Context) *exec.Cmd {
		cmd := exec.CommandContext(ctx, tools.python, "-B", "-u", "-c", "import sys,time;sys.stdin.readline();time.sleep(60)")
		cmd.Env = tools.env
		return cmd
	})
	if err != nil {
		t.Fatal(err)
	}
	defer observer.close()
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	if _, err := observer.observe(ctx); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("request deadline lost: %v", err)
	}
	select {
	case <-observer.done:
	case <-time.After(5 * time.Second):
		t.Fatal("timed-out observer did not terminate")
	}
}

func TestRemoteSyncObservationCommand(t *testing.T) {
	command, err := syncRemoteObserverCommand("/a path/with'quote")
	if err != nil {
		t.Fatal(err)
	}
	if len(command) > 30000 || !strings.Contains(command, shellQuote("/a path/with'quote")) {
		t.Fatal("SSH worker command exceeded Windows limit or lost root quoting")
	}
}
