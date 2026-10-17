package main

import (
	"bytes"
	"context"
	_ "embed"
	"encoding/json"
	"fmt"
	"github.com/mutagen-io/mutagen/pkg/filesystem/locking"
	"os"
	"path/filepath"
	"strings"
)

// A checkpoint is the Git part of the same file synchronization, not a second
// repository. Index trees preserve staged edits without copying OS-specific indexes.
type syncGitState struct {
	Head   string `json:"head"`
	Branch string `json:"branch"`
	Index  string `json:"index"`
}

type syncGitPending struct {
	Local   syncGitState `json:"local"`
	Remote  syncGitState `json:"remote"`
	Desired syncGitState `json:"desired"`
}

type syncGitCheckpoint struct {
	Root      string          `json:"root"`
	LocalPath string          `json:"localPath"`
	Epoch     string          `json:"epoch"`
	State     syncGitState    `json:"state"`
	Pending   *syncGitPending `json:"pending,omitempty"`
}

type syncGitSourceKey struct{}

func syncGitCheckpointPath(m *Mapping) string {
	return filepath.Join(dataDir(), "sync-git", syncReleaseName(m)+".json")
}

func loadGitCheckpoint(m *Mapping) (*syncGitCheckpoint, error) {
	r := &syncGitCheckpoint{Root: m.ServerPath, LocalPath: m.LocalPath, Epoch: m.BindingEpoch}
	b, err := os.ReadFile(syncGitCheckpointPath(m))
	if os.IsNotExist(err) {
		return r, nil
	}
	if err != nil {
		return nil, err
	}
	if err = json.Unmarshal(b, r); err != nil {
		return nil, err
	}
	if r.Root != m.ServerPath || r.LocalPath != m.LocalPath || r.Epoch != m.BindingEpoch {
		return nil, fmt.Errorf("Git 同步记录不属于当前项目绑定")
	}
	return r, nil
}

func saveGitCheckpoint(m *Mapping, r *syncGitCheckpoint) error {
	file := syncGitCheckpointPath(m)
	if err := os.MkdirAll(filepath.Dir(file), 0700); err != nil {
		return err
	}
	b, err := json.Marshal(r)
	if err != nil {
		return err
	}
	f, err := os.CreateTemp(filepath.Dir(file), ".git-sync-*")
	if err != nil {
		return err
	}
	defer os.Remove(f.Name())
	if _, err = f.Write(b); err == nil {
		err = f.Sync()
	}
	closeErr := f.Close()
	if err != nil {
		return err
	}
	if closeErr != nil {
		return closeErr
	}
	return os.Rename(f.Name(), file)
}

func readLocalGitState(ctx context.Context, m *Mapping) (s syncGitState, err error) {
	_, guard, err := gitIndexGuard(ctx, m)
	if err != nil {
		return s, err
	}
	defer guard.Close()

	if s.Head, err = gitOutputContext(ctx, m.LocalPath, "rev-parse", "--verify", "HEAD^{commit}"); err != nil {
		return
	}
	s.Branch, err = gitOutputContext(ctx, m.LocalPath, "symbolic-ref", "--quiet", "HEAD")
	if gitExitCode(err) == 1 {
		err = nil
	}
	if err != nil {
		return
	}
	s.Index, err = gitOutputContext(ctx, m.LocalPath, "write-tree")
	return
}

// The OS lock is released on process death. A hard link proves whether a
// surviving index.lock is ours; an unrelated Git lock is never removed.
func gitIndexGuard(ctx context.Context, m *Mapping) (string, *locking.Locker, error) {
	index, err := gitOutputContext(ctx, m.LocalPath, "rev-parse", "--git-path", "index")
	if err != nil {
		return "", nil, err
	}
	if !filepath.IsAbs(index) {
		index = filepath.Join(m.LocalPath, index)
	}
	guard, err := locking.NewLocker(index+".chisa-guard", 0600)
	if err != nil {
		return "", nil, err
	}
	if err = guard.Lock(false); err != nil {
		guard.Close()
		return "", nil, err
	}
	if err = removeOwnedIndexLock(index); err != nil {
		guard.Close()
		return "", nil, err
	}
	return index, guard, nil
}

func removeOwnedIndexLock(index string) error {
	owned, err := os.Stat(index + ".chisa-owned")
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return err
	}
	current, err := os.Stat(index + ".lock")
	if err != nil && !os.IsNotExist(err) {
		return err
	}
	if err == nil && os.SameFile(owned, current) {
		if err = os.Remove(index + ".lock"); err != nil {
			return err
		}
	}
	return os.Remove(index + ".chisa-owned")
}

func readRemoteGitState(ctx context.Context, m *Mapping) (syncGitState, error) {
	q, _ := json.Marshal(map[string]any{"root": m.ServerPath, "op": "read"})
	out, err := syncRemoteScript(ctx, m, "setpriv --reuid=1000 --regid=1000 --clear-groups env HOME=/nonexistent python3 -c "+shellQuote(syncGitApplyWorker), bytes.NewReader(q))
	if err != nil {
		return syncGitState{}, err
	}
	var state syncGitState
	err = json.Unmarshal([]byte(out), &state)
	return state, err
}

// Restart may observe any prefix of updating the ref, HEAD, and index. Only the
// journaled transition is resumable; unrelated edits are never treated as recovery.
func gitTransitionMatches(s, before, after syncGitState) bool {
	return (s.Head == before.Head || s.Head == after.Head) &&
		(s.Branch == before.Branch || s.Branch == after.Branch) &&
		(s.Index == before.Index || s.Index == after.Index)
}

func selectGitState(ctx context.Context, m *Mapping, r *syncGitCheckpoint, local, remote syncGitState) (syncGitState, error) {
	if r.Pending != nil {
		p := r.Pending
		if gitTransitionMatches(local, p.Local, p.Desired) && gitTransitionMatches(remote, p.Remote, p.Desired) {
			return p.Desired, nil
		}
		return syncGitState{}, fmt.Errorf("上次 Git 同步未完成后又有新修改；已保留两端，请先核对修改")
	}
	if local == remote {
		return local, nil
	}
	if r.State.Head != "" {
		if local == r.State {
			return remote, nil
		}
		if remote == r.State {
			return local, nil
		}
		return syncGitState{}, fmt.Errorf("两端在上次同步后都更改了分支、提交或暂存区；已保留双方修改")
	}
	// Upgrade from the old file-only checkpoint. Ownership identifies the side
	// returning its workspace, including a branch switch to an unrelated commit.
	source, _ := ctx.Value(syncGitSourceKey{}).(string)
	if source != "" {
		receiver, desired := local, remote
		if source == "local" {
			receiver, desired = remote, local
		}
		tree, err := gitOutputContext(ctx, m.LocalPath, "rev-parse", receiver.Head+"^{tree}")
		if err != nil {
			return syncGitState{}, err
		}
		if receiver.Index != tree && receiver.Index != desired.Index {
			return syncGitState{}, fmt.Errorf("接收端存在独立暂存修改，已保留两端，未覆盖")
		}
		return desired, nil
	}
	if local.Branch != remote.Branch {
		return syncGitState{}, fmt.Errorf("首次 Git 状态同步无法确定分支切换方向；已保留两端")
	}

	if local.Head == remote.Head {
		tree, err := gitOutputContext(ctx, m.LocalPath, "rev-parse", local.Head+"^{tree}")
		if err != nil {
			return syncGitState{}, err
		}
		if local.Index == tree {
			return remote, nil
		}
		if remote.Index == tree {
			return local, nil
		}
	} else {
		for _, pair := range [][2]syncGitState{{local, remote}, {remote, local}} {
			_, err := gitOutputContext(ctx, m.LocalPath, "merge-base", "--is-ancestor", pair[0].Head, pair[1].Head)
			if err == nil {
				tree, e := gitOutputContext(ctx, m.LocalPath, "rev-parse", pair[0].Head+"^{tree}")
				if e != nil {
					return syncGitState{}, e
				}
				if pair[0].Index == tree {
					return pair[1], nil
				}
				break
			}
			if gitExitCode(err) != 1 {
				return syncGitState{}, err
			}
		}
	}
	return syncGitState{}, fmt.Errorf("两端 Git 提交或暂存修改存在冲突；已保留双方修改")
}

func localGitSnapshot(ctx context.Context, m *Mapping, s syncGitState, ref string) (string, error) {
	commit, err := gitOutputContext(ctx, m.LocalPath, "-c", "user.name=Chisa Sync", "-c", "user.email=sync@localhost", "commit-tree", s.Index, "-p", s.Head, "-m", "Chisa sync recovery: "+s.Branch)
	if err != nil {
		return "", err
	}
	_, err = gitOutputContext(ctx, m.LocalPath, "update-ref", ref, commit)
	return commit, err
}

func remoteGitSnapshot(ctx context.Context, m *Mapping, s syncGitState, ref string) (string, error) {
	return syncRemoteScript(ctx, m, "set -e\ncommit=$("+serverGit(m, "-c", "user.name=Chisa Sync", "-c", "user.email=sync@localhost", "commit-tree", s.Index, "-p", s.Head, "-m", "Chisa sync recovery: "+s.Branch)+")\n"+serverGit(m, "update-ref", ref)+" \"$commit\"\nprintf '%s' \"$commit\"", nil)
}

// Preserve an inactive branch's independent history and any worktree that is
// already using it. The returned tip is also the compare-and-swap expectation.
func localGitTarget(ctx context.Context, m *Mapping, before, desired syncGitState) (string, error) {
	if desired.Branch == "" {
		return "", nil
	}
	worktrees, err := gitOutputContext(ctx, m.LocalPath, "worktree", "list", "--porcelain", "-z")
	if err != nil {
		return "", err
	}
	root, err := filepath.EvalSymlinks(m.LocalPath)
	if err != nil {
		return "", err
	}
	for _, record := range strings.Split(worktrees, "\x00\x00") {
		worktree, branch := "", ""
		for _, field := range strings.Split(record, "\x00") {
			if path, ok := strings.CutPrefix(field, "worktree "); ok {
				worktree = path
			}
			if ref, ok := strings.CutPrefix(field, "branch "); ok {
				branch = ref
			}
		}
		if branch != desired.Branch {
			continue
		}
		resolved, err := filepath.EvalSymlinks(worktree)
		if err != nil {
			return "", fmt.Errorf("无法确认目标分支使用的工作树: %w", err)
		}
		if norm(resolved) != norm(root) {
			return "", fmt.Errorf("目标 Git 分支正在其他工作树中使用，已保留其历史")
		}
	}
	old, err := gitOutputContext(ctx, m.LocalPath, "rev-parse", "--verify", "--quiet", desired.Branch)
	if gitExitCode(err) == 1 {
		return strings.Repeat("0", len(desired.Head)), nil
	}
	if err != nil {
		return "", err
	}
	if desired.Branch != before.Branch && old != desired.Head {
		if _, err := gitOutputContext(ctx, m.LocalPath, "merge-base", "--is-ancestor", old, desired.Head); err != nil {
			if gitExitCode(err) == 1 {
				return "", fmt.Errorf("目标 Git 分支包含独立提交，已保留其历史，请先处理分支冲突")
			}
			return "", err
		}
	}
	return old, nil
}

func applyLocalGitState(ctx context.Context, m *Mapping, before, desired syncGitState) error {
	index, guard, err := gitIndexGuard(ctx, m)
	if err != nil {
		return err
	}
	defer guard.Close()
	lock, err := os.OpenFile(index+".chisa-owned", os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return err
	}
	defer func() { lock.Close(); removeOwnedIndexLock(index) }()
	if err = os.Link(lock.Name(), index+".lock"); err != nil {
		return err
	}

	content, err := os.ReadFile(index)
	if err != nil {
		return err
	}
	temporary, err := os.CreateTemp(filepath.Dir(index), "chisa-index-*")
	if err != nil {
		return err
	}
	defer os.Remove(temporary.Name())
	if _, err = temporary.Write(content); err != nil {
		temporary.Close()
		return err
	}
	if err = temporary.Close(); err != nil {
		return err
	}
	env := []string{"GIT_INDEX_FILE=" + temporary.Name()}
	current := syncGitState{}
	current.Head, err = gitOutputContext(ctx, m.LocalPath, "rev-parse", "--verify", "HEAD^{commit}")
	if err != nil {
		return err
	}
	current.Branch, err = gitOutputContext(ctx, m.LocalPath, "symbolic-ref", "--quiet", "HEAD")
	if err != nil && gitExitCode(err) != 1 {
		return err
	}
	current.Index, err = gitOutputContextEnv(ctx, m.LocalPath, env, "write-tree")
	if err != nil {
		return err
	}
	if current != before {
		return fmt.Errorf("同步期间本地 Git 状态发生改变，未覆盖")
	}
	old, err := localGitTarget(ctx, m, before, desired)
	if err != nil {
		return err
	}
	if _, err = gitOutputContextEnv(ctx, m.LocalPath, env, "read-tree", desired.Index); err != nil {
		return err
	}

	backup := "refs/chisa/recovery/" + randHex(16)
	if _, err = localGitSnapshot(ctx, m, before, backup); err != nil {
		return err
	}
	if desired.Branch != "" {
		if strings.Trim(old, "0") != "" && old != desired.Head {
			if _, err = gitOutputContext(ctx, m.LocalPath, "update-ref", backup+"-branch", old); err != nil {
				return err
			}
		}
		if _, err = gitOutputContext(ctx, m.LocalPath, "update-ref", desired.Branch, desired.Head, old); err != nil {
			return err
		}
		if _, err = gitOutputContext(ctx, m.LocalPath, "symbolic-ref", "HEAD", desired.Branch); err != nil {
			return err
		}
	} else {
		if _, err = gitOutputContext(ctx, m.LocalPath, "update-ref", "--no-deref", "HEAD", desired.Head, before.Head); err != nil {
			return err
		}
	}
	// Deliberately omit -u: Mutagen owns worktree bytes, including untracked files.
	content, err = os.ReadFile(temporary.Name())
	if err != nil {
		return err
	}
	if _, err = lock.Write(content); err != nil {
		return err
	}
	if err = lock.Sync(); err != nil {
		return err
	}
	if err = lock.Close(); err != nil {
		return err
	}
	return os.Rename(index+".lock", index)
}

//go:embed resources/sync_git_apply.py
var syncGitApplyWorker string

func applyRemoteGitState(ctx context.Context, m *Mapping, before, desired syncGitState) error {
	q, err := json.Marshal(map[string]any{"root": m.ServerPath, "before": before, "desired": desired, "backup": "refs/chisa/recovery/" + randHex(16)})
	if err != nil {
		return err
	}
	_, err = syncRemoteScript(ctx, m, "setpriv --reuid=1000 --regid=1000 --clear-groups env HOME=/nonexistent python3 -c "+shellQuote(syncGitApplyWorker), bytes.NewReader(q))
	return err
}

func syncGitStateContext(ctx context.Context, m *Mapping) error {
	local, err := readLocalGitState(ctx, m)
	if err != nil {
		return err
	}
	remote, err := readRemoteGitState(ctx, m)
	if err != nil {
		return err
	}
	r, err := loadGitCheckpoint(m)
	if err != nil {
		return err
	}
	cfg := workspaceSyncConfig(ctx)
	url := cfg.SSHUser + "@" + cfg.SSHHost + ":" + m.ServerPath
	// Fetch the server HEAD even when it is not an ancestor of the local branch.
	if local.Head != remote.Head {
		if _, err = gitOutputContext(ctx, m.LocalPath, "fetch", "--no-tags", "--upload-pack=setpriv --reuid=1000 --regid=1000 --clear-groups env HOME=/nonexistent git -c core.hooksPath=/dev/null -c core.fsmonitor=false upload-pack", url, "HEAD"); err != nil {
			return err
		}
	}
	desired, err := selectGitState(ctx, m, r, local, remote)
	if err != nil {
		return err
	}
	if local == remote && local == desired {
		r.State, r.Pending = desired, nil
		return saveGitCheckpoint(m, r)
	}
	// Transfer a temporary commit whose tree is the staged snapshot and whose
	// parent is the actual HEAD. Neither user's branch receives this commit.
	ref := "refs/chisa/transfer/" + randHex(16)
	if desired == remote {
		if _, err = remoteGitSnapshot(ctx, m, desired, ref); err != nil {
			return err
		}
		if _, err = gitOutputContext(ctx, m.LocalPath, "fetch", "--no-tags", "--upload-pack=setpriv --reuid=1000 --regid=1000 --clear-groups env HOME=/nonexistent git -c core.hooksPath=/dev/null -c core.fsmonitor=false upload-pack", url, ref); err != nil {
			return err
		}
	} else {
		if _, err = localGitSnapshot(ctx, m, desired, ref); err != nil {
			return err
		}
		receive, e := syncRemoteJobCommand(ctx, m, "receive-pack", "")
		if e != nil {
			return e
		}
		if _, err = gitOutputContext(ctx, m.LocalPath, "push", "--receive-pack="+receive, url, ref+":"+ref); err != nil {
			return err
		}
	}
	if r.Pending == nil {
		r.Pending = &syncGitPending{Local: local, Remote: remote, Desired: desired}
	}
	if err = saveGitCheckpoint(m, r); err != nil {
		return err
	}
	if local != desired {
		if err = applyLocalGitState(ctx, m, local, desired); err != nil {
			return err
		}
	}
	if remote != desired {
		if err = applyRemoteGitState(ctx, m, remote, desired); err != nil {
			return err
		}
	}
	r.State, r.Pending = desired, nil
	return saveGitCheckpoint(m, r)
}
