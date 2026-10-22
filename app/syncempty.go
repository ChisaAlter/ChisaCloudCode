package main

import (
	"bytes"
	"context"
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"path"
	"path/filepath"
	"slices"
	"strings"
	"sync"

	"github.com/mutagen-io/mutagen/pkg/synchronization/core/ignore"
	mutagenignore "github.com/mutagen-io/mutagen/pkg/synchronization/core/ignore/mutagen"
)

//go:embed resources/confirm_empty.py
var confirmEmptyWorker string

type pendingEmptyConfirmation struct {
	epoch   string
	session syncSession
}

// A failed paused operation may retry the exact confirmation without another failing flush.
var pendingEmptyConfirmations sync.Map

var errLocalSyncRootNotEmpty = errors.New("本地目录已有新的可同步内容，请刷新状态后重新同步")

func pendingProjectEmpty(m *Mapping, session syncSession) (syncSession, bool) {
	value, found := pendingEmptyConfirmations.Load(m.ServerPath)
	if !found {
		return syncSession{}, false
	}
	pending := value.(pendingEmptyConfirmation)
	valid := pending.epoch == m.BindingEpoch && session.Paused && session.Identifier == pending.session.Identifier
	// Dynamic live configuration contains only a capability marker, not current
	// Git exclusions. Recheck its local emptiness with both endpoints' fresh
	// snapshot inside clearConfirmedProject, after acquiring the exact lease.
	if valid && !syncSessionHasDynamicGitPolicy(pending.session) && errors.Is(localSyncRootEmpty(m, pending.session), errLocalSyncRootNotEmpty) {
		pendingEmptyConfirmations.Delete(m.ServerPath)
		valid = false
	}
	return pending.session, valid
}

func emptySyncEndpoint(endpoint syncEndpoint) bool {
	return endpoint.Connected && endpoint.Scanned && endpoint.Directories == 1 && endpoint.Files == 0 && endpoint.Symlinks == 0
}

func sessionIgnorer(session syncSession) (ignore.Ignorer, error) {
	ignorer, err := mutagenignore.NewIgnorer(session.Ignore.Paths)
	if err == nil && session.Ignore.VCS {
		ignorer = ignore.IgnoreVCS(ignorer)
	}
	return ignorer, err
}

func localSyncRootEmpty(m *Mapping, session syncSession) error {
	ignorer, err := sessionIgnorer(session)
	if err != nil {
		return err
	}
	return filepath.WalkDir(m.LocalPath, func(name string, entry fs.DirEntry, failure error) error {
		if failure != nil {
			return failure
		}
		if name == m.LocalPath {
			if !entry.IsDir() || entry.Type()&fs.ModeSymlink != 0 {
				return fmt.Errorf("本地项目根路径不再是目录")
			}
			return nil
		}
		relative, err := filepath.Rel(m.LocalPath, name)
		if err != nil {
			return err
		}
		status, _ := ignorer.Ignore(filepath.ToSlash(relative), entry.IsDir())
		if status == ignore.IgnoreStatusIgnored {
			if entry.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		return errLocalSyncRootNotEmpty
	})
}

func projectEmptySession(ctx context.Context, m *Mapping) (syncSession, error) {
	sessions, err := syncSessionsContext(ctx, m.SyncName)
	if err != nil {
		return syncSession{}, err
	}
	if len(sessions) != 1 || !syncSessionMatchesMapping(sessions[0], m, workspaceSyncConfig(ctx)) {
		return syncSession{}, fmt.Errorf("同步会话绑定已改变，请刷新状态")
	}
	session := sessions[0]
	if pending, valid := pendingProjectEmpty(m, session); valid {
		session = pending
	} else if session.Mode != "two-way-safe" || session.Status != "halted-on-root-emptied" || !emptySyncEndpoint(session.Alpha) || emptySyncEndpoint(session.Beta) {
		return syncSession{}, fmt.Errorf("当前项目不再处于本地清空保护状态，请刷新后重新确认")
	}
	if !syncSessionHasDynamicGitPolicy(session) {
		if err := localSyncRootEmpty(m, session); err != nil {
			return syncSession{}, err
		}
	}
	// The authoritative local-content guard for a dynamic session runs under
	// the exact lease, using fresh Git exclusions, before any remote move.
	return session, nil
}

type syncEmptyEntry struct {
	Path      string `json:"path"`
	Directory bool   `json:"directory"`
	Mode      uint32 `json:"mode"`
	Size      int64  `json:"size"`
	MTime     int64  `json:"mtime"`
	Inode     uint64 `json:"inode"`
	Device    uint64 `json:"device"`
}

func syncEmptyPlan(entries []syncEmptyEntry, session syncSession) ([]syncEmptyEntry, error) {
	ignorer, err := sessionIgnorer(session)
	if err != nil {
		return nil, err
	}
	ignored := map[string]bool{}
	selected := []syncEmptyEntry{}
	for _, entry := range entries {
		if entry.Path == "." || path.Clean(entry.Path) != entry.Path || strings.HasPrefix(entry.Path, "/") || strings.HasPrefix(entry.Path, "../") {
			return nil, fmt.Errorf("远端返回无效项目路径")
		}
		if ignored[path.Dir(entry.Path)] {
			if entry.Directory {
				ignored[entry.Path] = true
			}
			continue
		}
		// Mutagen retains unsupported filesystem objects as untracked content.
		switch entry.Mode & 0170000 {
		case 0040000, 0100000, 0120000:
		default:
			continue
		}
		status, _ := ignorer.Ignore(entry.Path, entry.Directory)
		if status == ignore.IgnoreStatusIgnored {
			if entry.Directory {
				ignored[entry.Path] = true
			}
			continue
		}
		selected = append(selected, entry)
	}
	return selected, nil
}

type syncEmptyResult struct {
	ClearState string `json:"clearState"`
	BackupPath string `json:"backupPath"`
	Error      string `json:"error,omitempty"`
}

// A live policy marker is deliberately not a static ignore snapshot. Destructive
// confirmation obtains both endpoints' current policy under the paused session
// and exact lease, and proves it unchanged again before requesting quarantine.
var confirmedEmptyIgnorePatterns = projectSyncIgnoreSnapshotPatterns

func clearConfirmedProject(ctx context.Context, m *Mapping, session syncSession) (syncEmptyResult, error) {
	notStarted := syncEmptyResult{ClearState: "not-started"}
	current, err := syncSessionsContext(ctx, m.SyncName)
	if err != nil {
		return notStarted, err
	}
	if len(current) != 1 || !current[0].Paused || current[0].Identifier != session.Identifier || !syncSessionMatchesMapping(current[0], m, workspaceSyncConfig(ctx)) {
		return notStarted, fmt.Errorf("清空确认后同步会话已改变")
	}
	dynamicPolicy := syncSessionHasDynamicGitPolicy(session)
	if dynamicPolicy {
		patterns, err := confirmedEmptyIgnorePatterns(ctx, m)
		if err != nil {
			return notStarted, fmt.Errorf("无法确认清空时的最新过滤规则，未移动文件: %w", err)
		}
		session.Ignore.Paths = patterns
	}
	if err := localSyncRootEmpty(m, session); err != nil {
		return notStarted, err
	}
	callWorker := func(request map[string]any, result any) error {
		request["root"] = m.ServerPath
		data, err := json.Marshal(request)
		if err != nil {
			return err
		}
		output, err := syncRemoteScript(ctx, m, "python3 -c "+shellQuote(confirmEmptyWorker), bytes.NewReader(data))
		if err != nil {
			return err
		}
		return json.Unmarshal([]byte(output), result)
	}
	entries := []syncEmptyEntry{}
	directories := []string{""}
	directoryContents := map[string][]string{}
	for len(directories) > 0 {
		var inventory struct {
			Entries     []syncEmptyEntry    `json:"entries"`
			Directories map[string][]string `json:"directories"`
			RootDevice  uint64              `json:"rootDevice"`
		}
		if err := callWorker(map[string]any{"op": "list", "directories": directories}, &inventory); err != nil {
			return notStarted, err
		}
		for directory, names := range inventory.Directories {
			directoryContents[directory] = names
		}
		selected, err := syncEmptyPlan(inventory.Entries, session)
		if err != nil {
			return notStarted, err
		}
		directories = nil
		for _, entry := range selected {
			if entry.Device != inventory.RootDevice {
				return notStarted, fmt.Errorf("可同步目录跨越文件系统，无法安全移入备份")
			}
			if entry.Directory {
				directories = append(directories, entry.Path)
			}
		}
		entries = append(entries, selected...)
	}
	if dynamicPolicy {
		patterns, err := confirmedEmptyIgnorePatterns(ctx, m)
		if err != nil || !slices.Equal(patterns, session.Ignore.Paths) {
			return notStarted, fmt.Errorf("清空准备期间文件过滤规则已改变或无法确认，未移动文件")
		}
	}
	if err := localSyncRootEmpty(m, session); err != nil {
		return notStarted, err
	}
	id, _ := ctx.Value(syncLeaseContextKey{}).(string)
	request := map[string]any{"op": "move", "id": id, "epoch": m.BindingEpoch, "entries": entries, "directories": directoryContents}
	if dynamicPolicy {
		local, err := localSyncGitInventory(ctx, m)
		if err != nil {
			return notStarted, fmt.Errorf("清空前无法确认本地跟踪例外，未移动文件: %w", err)
		}
		request["gitPolicy"], request["tracked"] = true, local.Tracked
	}
	moved := syncEmptyResult{ClearState: "unknown"}
	if err := callWorker(request, &moved); err != nil {
		return syncEmptyResult{ClearState: "unknown"}, fmt.Errorf("清空结果未确认；请检查 VPS 原目录和备份目录后再操作: %w", err)
	}
	switch moved.ClearState {
	case "not-started":
		moved.BackupPath = ""
	case "partial", "completed":
		if moved.BackupPath != m.ServerPath+".chisa-sync-backups/"+id {
			return syncEmptyResult{ClearState: "unknown"}, fmt.Errorf("清空返回的备份位置未确认，请检查 VPS 文件")
		}
	default:
		return syncEmptyResult{ClearState: "unknown"}, fmt.Errorf("清空结果未确认，请检查 VPS 文件")
	}
	if moved.Error != "" {
		return moved, errors.New(moved.Error)
	}
	if moved.ClearState != "completed" {
		return moved, fmt.Errorf("清空未完成，请检查 VPS 文件")
	}
	// Reset only after confirmed files are quarantined.
	if _, err := runMutagenContext(ctx, "sync", "reset", session.Identifier); err != nil {
		return moved, err
	}
	pendingEmptyConfirmations.Delete(m.ServerPath)
	return moved, nil
}
