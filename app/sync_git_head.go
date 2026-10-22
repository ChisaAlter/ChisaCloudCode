package main

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// syncGitHeadBeforeLockKey permits deterministic races after observing HEAD but
// before either Git's transaction or our HEAD.lock acquires it. Production
// callers do not supply this context value.
type syncGitHeadBeforeLockKey struct{}

// Child-process crash regressions stop only at completed real filesystem/CAS
// boundaries. Production callers never supply this context value.
type syncGitHeadLockStageKey struct{}

// applyLocalGitHead installs only HEAD and the desired branch tip. The caller
// retains index/operation locking, target/worktree validation, recovery refs,
// and the pending journal. old is the exact target tip from localGitTarget
// (all zeroes if absent), not the previously resolved HEAD unless they coincide.
func applyLocalGitHead(ctx context.Context, m *Mapping, before, desired syncGitState, old string) error {
	if !syncGitHeadOID(before.Head) || !syncGitHeadOID(desired.Head) {
		return fmt.Errorf("无效的 Git HEAD 提交")
	}
	for _, branch := range []string{before.Branch, desired.Branch} {
		if branch != "" {
			if !strings.HasPrefix(branch, "refs/heads/") {
				return fmt.Errorf("无效的 Git HEAD 分支")
			}
			if _, err := gitOutputContext(ctx, m.LocalPath, "check-ref-format", branch); err != nil {
				return err
			}
		}
	}
	if desired.Branch != "" {
		if old == "" {
			old = strings.Repeat("0", len(desired.Head))
		}
		if !syncGitHeadOID(old) || len(old) != len(desired.Head) {
			return fmt.Errorf("无效的 Git 目标分支比较值")
		}
	} else {
		// The locked path writes HEAD directly, so retain update-ref's object
		// validation before publishing a detached commit.
		kind, err := gitOutputContext(ctx, m.LocalPath, "cat-file", "-t", desired.Head)
		if err != nil {
			return err
		}
		if kind != "commit" {
			return fmt.Errorf("Git HEAD 目标不是提交")
		}
	}
	head, err := localGitHeadPath(ctx, m)
	if err != nil {
		return err
	}
	observed, err := os.ReadFile(head)
	if err != nil {
		return err
	}
	if !syncGitHeadMatches(observed, before) {
		return fmt.Errorf("同步期间本地 Git HEAD 发生改变，未覆盖")
	}
	if hook, _ := ctx.Value(syncGitHeadBeforeLockKey{}).(func()); hook != nil {
		hook()
	}

	// Own every HEAD write through the same durable lock protocol, including
	// branch switches on Git versions supporting symref-update. Letting Git
	// create HEAD.lock inside a transaction would leave no exact ownership proof
	// if the process were killed. The pending journal resumes the branch-CAS /
	// HEAD-publication prefix; raw HEAD identity is rechecked under our lock.
	return applyLocalGitHeadLocked(ctx, m, before, desired, old, head, observed)
}

func syncGitHeadOID(oid string) bool {
	if len(oid) != 40 && len(oid) != 64 {
		return false
	}
	for _, c := range oid {
		if !(c >= '0' && c <= '9' || c >= 'a' && c <= 'f') {
			return false
		}
	}
	return true
}

func syncGitHeadMatches(raw []byte, state syncGitState) bool {
	value := strings.TrimSuffix(strings.TrimSuffix(string(raw), "\n"), "\r")
	if state.Branch != "" {
		return value == "ref: "+state.Branch
	}
	return value == state.Head
}

func applyLocalGitHeadLocked(ctx context.Context, m *Mapping, before, desired syncGitState, old, head string, observed []byte) error {
	guard, err := syncGitHeadGuard(head)
	if err != nil {
		return err
	}
	defer guard.Close()
	// Publish the proof before the lock: a kill at either boundary is safely
	// recoverable. Never create HEAD.lock and then try to establish ownership.
	lock, err := os.OpenFile(head+".chisa-owned", os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return err
	}
	owned, err := lock.Stat()
	if err != nil {
		lock.Close()
		return err
	}
	defer func() { lock.Close(); removeGitHeadLockOwner(head, owned) }()
	if err = os.Link(lock.Name(), head+".lock"); err != nil {
		return err // In particular, never remove another process's HEAD.lock.
	}
	if hook, _ := ctx.Value(syncGitHeadLockStageKey{}).(func(string)); hook != nil {
		hook("locked")
	}
	current, err := os.ReadFile(head)
	if err != nil {
		return err
	}
	if string(current) != string(observed) || !syncGitHeadMatches(current, before) {
		return fmt.Errorf("同步期间本地 Git HEAD 发生改变，未覆盖")
	}
	resolved, err := gitOutputContext(ctx, m.LocalPath, "rev-parse", "--verify", "HEAD^{commit}")
	if err != nil {
		return err
	}
	if resolved != before.Head {
		return fmt.Errorf("同步期间本地 Git HEAD 提交发生改变，未覆盖")
	}
	if err = ctx.Err(); err != nil {
		return err
	}
	value := desired.Head + "\n"
	if desired.Branch != "" {
		value = "ref: " + desired.Branch + "\n"
	}
	if _, err = lock.WriteString(value); err != nil {
		return err
	}
	if err = lock.Sync(); err != nil {
		return err
	}

	if err = func() error {
		if desired.Branch == "" {
			return nil
		}
		// A normal update-ref of a checked-out branch tries to acquire
		// HEAD.lock for its reflog, even with --no-deref. A private detached
		// Git dir shares the same objects/refs through commondir, allowing
		// Git to perform the exact branch OID CAS without touching real HEAD.
		common, commonErr := gitOutputContext(ctx, m.LocalPath, "rev-parse", "--git-common-dir")
		if commonErr != nil {
			return commonErr
		}
		if !filepath.IsAbs(common) {
			common = filepath.Join(m.LocalPath, common)
		}
		private, privateErr := os.MkdirTemp(filepath.Dir(head), "chisa-head-*")
		if privateErr != nil {
			return privateErr
		}
		defer os.RemoveAll(private)
		if err = os.WriteFile(filepath.Join(private, "HEAD"), []byte(before.Head+"\n"), 0600); err != nil {
			return err
		}
		if err = os.WriteFile(filepath.Join(private, "commondir"), []byte(filepath.ToSlash(common)+"\n"), 0600); err != nil {
			return err
		}
		_, err = gitOutputContext(ctx, m.LocalPath, "--git-dir="+private,
			"-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "update-ref", "--no-deref", desired.Branch, desired.Head, old)
		return err
	}(); err != nil {
		return err
	}
	if hook, _ := ctx.Value(syncGitHeadLockStageKey{}).(func(string)); hook != nil {
		hook("cas")
	}
	// No cancellable operation remains between branch CAS and replacing HEAD.
	// On failure the existing recovery ref and pending journal still describe
	// this partial branch update; never roll it back over an external writer.
	if err = lock.Close(); err != nil {
		return err
	}
	currentLock, err := os.Lstat(head + ".lock")
	if err != nil {
		return err
	}
	if !currentLock.Mode().IsRegular() || !os.SameFile(owned, currentLock) {
		return fmt.Errorf("Git HEAD 锁所有者发生改变，未覆盖")
	}
	if err = os.Rename(head+".lock", head); err != nil {
		return err
	}
	if hook, _ := ctx.Value(syncGitHeadLockStageKey{}).(func(string)); hook != nil {
		hook("published")
	}
	return nil
}
