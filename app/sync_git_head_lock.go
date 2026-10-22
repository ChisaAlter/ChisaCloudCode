package main

import (
	"context"
	"fmt"
	"os"
	"path/filepath"

	"github.com/mutagen-io/mutagen/pkg/filesystem/locking"
)

// The kernel guard is released on death. The durable hard link proves exact
// ownership of HEAD.lock even if the process never reaches its cleanup. Marker
// contents are never rewritten during recovery: after publication it may also
// be a hard link to the live HEAD itself.
func syncGitHeadGuard(head string) (*locking.Locker, error) {
	guard, err := locking.NewLocker(head+".chisa-guard", 0600)
	if err != nil {
		return nil, err
	}
	if err = guard.Lock(false); err != nil {
		guard.Close()
		return nil, err
	}
	if err = removeOwnedGitHeadLock(head); err != nil {
		guard.Close()
		return nil, err
	}
	return guard, nil
}

func removeOwnedGitHeadLock(head string) error {
	return removeGitHeadLockOwner(head, nil)
}

func removeGitHeadLockOwner(head string, expected os.FileInfo) error {
	marker := head + ".chisa-owned"
	owned, err := os.Lstat(marker)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return err
	}
	if !owned.Mode().IsRegular() {
		return fmt.Errorf("Git HEAD 锁所有权记录不是普通文件，已保留")
	}
	if expected != nil && !os.SameFile(expected, owned) {
		return fmt.Errorf("Git HEAD 锁所有权记录已被替换，已保留")
	}
	current, err := os.Lstat(head + ".lock")
	if err != nil && !os.IsNotExist(err) {
		return err
	}
	if err == nil && current.Mode().IsRegular() && os.SameFile(owned, current) {
		if err = os.Remove(head + ".lock"); err != nil {
			return err
		}
	}
	// A foreign replacement at HEAD.lock remains in place. Only unlink our
	// original marker, including the marker-only prefix before lock publication
	// or after HEAD publication; do not truncate a link to the installed HEAD.
	latest, err := os.Lstat(marker)
	if err != nil {
		return err
	}
	if !os.SameFile(owned, latest) {
		return fmt.Errorf("Git HEAD 锁所有权记录发生改变，已保留")
	}
	return os.Remove(marker)
}

func localGitHeadPath(ctx context.Context, m *Mapping) (string, error) {
	head, err := gitOutputContext(ctx, m.LocalPath, "rev-parse", "--git-path", "HEAD")
	if err != nil {
		return "", err
	}
	if !filepath.IsAbs(head) {
		head = filepath.Join(m.LocalPath, head)
	}
	return head, nil
}

// Non-preview guarded reads recover before comparing portable state. A no-op
// transition must clean an interrupted owned lock too; it cannot skip this by
// observing both endpoints already equal to the desired checkpoint.
func recoverLocalGitHeadLock(ctx context.Context, m *Mapping) error {
	head, err := localGitHeadPath(ctx, m)
	if err != nil {
		return err
	}
	guard, err := syncGitHeadGuard(head)
	if err != nil {
		return err
	}
	defer guard.Close()
	if _, err = os.Lstat(head + ".lock"); err == nil {
		return fmt.Errorf("Git HEAD 正在写入，请等待操作完成后重试")
	} else if !os.IsNotExist(err) {
		return err
	}
	return nil
}
