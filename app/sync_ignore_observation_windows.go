//go:build windows

package main

import (
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
	"unicode/utf16"

	"golang.org/x/sys/windows"
)

// Notifications are drained under the observer mutex in the background and
// synchronously before cache hits, so no queued forwarding stage can hide them.
// The directory stream is separate so normal file edits never require a stat or
// another directory discovery. Windows watches new subdirectories recursively.
type syncIgnoreChange struct {
	path      string
	directory bool
	name      bool
}

type syncIgnoreWatch interface {
	poll() ([]syncIgnoreChange, error)
	close()
}

type syncIgnoreWatchFactory func(string, bool) (syncIgnoreWatch, error)

type syncIgnoreDiscovery func(string) (map[string][sha256.Size]byte, error)

const (
	syncIgnoreObservationLimit = 32
	syncIgnoreRetryInterval    = time.Minute
)

var syncIgnoreObservations = struct {
	sync.Mutex
	entries map[string]*syncIgnoreObservation
	serial  uint64
}{entries: make(map[string]*syncIgnoreObservation)}

// A signature from another process cannot certify this process's new watch.
var syncIgnoreProcessNonce = fmt.Sprintf("%d:%d", os.Getpid(), time.Now().UnixNano())

// Capture identity eagerly. os.Stat's Windows FileInfo loads file IDs lazily,
// which would let a replaced path be resolved again when os.SameFile runs.
type syncIgnoreDirectoryIdentity struct {
	volume, high, low uint32
	created           uint64
}

func syncIgnoreWindowsPath(name string) (*uint16, error) {
	absolute, err := filepath.Abs(name)
	if err != nil {
		return nil, err
	}
	if !strings.HasPrefix(absolute, `\\?\`) {
		if strings.HasPrefix(absolute, `\\`) {
			absolute = `\\?\UNC\` + strings.TrimPrefix(absolute, `\\`)
		} else {
			absolute = `\\?\` + absolute
		}
	}
	return windows.UTF16PtrFromString(absolute)
}

func syncIgnoreReadDirectoryIdentity(name string) (syncIgnoreDirectoryIdentity, error) {
	var identity syncIgnoreDirectoryIdentity
	path, err := syncIgnoreWindowsPath(name)
	if err != nil {
		return identity, err
	}
	handle, err := windows.CreateFile(path, 0, windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE,
		nil, windows.OPEN_EXISTING, windows.FILE_FLAG_BACKUP_SEMANTICS, 0)
	if err != nil {
		return identity, err
	}
	defer windows.CloseHandle(handle)
	var information windows.ByHandleFileInformation
	if err := windows.GetFileInformationByHandle(handle, &information); err != nil {
		return identity, err
	}
	if information.FileAttributes&windows.FILE_ATTRIBUTE_DIRECTORY == 0 {
		return identity, fmt.Errorf("ignore observation input parent is no longer a directory")
	}
	return syncIgnoreDirectoryIdentity{information.VolumeSerialNumber, information.FileIndexHigh, information.FileIndexLow,
		uint64(information.CreationTime.HighDateTime)<<32 | uint64(information.CreationTime.LowDateTime)}, nil
}

type syncIgnoreObservation struct {
	mu                   sync.Mutex
	root                 string
	identity             *syncIgnoreDirectoryIdentity
	serial               uint64
	used                 uint64
	revision             uint64
	rules                map[string][sha256.Size]byte
	signature            string
	discover             bool
	metadata             bool
	configuration        bool
	dirtyRules           map[string]bool
	watchers             map[string]syncIgnoreWatch
	watchPaths           map[string]string
	watchIdentity        map[string]syncIgnoreDirectoryIdentity
	inputs               map[string]bool
	external             map[string]bool
	environment          string
	retryAt              time.Time
	watchFailure         error
	closed               bool
	newWatch             syncIgnoreWatchFactory
	discoverRules        syncIgnoreDiscovery
	drainStarted         bool
	drainStop            chan struct{}
	resolveConfiguration func() (map[string]bool, error)
}

func syncIgnoreObservationKey(m *Mapping) string {
	return strings.Join([]string{norm(m.LocalPath), m.ServerID, m.ServerPath, m.BindingEpoch}, "\x00")
}

func syncIgnoreLocalSignature(m *Mapping) (string, error) {
	key := syncIgnoreObservationKey(m)
	syncIgnoreObservations.Lock()
	syncIgnoreObservations.serial++
	serial := syncIgnoreObservations.serial
	observation := syncIgnoreObservations.entries[key]
	if observation == nil {
		observation = newSyncIgnoreObservation(m.LocalPath, serial, newSyncIgnoreWindowsWatch, discoverSyncIgnoreRules)
		mapping := *m
		observation.resolveConfiguration = func() (map[string]bool, error) {
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			return syncIgnoreGitConfigurationInputs(ctx, &mapping)
		}
		observation.startDrain()
		syncIgnoreObservations.entries[key] = observation
	}
	observation.used = serial
	if len(syncIgnoreObservations.entries) > syncIgnoreObservationLimit {
		var oldestKey string
		var oldest *syncIgnoreObservation
		for candidateKey, candidate := range syncIgnoreObservations.entries {
			if candidate != observation && (oldest == nil || candidate.used < oldest.used) {
				oldestKey, oldest = candidateKey, candidate
			}
		}
		if oldest != nil {
			delete(syncIgnoreObservations.entries, oldestKey)
			oldest.close()
		}
	}
	syncIgnoreObservations.Unlock()
	return observation.current()
}

func newSyncIgnoreObservation(root string, serial uint64, factory syncIgnoreWatchFactory, discovery syncIgnoreDiscovery) *syncIgnoreObservation {
	return &syncIgnoreObservation{root: filepath.Clean(root), serial: serial, revision: 1, discover: true, metadata: true, configuration: true,
		dirtyRules: make(map[string]bool), watchers: make(map[string]syncIgnoreWatch), watchPaths: make(map[string]string),
		watchIdentity: make(map[string]syncIgnoreDirectoryIdentity), inputs: make(map[string]bool),
		newWatch: factory, discoverRules: discovery}
}

// Explicit reconciliation invalidation is useful after Git changes its index,
// even on filesystems whose notification support has failed. Directory discovery
// stays cached: an index update changes exact tracked exceptions, not locations
// where .gitignore files can exist.
func invalidateSyncIgnoreObservation(m *Mapping) {
	syncIgnoreObservations.Lock()
	observation := syncIgnoreObservations.entries[syncIgnoreObservationKey(m)]
	if observation != nil {
		observation.mu.Lock()
		observation.revision++
		observation.signature = ""
		observation.mu.Unlock()
	}
	syncIgnoreObservations.Unlock()
}

func forgetSyncIgnoreObservation(m *Mapping) {
	syncIgnoreObservations.Lock()
	key := syncIgnoreObservationKey(m)
	observation := syncIgnoreObservations.entries[key]
	delete(syncIgnoreObservations.entries, key)
	if observation != nil {
		observation.close()
	}
	syncIgnoreObservations.Unlock()
}

func (o *syncIgnoreObservation) startDrain() {
	o.drainStarted = true
	o.drainStop = make(chan struct{})
	go func() {
		ticker := time.NewTicker(100 * time.Millisecond)
		defer ticker.Stop()
		for {
			select {
			case <-o.drainStop:
				return
			case <-ticker.C:
				o.mu.Lock()
				if !o.closed && o.watchFailure == nil {
					if err := o.poll(); err != nil {
						o.loseProof(err)
					}
				}
				o.mu.Unlock()
			}
		}
	}()
}

func (o *syncIgnoreObservation) close() {
	o.mu.Lock()
	defer o.mu.Unlock()
	if o.closed {
		return
	}
	o.closeWatches()
	o.closed = true
	if o.drainStarted {
		close(o.drainStop)
	}
}

func (o *syncIgnoreObservation) closeWatches() {
	for key, watch := range o.watchers {
		watch.close()
		delete(o.watchers, key)
		delete(o.watchPaths, key)
		delete(o.watchIdentity, key)
	}
}

func (o *syncIgnoreObservation) loseProof(err error) {
	o.closeWatches()
	o.watchFailure = err
	o.retryAt = time.Now().Add(syncIgnoreRetryInterval)
	o.revision++
	o.signature = ""
	o.discover, o.metadata, o.configuration = true, true, true
}

func syncIgnoreEnvironment() string {
	var values []string
	for _, value := range os.Environ() {
		key, _, _ := strings.Cut(value, "=")
		key = strings.ToUpper(key)
		if strings.HasPrefix(key, "GIT_") || key == "HOME" || key == "USERPROFILE" || key == "XDG_CONFIG_HOME" {
			values = append(values, value)
		}
	}
	sort.Strings(values)
	return strings.Join(values, "\x00")
}

func (o *syncIgnoreObservation) current() (string, error) {
	o.mu.Lock()
	defer o.mu.Unlock()
	if o.closed {
		return "", fmt.Errorf("ignore observation was retired")
	}
	identity, err := syncIgnoreReadDirectoryIdentity(o.root)
	if err != nil {
		o.loseProof(err)
		return "", err
	}
	if o.identity != nil && *o.identity != identity {
		o.loseProof(fmt.Errorf("ignore observation root was replaced"))
	}
	o.identity = &identity
	for key, previous := range o.watchIdentity {
		current, err := syncIgnoreReadDirectoryIdentity(o.watchPaths[key])
		if err != nil || previous != current {
			if err == nil {
				err = fmt.Errorf("Git ignore input watch directory was replaced")
			}
			o.loseProof(err)
			return "", err
		}
	}
	if environment := syncIgnoreEnvironment(); environment != o.environment {
		o.environment, o.metadata, o.configuration = environment, true, true
		o.revision++
		o.signature = ""
	}
	if o.watchFailure != nil && time.Now().Before(o.retryAt) {
		return "", o.watchFailure
	}
	if len(o.watchers) == 0 {
		watch, err := o.newWatch(o.root, true)
		if err != nil {
			o.loseProof(err)
			return "", err
		}
		o.watchers[norm(o.root)] = watch
		o.watchPaths[norm(o.root)] = o.root
		o.watchFailure = nil
	}
	// A change during discovery must not be certified as already observed. A
	// busy tree is conservatively uncached after a bounded number of attempts.
	for attempt := 0; attempt < 3; attempt++ {
		if err := o.poll(); err != nil {
			o.loseProof(err)
			return "", err
		}
		configurationChanged := o.configuration && o.resolveConfiguration != nil
		if o.configuration {
			if o.resolveConfiguration != nil {
				inputs, err := o.resolveConfiguration()
				if err != nil {
					o.loseProof(err)
					return "", err
				}
				o.external = inputs
			}
			o.configuration, o.metadata = false, true
		}
		if o.metadata {
			if err := o.refreshInputs(); err != nil {
				o.loseProof(err)
				return "", err
			}
			o.metadata = false
		}
		if configurationChanged {
			// A config file may select a different external excludes/include
			// while its watch is being installed. Resolve again with all newly
			// discovered watches active before certifying that input set.
			inputs, err := o.resolveConfiguration()
			if err != nil {
				o.loseProof(err)
				return "", err
			}
			if !sameSyncIgnoreInputs(o.external, inputs) {
				o.external = inputs
				o.configuration, o.metadata = true, true
				o.revision++
				o.signature = ""
				continue
			}
		}
		if o.discover {
			rules, err := o.discoverRules(o.root)
			if err != nil {
				o.loseProof(err)
				return "", err
			}
			o.rules, o.discover = rules, false
			o.dirtyRules = make(map[string]bool)
			o.signature = ""
		}
		for name := range o.dirtyRules {
			data, err := os.ReadFile(name)
			if os.IsNotExist(err) {
				delete(o.rules, name)
			} else if err != nil {
				o.loseProof(err)
				return "", err
			} else {
				o.rules[name] = sha256.Sum256(data)
			}
			delete(o.dirtyRules, name)
		}
		if err := o.poll(); err != nil {
			o.loseProof(err)
			return "", err
		}
		if o.discover || o.metadata || o.configuration || len(o.dirtyRules) != 0 {
			continue
		}
		if o.signature == "" {
			digest := sha256.New()
			fmt.Fprintf(digest, "%s\x00%s\x00%s\x00%d\x00%d", syncIgnorePolicyVersion, workspaceSyncEngineVersion, syncIgnoreProcessNonce, o.serial, o.revision)
			var names []string
			for name := range o.rules {
				names = append(names, name)
			}
			sort.Strings(names)
			for _, name := range names {
				fmt.Fprintf(digest, "\x00%s:%x", name, o.rules[name])
			}
			o.signature = hex.EncodeToString(digest.Sum(nil))
		}
		return o.signature, nil
	}
	err = fmt.Errorf("ignore inputs changed during discovery")
	o.loseProof(err)
	return "", err
}

func (o *syncIgnoreObservation) poll() error {
	for key, watch := range o.watchers {
		root := o.watchPaths[key]
		changes, err := watch.poll()
		if err != nil {
			return err
		}
		for _, change := range changes {
			o.changed(filepath.Join(root, filepath.FromSlash(change.path)), change)
		}
	}
	return nil
}

func syncIgnorePathWithin(root, name string) bool {
	root, name = norm(root), norm(name)
	return root == name || strings.HasPrefix(name, strings.TrimRight(root, "\\")+"\\")
}

func syncIgnoreUnconditionalDirectory(name string) bool {
	switch strings.ToLower(name) {
	case "node_modules", ".venv", "venv", "__pycache__":
		return true
	}
	return false
}

func (o *syncIgnoreObservation) changed(name string, change syncIgnoreChange) {
	name = filepath.Clean(name)
	// These known files may live outside the worktree (linked worktrees,
	// core.excludesFile and included Git configuration).
	for input, configuration := range o.inputs {
		sharedIndex := strings.EqualFold(filepath.Base(input), "index") &&
			norm(filepath.Dir(input)) == norm(filepath.Dir(name)) && strings.HasPrefix(strings.ToLower(filepath.Base(name)), "sharedindex.")
		if norm(input) == norm(name) || sharedIndex || (change.directory && syncIgnorePathWithin(name, input)) {
			o.revision++
			o.signature = ""
			o.metadata = o.metadata || configuration || change.directory || change.name
			o.configuration = o.configuration || configuration || change.directory
			return
		}
	}
	if !syncIgnorePathWithin(o.root, name) {
		return
	}
	relative, err := filepath.Rel(o.root, name)
	if err != nil {
		o.discover, o.metadata, o.configuration = true, true, true
		o.revision++
		o.signature = ""
		return
	}
	parts := strings.Split(filepath.ToSlash(relative), "/")
	for _, part := range parts {
		if strings.EqualFold(part, ".git") {
			// Metadata files were handled above; object writes and lock files
			// do not change the effective ignore inventory.
			if len(parts) == 1 {
				o.metadata, o.configuration = true, true
				o.revision++
				o.signature = ""
			}
			return
		}
		if syncIgnoreUnconditionalDirectory(part) {
			return
		}
	}
	if change.directory {
		o.discover = true
	} else if strings.EqualFold(filepath.Base(name), ".gitignore") {
		o.dirtyRules[name] = true
	} else if !change.name {
		return
	}
	// Generated rules contain concrete ignored paths. A new/renamed/deleted
	// ordinary file can therefore change the policy, while editing it cannot.
	o.revision++
	o.signature = ""
}

// Discovery visits directory entries once, reads only ignore files and never
// stats/hashes ordinary files. Fixed runtime exclusions cannot contribute rules.
func discoverSyncIgnoreRules(root string) (map[string][sha256.Size]byte, error) {
	rules := make(map[string][sha256.Size]byte)
	var visit func(string) error
	visit = func(directory string) error {
		entries, err := os.ReadDir(directory)
		if err != nil {
			return err
		}
		for _, entry := range entries {
			name := filepath.Join(directory, entry.Name())
			if entry.IsDir() {
				if strings.EqualFold(entry.Name(), ".git") || syncIgnoreUnconditionalDirectory(entry.Name()) || entry.Type()&fs.ModeSymlink != 0 {
					continue
				}
				if err := visit(name); err != nil {
					return err
				}
			} else if strings.EqualFold(entry.Name(), ".gitignore") && entry.Type()&fs.ModeSymlink == 0 {
				data, err := os.ReadFile(name)
				if err != nil {
					return err
				}
				rules[name] = sha256.Sum256(data)
			}
		}
		return nil
	}
	return rules, visit(root)
}

// refreshInputs discovers Git metadata locations without Git subprocesses. The
// linked-worktree pointer and commondir are both relative to their containing
// directory. Effective global/config includes are resolved only on invalidation.
func (o *syncIgnoreObservation) refreshInputs() error {
	inputs := make(map[string]bool)
	marker := filepath.Join(o.root, ".git")
	inputs[marker] = true
	gitDirectory := marker
	if info, err := os.Stat(marker); err == nil && !info.IsDir() {
		data, err := os.ReadFile(marker)
		if err != nil {
			return err
		}
		value, valid := strings.CutPrefix(strings.TrimSpace(string(data)), "gitdir:")
		if !valid || strings.TrimSpace(value) == "" {
			return fmt.Errorf("invalid Git directory pointer")
		}
		gitDirectory = strings.TrimSpace(value)
		if !filepath.IsAbs(gitDirectory) {
			gitDirectory = filepath.Join(o.root, gitDirectory)
		}
	} else if err != nil && !os.IsNotExist(err) {
		return err
	}
	commonDirectory := gitDirectory
	commonFile := filepath.Join(gitDirectory, "commondir")
	inputs[commonFile] = true
	if data, err := os.ReadFile(commonFile); err == nil {
		commonDirectory = strings.TrimSpace(string(data))
		if !filepath.IsAbs(commonDirectory) {
			commonDirectory = filepath.Join(gitDirectory, commonDirectory)
		}
	} else if !os.IsNotExist(err) {
		return err
	}
	for _, directory := range []string{gitDirectory, commonDirectory} {
		for _, item := range []string{"index", "HEAD", "config", "config.worktree", "info/exclude"} {
			inputs[filepath.Join(directory, filepath.FromSlash(item))] = item == "config" || item == "config.worktree" || item == "HEAD"
		}
	}
	if alternate := os.Getenv("GIT_INDEX_FILE"); alternate != "" {
		if !filepath.IsAbs(alternate) {
			alternate = filepath.Join(o.root, alternate)
		}
		inputs[filepath.Clean(alternate)] = false
	}
	// Configuration discovery publishes effective global/config includes.
	for input, configuration := range o.external {
		inputs[input] = configuration
	}
	return o.setInputs(inputs)
}

func sameSyncIgnoreInputs(a, b map[string]bool) bool {
	if len(a) != len(b) {
		return false
	}
	for name, configuration := range a {
		if previous, present := b[name]; !present || configuration != previous {
			return false
		}
	}
	return true
}

func (o *syncIgnoreObservation) setInputs(inputs map[string]bool) error {
	// Git follows external excludes/config symlinks. Observe their resolved
	// target as well as the link's parent so both target edits and link swaps
	// invalidate proof. Dangling/unreadable links cannot establish proof.
	for input, configuration := range inputs {
		info, err := os.Lstat(input)
		if os.IsNotExist(err) {
			continue
		}
		if err != nil {
			return err
		}
		if info.IsDir() {
			continue
		}
		resolved, err := filepath.EvalSymlinks(input)
		if err != nil {
			return err
		}
		if norm(resolved) != norm(input) {
			inputs[resolved] = inputs[resolved] || configuration
		}
	}
	wanted := map[string]bool{norm(o.root): true}
	for input := range inputs {
		if syncIgnorePathWithin(o.root, input) {
			continue
		}
		// Watch each existing parent non-recursively. A missing path's first
		// created ancestor invalidates metadata discovery and moves the watch
		// inward before proof can be reused.
		directory := filepath.Dir(input)
		var identity syncIgnoreDirectoryIdentity
		for {
			var err error
			identity, err = syncIgnoreReadDirectoryIdentity(directory)
			if err == nil {
				break
			}
			if !os.IsNotExist(err) {
				return err
			}
			parent := filepath.Dir(directory)
			if parent == directory {
				return fmt.Errorf("no existing parent for Git ignore input")
			}
			directory = parent
		}
		key := norm(directory)
		wanted[key] = true
		if o.watchers[key] == nil {
			watch, err := o.newWatch(directory, false)
			if err != nil {
				return err
			}
			o.watchers[key] = watch
			o.watchPaths[key] = directory
			o.watchIdentity[key] = identity
		}
	}
	for key, watch := range o.watchers {
		if !wanted[key] {
			watch.close()
			delete(o.watchers, key)
			delete(o.watchPaths, key)
			delete(o.watchIdentity, key)
		}
	}
	o.inputs = inputs
	return nil
}

func syncIgnoreGitConfigOutput(ctx context.Context, local string, args ...string) (string, error) {
	return syncIgnoreLocalGitOutput(ctx, local, append([]string{"config"}, args...)...)
}

func syncIgnoreLocalGitOutput(ctx context.Context, local string, args ...string) (string, error) {
	command := hideCommandWindow(exec.CommandContext(ctx, "git", append([]string{"-C", local, "-c", "core.fsmonitor=false"}, args...)...))
	command.WaitDelay = time.Second
	// These local, read-only config queries cannot use SSH and need no account
	// state. In particular, signature observation also works during offline use.
	command.Env = append(os.Environ(), "LC_ALL=C", "GIT_TERMINAL_PROMPT=0")
	out, err := command.CombinedOutput()
	if err != nil {
		if ctx.Err() != nil {
			return "", ctx.Err()
		}
		return "", fmt.Errorf("observe local Git ignore configuration: %w: %s", err, strings.TrimSpace(string(out)))
	}
	if strings.HasSuffix(string(out), "\x00") {
		return string(out), nil
	}
	return strings.TrimSpace(string(out)), nil
}

func syncIgnoreGitHome() string {
	if home := os.Getenv("HOME"); home != "" {
		return home
	}
	home, _ := os.UserHomeDir()
	return home
}

// Git resolves includeIf and core.excludesFile on initial/config discovery.
// Steady signatures use the watches installed for these effective inputs.
func syncIgnoreGitConfigurationInputs(ctx context.Context, m *Mapping) (map[string]bool, error) {
	// These overrides select metadata outside the mapped repository. Until
	// resolved explicitly, force the existing uncached inventory fallback.
	for _, key := range []string{"GIT_DIR", "GIT_COMMON_DIR", "GIT_WORK_TREE"} {
		if os.Getenv(key) != "" {
			return nil, fmt.Errorf("Git ignore observation does not certify %s override", key)
		}
	}
	inputs := make(map[string]bool)
	add := func(name string, configuration bool) {
		if name == "" || strings.ContainsRune(name, 0) {
			return
		}
		if !filepath.IsAbs(name) {
			name = filepath.Join(m.LocalPath, name)
		}
		name = filepath.Clean(name)
		inputs[name] = inputs[name] || configuration
	}
	out, err := syncIgnoreGitConfigOutput(ctx, m.LocalPath, "--null", "--list", "--show-origin")
	if err != nil {
		return nil, err
	}
	fields := strings.Split(strings.TrimSuffix(out, "\x00"), "\x00")
	if len(fields)%2 != 0 {
		return nil, fmt.Errorf("invalid Git configuration origins")
	}
	for index := 0; index < len(fields); index += 2 {
		origin, entry := fields[index], fields[index+1]
		originName, file := strings.CutPrefix(origin, "file:")
		if file {
			add(originName, true)
		}
		key, value, _ := strings.Cut(entry, "\n")
		key = strings.ToLower(key)
		if key == "include.path" || (strings.HasPrefix(key, "includeif.") && strings.HasSuffix(key, ".path")) {
			if strings.HasPrefix(value, "~/") || strings.HasPrefix(value, "~\\") {
				if home := syncIgnoreGitHome(); home != "" {
					value = filepath.Join(home, value[2:])
				}
			} else if !filepath.IsAbs(value) && file {
				if !filepath.IsAbs(originName) {
					originName = filepath.Join(m.LocalPath, originName)
				}
				value = filepath.Join(filepath.Dir(originName), value)
			}
			add(value, true)
		}
	}
	out, err = syncIgnoreGitConfigOutput(ctx, m.LocalPath, "--path", "--get", "core.excludesFile")
	if err != nil && gitExitCode(err) != 1 {
		return nil, err
	}
	if err == nil {
		add(out, false)
	} else {
		configuration := os.Getenv("XDG_CONFIG_HOME")
		if configuration == "" {
			if home := syncIgnoreGitHome(); home != "" {
				configuration = filepath.Join(home, ".config")
			}
		}
		if configuration != "" {
			add(filepath.Join(configuration, "git", "ignore"), false)
		}
	}
	// Missing standard config files have no --show-origin entry. Observe their
	// creation as well as changes to the currently effective files.
	if name := os.Getenv("GIT_CONFIG_GLOBAL"); name != "" {
		add(name, true)
	} else if home := syncIgnoreGitHome(); home != "" {
		add(filepath.Join(home, ".gitconfig"), true)
		configuration := os.Getenv("XDG_CONFIG_HOME")
		if configuration == "" {
			configuration = filepath.Join(home, ".config")
		}
		add(filepath.Join(configuration, "git", "config"), true)
	}
	if !syncGitSystemConfigDisabled() {
		if name := os.Getenv("GIT_CONFIG_SYSTEM"); name != "" {
			add(name, true)
		} else if name, err := syncGitSystemConfigPath(); err == nil {
			add(name, true)
		} else {
			// Older Git versions do not publish the installation-dependent
			// system-config path. They cannot certify its later creation.
			return nil, err
		}
	}
	return inputs, nil
}

// A stream owns one pending overlapped read. Both buffers remain reachable until
// cancellation completes; no goroutine or kernel write outlives close().
type syncIgnoreWindowsStream struct {
	handle     windows.Handle
	event      windows.Handle
	overlapped windows.Overlapped
	buffer     []byte
	mask       uint32
	recursive  bool
	directory  bool
	pending    bool
}

type syncIgnoreWindowsWatch struct {
	streams []*syncIgnoreWindowsStream
}

func newSyncIgnoreWindowsWatch(root string, recursive bool) (syncIgnoreWatch, error) {
	watch := &syncIgnoreWindowsWatch{}
	for _, directory := range []bool{true, false} {
		stream, err := newSyncIgnoreWindowsStream(root, recursive, directory)
		if err != nil {
			watch.close()
			return nil, err
		}
		watch.streams = append(watch.streams, stream)
	}
	return watch, nil
}

func newSyncIgnoreWindowsStream(root string, recursive, directory bool) (*syncIgnoreWindowsStream, error) {
	name, err := syncIgnoreWindowsPath(root)
	if err != nil {
		return nil, err
	}
	handle, err := windows.CreateFile(name, windows.FILE_LIST_DIRECTORY, windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE,
		nil, windows.OPEN_EXISTING, windows.FILE_FLAG_BACKUP_SEMANTICS|windows.FILE_FLAG_OVERLAPPED, 0)
	if err != nil {
		return nil, err
	}
	event, err := windows.CreateEvent(nil, 1, 0, nil)
	if err != nil {
		windows.CloseHandle(handle)
		return nil, err
	}
	mask := uint32(windows.FILE_NOTIFY_CHANGE_FILE_NAME | windows.FILE_NOTIFY_CHANGE_LAST_WRITE | windows.FILE_NOTIFY_CHANGE_SIZE)
	if directory {
		mask = windows.FILE_NOTIFY_CHANGE_DIR_NAME
	}
	stream := &syncIgnoreWindowsStream{handle: handle, event: event, buffer: make([]byte, 64*1024), mask: mask, recursive: recursive, directory: directory}
	if err := stream.arm(); err != nil {
		stream.close()
		return nil, err
	}
	return stream, nil
}

func (s *syncIgnoreWindowsStream) arm() error {
	if err := windows.ResetEvent(s.event); err != nil {
		return err
	}
	s.overlapped = windows.Overlapped{HEvent: s.event}
	err := windows.ReadDirectoryChanges(s.handle, &s.buffer[0], uint32(len(s.buffer)), s.recursive, s.mask, nil, &s.overlapped, 0)
	if err != nil && !errors.Is(err, windows.ERROR_IO_PENDING) {
		return err
	}
	s.pending = true
	return nil
}

func (w *syncIgnoreWindowsWatch) poll() ([]syncIgnoreChange, error) {
	var changes []syncIgnoreChange
	for _, stream := range w.streams {
		for batch := 0; ; batch++ {
			ready, err := windows.WaitForSingleObject(stream.event, 0)
			if err != nil {
				return nil, err
			}
			if ready == uint32(windows.WAIT_TIMEOUT) {
				break
			}
			if ready != windows.WAIT_OBJECT_0 || batch >= 16 {
				return nil, fmt.Errorf("ignore directory notification backlog exceeded")
			}
			var count uint32
			err = windows.GetOverlappedResult(stream.handle, &stream.overlapped, &count, false)
			stream.pending = false
			if err != nil {
				return nil, err
			}
			if count == 0 || count > uint32(len(stream.buffer)) {
				return nil, fmt.Errorf("ignore directory notification overflow")
			}
			batchChanges, err := parseSyncIgnoreWindowsChanges(stream.buffer[:count], stream.directory)
			if err != nil {
				return nil, err
			}
			changes = append(changes, batchChanges...)
			if err := stream.arm(); err != nil {
				return nil, err
			}
		}
	}
	return changes, nil
}

func parseSyncIgnoreWindowsChanges(buffer []byte, directory bool) ([]syncIgnoreChange, error) {
	var changes []syncIgnoreChange
	for offset := 0; ; {
		if len(buffer)-offset < 12 {
			return nil, fmt.Errorf("truncated ignore directory notification")
		}
		record := buffer[offset:]
		next, action, size := binary.LittleEndian.Uint32(record), binary.LittleEndian.Uint32(record[4:]), binary.LittleEndian.Uint32(record[8:])
		if size%2 != 0 || size == 0 || size > uint32(len(record)-12) || action < windows.FILE_ACTION_ADDED || action > windows.FILE_ACTION_RENAMED_NEW_NAME {
			return nil, fmt.Errorf("invalid ignore directory notification")
		}
		wide := make([]uint16, size/2)
		for i := range wide {
			wide[i] = binary.LittleEndian.Uint16(record[12+i*2:])
		}
		name := string(utf16.Decode(wide))
		if filepath.IsAbs(name) || name == ".." || strings.HasPrefix(filepath.Clean(name), "..\\") || strings.ContainsRune(name, 0) {
			return nil, fmt.Errorf("invalid ignore notification path")
		}
		changes = append(changes, syncIgnoreChange{path: name, directory: directory, name: action != windows.FILE_ACTION_MODIFIED})
		if next == 0 {
			return changes, nil
		}
		if next%4 != 0 || next < 12+size || next > uint32(len(record)-12) {
			return nil, fmt.Errorf("invalid ignore notification offset")
		}
		offset += int(next)
	}
}

func (w *syncIgnoreWindowsWatch) close() {
	for _, stream := range w.streams {
		stream.close()
	}
	w.streams = nil
}

func (s *syncIgnoreWindowsStream) close() {
	if s.pending {
		_ = windows.CancelIoEx(s.handle, &s.overlapped)
		var ignored uint32
		_ = windows.GetOverlappedResult(s.handle, &s.overlapped, &ignored, true)
		s.pending = false
	}
	_ = windows.CloseHandle(s.handle)
	_ = windows.CloseHandle(s.event)
}
