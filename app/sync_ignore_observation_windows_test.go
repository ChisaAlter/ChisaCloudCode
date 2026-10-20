//go:build windows

package main

import (
	"context"
	"crypto/sha256"
	"encoding/binary"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
	"unicode/utf16"

	"golang.org/x/sys/windows"
)

type fakeSyncIgnoreWatch struct {
	changes []syncIgnoreChange
	failure error
	closed  bool
}

func (w *fakeSyncIgnoreWatch) poll() ([]syncIgnoreChange, error) {
	changes, failure := w.changes, w.failure
	w.changes, w.failure = nil, nil
	return changes, failure
}

func (w *fakeSyncIgnoreWatch) close() { w.closed = true }

func testSyncIgnoreObservation(t *testing.T) (*syncIgnoreObservation, *fakeSyncIgnoreWatch, *int) {
	t.Helper()
	root := t.TempDir()
	watch := &fakeSyncIgnoreWatch{}
	discoveries := 0
	observation := newSyncIgnoreObservation(root, 1, func(string, bool) (syncIgnoreWatch, error) {
		return watch, nil
	}, func(root string) (map[string][sha256.Size]byte, error) {
		discoveries++
		return discoverSyncIgnoreRules(root)
	})
	t.Cleanup(observation.close)
	return observation, watch, &discoveries
}

func testWriteIgnoreInput(t *testing.T, root, relative, content string) string {
	t.Helper()
	name := filepath.Join(root, filepath.FromSlash(relative))
	if err := os.MkdirAll(filepath.Dir(name), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(name, []byte(content), 0600); err != nil {
		t.Fatal(err)
	}
	return name
}

func testIgnoreSignature(t *testing.T, observation *syncIgnoreObservation) string {
	t.Helper()
	signature, err := observation.current()
	if err != nil {
		t.Fatal(err)
	}
	return signature
}

func TestSyncIgnoreObservationSteadyMessagesNeverRediscover(t *testing.T) {
	observation, watch, discoveries := testSyncIgnoreObservation(t)
	testWriteIgnoreInput(t, observation.root, "src/.gitignore", "*.log\n")
	initial := testIgnoreSignature(t, observation)
	for message := 0; message < 100; message++ {
		watch.changes = []syncIgnoreChange{{path: "src/source.go"}, {path: "README.md"}, {path: "node_modules/package/index.js", name: true}}
		if got := testIgnoreSignature(t, observation); got != initial {
			t.Fatal("ordinary content writes invalidated the cached ignore policy")
		}
	}
	if *discoveries != 1 {
		t.Fatalf("steady messages performed %d discovery scans, want one initial scan", *discoveries)
	}
}

func TestSyncIgnoreObservationIgnoreEditsAndTrackedExceptions(t *testing.T) {
	observation, watch, discoveries := testSyncIgnoreObservation(t)
	name := testWriteIgnoreInput(t, observation.root, ".gitignore", "*.log\n")
	testWriteIgnoreInput(t, observation.root, ".git/info/exclude", "scratch\n")
	testWriteIgnoreInput(t, observation.root, ".git/index", "first index")
	previous := testIgnoreSignature(t, observation)
	info, err := os.Stat(name)
	if err != nil {
		t.Fatal(err)
	}
	// Same-size content with restored timestamps defeats the old metadata-only
	// fingerprint but must not defeat notification evidence.
	if err := os.WriteFile(name, []byte("*.tmp\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Chtimes(name, info.ModTime(), info.ModTime()); err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{".gitignore", ".git/info/exclude", ".git/index", ".git/sharedindex.0123", "fresh.log", "removed.log", "renamed.log"} {
		watch.changes = []syncIgnoreChange{{path: path, name: strings.HasSuffix(path, ".log")}}
		current := testIgnoreSignature(t, observation)
		if current == previous {
			t.Fatalf("ignore inventory input %q did not invalidate policy", path)
		}
		previous = current
	}
	if got := observation.rules[name]; got != sha256.Sum256([]byte("*.tmp\n")) {
		t.Fatalf("ignore content hash did not refresh: %x", got)
	}
	if *discoveries != 1 {
		t.Fatalf("file/index changes performed %d discoveries, want initial only", *discoveries)
	}
}

func TestSyncIgnoreObservationDirectoryTopologyDiscoversNestedRules(t *testing.T) {
	observation, watch, discoveries := testSyncIgnoreObservation(t)
	previous := testIgnoreSignature(t, observation)
	for _, scenario := range []struct {
		name string
		act  func() string
	}{
		{"create", func() string {
			testWriteIgnoreInput(t, observation.root, "build/deep/.gitignore", "generated\n")
			return "build"
		}},
		{"rename", func() string {
			if err := os.Rename(filepath.Join(observation.root, "build"), filepath.Join(observation.root, "out")); err != nil {
				t.Fatal(err)
			}
			return "out"
		}},
		{"delete", func() string {
			if err := os.RemoveAll(filepath.Join(observation.root, "out")); err != nil {
				t.Fatal(err)
			}
			return "out"
		}},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			watch.changes = []syncIgnoreChange{{path: scenario.act(), directory: true, name: true}}
			current := testIgnoreSignature(t, observation)
			if current == previous {
				t.Fatal("directory topology did not invalidate policy")
			}
			previous = current
			if scenario.name != "delete" && len(observation.rules) != 1 {
				t.Fatalf("nested rule not discovered after %s: %v", scenario.name, observation.rules)
			}
		})
	}
	if len(observation.rules) != 0 || *discoveries != 4 {
		t.Fatalf("topology discovery count/rules = %d/%v, want 4/empty", *discoveries, observation.rules)
	}
}

func TestSyncIgnoreObservationLostProofCannotReuseAndRecoveryIsBounded(t *testing.T) {
	observation, watch, discoveries := testSyncIgnoreObservation(t)
	initial := testIgnoreSignature(t, observation)
	watch.failure = errors.New("notification overflow")
	if signature, err := observation.current(); err == nil || signature != "" || !watch.closed {
		t.Fatalf("overflow retained cached proof: signature=%q error=%v closed=%t", signature, err, watch.closed)
	}
	for message := 0; message < 100; message++ {
		if signature, err := observation.current(); err == nil || signature != "" {
			t.Fatalf("lost watcher proof became reusable: %q, %v", signature, err)
		}
	}
	if *discoveries != 1 {
		t.Fatalf("watch failure caused unbounded rescanning: %d", *discoveries)
	}
	observation.retryAt = time.Time{}
	replacement := &fakeSyncIgnoreWatch{}
	observation.newWatch = func(string, bool) (syncIgnoreWatch, error) { return replacement, nil }
	if current := testIgnoreSignature(t, observation); current == initial || *discoveries != 2 {
		t.Fatalf("recovery did not replace evidence and rediscover once: signature=%q, scans=%d", current, *discoveries)
	}
}

func TestSyncIgnoreObservationBusyDiscoveryRecoveryIsBounded(t *testing.T) {
	observation, watch, discoveries := testSyncIgnoreObservation(t)
	originalDiscovery := observation.discoverRules
	observation.discoverRules = func(root string) (map[string][sha256.Size]byte, error) {
		rules, err := originalDiscovery(root)
		watch.changes = []syncIgnoreChange{{path: "busy", directory: true, name: true}}
		return rules, err
	}
	if signature, err := observation.current(); signature != "" || err == nil {
		t.Fatalf("busy discovery retained proof: signature=%q error=%v", signature, err)
	}
	for message := 0; message < 20; message++ {
		if signature, err := observation.current(); signature != "" || err == nil {
			t.Fatalf("busy recovery reused proof: signature=%q error=%v", signature, err)
		}
	}
	if *discoveries != 3 {
		t.Fatalf("busy notifications triggered %d discovery passes, want bounded three", *discoveries)
	}
}

func TestSyncIgnoreObservationRootReplacementInvalidates(t *testing.T) {
	observation, _, discoveries := testSyncIgnoreObservation(t)
	initial := testIgnoreSignature(t, observation)
	original := observation.root + "-old"
	if err := os.Rename(observation.root, original); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(original) })
	if err := os.Mkdir(observation.root, 0700); err != nil {
		t.Fatal(err)
	}
	for message := 0; message < 20; message++ {
		if current, err := observation.current(); current != "" || err == nil || *discoveries != 1 {
			t.Fatalf("replacement directory inherited proof or forced repeated discovery: signature=%q scans=%d error=%v", current, *discoveries, err)
		}
	}
	observation.retryAt = time.Time{}
	if current := testIgnoreSignature(t, observation); current == initial || *discoveries != 2 {
		t.Fatalf("replacement directory did not recover with new proof: signature=%q scans=%d", current, *discoveries)
	}
}

func TestSyncIgnoreObservationLinkedWorktreeExternalMetadata(t *testing.T) {
	root, external := t.TempDir(), t.TempDir()
	gitDirectory := filepath.Join(external, "common", "worktrees", "selected")
	testWriteIgnoreInput(t, root, ".git", "gitdir: "+gitDirectory+"\n")
	testWriteIgnoreInput(t, gitDirectory, "commondir", "../..\n")
	testWriteIgnoreInput(t, gitDirectory, "index", "tracked exception")
	exclude := testWriteIgnoreInput(t, external, "common/info/exclude", "scratch\n")
	watches := map[string]*fakeSyncIgnoreWatch{}
	observation := newSyncIgnoreObservation(root, 1, func(path string, recursive bool) (syncIgnoreWatch, error) {
		watch := &fakeSyncIgnoreWatch{}
		watches[norm(path)] = watch
		return watch, nil
	}, discoverSyncIgnoreRules)
	t.Cleanup(observation.close)
	previous := testIgnoreSignature(t, observation)
	if _, exists := observation.inputs[exclude]; !exists {
		t.Fatalf("common info/exclude was not observed: %v", observation.inputs)
	}
	for _, input := range []string{filepath.Join(gitDirectory, "index"), exclude} {
		delivered := false
		for parent, watch := range watches {
			if norm(filepath.Dir(input)) == parent {
				relative, err := filepath.Rel(parent, input)
				if err != nil {
					t.Fatal(err)
				}
				watch.changes = append(watch.changes, syncIgnoreChange{path: relative})
				delivered = true
			}
		}
		if !delivered {
			t.Fatalf("no watch covers linked-worktree metadata %q", input)
		}
		current := testIgnoreSignature(t, observation)
		if previous == current {
			t.Fatalf("external Git input %q failed to invalidate", input)
		}
		previous = current
	}
}

func TestSyncIgnoreObservationExternalInputsMissingParentAndConfiguration(t *testing.T) {
	root, external := t.TempDir(), t.TempDir()
	input := filepath.Join(external, "not-created", "deep", "excludes")
	watches := make(map[string]*fakeSyncIgnoreWatch)
	observation := newSyncIgnoreObservation(root, 1, func(path string, recursive bool) (syncIgnoreWatch, error) {
		if norm(path) != norm(root) && recursive {
			t.Fatal("external configuration parent must not watch entire profile recursively")
		}
		watch := &fakeSyncIgnoreWatch{}
		watches[norm(path)] = watch
		return watch, nil
	}, discoverSyncIgnoreRules)
	t.Cleanup(observation.close)
	resolutions := 0
	observation.resolveConfiguration = func() (map[string]bool, error) {
		resolutions++
		return map[string]bool{input: false, filepath.Join(external, "global.config"): true}, nil
	}
	previous := testIgnoreSignature(t, observation)
	testWriteIgnoreInput(t, external, "not-created/deep/excludes", "*.scratch\n")
	watches[norm(external)].changes = []syncIgnoreChange{{path: "not-created", directory: true, name: true}}
	current := testIgnoreSignature(t, observation)
	if current == previous || watches[norm(filepath.Dir(input))] == nil {
		t.Fatal("missing external excludes parent creation was not rediscovered")
	}
	previous = current
	for message := 0; message < 20; message++ {
		if testIgnoreSignature(t, observation) != previous {
			t.Fatal("steady external input evidence changed")
		}
	}
	if resolutions != 4 {
		t.Fatalf("configuration resolved %d times, want two bracketing reads per initial/ancestor discovery", resolutions)
	}
	watches[norm(external)].changes = []syncIgnoreChange{{path: "global.config"}}
	if testIgnoreSignature(t, observation) == previous || resolutions != 6 {
		t.Fatal("effective configuration edit was not resolved again")
	}
}

func TestSyncIgnoreObservationConfigurationArmingRaceCannotReuseOldInputSet(t *testing.T) {
	root, external := t.TempDir(), t.TempDir()
	first, second := filepath.Join(external, "first", "ignore"), filepath.Join(external, "second", "ignore")
	observation := newSyncIgnoreObservation(root, 1, func(string, bool) (syncIgnoreWatch, error) {
		return &fakeSyncIgnoreWatch{}, nil
	}, discoverSyncIgnoreRules)
	t.Cleanup(observation.close)
	resolutions := 0
	observation.resolveConfiguration = func() (map[string]bool, error) {
		resolutions++
		if resolutions == 1 {
			return map[string]bool{first: false}, nil
		}
		return map[string]bool{second: false}, nil
	}
	_ = testIgnoreSignature(t, observation)
	if _, present := observation.inputs[second]; !present {
		t.Fatalf("configuration changed during watch arming retained old excludes set: %v", observation.inputs)
	}
	if _, present := observation.inputs[first]; present || resolutions != 4 {
		t.Fatalf("configuration arming race was not retried once: inputs=%v resolutions=%d", observation.inputs, resolutions)
	}
}

func TestSyncIgnoreObservationGitConfigurationOriginsAndExcludes(t *testing.T) {
	root, home := t.TempDir(), t.TempDir()
	included := testWriteIgnoreInput(t, home, "included.config", "[core]\n\texcludesFile = "+filepath.ToSlash(filepath.Join(home, "ignore"))+"\n")
	global := testWriteIgnoreInput(t, home, "global.config", "[include]\n\tpath = "+filepath.ToSlash(included)+"\n")
	t.Setenv("GIT_CONFIG_GLOBAL", global)
	t.Setenv("GIT_CONFIG_NOSYSTEM", "1")
	t.Setenv("GIT_CONFIG_COUNT", "0")
	if output, err := exec.Command("git", "-C", root, "init", "--quiet").CombinedOutput(); err != nil {
		t.Fatalf("initialize private repository: %v: %s", err, output)
	}
	inputs, err := syncIgnoreGitConfigurationInputs(context.Background(), &Mapping{LocalPath: root})
	if err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{included, global, filepath.Join(root, ".git", "config")} {
		if configuration, present := inputs[name]; !present || !configuration {
			t.Fatalf("Git configuration origin %q missing from inputs: %v", name, inputs)
		}
	}
	if configuration, present := inputs[filepath.Join(home, "ignore")]; !present || configuration {
		t.Fatalf("effective core.excludesFile missing or misclassified: %v", inputs)
	}
}

func TestSyncIgnoreObservationExternalSymlinkTargetIsObserved(t *testing.T) {
	root, external, target := t.TempDir(), t.TempDir(), t.TempDir()
	destination := testWriteIgnoreInput(t, target, "ignore", "*.scratch\n")
	link := filepath.Join(external, "excludes")
	if err := os.Symlink(destination, link); err != nil {
		t.Skipf("file symlinks unavailable: %v", err)
	}
	watches := make(map[string]*fakeSyncIgnoreWatch)
	observation := newSyncIgnoreObservation(root, 1, func(path string, recursive bool) (syncIgnoreWatch, error) {
		watch := &fakeSyncIgnoreWatch{}
		watches[norm(path)] = watch
		return watch, nil
	}, discoverSyncIgnoreRules)
	t.Cleanup(observation.close)
	observation.external = map[string]bool{link: false}
	previous := testIgnoreSignature(t, observation)
	if _, exists := observation.inputs[destination]; !exists || watches[norm(target)] == nil {
		t.Fatalf("symlink target is not observed: inputs=%v watches=%v", observation.inputs, watches)
	}
	watches[norm(target)].changes = []syncIgnoreChange{{path: "ignore"}}
	if current := testIgnoreSignature(t, observation); current == previous {
		t.Fatal("external ignore symlink target edit reused old policy proof")
	}
}

func testWindowsNotification(action uint32, name string) []byte {
	wide := utf16.Encode([]rune(name))
	buffer := make([]byte, 12+2*len(wide))
	binary.LittleEndian.PutUint32(buffer[4:], action)
	binary.LittleEndian.PutUint32(buffer[8:], uint32(2*len(wide)))
	for index, value := range wide {
		binary.LittleEndian.PutUint16(buffer[12+2*index:], value)
	}
	return buffer
}

func TestSyncIgnoreWindowsNotificationParsing(t *testing.T) {
	for _, action := range []uint32{windows.FILE_ACTION_ADDED, windows.FILE_ACTION_REMOVED, windows.FILE_ACTION_MODIFIED, windows.FILE_ACTION_RENAMED_OLD_NAME, windows.FILE_ACTION_RENAMED_NEW_NAME} {
		buffer := testWindowsNotification(action, `nested\资料\.gitignore`)
		changes, err := parseSyncIgnoreWindowsChanges(buffer, false)
		want := []syncIgnoreChange{{path: `nested\资料\.gitignore`, name: action != windows.FILE_ACTION_MODIFIED}}
		if err != nil || !reflect.DeepEqual(changes, want) {
			t.Fatalf("notification action %d parsed as %+v, %v", action, changes, err)
		}
	}
	for _, buffer := range [][]byte{nil, make([]byte, 12), testWindowsNotification(99, "input"), testWindowsNotification(windows.FILE_ACTION_ADDED, `..\outside`)} {
		if _, err := parseSyncIgnoreWindowsChanges(buffer, false); err == nil {
			t.Fatalf("malformed notification retained trusted evidence: %v", buffer)
		}
	}
}

func waitSyncIgnoreOSChange(t *testing.T, observation *syncIgnoreObservation, previous string) string {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		current := testIgnoreSignature(t, observation)
		if current != previous {
			return current
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("native recursive watcher did not invalidate ignore evidence")
	return ""
}

func TestSyncIgnoreWindowsNativeRecursiveNotifications(t *testing.T) {
	root := t.TempDir()
	testWriteIgnoreInput(t, root, ".gitignore", "*.log\n")
	testWriteIgnoreInput(t, root, ".git/index", "first index")
	testWriteIgnoreInput(t, root, "src/source.go", "first content")
	discoveries := 0
	observation := newSyncIgnoreObservation(root, 1, newSyncIgnoreWindowsWatch, func(root string) (map[string][sha256.Size]byte, error) {
		discoveries++
		return discoverSyncIgnoreRules(root)
	})
	t.Cleanup(observation.close)
	previous := testIgnoreSignature(t, observation)
	testWriteIgnoreInput(t, root, ".gitignore", "*.tmp\n")
	previous = waitSyncIgnoreOSChange(t, observation, previous)
	if discoveries != 1 {
		t.Fatal("ignore edit rediscovered the worktree")
	}
	testWriteIgnoreInput(t, root, ".git/index", "second index")
	previous = waitSyncIgnoreOSChange(t, observation, previous)
	if discoveries != 1 {
		t.Fatal("tracked exception update rediscovered the worktree")
	}
	testWriteIgnoreInput(t, root, "new/deep/.gitignore", "new-output\n")
	previous = waitSyncIgnoreOSChange(t, observation, previous)
	if _, exists := observation.rules[filepath.Join(root, "new", "deep", ".gitignore")]; !exists {
		t.Fatal("new nested directory's ignore rules were not discovered")
	}
	// Drain any coalesced create events before checking an ordinary content edit.
	for settle := 0; settle < 5; settle++ {
		time.Sleep(10 * time.Millisecond)
		previous = testIgnoreSignature(t, observation)
	}
	before := discoveries
	testWriteIgnoreInput(t, root, "src/source.go", "updated content")
	for message := 0; message < 5; message++ {
		time.Sleep(10 * time.Millisecond)
		if current := testIgnoreSignature(t, observation); current != previous || discoveries != before {
			t.Fatal("ordinary content editing changed the ignore signature or caused discovery")
		}
	}
}
