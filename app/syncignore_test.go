//go:build windows

package main

import (
	"context"
	"encoding/json"
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
	}{{".dev", false}, {".dev", true}, {".nodetmp", false}, {".nodetmp", true}} {
		directory, tracked := scenario.directory, scenario.tracked
		name := directory + "/temporary runtime"
		if tracked {
			name = directory + "/tracked source exception"
		}
		t.Run(name, func(t *testing.T) {
			m := isolatePi(t)
			for name, content := range map[string]string{
				"README.md":                         "project source",
				".gitignore":                        directory + "/\n",
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
			if tracked {
				for _, args := range [][]string{{"init", "-b", "main"}, {"add", "-f", directory + "/assets/source.txt"}} {
					if _, err := gitOutputContext(context.Background(), m.LocalPath, args...); err != nil {
						t.Fatal(err)
					}
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
