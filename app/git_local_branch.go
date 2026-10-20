package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"time"
)

// This capability executes only these three owner-side operations. The caller
// holds the workspace mutex; neither a task's lease nor explicit recovery is
// borrowed to make a branch operation succeed.
func localGitBranchRPC(parent context.Context, m *Mapping, request map[string]any) (result map[string]any) {
	action, _ := request["action"].(string)
	branch, _ := request["branch"].(string)
	if !slices.Contains([]string{"checkout", "create", "delete"}, action) || !localGitReadRef(branch) || strings.ContainsAny(branch, "@^~") {
		return localGitReadError("INVALID_REQUEST", "Invalid local branch action or name")
	}
	force := false
	for key, value := range request {
		if key == "force" && action == "delete" {
			var valid bool
			force, valid = value.(bool)
			if !valid {
				return localGitReadError("INVALID_REQUEST", "Branch force must be a boolean")
			}
		} else if key != "op" && key != "action" && key != "branch" {
			return localGitReadError("INVALID_REQUEST", "Unsupported local branch option")
		}
	}
	bounded, stop := context.WithTimeout(parent, workspaceSyncTimeout)
	defer stop()
	ctx, cancel, err := bindWorkspaceSyncConnection(bounded)
	if err != nil {
		return localGitReadError("WORKSPACE_UNAVAILABLE", "工作区账号或连接已改变")
	}
	defer cancel()
	binding := *m
	defer func() {
		current := store.findMappingByServer(binding.ServerPath)
		if current == nil || *current != binding {
			result = localGitReadError("STALE_BINDING", "工作区绑定已改变，请核对分支并恢复同步")
		} else if err := workspaceSyncCurrent(ctx); err != nil {
			result = localGitReadError("WORKSPACE_UNAVAILABLE", "分支操作已取消或账号连接已改变，请核对本机分支与同步状态")
		}
	}()
	if m.Mode != "vps" {
		return localGitReadError("WORKSPACE_UNAVAILABLE", "请先完成项目同步后再管理分支")
	}
	if piWorkspaceOwned(m.ServerPath) {
		return localGitReadError("WORKSPACE_BUSY", "工作区正在由 Pi 使用，请等待交还")
	}
	if err := mappingTaskBusy(m, false); err != nil {
		return localGitReadError("WORKSPACE_BUSY", err.Error())
	}
	if _, pending := cloudSyncRecovery.Load(m.ServerPath); pending {
		return localGitReadError("SYNC_BLOCKED", "项目任务尚未完成交还，请先恢复同步")
	}
	for _, barrier := range []bool{branchMapHas(&pendingSyncReleases, m.ServerPath), branchMapHas(&syncStopUnconfirmed, m.ServerPath)} {
		if barrier {
			return localGitReadError("SYNC_BLOCKED", "项目尚有同步恢复记录，请先恢复同步")
		}
	}
	journal, err := loadSyncRelease(m)
	if err != nil || journal != nil {
		return localGitReadError("SYNC_BLOCKED", "项目尚有同步交还记录，请先恢复同步")
	}
	checkpoint, err := loadGitCheckpoint(m)
	if err != nil || checkpoint.Pending != nil {
		return localGitReadError("SYNC_BLOCKED", "上次 Git 同步未完成，请先恢复同步")
	}
	rootPath, err := filepath.EvalSymlinks(m.LocalPath)
	if err != nil {
		return localGitReadFileError(err)
	}
	root, err := os.OpenRoot(rootPath)
	if err != nil {
		return localGitReadFileError(err)
	}
	defer root.Close()
	gitIdentity, err := localGitBranchIdentity(ctx, rootPath)
	if err != nil {
		return localGitReadError("WORKSPACE_GIT_CHANGED", "无法确认本机 Git 元数据目录")
	}
	if err := localGitBranchCurrent(ctx, &binding, rootPath, root, gitIdentity); err != nil {
		return localGitReadError("WORKSPACE_GIT_CHANGED", "无法确认绑定的本地 Git 仓库")
	}
	name, err := runLocalGitRead(ctx, rootPath, rootPath, []string{"check-ref-format", "--branch", branch})
	if err != nil || name.exitCode != 0 || strings.TrimSpace(name.stdout) != branch {
		return localGitReadError("INVALID_REQUEST", "Invalid literal local branch name")
	}
	options, failure := localGitBranchCheck(ctx, rootPath, action, branch)
	if failure != nil {
		return failure
	}
	finish := beginSyncOperation(m, "syncing")
	defer finish()
	state, err := remoteLeaseContext(ctx, m, "read", "", "")
	if err != nil {
		return localGitReadError("WORKSPACE_UNAVAILABLE", "无法确认工作区租约")
	}
	lease, present := state["lease"]
	if !present {
		return localGitReadError("WORKSPACE_UNAVAILABLE", "服务器未返回工作区租约状态")
	}
	if lease != nil {
		return localGitReadError("WORKSPACE_BUSY", "工作区仍由任务或同步持有，请先完成交还")
	}
	id := randHex(16)
	if err := saveSyncRelease(m, id); err != nil {
		return localGitReadError("WORKSPACE_UNAVAILABLE", "无法持久化分支同步交还记录")
	}
	pendingSyncReleases.Store(m.ServerPath, pendingSyncRelease{id: id, epoch: m.BindingEpoch})
	releaseReady := true // A failed claim can only release this exact, unused ID.
	defer func() {
		cleanup, cleanupCancel := localGitBranchCleanupContext(ctx, 30*time.Second)
		defer cleanupCancel()
		if !releaseReady {
			needsPause := true
			if !branchMapHas(&syncStopUnconfirmed, m.ServerPath) {
				pause, pauseCancel := context.WithTimeout(cleanup, workspaceSyncPauseTimeout)
				pauseErr := pauseProjectSync(pause, m)
				pauseCancel()
				needsPause = pauseErr != nil
				if needsPause {
					syncStopUnconfirmed.Store(m.ServerPath, unconfirmedSyncStop{m.BindingEpoch, m.SyncName})
				}
			}
			pendingSyncReleases.Store(m.ServerPath, pendingSyncRelease{id: id, epoch: m.BindingEpoch, needsPause: needsPause})
			setSyncInfo(m, "blocked", "分支同步尚未完成，保留本机修改与精确租约，请恢复同步")
			result["recoveryRequired"] = true
			return
		}
		cleanup, unbind, bindErr := bindWorkspaceSyncConnection(cleanup)
		if bindErr == nil {
			defer unbind()
			bindErr = releaseRecordedSyncLease(cleanup, m, id)
		}
		if bindErr != nil {
			pendingSyncReleases.Store(m.ServerPath, pendingSyncRelease{id: id, epoch: m.BindingEpoch})
			setSyncInfo(m, "blocked", "分支同步交还未确认，请恢复同步")
			result = localGitReadError("WORKSPACE_RELEASE_FAILED", "本机分支操作已结束，但同步交还未确认，请恢复同步")
			result["recoveryRequired"] = true
		}
	}()
	if _, err := remoteLeaseContext(ctx, m, "claim", "sync", id); err != nil {
		return localGitReadError("WORKSPACE_BUSY", "无法领取空闲工作区，请先完成任务交还")
	}
	ctx = syncLeaseContext(ctx, id)
	ctx = context.WithValue(ctx, syncGitSourceKey{}, "local")
	releaseReady = false
	if err := synchronizeProjectContext(ctx, m, false); err != nil {
		return localGitReadError("SYNC_BLOCKED", "分支操作前同步失败，已保留两端修改: "+localGitReadVirtualError(err.Error(), rootPath))
	}
	releaseReady = true
	if err := localGitBranchCurrent(ctx, &binding, rootPath, root, gitIdentity); err != nil {
		return localGitReadError("WORKSPACE_GIT_CHANGED", "同步后本地仓库或绑定已改变")
	}
	options, failure = localGitBranchCheck(ctx, rootPath, action, branch)
	if failure != nil {
		return failure
	}
	releaseReady = false
	if err := pauseProjectSync(ctx, m); err != nil {
		syncStopUnconfirmed.Store(m.ServerPath, unconfirmedSyncStop{m.BindingEpoch, m.SyncName})
		return localGitReadError("SYNC_PAUSE_UNCONFIRMED", "无法确认分支操作前同步已暂停")
	}
	remoteBefore := ""
	if action != "delete" {
		remoteBefore, err = localGitBranchRemote(ctx, m, "observe", branch, "", "")
		if err != nil {
			return localGitReadError("SYNC_BLOCKED", "无法确认远端 Git 状态，未执行分支切换: "+localGitReadVirtualError(err.Error(), rootPath))
		}
	}
	// Repeat after pausing and the remote observation, immediately before Git
	// acquires its own locks. Git also refuses worktree/index overwrites itself.
	if err := localGitBranchCurrent(ctx, &binding, rootPath, root, gitIdentity); err != nil {
		return localGitReadError("WORKSPACE_GIT_CHANGED", "执行分支操作前仓库或绑定已改变")
	}
	options, failure = localGitBranchCheck(ctx, rootPath, action, branch)
	var output localGitReadOutput
	if failure == nil {
		args := []string{"switch", "--no-guess", "--no-overwrite-ignore", "--", branch}
		if action == "create" {
			args = []string{"switch", "--no-guess", "--no-overwrite-ignore", "--no-track", "--create=" + branch, "--", "HEAD"}
		} else if action == "delete" {
			args = []string{"branch", "--delete"}
			if force {
				args = append(args, "--force")
			}
			args = append(args, "--", branch)
		}
		output, err = runLocalGitReadInput(ctx, rootPath, rootPath, args, nil, options)
		if err != nil {
			return localGitReadError("WORKSPACE_UNAVAILABLE", "本机 Git 操作中断，请核对分支后恢复同步")
		}
		if output.exitCode != 0 {
			failure = localGitReadError("WORKSPACE_GIT_REJECTED", localGitReadVirtualError(strings.TrimSpace(output.stderr), rootPath))
		} else if action != "delete" {
			head, headErr := runLocalGitRead(ctx, rootPath, rootPath, []string{"rev-parse", "--verify", "refs/heads/" + branch + "^{commit}"})
			current, currentErr := runLocalGitRead(ctx, rootPath, rootPath, []string{"symbolic-ref", "--quiet", "HEAD"})
			if headErr != nil || currentErr != nil || head.exitCode != 0 || current.exitCode != 0 || strings.TrimSpace(current.stdout) != "refs/heads/"+branch {
				return localGitReadError("WORKSPACE_GIT_CHANGED", "切换后本机分支发生改变，请核对后恢复同步")
			}
			if _, err := localGitBranchRemote(ctx, m, "align", branch, strings.TrimSpace(head.stdout), remoteBefore); err != nil {
				return localGitReadError("SYNC_BLOCKED", "本机分支已切换，远端分支尚未对齐，请恢复同步: "+localGitReadVirtualError(err.Error(), rootPath))
			}
		}
	}
	// A rejected Git command still has to resume and finish handback. Never undo
	// a successful local switch to hide an unsuccessful remote synchronization.
	if err := synchronizeProjectContext(ctx, m, false); err != nil {
		return localGitReadError("SYNC_BLOCKED", "分支操作后同步失败，已保留本机结果: "+localGitReadVirtualError(err.Error(), rootPath))
	}
	if err := localGitBranchCurrent(ctx, &binding, rootPath, root, gitIdentity); err != nil {
		return localGitReadError("WORKSPACE_GIT_CHANGED", "分支同步后仓库或绑定已改变")
	}
	current, err := runLocalGitRead(ctx, rootPath, rootPath, []string{"symbolic-ref", "--quiet", "HEAD"})
	if err != nil || (current.exitCode != 0 && current.exitCode != 1) {
		return localGitReadError("WORKSPACE_UNAVAILABLE", "无法确认同步后的本机分支")
	}
	currentRef := strings.TrimSpace(current.stdout)
	if failure == nil && action != "delete" && currentRef != "refs/heads/"+branch {
		return localGitReadError("WORKSPACE_GIT_CHANGED", "同步后的分支与请求不一致，请核对后恢复同步")
	}
	releaseReady = true
	if failure != nil {
		return failure
	}
	return map[string]any{"ok": true, "stdout": localGitReadVirtualError(output.stdout, rootPath), "stderr": localGitReadVirtualError(output.stderr, rootPath), "exitCode": 0, "branch": strings.TrimPrefix(currentRef, "refs/heads/")}
}

func branchMapHas(m interface{ Load(any) (any, bool) }, key string) bool {
	_, present := m.Load(key)
	return present
}

func localGitBranchCleanupContext(ctx context.Context, timeout time.Duration) (context.Context, context.CancelFunc) {
	cleanup := context.Background()
	if snapshot, _ := ctx.Value(workspaceSyncConnectionKey{}).(*workspaceSyncConnection); snapshot != nil {
		cleanup = context.WithValue(cleanup, workspaceSyncConnectionKey{}, snapshot)
	}
	return context.WithTimeout(cleanup, timeout)
}

// Capture both locations: a linked worktree's git-dir and shared common-dir
// are separate identities. A later .git replacement must not retarget a write.
func localGitBranchIdentity(ctx context.Context, path string) ([]os.FileInfo, error) {
	identities := make([]os.FileInfo, 0, 2)
	for _, option := range []string{"--absolute-git-dir", "--git-common-dir"} {
		value, err := runLocalGitRead(ctx, path, path, []string{"rev-parse", "--path-format=absolute", option})
		if err != nil || value.exitCode != 0 || value.truncated {
			return nil, fs.ErrInvalid
		}
		info, err := os.Stat(strings.TrimSpace(value.stdout))
		if err != nil || !info.IsDir() {
			return nil, fs.ErrInvalid
		}
		identities = append(identities, info)
	}
	return identities, nil
}

func localGitBranchCurrent(ctx context.Context, binding *Mapping, path string, root *os.Root, identities []os.FileInfo) error {
	if err := workspaceSyncCurrent(ctx); err != nil {
		return err
	}
	current := store.findMappingByServer(binding.ServerPath)
	if current == nil || *current != *binding {
		return fs.ErrInvalid
	}
	selected, err := root.Stat(".")
	if err != nil {
		return err
	}
	actual, err := os.Stat(binding.LocalPath)
	if err != nil || !os.SameFile(selected, actual) {
		return fs.ErrInvalid
	}
	inside, err := localGitReadRepository(ctx, path, root)
	if err != nil || !inside {
		return fs.ErrInvalid
	}
	actualIdentities, err := localGitBranchIdentity(ctx, path)
	if err != nil || len(actualIdentities) != len(identities) {
		return fs.ErrInvalid
	}
	for i, identity := range identities {
		if !os.SameFile(identity, actualIdentities[i]) {
			return fs.ErrInvalid
		}
	}
	return nil
}

func localGitBranchCheck(ctx context.Context, root, action, branch string) ([]string, map[string]any) {
	run := func(args ...string) (localGitReadOutput, error) { return runLocalGitRead(ctx, root, root, args) }
	exact := "refs/heads/" + branch
	exists, err := run("show-ref", "--verify", "--quiet", exact)
	if err != nil || exists.exitCode > 1 {
		return nil, localGitReadError("WORKSPACE_UNAVAILABLE", "无法读取本机分支")
	}
	if action == "create" && exists.exitCode == 0 {
		return nil, localGitReadError("WORKSPACE_GIT_BRANCH_EXISTS", "本机已存在该分支")
	}
	if action != "create" && exists.exitCode != 0 {
		return nil, localGitReadError("WORKSPACE_GIT_BRANCH_MISSING", "本机不存在该分支")
	}
	if exists.exitCode == 0 {
		symbolic, err := run("symbolic-ref", "--quiet", exact)
		if err != nil || symbolic.exitCode != 1 {
			return nil, localGitReadError("WORKSPACE_GIT_UNSUPPORTED", "无法安全操作符号分支引用")
		}
	}
	unmerged, err := run("ls-files", "--unmerged", "-z")
	if err != nil || unmerged.exitCode != 0 || unmerged.truncated {
		return nil, localGitReadError("WORKSPACE_UNAVAILABLE", "无法确认 Git 冲突状态")
	}
	if unmerged.stdout != "" {
		return nil, localGitReadError("WORKSPACE_GIT_CONFLICT", "存在尚未解决的 Git 冲突，请先解决或完成当前操作")
	}
	for _, marker := range []string{"MERGE_HEAD", "MERGE_AUTOSTASH", "REBASE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply", "sequencer", "refs/rewritten"} {
		path, err := run("rev-parse", "--path-format=absolute", "--git-path", marker)
		if err != nil || path.exitCode != 0 {
			return nil, localGitReadError("WORKSPACE_UNAVAILABLE", "无法确认 Git 操作状态")
		}
		_, err = os.Lstat(strings.TrimSpace(path.stdout))
		if err == nil {
			return nil, localGitReadError("WORKSPACE_GIT_OPERATION", "合并、变基或提交序列尚未结束，请先完成当前 Git 操作")
		}
		if !errors.Is(err, fs.ErrNotExist) {
			return nil, localGitReadError("WORKSPACE_UNAVAILABLE", "无法读取 Git 操作状态")
		}
	}
	options, unsupported, err := localGitReadSafety(ctx, root)
	if err != nil || unsupported != "" {
		return nil, localGitReadError("WORKSPACE_GIT_UNSUPPORTED", "分支操作暂不支持外部过滤器或子模块")
	}
	// Disable all configured checkout helpers too, including smudge-only drivers.
	configured, err := run("config", "--null", "--name-only", "--get-regexp", `^filter\..*\.(clean|smudge|process)$`)
	if err != nil || configured.exitCode > 1 || configured.truncated {
		return nil, localGitReadError("WORKSPACE_GIT_UNSUPPORTED", "无法确认 Git 过滤器设置")
	}
	for _, key := range strings.Split(configured.stdout, "\x00") {
		if key == "" {
			continue
		}
		driver := key[:strings.LastIndex(key, ".")]
		if strings.ContainsAny(driver, "=\r\n\x00") {
			return nil, localGitReadError("WORKSPACE_GIT_UNSUPPORTED", "无法安全禁用 Git 过滤器")
		}
		options = append(options, "-c", driver+".clean=", "-c", driver+".smudge=", "-c", driver+".process=", "-c", driver+".required=false")
	}
	options = append(options, "-c", "submodule.recurse=false", "-c", "branch.autoSetupMerge=false", "-c", "branch.autoSetupRebase=never")
	if action != "delete" {
		status, err := runLocalGitReadInput(ctx, root, root, []string{"status", "--porcelain=v1", "-z", "--untracked-files=all"}, nil, options)
		if err != nil || status.exitCode != 0 || status.truncated {
			return nil, localGitReadError("WORKSPACE_UNAVAILABLE", "无法确认本机工作区修改")
		}
		if status.stdout != "" {
			return nil, localGitReadError("WORKSPACE_GIT_DIRTY", "请先提交或自行保存本机修改，再切换或创建分支")
		}
		if action == "checkout" {
			tree, err := run("ls-tree", "-r", "-z", "--full-tree", exact)
			if err != nil || tree.exitCode != 0 || tree.truncated {
				return nil, localGitReadError("WORKSPACE_UNAVAILABLE", "无法读取目标分支文件")
			}
			var paths bytes.Buffer
			for _, entry := range strings.Split(tree.stdout, "\x00") {
				if entry == "" {
					continue
				}
				mode, path, valid := strings.Cut(entry, "\t")
				if !valid || strings.HasPrefix(mode, "160000 ") {
					return nil, localGitReadError("WORKSPACE_GIT_UNSUPPORTED", "目标分支包含不支持的子模块")
				}
				paths.WriteString(path)
				paths.WriteByte(0)
			}
			attrs, err := runLocalGitReadInput(ctx, root, root, []string{"check-attr", "--source=" + exact, "-z", "--stdin", "filter"}, paths.Bytes(), nil)
			if err != nil || attrs.exitCode != 0 || attrs.truncated {
				return nil, localGitReadError("WORKSPACE_GIT_UNSUPPORTED", "无法确认目标分支过滤器")
			}
			parts := strings.Split(strings.TrimSuffix(attrs.stdout, "\x00"), "\x00")
			if paths.Len() != 0 && len(parts)%3 != 0 {
				return nil, localGitReadError("WORKSPACE_GIT_UNSUPPORTED", "无法确认目标分支过滤器")
			}
			for i := 2; i < len(parts); i += 3 {
				if parts[i] != "unspecified" && parts[i] != "unset" {
					return nil, localGitReadError("WORKSPACE_GIT_UNSUPPORTED", "目标分支包含外部过滤器")
				}
			}
		}
	}
	return options, nil
}

var localGitBranchRemote = func(ctx context.Context, m *Mapping, phase, branch, head, expected string) (string, error) {
	payload, err := json.Marshal(map[string]any{"root": m.ServerPath, "phase": phase, "ref": "refs/heads/" + branch, "head": head, "expected": expected, "backup": "refs/chisa/recovery/branch-" + randHex(16)})
	if err != nil {
		return "", err
	}
	out, err := syncRemoteScript(ctx, m, "setpriv --reuid=1000 --regid=1000 --clear-groups env HOME=/nonexistent python3 -c "+shellQuote(localGitBranchRemoteWorker), bytes.NewReader(payload))
	return strings.TrimSpace(out), err
}

// A stale inactive VPS ref must not decide what an owner may check out locally.
// Observe before switching, then preserve/CAS-retire only that exact ref after
// the local switch succeeds. Existing sync installs HEAD/index and file contents.
const localGitBranchRemoteWorker = `import base64, fcntl, hashlib, json, os, pathlib, subprocess, sys
q = json.load(sys.stdin)
root, target = pathlib.Path(q['root']), q['ref']
env = {k:v for k,v in os.environ.items() if not k.upper().startswith('GIT_')}
env.update({'GIT_NO_LAZY_FETCH':'1', 'GIT_TERMINAL_PROMPT':'0'})
base = ['git', '--no-pager', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-C', str(root)]
# Older server Git lacks --no-lazy-fetch. Refuse promisor repositories before
# object reads so their missing objects cannot trigger an implicit network fetch.
partial = subprocess.run(base + ['config','--get-regexp',r'^(extensions\.partialclone|remote\..*\.promisor)$'], capture_output=True, env=env)
if partial.returncode not in (0, 1): raise RuntimeError('Cannot verify remote Git object availability')
if partial.returncode == 0: raise RuntimeError('Partial clone repositories require a complete local object set before branch management')
def git(*args, data=None, missing=False):
    p = subprocess.run(base + list(args), input=data, capture_output=True, env=env)
    if missing and p.returncode == 1: return b''
    if p.returncode: raise RuntimeError(os.fsdecode(p.stderr).strip())
    return p.stdout
files = ('ORIG_HEAD','MERGE_HEAD','MERGE_AUTOSTASH','MERGE_MSG','MERGE_MODE','MERGE_RR','AUTO_MERGE','CHERRY_PICK_HEAD','REVERT_HEAD','REBASE_HEAD','SQUASH_MSG')
directories = ('rebase-merge','rebase-apply','sequencer','refs/rewritten')
active = ('MERGE_HEAD','MERGE_AUTOSTASH','REBASE_HEAD','CHERRY_PICK_HEAD','REVERT_HEAD') + directories
def state():
    entries = {}
    for name in files + directories:
        path = pathlib.Path(os.fsdecode(git('rev-parse','--path-format=absolute','--git-path',name)).strip())
        if not path.exists() and not path.is_symlink(): continue
        if name in active: raise RuntimeError('Remote Git operation is still active; preserved branch history')
        if path.is_symlink() or not path.is_file(): raise RuntimeError('Unsafe Git operation metadata')
        entries[name] = base64.b64encode(path.read_bytes()).decode('ascii')
    return {'head': os.fsdecode(git('rev-parse','--verify','HEAD^{commit}')).strip(),
            'branch': os.fsdecode(git('symbolic-ref','--quiet','HEAD',missing=True)).strip(),
            'index': base64.b64encode(git('ls-files','--stage','-z')).decode('ascii'),
            'operations': entries, 'target': os.fsdecode(git('rev-parse','--verify','--quiet',target,missing=True)).strip()}
def token(value): return hashlib.sha256(json.dumps(value,sort_keys=True).encode()).hexdigest()
if q['phase'] not in ('observe','align'): raise RuntimeError('Invalid branch alignment action')
index = pathlib.Path(os.fsdecode(git('rev-parse','--path-format=absolute','--git-path','index')).strip())
lock, owned = pathlib.Path(str(index) + '.lock'), pathlib.Path(str(index) + '.chisa-owned')
def remove_owned_lock():
    if owned.exists():
        if lock.exists() and os.path.samefile(owned, lock): lock.unlink()
        owned.unlink()
with pathlib.Path(str(index) + '.chisa-guard').open('a+b') as guard:
    fcntl.flock(guard, fcntl.LOCK_EX | fcntl.LOCK_NB)
    remove_owned_lock()
    try:
        with owned.open('xb'): pass
        os.link(owned, lock)
        before = state()
        if q['phase'] == 'observe':
            print(token(before))
            sys.exit(0)
        if token(before) != q['expected']: raise RuntimeError('Remote Git state changed after branch preparation')
        if not before['target'] or before['target'] == q['head']: sys.exit(0)
        if before['branch'] == target: raise RuntimeError('Target branch is active remotely; preserved history')
        for record in os.fsdecode(git('worktree','list','--porcelain','-z')).split('\0\0'):
            if 'branch ' + target in record.split('\0'): raise RuntimeError('Target branch is used by a remote worktree; preserved history')
        if git('symbolic-ref','--quiet',target,missing=True): raise RuntimeError('Target is a symbolic ref; preserved history')
        lines = ['start', 'create ' + q['backup'] + ' ' + before['target'], 'delete ' + target + ' ' + before['target']]
        if before['branch']: lines.append('verify ' + before['branch'] + ' ' + before['head'])
        lines += ['prepare', 'commit', '']
        git('update-ref','--stdin',data='\n'.join(lines).encode())
        print(q['backup'])
    finally:
        remove_owned_lock()
`
