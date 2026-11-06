package main

import (
	"os"
	"path/filepath"
	"testing"
)

func testWatcher() *sshRelayWatcher {
	return &sshRelayWatcher{roots: map[string]*watchedRoot{}, pending: map[string]relayEvent{}, wake: make(chan struct{}, 1), done: make(chan struct{})}
}

func pendingKinds(w *sshRelayWatcher) map[string]string {
	w.mu.Lock()
	defer w.mu.Unlock()
	kinds := map[string]string{}
	for _, event := range w.pending {
		kinds[event.Path] = event.Kind
	}
	return kinds
}

func TestWatchScanDiffsChanges(t *testing.T) {
	root := t.TempDir()
	w := testWatcher()
	w.observe(root, "vol:idx")
	entry := w.roots[filepath.Clean(root)]
	if entry == nil {
		t.Fatal("observed root was not registered")
	}
	w.scan(entry) // Baseline never emits.
	if len(w.pending) != 0 {
		t.Fatalf("baseline produced %d events", len(w.pending))
	}
	if err := os.WriteFile(filepath.Join(root, "added.txt"), []byte("a"), 0o600); err != nil {
		t.Fatal(err)
	}
	w.scan(entry)
	kinds := pendingKinds(w)
	if kinds["added.txt"] != "create" {
		t.Fatalf("expected create event for added.txt, got %v", kinds)
	}
	w.pending = map[string]relayEvent{}
	w.order = nil
	if err := os.WriteFile(filepath.Join(root, "added.txt"), []byte("longer"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(filepath.Join(root, "added.txt.tmp")); err != nil && !os.IsNotExist(err) {
		t.Fatal(err)
	}
	w.scan(entry)
	kinds = pendingKinds(w)
	if kinds["added.txt"] != "write" {
		t.Fatalf("expected write event, got %v", kinds)
	}
	w.pending = map[string]relayEvent{}
	w.order = nil
	if err := os.Remove(filepath.Join(root, "added.txt")); err != nil {
		t.Fatal(err)
	}
	w.scan(entry)
	if pendingKinds(w)["added.txt"] != "remove" {
		t.Fatalf("expected remove event, got %v", pendingKinds(w))
	}
}

func TestWatchIgnoresDefaultNoiseAndManifest(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, ".chisa"), 0o700); err != nil {
		t.Fatal(err)
	}
	manifest := `{"excludePaths":["vendor-src","*.log"],"includePaths":[]}`
	if err := os.WriteFile(filepath.Join(root, ".chisa", "workspace.json"), []byte(manifest), 0o600); err != nil {
		t.Fatal(err)
	}
	w := testWatcher()
	w.observe(root, "")
	entry := w.roots[filepath.Clean(root)]
	w.scan(entry)
	for _, dir := range []string{"node_modules", "vendor-src", "src"} {
		if err := os.MkdirAll(filepath.Join(root, dir), 0o700); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(root, "node_modules", "x.js"), []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "vendor-src", "v.go"), []byte("v"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "debug.log"), []byte("l"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "src", "app.ts"), []byte("s"), 0o600); err != nil {
		t.Fatal(err)
	}
	w.scan(entry)
	kinds := pendingKinds(w)
	if _, ok := kinds["node_modules"]; ok {
		t.Fatal("node_modules emitted an event")
	}
	if _, ok := kinds["vendor-src"]; ok {
		t.Fatal("manifest-excluded directory emitted an event")
	}
	if _, ok := kinds["debug.log"]; ok {
		t.Fatal("manifest glob-excluded file emitted an event")
	}
	if kinds["src"] != "create" || kinds["src/app.ts"] != "create" {
		t.Fatalf("expected create events for src tree, got %v", kinds)
	}
}

func TestWatchManifestIncludePathsScopeEvents(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, ".chisa"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, ".chisa", "workspace.json"), []byte(`{"includePaths":["packages/app"]}`), 0o600); err != nil {
		t.Fatal(err)
	}
	exclude, include := loadWatchIgnores(root)
	if len(include) != 1 || include[0] != "packages/app" || len(exclude) != 0 {
		t.Fatalf("manifest parse mismatch: exclude=%v include=%v", exclude, include)
	}
	entry := &watchedRoot{root: root, include: include}
	if entry.ignored("packages", true) {
		t.Fatal("ancestor of an included subtree must not be ignored")
	}
	if entry.ignored("packages/app/main.ts", false) {
		t.Fatal("included file reported as ignored")
	}
	if !entry.ignored("other/file.ts", false) {
		t.Fatal("file outside includePaths must be ignored")
	}
}

func TestWatchIgnoresMalformedManifest(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, ".chisa"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, ".chisa", "workspace.json"), []byte(`{"excludePaths":"not-an-array"`), 0o600); err != nil {
		t.Fatal(err)
	}
	exclude, include := loadWatchIgnores(root)
	if exclude != nil || include != nil {
		t.Fatalf("malformed manifest must yield defaults, got exclude=%v include=%v", exclude, include)
	}
}
