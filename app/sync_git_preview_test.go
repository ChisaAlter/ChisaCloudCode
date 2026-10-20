package main

import (
	"context"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"testing"
	"time"
)

func syncGitPreviewTools(t *testing.T) *syncSeedTestTools {
	t.Helper()
	syncGitObservationTestEnvironment(t)
	tools := syncSeedTools(t)
	for _, item := range tools.env {
		key, value, _ := strings.Cut(item, "=")
		if strings.HasPrefix(key, "GIT_") {
			t.Setenv(key, value)
		}
	}
	return tools
}

func syncGitPreviewInit(t *testing.T, tools *syncSeedTestTools, root string) {
	t.Helper()
	tools.gitRun(t, root, "init", "-b", "main")
	tools.gitRun(t, root, "config", "core.autocrlf", "false")
	syncSeedWrite(t, root, "tracked.txt", "base\n")
	tools.gitRun(t, root, "add", ".")
	tools.gitRun(t, root, "commit", "-m", "base")
}

func syncGitPreviewState(t *testing.T, tools *syncSeedTestTools, m *Mapping, reader string) (syncGitState, error) {
	t.Helper()
	if reader == "local" {
		ctx := context.WithValue(context.Background(), syncGitPreviewKey{}, true)
		return readLocalGitState(ctx, m)
	}
	out, err := syncGitWorker(t, tools, map[string]any{"root": m.LocalPath, "op": "preview"}, "")
	if err != nil {
		return syncGitState{}, err
	}
	var state syncGitState
	err = json.Unmarshal([]byte(out), &state)
	return state, err
}

func syncGitPreviewUnchanged(t *testing.T, root string, before map[string]string) {
	t.Helper()
	after := syncSeedSnapshot(t, root, false)
	if reflect.DeepEqual(before, after) {
		return
	}
	changed := []string{}
	for name, content := range before {
		if actual, exists := after[name]; !exists || actual != content {
			changed = append(changed, name)
		}
	}
	for name := range after {
		if _, exists := before[name]; !exists {
			changed = append(changed, name)
		}
	}
	sort.Strings(changed)
	t.Errorf("read-only preview changed %s: %v", root, changed)
}

// Calculate the expected tree without write-tree or mktree: neither the fixture
// nor the expectation should populate an object that preview might wrongly write.
// These fixtures have one tracked path; conflicts preserve the raw Git stages.
func syncGitPreviewExpected(t *testing.T, tools *syncSeedTestTools, m *Mapping, detached, conflict bool) syncGitState {
	t.Helper()
	state := syncGitState{Head: tools.gitRun(t, m.LocalPath, "rev-parse", "HEAD")}
	if !detached {
		state.Branch = tools.gitRun(t, m.LocalPath, "symbolic-ref", "HEAD")
	}
	listing := tools.gitRun(t, m.LocalPath, "ls-files", "--stage", "-z")
	if conflict {
		state.Index = syncGitStagesPrefix + base64.StdEncoding.EncodeToString([]byte(listing))
	} else if listing == "" {
		state.Index = tools.gitInput(t, m.LocalPath, nil, "hash-object", "-t", "tree", "--stdin")
	} else {
		metadata, name, ok := strings.Cut(strings.TrimSuffix(listing, "\x00"), "\t")
		fields := strings.Fields(metadata)
		if !ok || len(fields) != 3 || fields[2] != "0" || name != "tracked.txt" {
			t.Fatalf("unexpected fixture index: %q", listing)
		}
		oid, err := hex.DecodeString(fields[1])
		if err != nil {
			t.Fatal(err)
		}
		tree := append([]byte(fields[0]+" "+name+"\x00"), oid...)
		state.Index = tools.gitInput(t, m.LocalPath, tree, "hash-object", "-t", "tree", "--stdin")
	}
	operations := map[string]syncGitOperationEntry{}
	for _, name := range syncGitOperationFiles {
		content, err := os.ReadFile(filepath.Join(m.LocalPath, ".git", name))
		if os.IsNotExist(err) {
			continue
		}
		if err != nil {
			t.Fatal(err)
		}
		operations[name] = syncGitOperationEntry{content: string(content)}
	}
	state.Operations = encodeGitOperations(operations)
	return state
}

func TestSyncGitPreviewRealStateReadOnly(t *testing.T) {
	for _, scenario := range []string{"clean", "staged-and-unstaged", "detached", "merge-conflict", "missing-index"} {
		for _, reader := range []string{"local", "worker"} {
			t.Run(scenario+"/"+reader, func(t *testing.T) {
				m := isolatePi(t)
				tools := syncGitPreviewTools(t)
				syncGitPreviewInit(t, tools, m.LocalPath)
				switch scenario {
				case "staged-and-unstaged":
					syncSeedWrite(t, m.LocalPath, "tracked.txt", "staged\n")
					tools.gitRun(t, m.LocalPath, "add", "tracked.txt")
					syncSeedWrite(t, m.LocalPath, "tracked.txt", "unstaged must survive\n")
				case "detached":
					tools.gitRun(t, m.LocalPath, "checkout", "--detach", "HEAD")
				case "missing-index":
					// This is exactly this fixture's index, never a user repository.
					index := filepath.Join(m.LocalPath, ".git", "index")
					if err := os.Remove(index); err != nil {
						t.Fatal(err)
					}
				case "merge-conflict":
					tools.gitRun(t, m.LocalPath, "checkout", "-b", "topic")
					syncSeedWrite(t, m.LocalPath, "tracked.txt", "topic\n")
					tools.gitRun(t, m.LocalPath, "commit", "-am", "topic")
					tools.gitRun(t, m.LocalPath, "checkout", "main")
					syncSeedWrite(t, m.LocalPath, "tracked.txt", "main\n")
					tools.gitRun(t, m.LocalPath, "commit", "-am", "main")
					syncGitExpectFailure(t, tools, m.LocalPath, "merge", "topic")
				}
				expected := syncGitPreviewExpected(t, tools, m, scenario == "detached", scenario == "merge-conflict")
				before := syncSeedSnapshot(t, m.LocalPath, false)
				actual, err := syncGitPreviewState(t, tools, m, reader)
				if err != nil {
					t.Fatal(err)
				}
				if actual != expected {
					t.Errorf("preview differs from real Git: got %+v; want %+v", actual, expected)
				}
				syncGitPreviewUnchanged(t, m.LocalPath, before)
			})
		}
	}
}

func TestSyncGitPreviewFetchUsesDisposableObjects(t *testing.T) {
	m := isolatePi(t)
	tools := syncGitPreviewTools(t)
	syncGitPreviewInit(t, tools, m.LocalPath)
	other := t.TempDir()
	syncGitPreviewInit(t, tools, other)
	syncSeedWrite(t, other, "remote-only.txt", "exists only in the independent repository\n")
	tools.gitRun(t, other, "add", "remote-only.txt")
	tools.gitRun(t, other, "commit", "-m", "independent remote commit")
	head := tools.gitRun(t, other, "rev-parse", "HEAD")
	tree := tools.gitRun(t, other, "cat-file", "-p", head+"^{tree}")
	if _, err := gitOutputContext(context.Background(), m.LocalPath, "cat-file", "-e", head+"^{commit}"); err == nil {
		t.Fatal("fixture already contains the independent commit")
	}
	expected := syncGitPreviewExpected(t, tools, m, false, false)
	before := syncSeedSnapshot(t, m.LocalPath, false)
	ctx := context.WithValue(context.Background(), syncGitPreviewKey{}, true)
	ctx, discard, err := syncGitPreviewObjectsContext(ctx, m)
	if err != nil {
		t.Fatal(err)
	}
	defer discard()
	privateObjects := ""
	for _, setting := range ctx.Value(syncGitPreviewObjectsKey{}).([]string) {
		if value, ok := strings.CutPrefix(setting, "GIT_OBJECT_DIRECTORY="); ok {
			privateObjects = value
		}
	}
	if privateObjects == "" {
		t.Fatal("preview did not create a private object directory")
	}
	if _, err := gitOutputContext(ctx, m.LocalPath, "fetch", "--no-tags", "--no-write-fetch-head", "--no-auto-maintenance", other, "HEAD"); err != nil {
		t.Fatal(err)
	}
	if actual, err := gitOutputContext(ctx, m.LocalPath, "cat-file", "-p", head+"^{tree}"); err != nil || actual != tree {
		t.Fatalf("preview cannot read fetched tree: %q %v; want %q", actual, err, tree)
	}
	if state, err := readLocalGitState(ctx, m); err != nil || state != expected {
		t.Fatalf("shared preview context changed local state: %+v %v; want %+v", state, err, expected)
	}
	// Reusing the context, including readLocalGitState's deferred cleanup, must
	// leave the shared fetch objects alive for the remaining preview preflight.
	if kind, err := gitOutputContext(ctx, m.LocalPath, "cat-file", "-t", head); err != nil || kind != "commit" {
		t.Fatalf("nested preview discarded shared objects: %q %v", kind, err)
	}
	syncGitPreviewUnchanged(t, m.LocalPath, before)
	discard()
	if _, err := os.Stat(privateObjects); !os.IsNotExist(err) {
		t.Errorf("private preview objects survived cleanup: %v", err)
	}
	if _, err := gitOutputContext(context.Background(), m.LocalPath, "cat-file", "-e", head+"^{commit}"); err == nil {
		t.Error("preview fetch permanently imported the independent commit")
	}
	syncGitPreviewUnchanged(t, m.LocalPath, before)
}

func TestSyncGitPreviewPreservesIndexLocks(t *testing.T) {
	for _, scenario := range []string{"existing-guard", "orphan-owned", "foreign-lock", "foreign-lock-with-owned", "owned-lock"} {
		for _, reader := range []string{"local", "worker"} {
			t.Run(scenario+"/"+reader, func(t *testing.T) {
				m := isolatePi(t)
				tools := syncGitPreviewTools(t)
				syncGitPreviewInit(t, tools, m.LocalPath)
				index := filepath.Join(m.LocalPath, ".git", "index")
				write := func(suffix, content string) {
					t.Helper()
					if err := os.WriteFile(index+suffix, []byte(content), 0600); err != nil {
						t.Fatal(err)
					}
				}
				switch scenario {
				case "existing-guard":
					write(".chisa-guard", "preexisting guard inode\n")
				case "orphan-owned":
					write(".chisa-owned", "interrupted writer evidence\n")
				case "foreign-lock":
					write(".lock", "external Git writer\n")
				case "foreign-lock-with-owned":
					write(".chisa-owned", "old writer evidence\n")
					write(".lock", "external replacement writer\n")
				case "owned-lock":
					write(".chisa-owned", "same-inode interrupted writer\n")
					if err := os.Link(index+".chisa-owned", index+".lock"); err != nil {
						t.Fatal(err)
					}
				}
				before := syncSeedSnapshot(t, m.LocalPath, false)
				identities := map[string]os.FileInfo{}
				for _, suffix := range []string{".chisa-guard", ".chisa-owned", ".lock"} {
					if info, err := os.Stat(index + suffix); err == nil {
						identities[suffix] = info
					} else if !os.IsNotExist(err) {
						t.Fatal(err)
					}
				}
				_, err := syncGitPreviewState(t, tools, m, reader)
				locked := strings.Contains(scenario, "lock")
				if locked && err == nil {
					t.Error("preview accepted an existing index.lock")
				} else if !locked && err != nil {
					t.Errorf("preview rejected metadata without an index.lock: %v", err)
				}
				syncGitPreviewUnchanged(t, m.LocalPath, before)
				for suffix, before := range identities {
					after, err := os.Stat(index + suffix)
					if err != nil || !os.SameFile(before, after) || !before.ModTime().Equal(after.ModTime()) {
						t.Errorf("preview replaced or modified %s: %v", suffix, err)
					}
				}
			})
		}
	}
}

// A read must not enter flock, even when the guard already exists. Other worker
// tests cover the real platform lock for writes; no locking is simulated here.
const syncGitPreviewLeaseBootstrap = `import sys, types
def forbidden_flock(*args): raise AssertionError('lease read acquired a write guard')
sys.modules['fcntl'] = types.SimpleNamespace(LOCK_EX=2, LOCK_NB=4, flock=forbidden_flock)
` + syncGitApplyTestBootstrap

func TestSyncGitPreviewLeaseReadDoesNotCreateGuard(t *testing.T) {
	tools := syncSeedTools(t)
	for _, scenario := range []string{"absent", "existing", "existing-guard", "invalid-state"} {
		t.Run(scenario, func(t *testing.T) {
			parent := t.TempDir()
			root := filepath.Join(parent, "project")
			var expected map[string]any
			if scenario != "absent" {
				expected = map[string]any{"owner": "pi", "id": "unrelated-task", "epoch": "binding"}
				data, err := json.Marshal(expected)
				if err != nil {
					t.Fatal(err)
				}
				if scenario == "invalid-state" {
					data = []byte("{not-json")
				}
				syncSeedWrite(t, parent, "project.chisa-lease/state.json", string(data))
			}
			if scenario == "existing-guard" {
				syncSeedWrite(t, parent, "project.chisa-lease.guard", "preserve guard\n")
			}
			before := syncSeedSnapshot(t, parent, false)
			request, err := json.Marshal(map[string]any{"root": root, "op": "read", "epoch": "binding"})
			if err != nil {
				t.Fatal(err)
			}
			out, stderr, err := tools.command(t, request, tools.python, "-c", syncGitPreviewLeaseBootstrap, leaseWorker)
			if err != nil {
				t.Fatalf("lease read: %v: %s", err, stderr)
			}
			var result map[string]any
			if err := json.Unmarshal([]byte(out), &result); err != nil {
				t.Fatal(err, out)
			}
			if scenario == "invalid-state" {
				if result["ok"] != false {
					t.Fatalf("invalid lease accepted: %v", result)
				}
			} else {
				lease, _ := result["lease"].(map[string]any)
				if result["ok"] != true || !reflect.DeepEqual(lease, expected) {
					t.Errorf("lease read: got %v; want %v", result, expected)
				}
			}
			syncGitPreviewUnchanged(t, parent, before)
		})
	}
}

type syncGitPreviewConsentFixture struct {
	tools                             *syncSeedTestTools
	mapping                           *Mapping
	remote                            string
	session                           syncSession
	calls                             string
	ctx                               context.Context
	consent                           *syncGitRecoveryConsent
	lease                             map[string]any
	leaseWrites, pauses, synchronizes int
}

func syncGitPreviewConsent(t *testing.T) *syncGitPreviewConsentFixture {
	t.Helper()
	f := &syncGitPreviewConsentFixture{mapping: isolateSyncRecovery(t), remote: t.TempDir()}
	f.tools = syncGitPreviewTools(t)
	m := f.mapping
	f.session = syncSession{Name: m.SyncName, Identifier: "preview-session", Mode: "two-way-safe", Status: "watching", SuccessfulCycles: 1}
	f.session.Ignore.VCS = true
	f.session.Alpha = syncEndpoint{Path: m.LocalPath, Connected: true, Scanned: true}
	f.session.Beta = syncEndpoint{Protocol: "ssh", Host: syncSSHAlias(store.config()), Path: m.ServerPath, Connected: true, Scanned: true}
	encoded, err := json.Marshal([]syncSession{f.session})
	if err != nil {
		t.Fatal(err)
	}
	f.calls = privateConnectionTool(t, string(encoded))
	syncGitPreviewInit(t, f.tools, m.LocalPath)
	f.tools.gitRun(t, f.remote, "clone", "--no-hardlinks", m.LocalPath, ".")
	f.lease = map[string]any{"owner": "sync-needed", "id": "observed-reservation", "epoch": m.BindingEpoch}
	remoteLeaseContext = func(_ context.Context, _ *Mapping, op, _, _ string) (map[string]any, error) {
		if op != "read" {
			f.leaseWrites++
			return nil, errors.New("unexpected lease mutation after stale preview")
		}
		return map[string]any{"ok": true, "lease": f.lease}, nil
	}
	pauseProjectSync = func(context.Context, *Mapping) error {
		f.pauses++
		return errors.New("unexpected pause after stale preview")
	}
	synchronizeProjectContext = func(context.Context, *Mapping, bool) error {
		f.synchronizes++
		return errors.New("unexpected synchronization after stale preview")
	}
	previousObserver := observeSyncGitRemoteMetadata
	// Only transport is replaced: both fingerprints observe real Git metadata in
	// independent repositories. The embedded preview worker is exercised above.
	observeSyncGitRemoteMetadata = func(_ context.Context, _ *Mapping) (syncMetadataObservation, error) {
		remoteMapping := *m
		remoteMapping.LocalPath = f.remote
		fingerprint, repository, err := localSyncMetadataFingerprint(&remoteMapping)
		return syncMetadataObservation{Git: fingerprint, Repository: repository}, err
	}
	t.Cleanup(func() {
		observeSyncGitRemoteMetadata = previousObserver
		syncGitRecoveryPreviews.Delete(m.ServerPath)
	})
	ctx, cancel, err := bindWorkspaceSyncConnection(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(cancel)
	f.ctx = ctx
	checkpoint, err := loadGitCheckpoint(m)
	if err != nil {
		t.Fatal(err)
	}
	local, err := syncGitPreviewState(t, f.tools, m, "local")
	if err != nil {
		t.Fatal(err)
	}
	remote, err := syncGitPreviewState(t, f.tools, &Mapping{LocalPath: f.remote}, "worker")
	if err != nil {
		t.Fatal(err)
	}
	localFingerprint, repository, err := localSyncMetadataFingerprint(m)
	if err != nil || !repository || localFingerprint == "" {
		t.Fatalf("local fingerprint: %q %v %v", localFingerprint, repository, err)
	}
	other, err := observeSyncGitRemoteMetadata(ctx, m)
	if err != nil || !other.Repository || other.Git == "" {
		t.Fatalf("remote fingerprint: %+v %v", other, err)
	}
	lease, err := syncGitRecoveryLease(ctx, m)
	if err != nil {
		t.Fatal(err)
	}
	f.consent = &syncGitRecoveryConsent{
		view: syncGitRecoveryView{Token: "preview-token", ServerPath: m.ServerPath, BindingEpoch: m.BindingEpoch, LocalAllowed: true, RemoteAllowed: true},
		plan: &syncGitPlan{mapping: *m, key: syncGitObservationKey(ctx, m), checkpoint: checkpoint,
			local: local, remote: remote, localFingerprint: localFingerprint, remoteFingerprint: other.Git, git: true},
		lease: lease, session: f.session.Identifier, expires: time.Now().Add(time.Minute),
	}
	if err := os.MkdirAll(dataDir(), 0700); err != nil {
		t.Fatal(err)
	}
	syncGitRecoveryPreviews.Store(m.ServerPath, f.consent)
	return f
}

func TestSyncGitPreviewConsentSingleUse(t *testing.T) {
	f := syncGitPreviewConsent(t)
	local, remote := syncSeedSnapshot(t, f.mapping.LocalPath, false), syncSeedSnapshot(t, f.remote, false)
	data := syncSeedSnapshot(t, dataDir(), false)
	if err := validateSyncGitRecovery(f.ctx, f.mapping, f.consent); err != nil {
		t.Fatal("unchanged consent rejected:", err)
	}
	if _, ok := syncGitRecoveryPreviews.Load(f.mapping.ServerPath); ok {
		t.Error("successful validation left the confirmation reusable")
	}
	if err := validateSyncGitRecovery(f.ctx, f.mapping, f.consent); !errors.Is(err, errSyncGitRecoveryStale) {
		t.Errorf("consumed confirmation accepted: %v", err)
	}
	if result := (FrontendBridge{}).RecoverProjectGit(f.mapping.ServerPath, f.mapping.BindingEpoch, f.consent.view.Token, "local"); result["ok"] != false || result["code"] != "GIT_RECOVERY_STALE" {
		t.Errorf("consumed token reached recovery: %v", result)
	}
	if f.leaseWrites != 0 || f.pauses != 0 || f.synchronizes != 0 {
		t.Errorf("validation mutated synchronization: lease=%d pause=%d sync=%d", f.leaseWrites, f.pauses, f.synchronizes)
	}
	syncGitPreviewUnchanged(t, f.mapping.LocalPath, local)
	syncGitPreviewUnchanged(t, f.remote, remote)
	syncGitPreviewUnchanged(t, dataDir(), data)
}

func TestSyncGitPreviewTokenAdmission(t *testing.T) {
	f := syncGitPreviewConsent(t)
	m, consent := f.mapping, f.consent
	local, remote := syncSeedSnapshot(t, m.LocalPath, false), syncSeedSnapshot(t, f.remote, false)
	data := syncSeedSnapshot(t, dataDir(), false)
	for _, request := range []struct {
		name, epoch, token string
		expired            bool
	}{
		{name: "empty-token", epoch: m.BindingEpoch},
		{name: "wrong-token", epoch: m.BindingEpoch, token: "unissued-token"},
		{name: "empty-epoch", token: consent.view.Token},
		{name: "wrong-epoch", epoch: m.BindingEpoch + "-previous", token: consent.view.Token},
		{name: "expired-token", epoch: m.BindingEpoch, token: consent.view.Token, expired: true},
	} {
		t.Run(request.name, func(t *testing.T) {
			expires := consent.expires
			if request.expired {
				consent.expires = time.Now().Add(-time.Second)
			}
			defer func() { consent.expires = expires }()
			result := (FrontendBridge{}).RecoverProjectGit(m.ServerPath, request.epoch, request.token, "local")
			if result["ok"] != false || result["code"] != "GIT_RECOVERY_STALE" {
				t.Errorf("invalid token reached recovery: %v", result)
			}
			if f.leaseWrites != 0 || f.pauses != 0 || f.synchronizes != 0 {
				t.Errorf("invalid token mutated synchronization: lease=%d pause=%d sync=%d", f.leaseWrites, f.pauses, f.synchronizes)
			}
			if actual, ok := syncGitRecoveryPreviews.Load(m.ServerPath); !ok || actual != consent {
				t.Error("invalid token consumed the current confirmation")
			}
			syncGitPreviewUnchanged(t, m.LocalPath, local)
			syncGitPreviewUnchanged(t, f.remote, remote)
			syncGitPreviewUnchanged(t, dataDir(), data)
		})
	}
}

func TestSyncGitPreviewConsentInvalidatedBeforeMutation(t *testing.T) {
	for _, scenario := range []string{"expired", "binding-epoch", "connection", "checkpoint", "pending-checkpoint", "lease", "local-index", "local-metadata", "remote-metadata", "replaced-token"} {
		t.Run(scenario, func(t *testing.T) {
			f := syncGitPreviewConsent(t)
			m, consent := f.mapping, f.consent
			expectedToken := consent
			switch scenario {
			case "expired":
				consent.expires = time.Now().Add(-time.Second)
			case "binding-epoch":
				m.BindingEpoch += "-replacement"
			case "connection":
				replacement, err := newServerConnection(apiConnection.baseURL, apiConnection.loginURL)
				if err != nil {
					t.Fatal(err)
				}
				replacement.authenticated = true
				t.Cleanup(replacement.cancel)
				serverConnectionMu.Lock()
				apiConnection = replacement
				serverConnectionMu.Unlock()
			case "checkpoint", "pending-checkpoint":
				checkpoint := *consent.plan.checkpoint
				checkpoint.Version = 2
				if scenario == "checkpoint" {
					checkpoint.State = consent.plan.local
				} else {
					checkpoint.Pending = &syncGitPending{Local: consent.plan.local, Remote: consent.plan.remote, Desired: consent.plan.local}
				}
				if err := saveGitCheckpoint(m, &checkpoint); err != nil {
					t.Fatal(err)
				}
			case "lease":
				f.lease["id"] = "replacement-reservation"
			case "local-index":
				syncSeedWrite(t, m.LocalPath, "tracked.txt", "new staged state\n")
				f.tools.gitRun(t, m.LocalPath, "add", "tracked.txt")
			case "local-metadata":
				f.tools.gitRun(t, m.LocalPath, "config", "chisa.previewRegression", "changed")
			case "remote-metadata":
				f.tools.gitRun(t, f.remote, "config", "chisa.previewRegression", "changed")
			case "replaced-token":
				replacement := *consent
				replacement.view.Token = "newer-preview-token"
				expectedToken = &replacement
				syncGitRecoveryPreviews.Store(m.ServerPath, expectedToken)
			}
			local, remote := syncSeedSnapshot(t, m.LocalPath, false), syncSeedSnapshot(t, f.remote, false)
			data := syncSeedSnapshot(t, dataDir(), false)
			if err := validateSyncGitRecovery(f.ctx, m, consent); !errors.Is(err, errSyncGitRecoveryStale) {
				t.Errorf("changed preview accepted: %v", err)
			}
			ctx := context.WithValue(context.Background(), syncGitRecoveryKey{}, consent)
			ctx = context.WithValue(ctx, syncGitSourceKey{}, "local")
			result := syncProjectWithEmptyConfirmationContext(ctx, m.ServerPath, "")
			if result["ok"] != false || result["code"] != "GIT_RECOVERY_STALE" {
				t.Errorf("stale preview escaped synchronization admission: %v", result)
			}
			if f.leaseWrites != 0 || f.pauses != 0 || f.synchronizes != 0 {
				t.Errorf("stale preview mutated synchronization: lease=%d pause=%d sync=%d", f.leaseWrites, f.pauses, f.synchronizes)
			}
			if actual, ok := syncGitRecoveryPreviews.Load(m.ServerPath); !ok || actual != expectedToken {
				t.Error("failed validation consumed or replaced the current confirmation")
			}
			syncGitPreviewUnchanged(t, m.LocalPath, local)
			syncGitPreviewUnchanged(t, f.remote, remote)
			syncGitPreviewUnchanged(t, dataDir(), data)
		})
	}
}
