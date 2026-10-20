package main

import (
	"context"
	"maps"
	"os"
	"path/filepath"
	"testing"

	"github.com/mutagen-io/mutagen/pkg/synchronization/core/ignore"
)

func TestReadOnlyIgnoreCacheStillObservesMetadataAndNewPathTypes(t *testing.T) {
	for _, change := range []string{"unchanged", "same-size-restored-mtime", "new-visible", "new-ignored", "file-to-ignored-directory"} {
		t.Run(change, func(t *testing.T) {
			f := readOnlySyncTestFixture(t)
			f.session.Ignore.Paths = []string{"ignored", "directory-only/"}
			piWorkspaceWrite(t, f.mapping.LocalPath, "directory-only", "file remains visible")
			before, previous, err := captureReadOnlyWorkspaceSession(context.Background(), f.mapping, *f.session, nil)
			if err != nil {
				t.Fatal(err)
			}
			wantChanged := change != "unchanged" && change != "new-ignored"
			switch change {
			case "same-size-restored-mtime":
				name := filepath.Join(f.mapping.LocalPath, "source.txt")
				info, err := os.Stat(name)
				if err != nil {
					t.Fatal(err)
				}
				piWorkspaceWrite(t, f.mapping.LocalPath, "source.txt", "other dirty source")
				if err := os.Chtimes(name, info.ModTime(), info.ModTime()); err != nil {
					t.Fatal(err)
				}
			case "new-visible":
				piWorkspaceWrite(t, f.mapping.LocalPath, "new.txt", "new visible source")
			case "new-ignored":
				piWorkspaceWrite(t, f.mapping.LocalPath, "ignored/secret.txt", "ignored contents")
			case "file-to-ignored-directory":
				if err := os.Remove(filepath.Join(f.mapping.LocalPath, "directory-only")); err != nil {
					t.Fatal(err)
				}
				piWorkspaceWrite(t, f.mapping.LocalPath, "directory-only/secret.txt", "ignored directory contents")
			}
			current, next, err := captureReadOnlyWorkspaceSession(context.Background(), f.mapping, *f.session, previous)
			if err != nil || (!maps.Equal(before.files, current.files)) != wantChanged {
				t.Fatalf("cached ignore decisions replaced fresh metadata: wantChanged=%t error=%v", wantChanged, err)
			}
			if change == "new-visible" {
				key := ignore.IgnoreCacheKey{Path: "new.txt", Directory: false}
				if _, existed := previous[key]; existed {
					t.Fatal("new path was not a real cache miss")
				}
				if value, seen := next[key]; !seen || value.Status == ignore.IgnoreStatusIgnored {
					t.Fatal("new path was not evaluated and observed")
				}
			}
			if change == "new-ignored" || change == "file-to-ignored-directory" {
				path := "ignored"
				if change == "file-to-ignored-directory" {
					path = "directory-only"
				}
				key := ignore.IgnoreCacheKey{Path: path, Directory: true}
				if _, existed := previous[key]; existed {
					t.Fatal("new directory type reused an old file decision")
				}
				if value, seen := next[key]; !seen || value.Status != ignore.IgnoreStatusIgnored {
					t.Fatal("new directory did not run its directory-sensitive ignore rule")
				}
			}
		})
	}
}

func TestReadOnlyIgnoreCacheStillObservesGitHeadBranchAndIndex(t *testing.T) {
	for _, change := range []string{"head", "branch", "index"} {
		t.Run(change, func(t *testing.T) {
			f := readOnlySyncTestFixture(t)
			git := func(args ...string) {
				t.Helper()
				if _, err := gitOutputContext(context.Background(), f.mapping.LocalPath, args...); err != nil {
					t.Fatal(err)
				}
			}
			git("init", "-b", "main")
			git("config", "user.name", "Read-only QA")
			git("config", "user.email", "readonly-qa@localhost")
			git("add", "source.txt")
			git("commit", "-m", "baseline")
			before, cache, err := captureReadOnlyWorkspaceSession(context.Background(), f.mapping, *f.session, nil)
			if err != nil {
				t.Fatal(err)
			}
			if changed, err := readOnlyWorkspaceChanged(context.Background(), f.mapping, before, cache); changed || err != nil {
				t.Fatalf("unchanged Git state was rejected: changed=%t error=%v", changed, err)
			}
			switch change {
			case "head":
				git("commit", "--allow-empty", "-m", "new HEAD")
			case "branch":
				git("checkout", "-b", "same-tree-new-branch")
			case "index":
				git("update-index", "--chmod=+x", "source.txt")
			}
			if changed, err := readOnlyWorkspaceChanged(context.Background(), f.mapping, before, cache); !changed || err != nil {
				t.Fatalf("ignore cache hid a Git state change: changed=%t error=%v", changed, err)
			}
		})
	}
}

func TestReadOnlyIgnoreCacheRejectsDifferentSessionOrIgnoreConfiguration(t *testing.T) {
	for _, change := range []string{"session", "unpaused", "VCS", "path-in-place", "path-order"} {
		t.Run(change, func(t *testing.T) {
			f := readOnlySyncTestFixture(t)
			f.session.Ignore.Paths = []string{"ignored-a", "ignored-b"}
			before, cache, err := captureReadOnlyWorkspaceSession(context.Background(), f.mapping, *f.session, nil)
			if err != nil {
				t.Fatal(err)
			}
			switch change {
			case "session":
				f.session.Identifier = "replacement-engine"
			case "unpaused":
				f.session.Paused = false
			case "VCS":
				f.session.Ignore.VCS = false
			case "path-in-place":
				f.session.Ignore.Paths[0] = "replacement-rule"
			case "path-order":
				f.session.Ignore.Paths[0], f.session.Ignore.Paths[1] = f.session.Ignore.Paths[1], f.session.Ignore.Paths[0]
			}
			if changed, _ := readOnlyWorkspaceChanged(context.Background(), f.mapping, before, cache); !changed {
				t.Fatal("different session/configuration reused prepared ignore decisions")
			}
		})
	}
}
