package main

import (
	"context"
	"fmt"
	"io/fs"
	"maps"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"syscall"
	"unsafe"

	"github.com/mutagen-io/mutagen/pkg/synchronization/core/ignore"
)

// A baseline exists only in the process that successfully prepared this turn.
// Restart recovery therefore keeps the full synchronization path.
type piWorkspaceSnapshot struct {
	localPath, serverPath, serverID, epoch, syncName string
	session                                          syncSession
	files                                            map[string]piWorkspaceFile
	git                                              *syncGitState
}

type piWorkspaceFile struct {
	mode                        fs.FileMode
	size, modified, changed     int64
	volume, indexHigh, indexLow uint32
	target                      string
}

// These are the existing engine operations, exposed together at the Pi
// handback seam so a failed observation cannot be mistaken for a clean tree.
var piWorkspaceSyncSessions = syncSessionsContext
var piWorkspaceResumeSync = func(ctx context.Context, name string) error {
	_, err := runMutagenContext(ctx, "sync", "resume", name)
	return err
}

func piWorkspaceSession(ctx context.Context, m *Mapping) (syncSession, error) {
	if err := workspaceSyncCurrent(ctx); err != nil {
		return syncSession{}, err
	}
	if m.SyncName == "" || m.ServerID != serverIdentity(workspaceSyncConfig(ctx)) {
		return syncSession{}, fmt.Errorf("Pi 工作区同步绑定已改变")
	}
	sessions, err := piWorkspaceSyncSessions(ctx, m.SyncName)
	if err != nil {
		return syncSession{}, err
	}
	if len(sessions) != 1 || sessions[0].Identifier == "" || !sessions[0].Paused ||
		!syncSessionMatchesMapping(sessions[0], m, workspaceSyncConfig(ctx)) {
		return syncSession{}, fmt.Errorf("Pi 工作区同步会话未保持原绑定和暂停状态")
	}
	s := sessions[0]
	if strings.HasPrefix(s.Status, "halted-") || s.LastError != "" || len(s.Conflicts) != 0 || s.ExcludedConflicts != 0 {
		return syncSession{}, fmt.Errorf("Pi 工作区同步存在尚未恢复的错误")
	}
	return s, nil
}

func capturePiWorkspace(ctx context.Context, m *Mapping) (*piWorkspaceSnapshot, error) {
	session, err := piWorkspaceSession(ctx, m)
	if err != nil {
		return nil, err
	}
	return capturePiWorkspaceSession(ctx, m, session)
}

func capturePiWorkspaceSession(ctx context.Context, m *Mapping, session syncSession) (*piWorkspaceSnapshot, error) {
	s := &piWorkspaceSnapshot{
		localPath: m.LocalPath, serverPath: m.ServerPath, serverID: m.ServerID,
		epoch: m.BindingEpoch, syncName: m.SyncName, session: session,
	}
	// Git's synchronized state includes staged edits and the active branch, not
	// just worktree paths. VCS files themselves remain excluded from file sync.
	repository, err := localGitRepository(ctx, m.LocalPath)
	if err != nil {
		return nil, err
	}
	if repository {
		state, err := readLocalGitState(ctx, m)
		if err != nil {
			return nil, err
		}
		s.git = &state
	}
	s.files, err = piWorkspaceFiles(ctx, m.LocalPath, session)
	if err != nil {
		return nil, err
	}
	return s, nil
}

func (s *piWorkspaceSnapshot) changed(ctx context.Context, m *Mapping) (bool, error) {
	if s == nil {
		return true, nil
	}
	if s.localPath != m.LocalPath || s.serverPath != m.ServerPath || s.serverID != m.ServerID || s.epoch != m.BindingEpoch || s.syncName != m.SyncName {
		return true, fmt.Errorf("Pi 任务的工作区绑定已失效")
	}
	session, err := piWorkspaceSession(ctx, m)
	if err != nil {
		return true, err
	}
	if session.Identifier != s.session.Identifier || session.Ignore.VCS != s.session.Ignore.VCS || !slices.Equal(session.Ignore.Paths, s.session.Ignore.Paths) {
		return true, nil
	}
	current, err := capturePiWorkspaceSession(ctx, m, session)
	if err != nil {
		return true, err
	}
	if (s.git == nil) != (current.git == nil) || (s.git != nil && *s.git != *current.git) {
		return true, nil
	}
	return !maps.Equal(s.files, current.files), nil
}

func piWorkspaceFiles(ctx context.Context, root string, session syncSession) (map[string]piWorkspaceFile, error) {
	ignorer, err := sessionIgnorer(session)
	if err != nil {
		return nil, err
	}
	files := map[string]piWorkspaceFile{}
	err = filepath.WalkDir(root, func(name string, entry fs.DirEntry, failure error) error {
		if err := ctx.Err(); err != nil {
			return err
		}
		if failure != nil {
			return failure
		}
		if name == root {
			if !entry.IsDir() || entry.Type()&fs.ModeSymlink != 0 {
				return fmt.Errorf("Pi 本地项目根路径不再是目录")
			}
			return nil
		}
		relative, err := filepath.Rel(root, name)
		if err != nil {
			return err
		}
		relative = filepath.ToSlash(relative)
		status, _ := ignorer.Ignore(relative, entry.IsDir())
		if status == ignore.IgnoreStatusIgnored {
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
			// Directory timestamps also change for ignored/transient children;
			// only their presence and type belong to the synchronization result.
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
			return fmt.Errorf("Pi 项目包含无法确认的文件类型: %s", relative)
		}
		files[relative] = state
		return nil
	})
	if err != nil {
		return nil, err
	}
	return files, nil
}

var piWorkspaceFileInformation = syscall.NewLazyDLL("kernel32.dll").NewProc("GetFileInformationByHandleEx")

// NTFS ChangeTime and file identity also detect same-size replacements and
// writes that restore LastWriteTime. No project file contents are read or hashed.
func piWorkspaceFileIdentity(name string, state *piWorkspaceFile) error {
	path, err := syscall.UTF16PtrFromString(name)
	if err != nil {
		return err
	}
	handle, err := syscall.CreateFile(path, 0, syscall.FILE_SHARE_READ|syscall.FILE_SHARE_WRITE|syscall.FILE_SHARE_DELETE, nil, syscall.OPEN_EXISTING, syscall.FILE_FLAG_OPEN_REPARSE_POINT, 0)
	if err != nil {
		return err
	}
	defer syscall.CloseHandle(handle)
	var identity syscall.ByHandleFileInformation
	if err := syscall.GetFileInformationByHandle(handle, &identity); err != nil {
		return err
	}
	var basic struct {
		creation, access, write, change int64
		attributes                      uint32
		padding                         uint32
	}
	ok, _, callErr := piWorkspaceFileInformation.Call(uintptr(handle), 0, uintptr(unsafe.Pointer(&basic)), unsafe.Sizeof(basic))
	if ok == 0 {
		return callErr
	}
	state.changed = basic.change
	state.volume, state.indexHigh, state.indexLow = identity.VolumeSerialNumber, identity.FileIndexHigh, identity.FileIndexLow
	return nil
}

// Use only after a successful preparation and an unchanged baseline. The caller
// still releases the exact pi lease and updates ownership after this succeeds.
func resumePiWorkspace(ctx context.Context, m *Mapping, leaseID string) error {
	if leaseID == "" {
		return fmt.Errorf("Pi 工作区缺少原任务租约")
	}
	session, err := piWorkspaceSession(ctx, m)
	if err != nil {
		return err
	}
	state, err := remoteLeaseContext(ctx, m, "confirm", "pi", leaseID)
	if err != nil {
		return err
	}
	lease, _ := state["lease"].(map[string]any)
	if lease["id"] != leaseID || lease["epoch"] != m.BindingEpoch || lease["owner"] != "pi" {
		return fmt.Errorf("Pi 工作区原任务租约已改变")
	}
	if err := workspaceSyncCurrent(ctx); err != nil {
		return err
	}
	return piWorkspaceResumeSync(ctx, session.Identifier)
}
