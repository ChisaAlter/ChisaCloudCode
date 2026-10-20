package main

import (
	"bytes"
	"context"
	_ "embed"
	"encoding/json"
	"fmt"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"
)

// syncIgnorePolicyVersion invalidates every cached policy when the rule
// generation changes.
const syncIgnorePolicyVersion = "2"

// syncIgnoreForceKey marks a synchronization that must recompute the policy even
// when nothing that feeds it changed (the manual "Sync now" action).
type syncIgnoreForceKey struct{}

// syncIgnoreSignature certifies only the local half of the policy. A native
// recursive watcher preserves same-process evidence between messages; remote
// ignore/index evidence must also be checked before using the saved stamp.
func syncIgnoreSignature(m *Mapping) (string, error) {
	return syncIgnoreLocalSignature(m)
}

func syncIgnoreStampPath(m *Mapping) string {
	return filepath.Join(dataDir(), "sync-config", m.BindingEpoch+".sig")
}

type syncGitInventory struct {
	Tracked []string `json:"tracked"`
	Ignored []string `json:"ignored"`
}

//go:embed resources/sync_ignore.py
var syncIgnoreWorker string

func localSyncGitInventory(ctx context.Context, m *Mapping) (syncGitInventory, error) {
	var inventory syncGitInventory
	repository, err := localGitRepository(ctx, m.LocalPath)
	if err != nil || !repository {
		return inventory, err
	}
	for _, item := range []struct {
		args []string
		out  *[]string
	}{
		{[]string{"ls-files", "-z"}, &inventory.Tracked},
		{[]string{"ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"}, &inventory.Ignored},
	} {
		out, err := gitOutputContext(ctx, m.LocalPath, append([]string{"-c", "core.fsmonitor=false"}, item.args...)...)
		if err != nil {
			return inventory, err
		}
		*item.out = strings.Split(strings.TrimSuffix(out, "\x00"), "\x00")
	}
	// ls-files does not emit fully ignored ancestors, but a directory that holds
	// a force-tracked child still needs its ignored ancestors honoured. Ask Git
	// about ancestors without consulting the index; writeSyncIgnoreConfiguration
	// then drops any prefix that would cover too many tracked files.
	var candidates []string
	seen := map[string]bool{}
	for _, item := range inventory.Ignored {
		if item == "" {
			continue
		}
		parts := strings.Split(strings.TrimSuffix(item, "/"), "/")
		for i := range parts {
			candidate := strings.Join(parts[:i+1], "/")
			if i < len(parts)-1 || strings.HasSuffix(item, "/") {
				candidate += "/"
			}
			if !seen[candidate] {
				seen[candidate] = true
				candidates = append(candidates, candidate)
			}
		}
	}
	if len(candidates) > 0 {
		out, err := gitOutputContextEnvInput(ctx, m.LocalPath, nil, []byte(strings.Join(candidates, "\x00")+"\x00"), "-c", "core.fsmonitor=false", "check-ignore", "--no-index", "-z", "--stdin")
		if err != nil && gitExitCode(err) != 1 {
			return inventory, err
		}
		inventory.Ignored = strings.Split(strings.TrimSuffix(out, "\x00"), "\x00")
	}
	return inventory, nil
}

// Local-only entry point is also used by offline project policy inspection.
func syncIgnoreConfiguration(m *Mapping) (string, error) {
	return syncIgnoreConfigurationContext(context.Background(), m)
}

func syncIgnoreConfigurationContext(ctx context.Context, m *Mapping) (string, error) {
	local, err := localSyncGitInventory(ctx, m)
	if err != nil {
		return "", err
	}
	return writeSyncIgnoreConfiguration(m, local)
}

// Both endpoints contribute effective Git ignores (including info/exclude and
// nested ignore files). Exact tracked exceptions from either index win. Query
// through the existing lease-bound sync worker, never an unowned SSH command.
var projectSyncIgnoreConfigurationContext = projectSyncIgnoreConfiguration

func projectSyncIgnoreConfiguration(ctx context.Context, m *Mapping) (string, error) {
	local, err := localSyncGitInventory(ctx, m)
	if err != nil {
		return "", err
	}
	request, _ := json.Marshal(map[string]string{"root": m.ServerPath})
	out, err := syncRemoteScript(ctx, m, "setpriv --reuid=1000 --regid=1000 --clear-groups env HOME=/nonexistent python3 -c "+shellQuote(syncIgnoreWorker), bytes.NewReader(request))
	if err != nil {
		return "", fmt.Errorf("无法读取 VPS 项目忽略规则: %w", err)
	}
	var remote syncGitInventory
	if err := json.Unmarshal([]byte(out), &remote); err != nil {
		return "", fmt.Errorf("VPS 项目忽略规则响应无效: %w", err)
	}
	return writeSyncIgnoreConfiguration(m, local, remote)
}

func literalSyncIgnorePath(value string) (string, error) {
	value = strings.TrimSuffix(value, "/")
	if value == "" || value == "." || strings.ContainsAny(value, "\x00\\") || strings.HasPrefix(value, "/") || path.Clean(value) != value || value == ".." || strings.HasPrefix(value, "../") {
		return "", fmt.Errorf("Git 返回了无效的项目路径")
	}
	return "/" + strings.NewReplacer("*", "\\*", "?", "\\?", "[", "\\[", "]", "\\]").Replace(value), nil
}

// syncIgnoreTrackedChildLimit drops an ignore prefix once it covers more than
// this many tracked files. Such a prefix is an ancestor of a tracked tree (or a
// build directory holding tracked sources), not a leaf artifact; keeping it would
// require one re-include exception per tracked descendant, and those exceptions
// dominate the synchronization engine's matcher cost on every cold scan.
// Dropping the prefix only means that directory is synchronized as well.
//
// Measured on a 37k-file vendored repository: unlimited expansion produced
// 45,861 rules (39,721 of them exceptions); this limit produces 986.
const syncIgnoreTrackedChildLimit = 4

func writeSyncIgnoreConfiguration(m *Mapping, inventories ...syncGitInventory) (string, error) {
	// Root-anchored: an unanchored name matches at every depth, which drags whole
	// tracked trees into the exception list.
	patterns := []string{"/dist", "/build", "/out", "/.next", "/coverage", "/.cache", "/cache", "/.tmp", "/.dev", "/.nodetmp"}
	rootGenerated := map[string]bool{"dist": true, "build": true, "out": true, ".next": true, "coverage": true, ".cache": true, "cache": true, ".tmp": true, ".dev": true, ".nodetmp": true}
	ignored, tracked := map[string]bool{}, map[string]bool{}
	for _, inventory := range inventories {
		for _, item := range inventory.Ignored {
			if item == "" {
				continue
			}
			ignored[strings.TrimSuffix(item, "/")] = true
		}
		for _, item := range inventory.Tracked {
			if item != "" {
				tracked[item] = true
			}
		}
	}
	trackedPrefixes := map[string]int{}
	for file := range tracked {
		if _, err := literalSyncIgnorePath(file); err != nil {
			return "", err
		}
		parts := strings.Split(file, "/")
		for i := range parts {
			trackedPrefixes[strings.Join(parts[:i+1], "/")]++
		}
	}
	for prefix := range ignored {
		if trackedPrefixes[prefix] > syncIgnoreTrackedChildLimit {
			delete(ignored, prefix)
		}
	}
	exceptions := map[string]bool{}
	for file := range tracked {
		parts, excluded := strings.Split(file, "/"), false
		for i, part := range parts {
			prefix := strings.Join(parts[:i+1], "/")
			excluded = excluded || ignored[prefix] || (i == 0 && rootGenerated[part])
			if !excluded {
				continue
			}
			literal, _ := literalSyncIgnorePath(prefix)
			exceptions["!"+literal] = true
			if i < len(parts)-1 {
				exceptions[literal+"/*"] = true
			}
		}
	}
	var ignoredPatterns []string
	for item := range ignored {
		literal, err := literalSyncIgnorePath(item)
		if err != nil {
			return "", err
		}
		ignoredPatterns = append(ignoredPatterns, literal)
	}
	sort.Strings(ignoredPatterns)
	patterns = append(patterns, ignoredPatterns...)
	keys := make([]string, 0, len(exceptions))
	for key := range exceptions {
		keys = append(keys, key)
	}
	sort.Slice(keys, func(i, j int) bool {
		a, b := strings.TrimPrefix(keys[i], "!"), strings.TrimPrefix(keys[j], "!")
		da, db := strings.Count(strings.TrimSuffix(a, "/*"), "/"), strings.Count(strings.TrimSuffix(b, "/*"), "/")
		if da != db {
			return da < db
		}
		return a < b
	})
	patterns = append(patterns, keys...)
	// These existing security/runtime exclusions remain unconditional. This
	// policy must not make tracked credentials or node_modules newly public.
	patterns = append(patterns, "node_modules", ".git", ".venv", "venv", "__pycache__", ".env", ".env.*", "!.env.example", "!.env.sample", ".chisa-bridge.json")
	var config strings.Builder
	config.WriteString("sync:\n  defaults:\n    ignore:\n      paths:\n")
	for _, pattern := range patterns {
		encoded, _ := json.Marshal(pattern)
		config.WriteString("        - " + string(encoded) + "\n")
	}
	directory := filepath.Join(dataDir(), "sync-config")
	if err := os.MkdirAll(directory, 0700); err != nil {
		return "", err
	}
	target := filepath.Join(directory, m.BindingEpoch+".yml")
	return target, os.WriteFile(target, []byte(config.String()), 0600)
}
