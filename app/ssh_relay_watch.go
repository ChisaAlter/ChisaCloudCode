package main

import (
	"context"
	"encoding/json"
	"io/fs"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// The workspace watcher reports advisory filesystem observations for roots the
// server actually dispatches work into. It uses bounded snapshot diffs rather
// than OS notifications so the semantics stay identical everywhere the Agent
// runs, and it never observes a root the transport has not used recently.
const (
	watchSweepInterval  = 3 * time.Second
	watchRootIdleLimit  = 10 * time.Minute
	watchMaxRoots       = 4
	watchMaxEntries     = 200_000
	watchEventBatch     = 128
	watchEventQueueMax  = 4_096
	watchFlushInterval  = time.Second
	watchManifestPath   = ".chisa/workspace.json"
	watchMaxManifest    = 64 * 1024
	watchMaxIgnoreRules = 64
)

// Mirror of the server file-tree's ignored directory names: generated trees
// are noise for both humans and cache invalidation.
var watchIgnoredDirNames = map[string]bool{
	"node_modules": true, ".git": true, ".svn": true, ".hg": true,
	"dist": true, "build": true, ".next": true, ".nuxt": true, ".cache": true, ".parcel-cache": true,
	"__pycache__": true, ".pytest_cache": true, ".mypy_cache": true, ".tox": true, "venv": true, ".venv": true,
	"target": true, "vendor": true, ".gradle": true, ".idea": true, "coverage": true, ".nyc_output": true,
	".chisa-ssh-projects": true,
}

type watchEntry struct {
	size  int64
	mtime int64
	dir   bool
}

type watchedRoot struct {
	root         string
	identity     string
	lastJob      time.Time
	snapshot     map[string]watchEntry
	ignore       []string
	include      []string
	manifestTime time.Time
	overflowed   bool
}

type relayEvent struct {
	Root         string `json:"root"`
	RootIdentity string `json:"rootIdentity,omitempty"`
	Path         string `json:"path"`
	Kind         string `json:"kind"`
}

func (w *sshRelayWatcher) profileID() string {
	if w.runtime == nil || w.runtime.entry == nil {
		return ""
	}
	return w.runtime.entry.profile.ID
}

// sshRelayWatcher owns diff snapshots and the single flush lane for one relay
// session. Events are deduplicated by path with last-wins ordering; a buffer
// overflow collapses to a root-level reset hint because consumers invalidate
// whole buckets anyway.
type sshRelayWatcher struct {
	runtime *sshRelayRuntime
	mu      sync.Mutex
	roots   map[string]*watchedRoot
	pending map[string]relayEvent // dedupe key: root + "\x00" + path
	order   []string
	wake    chan struct{}
	done    chan struct{}
	cancel  context.CancelFunc
}

func newSshRelayWatcher(runtime *sshRelayRuntime, ctx context.Context) *sshRelayWatcher {
	watchCtx, cancel := context.WithCancel(ctx)
	watcher := &sshRelayWatcher{runtime: runtime, roots: map[string]*watchedRoot{}, pending: map[string]relayEvent{}, wake: make(chan struct{}, 1), done: make(chan struct{})}
	watcher.cancel = cancel
	go watcher.loop(watchCtx)
	return watcher
}

func (w *sshRelayWatcher) close() {
	w.cancel()
	<-w.done
}

// observe records transport interest in a root. Watching starts lazily: a root
// with no recent jobs is dropped rather than watched forever.
func (w *sshRelayWatcher) observe(root, identity string) {
	if root == "" {
		return
	}
	root = filepath.Clean(root)
	w.mu.Lock()
	defer w.mu.Unlock()
	entry := w.roots[root]
	if entry == nil {
		if len(w.roots) >= watchMaxRoots {
			return
		}
		exclude, include := loadWatchIgnores(root)
		entry = &watchedRoot{root: root, ignore: exclude, include: include}
		w.roots[root] = entry
		log.Printf("[agent-relay] event=watch-start profile=%s root=%s", w.profileID(), root)
	}
	entry.lastJob = time.Now()
	if identity != "" {
		entry.identity = identity
	}
}

func (w *sshRelayWatcher) loop(ctx context.Context) {
	defer close(w.done)
	sweep := time.NewTicker(watchSweepInterval)
	defer sweep.Stop()
	flush := time.NewTicker(watchFlushInterval)
	defer flush.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-sweep.C:
			w.sweep()
		case <-flush.C:
			w.flush(ctx)
		case <-w.wake:
			w.flush(ctx)
		}
	}
}

// sweep diffs every active root and drops roots the transport left idle.
func (w *sshRelayWatcher) sweep() {
	w.mu.Lock()
	roots := make([]*watchedRoot, 0, len(w.roots))
	for _, entry := range w.roots {
		roots = append(roots, entry)
	}
	w.mu.Unlock()
	now := time.Now()
	for _, entry := range roots {
		if now.Sub(entry.lastJob) > watchRootIdleLimit {
			w.mu.Lock()
			delete(w.roots, entry.root)
			w.mu.Unlock()
			log.Printf("[agent-relay] event=watch-stop profile=%s root=%s", w.profileID(), entry.root)
			continue
		}
		w.scan(entry)
	}
}

// ignored applies the default names plus the project-declared excludePaths
// from .chisa/workspace.json. When the project declares includePaths, only
// those subtrees produce events at all.
func (w *watchedRoot) ignored(rel string, dir bool) bool {
	rel = strings.ReplaceAll(rel, string(filepath.Separator), "/")
	if len(w.include) > 0 {
		included := false
		for _, rule := range w.include {
			if rel == rule || strings.HasPrefix(rel, rule+"/") || strings.HasPrefix(rule, rel+"/") {
				included = true
				break
			}
		}
		if !included {
			return true
		}
	}
	if dir && watchIgnoredDirNames[filepath.Base(rel)] {
		return true
	}
	for _, rule := range w.ignore {
		if rel == rule || strings.HasPrefix(rel, rule+"/") {
			return true
		}
		if strings.Contains(rule, "*") {
			if matched, _ := filepath.Match(rule, filepath.Base(rel)); matched {
				return true
			}
		}
	}
	return false
}

func watchRulePath(rule string) string {
	rule = strings.Trim(strings.ReplaceAll(strings.TrimSpace(rule), "\\", "/"), "/")
	if rule == "" || strings.HasPrefix(rule, "/") || strings.HasPrefix(rule, "..") || len(rule) > 256 || strings.ContainsAny(rule, "\x00:") {
		return ""
	}
	return rule
}

// loadWatchIgnores reads the optional project manifest. A malformed or absent
// manifest simply means the defaults apply.
func loadWatchIgnores(root string) (exclude, include []string) {
	raw, err := os.ReadFile(filepath.Join(root, watchManifestPath))
	if err != nil || len(raw) > watchMaxManifest {
		return nil, nil
	}
	var manifest struct {
		ExcludePaths []string `json:"excludePaths"`
		IncludePaths []string `json:"includePaths"`
	}
	if json.Unmarshal(raw, &manifest) != nil {
		return nil, nil
	}
	for _, rule := range manifest.ExcludePaths {
		if rule = watchRulePath(rule); rule != "" {
			exclude = append(exclude, rule)
		}
		if len(exclude) >= watchMaxIgnoreRules {
			break
		}
	}
	for _, rule := range manifest.IncludePaths {
		if rule = watchRulePath(rule); rule != "" && !strings.Contains(rule, "*") {
			include = append(include, rule)
		}
		if len(include) >= watchMaxIgnoreRules {
			break
		}
	}
	return exclude, include
}

func (w *sshRelayWatcher) scan(entry *watchedRoot) {
	// The manifest is reloaded whenever its own mtime moves so project edits to
	// exclude rules take effect without a restart.
	if info, err := os.Stat(filepath.Join(entry.root, watchManifestPath)); err == nil {
		if !info.ModTime().Equal(entry.manifestTime) {
			entry.manifestTime = info.ModTime()
			entry.ignore, entry.include = loadWatchIgnores(entry.root)
		}
	}
	current := make(map[string]watchEntry, 4096)
	overflow := false
	err := filepath.WalkDir(entry.root, func(path string, d fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			if path == entry.root {
				return walkErr
			}
			return nil // Skip unreadable entries; the root identity check belongs to the transport.
		}
		rel, relErr := filepath.Rel(entry.root, path)
		if relErr != nil || rel == "." {
			return nil
		}
		if d.IsDir() && entry.ignored(rel, true) {
			return filepath.SkipDir
		}
		if !d.IsDir() && entry.ignored(rel, false) {
			return nil
		}
		if len(current) >= watchMaxEntries {
			overflow = true
			return filepath.SkipAll
		}
		info, infoErr := d.Info()
		if infoErr != nil {
			return nil
		}
		current[rel] = watchEntry{size: info.Size(), mtime: info.ModTime().UnixNano(), dir: d.IsDir()}
		return nil
	})
	if err != nil {
		return // Keep the previous snapshot; the next sweep retries.
	}
	previous := entry.snapshot
	entry.snapshot = current
	if previous == nil {
		return // First sweep establishes the baseline without emitting noise.
	}
	if overflow && !entry.overflowed {
		w.enqueue(relayEvent{Root: entry.root, RootIdentity: entry.identity, Path: "/", Kind: "reset"})
	}
	entry.overflowed = overflow
	for rel, now := range current {
		before, existed := previous[rel]
		switch {
		case !existed:
			w.enqueue(relayEvent{Root: entry.root, RootIdentity: entry.identity, Path: filepath.ToSlash(rel), Kind: "create"})
		case before.mtime != now.mtime || before.size != now.size || before.dir != now.dir:
			w.enqueue(relayEvent{Root: entry.root, RootIdentity: entry.identity, Path: filepath.ToSlash(rel), Kind: "write"})
		}
	}
	for rel := range previous {
		if _, exists := current[rel]; !exists {
			w.enqueue(relayEvent{Root: entry.root, RootIdentity: entry.identity, Path: filepath.ToSlash(rel), Kind: "remove"})
		}
	}
}

func (w *sshRelayWatcher) enqueue(event relayEvent) {
	w.mu.Lock()
	defer w.mu.Unlock()
	key := event.Root + "\x00" + event.Path
	if _, exists := w.pending[key]; !exists {
		w.order = append(w.order, key)
	}
	w.pending[key] = event
	if len(w.order) >= watchEventQueueMax {
		// Collapse to one reset per overflowing root rather than dropping the
		// signal entirely; consumers invalidate whole buckets anyway.
		seen := map[string]bool{}
		kept := w.order[:0]
		for _, queued := range w.order {
			event := w.pending[queued]
			if !seen[event.Root] {
				seen[event.Root] = true
				kept = append(kept, event.Root+"\x00/")
				w.pending[event.Root+"\x00/"] = relayEvent{Root: event.Root, RootIdentity: event.RootIdentity, Path: "/", Kind: "reset"}
			}
			delete(w.pending, queued)
		}
		w.order = kept
	}
	select {
	case w.wake <- struct{}{}:
	default:
	}
}

// flush posts deduplicated batches on the agent token. Failures keep the
// pending set: events are advisory, so a lost batch only delays invalidation.
func (w *sshRelayWatcher) flush(ctx context.Context) {
	epoch := w.runtime.currentEpoch()
	if epoch == "" {
		return
	}
	w.mu.Lock()
	if len(w.order) == 0 {
		w.mu.Unlock()
		return
	}
	batch := w.order
	if len(batch) > watchEventBatch {
		batch = batch[:watchEventBatch]
	}
	events := make([]relayEvent, 0, len(batch))
	for _, key := range batch {
		events = append(events, w.pending[key])
	}
	w.mu.Unlock()
	payload, _ := json.Marshal(map[string]any{"connectionId": w.runtime.entry.profile.ID, "epoch": epoch, "events": events})
	requestCtx, cancel := context.WithTimeout(ctx, 8*time.Second)
	raw, err := sshAgentServiceRequest(requestCtx, w.runtime.entry.scope, w.runtime.agent.token, http.MethodPost, "/api/ssh-workspaces/agent/relay/events", payload, 64*1024)
	cancel()
	if err != nil {
		code, _ := sshErrorFields(err)
		if code == "SSH_ACCOUNT_CHANGED" || code == "SSH_AGENT_RELAY_AUTH_FAILED" {
			return // The session lifetime owns teardown; buffered events die with it.
		}
		return // Transient failures retry on the next tick with the same pending set.
	}
	var reply struct {
		OK       bool   `json:"ok"`
		Accepted bool   `json:"accepted"`
		Epoch    string `json:"epoch"`
	}
	if json.Unmarshal(raw, &reply) != nil || !reply.OK {
		return
	}
	w.mu.Lock()
	// A path may have produced a newer event while the batch was in flight;
	// keep deduped entries that no longer match what was acknowledged.
	for i, key := range batch {
		if current, ok := w.pending[key]; ok && current == events[i] {
			delete(w.pending, key)
		}
	}
	kept := w.order[:0]
	for _, key := range w.order {
		if _, ok := w.pending[key]; ok {
			kept = append(kept, key)
		}
	}
	w.order = kept
	w.mu.Unlock()
	if reply.Epoch != "" && reply.Epoch != epoch {
		w.runtime.fail(sshFailure("SSH_AGENT_REGISTRATION_REQUIRED", "服务端 Agent 会话已更新，正在恢复连接和任务状态。"))
	}
}
