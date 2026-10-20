package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
)

const syncGitStagesPrefix = "stages-v1:"
const syncGitOperationsPrefix = "files-v1:"

// Unlike an index tree, this portable listing represents all of stages 0/1/2/3.
// Keep it a string so existing checkpoint comparisons and old clean checkpoints
// retain their value semantics. File names and contents are never line-delimited.
type syncGitIndexEntry struct {
	mode, oid, stage, name string
}

func syncGitIndexEntries(value string) ([]syncGitIndexEntry, []byte, error) {
	if !strings.HasPrefix(value, syncGitStagesPrefix) {
		return nil, nil, nil
	}
	data, err := base64.StdEncoding.DecodeString(strings.TrimPrefix(value, syncGitStagesPrefix))
	if err != nil || len(data) == 0 || data[len(data)-1] != 0 {
		return nil, nil, fmt.Errorf("无效的 Git 冲突索引记录")
	}
	entries := []syncGitIndexEntry{}
	unmerged := false
	for _, record := range strings.Split(string(data[:len(data)-1]), "\x00") {
		metadata, name, ok := strings.Cut(record, "\t")
		fields := strings.Split(metadata, " ")
		if !ok || len(fields) != 3 || name == "" || strings.HasPrefix(name, "/") || strings.Contains(name, "\\") {
			return nil, nil, fmt.Errorf("无效的 Git 冲突索引路径")
		}
		for _, part := range strings.Split(name, "/") {
			if part == "" || part == "." || part == ".." || strings.EqualFold(part, ".git") {
				return nil, nil, fmt.Errorf("无效的 Git 冲突索引路径")
			}
		}
		if !syncGitOID.MatchString(fields[1]) || !strings.Contains("0123", fields[2]) || len(fields[2]) != 1 ||
			(fields[0] != "100644" && fields[0] != "100755" && fields[0] != "120000" && fields[0] != "160000") {
			return nil, nil, fmt.Errorf("无效的 Git 冲突索引条目")
		}
		unmerged = unmerged || fields[2] != "0"
		entries = append(entries, syncGitIndexEntry{fields[0], fields[1], fields[2], name})
	}
	if !unmerged {
		return nil, nil, fmt.Errorf("Git 冲突索引记录不包含冲突")
	}
	return entries, data, nil
}

var syncGitOID = regexp.MustCompile(`^(?:[a-f0-9]{40}|[a-f0-9]{64})$`)
var syncGitMentionedOID = regexp.MustCompile(`\b(?:[a-f0-9]{64}|[a-f0-9]{40})\b`)

func readGitIndexState(ctx context.Context, m *Mapping, env []string) (string, error) {
	preview, _ := ctx.Value(syncGitPreviewKey{}).(bool)
	listingArgs := []string{"ls-files", "--stage", "-z"}
	if preview {
		var discard func()
		var err error
		env, discard, err = syncGitPreviewIndexEnvironment(ctx, m, env)
		if err != nil {
			return "", err
		}
		defer discard()
		// Expanding a sparse index can write cache trees through alternates.
		// Directory entries are stage zero and need no expansion to find conflicts.
		listingArgs = append(listingArgs, "--sparse")
	}
	listing, err := gitOutputContextEnv(ctx, m.LocalPath, env, listingArgs...)
	if err != nil {
		return "", err
	}
	for _, record := range strings.Split(listing, "\x00") {
		metadata, _, _ := strings.Cut(record, "\t")
		if strings.HasSuffix(metadata, " 1") || strings.HasSuffix(metadata, " 2") || strings.HasSuffix(metadata, " 3") {
			return syncGitStagesPrefix + base64.StdEncoding.EncodeToString([]byte(listing)), nil
		}
	}
	if preview {
		// Git may freshen an existing alternate object while writing the same
		// tree. Build only in the disposable object database; index entries
		// already contain blob IDs, so missing blobs need not be opened here.
		private := append(append([]string{}, env...), "GIT_ALTERNATE_OBJECT_DIRECTORIES=")
		return gitOutputContextEnv(ctx, m.LocalPath, private, "write-tree", "--missing-ok")
	}
	return gitOutputContextEnv(ctx, m.LocalPath, env, "write-tree")
}

func installGitIndexState(ctx context.Context, m *Mapping, env []string, value string) error {
	_, listing, err := syncGitIndexEntries(value)
	if err != nil {
		return err
	}
	if listing == nil {
		_, err = gitOutputContextEnv(ctx, m.LocalPath, env, "read-tree", value)
		return err
	}
	if _, err = gitOutputContextEnv(ctx, m.LocalPath, env, "read-tree", "--empty"); err != nil {
		return err
	}
	if _, err = gitOutputContextEnvInput(ctx, m.LocalPath, env, listing, "update-index", "-z", "--index-info"); err != nil {
		return err
	}
	actual, err := readGitIndexState(ctx, m, env)
	if err == nil && actual != value {
		err = fmt.Errorf("Git 冲突索引重建结果不匹配，未覆盖暂存区")
	}
	return err
}

var syncGitOperationFiles = []string{
	"ORIG_HEAD", "MERGE_HEAD", "MERGE_MSG", "MERGE_MODE", "MERGE_RR", "MERGE_AUTOSTASH", "AUTO_MERGE",
	"CHERRY_PICK_HEAD", "REVERT_HEAD", "REBASE_HEAD", "SQUASH_MSG",
}
var syncGitOperationDirectories = []string{"rebase-merge", "rebase-apply", "sequencer", "refs/rewritten"}

type syncGitOperationEntry struct {
	directory bool
	content   string
}

func syncGitOperationName(name string) (string, bool) {
	if name == "" || strings.ContainsAny(name, "\\:\x00\r\n") || strings.HasPrefix(name, "/") {
		return "", false
	}
	for _, part := range strings.Split(name, "/") {
		if part == "" || part == "." || part == ".." {
			return "", false
		}
	}
	for _, top := range syncGitOperationFiles {
		if name == top {
			return top, true
		}
	}
	for _, top := range syncGitOperationDirectories {
		if name == top || strings.HasPrefix(name, top+"/") {
			return top, true
		}
	}
	return "", false
}

func encodeGitOperations(entries map[string]syncGitOperationEntry) string {
	if len(entries) == 0 {
		return ""
	}
	lines := make([]string, 0, len(entries))
	for name, entry := range entries {
		value := "d"
		if !entry.directory {
			value = "f" + base64.StdEncoding.EncodeToString([]byte(entry.content))
		}
		lines = append(lines, base64.StdEncoding.EncodeToString([]byte(name))+" "+value)
	}
	sort.Strings(lines)
	return syncGitOperationsPrefix + strings.Join(lines, "\n")
}

func decodeGitOperations(value string) (map[string]syncGitOperationEntry, error) {
	entries := map[string]syncGitOperationEntry{}
	if value == "" {
		return entries, nil
	}
	if !strings.HasPrefix(value, syncGitOperationsPrefix) {
		return nil, fmt.Errorf("无效的 Git 操作记录版本")
	}
	for _, line := range strings.Split(strings.TrimPrefix(value, syncGitOperationsPrefix), "\n") {
		encoded, content, ok := strings.Cut(line, " ")
		nameBytes, err := base64.StdEncoding.DecodeString(encoded)
		name := string(nameBytes)
		if !ok || err != nil {
			return nil, fmt.Errorf("无效的 Git 操作文件记录")
		}
		top, valid := syncGitOperationName(name)
		if !valid || len(content) == 0 {
			return nil, fmt.Errorf("无效的 Git 操作文件路径")
		}
		if _, duplicate := entries[name]; duplicate {
			return nil, fmt.Errorf("重复的 Git 操作文件记录")
		}
		entry := syncGitOperationEntry{directory: content == "d"}
		if entry.directory {
			if name == top {
				isDirectory := false
				for _, directory := range syncGitOperationDirectories {
					isDirectory = isDirectory || top == directory
				}
				if !isDirectory {
					return nil, fmt.Errorf("Git 操作文件类型不匹配")
				}
			}
		} else {
			for _, directory := range syncGitOperationDirectories {
				if name == directory {
					return nil, fmt.Errorf("Git 操作目录类型不匹配")
				}
			}
			if content[0] != 'f' {
				return nil, fmt.Errorf("无效的 Git 操作文件类型")
			}
			data, err := base64.StdEncoding.DecodeString(content[1:])
			if err != nil {
				return nil, err
			}
			entry.content = string(data)
		}
		entries[name] = entry
	}
	for name := range entries {
		top, _ := syncGitOperationName(name)
		for parent := filepath.ToSlash(filepath.Dir(name)); parent != "." && parent != filepath.ToSlash(filepath.Dir(top)); parent = filepath.ToSlash(filepath.Dir(parent)) {
			if entry, ok := entries[parent]; !ok || !entry.directory {
				return nil, fmt.Errorf("Git 操作目录记录不完整")
			}
		}
	}
	if encodeGitOperations(entries) != value {
		return nil, fmt.Errorf("Git 操作文件记录不是规范格式")
	}
	if entry, ok := entries["rebase-merge/update-refs"]; ok && (entry.directory || strings.TrimSpace(entry.content) != "") {
		return nil, fmt.Errorf("暂不支持同步带有 --update-refs 的进行中 rebase；请先在当前端完成或中止 rebase，已保留两端")
	}
	return entries, nil
}

// Old checkpoints did not observe ORIG_HEAD, which Git deliberately leaves
// behind after a completed operation. Only that inert file can be ignored when
// comparing against a legacy checkpoint; an active operation is always new.
func gitLegacyCheckpointEqual(actual, recorded syncGitState, version int) bool {
	if actual == recorded {
		return true
	}
	if version >= 2 || recorded.Operations != "" || actual.Head != recorded.Head || actual.Branch != recorded.Branch || actual.Index != recorded.Index {
		return false
	}
	return gitOnlyInertOperations(actual.Operations)
}

func gitOnlyInertOperations(value string) bool {
	entries, err := decodeGitOperations(value)
	if err != nil {
		return false
	}
	for name := range entries {
		if name != "ORIG_HEAD" {
			return false
		}
	}
	return true
}

func gitCheckpointTransitionMatches(actual, before, after syncGitState, version int) bool {
	if version < 2 && before.Operations == "" && after.Operations == "" && gitOnlyInertOperations(actual.Operations) {
		actual.Operations = ""
	}
	return gitTransitionMatches(actual, before, after)
}

// A detached rebase still owns its original branch. Git --continue updates
// that ref with orig-head as its compare-and-swap expectation.
func gitRebaseOriginal(state syncGitState) (branch, head string, err error) {
	if state.Branch != "" {
		return "", "", nil
	}
	entries, err := decodeGitOperations(state.Operations)
	if err != nil {
		return "", "", err
	}
	for _, directory := range []string{"rebase-merge", "rebase-apply"} {
		if !entries[directory].directory {
			continue
		}
		name := strings.TrimSpace(entries[directory+"/head-name"].content)
		original := strings.TrimSpace(entries[directory+"/orig-head"].content)
		if name == "" { // A journaled interruption may not have copied it yet.
			continue
		}
		if name == "detached HEAD" {
			return "", "", nil
		}
		if original == "" { // The original-tip file may be the next entry to copy.
			continue
		}
		if !strings.HasPrefix(name, "refs/heads/") || !syncGitOID.MatchString(original) {
			return "", "", fmt.Errorf("无效的 Git rebase 原始分支记录")
		}
		return name, original, nil
	}
	return "", "", nil
}

// A completed rebase legitimately rewrites its original branch. Permit only
// that operation's recorded original tip, never an independently moved branch.
func gitRebaseOwnsTarget(before syncGitState, branch, old string) bool {
	name, original, err := gitRebaseOriginal(before)
	return err == nil && name == branch && original == old && name != ""
}

func gitOperationsTransitionMatches(current, before, after string) bool {
	actual, err := decodeGitOperations(current)
	if err != nil {
		return false
	}
	old, err := decodeGitOperations(before)
	if err != nil {
		return false
	}
	next, err := decodeGitOperations(after)
	if err != nil {
		return false
	}
	names := map[string]bool{}
	for _, entries := range []map[string]syncGitOperationEntry{actual, old, next} {
		for name := range entries {
			names[name] = true
		}
	}
	for name := range names {
		value, present := actual[name]
		oldValue, wasPresent := old[name]
		nextValue, willBePresent := next[name]
		if (present != wasPresent || value != oldValue) && (present != willBePresent || value != nextValue) {
			return false
		}
	}
	return true
}

func localGitOperationPaths(ctx context.Context, m *Mapping) (map[string]string, error) {
	names := append(append([]string{}, syncGitOperationFiles...), syncGitOperationDirectories...)
	args := []string{"rev-parse", "--path-format=absolute"}
	for _, name := range names {
		args = append(args, "--git-path", name)
	}
	out, err := gitOutputContext(ctx, m.LocalPath, args...)
	if err != nil {
		return nil, err
	}
	values := strings.Split(out, "\n")
	if len(values) != len(names) {
		return nil, fmt.Errorf("无法解析 Git 操作元数据路径")
	}
	paths := map[string]string{}
	for i, name := range names {
		paths[name] = strings.TrimSuffix(values[i], "\r")
	}
	return paths, nil
}

func readGitOperations(paths map[string]string) (string, error) {
	entries := map[string]syncGitOperationEntry{}
	for name, path := range paths {
		err := filepath.WalkDir(path, func(path string, item fs.DirEntry, walkErr error) error {
			if os.IsNotExist(walkErr) && path == paths[name] {
				return nil
			}
			if walkErr != nil {
				return walkErr
			}
			relative, err := filepath.Rel(paths[name], path)
			if err != nil {
				return err
			}
			key := name
			if relative != "." {
				key += "/" + filepath.ToSlash(relative)
			}
			if _, valid := syncGitOperationName(key); !valid || item.Type()&os.ModeSymlink != 0 || (!item.IsDir() && !item.Type().IsRegular()) {
				return fmt.Errorf("Git 操作元数据包含不安全路径，已保留: %s", key)
			}
			entry := syncGitOperationEntry{directory: item.IsDir()}
			if !entry.directory {
				content, err := os.ReadFile(path)
				if err != nil {
					return err
				}
				entry.content = string(content)
			}
			entries[key] = entry
			return nil
		})
		if err != nil {
			return "", err
		}
	}
	value := encodeGitOperations(entries)
	_, err := decodeGitOperations(value)
	return value, err
}

func applyGitOperations(paths map[string]string, before, desired string) error {
	actual, err := readGitOperations(paths)
	if err != nil {
		return err
	}
	if actual != before {
		return fmt.Errorf("同步期间 Git 操作状态发生改变，未覆盖")
	}
	old, err := decodeGitOperations(before)
	if err != nil {
		return err
	}
	next, err := decodeGitOperations(desired)
	if err != nil {
		return err
	}
	pathOf := func(name string) string {
		top, _ := syncGitOperationName(name)
		return paths[top] + filepath.FromSlash(strings.TrimPrefix(name, top))
	}
	// Remove only recorded entries, children before parents. Never recursively
	// delete an operation directory that could contain independently added files.
	names := []string{}
	for name := range old {
		names = append(names, name)
	}
	sort.Sort(sort.Reverse(sort.StringSlice(names)))
	for _, name := range names {
		entry := old[name]
		if replacement, ok := next[name]; ok && replacement.directory == entry.directory {
			continue
		}
		if err := os.Remove(pathOf(name)); err != nil {
			return err
		}
	}
	names = names[:0]
	for name := range next {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		entry := next[name]
		if prior, ok := old[name]; ok && prior == entry {
			continue
		}
		path := pathOf(name)
		if entry.directory {
			if err := os.Mkdir(path, 0700); err != nil && !os.IsExist(err) {
				return err
			}
			continue
		}
		file, err := os.CreateTemp(filepath.Dir(paths["MERGE_HEAD"]), ".chisa-operation-*")
		if err != nil {
			return err
		}
		err = func() error {
			defer os.Remove(file.Name())
			defer file.Close()
			if _, err := file.WriteString(entry.content); err != nil {
				return err
			}
			if err := file.Sync(); err != nil {
				return err
			}
			if err := file.Close(); err != nil {
				return err
			}
			return os.Rename(file.Name(), path)
		}()
		if err != nil {
			return err
		}
	}
	return nil
}

// Every stage blob is reachable from an ordinary synthetic tree; operation
// commits become parents, and AUTO_MERGE/other referenced trees stay reachable.
// No commit is made from an unresolved index and no user branch is moved here.
func gitSnapshotTree(ctx context.Context, m *Mapping, s syncGitState) (string, []string, error) {
	if !strings.HasPrefix(s.Index, syncGitStagesPrefix) && s.Operations == "" {
		return s.Index, []string{s.Head}, nil
	}
	entries, _, err := syncGitIndexEntries(s.Index)
	if err != nil {
		return "", nil, err
	}
	operations, err := decodeGitOperations(s.Operations)
	if err != nil {
		return "", nil, err
	}
	manifest, err := json.Marshal(s)
	if err != nil {
		return "", nil, err
	}
	blob, err := gitOutputContextEnvInput(ctx, m.LocalPath, nil, manifest, "hash-object", "-w", "--stdin")
	if err != nil {
		return "", nil, err
	}
	listing := "100644 blob " + blob + "\tstate.json\x00"
	if entries == nil {
		listing += "040000 tree " + s.Index + "\tindex\x00"
	}
	for number, entry := range entries {
		if entry.mode != "160000" {
			listing += fmt.Sprintf("100644 blob %s\tstage-%08d\x00", entry.oid, number)
		}
	}
	parents := []string{s.Head}
	seen := map[string]bool{s.Head: true}
	var contents strings.Builder
	for _, entry := range operations {
		contents.WriteString(entry.content)
		contents.WriteByte('\n')
	}
	for _, oid := range syncGitMentionedOID.FindAllString(contents.String(), -1) {
		if seen[oid] {
			continue
		}
		seen[oid] = true
		kind, err := gitOutputContext(ctx, m.LocalPath, "cat-file", "-t", oid)
		if err != nil {
			continue // Commit messages/todo comments may mention unavailable objects.
		}
		switch kind {
		case "commit":
			parents = append(parents, oid)
		case "tree", "blob":
			mode := "100644"
			if kind == "tree" {
				mode = "040000"
			}
			listing += mode + " " + kind + " " + oid + "\toperation-" + oid + "\x00"
		}
	}
	tree, err := gitOutputContextEnvInput(ctx, m.LocalPath, nil, []byte(listing), "mktree", "-z")
	return tree, parents, err
}
