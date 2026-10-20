//go:build windows

package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func TestSyncIgnoreRuntimeKeepsTrackedSources(t *testing.T) {
	for _, scenario := range []struct {
		directory string
		tracked   bool
	}{{".dev", false}, {".dev", true}, {".nodetmp", false}, {".nodetmp", true}, {".local-node", false}, {".local-node", true}, {"arbitrary runtime [1]", false}, {"arbitrary runtime [1]", true}} {
		directory, tracked := scenario.directory, scenario.tracked
		name := directory + "/temporary runtime"
		if tracked {
			name = directory + "/tracked source exception"
		}
		t.Run(name, func(t *testing.T) {
			m := isolatePi(t)
			for name, content := range map[string]string{
				"README.md":                         "project source",
				".gitignore":                        strings.NewReplacer("[", "\\[", "]", "\\]").Replace(directory) + "/\n",
				directory + "/assets/source.txt":    "tracked asset",
				directory + "/assets/generated.bin": "temporary output",
				directory + "/pw/browser.exe":       "temporary browser",
			} {
				target := filepath.Join(m.LocalPath, filepath.FromSlash(name))
				if err := os.MkdirAll(filepath.Dir(target), 0700); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(target, []byte(content), 0600); err != nil {
					t.Fatal(err)
				}
			}
			commands := [][]string{{"init", "-b", "main"}}
			if tracked {
				commands = append(commands, []string{"add", "-f", directory + "/assets/source.txt"})
			}
			for _, args := range commands {
				if _, err := gitOutputContext(context.Background(), m.LocalPath, args...); err != nil {
					t.Fatal(err)
				}
			}
			configuration, err := syncIgnoreConfigurationContext(context.Background(), m)
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
				{Path: directory, Directory: true, Mode: 0040755},
				{Path: directory + "/assets", Directory: true, Mode: 0040755},
				{Path: directory + "/assets/source.txt", Mode: 0100644},
				{Path: directory + "/assets/generated.bin", Mode: 0100644},
				{Path: directory + "/pw", Directory: true, Mode: 0040755},
				{Path: directory + "/pw/browser.exe", Mode: 0100755},
				{Path: directory + "/sysroot", Directory: true, Mode: 0040755},
				{Path: directory + "/sysroot/fontconfig-link", Mode: 0120777},
				{Path: directory + "/node-v22.20.0-linux-x64", Directory: true, Mode: 0040755},
				{Path: directory + "/node-v22.20.0-linux-x64/bin", Directory: true, Mode: 0040755},
				{Path: directory + "/node-v22.20.0-linux-x64/bin/node", Mode: 0100755},
				{Path: directory + "/node-v22.20.0-linux-x64/bin/npm", Mode: 0120777},
			}
			selected, err := syncEmptyPlan(entries, session)
			if err != nil {
				t.Fatal(err)
			}
			names := []string{}
			for _, entry := range selected {
				names = append(names, entry.Path)
			}
			want := []string{"README.md"}
			if tracked {
				want = append(want, directory, directory+"/assets", directory+"/assets/source.txt")
			}
			if !reflect.DeepEqual(names, want) {
				t.Fatalf("synchronized entries = %v, want %v", names, want)
			}
		})
	}
}

// A vendored repository can report thousands of ignored directories and tens of
// thousands of tracked files. Enumerating a re-include exception per tracked
// descendant is what made a cold scan take minutes, so the generated rule set has
// to stay bounded no matter how large the repository is.
func TestSyncIgnoreRuleCountStaysBounded(t *testing.T) {
	m := isolatePi(t)
	var ignored []string
	for i := 0; i < 400; i++ {
		ignored = append(ignored, fmt.Sprintf("pkg%d/dist/", i))
	}
	var tracked []string
	for i := 0; i < 4000; i++ {
		tracked = append(tracked, fmt.Sprintf("pkg%d/src/file%d.ts", i%400, i))
	}
	// A handful of tracked files that really do live inside an ignored directory.
	for i := 0; i < 200; i++ {
		tracked = append(tracked, fmt.Sprintf("pkg%d/dist/keep%d.ts", i%400, i))
	}
	configuration, err := writeSyncIgnoreConfiguration(m, syncGitInventory{Tracked: tracked, Ignored: ignored})
	if err != nil {
		t.Fatal(err)
	}
	contents, err := os.ReadFile(configuration)
	if err != nil {
		t.Fatal(err)
	}
	patterns, exceptions := 0, 0
	for _, line := range strings.Split(string(contents), "\n") {
		item, found := strings.CutPrefix(strings.TrimSpace(line), "- ")
		if !found {
			continue
		}
		patterns++
		if strings.Contains(item, `"!`) {
			exceptions++
		}
	}
	if patterns > 2000 {
		t.Fatalf("rule set grew with the repository: %d patterns (%d exceptions)", patterns, exceptions)
	}
	// Exceptions may grow linearly with the tracked files that genuinely live
	// inside an ignored directory (a few rules per path level), but they must not
	// grow with the repository's overall size.
	if exceptions > 4*200 {
		t.Fatalf("re-include exceptions are unbounded: %d for 200 tracked inputs", exceptions)
	}
}
