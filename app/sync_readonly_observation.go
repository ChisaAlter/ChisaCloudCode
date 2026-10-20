package main

import (
	"context"
	"fmt"
	"io/fs"
	"maps"
	"os"
	"path/filepath"
	"slices"

	"github.com/mutagen-io/mutagen/pkg/synchronization/core/ignore"
)

// Reuse only pure ignore decisions within this prepared read-only turn. File
// metadata and Git state are observed anew; Pi retains its existing path.
func captureReadOnlyWorkspaceSession(ctx context.Context, m *Mapping, session syncSession, previous ignore.IgnoreCache) (*piWorkspaceSnapshot, ignore.IgnoreCache, error) {
	session.Ignore.Paths = slices.Clone(session.Ignore.Paths)
	s := &piWorkspaceSnapshot{
		localPath: m.LocalPath, serverPath: m.ServerPath, serverID: m.ServerID,
		epoch: m.BindingEpoch, syncName: m.SyncName, session: session,
	}
	repository, err := localGitRepository(ctx, m.LocalPath)
	if err != nil {
		return nil, nil, err
	}
	if repository {
		state, err := readLocalGitState(ctx, m)
		if err != nil {
			return nil, nil, err
		}
		s.git = &state
	}
	files, cache, err := readOnlyWorkspaceFiles(ctx, m.LocalPath, session, previous)
	if err != nil {
		return nil, nil, err
	}
	s.files = files
	return s, cache, nil
}

func readOnlyWorkspaceChanged(ctx context.Context, m *Mapping, baseline *piWorkspaceSnapshot, previous ignore.IgnoreCache) (bool, error) {
	session, err := piWorkspaceSession(ctx, m)
	if err != nil {
		return true, err
	}
	if session.Identifier != baseline.session.Identifier || session.Ignore.VCS != baseline.session.Ignore.VCS || !slices.Equal(session.Ignore.Paths, baseline.session.Ignore.Paths) {
		return true, nil
	}
	current, _, err := captureReadOnlyWorkspaceSession(ctx, m, session, previous)
	if err != nil {
		return true, err
	}
	if (baseline.git == nil) != (current.git == nil) || (baseline.git != nil && *baseline.git != *current.git) {
		return true, nil
	}
	return !maps.Equal(baseline.files, current.files), nil
}

func readOnlyWorkspaceFiles(ctx context.Context, root string, session syncSession, previous ignore.IgnoreCache) (map[string]piWorkspaceFile, ignore.IgnoreCache, error) {
	ignorer, err := sessionIgnorer(session)
	if err != nil {
		return nil, nil, err
	}
	files := map[string]piWorkspaceFile{}
	cache := make(ignore.IgnoreCache, len(previous))
	err = filepath.WalkDir(root, func(name string, entry fs.DirEntry, failure error) error {
		if err := ctx.Err(); err != nil {
			return err
		}
		if failure != nil {
			return failure
		}
		if name == root {
			if !entry.IsDir() || entry.Type()&fs.ModeSymlink != 0 {
				return fmt.Errorf("只读工作区本地项目根路径不再是目录")
			}
			return nil
		}
		relative, err := filepath.Rel(root, name)
		if err != nil {
			return err
		}
		relative = filepath.ToSlash(relative)
		key := ignore.IgnoreCacheKey{Path: relative, Directory: entry.IsDir()}
		behavior, present := previous[key]
		if !present {
			status, continuation := ignorer.Ignore(relative, entry.IsDir())
			behavior = ignore.IgnoreCacheValue{Status: status, ContinueTraversal: continuation}
		}
		cache[key] = behavior
		if behavior.Status == ignore.IgnoreStatusIgnored {
			if entry.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		state := piWorkspaceFile{mode: info.Mode()}
		switch {
		case info.IsDir():
		case info.Mode().IsRegular():
			state.size, state.modified = info.Size(), info.ModTime().UnixNano()
			if err := piWorkspaceFileIdentity(name, &state); err != nil {
				return err
			}
		case info.Mode()&fs.ModeSymlink != 0:
			state.target, err = os.Readlink(name)
			if err != nil {
				return err
			}
		default:
			return fmt.Errorf("只读工作区包含无法确认的文件类型: %s", relative)
		}
		files[relative] = state
		return nil
	})
	if err != nil {
		return nil, nil, err
	}
	return files, cache, nil
}
