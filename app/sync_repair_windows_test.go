//go:build windows

package main

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

func TestStorePhysicalDirectoryAliasCannotCreateAnotherBinding(t *testing.T) {
	local := t.TempDir()
	alias := `\\?\` + local
	if norm(alias) == norm(local) {
		t.Fatal("fixture must exercise physical, not lexical identity")
	}
	s := &Store{path: filepath.Join(t.TempDir(), "state.json")}
	m := &Mapping{LocalPath: local, ServerPath: "/account-a/project", BindingEpoch: "one", ServerID: "account-a"}
	if err := s.addMapping(m); err != nil {
		t.Fatal(err)
	}
	if found := s.findMappingByLocal(alias); found == nil || *found != *m {
		t.Fatalf("physical alias did not find original binding: %v", found)
	}
	if err := s.addMapping(&Mapping{LocalPath: alias, ServerPath: "/account-b/project", BindingEpoch: "two", ServerID: "account-b"}); err == nil {
		t.Fatal("same physical directory accepted a second account binding")
	}
	if mappings := s.mappings(); len(mappings) != 1 || *mappings[0] != *m {
		t.Fatalf("failed alias binding changed original: %v", mappings)
	}
}

func TestLocalGitReadRepositoryLiteralModifierUsesActualFile(t *testing.T) {
	m, git := localGitReadFixture(t)
	piWorkspaceWrite(t, m.LocalPath, "[ab].txt", "literal baseline\n")
	piWorkspaceWrite(t, m.LocalPath, "a.txt", "other baseline\n")
	git("add", ".")
	git("commit", "-m", "literal filenames")
	piWorkspaceWrite(t, m.LocalPath, "[ab].txt", "literal modified\n")
	piWorkspaceWrite(t, m.LocalPath, "a.txt", "other modified\n")
	if err := os.Mkdir(filepath.Join(m.LocalPath, "nested"), 0700); err != nil {
		t.Fatal(err)
	}
	for _, cwd := range []string{"/workspace", "/workspace/nested"} {
		result := workspaceRPCContext(context.Background(), m, map[string]any{
			"op": "git_read", "action": "command", "path": cwd,
			"argv": []string{"git", "diff", "--", ":(top,literal)[ab].txt"},
		})
		out, _ := result["stdout"].(string)
		if result["ok"] != true || result["exitCode"] != 0 || !strings.Contains(out, "literal modified") || strings.Contains(out, "other modified") {
			t.Fatalf("literal read at %s did not select exact file: %v", cwd, result)
		}
	}
}

func TestSyncIgnoreEffectiveExcludeAndBothTrackedIndexes(t *testing.T) {
	m := isolatePi(t)
	for name, content := range map[string]string{
		"README.md": "source", ".gitignore": "nested/cache-*/\n",
		"nested/cache-new/source.txt": "tracked on the other endpoint", "nested/cache-new/runtime.txt": "output",
		"custom-toolchain/bin/npm": "platform launcher", "custom-toolchain/readme.txt": "tracked locally",
	} {
		piWorkspaceWrite(t, m.LocalPath, name, content)
	}
	for _, args := range [][]string{{"init", "-b", "main"}, {"add", "-f", "custom-toolchain/readme.txt"}} {
		if _, err := gitOutputContext(context.Background(), m.LocalPath, args...); err != nil {
			t.Fatal(err)
		}
	}
	piWorkspaceWrite(t, m.LocalPath, ".git/info/exclude", "custom-toolchain/\n")
	local, err := localSyncGitInventory(context.Background(), m)
	if err != nil {
		t.Fatal(err)
	}
	configuration, err := writeSyncIgnoreConfiguration(m, local, syncGitInventory{Tracked: []string{"nested/cache-new/source.txt"}})
	if err != nil {
		t.Fatal(err)
	}
	contents, err := os.ReadFile(configuration)
	if err != nil {
		t.Fatal(err)
	}
	session := syncSession{}
	for _, line := range strings.Split(string(contents), "\n") {
		if item, found := strings.CutPrefix(strings.TrimSpace(line), "- "); found {
			var pattern string
			if err := json.Unmarshal([]byte(item), &pattern); err != nil {
				t.Fatal(err)
			}
			session.Ignore.Paths = append(session.Ignore.Paths, pattern)
		}
	}
	entries := []syncEmptyEntry{
		{Path: "README.md", Mode: 0100644},
		{Path: "nested", Directory: true, Mode: 0040755},
		{Path: "nested/cache-new", Directory: true, Mode: 0040755},
		{Path: "nested/cache-new/source.txt", Mode: 0100644},
		{Path: "nested/cache-new/runtime.txt", Mode: 0100644},
		{Path: "custom-toolchain", Directory: true, Mode: 0040755},
		{Path: "custom-toolchain/readme.txt", Mode: 0100644},
		{Path: "custom-toolchain/bin", Directory: true, Mode: 0040755},
		{Path: "custom-toolchain/bin/npm", Mode: 0120777},
	}
	selected, err := syncEmptyPlan(entries, session)
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, item := range selected {
		names = append(names, item.Path)
	}
	want := []string{"README.md", "nested", "nested/cache-new", "nested/cache-new/source.txt", "custom-toolchain", "custom-toolchain/readme.txt"}
	if !slices.Equal(names, want) {
		t.Fatalf("effective excludes or remote tracked exception lost: got %v, want %v", names, want)
	}
}
