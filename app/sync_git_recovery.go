package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Direction is requested only for an initial observation without a durable
// baseline. Existing checkpoints and interrupted transitions retain precedence.
type syncGitDirectionError struct{ detail string }

func (e *syncGitDirectionError) Error() string { return e.detail }

var errSyncGitRecoveryStale = errors.New("Git 状态或项目连接已改变，请重新查看两端状态后确认")

type syncGitRecoveryKey struct{}
type syncGitPreviewKey struct{}
type syncGitPreviewObjectsKey struct{}

// Preview fetches and write-tree operations share one disposable object database.
// Existing blobs remain readable through alternates; the repository is untouched.
func syncGitPreviewObjectsContext(ctx context.Context, m *Mapping) (context.Context, func(), error) {
	if objects, _ := ctx.Value(syncGitPreviewObjectsKey{}).([]string); objects != nil {
		return ctx, func() {}, nil
	}
	objects, err := gitOutputContext(ctx, m.LocalPath, "rev-parse", "--path-format=absolute", "--git-path", "objects")
	if err != nil {
		return ctx, nil, err
	}
	private, err := os.MkdirTemp("", "chisa-preview-objects-*")
	if err != nil {
		return ctx, nil, err
	}
	alternates := strconv.Quote(filepath.ToSlash(objects))
	if previous := os.Getenv("GIT_ALTERNATE_OBJECT_DIRECTORIES"); previous != "" {
		alternates += string(os.PathListSeparator) + previous
	}
	env := []string{"GIT_OBJECT_DIRECTORY=" + private, "GIT_ALTERNATE_OBJECT_DIRECTORIES=" + alternates, "GIT_OPTIONAL_LOCKS=0", "GIT_NO_LAZY_FETCH=1"}
	return context.WithValue(ctx, syncGitPreviewObjectsKey{}, env), func() { _ = os.RemoveAll(private) }, nil
}

func syncGitRecoverySession(ctx context.Context, m *Mapping) (string, error) {
	sessions, err := syncSessionsContext(ctx, m.SyncName)
	if err != nil {
		return "", fmt.Errorf("%w: %v", errSyncGitRecoveryStale, err)
	}
	if len(sessions) != 1 {
		return "", fmt.Errorf("%w: 无法确认唯一的项目同步会话", errSyncGitRecoveryStale)
	}
	if err := validateProjectSyncSessionContext(ctx, m, sessions[0]); err != nil {
		return "", fmt.Errorf("%w: %v", errSyncGitRecoveryStale, err)
	}
	return sessions[0].Identifier, nil
}

// Only metadata read/preflight call sites may use the lease-free preview path.
// Mutating workers always retain syncRemoteScript's lease requirement.
func syncGitMetadataRemoteScript(ctx context.Context, m *Mapping, script string, input io.Reader) (string, error) {
	if preview, _ := ctx.Value(syncGitPreviewKey{}).(bool); preview {
		return syncGitPreviewRemoteScript(ctx, m, script, input)
	}
	return syncRemoteScript(ctx, m, script, input)
}

// This bypass is scoped to the internal metadata preview, whose callers only
// read states and preflight targets. It cannot enter the file/apply pipeline and
// does not claim, release or reuse a task's synchronization lease.
func syncGitPreviewRemoteScript(ctx context.Context, m *Mapping, script string, input io.Reader) (string, error) {
	command, err := compactSyncRemoteShellCommand(script)
	if err != nil {
		return "", err
	}
	transport, err := workspaceSyncTunnel(ctx, m)
	if err != nil {
		return "", err
	}
	cmd := hideCommandWindow(exec.CommandContext(ctx, sshExe(), append(transport.baseArgs(), command)...))
	cmd.WaitDelay = time.Second
	cmd.Stdin = input
	var diagnostic bytes.Buffer
	cmd.Stderr = &diagnostic
	out, err := cmd.Output()
	if err != nil {
		return "", fmt.Errorf("远端 Git 状态读取未确认: %w: %s", err, strings.TrimSpace(diagnostic.String()))
	}
	if err = workspaceSyncCurrent(ctx); err != nil {
		return "", err
	}
	return strings.TrimSpace(string(out)), nil
}

type syncGitRecoveryEndpoint struct {
	Branch    string `json:"branch"`
	Head      string `json:"head"`
	Staged    bool   `json:"staged"`
	Operation string `json:"operation"`
}

type syncGitRecoveryView struct {
	Token         string                  `json:"token"`
	ServerPath    string                  `json:"serverPath"`
	BindingEpoch  string                  `json:"bindingEpoch"`
	Local         syncGitRecoveryEndpoint `json:"local"`
	Remote        syncGitRecoveryEndpoint `json:"remote"`
	LocalAllowed  bool                    `json:"localAllowed"`
	LocalReason   string                  `json:"localReason"`
	RemoteAllowed bool                    `json:"remoteAllowed"`
	RemoteReason  string                  `json:"remoteReason"`
}

// One short-lived preview per project, bound to the connection, exact Git states
// and metadata fingerprints. The token authorizes neither a reset nor a checkout.
type syncGitRecoveryConsent struct {
	view    syncGitRecoveryView
	plan    *syncGitPlan
	lease   string
	session string
	expires time.Time
}

var syncGitRecoveryPreviews sync.Map

func syncGitNeedsRecovery(err error) bool {
	var direction *syncGitDirectionError
	return errors.As(err, &direction) || errors.Is(err, errSyncGitRecoveryStale)
}

func syncGitRecoveryFailure(err error) map[string]any {
	code := "GIT_RECOVERY_FAILED"
	if errors.Is(err, errSyncGitRecoveryStale) {
		code = "GIT_RECOVERY_STALE"
	}
	return map[string]any{"ok": false, "error": err.Error(), "code": code}
}

func syncGitRecoveryInitial(r *syncGitCheckpoint) bool {
	return r != nil && r.State.Head == "" && r.Pending == nil
}

func syncGitRecoveryCheckpointEqual(a, b *syncGitCheckpoint) bool {
	return syncGitRecoveryInitial(a) && syncGitRecoveryInitial(b) && a.Version == b.Version &&
		a.Root == b.Root && a.LocalPath == b.LocalPath && a.Epoch == b.Epoch && a.State == b.State
}

func syncGitRecoveryLease(ctx context.Context, m *Mapping) (string, error) {
	result, err := remoteLeaseContext(ctx, m, "read", "", "")
	if err != nil {
		return "", err
	}
	lease, _ := result["lease"].(map[string]any)
	if lease != nil && (lease["epoch"] != m.BindingEpoch || lease["owner"] != "sync-needed") {
		return "", fmt.Errorf("项目租约仍由任务占用或不属于当前绑定，请先完成任务交还")
	}
	data, err := json.Marshal(lease)
	return string(data), err
}

func syncGitRecoveryEndpointView(ctx context.Context, m *Mapping, state syncGitState) (syncGitRecoveryEndpoint, error) {
	tree, err := gitOutputContext(ctx, m.LocalPath, "rev-parse", state.Head+"^{tree}")
	if err != nil {
		return syncGitRecoveryEndpoint{}, err
	}
	operations, err := decodeGitOperations(state.Operations)
	if err != nil {
		return syncGitRecoveryEndpoint{}, err
	}
	names := []string{}
	for name := range operations {
		if name == "CHERRY_PICK_HEAD" || name == "REVERT_HEAD" || name == "MERGE_HEAD" ||
			name == "rebase-merge" || name == "rebase-apply" || name == "sequencer" {
			names = append(names, name)
		}
	}
	sort.Strings(names)
	return syncGitRecoveryEndpoint{Branch: strings.TrimPrefix(state.Branch, "refs/heads/"), Head: state.Head,
		Staged: state.Index != tree, Operation: strings.Join(names, ", ")}, nil
}

// GetProjectGitRecovery reads metadata and preflights both possible sources. It
// never starts a file synchronization or applies Git metadata to either endpoint.
func (FrontendBridge) GetProjectGitRecovery(serverPath, bindingEpoch string) map[string]any {
	ctx, cancel, err := bindWorkspaceSyncConnection(context.Background())
	if err != nil {
		return syncGitRecoveryFailure(err)
	}
	defer cancel()
	ctx, stop := context.WithTimeout(ctx, 2*time.Minute)
	defer stop()
	ctx = context.WithValue(ctx, syncGitPreviewKey{}, true)
	ctx = context.WithValue(ctx, syncSessionIdentityKey{}, &syncSessionIdentity{})
	unlock, err := lockWorkspace(ctx, serverPath)
	if err != nil {
		return syncGitRecoveryFailure(err)
	}
	defer unlock()
	m := store.findMappingByServer(serverPath)
	if bindingEpoch == "" || m == nil || m.BindingEpoch != bindingEpoch || m.ServerID != serverIdentity(workspaceSyncConfig(ctx)) {
		return syncGitRecoveryFailure(errSyncGitRecoveryStale)
	}
	if err = mappingTaskBusy(m, false); err != nil {
		return syncGitRecoveryFailure(err)
	}
	if m.SyncName == "" {
		return syncGitRecoveryFailure(fmt.Errorf("同步会话尚未初始化，请先使用普通同步"))
	}
	session, err := syncGitRecoverySession(ctx, m)
	if err != nil {
		return syncGitRecoveryFailure(err)
	}
	ctx, discardObjects, err := syncGitPreviewObjectsContext(ctx, m)
	if err != nil {
		return syncGitRecoveryFailure(err)
	}
	defer discardObjects()
	checkpoint, err := loadGitCheckpoint(m)
	if err != nil {
		return syncGitRecoveryFailure(err)
	}
	if !syncGitRecoveryInitial(checkpoint) {
		return syncGitRecoveryFailure(fmt.Errorf("已有 Git 同步基线或未完成的精确恢复记录，请使用普通同步继续"))
	}
	p := &syncGitPlan{mapping: *m, key: syncGitObservationKey(ctx, m), checkpoint: checkpoint, git: true}
	if err = p.readStable(ctx, m); err != nil {
		return syncGitRecoveryFailure(err)
	}
	if err = fetchSyncGitHead(ctx, m, p.local, p.remote); err != nil {
		return syncGitRecoveryFailure(err)
	}
	_, err = selectGitState(ctx, m, checkpoint, p.local, p.remote)
	var direction *syncGitDirectionError
	if !errors.As(err, &direction) {
		if err == nil {
			err = fmt.Errorf("当前 Git 方向已可确定，请使用普通同步继续")
		}
		return syncGitRecoveryFailure(err)
	}
	local, err := syncGitRecoveryEndpointView(ctx, m, p.local)
	if err != nil {
		return syncGitRecoveryFailure(err)
	}
	remote, err := syncGitRecoveryEndpointView(ctx, m, p.remote)
	if err != nil {
		return syncGitRecoveryFailure(err)
	}
	view := syncGitRecoveryView{Token: randHex(24), ServerPath: m.ServerPath, BindingEpoch: m.BindingEpoch, Local: local, Remote: remote}
	for _, source := range []string{"local", "remote"} {
		choice := context.WithValue(ctx, syncGitSourceKey{}, source)
		desired, choiceErr := selectGitState(choice, m, checkpoint, p.local, p.remote)
		if choiceErr == nil {
			choiceErr = preflightSyncGitState(choice, m, p.local, p.remote, desired)
		}
		allowed, reason := choiceErr == nil, ""
		if choiceErr != nil {
			reason = choiceErr.Error()
		}
		if source == "local" {
			view.LocalAllowed, view.LocalReason = allowed, reason
		} else {
			view.RemoteAllowed, view.RemoteReason = allowed, reason
		}
	}
	lease, err := syncGitRecoveryLease(ctx, m)
	if err != nil {
		return syncGitRecoveryFailure(err)
	}
	current, err := loadGitCheckpoint(m)
	if err != nil {
		return syncGitRecoveryFailure(err)
	}
	if !syncGitRecoveryCheckpointEqual(checkpoint, current) {
		return syncGitRecoveryFailure(errSyncGitRecoveryStale)
	}
	if err = p.verify(ctx, m); err != nil {
		return syncGitRecoveryFailure(fmt.Errorf("%w: %v", errSyncGitRecoveryStale, err))
	}
	if current, sessionErr := syncGitRecoverySession(ctx, m); sessionErr != nil || current != session {
		return syncGitRecoveryFailure(errSyncGitRecoveryStale)
	}
	consent := &syncGitRecoveryConsent{view: view, plan: p, lease: lease, session: session, expires: time.Now().Add(10 * time.Minute)}
	syncGitRecoveryPreviews.Store(serverPath, consent)
	return map[string]any{"ok": true, "recovery": view}
}

func (FrontendBridge) RecoverProjectGit(serverPath, bindingEpoch, token, source string) map[string]any {
	if source != "local" && source != "remote" {
		return map[string]any{"ok": false, "error": "请选择有效的 Git 状态来源", "code": "INVALID_REQUEST"}
	}
	value, ok := syncGitRecoveryPreviews.Load(serverPath)
	if !ok {
		return syncGitRecoveryFailure(errSyncGitRecoveryStale)
	}
	consent := value.(*syncGitRecoveryConsent)
	if token == "" || token != consent.view.Token || bindingEpoch == "" || bindingEpoch != consent.view.BindingEpoch || time.Now().After(consent.expires) {
		return syncGitRecoveryFailure(errSyncGitRecoveryStale)
	}
	if (source == "local" && !consent.view.LocalAllowed) || (source == "remote" && !consent.view.RemoteAllowed) {
		return syncGitRecoveryFailure(fmt.Errorf("所选方向未通过接收端安全检查，请核对两端 Git 状态"))
	}
	ctx := context.WithValue(context.Background(), syncGitRecoveryKey{}, consent)
	ctx = context.WithValue(ctx, syncGitSourceKey{}, source)
	result := syncProjectWithEmptyConfirmationContext(ctx, serverPath, "")
	if result["ok"] != true && result["code"] != "GIT_RECOVERY_STALE" {
		if current, ok := syncGitRecoveryPreviews.Load(serverPath); !ok || current != consent {
			// A failed request may already have persisted its exact Pending plan.
			// Refresh status instead of offering to reuse the consumed preview.
			result["code"] = "GIT_RECOVERY_RETRY"
		}
	}
	return result
}

// Called under the workspace mutex before pausing a session or changing a lease.
// Confirmation is single use; later preflight still revalidates both endpoints.
func validateSyncGitRecovery(ctx context.Context, m *Mapping, consent *syncGitRecoveryConsent) error {
	if time.Now().After(consent.expires) || consent.plan.mapping != *m || consent.plan.key != syncGitObservationKey(ctx, m) {
		return errSyncGitRecoveryStale
	}
	current, err := loadGitCheckpoint(m)
	if err != nil {
		return err
	}
	if !syncGitRecoveryCheckpointEqual(consent.plan.checkpoint, current) {
		return errSyncGitRecoveryStale
	}
	lease, err := syncGitRecoveryLease(ctx, m)
	if err != nil {
		return err
	}
	if lease != consent.lease {
		return errSyncGitRecoveryStale
	}
	preview := context.WithValue(ctx, syncGitPreviewKey{}, true)
	if err = consent.plan.verify(preview, m); err != nil {
		return fmt.Errorf("%w: %v", errSyncGitRecoveryStale, err)
	}
	session, err := syncGitRecoverySession(ctx, m)
	if err != nil {
		return err
	}
	if consent.session == "" || session != consent.session {
		return errSyncGitRecoveryStale
	}
	if !syncGitRecoveryPreviews.CompareAndDelete(m.ServerPath, consent) {
		return errSyncGitRecoveryStale
	}
	return nil
}

func verifySyncGitRecoveryPlan(ctx context.Context, p *syncGitPlan) error {
	consent, _ := ctx.Value(syncGitRecoveryKey{}).(*syncGitRecoveryConsent)
	if consent == nil {
		return nil
	}
	previous := consent.plan
	if p.mapping != previous.mapping || p.key != previous.key || !syncGitRecoveryCheckpointEqual(p.checkpoint, previous.checkpoint) ||
		p.local != previous.local || p.remote != previous.remote ||
		(previous.localFingerprint != "" && p.localFingerprint != previous.localFingerprint) ||
		(previous.remoteFingerprint != "" && p.remoteFingerprint != previous.remoteFingerprint) {
		return errSyncGitRecoveryStale
	}
	return nil
}

// Save the exact chosen transition before the first file flush. If transfer is
// interrupted, lease cleanup and application restart cannot discard the choice.
// Existing legacy Pending records keep their original comparison semantics.
func (p *syncGitPlan) persistRecoveryIntent(ctx context.Context, m *Mapping) error {
	if consent, _ := ctx.Value(syncGitRecoveryKey{}).(*syncGitRecoveryConsent); consent == nil {
		return nil
	}
	if err := p.verify(ctx, m); err != nil {
		return err
	}
	if err := verifySyncGitRecoveryPlan(ctx, p); err != nil {
		return err
	}
	checkpoint := *p.checkpoint
	checkpoint.Version = 2
	checkpoint.Pending = &syncGitPending{Local: p.local, Remote: p.remote, Desired: p.desired}
	if err := saveGitCheckpoint(m, &checkpoint); err != nil {
		return err
	}
	p.checkpoint = &checkpoint
	return nil
}
