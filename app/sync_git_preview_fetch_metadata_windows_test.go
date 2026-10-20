//go:build windows

package main

import (
	"context"
	"path/filepath"
	"reflect"
	"testing"
)

// Production recovery can have different HEADs. Object discovery/fetch must
// leave existing loose objects and repository metadata unchanged as well.
func TestSyncGitPreviewFetchMetadataReadOnly(t *testing.T) {
	m := isolatePi(t)
	tools := syncGitPreviewTools(t)
	syncGitPreviewInit(t, tools, m.LocalPath)
	other := t.TempDir()
	tools.gitRun(t, other, "clone", "--no-hardlinks", m.LocalPath, ".")
	syncSeedWrite(t, other, "tracked.txt", "remote commit\n")
	tools.gitRun(t, other, "commit", "-am", "remote commit")
	head := tools.gitRun(t, other, "rev-parse", "HEAD")
	before := readVPSQARepositorySnapshot(t, m.LocalPath)
	ctx := context.WithValue(context.Background(), syncGitPreviewKey{}, true)
	ctx, discard, err := syncGitPreviewObjectsContext(ctx, m)
	if err != nil {
		t.Fatal(err)
	}
	defer discard()
	if _, err := gitOutputContext(ctx, m.LocalPath, "fetch", "--no-tags", "--no-write-fetch-head", "--no-auto-maintenance", filepath.ToSlash(other), "HEAD"); err != nil {
		t.Fatal(err)
	}
	if kind, err := gitOutputContext(ctx, m.LocalPath, "cat-file", "-t", head); err != nil || kind != "commit" {
		t.Fatalf("private fetch lost commit: %q %v", kind, err)
	}
	if _, err := readLocalGitState(ctx, m); err != nil {
		t.Fatal(err)
	}
	discard()
	if after := readVPSQARepositorySnapshot(t, m.LocalPath); !reflect.DeepEqual(before, after) {
		t.Fatal(describeVPSQASnapshotChanges(before, after))
	}
}
