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
	head, err := gitOutputContext(ctx, m.LocalPath, "rev-parse", "--git-path", "HEAD")
	if err != nil {
		return err
	}
	if !filepath.IsAbs(head) {
		head = filepath.Join(m.LocalPath, head)
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

	// symref-update's `ref` expectation checks the raw symbolic target, even
	// when another branch resolves to the same OID. Git locks both refs before
	// committing. Do not fall back on a failed CAS or a foreign lock.
	//
	// Git's files backend also creates a HEAD reflog update for an update of
	// the checked-out branch. Including that branch and HEAD in one transaction
	// is rejected as a duplicate update, so that case uses the locked path.
	if before.Branch != "" && desired.Branch != "" && before.Branch != desired.Branch {
		transaction := "start\x00symref-update HEAD\x00" + desired.Branch + "\x00ref\x00" + before.Branch +
			"\x00update " + desired.Branch + "\x00" + desired.Head + "\x00" + old + "\x00prepare\x00commit\x00"
		_, err = gitOutputContextEnvInput(ctx, m.LocalPath, nil, []byte(transaction),
			"-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "update-ref", "--no-deref", "--stdin", "-z")
		if err == nil {
			return nil
		}
		// Symref transactions were added in Git 2.48. Detect the command, not
		// a parsed version string (vendors can backport it). A parser rejection
		// precedes prepare/commit and cannot have modified either reference.
		if !strings.Contains(err.Error(), "unknown command: symref-update") {
			return err
		}
	}
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
	lock, err := os.OpenFile(head+".lock", os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return err // In particular, never remove another process's HEAD.lock.
	}
	owned, err := lock.Stat()
	if err != nil {
		lock.Close()
		return err
	}
	defer func() {
		lock.Close()
		// Identity is checked even during error cleanup: a replacement lock
		// at the same path belongs to its new owner.
		current, statErr := os.Lstat(lock.Name())
		if statErr == nil && os.SameFile(owned, current) {
			os.Remove(lock.Name())
		}
	}()
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

	if desired.Branch != "" {
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
		if _, err = gitOutputContext(ctx, m.LocalPath, "--git-dir="+private,
			"-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "update-ref", "--no-deref", desired.Branch, desired.Head, old); err != nil {
			return err
		}
	}
	// No cancellable operation remains between branch CAS and replacing HEAD.
	// On failure the existing recovery ref and pending journal still describe
	// this partial branch update; never roll it back over an external writer.
	if err = lock.Close(); err != nil {
		return err
	}
	currentLock, err := os.Lstat(lock.Name())
	if err != nil {
		return err
	}
	if !os.SameFile(owned, currentLock) {
		return fmt.Errorf("Git HEAD 锁所有者发生改变，未覆盖")
	}
	return os.Rename(lock.Name(), head)
}
