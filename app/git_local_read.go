package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"errors"
	"io"
	"io/fs"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"time"
	"unicode"
)

const localGitReadLimit = 8 * 1024 * 1024
const localGitLogFormat = "--pretty=format:%H%x1f%P%x1f%D%x1f%an%x1f%ae%x1f%ad%x1f%s"

// This is an explicit, account-bound SCM capability, not a general local exec
// or filesystem fallback. The caller owns the existing workspace mutex.
func localGitReadRPC(parent context.Context, m *Mapping, request map[string]any) (result map[string]any) {
	action, _ := request["action"].(string)
	if !slices.Contains([]string{"prepare", "command", "stat", "lstat", "read", "realpath"}, action) {
		return localGitReadError("INVALID_REQUEST", "Unsupported local Git read action")
	}
	for key := range request {
		if key != "op" && key != "action" && key != "path" && !(action == "command" && key == "argv") {
			return localGitReadError("INVALID_REQUEST", "Unsupported local Git read option")
		}
	}
	ctx, cancel, err := bindWorkspaceSyncConnection(parent)
	if err != nil {
		return localGitReadError("WORKSPACE_UNAVAILABLE", "工作区账号或连接已改变")
	}
	defer cancel()
	binding := *m
	defer func() {
		current := store.findMappingByServer(binding.ServerPath)
		if current == nil || *current != binding {
			result = localGitReadError("STALE_BINDING", "工作区绑定已改变")
		} else if err := workspaceSyncCurrent(ctx); err != nil {
			result = localGitReadError("WORKSPACE_UNAVAILABLE", "本地 Git 读取已取消或账号连接已改变")
		}
	}()
	if _, busy := cloudReservations.Load(m.ServerPath); busy || piWorkspaceOwned(m.ServerPath) {
		return localGitReadError("WORKSPACE_BUSY", "工作区正在由任务使用，请等待交还后读取源码管理")
	}
	if active, busy := activeSyncOperations()[m.ServerPath]; busy && active.BindingEpoch == m.BindingEpoch {
		return localGitReadError("WORKSPACE_BUSY", "工作区正在同步，请等待同步完成")
	}
	rootPath, err := filepath.EvalSymlinks(m.LocalPath)
	if err != nil {
		return localGitReadFileError(err)
	}
	root, err := os.OpenRoot(rootPath)
	if err != nil {
		return localGitReadFileError(err)
	}
	defer root.Close()
	inside, err := localGitReadRepository(ctx, rootPath, root)
	if err != nil {
		return localGitReadError("WORKSPACE_UNAVAILABLE", "无法确认本地 Git 仓库")
	}
	if !inside {
		if action == "prepare" {
			return map[string]any{"ok": true, "localGitRead": false}
		}
		return localGitReadError("WORKSPACE_GIT_CHANGED", "绑定目录已不再是原 Git 仓库根目录")
	}
	if action == "prepare" {
		_, unsupported, err := localGitReadSafety(ctx, rootPath)
		if err != nil {
			return localGitReadError("WORKSPACE_UNAVAILABLE", "无法确认本地 Git 只读能力")
		}
		if unsupported != "" {
			return map[string]any{"ok": true, "localGitRead": false, "reason": unsupported}
		}
		return map[string]any{"ok": true, "localGitRead": true, "gitBranch": true}
	}
	virtual, valid := request["path"].(string)
	if !valid {
		return localGitReadError("INVALID_REQUEST", "Local Git read requires a workspace path")
	}
	relative, err := localGitReadRelative(virtual)
	if err != nil {
		return localGitReadError("EACCES", "Path is outside the workspace")
	}
	if action == "command" {
		argv, valid := localGitReadArgv(request["argv"])
		if !valid {
			return localGitReadError("INVALID_REQUEST", "Invalid local Git read arguments")
		}
		args, err := localGitReadArguments(root, relative, argv)
		if err != nil {
			return localGitReadError("INVALID_REQUEST", "Unsupported local Git read command or path")
		}
		cwd, err := root.OpenRoot(relative)
		if err != nil {
			return localGitReadFileError(err)
		}
		defer cwd.Close()
		cwdPath, err := filepath.EvalSymlinks(filepath.Join(rootPath, relative))
		if err != nil {
			return localGitReadFileError(err)
		}
		if relative != "." {
			cwdRepository, err := localGitReadRepository(ctx, cwdPath, root)
			if err != nil || !cwdRepository {
				return localGitReadError("WORKSPACE_GIT_CHANGED", "Git 读取路径不属于绑定仓库")
			}
		}
		var filters []string
		if args[0] == "status" || args[0] == "diff" {
			var unsupported string
			filters, unsupported, err = localGitReadSafety(ctx, rootPath)
			if err != nil {
				return localGitReadError("WORKSPACE_UNAVAILABLE", "无法确认本地 Git 只读能力")
			}
			if unsupported != "" {
				return localGitReadError("WORKSPACE_GIT_CHANGED", "仓库需要外部 Git 过滤器或子模块，请刷新后使用服务器读取")
			}
		}
		response, err := runLocalGitReadInput(ctx, rootPath, cwdPath, args, nil, filters)
		if err != nil {
			return localGitReadError("WORKSPACE_UNAVAILABLE", "本地 Git 读取已取消或无法启动")
		}
		if err := confirmLocalGitReadResult(ctx, rootPath, args); err != nil {
			return localGitReadError("WORKSPACE_GIT_CHANGED", "读取期间仓库过滤器或子模块发生变化，请刷新源码管理")
		}
		if len(args) == 2 && args[0] == "rev-parse" && args[1] == "--show-toplevel" && response.exitCode == 0 {
			response.stdout = "/workspace\n"
		}
		return map[string]any{"ok": true, "stdout": response.stdout, "stderr": localGitReadVirtualError(response.stderr, rootPath), "exitCode": response.exitCode, "timedOut": false, "truncated": response.truncated}
	}
	file, err := root.Open(relative)
	if err != nil {
		return localGitReadFileError(err)
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return localGitReadFileError(err)
	}
	switch action {
	case "stat", "lstat":
		linkInfo, err := root.Lstat(relative)
		if err != nil {
			return localGitReadFileError(err)
		}
		if action == "lstat" {
			info = linkInfo
		}
		mode := uint32(info.Mode().Perm()) | 0100000
		if info.IsDir() {
			mode = uint32(info.Mode().Perm()) | 0040000
		} else if info.Mode()&fs.ModeSymlink != 0 {
			mode = uint32(info.Mode().Perm()) | 0120000
		}
		return map[string]any{"ok": true, "size": info.Size(), "mtime": float64(info.ModTime().UnixNano()) / 1e9, "mode": mode, "dir": info.IsDir(), "symlink": linkInfo.Mode()&fs.ModeSymlink != 0}
	case "realpath":
		resolved, err := filepath.EvalSymlinks(filepath.Join(rootPath, relative))
		if err != nil {
			return localGitReadFileError(err)
		}
		rel, err := filepath.Rel(rootPath, resolved)
		if err != nil || !filepath.IsLocal(rel) {
			return localGitReadError("EACCES", "Path is outside the workspace")
		}
		current, err := root.Stat(rel)
		if err != nil || !os.SameFile(info, current) {
			return localGitReadError("EACCES", "Workspace path changed while resolving it")
		}
		return map[string]any{"ok": true, "path": path.Join("/workspace", filepath.ToSlash(rel))}
	case "read":
		if !info.Mode().IsRegular() {
			return localGitReadError("EACCES", "Workspace read requires a regular file")
		}
		if info.Size() > localGitReadLimit {
			return localGitReadError("INVALID_REQUEST", "File exceeds the 8 MiB workspace limit")
		}
		data, err := io.ReadAll(io.LimitReader(file, localGitReadLimit+1))
		if err != nil {
			return localGitReadFileError(err)
		}
		if len(data) > localGitReadLimit {
			return localGitReadError("INVALID_REQUEST", "File exceeds the 8 MiB workspace limit")
		}
		return map[string]any{"ok": true, "b64": base64.StdEncoding.EncodeToString(data)}
	}
	return localGitReadError("INVALID_REQUEST", "Unsupported local Git read action")
}

func localGitReadError(code, message string) map[string]any {
	return map[string]any{"ok": false, "error": message, "code": code}
}

func localGitReadFileError(err error) map[string]any {
	if errors.Is(err, fs.ErrNotExist) {
		return localGitReadError("ENOENT", "Workspace path does not exist")
	}
	return localGitReadError("EACCES", "Workspace path cannot be read safely")
}

func localGitReadRelative(virtual string) (string, error) {
	if strings.ContainsAny(virtual, "\\:\x00") || (virtual != "/workspace" && !strings.HasPrefix(virtual, "/workspace/")) {
		return "", fs.ErrPermission
	}
	relative := strings.TrimPrefix(strings.TrimPrefix(virtual, "/workspace"), "/")
	for _, component := range strings.Split(relative, "/") {
		if component == ".." || strings.EqualFold(component, ".chisa-bridge.json") {
			return "", fs.ErrPermission
		}
	}
	if relative == "" {
		relative = "."
	}
	if !filepath.IsLocal(filepath.FromSlash(relative)) {
		return "", fs.ErrPermission
	}
	return filepath.FromSlash(relative), nil
}

func localGitReadArgv(value any) ([]string, bool) {
	var args []string
	switch typed := value.(type) {
	case []string:
		args = slices.Clone(typed)
	case []any:
		for _, item := range typed {
			arg, ok := item.(string)
			if !ok {
				return nil, false
			}
			args = append(args, arg)
		}
	}
	if len(args) < 2 || args[0] != "git" {
		return nil, false
	}
	args = args[1:]
	if args[0] == "--no-optional-locks" {
		args = args[1:]
	}
	return args, len(args) > 0
}

// Every admitted form comes from the existing SCM read service. Paths are
// literal pathspecs and may contain spaces, Unicode or a leading dash after --.
func localGitReadArguments(root *os.Root, cwd string, args []string) ([]string, error) {
	for _, arg := range args {
		if strings.ContainsRune(arg, 0) {
			return nil, fs.ErrInvalid
		}
	}
	valid := false
	fileIndex := -1
	switch args[0] {
	case "rev-parse":
		valid = slices.Equal(args, []string{"rev-parse", "--is-inside-work-tree"}) || slices.Equal(args, []string{"rev-parse", "--show-toplevel"}) ||
			slices.Equal(args, []string{"rev-parse", "--verify", "HEAD"}) || slices.Equal(args, []string{"rev-parse", "--verify", "HEAD^{commit}"}) ||
			slices.Equal(args, []string{"rev-parse", "--abbrev-ref", "HEAD"})
		if len(args) == 3 && args[1] == "--abbrev-ref" && strings.HasSuffix(args[2], "@{upstream}") {
			valid = localGitReadRef(strings.TrimSuffix(args[2], "@{upstream}"))
		}
	case "symbolic-ref":
		valid = slices.Equal(args, []string{"symbolic-ref", "HEAD"}) || slices.Equal(args, []string{"symbolic-ref", "--short", "HEAD"})
	case "status":
		valid = slices.Equal(args, []string{"status", "--porcelain=v1", "-z"}) || slices.Equal(args, []string{"status", "--porcelain"})
		if len(args) == 4 && args[1] == "--porcelain" && args[2] == "--" {
			valid, fileIndex = true, 3
		}
	case "branch":
		valid = slices.Equal(args, []string{"branch", "-a"})
	case "remote":
		valid = len(args) == 1
	case "rev-list":
		valid = len(args) == 4 && args[1] == "--count" && args[2] == "--left-right" && strings.HasSuffix(args[3], "...HEAD") && localGitReadRef(strings.TrimSuffix(args[3], "...HEAD"))
	case "diff":
		if len(args) == 3 && args[1] == "--" {
			valid, fileIndex = true, 2
		} else if len(args) == 4 && (args[1] == "--cached" || args[1] == "HEAD") && args[2] == "--" {
			valid, fileIndex = true, 3
		}
	case "show":
		if len(args) == 2 {
			if strings.HasPrefix(args[1], "HEAD:") {
				file := strings.TrimPrefix(args[1], "HEAD:")
				if _, err := localGitReadFileArgument(root, ".", file); err != nil {
					return nil, err
				}
				valid = file != "" && !strings.HasPrefix(file, "/") && path.Clean(file) == file
			} else {
				valid = localGitReadRef(args[1])
			}
		}
	case "log":
		if len(args) == 10 && slices.Equal(args[:9], []string{"log", "--branches", "--remotes", "--tags", "--topo-order", "--shortstat", localGitLogFormat, "--date=iso-strict", "-n"}) {
			limit, err := strconv.Atoi(args[9])
			valid = err == nil && limit >= 1 && limit <= 100
		}
	}
	if !valid {
		return nil, fs.ErrInvalid
	}
	args = slices.Clone(args)
	if fileIndex >= 0 {
		value, fileCWD := args[fileIndex], cwd
		if name, ok := strings.CutPrefix(value, ":(top,literal)"); ok {
			value, fileCWD = name, "."
		} else {
			value = strings.TrimPrefix(value, ":(literal)")
		}
		// The executor already forces --literal-pathspecs. Consume only our
		// explicit producer modifiers, then validate the actual filesystem path.
		file, err := localGitReadFileArgument(root, fileCWD, value)
		if err != nil {
			return nil, err
		}
		if fileCWD != cwd {
			file, err = filepath.Rel(cwd, file)
			if err != nil {
				return nil, err
			}
			file = filepath.ToSlash(file)
		}
		args[fileIndex] = file
	}
	return args, nil
}

func localGitReadFileArgument(root *os.Root, cwd, value string) (string, error) {
	virtual := value
	if !strings.HasPrefix(virtual, "/") {
		virtual = "/workspace/" + filepath.ToSlash(filepath.Join(cwd, value))
	}
	relative, err := localGitReadRelative(virtual)
	if err != nil || relative == "." {
		return "", fs.ErrPermission
	}
	// Deleted files are valid SCM inputs. Resolve their nearest existing parent
	// through the confined Root instead of weakening the symlink boundary.
	check := relative
	for {
		file, err := root.Open(check)
		if err == nil {
			file.Close()
			break
		}
		if !errors.Is(err, fs.ErrNotExist) || check == "." {
			return "", fs.ErrPermission
		}
		check = filepath.Dir(check)
	}
	fromCWD, err := filepath.Rel(cwd, relative)
	if err != nil || !filepath.IsLocal(fromCWD) {
		return "", fs.ErrPermission
	}
	return filepath.ToSlash(fromCWD), nil
}

func localGitReadRef(value string) bool {
	if value == "" || strings.HasPrefix(value, "-") || strings.HasPrefix(value, ".") || strings.HasPrefix(value, "/") || strings.Contains(value, "..") {
		return false
	}
	for _, r := range value {
		if unicode.IsControl(r) || unicode.IsSpace(r) || strings.ContainsRune("\\:?*[", r) {
			return false
		}
	}
	return true
}

func localGitReadRepository(ctx context.Context, cwd string, root *os.Root) (bool, error) {
	response, err := runLocalGitRead(ctx, root.Name(), cwd, []string{"rev-parse", "--show-toplevel"})
	if err != nil {
		return false, err
	}
	if response.exitCode != 0 {
		if strings.Contains(response.stderr, "not a git repository") || strings.Contains(response.stderr, "must be run in a work tree") {
			return false, nil
		}
		return false, fs.ErrInvalid
	}
	selected, err := root.Stat(".")
	if err != nil {
		return false, err
	}
	repository, err := os.Stat(strings.TrimSpace(response.stdout))
	if err != nil {
		return false, err
	}
	return os.SameFile(selected, repository), nil
}

type localGitReadOutput struct {
	stdout, stderr string
	exitCode       int
	truncated      bool
}

type localGitReadBuffer struct {
	buffer    bytes.Buffer
	truncated bool
}

func (b *localGitReadBuffer) Write(data []byte) (int, error) {
	n := len(data)
	left := localGitReadLimit - b.buffer.Len()
	if len(data) > left {
		b.truncated = true
		data = data[:left]
	}
	_, err := b.buffer.Write(data)
	return n, err
}

func (b *localGitReadBuffer) String() string { return b.buffer.String() }

func runLocalGitRead(ctx context.Context, root, cwd string, args []string) (localGitReadOutput, error) {
	return runLocalGitReadInput(ctx, root, cwd, args, nil, nil)
}

func runLocalGitReadInput(ctx context.Context, root, cwd string, args []string, input []byte, filterOptions []string) (localGitReadOutput, error) {
	if err := ctx.Err(); err != nil {
		return localGitReadOutput{}, err
	}
	fixed := []string{"--no-pager", "--no-optional-locks", "--literal-pathspecs", "--no-lazy-fetch", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "diff.external=", "-c", "color.ui=false", "-c", "log.showSignature=false", "-c", "safe.directory=" + root}
	fixed = append(fixed, filterOptions...)
	if args[0] == "diff" || args[0] == "show" || args[0] == "log" {
		args = append([]string{args[0], "--no-ext-diff", "--no-textconv", "--no-color"}, args[1:]...)
	}
	if args[0] == "show" {
		args = append(args, "--")
	}
	cmd := exec.CommandContext(ctx, "git", append(fixed, args...)...)
	cmd.Dir, cmd.WaitDelay = cwd, time.Second
	if input != nil {
		cmd.Stdin = bytes.NewReader(input)
	}
	for _, entry := range os.Environ() {
		key, _, _ := strings.Cut(entry, "=")
		if !strings.HasPrefix(strings.ToUpper(key), "GIT_") {
			cmd.Env = append(cmd.Env, entry)
		}
	}
	cmd.Env = append(cmd.Env, "LC_ALL=C", "LANG=C", "GIT_OPTIONAL_LOCKS=0", "GIT_TERMINAL_PROMPT=0", "GIT_NO_LAZY_FETCH=1")
	var stdout, stderr localGitReadBuffer
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	preparePiProcess(cmd)
	if err := cmd.Start(); err != nil {
		return localGitReadOutput{}, err
	}
	guard, err := attachPiProcess(cmd)
	if err != nil {
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
		return localGitReadOutput{}, err
	}
	defer guard.close()
	err = cmd.Wait()
	if ctx.Err() != nil {
		return localGitReadOutput{}, ctx.Err()
	}
	result := localGitReadOutput{stdout: stdout.String(), stderr: stderr.String(), truncated: stdout.truncated || stderr.truncated}
	var exit *exec.ExitError
	if errors.As(err, &exit) {
		result.exitCode = exit.ExitCode()
	} else if err != nil {
		return localGitReadOutput{}, err
	}
	return result, nil
}

func localGitReadVirtualError(message, root string) string {
	message = strings.ReplaceAll(message, root, "/workspace")
	return strings.ReplaceAll(message, filepath.ToSlash(root), "/workspace")
}

// Registered but unused drivers (notably global Git LFS) are harmless. Reject
// actual filter attributes and gitlinks instead of returning inaccurate status
// after silently disabling their conversion. Worktree comparisons repeat this
// check before and after execution; refs/history commands do not run conversion.
func localGitReadSafety(ctx context.Context, root string) ([]string, string, error) {
	configured, err := runLocalGitRead(ctx, root, root, []string{"config", "--null", "--name-only", "--get-regexp", `^filter\..*\.(clean|process)$`})
	if err != nil || configured.exitCode > 1 || configured.truncated {
		return nil, "", fs.ErrInvalid
	}
	var filters []string
	seen := map[string]bool{}
	for _, key := range strings.Split(configured.stdout, "\x00") {
		if key == "" {
			continue
		}
		driver := strings.TrimSuffix(strings.TrimSuffix(key, ".clean"), ".process")
		if strings.ContainsAny(driver, "=\r\n\x00") || !strings.HasPrefix(driver, "filter.") {
			return nil, "external-filter", nil
		}
		if !seen[driver] {
			seen[driver] = true
			filters = append(filters, "-c", driver+".clean=", "-c", driver+".process=")
		}
	}
	tracked, err := runLocalGitRead(ctx, root, root, []string{"ls-files", "--stage", "-z"})
	if err != nil || tracked.exitCode != 0 || tracked.truncated {
		return nil, "", fs.ErrInvalid
	}
	var paths bytes.Buffer
	for _, entry := range strings.Split(tracked.stdout, "\x00") {
		if entry == "" {
			continue
		}
		metadata, name, valid := strings.Cut(entry, "\t")
		if !valid {
			return nil, "", fs.ErrInvalid
		}
		if strings.HasPrefix(metadata, "160000 ") {
			return nil, "submodule", nil
		}
		paths.WriteString(name)
		paths.WriteByte(0)
	}
	if paths.Len() == 0 {
		return filters, "", nil
	}
	attributes, err := runLocalGitReadInput(ctx, root, root, []string{"check-attr", "-z", "--stdin", "filter"}, paths.Bytes(), nil)
	if err != nil || attributes.exitCode != 0 || attributes.truncated {
		return nil, "", fs.ErrInvalid
	}
	parts := strings.Split(strings.TrimSuffix(attributes.stdout, "\x00"), "\x00")
	if len(parts)%3 != 0 {
		return nil, "", fs.ErrInvalid
	}
	for i := 2; i < len(parts); i += 3 {
		if parts[i] != "unspecified" && parts[i] != "unset" {
			return nil, "external-filter", nil
		}
	}
	return filters, "", nil
}

// Empty clean/process overrides prevent known helpers from executing, but Git
// may then compare raw bytes successfully. Never expose that result if actual
// filter attributes or gitlinks appeared while status/diff was running.
func confirmLocalGitReadResult(ctx context.Context, root string, args []string) error {
	if args[0] != "status" && args[0] != "diff" {
		return nil
	}
	_, unsupported, err := localGitReadSafety(ctx, root)
	if err != nil || unsupported != "" {
		return fs.ErrPermission
	}
	return nil
}
