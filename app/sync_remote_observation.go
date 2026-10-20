package main

import (
	"bufio"
	"bytes"
	"compress/zlib"
	"context"
	_ "embed"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os/exec"
	"sync"
	"sync/atomic"
	"time"
)

//go:embed resources/sync_observe.py
var syncObserveWorker string

// Tokens are evidence for reusing a completed full read, not Git state itself.
// An observation error must always take the caller's existing full-reader path.
type syncMetadataObservation struct {
	Git        string `json:"git"`
	Ignore     string `json:"ignore"`
	Repository bool   `json:"repository"`
}

const (
	syncRemoteObservationTimeout = 25 * time.Second
	syncRemoteObservationIdle    = 90 * time.Second
	syncRemoteObservationLimit   = 1024 * 1024
	syncRemoteObservationMax     = 32
)

type syncRemoteObservationKey struct {
	mapping    Mapping
	connection *serverConnection
	transport  *Tunnel
	account    string
	keyPath    string
	recovery   bool
}

var syncRemoteObservationPool = struct {
	sync.Mutex
	observers map[syncRemoteObservationKey]*syncRemoteObserver
}{observers: make(map[syncRemoteObservationKey]*syncRemoteObserver)}

// The lifetime belongs to the account connection, never to a flush/request ctx.
// The channel is a context-aware requests mutex: cancellation while waiting for
// another request does not need to wait for that request's network timeout.
type syncRemoteObserver struct {
	requests chan struct{}
	input    io.WriteCloser
	output   io.ReadCloser
	reader   *bufio.Reader
	command  *exec.Cmd
	cancel   context.CancelFunc
	done     chan struct{}
	closed   atomic.Bool
	lastUsed atomic.Int64
	closeOne sync.Once
	idleMu   sync.Mutex
	idle     *time.Timer
}

// observeRemoteSyncMetadata reuses one read-only SSH/Python process for the exact
// mapping and workspace account connection. It never acquires/removes Git locks.
func observeRemoteSyncMetadata(ctx context.Context, m *Mapping) (syncMetadataObservation, error) {
	if err := workspaceSyncCurrent(ctx); err != nil {
		return syncMetadataObservation{}, err
	}
	if m == nil || m.LocalPath == "" || m.ServerPath == "" || m.BindingEpoch == "" {
		return syncMetadataObservation{}, fmt.Errorf("远端元数据观察缺少完整工作区绑定")
	}
	transport, err := workspaceSyncTunnel(ctx, m)
	if err != nil {
		return syncMetadataObservation{}, err
	}
	serverConnectionMu.RLock()
	snapshot, _ := ctx.Value(workspaceSyncConnectionKey{}).(*workspaceSyncConnection)
	if snapshot == nil {
		snapshot = &workspaceSyncConnection{connection: apiConnection, tunnel: tunnel, cfg: store.config(), keyPath: store.keyPathOf()}
	}
	if !snapshot.currentLocked() || snapshot.tunnel != transport {
		serverConnectionMu.RUnlock()
		return syncMetadataObservation{}, fmt.Errorf("远端元数据观察账号或连接已改变")
	}
	key := syncRemoteObservationKey{mapping: *m, connection: snapshot.connection, transport: transport,
		account: snapshot.connection.accountIdentity + "\x00" + snapshot.cfg.WorkspaceAccount,
		keyPath: snapshot.keyPath, recovery: snapshot.connection.workspaceRecoveryOnly}
	lifetime := snapshot.connection.ctx
	serverConnectionMu.RUnlock()
	// Preserve the captured connection check even for an unbound caller.
	ctx = context.WithValue(ctx, workspaceSyncConnectionKey{}, snapshot)
	observer, err := remoteSyncObserverFor(key, lifetime)
	if err != nil {
		if ctx.Err() != nil {
			return syncMetadataObservation{}, ctx.Err()
		}
		return syncMetadataObservation{}, err
	}
	observation, err := observer.observe(ctx)
	if currentErr := workspaceSyncCurrent(ctx); currentErr != nil {
		observer.close()
		return syncMetadataObservation{}, currentErr
	}
	if err != nil {
		return syncMetadataObservation{}, err
	}
	return observation, nil
}

func remoteSyncObserverFor(key syncRemoteObservationKey, lifetime context.Context) (*syncRemoteObserver, error) {
	syncRemoteObservationPool.Lock()
	var retired []*syncRemoteObserver
	for oldKey, observer := range syncRemoteObservationPool.observers {
		replaced := oldKey != key && (oldKey.connection != key.connection || oldKey.transport != key.transport ||
			oldKey.mapping.LocalPath == key.mapping.LocalPath || oldKey.mapping.BindingEpoch == key.mapping.BindingEpoch)
		if observer.closed.Load() || replaced {
			delete(syncRemoteObservationPool.observers, oldKey)
			retired = append(retired, observer)
		}
	}
	if observer := syncRemoteObservationPool.observers[key]; observer != nil {
		syncRemoteObservationPool.Unlock()
		for _, old := range retired {
			old.close()
		}
		return observer, nil
	}
	// Bound idle mappings even if a client opens many workspaces in one account.
	if len(syncRemoteObservationPool.observers) >= syncRemoteObservationMax {
		var oldestKey syncRemoteObservationKey
		var oldest *syncRemoteObserver
		for candidateKey, candidate := range syncRemoteObservationPool.observers {
			if oldest == nil || candidate.lastUsed.Load() < oldest.lastUsed.Load() {
				oldestKey, oldest = candidateKey, candidate
			}
		}
		delete(syncRemoteObservationPool.observers, oldestKey)
		retired = append(retired, oldest)
	}
	remote, err := syncRemoteObserverCommand(key.mapping.ServerPath)
	var observer *syncRemoteObserver
	if err == nil {
		observer, err = newSyncRemoteObserver(lifetime, func(processCtx context.Context) *exec.Cmd {
			return hideCommandWindow(exec.CommandContext(processCtx, sshExe(), append(key.transport.baseArgs(), remote)...))
		})
	}
	if err == nil {
		syncRemoteObservationPool.observers[key] = observer
	}
	syncRemoteObservationPool.Unlock()
	for _, old := range retired {
		old.close()
	}
	if err != nil {
		return nil, err
	}
	go func() {
		<-observer.done
		syncRemoteObservationPool.Lock()
		if syncRemoteObservationPool.observers[key] == observer {
			delete(syncRemoteObservationPool.observers, key)
		}
		syncRemoteObservationPool.Unlock()
	}()
	return observer, nil
}

func syncRemoteObserverCommand(root string) (string, error) {
	// Compress only the embedded program, preserving stdin for repeated JSON
	// requests and staying below Windows' SSH command-line length limit.
	var compressed bytes.Buffer
	writer := zlib.NewWriter(&compressed)
	if _, err := writer.Write([]byte(syncObserveWorker)); err != nil {
		return "", err
	}
	if err := writer.Close(); err != nil {
		return "", err
	}
	bootstrap := "import base64,zlib;exec(compile(zlib.decompress(base64.b64decode('" +
		base64.StdEncoding.EncodeToString(compressed.Bytes()) + "')),'<sync-observe>','exec'))"
	return "setpriv --reuid=1000 --regid=1000 --clear-groups env HOME=/nonexistent python3 -B -u -c " + shellQuote(bootstrap) + " " + shellQuote(root), nil
}

func newSyncRemoteObserver(lifetime context.Context, command func(context.Context) *exec.Cmd) (*syncRemoteObserver, error) {
	if err := lifetime.Err(); err != nil {
		return nil, err
	}
	processCtx, cancel := context.WithCancel(lifetime)
	cmd := command(processCtx)
	cmd.WaitDelay = time.Second
	cmd.Stderr = io.Discard // Diagnostics must not expose account paths or credentials.
	input, err := cmd.StdinPipe()
	if err != nil {
		cancel()
		return nil, fmt.Errorf("远端元数据观察输入管道不可用: %w", err)
	}
	output, err := cmd.StdoutPipe()
	if err != nil {
		input.Close()
		cancel()
		return nil, fmt.Errorf("远端元数据观察输出管道不可用: %w", err)
	}
	observer := &syncRemoteObserver{requests: make(chan struct{}, 1), input: input, output: output,
		reader: bufio.NewReaderSize(output, 4096), command: cmd, cancel: cancel, done: make(chan struct{})}
	if err := cmd.Start(); err != nil {
		input.Close()
		output.Close()
		cancel()
		return nil, fmt.Errorf("远端元数据观察进程未启动: %w", err)
	}
	observer.lastUsed.Store(time.Now().UnixNano())
	observer.armIdle()
	go func() {
		_ = cmd.Wait()
		observer.close()
		close(observer.done)
	}()
	return observer, nil
}

func (observer *syncRemoteObserver) close() {
	observer.closeOne.Do(func() {
		observer.closed.Store(true)
		observer.idleMu.Lock()
		if observer.idle != nil {
			observer.idle.Stop()
		}
		observer.idleMu.Unlock()
		observer.cancel()
		_ = observer.input.Close()
		_ = observer.output.Close()
		if observer.command.Process != nil {
			_ = observer.command.Process.Kill()
		}
	})
}

func (observer *syncRemoteObserver) armIdle() {
	observer.idleMu.Lock()
	defer observer.idleMu.Unlock()
	if !observer.closed.Load() {
		if observer.idle == nil {
			observer.idle = time.AfterFunc(syncRemoteObservationIdle, observer.close)
		} else {
			observer.idle.Reset(syncRemoteObservationIdle)
		}
	}
}

func (observer *syncRemoteObserver) observe(ctx context.Context) (syncMetadataObservation, error) {
	queryCtx, cancel := context.WithTimeout(ctx, syncRemoteObservationTimeout)
	defer cancel()
	select {
	case observer.requests <- struct{}{}:
	case <-queryCtx.Done():
		return syncMetadataObservation{}, queryCtx.Err()
	case <-observer.done:
		return syncMetadataObservation{}, fmt.Errorf("远端元数据观察进程已关闭")
	}
	defer func() { <-observer.requests }()
	if err := ctx.Err(); err != nil {
		return syncMetadataObservation{}, err
	}
	if observer.closed.Load() {
		return syncMetadataObservation{}, fmt.Errorf("远端元数据观察进程已关闭")
	}
	observer.idleMu.Lock()
	if observer.idle != nil {
		observer.idle.Stop()
	}
	observer.idleMu.Unlock()
	defer observer.armIdle()
	observer.lastUsed.Store(time.Now().UnixNano())
	stopCancellation := context.AfterFunc(queryCtx, observer.close)
	defer stopCancellation()
	fail := func(err error) (syncMetadataObservation, error) {
		observer.close()
		if ctx.Err() != nil {
			return syncMetadataObservation{}, ctx.Err()
		}
		if queryCtx.Err() != nil {
			return syncMetadataObservation{}, queryCtx.Err()
		}
		return syncMetadataObservation{}, err
	}
	if _, err := io.WriteString(observer.input, "{}\n"); err != nil {
		return fail(fmt.Errorf("远端元数据观察请求未完成: %w", err))
	}
	line, err := readSyncRemoteObservationLine(observer.reader)
	if err != nil {
		return fail(err)
	}
	var response struct {
		Git        string `json:"git"`
		Ignore     string `json:"ignore"`
		Repository *bool  `json:"repository"`
		Error      string `json:"error"`
	}
	if err := json.Unmarshal(line, &response); err != nil {
		return fail(fmt.Errorf("远端元数据观察响应无效"))
	}
	if response.Error != "" {
		return fail(fmt.Errorf("远端元数据观察需要完整读取: %s", response.Error))
	}
	git, gitErr := hex.DecodeString(response.Git)
	ignore, ignoreErr := hex.DecodeString(response.Ignore)
	if response.Repository == nil || gitErr != nil || ignoreErr != nil || len(git) != 32 || len(ignore) != 32 {
		return fail(fmt.Errorf("远端元数据观察证据不完整"))
	}
	if queryCtx.Err() != nil {
		return fail(queryCtx.Err())
	}
	return syncMetadataObservation{Git: response.Git, Ignore: response.Ignore, Repository: *response.Repository}, nil
}

func readSyncRemoteObservationLine(reader *bufio.Reader) ([]byte, error) {
	var line []byte
	for {
		fragment, err := reader.ReadSlice('\n')
		if len(line)+len(fragment) > syncRemoteObservationLimit {
			return nil, fmt.Errorf("远端元数据观察响应超过大小限制")
		}
		line = append(line, fragment...)
		if errors.Is(err, bufio.ErrBufferFull) {
			continue
		}
		if err != nil {
			return nil, fmt.Errorf("远端元数据观察响应未完成: %w", err)
		}
		return line, nil
	}
}
