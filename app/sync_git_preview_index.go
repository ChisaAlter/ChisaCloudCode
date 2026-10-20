package main

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// A copied split index still resolves sharedindex files relative to GIT_DIR,
// and Git freshens those files even with optional locks disabled. Only index
// commands use this minimal disposable repository; HEAD/refs/operations are
// observed separately in the original repository.
func syncGitPreviewIndexEnvironment(ctx context.Context, m *Mapping, env []string) ([]string, func(), error) {
	format, err := gitOutputContext(ctx, m.LocalPath, "rev-parse", "--show-object-format")
	if err != nil {
		return nil, nil, err
	}
	if format != "sha1" && format != "sha256" {
		return nil, nil, fmt.Errorf("不支持的 Git 对象格式: %s", format)
	}
	gitdir, err := gitOutputContext(ctx, m.LocalPath, "rev-parse", "--absolute-git-dir")
	if err != nil {
		return nil, nil, err
	}
	private, err := os.MkdirTemp("", "chisa-preview-git-*")
	if err != nil {
		return nil, nil, err
	}
	discard := func() { _ = os.RemoveAll(private) }
	fail := func(err error) ([]string, func(), error) {
		discard()
		return nil, nil, err
	}
	for _, directory := range []string{"objects", "refs"} {
		if err := os.Mkdir(filepath.Join(private, directory), 0700); err != nil {
			return fail(err)
		}
	}
	config := "[core]\nrepositoryformatversion = 1\nbare = false\n[extensions]\nobjectformat = " + format + "\n[index]\nsparse = true\n"
	sparsePath, err := gitOutputContext(ctx, m.LocalPath, "rev-parse", "--path-format=absolute", "--git-path", "info/sparse-checkout")
	if err != nil {
		return fail(err)
	}
	patterns, err := os.ReadFile(sparsePath)
	if err == nil {
		if err := os.Mkdir(filepath.Join(private, "info"), 0700); err != nil {
			return fail(err)
		}
		if err := os.WriteFile(filepath.Join(private, "info", "sparse-checkout"), patterns, 0600); err != nil {
			return fail(err)
		}
		config += "[core]\nsparseCheckout = true\nsparseCheckoutCone = true\n"
	} else if !os.IsNotExist(err) {
		return fail(err)
	}
	for name, content := range map[string]string{"HEAD": "ref: refs/heads/chisa-preview\n", "config": config} {
		if err := os.WriteFile(filepath.Join(private, name), []byte(content), 0600); err != nil {
			return fail(err)
		}
	}
	children, err := os.ReadDir(gitdir)
	if err != nil {
		return fail(err)
	}
	for _, entry := range children {
		if !strings.HasPrefix(entry.Name(), "sharedindex.") {
			continue
		}
		data, err := os.ReadFile(filepath.Join(gitdir, entry.Name()))
		if err != nil {
			return fail(err)
		}
		if err := os.WriteFile(filepath.Join(private, entry.Name()), data, 0600); err != nil {
			return fail(err)
		}
	}
	isolated := append(append([]string{}, env...), "GIT_DIR="+private, "GIT_COMMON_DIR="+private, "GIT_WORK_TREE="+m.LocalPath, "GIT_NO_LAZY_FETCH=1")
	return isolated, discard, nil
}
