package main

import (
	"bytes"
	"context"
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

//go:embed resources/lease.py
var leaseWorker string

//go:embed resources/sync_git_seed.py
var syncGitSeedWorker string

var remoteLease = executeRemoteLease
var remoteLeaseContext = executeRemoteLeaseContext

func executeRemoteLease(m *Mapping, op, owner, id string) (map[string]any, error) {
	return remoteLeaseContext(context.Background(), m, op, owner, id)
}

func executeRemoteLeaseContext(parent context.Context, m *Mapping, op, owner, id string) (map[string]any, error) {
	if err := parent.Err(); err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(parent, 30*time.Second)
	defer cancel()
	transport, err := workspaceSyncTunnel(ctx, m)
	if err != nil {
		return nil, err
	}
	request := map[string]any{"root": m.ServerPath, "op": op, "owner": owner, "id": id, "epoch": m.BindingEpoch}
	if transport.Cfg.WorkspaceAccount != "" && op == "recover" {
		checked, err := accountWorkspaceRPC(ctx, "/api/workspace-sync/lease-recovery", map[string]any{"serverPath": m.ServerPath, "bindingEpoch": m.BindingEpoch})
		if err != nil {
			return nil, err
		}
		if checked["ok"] != true {
			return checked, fmt.Errorf("%v", checked["error"])
		}
		request["serverChecked"] = true
		request["checkedLease"] = checked["lease"]
	}
	q, _ := json.Marshal(request)
	if err := workspaceSyncCurrent(ctx); err != nil {
		return nil, err
	}
	cmd := hideCommandWindow(exec.CommandContext(ctx, sshExe(), append(transport.baseArgs(), "python3 -c "+shellQuote(leaseWorker))...))
	cmd.WaitDelay = time.Second
	cmd.Stdin = bytes.NewReader(q)
	out, err := cmd.Output()
	if err != nil {
		if ctx.Err() != nil {
			err = ctx.Err()
		}
		return nil, err
	}
	var result map[string]any
	if err = json.Unmarshal(out, &result); err != nil {
		return nil, err
	}
	if err := workspaceSyncCurrent(ctx); err != nil {
		return nil, err
	}
	if result["ok"] != true {
		return result, fmt.Errorf("%v", result["error"])
	}
	return result, nil
}

func serverGit(m *Mapping, args ...string) string {
	command := "setpriv --reuid=1000 --regid=1000 --clear-groups env HOME=/nonexistent git -c core.hooksPath=/dev/null -c core.fsmonitor=false -C " + shellQuote(m.ServerPath)
	for _, arg := range args {
		command += " " + shellQuote(arg)
	}
	return command
}

// Git objects/HEAD use Git transport; OS-specific .git files never use Mutagen.
func syncGit(m *Mapping) (err error) {
	ctx, cancel := context.WithTimeout(context.Background(), workspaceSyncTimeout)
	defer cancel()
	return syncGitContext(ctx, m)
}

func localGitRepository(ctx context.Context, local string) (bool, error) {
	top, err := gitOutputContext(ctx, local, "rev-parse", "--show-toplevel")
	if err == nil {
		root, err := os.Stat(top)
		if err != nil {
			return false, err
		}
		selected, err := os.Stat(local)
		if err != nil {
			return false, err
		}
		// Git resolves junctions; compare directory identities, not path aliases.
		return os.SameFile(root, selected), nil
	}
	if ctx.Err() == nil && strings.Contains(err.Error(), "fatal: not a git repository") {
		for directory := filepath.Clean(local); ; directory = filepath.Dir(directory) {
			if _, markerErr := os.Lstat(filepath.Join(directory, ".git")); markerErr == nil {
				return false, err
			} else if !os.IsNotExist(markerErr) {
				return false, markerErr
			}
			if filepath.Dir(directory) == directory {
				break
			}
		}
		return false, nil
	}
	return false, err
}

func syncGitContext(ctx context.Context, m *Mapping) (err error) {
	repository, err := localGitRepository(ctx, m.LocalPath)
	if err != nil {
		return err
	}
	if !repository {
		return nil
	}
	localHead, err := gitOutputContext(ctx, m.LocalPath, "rev-parse", "--verify", "HEAD^{commit}")
	if err != nil {
		// Only an unborn branch may omit HEAD; corrupt/missing objects are errors.
		branch, branchErr := gitOutputContext(ctx, m.LocalPath, "symbolic-ref", "--quiet", "HEAD")
		if branchErr == nil {
			if _, refErr := gitOutputContext(ctx, m.LocalPath, "show-ref", "--verify", "--quiet", branch); gitExitCode(refErr) == 1 {
				return nil
			}
		}
		return err
	}
	defer func() {
		if err != nil {
			return
		}
		// Git's index retains executable bits that a Windows checkout cannot expose.
		worker := "import os,pathlib,subprocess,sys\nroot=pathlib.Path(sys.argv[1]).resolve();excluded=[]\nfor entry in sys.stdin.buffer.read().split(b'\\0'):\n if not entry:continue\n meta,name=entry.split(b'\\t',1);parts=os.fsdecode(name).split('/')\n if any(x in ('node_modules','.venv','venv','__pycache__') for x in parts) or ((parts[-1]=='.env' or parts[-1].startswith('.env.')) and parts[-1] not in ('.env.example','.env.sample')):excluded.append(name);continue\n if meta.split()[0]!=b'100755':continue\n p=root/os.fsdecode(name)\n if p.is_file() and not p.is_symlink() and p.resolve().is_relative_to(root):p.chmod(p.stat().st_mode|0o111)\nif excluded:subprocess.run(['git','-C',str(root),'update-index','--skip-worktree','-z','--stdin'],input=b'\\0'.join(excluded)+b'\\0',check=True)"
		_, err = syncRemoteScript(ctx, m, "set -o pipefail\n"+serverGit(m, "ls-files", "--stage", "-z")+" | setpriv --reuid=1000 --regid=1000 --clear-groups env HOME=/nonexistent python3 -c "+shellQuote(worker)+" "+shellQuote(m.ServerPath), nil)
	}()
	transport, err := workspaceSyncTunnel(ctx, m)
	if err != nil {
		return err
	}
	remoteHead, err := transport.ExecRemoteContext(ctx, "if [ -e "+shellQuote(m.ServerPath+".chisa-git-seed.json")+" ]; then printf CHISA_GIT_SEED_PENDING; exit 0; fi\nif [ ! -e "+shellQuote(m.ServerPath+"/.git")+" ]; then exit 0; fi\n"+serverGit(m, "rev-parse", "--verify", "HEAD^{commit}"))
	if err != nil {
		return err
	}
	if remoteHead == "" || remoteHead == "CHISA_GIT_SEED_PENDING" {
		bundle := filepath.Join(dataDir(), "sync-config", m.BindingEpoch+".bundle")
		if err := os.MkdirAll(filepath.Dir(bundle), 0700); err != nil {
			return err
		}
		if _, err = gitOutputContext(ctx, m.LocalPath, "bundle", "create", bundle, "--all"); err != nil {
			return err
		}
		defer os.Remove(bundle)
		target := m.ServerPath + ".bundle"
		input, err := os.Open(bundle)
		if err != nil {
			return err
		}
		_, uploadErr := syncRemoteScript(ctx, m, "umask 077; cat > "+shellQuote(target), input)
		_ = input.Close()
		if uploadErr != nil {
			return fmt.Errorf("Git 初次上传失败: %w", uploadErr)
		}
		branch, branchErr := gitOutputContext(ctx, m.LocalPath, "symbolic-ref", "--quiet", "HEAD")
		if branchErr != nil && gitExitCode(branchErr) != 1 {
			return branchErr
		}
		origin, originErr := gitOutputContext(ctx, m.LocalPath, "remote", "get-url", "origin")
		if originErr != nil && gitExitCode(originErr) != 2 {
			return originErr
		}
		request, _ := json.Marshal(map[string]any{"root": m.ServerPath, "epoch": m.BindingEpoch, "head": localHead, "branch": branch, "origin": origin})
		_, err = syncRemoteScript(ctx, m, "python3 -c "+shellQuote(syncGitSeedWorker), bytes.NewReader(request))
		if err != nil {
			return err
		}
		return syncGitStateContext(ctx, m)
	}
	if _, err = syncRemoteScript(ctx, m, serverGitConfigurationContext(ctx, m), nil); err != nil {
		return err
	}
	return syncGitStateContext(ctx, m)
}

func gitExitCode(err error) int {
	var exit *exec.ExitError
	if errors.As(err, &exit) {
		return exit.ExitCode()
	}
	return -1
}

// Mutagen preserves Windows checkout bytes; Git normalizes CRLF on the server.
// Windows checkout file modes and materialized links must not become fake edits.
func serverGitConfiguration(m *Mapping) string {
	return serverGitConfigurationContext(context.Background(), m)
}

func serverGitConfigurationContext(ctx context.Context, m *Mapping) string {
	worker := "import pathlib,sys\np=pathlib.Path(sys.argv[1])/'.git/info/exclude';p.parent.mkdir(parents=True,exist_ok=True)\ns=p.read_text() if p.exists() else ''\nif '.chisa-bridge.json' not in s.splitlines():p.write_text(s+'\\n.chisa-bridge.json\\n')"
	// Replace only the temporary bundle remote created during initial replication.
	remoteCommand := serverGit(m, "remote", "remove", "origin")
	if origin, err := gitOutputContext(ctx, m.LocalPath, "remote", "get-url", "origin"); err == nil {
		remoteCommand = serverGit(m, "remote", "set-url", "origin", origin)
	}
	remoteConfiguration := "\nif [ \"$(" + serverGit(m, "remote", "get-url", "origin") + " 2>/dev/null)\" = " + shellQuote(m.ServerPath+".bundle") + " ]; then " + remoteCommand + "; fi"
	return "set -e\n" + serverGit(m, "config", "core.autocrlf", "input") + "\n" +
		serverGit(m, "config", "core.filemode", "false") + "\n" +
		serverGit(m, "config", "core.symlinks", "false") + "\nsetpriv --reuid=1000 --regid=1000 --clear-groups env HOME=/nonexistent python3 -c " + shellQuote(worker) + " " + shellQuote(m.ServerPath) + remoteConfiguration
}

var synchronizeProject = syncProjectContents
var synchronizeProjectContext = syncProjectContentsContext
var pauseProjectSync = pauseProjectSyncContext

type syncPauseError struct{ error }

func (e *syncPauseError) Unwrap() error { return e.error }

type unconfirmedSyncStop struct{ epoch, name string }

var syncStopUnconfirmed sync.Map

func confirmProjectSyncStop(ctx context.Context, m *Mapping) error {
	if value, ok := syncStopUnconfirmed.Load(m.ServerPath); ok {
		pending := value.(unconfirmedSyncStop)
		if pending.epoch != m.BindingEpoch || pending.name != m.SyncName {
			return fmt.Errorf("未确认的同步停止记录属于其他项目绑定")
		}
		if err := pauseProjectSync(ctx, m); err != nil {
			return &syncPauseError{err}
		}
		syncStopUnconfirmed.Delete(m.ServerPath)
	}
	return nil
}

func pauseProjectSyncContext(ctx context.Context, m *Mapping) error {
	if m.SyncName == "" {
		return nil
	}
	sessions, err := syncSessionsContext(ctx, m.SyncName)
	if err != nil {
		return err
	}
	if len(sessions) == 0 {
		return nil
	}
	if len(sessions) != 1 || !syncSessionMatchesMapping(sessions[0], m, workspaceSyncConfig(ctx)) {
		return fmt.Errorf("暂停同步前发现项目会话绑定不一致")
	}
	_, err = runMutagenContext(ctx, "sync", "pause", m.SyncName)
	return err
}

func syncProjectContents(m *Mapping, pause bool) error {
	ctx, cancel := context.WithTimeout(context.Background(), workspaceSyncTimeout)
	defer cancel()
	return synchronizeProjectContext(ctx, m, pause)
}

func syncProjectContentsContext(ctx context.Context, m *Mapping, pause bool) (failure error) {
	finish := beginSyncOperation(m, "syncing")
	defer finish()
	defer func() {
		if failure != nil && m.SyncName != "" {
			// Canceling the CLI does not cancel a daemon synchronization cycle.
			cleanup, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			if snapshot, _ := ctx.Value(workspaceSyncConnectionKey{}).(*workspaceSyncConnection); snapshot != nil {
				cleanup = context.WithValue(cleanup, workspaceSyncConnectionKey{}, snapshot)
			}
			if err := pauseProjectSync(cleanup, m); err != nil {
				syncStopUnconfirmed.Store(m.ServerPath, unconfirmedSyncStop{m.BindingEpoch, m.SyncName})
				failure = errors.Join(failure, &syncPauseError{fmt.Errorf("同步暂停尚未确认: %w", err)})
			}
			setSyncInfo(m, "blocked", "同步确认已中断，保留两端修改并重新同步恢复: "+failure.Error())
		}
	}()
	if err := confirmProjectSyncStop(ctx, m); err != nil {
		setSyncFailure(m, err)
		return err
	}
	id, _ := ctx.Value(syncLeaseContextKey{}).(string)
	if id == "" {
		failure = fmt.Errorf("同步操作缺少匹配的工作区租约")
		setSyncFailure(m, failure)
		return failure
	}
	confirmed, err := remoteLeaseContext(ctx, m, "confirm", "", id)
	if err != nil {
		setSyncFailure(m, err)
		return err
	}
	lease, _ := confirmed["lease"].(map[string]any)
	source := ""
	if lease["owner"] == "sync-needed" || lease["gitSource"] == "remote" {
		source = "remote"
	}
	if lease["owner"] == "claude" {
		source = "local"
	}
	ctx = context.WithValue(ctx, syncGitSourceKey{}, source)
	started := time.Now()
	if err := flushSyncContext(ctx, m, true); err != nil {
		setSyncFailure(m, err)
		return err
	}
	filesDone := time.Now()
	if err := ctx.Err(); err != nil {
		setSyncFailure(m, err)
		return err
	}
	setSyncInfo(m, "syncing", "")
	if err := syncGitContext(ctx, m); err != nil {
		setSyncFailure(m, err)
		return err
	}
	if err := refreshSyncIgnoreContext(ctx, m); err != nil {
		setSyncFailure(m, err)
		return err
	}
	if err := ctx.Err(); err != nil {
		setSyncFailure(m, err)
		return err
	}
	if !pause {
		if _, err := runMutagenContext(ctx, "sync", "resume", m.SyncName); err != nil {
			setSyncFailure(m, err)
			return err
		}
	}
	log.Printf("[sync] files=%s git=%s pause=%t", filesDone.Sub(started), time.Since(filesDone), pause)
	if pause {
		setSyncInfo(m, "reserved", "")
	} else {
		setSyncInfo(m, "ready", "")
	}
	ensureSyncMonitor()
	return nil
}

type pendingSyncRelease struct {
	id, epoch  string
	needsPause bool
}

var pendingSyncReleases sync.Map

// An unreadable identity is not proof that a previously claimed lease ended.
func readSyncReleaseOwnership(ctx context.Context, m *Mapping, id string) (bool, error) {
	state, err := remoteLeaseContext(ctx, m, "read", "", "")
	if err != nil {
		return false, err
	}
	value, present := state["lease"]
	if !present {
		return false, fmt.Errorf("服务器未返回可确认的工作区租约")
	}
	if value == nil {
		return false, nil
	}
	lease, valid := value.(map[string]any)
	remoteID, idValid := lease["id"].(string)
	epoch, epochValid := lease["epoch"].(string)
	owner, ownerValid := lease["owner"].(string)
	if !valid || !idValid || remoteID == "" || !epochValid || epoch == "" || !ownerValid || owner == "" {
		return false, fmt.Errorf("服务器租约绑定或身份无法确认，仍保留同步释放记录")
	}
	return remoteID == id && epoch == m.BindingEpoch && owner == "sync", nil
}

func clearPendingSyncRelease(m *Mapping) error {
	if err := clearSyncRelease(m); err != nil {
		return err
	}
	pendingSyncReleases.Delete(m.ServerPath)
	return nil
}

// Never release a replacement task; only discard this client's stale journal.
func releaseRecordedSyncLease(ctx context.Context, m *Mapping, id string) error {
	owned, err := readSyncReleaseOwnership(ctx, m, id)
	if err != nil {
		return err
	}
	if owned {
		if _, err := remoteLeaseContext(ctx, m, "release", "sync", id); err != nil {
			return err
		}
	}
	return clearPendingSyncRelease(m)
}

func (FrontendBridge) SyncProject(serverPath string) (result map[string]any) {
	return syncProject(serverPath)
}

func syncProject(serverPath string) (result map[string]any) {
	return syncProjectWithEmptyConfirmation(serverPath, "")
}

// Clearing a root is separate from ordinary synchronization and binds consent to this mapping.
func (FrontendBridge) ConfirmProjectEmpty(serverPath, bindingEpoch string) map[string]any {
	if bindingEpoch == "" {
		return map[string]any{"ok": false, "error": "缺少项目清空确认", "clearState": "not-started"}
	}
	result := syncProjectWithEmptyConfirmation(serverPath, bindingEpoch)
	if _, found := result["clearState"]; !found {
		result["clearState"] = "not-started"
	}
	return result
}

func syncProjectWithEmptyConfirmation(serverPath, emptyEpoch string) (result map[string]any) {
	return syncProjectWithEmptyConfirmationContext(context.Background(), serverPath, emptyEpoch)
}

func syncProjectWithEmptyConfirmationContext(parent context.Context, serverPath, emptyEpoch string) (result map[string]any) {
	ctx, cancel, err := bindWorkspaceSyncConnection(parent)
	if err != nil {
		return map[string]any{"ok": false, "error": err.Error()}
	}
	defer cancel()
	ctx, timeout := context.WithTimeout(ctx, workspaceSyncTimeout)
	defer timeout()
	m := store.findMappingByServer(serverPath)
	if m == nil {
		return map[string]any{"ok": false, "error": "工作区未绑定"}
	}
	unlock, err := lockWorkspace(ctx, serverPath)
	if err != nil {
		return map[string]any{"ok": false, "error": err.Error()}
	}
	defer unlock()
	if err := workspaceSyncCurrent(ctx); err != nil {
		return map[string]any{"ok": false, "error": err.Error()}
	}
	if current := store.findMappingByServer(serverPath); current == nil || current.BindingEpoch != m.BindingEpoch || m.ServerID != serverIdentity(workspaceSyncConfig(ctx)) {
		return map[string]any{"ok": false, "error": "工作区绑定已失效"}
	}
	if piWorkspaceOwned(serverPath) {
		return map[string]any{"ok": false, "error": "Pi 正在使用项目，请先结束任务"}
	}
	var emptySession *syncSession
	if emptyEpoch != "" {
		if m.BindingEpoch != emptyEpoch {
			return map[string]any{"ok": false, "error": "项目绑定已改变，请重新确认清空方向"}
		}
		session, err := projectEmptySession(ctx, m)
		if err != nil {
			return map[string]any{"ok": false, "error": err.Error()}
		}
		emptySession = &session
	}
	finish := beginSyncOperation(m, "migrating")
	defer finish()
	record, err := loadSyncRelease(m)
	if err != nil {
		setSyncFailure(m, err)
		return map[string]any{"ok": false, "error": "无法读取同步释放记录: " + err.Error()}
	}
	var pending pendingSyncRelease
	recoveryMapping := *m
	if record != nil {
		pending = pendingSyncRelease{id: record.ID, epoch: record.Epoch}
		recoveryMapping.SyncName = record.SyncName
	} else if value, ok := pendingSyncReleases.Load(serverPath); ok {
		pending = value.(pendingSyncRelease)
	}
	if pending.id != "" {
		if pending.epoch != m.BindingEpoch {
			return map[string]any{"ok": false, "error": "同步释放记录的项目绑定已失效"}
		}
		owned, err := readSyncReleaseOwnership(ctx, m, pending.id)
		if err != nil {
			setSyncFailure(m, err)
			return map[string]any{"ok": false, "error": "无法确认服务器租约，仍保留同步释放记录: " + err.Error()}
		}
		if !owned {
			if err := clearPendingSyncRelease(m); err != nil {
				setSyncFailure(m, err)
				return map[string]any{"ok": false, "error": "同步恢复记录清理失败: " + err.Error()}
			}
			pending.id = ""
		}
	}
	if pending.id != "" {
		// Memory loss cannot skip pausing the exact persisted daemon session.
		if err := pauseProjectSync(ctx, &recoveryMapping); err != nil {
			setSyncFailure(m, err)
			return map[string]any{"ok": false, "error": "上次同步暂停未确认，仍保留工作区租约: " + err.Error()}
		}
		if pending.needsPause {
			if err := confirmProjectSyncStop(ctx, m); err != nil {
				setSyncFailure(m, err)
				return map[string]any{"ok": false, "error": "上次同步暂停未确认，仍保留工作区租约: " + err.Error()}
			}
		}
		if err := releaseRecordedSyncLease(ctx, m, pending.id); err != nil {
			setSyncFailure(m, err)
			return map[string]any{"ok": false, "error": "上次同步已结束，但工作区释放仍未确认: " + err.Error()}
		}
	}
	id := randHex(16)
	if emptySession != nil {
		pendingEmptyConfirmations.Store(m.ServerPath, pendingEmptyConfirmation{epoch: m.BindingEpoch, session: *emptySession})
		_, err = runMutagenContext(ctx, "sync", "pause", emptySession.Identifier)
	} else {
		err = pauseProjectSync(ctx, m)
	}
	if err != nil {
		setSyncFailure(m, err)
		return map[string]any{"ok": false, "error": err.Error()}
	}
	if err := saveSyncRelease(m, id); err != nil {
		setSyncFailure(m, err)
		return map[string]any{"ok": false, "error": "无法保存同步释放记录，未领取工作区: " + err.Error()}
	}
	if _, err := remoteLeaseContext(ctx, m, "recover", "sync", id); err != nil {
		setSyncFailure(m, err)
		return map[string]any{"ok": false, "error": err.Error()}
	}
	ctx = syncLeaseContext(ctx, id)
	clearResult := syncEmptyResult{ClearState: "not-started"}
	defer func() {
		if emptyEpoch != "" {
			result["clearState"] = clearResult.ClearState
			result["backupPath"] = clearResult.BackupPath
		}
	}()
	releaseBlocked := false
	defer func() {
		if releaseBlocked {
			pendingSyncReleases.Store(serverPath, pendingSyncRelease{id: id, epoch: m.BindingEpoch, needsPause: true})
			return
		}
		// Cleanup gets a separate short budget even when the operation was canceled.
		cleanup, stopCleanup, bindErr := bindWorkspaceSyncConnection(context.WithValue(context.Background(), workspaceSyncConnectionKey{}, ctx.Value(workspaceSyncConnectionKey{})))
		if bindErr == nil {
			defer stopCleanup()
			cleanup, cancelCleanup := context.WithTimeout(cleanup, 30*time.Second)
			defer cancelCleanup()
			bindErr = releaseRecordedSyncLease(cleanup, m, id)
		}
		if bindErr != nil {
			pendingSyncReleases.Store(serverPath, pendingSyncRelease{id: id, epoch: m.BindingEpoch})
			detail := "同步操作已结束，但工作区释放未确认；请重新同步恢复: " + bindErr.Error()
			setSyncInfo(m, "blocked", detail)
			result = map[string]any{"ok": false, "error": detail, "code": "WORKSPACE_RELEASE_FAILED", "backupPath": clearResult.BackupPath}
		}
		if result["ok"] == true {
			if err := workspaceSyncCurrent(ctx); err != nil {
				result = map[string]any{"ok": false, "error": err.Error(), "backupPath": clearResult.BackupPath}
			}
		}
	}()
	if emptySession != nil {
		var err error
		clearResult, err = clearConfirmedProject(ctx, m, *emptySession)
		if err != nil {
			setSyncFailure(m, err)
			return map[string]any{"ok": false, "error": err.Error(), "backupPath": clearResult.BackupPath}
		}
	}
	if err := migrateProjectLockedContext(ctx, m); err != nil {
		var pauseError *syncPauseError
		releaseBlocked = errors.As(err, &pauseError)
		setSyncFailure(m, err)
		return map[string]any{"ok": false, "error": err.Error(), "backupPath": clearResult.BackupPath}
	}
	cloudReservations.Delete(serverPath)
	cloudSyncRecovery.Delete(serverPath)
	ensureSyncMonitor()
	if err := workspaceSyncCurrent(ctx); err != nil {
		return map[string]any{"ok": false, "error": err.Error(), "backupPath": clearResult.BackupPath}
	}
	return map[string]any{"ok": true, "backupPath": clearResult.BackupPath}
}

func migrateProjectLocked(m *Mapping) error {
	ctx, cancel := context.WithTimeout(context.Background(), workspaceSyncTimeout)
	defer cancel()
	return migrateProjectLockedContext(ctx, m)
}

func migrateProjectLockedContext(ctx context.Context, m *Mapping) error {
	setSyncInfo(m, "migrating", "")
	if m.Mode != "vps" {
		// Remove only the exact placeholder generated by the previous bridge.
		placeholders := []string{
			"# Workspace\n\nProject files and commands are available through the workspace tools at /workspace. Read /workspace/CLAUDE.md when present for project instructions.\n",
			"# 项目说明\n\n## 文件访问\n- 本项目源码位于 /workspace/（工作区根）。\n- 列目录：localfiles list /workspace\n- 读文件：localfiles read /workspace/路径\n- 写文件：echo \"内容\" | localfiles write /workspace/路径\n- 按名搜索：localfiles search /workspace 关键词\n- 按内容搜索：localfiles grep /workspace 关键词\n- 不要用本地 Read/Edit 工具操作 /workspace（那不是真实路径），一律用 localfiles。\n\n## 命令执行\n- 构建、测试、运行等命令使用 run 工具执行：run \"<命令>\"（在项目根目录执行）。\n",
		}
		q, _ := json.Marshal(map[string]any{"root": m.ServerPath, "placeholders": placeholders})
		worker := "import json,pathlib,os,sys\nq=json.load(sys.stdin);p=pathlib.Path(q['root']);p.mkdir(parents=True,exist_ok=True);os.chown(p,1000,1000)\nf=p/'CLAUDE.md'\nif f.exists() and f.read_text() in q['placeholders']:f.unlink()"
		if _, err := syncRemoteScript(ctx, m, "python3 -c "+shellQuote(worker), bytes.NewReader(q)); err != nil {
			return fmt.Errorf("VPS 项目初始化失败: %w", err)
		}
	}
	if err := synchronizeProjectContext(ctx, m, false); err != nil {
		return err
	}
	m.Mode = "vps"
	if err := workspaceSyncCurrent(ctx); err != nil {
		return err
	}
	transport, err := workspaceSyncTunnel(ctx, m)
	if err != nil {
		return err
	}
	serverConnectionMu.RLock()
	snapshot, _ := ctx.Value(workspaceSyncConnectionKey{}).(*workspaceSyncConnection)
	if ctx.Err() != nil || (snapshot != nil && !snapshot.currentLocked()) {
		serverConnectionMu.RUnlock()
		return fmt.Errorf("文件同步账号或连接已改变")
	}
	err = store.updateMapping(m)
	serverConnectionMu.RUnlock()
	if err != nil {
		return err
	}
	if err := transport.RegisterMappingContext(ctx, m); err != nil {
		return err
	}
	if err := workspaceSyncCurrent(ctx); err != nil {
		return err
	}
	setSyncInfo(m, "ready", "")
	return nil
}

// Only the matching server reservation can pause/resume a project's sync.
func synchronizationRPC(m *Mapping, q map[string]any) map[string]any {
	ctx, cancel := context.WithTimeout(context.Background(), workspaceSyncTimeout)
	defer cancel()
	return synchronizationRPCContext(ctx, m, q)
}

func synchronizationRPCContext(ctx context.Context, m *Mapping, q map[string]any) (result map[string]any) {
	op, _ := q["op"].(string)
	if op == "sync_end" || op == "sync_released" {
		ctx = context.WithValue(ctx, workspaceRecoveryContextKey{}, true)
	}
	ctx, cancel, err := bindWorkspaceSyncConnection(ctx)
	if err != nil {
		return map[string]any{"error": err.Error(), "code": "WORKSPACE_UNAVAILABLE"}
	}
	defer cancel()
	id, _ := q["runId"].(string)
	if m.Mode != "vps" || id == "" {
		return map[string]any{"error": "项目尚未完成 VPS 迁移", "code": "WORKSPACE_UNAVAILABLE"}
	}
	state, err := remoteLeaseContext(ctx, m, "read", "", "")
	if err != nil {
		return map[string]any{"error": err.Error(), "code": "WORKSPACE_UNAVAILABLE"}
	}
	if op == "sync_released" {
		if state["lease"] != nil {
			return map[string]any{"error": "项目接管状态已改变", "code": "WORKSPACE_BUSY"}
		}
		if reserved, ok := cloudReservations.Load(m.ServerPath); ok && reserved != id {
			return map[string]any{"error": "项目接管状态已改变", "code": "WORKSPACE_BUSY"}
		}
		cloudReservations.CompareAndDelete(m.ServerPath, id)
		cloudSyncRecovery.CompareAndDelete(m.ServerPath, id)
		publishProjectSync(m)
		if err := workspaceSyncCurrent(ctx); err != nil {
			return map[string]any{"error": err.Error(), "code": "WORKSPACE_UNAVAILABLE"}
		}
		return map[string]any{"ok": true}
	}
	lease, _ := state["lease"].(map[string]any)
	expectedOwner := "claude"
	if op == "sync_end" {
		expectedOwner = "sync-needed"
	}
	if lease["id"] != id || lease["epoch"] != m.BindingEpoch || lease["owner"] != expectedOwner {
		return map[string]any{"error": "项目接管状态已改变", "code": "WORKSPACE_BUSY"}
	}
	// File synchronization alone cannot release the server's task reservation.
	cloudReservations.Store(m.ServerPath, id)
	cloudSyncRecovery.Delete(m.ServerPath)
	if op == "sync_end" {
		defer func() {
			if result["error"] == nil {
				return
			}
			// The verified sync-needed lease belongs to handback, not an active Claude task.
			// Keep its reservation; the existing manual recovery path still checks the server.
			cloudSyncRecovery.Store(m.ServerPath, id)
			if syncOperationInfo(m).Status != "blocked" {
				setSyncInfo(m, "blocked", "云端任务已结束，但文件交还未完成；请立即同步恢复: "+fmt.Sprint(result["error"]))
			} else {
				publishProjectSync(m)
			}
		}()
	}
	ctx = syncLeaseContext(ctx, id)
	if pending, ok := lease["cleanupPending"].([]any); ok && len(pending) > 0 {
		setSyncInfo(m, "blocked", "工作区运行容器清理尚未确认，请立即同步恢复")
		return map[string]any{"error": "工作区运行容器清理尚未确认", "code": "WORKSPACE_CLEANUP_FAILED"}
	}
	if piWorkspaceOwned(m.ServerPath) {
		return map[string]any{"error": "Pi 正在使用工作区", "code": "WORKSPACE_BUSY"}
	}

	if err := synchronizeProjectContext(ctx, m, op == "sync_begin"); err != nil {
		return map[string]any{"error": err.Error(), "code": "SYNC_BLOCKED"}
	}
	publishProjectSync(m)
	if err := workspaceSyncCurrent(ctx); err != nil {
		return map[string]any{"error": err.Error(), "code": "WORKSPACE_UNAVAILABLE"}
	}
	if op == "sync_end" {
		// Admission of a delayed SSH synchronization job and the final lease
		// removal share lease.py's persistent flock. A Node check followed by
		// rmtree cannot make this handback atomic with sync_job.py admission.
		if _, err := remoteLeaseContext(ctx, m, "release", "sync-needed", id); err != nil {
			setSyncInfo(m, "blocked", "工作区同步已结束，但原子释放尚未确认；请同步恢复: "+err.Error())
			return map[string]any{"error": err.Error(), "code": "WORKSPACE_CLEANUP_FAILED"}
		}
	}
	return map[string]any{"ok": true}
}

// Every account transport reconnect checks durable handback. Normal transports
// recover only stopped exact-binding work; legacy network migration also drains
// older reservations before the callback address can change.
func recoverAccountWorkspaceTransport(parent context.Context, connection *serverConnection, pendingOnly bool) error {
	parent, timeout := context.WithTimeout(parent, workspaceSyncTimeout)
	defer timeout()
	ctx := context.WithValue(parent, workspaceRecoveryContextKey{}, true)
	ctx, cancel, err := bindWorkspaceSyncConnection(ctx)
	if err != nil {
		return err
	}
	defer cancel()
	snapshot := ctx.Value(workspaceSyncConnectionKey{}).(*workspaceSyncConnection)
	if snapshot.connection != connection {
		return fmt.Errorf("文件同步账号已改变")
	}
	var pending []*Mapping
	for _, mapping := range store.mappings() {
		if mapping.ServerID != serverIdentity(snapshot.cfg) {
			continue
		}
		if pendingOnly && (mappingTaskBusy(mapping, true) != nil || piWorkspaceOwned(mapping.ServerPath)) {
			continue
		}
		record, err := loadSyncRelease(mapping)
		if err != nil {
			if !pendingOnly {
				return err
			}
			setSyncFailure(mapping, err)
			log.Printf("[workspace-recovery] 项目 %s: %v", mapping.LocalPath, err)
			continue
		}
		state, err := remoteLeaseContext(ctx, mapping, "read", "", "")
		if err != nil {
			if !pendingOnly {
				return err
			}
			setSyncFailure(mapping, err)
			log.Printf("[workspace-recovery] 项目 %s: %v", mapping.LocalPath, err)
			continue
		}
		if record == nil && state["lease"] == nil {
			continue
		}
		if pendingOnly {
			if state["lease"] == nil && record != nil {
				// The old release may have succeeded before its reply was lost.
				// Clearing only that journal never pauses a replacement task.
				err := func() error {
					unlock, err := lockWorkspace(ctx, mapping.ServerPath)
					if err != nil {
						return err
					}
					defer unlock()
					current := store.findMappingByServer(mapping.ServerPath)
					if current == nil || current.BindingEpoch != mapping.BindingEpoch || current.ServerID != mapping.ServerID {
						return nil
					}
					latest, err := loadSyncRelease(current)
					if err != nil {
						return err
					}
					if latest == nil || latest.ID != record.ID {
						return nil
					}
					return releaseRecordedSyncLease(ctx, current, record.ID)
				}()
				if err != nil {
					setSyncFailure(mapping, err)
					log.Printf("[workspace-recovery] 项目 %s: %v", mapping.LocalPath, err)
				}
				continue
			}
			lease, valid := state["lease"].(map[string]any)
			id, _ := lease["id"].(string)
			if !valid || lease["epoch"] != mapping.BindingEpoch || id == "" ||
				(lease["owner"] != "sync-needed" && !(record != nil && lease["owner"] == "sync" && id == record.ID)) {
				continue
			}
		}
		pending = append(pending, mapping)
	}
	if pendingOnly && len(pending) == 0 {
		return nil
	}
	if err := recoverPreviewsContext(ctx); err != nil {
		for _, mapping := range pending {
			setSyncFailure(mapping, err)
		}
		return err
	}
	if !pendingOnly {
		for _, preview := range previewList() {
			if mapping := store.findMappingByServer(preview.ServerPath); mapping != nil &&
				mapping.ServerID == serverIdentity(snapshot.cfg) && mapping.BindingEpoch == preview.Epoch {
				return fmt.Errorf("项目预览仍在运行，请先在预览列表停止后重新连接文件同步")
			}
		}
	}
	for _, mapping := range pending {
		previewActive := false
		for _, preview := range previewList() {
			if preview.ServerPath == mapping.ServerPath && preview.Epoch == mapping.BindingEpoch {
				previewActive = true
				break
			}
		}
		if previewActive {
			if !pendingOnly {
				return fmt.Errorf("项目预览仍在运行，请先在预览列表停止后重新连接文件同步")
			}
			continue
		}
		if result := syncProjectWithEmptyConfirmationContext(ctx, mapping.ServerPath, ""); result["ok"] != true {
			err := fmt.Errorf("项目工作区恢复未完成: %v", result["error"])
			if !pendingOnly {
				return err
			}
			setSyncFailure(mapping, err)
			log.Printf("[workspace-recovery] 项目 %s: %v", mapping.LocalPath, err)
		}
	}
	return nil
}
