//go:build windows

package main

import (
	"context"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"testing"
)

// Run without SSH to isolate preview effects from any background file engine.
func TestSyncGitPreviewMetadataReadOnly(t *testing.T) {
	for _, scenario := range []string{"clean", "staged-operation", "split-index", "sparse-index", "sha256", "promisor"} {
		for _, reader := range []string{"local", "worker"} {
			t.Run(scenario+"/"+reader, func(t *testing.T) {
				m := isolatePi(t)
				tools := syncGitPreviewTools(t)
				if scenario == "sha256" {
					tools.gitRun(t, m.LocalPath, "init", "--object-format=sha256", "-b", "main")
				}
				syncGitPreviewInit(t, tools, m.LocalPath)
				tools.gitRun(t, m.LocalPath, "checkout", "-b", "local/recovery")
				if scenario == "split-index" {
					tools.gitRun(t, m.LocalPath, "update-index", "--split-index")
				}
				if scenario == "sparse-index" {
					syncSeedWrite(t, m.LocalPath, "kept/file.txt", "kept\n")
					syncSeedWrite(t, m.LocalPath, "excluded/file.txt", "excluded\n")
					tools.gitRun(t, m.LocalPath, "add", ".")
					tools.gitRun(t, m.LocalPath, "commit", "-m", "sparse directories")
					tools.gitRun(t, m.LocalPath, "sparse-checkout", "set", "--sparse-index", "kept")
				}
				if scenario == "staged-operation" {
					syncSeedWrite(t, m.LocalPath, "tracked.txt", "staged\n")
					tools.gitRun(t, m.LocalPath, "add", "tracked.txt")
					syncSeedWrite(t, m.LocalPath, "tracked.txt", "unstaged\n")
					head := tools.gitRun(t, m.LocalPath, "rev-parse", "HEAD")
					syncSeedWrite(t, m.LocalPath, ".git/CHERRY_PICK_HEAD", head+"\n")
				}
				expected, err := readLocalGitState(context.Background(), m)
				if err != nil {
					t.Fatal(err)
				}
				if scenario == "promisor" {
					remote := t.TempDir()
					tools.gitRun(t, remote, "clone", "--bare", "--no-hardlinks", m.LocalPath, ".")
					tools.gitRun(t, m.LocalPath, "remote", "add", "origin", filepath.ToSlash(remote))
					tools.gitRun(t, m.LocalPath, "config", "remote.origin.promisor", "true")
					// Leave partialclonefilter unset: Git may otherwise register it
					// during an accidental lazy fetch of the hidden cache tree.
				}
				before := readVPSQARepositorySnapshot(t, m.LocalPath)
				if reader == "worker" {
					actual, err := syncGitPreviewState(t, tools, m, reader)
					if err != nil {
						t.Fatal(err)
					}
					if actual != expected {
						t.Fatalf("preview differs from real state: got %+v; want %+v", actual, expected)
					}
					if after := readVPSQARepositorySnapshot(t, m.LocalPath); !reflect.DeepEqual(before, after) {
						t.Fatal(describeVPSQASnapshotChanges(before, after))
					}
					return
				}
				ctx := context.WithValue(context.Background(), syncGitPreviewKey{}, true)
				ctx, discard, err := syncGitPreviewObjectsContext(ctx, m)
				if err != nil {
					t.Fatal(err)
				}
				defer discard()
				if _, _, err := localSyncMetadataFingerprint(m); err != nil {
					t.Fatal(err)
				}
				state, err := readLocalGitState(ctx, m)
				if err != nil {
					t.Fatal(err)
				}
				if state != expected {
					t.Fatalf("preview differs from real state: got %+v; want %+v", state, expected)
				}
				desired := state
				desired.Branch = "refs/heads/remote/recovery"
				if _, err := localGitTarget(ctx, m, state, desired); err != nil {
					t.Fatal(err)
				}
				if _, err := syncGitRecoveryEndpointView(ctx, m, state); err != nil {
					t.Fatal(err)
				}
				discard()
				if after := readVPSQARepositorySnapshot(t, m.LocalPath); !reflect.DeepEqual(before, after) {
					t.Fatal(describeVPSQASnapshotChanges(before, after))
				}
			})
		}
	}
}

type vpsQAFileState struct {
	identity piWorkspaceFile
	body     string
}

func describeVPSQASnapshotChanges(before, after map[string]vpsQAFileState) string {
	paths := make(map[string]bool, len(before)+len(after))
	for path := range before {
		paths[path] = true
	}
	for path := range after {
		paths[path] = true
	}
	var changes []string
	for path := range paths {
		previous, was := before[path]
		current, exists := after[path]
		if was == exists && previous == current {
			continue
		}
		changes = append(changes, fmt.Sprintf("%s exists=%t->%t identity=%+v->%+v bytes=%d->%d content-equal=%t", path, was, exists, previous.identity, current.identity, len(previous.body), len(current.body), previous.body == current.body))
	}
	sort.Strings(changes)
	return strings.Join(changes, "; ")
}

// Capture every repository entry, including loose/packed objects and empty
// directories, with file identity/change time in addition to exact file bytes.
func readVPSQARepositorySnapshot(t *testing.T, root string) map[string]vpsQAFileState {
	t.Helper()
	result := map[string]vpsQAFileState{}
	if err := filepath.WalkDir(root, func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		relative, err := filepath.Rel(root, path)
		if err != nil {
			return err
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		state := vpsQAFileState{identity: piWorkspaceFile{mode: info.Mode(), size: info.Size(), modified: info.ModTime().UnixNano()}}
		if info.IsDir() || info.Mode().IsRegular() {
			// Read size, times and identity from the same handle; directory
			// enumeration metadata can lag behind the current NTFS state.
			stamp, exists, err := syncGitMetadataPathStamp(path)
			if err != nil {
				return fmt.Errorf("snapshot entry %s: %w", relative, err)
			}
			if !exists {
				return fmt.Errorf("snapshot entry disappeared: %s", relative)
			}
			state.identity.mode, state.identity.size, state.identity.modified = stamp.mode, stamp.size, stamp.modified
			state.identity.changed = stamp.changed
			state.identity.volume, state.identity.indexHigh, state.identity.indexLow = stamp.volume, stamp.high, stamp.low
		} else if err := piWorkspaceFileIdentity(path, &state.identity); err != nil {
			return fmt.Errorf("snapshot entry %s: %w", relative, err)
		}
		switch {
		case info.Mode()&os.ModeSymlink != 0:
			state.identity.target, err = os.Readlink(path)
		case info.Mode().IsRegular():
			var data []byte
			data, err = os.ReadFile(path)
			state.body = string(data)
		}
		if err != nil {
			return err
		}
		result[filepath.ToSlash(relative)] = state
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	return result
}
