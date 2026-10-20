//go:build windows

package main

import (
	"context"
	"encoding/json"
	"os"
	"sort"
	"strings"
	"testing"
)

// Opt-in diagnostic: reports the ignore rule set the shipping code generates for a
// real repository, without touching any synchronization session.
//
//	CHISA_IGNORE_REPORT=C:\path\to\project go test . -run TestReportIgnorePolicy -v
func TestReportIgnorePolicy(t *testing.T) {
	root := os.Getenv("CHISA_IGNORE_REPORT")
	if root == "" {
		t.Skip("set CHISA_IGNORE_REPORT to a repository path")
	}
	m := isolatePi(t)
	m.LocalPath = root
	repository, err := localGitRepository(context.Background(), root)
	if err != nil {
		t.Fatal(err)
	}
	if !repository {
		t.Fatalf("%s is not a Git work tree root", root)
	}
	inventory, err := localSyncGitInventory(context.Background(), m)
	if err != nil {
		t.Fatal(err)
	}
	configuration, err := writeSyncIgnoreConfiguration(m, inventory)
	if err != nil {
		t.Fatal(err)
	}
	contents, err := os.ReadFile(configuration)
	if err != nil {
		t.Fatal(err)
	}
	patterns, exceptions := 0, 0
	var ignored []string
	for _, line := range strings.Split(string(contents), "\n") {
		item, found := strings.CutPrefix(strings.TrimSpace(line), "- ")
		if !found {
			continue
		}
		patterns++
		var value string
		if err := json.Unmarshal([]byte(item), &value); err != nil {
			t.Fatal(err)
		}
		if strings.HasPrefix(value, "!") {
			exceptions++
			continue
		}
		if strings.HasPrefix(value, "/") {
			ignored = append(ignored, value)
		}
	}
	sort.Strings(ignored)
	tracked := 0
	for _, item := range inventory.Tracked {
		if item != "" {
			tracked++
		}
	}
	t.Logf("tracked=%d ignored-entries=%d patterns=%d exceptions=%d", tracked, len(inventory.Ignored), patterns, exceptions)
	if len(ignored) > 0 {
		t.Logf("first ignored patterns: %v", ignored[:min(len(ignored), 12)])
	}
}
