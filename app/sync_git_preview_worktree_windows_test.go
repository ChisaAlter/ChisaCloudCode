//go:build windows

package main

import (
	"context"
	"path/filepath"
	"reflect"
	"testing"
)

// Linked worktrees keep their index/shared base outside the project root. Both
// the project and the owning repository must stay unchanged during preview.
func TestSyncGitPreviewLinkedWorktreeMetadataReadOnly(t *testing.T) {
	for _, split := range []bool{false, true} {
		for _, reader := range []string{"local", "worker"} {
			name := reader
			if split {
				name += "/split"
			}
			t.Run(name, func(t *testing.T) {
				m := isolatePi(t)
				tools := syncGitPreviewTools(t)
				syncGitPreviewInit(t, tools, m.LocalPath)
				owner := m.LocalPath
				linked := filepath.Join(t.TempDir(), "linked")
				tools.gitRun(t, owner, "worktree", "add", "-b", "linked/recovery", linked)
				m.LocalPath = linked
				if split {
					tools.gitRun(t, linked, "update-index", "--split-index")
				}
				expected, err := readLocalGitState(context.Background(), m)
				if err != nil {
					t.Fatal(err)
				}
				ownerBefore := readVPSQARepositorySnapshot(t, owner)
				linkedBefore := readVPSQARepositorySnapshot(t, linked)
				actual, err := syncGitPreviewState(t, tools, m, reader)
				if err != nil || actual != expected {
					t.Fatalf("linked preview got %+v, %v; want %+v", actual, err, expected)
				}
				if after := readVPSQARepositorySnapshot(t, owner); !reflect.DeepEqual(ownerBefore, after) {
					t.Fatal("owning repository", describeVPSQASnapshotChanges(ownerBefore, after))
				}
				if after := readVPSQARepositorySnapshot(t, linked); !reflect.DeepEqual(linkedBefore, after) {
					t.Fatal("linked worktree", describeVPSQASnapshotChanges(linkedBefore, after))
				}
			})
		}
	}
}
