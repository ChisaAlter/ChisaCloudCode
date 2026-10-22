package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"syscall"
	"time"
	"unsafe"
)

// Only a completed, stable portable observation can populate this process cache.
// Restart, reconnect, new binding, Pending, or changed metadata takes the full path.
type syncGitObservationCache struct {
	local, remote string
	state         syncGitState
}

var syncGitObservations sync.Map

type syncGitCacheKey struct {
	mapping           Mapping
	connection        *serverConnection
	transport         *Tunnel
	identity, keyPath string
	recovery          bool
}

func syncGitObservationKey(ctx context.Context, m *Mapping) syncGitCacheKey {
	key := syncGitCacheKey{mapping: *m}
	serverConnectionMu.RLock()
	defer serverConnectionMu.RUnlock()
	if snapshot, _ := ctx.Value(workspaceSyncConnectionKey{}).(*workspaceSyncConnection); snapshot != nil {
		key.connection, key.transport, key.identity, key.keyPath = snapshot.connection, snapshot.tunnel, serverIdentity(snapshot.cfg), snapshot.keyPath
	} else {
		key.connection, key.transport = apiConnection, tunnel
		key.identity, key.keyPath = serverIdentity(store.config()), store.keyPathOf()
	}
	// A handback is allowed to drain a recovery transport, but that permission
	// does not change a healthy connection's filesystem evidence. Bind to the
	// transport's actual mode; currentLocked still enforces caller admission.
	key.recovery = key.connection != nil && key.connection.workspaceRecoveryOnly
	return key
}

const (
	syncGitMetadataBytes   = int64(512 * 1024 * 1024)
	syncGitMetadataEntries = 100000
)

var syncGitSystemConfiguration struct {
	sync.Once
	path string
	err  error
}

// Git for Windows installs system configuration outside /etc. Resolve the
// installation-dependent default once; warm observations never launch Git.
// Callers must handle GIT_CONFIG_SYSTEM overrides separately.
func syncGitSystemConfigDisabled() bool {
	switch strings.ToLower(strings.TrimSpace(os.Getenv("GIT_CONFIG_NOSYSTEM"))) {
	case "1", "true", "yes", "on":
		return true
	default:
		return false // Observe extra configuration for unknown values.
	}
}

func syncGitSystemConfigPath() (string, error) {
	syncGitSystemConfiguration.Do(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		command := hideCommandWindow(exec.CommandContext(ctx, "git", "var", "GIT_CONFIG_SYSTEM"))
		command.Dir, command.WaitDelay = os.TempDir(), time.Second
		for _, entry := range os.Environ() {
			key, _, _ := strings.Cut(entry, "=")
			if !strings.HasPrefix(strings.ToUpper(key), "GIT_") {
				command.Env = append(command.Env, entry)
			}
		}
		command.Env = append(command.Env, "LC_ALL=C", "GIT_TERMINAL_PROMPT=0")
		out, err := command.Output()
		if err != nil {
			syncGitSystemConfiguration.err = fmt.Errorf("无法确定 Git 系统配置路径: %w", err)
			return
		}
		name := strings.TrimSpace(string(out))
		if !filepath.IsAbs(name) || strings.ContainsAny(name, "\x00\r\n") {
			syncGitSystemConfiguration.err = fmt.Errorf("Git 系统配置路径无效")
			return
		}
		syncGitSystemConfiguration.path = filepath.Clean(name)
	})
	return syncGitSystemConfiguration.path, syncGitSystemConfiguration.err
}

type syncGitMetadataStamp struct {
	mode                    fs.FileMode
	size, modified, changed int64
	volume, high, low       uint32
}

func syncGitMetadataHandleStamp(file *os.File) (syncGitMetadataStamp, error) {
	info, err := file.Stat()
	if err != nil {
		return syncGitMetadataStamp{}, err
	}
	return syncGitMetadataHandleInformation(syscall.Handle(file.Fd()), info)
}

func syncGitMetadataHandleInformation(handle syscall.Handle, info fs.FileInfo) (syncGitMetadataStamp, error) {
	// Directory enumeration data can lag behind NTFS handle information. Read
	// every timestamp from this handle so an observation is internally coherent.
	var identity syscall.ByHandleFileInformation
	if err := syscall.GetFileInformationByHandle(handle, &identity); err != nil {
		return syncGitMetadataStamp{}, err
	}
	var basic struct {
		creation, access, write, change int64
		attributes, padding             uint32
	}
	ok, _, err := piWorkspaceFileInformation.Call(uintptr(handle), 0, uintptr(unsafe.Pointer(&basic)), unsafe.Sizeof(basic))
	if ok == 0 {
		return syncGitMetadataStamp{}, err
	}
	return syncGitMetadataStamp{mode: info.Mode(), size: int64(uint64(identity.FileSizeHigh)<<32 | uint64(identity.FileSizeLow)), modified: identity.LastWriteTime.Nanoseconds(), changed: basic.change,
		volume: identity.VolumeSerialNumber, high: identity.FileIndexHigh, low: identity.FileIndexLow}, nil
}

func syncGitMetadataPathStamp(name string) (syncGitMetadataStamp, bool, error) {
	info, err := os.Lstat(name)
	if os.IsNotExist(err) {
		return syncGitMetadataStamp{}, false, nil
	}
	if err != nil {
		return syncGitMetadataStamp{}, false, err
	}
	if !info.Mode().IsRegular() && !info.IsDir() {
		return syncGitMetadataStamp{}, true, fmt.Errorf("Git 元数据类型需要完整观察: %s", name)
	}
	path, err := syscall.UTF16PtrFromString(name)
	if err != nil {
		return syncGitMetadataStamp{}, true, err
	}
	handle, err := syscall.CreateFile(path, 0, syscall.FILE_SHARE_READ|syscall.FILE_SHARE_WRITE|syscall.FILE_SHARE_DELETE,
		nil, syscall.OPEN_EXISTING, syscall.FILE_FLAG_OPEN_REPARSE_POINT|syscall.FILE_FLAG_BACKUP_SEMANTICS, 0)
	if err != nil {
		return syncGitMetadataStamp{}, true, err
	}
	defer syscall.CloseHandle(handle)
	stamp, err := syncGitMetadataHandleInformation(handle, info)
	return stamp, true, err
}

type syncGitMetadataFile struct {
	stamp   syncGitMetadataStamp
	exists  bool
	digest  [sha256.Size]byte
	content []byte
}

// Path, opened handle and final path must describe the same object. ChangeTime
// detects in-place writes even when a writer restores size and LastWriteTime.
func readSyncGitMetadataFile(name string, capture bool, limit int64) (syncGitMetadataFile, error) {
	before, exists, err := syncGitMetadataPathStamp(name)
	result := syncGitMetadataFile{stamp: before, exists: exists}
	if err != nil || !exists {
		return result, err
	}
	if !before.mode.IsRegular() {
		return result, fmt.Errorf("Git 元数据不是普通文件: %s", name)
	}
	if before.size > limit {
		return result, fmt.Errorf("Git 元数据超过观察限制")
	}
	file, err := os.Open(name)
	if err != nil {
		return result, err
	}
	defer file.Close()
	opened, err := syncGitMetadataHandleStamp(file)
	if err != nil {
		return result, err
	}
	if opened != before {
		return result, fmt.Errorf("Git 元数据在打开时改变: %s", name)
	}
	digest := sha256.New()
	var content bytes.Buffer
	var output io.Writer = digest
	if capture {
		output = io.MultiWriter(digest, &content)
	}
	count, err := io.Copy(output, io.LimitReader(file, limit+1))
	if err != nil {
		return result, err
	}
	if count > limit || count != before.size {
		return result, fmt.Errorf("Git 元数据长度在读取时改变或超过观察限制")
	}
	after, err := syncGitMetadataHandleStamp(file)
	if err != nil {
		return result, err
	}
	current, present, err := syncGitMetadataPathStamp(name)
	if err != nil {
		return result, err
	}
	if after != before || !present || current != before {
		return result, fmt.Errorf("Git 元数据在读取时改变: %s", name)
	}
	copy(result.digest[:], digest.Sum(nil))
	if capture {
		result.content = content.Bytes()
	}
	return result, nil
}

var syncGitUnsupportedConfig = regexp.MustCompile(`(?im)^\s*\[\s*include(?:if)?(?:\s|\.|\])|(?:refstorage|excludesfile)\s*=`)
var syncGitUnsupportedReference = regexp.MustCompile(`[\x00-\x20\x7f~^:?*\[\\]`)
var errSyncGitInheritedRepository = errors.New("项目继承了父目录 Git 仓库")

func localSyncMetadataFingerprint(m *Mapping) (string, bool, error) {
	digest := sha256.New()
	files := make(map[string]syncGitMetadataFile)
	directories := make(map[string]syncGitMetadataStamp)
	identities := make(map[string]syncGitMetadataStamp)
	var total int64
	entries := 0
	for _, key := range []string{"GIT_DIR", "GIT_COMMON_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_GRAFT_FILE", "GIT_SHALLOW_FILE", "GIT_REPLACE_REF_BASE", "GIT_CONFIG", "GIT_CONFIG_PARAMETERS", "GIT_CONFIG_COUNT", "GIT_IMPLICIT_WORK_TREE"} {
		if os.Getenv(key) != "" {
			return "", true, fmt.Errorf("Git 环境覆盖 %s 需要完整观察", key)
		}
	}
	for _, entry := range os.Environ() {
		key, value, _ := strings.Cut(entry, "=")
		upper := strings.ToUpper(key)
		if (strings.HasPrefix(upper, "GIT_CONFIG_KEY_") || strings.HasPrefix(upper, "GIT_CONFIG_VALUE_")) && value != "" {
			return "", true, fmt.Errorf("Git 环境配置需要完整观察")
		}
	}
	for _, key := range []string{"HOME", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "XDG_CONFIG_HOME", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM", "GIT_CONFIG_NOSYSTEM", "GIT_NO_REPLACE_OBJECTS", "GIT_CEILING_DIRECTORIES", "GIT_DISCOVERY_ACROSS_FILESYSTEM", "PATH"} {
		fmt.Fprintf(digest, "env:%s=%s\x00", key, os.Getenv(key))
	}
	addFile := func(name string, capture bool) (syncGitMetadataFile, error) {
		name = filepath.Clean(name)
		if record, found := files[name]; found {
			return record, nil
		}
		entries++
		if entries > syncGitMetadataEntries {
			return syncGitMetadataFile{}, fmt.Errorf("Git 元数据项目过多")
		}
		limit := syncGitMetadataBytes - total
		if capture && limit > 32*1024*1024 {
			limit = 32 * 1024 * 1024
		}
		record, err := readSyncGitMetadataFile(name, capture, limit)
		if err != nil {
			return record, err
		}
		files[name] = record
		if !record.exists {
			fmt.Fprintf(digest, "%s\x00missing\x00", name)
			return record, nil
		}
		total += record.stamp.size
		fmt.Fprintf(digest, "%s\x00%v\x00%x\x00", name, record.stamp, record.digest)
		return record, nil
	}
	addIdentity := func(name string) error {
		stamp, exists, err := syncGitMetadataPathStamp(name)
		if err != nil {
			return err
		}
		if !exists || !stamp.mode.IsDir() {
			return fmt.Errorf("Git 工作区目录不存在: %s", name)
		}
		identities[name] = stamp
		fmt.Fprintf(digest, "%s\x00directory:%d:%d:%d\x00", name, stamp.volume, stamp.high, stamp.low)
		return nil
	}
	readDirectory := func(name string) ([]fs.DirEntry, error) {
		before, exists, err := syncGitMetadataPathStamp(name)
		if err != nil {
			return nil, err
		}
		if !exists || !before.mode.IsDir() {
			return nil, fmt.Errorf("Git 元数据目录已改变: %s", name)
		}
		if original, found := directories[name]; found && original != before {
			return nil, fmt.Errorf("Git 元数据目录在观察时改变: %s", name)
		}
		directory, err := os.Open(name)
		if err != nil {
			return nil, err
		}
		defer directory.Close()
		opened, err := syncGitMetadataHandleStamp(directory)
		if err != nil {
			return nil, err
		}
		if opened != before {
			return nil, fmt.Errorf("Git 元数据目录在打开时改变: %s", name)
		}
		children, err := directory.ReadDir(syncGitMetadataEntries + 1)
		if err != nil && err != io.EOF {
			return nil, err
		}
		if len(children) > syncGitMetadataEntries {
			return nil, fmt.Errorf("Git 元数据目录项目过多")
		}
		sort.Slice(children, func(i, j int) bool { return children[i].Name() < children[j].Name() })
		closed, err := syncGitMetadataHandleStamp(directory)
		if err != nil {
			return nil, err
		}
		if closed != before {
			return nil, fmt.Errorf("Git 元数据目录在读取时改变: %s", name)
		}
		after, present, err := syncGitMetadataPathStamp(name)
		if err != nil {
			return nil, err
		}
		if !present || before != after {
			return nil, fmt.Errorf("Git 元数据目录在读取时改变: %s", name)
		}
		directories[name] = before
		return children, nil
	}
	validate := func() error {
		for name, file := range files {
			stamp, exists, err := syncGitMetadataPathStamp(name)
			if err != nil {
				return err
			}
			if exists != file.exists || (exists && stamp != file.stamp) {
				return fmt.Errorf("Git 元数据在观察时改变: %s", name)
			}
		}
		for name, before := range directories {
			current, exists, err := syncGitMetadataPathStamp(name)
			if err != nil {
				return err
			}
			if !exists || current != before {
				return fmt.Errorf("Git 元数据目录在观察时改变: %s", name)
			}
		}
		for name, before := range identities {
			current, exists, err := syncGitMetadataPathStamp(name)
			if err != nil {
				return err
			}
			if !exists || !current.mode.IsDir() || current.volume != before.volume || current.high != before.high || current.low != before.low {
				return fmt.Errorf("Git 工作区目录已改变: %s", name)
			}
		}
		return nil
	}
	if err := addIdentity(m.LocalPath); err != nil {
		return "", false, err
	}
	marker := filepath.Join(m.LocalPath, ".git")
	markerStamp, markerExists, err := syncGitMetadataPathStamp(marker)
	if err != nil {
		return "", markerExists, err
	}
	if !markerExists {
		// Certify absence at this exact root, including inherited/bare repositories.
		// No source-file contents or worktree inventory are read.
		for directory := filepath.Clean(m.LocalPath); ; directory = filepath.Dir(directory) {
			_, exists, err := syncGitMetadataPathStamp(filepath.Join(directory, ".git"))
			if err != nil {
				return "", false, err
			}
			if exists {
				return "", false, errSyncGitInheritedRepository
			}
			if _, err := addFile(filepath.Join(directory, ".git"), false); err != nil {
				return "", false, err
			}
			// Git also discovers a bare repository in any ancestor. Certify at
			// least one bare marker absent through final validation at each level.
			_, headExists, err := syncGitMetadataPathStamp(filepath.Join(directory, "HEAD"))
			if err != nil {
				return "", false, err
			}
			_, objectsExist, err := syncGitMetadataPathStamp(filepath.Join(directory, "objects"))
			if err != nil {
				return "", false, err
			}
			if headExists && objectsExist {
				return "", false, fmt.Errorf("项目根目录或祖先包含裸 Git 仓库，需要完整观察")
			}
			if !headExists {
				files[filepath.Join(directory, "HEAD")] = syncGitMetadataFile{}
			}
			if !objectsExist {
				files[filepath.Join(directory, "objects")] = syncGitMetadataFile{}
			}
			if parent := filepath.Dir(directory); parent == directory {
				break
			}
		}
		if err := validate(); err != nil {
			return "", false, err
		}
		return hex.EncodeToString(digest.Sum(nil)), false, nil
	}
	gitdir := marker
	if !markerStamp.mode.IsDir() {
		pointer, err := addFile(marker, true)
		if err != nil {
			return "", true, err
		}
		value, valid := strings.CutPrefix(strings.TrimSpace(string(pointer.content)), "gitdir: ")
		if !valid || value == "" || strings.ContainsRune(value, 0) {
			return "", true, fmt.Errorf("无效的 Git 目录指针")
		}
		gitdir = strings.TrimSpace(value)
		if !filepath.IsAbs(gitdir) {
			gitdir = filepath.Join(m.LocalPath, gitdir)
		}
	}
	gitdir, err = filepath.EvalSymlinks(gitdir)
	if err != nil {
		return "", true, err
	}
	if err := addIdentity(gitdir); err != nil {
		return "", true, err
	}
	common := gitdir
	pointer, err := addFile(filepath.Join(gitdir, "commondir"), true)
	if err != nil {
		return "", true, err
	}
	if pointer.exists {
		common = strings.TrimSpace(string(pointer.content))
		if common == "" || strings.ContainsRune(common, 0) {
			return "", true, fmt.Errorf("无效的 Git 公共目录指针")
		}
		if !filepath.IsAbs(common) {
			common = filepath.Join(gitdir, common)
		}
	}
	common, err = filepath.EvalSymlinks(common)
	if err != nil {
		return "", true, err
	}
	if err := addIdentity(common); err != nil {
		return "", true, err
	}
	for _, directory := range []string{gitdir, common} {
		for _, unsupported := range []string{"reftable"} {
			if _, err := os.Lstat(filepath.Join(directory, unsupported)); err == nil {
				return "", true, fmt.Errorf("Git %s 需要完整观察", unsupported)
			} else if !os.IsNotExist(err) {
				return "", true, err
			}
			if record, err := addFile(filepath.Join(directory, unsupported), false); err != nil {
				return "", true, err
			} else if record.exists {
				return "", true, fmt.Errorf("Git %s 在观察时出现", unsupported)
			}
		}
		children, err := readDirectory(directory)
		if err != nil {
			return "", true, err
		}
		for _, child := range children {
			if strings.HasPrefix(child.Name(), "sharedindex.") {
				if _, err := addFile(filepath.Join(directory, child.Name()), false); err != nil {
					return "", true, err
				}
			}
		}
	}
	checkLock := func(name string) error {
		record, err := addFile(name+".lock", false)
		if err != nil {
			return err
		}
		if record.exists {
			return fmt.Errorf("Git 写入尚未完成: %s.lock", name)
		}
		return nil
	}
	for _, name := range []string{filepath.Join(gitdir, "index"), filepath.Join(gitdir, "HEAD"), filepath.Join(common, "packed-refs")} {
		if err := checkLock(name); err != nil {
			return "", true, err
		}
	}
	for _, name := range []string{"index", "HEAD"} {
		if record, err := addFile(filepath.Join(gitdir, name+".chisa-owned"), false); err != nil {
			return "", true, err
		} else if record.exists {
			// Even a marker-only crash after rename must pass the guarded reader
			// before a no-op or warm cache can claim a completed transition.
			return "", true, fmt.Errorf("Git 自有锁需要安全恢复: %s", name)
		}
	}
	head := filepath.Join(gitdir, "HEAD")
	seen := make(map[string]bool)
	for depth := 0; ; depth++ {
		if depth >= 32 || seen[head] {
			return "", true, fmt.Errorf("Git 符号引用循环或过深")
		}
		seen[head] = true
		record, err := addFile(head, true)
		if err != nil {
			return "", true, err
		}
		if !record.exists {
			if depth == 0 {
				return "", true, fmt.Errorf("Git HEAD 缺失")
			}
			break
		}
		value := strings.TrimSpace(string(record.content))
		ref, symbolic := strings.CutPrefix(value, "ref: ")
		if !symbolic {
			if !syncGitHeadOID(value) {
				return "", true, fmt.Errorf("Git 引用格式需要完整观察")
			}
			break
		}
		if !strings.HasPrefix(ref, "refs/") || strings.Contains(ref, "..") || strings.Contains(ref, "@{") || syncGitUnsupportedReference.MatchString(ref) || strings.HasSuffix(ref, ".lock") || strings.HasSuffix(ref, ".") {
			return "", true, fmt.Errorf("无效 Git 符号引用")
		}
		for _, part := range strings.Split(ref, "/") {
			if part == "" || part == "." || part == ".." {
				return "", true, fmt.Errorf("无效 Git 符号引用")
			}
		}
		parent := common
		if strings.HasPrefix(ref, "refs/worktree/") || strings.HasPrefix(ref, "refs/bisect/") || strings.HasPrefix(ref, "refs/rewritten/") {
			parent = gitdir
		}
		head = filepath.Join(parent, filepath.FromSlash(ref))
		if err := checkLock(head); err != nil {
			return "", true, err
		}
	}
	configs := []string{filepath.Join(common, "config"), filepath.Join(gitdir, "config.worktree")}
	if common != gitdir {
		configs = append(configs, filepath.Join(common, "config.worktree"))
	}
	home := os.Getenv("HOME")
	if home == "" {
		home, _ = os.UserHomeDir()
	}
	if name := os.Getenv("GIT_CONFIG_GLOBAL"); name != "" {
		configs = append(configs, name)
	} else if home != "" {
		configs = append(configs, filepath.Join(home, ".gitconfig"))
		xdg := os.Getenv("XDG_CONFIG_HOME")
		if xdg == "" {
			xdg = filepath.Join(home, ".config")
		}
		configs = append(configs, filepath.Join(xdg, "git", "config"))
	}
	if name := os.Getenv("GIT_CONFIG_SYSTEM"); name != "" {
		configs = append(configs, name)
	} else if !syncGitSystemConfigDisabled() {
		system, err := syncGitSystemConfigPath()
		if err != nil {
			return "", true, err
		}
		configs = append(configs, system)
	}
	for _, name := range configs {
		if !filepath.IsAbs(name) {
			name = filepath.Join(m.LocalPath, name)
		}
		record, err := addFile(name, true)
		if err != nil {
			return "", true, err
		}
		if syncGitUnsupportedConfig.Match(record.content) {
			return "", true, fmt.Errorf("Git 扩展配置需要完整观察")
		}
	}
	packed, err := addFile(filepath.Join(common, "packed-refs"), true)
	if err != nil {
		return "", true, err
	}
	for _, line := range bytes.Split(packed.content, []byte{'\n'}) {
		if fields := bytes.Fields(line); len(fields) == 2 && bytes.HasPrefix(fields[1], []byte("refs/replace/")) {
			return "", true, fmt.Errorf("Git replace 引用需要完整观察")
		}
	}
	for _, name := range []string{filepath.Join(gitdir, "index"), filepath.Join(gitdir, "config.worktree"), filepath.Join(common, "shallow"), filepath.Join(common, "objects", "info", "alternates"), filepath.Join(common, "info", "grafts")} {
		if _, err := addFile(name, false); err != nil {
			return "", true, err
		}
	}
	var walkOperation func(string) error
	walkOperation = func(name string) error {
		stamp, exists, err := syncGitMetadataPathStamp(name)
		if err != nil {
			return err
		}
		if !exists || !stamp.mode.IsDir() {
			_, err := addFile(name, false)
			return err
		}
		entries++
		if entries > syncGitMetadataEntries {
			return fmt.Errorf("Git 元数据项目过多")
		}
		fmt.Fprintf(digest, "%s\x00directory:%d:%d:%d\x00", name, stamp.volume, stamp.high, stamp.low)
		children, err := readDirectory(name)
		if err != nil {
			return err
		}
		for _, child := range children {
			if err := walkOperation(filepath.Join(name, child.Name())); err != nil {
				return err
			}
		}
		return nil
	}
	for _, name := range append(append([]string{}, syncGitOperationFiles...), syncGitOperationDirectories...) {
		if err := walkOperation(filepath.Join(gitdir, filepath.FromSlash(name))); err != nil {
			return "", true, err
		}
	}
	replace := filepath.Join(common, "refs", "replace")
	if _, exists, err := syncGitMetadataPathStamp(replace); err != nil {
		return "", true, err
	} else if exists {
		children, err := readDirectory(replace)
		if err != nil {
			return "", true, err
		}
		if len(children) != 0 {
			return "", true, fmt.Errorf("Git replace 引用需要完整观察")
		}
	} else {
		if _, err := addFile(replace, false); err != nil {
			return "", true, err
		}
	}
	if err := validate(); err != nil {
		return "", true, err
	}
	return hex.EncodeToString(digest.Sum(nil)), true, nil
}

// A selected directory may inherit a valid repository without owning its Git
// state. The general fingerprint deliberately declines that discovery; preflight
// can still certify file-only mode after Git confirms the selected root is not
// the repository root. Never use this fallback for an existing .git marker.
func localSyncPreflightFingerprint(ctx context.Context, m *Mapping) (string, bool, error) {
	fingerprint, repository, observationErr := localSyncMetadataFingerprint(m)
	if repository || !errors.Is(observationErr, errSyncGitInheritedRepository) {
		return fingerprint, repository, observationErr
	}
	before, exists, err := syncGitMetadataPathStamp(m.LocalPath)
	if err != nil {
		return "", false, err
	}
	if !exists || !before.mode.IsDir() {
		return "", false, observationErr
	}
	marker := filepath.Join(m.LocalPath, ".git")
	if _, err := os.Lstat(marker); !os.IsNotExist(err) {
		if err != nil {
			return "", false, err
		}
		return "", true, observationErr
	}
	owned, err := localGitRepository(ctx, m.LocalPath)
	if err != nil {
		return "", false, err
	}
	if owned {
		return "", true, observationErr
	}
	if _, err := os.Lstat(marker); !os.IsNotExist(err) {
		return "", true, fmt.Errorf("Git 项目根目录标记在观察时改变")
	}
	after, exists, err := syncGitMetadataPathStamp(m.LocalPath)
	if err != nil {
		return "", false, err
	}
	if !exists || !after.mode.IsDir() || before.volume != after.volume || before.high != after.high || before.low != after.low {
		return "", false, fmt.Errorf("Git 工作区目录在观察时改变")
	}
	// Parent refs/index are outside the selected project. Only root identity and
	// its own marker absence belong to this proof; ordinary file edits are safe.
	digest := sha256.Sum256([]byte(fmt.Sprintf("file-only:%s\x00%d:%d:%d", filepath.Clean(m.LocalPath), after.volume, after.high, after.low)))
	return hex.EncodeToString(digest[:]), false, nil
}

var observeSyncGitRemoteMetadata = observeRemoteSyncMetadata

// An observer failure invalidates repository cache evidence. A metadata-only
// fallback can still certify absence without inotify or a worktree inventory.
func observeGitMetadataOrFallback(ctx context.Context, m *Mapping) (syncMetadataObservation, error) {
	observation, err := observeSyncGitRemoteMetadata(ctx, m)
	if err == nil {
		return observation, nil
	}
	if current := workspaceSyncCurrent(ctx); current != nil {
		return observation, current
	}
	bootstrap := "import json,os,sys\nnamespace={'__name__':'sync_metadata_fallback'}\nexec(compile(" + strconvQuoteSyncObserveWorker() + ",'<sync-metadata>','exec'),namespace)\nroot=os.path.realpath(sys.argv[1])\nif os.path.lexists(os.path.join(root,'.git')):\n print(json.dumps({'repository':True}))\nelse:\n first=namespace['fingerprint'](root)\n second=namespace['fingerprint'](root)\n if first['git'] != second['git'] or first['repository'] or second['repository']: raise RuntimeError('Git endpoint changed during observation')\n print(json.dumps({'repository':False,'git':second['git']}))\n"
	out, err := syncGitMetadataRemoteScript(ctx, m, "setpriv --reuid=1000 --regid=1000 --clear-groups env HOME=/nonexistent python3 -B -c "+shellQuote(bootstrap)+" "+shellQuote(m.ServerPath), nil)
	if err != nil {
		return syncMetadataObservation{}, err
	}
	observation = syncMetadataObservation{}
	if err := json.Unmarshal([]byte(out), &observation); err != nil {
		return syncMetadataObservation{}, err
	}
	return observation, nil
}

// JSON string escaping is valid Python for this embedded ASCII source, which
// deliberately contains neither non-ASCII characters nor JSON-only literals.
func strconvQuoteSyncObserveWorker() string {
	encoded, _ := json.Marshal(syncObserveWorker)
	return string(encoded)
}

type syncGitPlan struct {
	mapping                             Mapping
	key                                 syncGitCacheKey
	checkpoint                          *syncGitCheckpoint
	local, remote, desired              syncGitState
	localFingerprint, remoteFingerprint string
	git, unborn                         bool
}

func prepareGitSyncContext(ctx context.Context, m *Mapping) (*syncGitPlan, error) {
	key := syncGitObservationKey(ctx, m)
	localFP, repository, localErr := localSyncPreflightFingerprint(ctx, m)
	remote, err := observeGitMetadataOrFallback(ctx, m)
	if err != nil {
		return nil, err
	}
	if !repository && localErr == nil {
		if remote.Repository || remote.Git == "" {
			return nil, fmt.Errorf("两端 Git 仓库模式不一致或无法确认，请重新同步；已保留两端")
		}
		return &syncGitPlan{mapping: *m, key: key, localFingerprint: localFP, remoteFingerprint: remote.Git}, nil
	}
	if !remote.Repository {
		// Existing durable seeding transfers only Git objects; it never checks out
		// files. Its journal remains responsible for partial first initialization.
		if err := syncGitContext(ctx, m); err != nil {
			return nil, err
		}
		localFP, repository, localErr = localSyncPreflightFingerprint(ctx, m)
		remote, err = observeGitMetadataOrFallback(ctx, m)
		if err != nil {
			return nil, err
		}
		if !remote.Repository {
			if _, headErr := gitOutputContext(ctx, m.LocalPath, "rev-parse", "--verify", "HEAD^{commit}"); headErr != nil {
				branch, branchErr := gitOutputContext(ctx, m.LocalPath, "symbolic-ref", "--quiet", "HEAD")
				if branchErr == nil {
					if _, refErr := gitOutputContext(ctx, m.LocalPath, "show-ref", "--verify", "--quiet", branch); gitExitCode(refErr) == 1 {
						if localErr != nil || !repository || localFP == "" || remote.Git == "" {
							return nil, fmt.Errorf("无法稳定确认未创建提交的 Git 仓库，请等待 Git 操作完成后重试")
						}
						return &syncGitPlan{mapping: *m, key: key, unborn: true, localFingerprint: localFP, remoteFingerprint: remote.Git}, nil
					}
				}
				return nil, headErr
			}
			return nil, fmt.Errorf("远端 Git 仓库未完成初始化，请重试")
		}
	}
	r, err := loadGitCheckpoint(m)
	if err != nil {
		return nil, err
	}
	p := &syncGitPlan{mapping: *m, key: key, checkpoint: r, git: true}
	if cache, ok := syncGitObservations.Load(key); ok && r.Pending == nil && r.Version >= 2 && r.State.Head != "" && localErr == nil && remote.Git != "" {
		entry := cache.(syncGitObservationCache)
		if entry.local == localFP && entry.remote == remote.Git && entry.state == r.State {
			p.local, p.remote, p.desired = entry.state, entry.state, entry.state
			p.localFingerprint, p.remoteFingerprint = localFP, remote.Git
			return p, nil
		}
	}
	if err := p.readStable(ctx, m); err != nil {
		return nil, err
	}
	if err = verifySyncGitRecoveryPlan(ctx, p); err != nil {
		return nil, err
	}
	if err = fetchSyncGitHead(ctx, m, p.local, p.remote); err != nil {
		return nil, err
	}
	p.desired, err = selectGitState(ctx, m, r, p.local, p.remote)
	if err != nil {
		return nil, err
	}
	if err = preflightSyncGitState(ctx, m, p.local, p.remote, p.desired); err != nil {
		return nil, err
	}
	return p, nil
}

func fetchSyncGitHead(ctx context.Context, m *Mapping, local, remote syncGitState) error {
	if local.Head == remote.Head {
		return nil
	}
	cfg := workspaceSyncConfig(ctx)
	url := cfg.SSHUser + "@" + cfg.SSHHost + ":" + m.ServerPath
	_, err := gitOutputContext(ctx, m.LocalPath, "fetch", "--no-tags", "--no-write-fetch-head", "--no-auto-maintenance", "--upload-pack=setpriv --reuid=1000 --regid=1000 --clear-groups env HOME=/nonexistent git -c core.hooksPath=/dev/null -c core.fsmonitor=false upload-pack", url, "HEAD")
	return err
}

// Test fixtures replace only the transport with real local fetch/push between
// independent object databases. Selection, preflight and apply remain production.
var provisionSyncGitObjects = transferSyncGitObjects
var runSyncGitPreflightWorker = syncGitMetadataRemoteScript

func transferSyncGitObjects(ctx context.Context, m *Mapping, local, remote, desired syncGitState) error {
	if local == desired && remote == desired {
		return nil
	}
	cfg := workspaceSyncConfig(ctx)
	url := cfg.SSHUser + "@" + cfg.SSHHost + ":" + m.ServerPath
	// The synthetic commit retains HEAD's full history plus index/operation
	// objects. Publishing only under a unique private namespace cannot move a
	// user's branch, HEAD, index or worktree. Receiver target CAS is still later.
	ref := "refs/chisa/transfer/" + randHex(16)
	if desired == remote {
		if _, err := remoteGitSnapshot(ctx, m, desired, ref); err != nil {
			return err
		}
		_, err := gitOutputContext(ctx, m.LocalPath, "fetch", "--no-tags", "--no-write-fetch-head", "--no-auto-maintenance",
			"--upload-pack=setpriv --reuid=1000 --regid=1000 --clear-groups env HOME=/nonexistent git -c core.hooksPath=/dev/null -c core.fsmonitor=false upload-pack", url, ref)
		return err
	}
	if _, err := localGitSnapshot(ctx, m, desired, ref); err != nil {
		return err
	}
	receive, err := syncRemoteJobCommand(ctx, m, "receive-pack", "")
	if err != nil {
		return err
	}
	_, err = gitOutputContext(ctx, m.LocalPath, "push", "--receive-pack="+receive, url, ref+":"+ref)
	return err
}

func preflightSyncGitState(ctx context.Context, m *Mapping, local, remote, desired syncGitState) error {
	preview, _ := ctx.Value(syncGitPreviewKey{}).(bool)
	if !preview {
		// Ancestry needs the desired HEAD (and rebase parents) in the receiver's
		// object database. Transfer immutable objects before any target checks.
		if err := provisionSyncGitObjects(ctx, m, local, remote, desired); err != nil {
			return err
		}
	}
	if local != desired {
		if _, err := localGitTarget(ctx, m, local, desired); err != nil {
			return err
		}
		branch, head, err := gitRebaseOriginal(desired)
		if err != nil {
			return err
		}
		if branch != "" {
			if _, err = localGitTarget(ctx, m, local, syncGitState{Branch: branch, Head: head}); err != nil {
				return err
			}
		}
	}
	if remote != desired {
		op := "preflight"
		if preview {
			op = "preview-targets"
		}
		request, _ := json.Marshal(map[string]any{"root": m.ServerPath, "op": op, "before": remote, "desired": desired})
		out, err := runSyncGitPreflightWorker(ctx, m, "setpriv --reuid=1000 --regid=1000 --clear-groups env HOME=/nonexistent python3 -c "+shellQuote(syncGitApplyWorker), bytes.NewReader(request))
		if err != nil {
			return err
		}
		if preview {
			return preflightSyncGitPreviewTargets(ctx, m, remote, desired, out)
		}
	}
	return nil
}

func preflightSyncGitPreviewTargets(ctx context.Context, m *Mapping, before, desired syncGitState, output string) error {
	var tips map[string]string
	if err := json.Unmarshal([]byte(output), &tips); err != nil {
		return err
	}
	ctx, discard, err := syncGitPreviewObjectsContext(ctx, m)
	if err != nil {
		return err
	}
	defer discard()
	targets := []syncGitState{}
	if desired.Branch != "" {
		targets = append(targets, desired)
	}
	branch, head, err := gitRebaseOriginal(desired)
	if err != nil {
		return err
	}
	if branch != "" {
		targets = append(targets, syncGitState{Branch: branch, Head: head})
	}
	for _, target := range targets {
		old, present := tips[target.Branch]
		if !present || (old != "" && !syncGitHeadOID(old)) {
			return fmt.Errorf("无法确认接收端 Git 目标分支")
		}
		if old == "" || target.Branch == before.Branch || old == target.Head || gitRebaseOwnsTarget(before, target.Branch, old) {
			continue
		}
		if _, err := gitOutputContext(ctx, m.LocalPath, "cat-file", "-e", old+"^{commit}"); err != nil {
			cfg := workspaceSyncConfig(ctx)
			url := cfg.SSHUser + "@" + cfg.SSHHost + ":" + m.ServerPath
			// Fetch only the observed immutable tip; never resolve a possibly
			// changed branch name into a different ancestry expectation.
			if _, err = gitOutputContext(ctx, m.LocalPath, "fetch", "--no-tags", "--no-write-fetch-head", "--no-auto-maintenance",
				"--upload-pack=setpriv --reuid=1000 --regid=1000 --clear-groups env HOME=/nonexistent git -c core.hooksPath=/dev/null -c core.fsmonitor=false upload-pack", url, old); err != nil {
				return err
			}
		}
		if _, err := gitOutputContext(ctx, m.LocalPath, "merge-base", "--is-ancestor", old, target.Head); err != nil {
			if gitExitCode(err) == 1 {
				return fmt.Errorf("目标 Git 分支包含独立提交，已保留其历史，请先处理分支冲突")
			}
			return err
		}
	}
	return nil
}

// Fingerprints before and after the portable read belong to that exact state.
// Never associate an earlier state with a later index/HEAD observation.
func (p *syncGitPlan) readStable(ctx context.Context, m *Mapping) error {
	repository, err := localGitRepository(ctx, m.LocalPath)
	if err != nil {
		return err
	}
	if !repository {
		return fmt.Errorf("本地 Git 仓库不属于项目根目录")
	}
	for attempt := 0; attempt < 2; attempt++ {
		before, localRepoBefore, beforeErr := localSyncMetadataFingerprint(m)
		otherBefore, err := observeGitMetadataOrFallback(ctx, m)
		if err != nil {
			return err
		}
		if !otherBefore.Repository || (beforeErr == nil && !localRepoBefore) {
			return fmt.Errorf("Git 仓库模式在观察时改变")
		}
		local, err := readLocalGitState(ctx, m)
		if err != nil {
			return err
		}
		remote, err := readRemoteGitState(ctx, m)
		if err != nil {
			return err
		}
		after, localRepoAfter, afterErr := localSyncMetadataFingerprint(m)
		otherAfter, err := observeGitMetadataOrFallback(ctx, m)
		if err != nil {
			return err
		}
		if !otherAfter.Repository || (afterErr == nil && !localRepoAfter) {
			return fmt.Errorf("Git 仓库模式在观察时改变")
		}
		if beforeErr == nil && afterErr == nil && before != after {
			continue
		}
		if otherBefore.Git != "" && otherAfter.Git != "" && otherBefore.Git != otherAfter.Git {
			continue
		}
		// Without observation proof, a second guarded read is required. This is a
		// fallback only, never the steady path of a healthy active session.
		if beforeErr != nil || afterErr != nil || otherBefore.Git == "" || otherAfter.Git == "" {
			localAgain, err := readLocalGitState(ctx, m)
			if err != nil {
				return err
			}
			remoteAgain, err := readRemoteGitState(ctx, m)
			if err != nil {
				return err
			}
			if localAgain != local || remoteAgain != remote {
				continue
			}
			p.localFingerprint, p.remoteFingerprint = "", ""
		} else {
			p.localFingerprint, p.remoteFingerprint = after, otherAfter.Git
		}
		p.local, p.remote = local, remote
		return nil
	}
	return fmt.Errorf("Git 元数据持续变化，请等待 Git 操作完成后重试；已保留两端")
}

func (p *syncGitPlan) verify(ctx context.Context, m *Mapping) error {
	if err := workspaceSyncCurrent(ctx); err != nil {
		return err
	}
	if p.mapping != *m || p.key != syncGitObservationKey(ctx, m) {
		return fmt.Errorf("同步期间项目绑定或连接已改变")
	}
	local, repository, err := localSyncPreflightFingerprint(ctx, m)
	remote, remoteErr := observeGitMetadataOrFallback(ctx, m)
	if remoteErr != nil {
		return remoteErr
	}
	if !p.git {
		if err != nil || repository != p.unborn || remote.Repository || p.localFingerprint == "" || p.remoteFingerprint == "" || local != p.localFingerprint || remote.Git != p.remoteFingerprint {
			return fmt.Errorf("文件同步期间 Git 仓库模式或元数据已改变，请重新同步；已保留两端")
		}
		return nil
	}
	if !remote.Repository || (err == nil && !repository) {
		return fmt.Errorf("文件同步期间 Git 仓库模式已改变，请重新同步；已保留两端")
	}
	if p.localFingerprint != "" && err == nil && p.remoteFingerprint != "" && remote.Git != "" {
		if local != p.localFingerprint || remote.Git != p.remoteFingerprint {
			return fmt.Errorf("文件同步期间 Git 状态发生改变，请重新同步；已保留两端")
		}
		return nil
	}
	owned, err := localGitRepository(ctx, m.LocalPath)
	if err != nil {
		return err
	}
	if !owned {
		return fmt.Errorf("本地 Git 仓库不属于项目根目录")
	}
	actual, err := readLocalGitState(ctx, m)
	if err != nil {
		return err
	}
	other, err := readRemoteGitState(ctx, m)
	if err != nil {
		return err
	}
	if actual != p.local || other != p.remote {
		return fmt.Errorf("文件同步期间 Git 状态发生改变，请重新同步；已保留两端")
	}
	return nil
}

func (p *syncGitPlan) apply(ctx context.Context, m *Mapping) error {
	if err := p.verify(ctx, m); err != nil {
		return err
	}
	if !p.git {
		return nil
	}
	if p.local == p.desired && p.remote == p.desired {
		return nil
	}
	if err := applyPreparedGitState(ctx, m, p.checkpoint, p.local, p.remote, p.desired); err != nil {
		return err
	}
	if err := p.readStable(ctx, m); err != nil {
		return err
	}
	if p.local != p.desired || p.remote != p.desired {
		return fmt.Errorf("Git 交接期间又有新修改，请重新同步；已保留修改")
	}
	return nil
}

func (p *syncGitPlan) finish(ctx context.Context, m *Mapping) error {
	if err := p.verify(ctx, m); err != nil {
		return err
	}
	if !p.git {
		return nil
	}
	if err := finishGitCheckpoint(m, p.checkpoint, p.desired); err != nil {
		return err
	}
	if p.localFingerprint != "" && p.remoteFingerprint != "" {
		syncGitObservations.Store(p.key, syncGitObservationCache{p.localFingerprint, p.remoteFingerprint, p.desired})
	}
	return workspaceSyncCurrent(ctx)
}
