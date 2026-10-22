package main

import (
	"bufio"
	"bytes"
	"compress/zlib"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"os/exec"
	"sync"
	"sync/atomic"
	"time"
)

const (
	syncRemoteLeaseIdle          = 90 * time.Second
	syncRemoteLeaseRequestLimit  = 64 * 1024
	syncRemoteLeaseResponseLimit = 1024 * 1024
	syncRemoteLeaseMax           = 32
)

// The key contains immutable authority, not mutable mapping mode/session fields.
// A renamed/rebound workspace or replaced account cannot borrow an old process.
type syncRemoteLeaseKey struct {
	connection *serverConnection
	transport  *Tunnel
	serverID   string
	account    string
	keyPath    string
	root       string
	epoch      string
	recovery   bool
}

var syncRemoteLeasePool = struct {
	sync.Mutex
	workers map[syncRemoteLeaseKey]*syncRemoteLease
}{workers: make(map[syncRemoteLeaseKey]*syncRemoteLease)}

type syncRemoteLease struct {
	requests      chan struct{}
	input         io.WriteCloser
	output        io.ReadCloser
	reader        *bufio.Reader
	command       *exec.Cmd
	cancel        context.CancelFunc
	done          chan struct{}
	closed        atomic.Bool
	lastUsed      atomic.Int64
	closeOne      sync.Once
	idleMu        sync.Mutex
	idle          *time.Timer
	nonce         string
	sequence      uint64 // Only touched while holding requests.
	serverClockMS int64
	clockReceived time.Time
}

func executePersistentRemoteLease(ctx context.Context, m *Mapping, request map[string]any) (map[string]any, error) {
	if err := workspaceSyncCurrent(ctx); err != nil {
		return nil, err
	}
	if m == nil || m.ServerPath == "" || m.BindingEpoch == "" {
		return nil, fmt.Errorf("工作区租约缺少完整绑定")
	}
	serverConnectionMu.RLock()
	snapshot, _ := ctx.Value(workspaceSyncConnectionKey{}).(*workspaceSyncConnection)
	if snapshot == nil {
		snapshot = &workspaceSyncConnection{connection: apiConnection, tunnel: tunnel, cfg: store.config(), keyPath: store.keyPathOf()}
	}
	if !snapshot.currentLocked() || m.ServerID != serverIdentity(snapshot.cfg) {
		serverConnectionMu.RUnlock()
		return nil, fmt.Errorf("工作区租约账号或连接已改变")
	}
	key := syncRemoteLeaseKey{connection: snapshot.connection, transport: snapshot.tunnel,
		serverID: m.ServerID, account: snapshot.connection.accountIdentity + "\x00" + snapshot.cfg.WorkspaceAccount,
		keyPath: snapshot.keyPath, root: m.ServerPath, epoch: m.BindingEpoch, recovery: snapshot.connection.workspaceRecoveryOnly}
	lifetime := snapshot.connection.ctx
	serverConnectionMu.RUnlock()
	ctx = context.WithValue(ctx, workspaceSyncConnectionKey{}, snapshot)
	worker, err := remoteSyncLeaseFor(key, lifetime)
	if err != nil {
		return nil, err
	}
	started := time.Now()
	result, err := worker.request(ctx, request)
	// A completed response from a retired account is never accepted. If its
	// mutation ran, normal exact-owner recovery must discover that state.
	if currentErr := workspaceSyncCurrent(ctx); currentErr != nil {
		worker.close()
		err = currentErr
	}
	op, _ := request["op"].(string)
	log.Printf("[sync-lease] op=%s elapsed=%s transport=persistent ok=%t", op, time.Since(started), err == nil && result["ok"] == true)
	return result, err
}

func remoteSyncLeaseFor(key syncRemoteLeaseKey, lifetime context.Context) (*syncRemoteLease, error) {
	if err := lifetime.Err(); err != nil {
		return nil, err
	}
	syncRemoteLeasePool.Lock()
	var retired []*syncRemoteLease
	for oldKey, worker := range syncRemoteLeasePool.workers {
		if worker.closed.Load() || (oldKey != key && (oldKey.connection != key.connection || oldKey.transport != key.transport || oldKey.root == key.root || oldKey.epoch == key.epoch)) {
			delete(syncRemoteLeasePool.workers, oldKey)
			retired = append(retired, worker)
		}
	}
	if worker := syncRemoteLeasePool.workers[key]; worker != nil {
		syncRemoteLeasePool.Unlock()
		for _, old := range retired {
			old.close()
		}
		return worker, nil
	}
	if len(syncRemoteLeasePool.workers) >= syncRemoteLeaseMax {
		var oldestKey syncRemoteLeaseKey
		var oldest *syncRemoteLease
		for candidate, worker := range syncRemoteLeasePool.workers {
			if oldest == nil || worker.lastUsed.Load() < oldest.lastUsed.Load() {
				oldestKey, oldest = candidate, worker
			}
		}
		delete(syncRemoteLeasePool.workers, oldestKey)
		retired = append(retired, oldest)
	}
	nonce := randHex(24)
	remote, err := syncRemoteLeaseCommand(key.root, key.epoch, nonce)
	var worker *syncRemoteLease
	if err == nil {
		worker, err = newSyncRemoteLease(lifetime, nonce, func(processCtx context.Context) *exec.Cmd {
			return hideCommandWindow(exec.CommandContext(processCtx, sshExe(), append(key.transport.baseArgs(), remote)...))
		})
	}
	if err == nil {
		syncRemoteLeasePool.workers[key] = worker
	}
	syncRemoteLeasePool.Unlock()
	for _, old := range retired {
		old.close()
	}
	return worker, err
}

func syncRemoteLeaseCommand(root, epoch, nonce string) (string, error) {
	var compressed bytes.Buffer
	writer := zlib.NewWriter(&compressed)
	if _, err := writer.Write([]byte(leaseWorker)); err != nil {
		return "", err
	}
	if err := writer.Close(); err != nil {
		return "", err
	}
	bootstrap := "import base64,zlib;ns={'__name__':'chisa_lease_transport'};exec(compile(zlib.decompress(base64.b64decode('" +
		base64.StdEncoding.EncodeToString(compressed.Bytes()) + "')),'<sync-lease>','exec'),ns);ns['serve'](__import__('sys').argv[1],__import__('sys').argv[2],__import__('sys').argv[3])"
	// This separate worker retains the existing SSH lease authority. The
	// UID1000 read-only Git observer is deliberately not reused or upgraded.
	return "python3 -B -u -c " + shellQuote(bootstrap) + " " + shellQuote(root) + " " + shellQuote(epoch) + " " + shellQuote(nonce), nil
}

func newSyncRemoteLease(lifetime context.Context, nonce string, command func(context.Context) *exec.Cmd) (*syncRemoteLease, error) {
	if err := lifetime.Err(); err != nil {
		return nil, err
	}
	processCtx, cancel := context.WithCancel(lifetime)
	cmd := command(processCtx)
	cmd.WaitDelay = time.Second
	cmd.Stderr = io.Discard
	input, err := cmd.StdinPipe()
	if err != nil {
		cancel()
		return nil, err
	}
	output, err := cmd.StdoutPipe()
	if err != nil {
		input.Close()
		cancel()
		return nil, err
	}
	worker := &syncRemoteLease{requests: make(chan struct{}, 1), input: input, output: output,
		reader: bufio.NewReaderSize(output, 4096), command: cmd, cancel: cancel, done: make(chan struct{}), nonce: nonce}
	if err := cmd.Start(); err != nil {
		input.Close()
		output.Close()
		cancel()
		return nil, err
	}
	worker.lastUsed.Store(time.Now().UnixNano())
	worker.armIdle()
	go func() { _ = cmd.Wait(); worker.close(); close(worker.done) }()
	return worker, nil
}

func (worker *syncRemoteLease) close() {
	worker.closeOne.Do(func() {
		worker.closed.Store(true)
		worker.idleMu.Lock()
		if worker.idle != nil {
			worker.idle.Stop()
		}
		worker.idleMu.Unlock()
		worker.cancel()
		_ = worker.input.Close()
		_ = worker.output.Close()
		if worker.command.Process != nil {
			_ = worker.command.Process.Kill()
		}
	})
}

func (worker *syncRemoteLease) armIdle() {
	worker.idleMu.Lock()
	defer worker.idleMu.Unlock()
	if worker.closed.Load() {
		return
	}
	if worker.idle == nil {
		worker.idle = time.AfterFunc(syncRemoteLeaseIdle, worker.close)
	} else {
		worker.idle.Reset(syncRemoteLeaseIdle)
	}
}

func (worker *syncRemoteLease) request(parent context.Context, request map[string]any) (map[string]any, error) {
	ctx, cancel := context.WithTimeout(parent, 30*time.Second)
	defer cancel()
	select {
	case worker.requests <- struct{}{}:
	case <-ctx.Done():
		return nil, ctx.Err()
	case <-worker.done:
		return nil, fmt.Errorf("工作区租约通道已关闭，请重新确认工作区状态")
	}
	defer func() { <-worker.requests }()
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if worker.closed.Load() {
		return nil, fmt.Errorf("工作区租约通道已关闭，请重新确认工作区状态")
	}
	worker.idleMu.Lock()
	if worker.idle != nil {
		worker.idle.Stop()
	}
	worker.idleMu.Unlock()
	defer worker.armIdle()
	worker.lastUsed.Store(time.Now().UnixNano())
	stopCancellation := context.AfterFunc(ctx, worker.close)
	defer stopCancellation()
	fail := func(err error) (map[string]any, error) {
		worker.close()
		if ctx.Err() != nil {
			err = ctx.Err()
		}
		return nil, fmt.Errorf("工作区租约响应未确认，请保留工作区并重新确认状态: %w", err)
	}
	if worker.sequence == 0 {
		// Do not enqueue a mutation while SSH is still authenticating. The
		// hello proves the worker's root/epoch validation completed first.
		line, err := readSyncRemoteLeaseLine(worker.reader)
		if err != nil {
			return fail(err)
		}
		var hello struct {
			Version int    `json:"version"`
			Nonce   string `json:"nonce"`
			Seq     uint64 `json:"seq"`
			Ready   bool   `json:"ready"`
			ClockMS int64  `json:"clockMs"`
		}
		if err := json.Unmarshal(line, &hello); err != nil || hello.Version != 1 || hello.Nonce != worker.nonce || hello.Seq != 0 || !hello.Ready || hello.ClockMS <= 0 {
			return fail(fmt.Errorf("工作区租约通道握手无效"))
		}
		worker.serverClockMS, worker.clockReceived = hello.ClockMS, time.Now()
	}
	deadline, _ := ctx.Deadline()
	remaining := time.Until(deadline)
	if remaining <= time.Millisecond {
		return fail(context.DeadlineExceeded)
	}
	// Reserve a small response budget; the server's lock wait cannot consume
	// the entire client deadline and execute after the caller has given up.
	budget := remaining - time.Second
	if budget <= 0 {
		budget = remaining / 2
	}
	worker.sequence++
	frame := struct {
		Version    int            `json:"version"`
		Nonce      string         `json:"nonce"`
		Seq        uint64         `json:"seq"`
		Request    map[string]any `json:"request"`
		DeadlineMS int64          `json:"deadlineMs"`
	}{1, worker.nonce, worker.sequence, request, worker.serverClockMS + time.Since(worker.clockReceived).Milliseconds() + budget.Milliseconds()}
	encoded, err := json.Marshal(frame)
	if err != nil || len(encoded) > syncRemoteLeaseRequestLimit {
		return fail(fmt.Errorf("工作区租约请求无效或超过大小限制"))
	}
	if err := ctx.Err(); err != nil {
		return fail(err)
	}
	// Exactly one write attempt. A partial write, EOF or canceled reply has
	// an unknown outcome; neither this method nor its caller replays it.
	encoded = append(encoded, '\n')
	if count, err := worker.input.Write(encoded); err != nil {
		return fail(err)
	} else if count != len(encoded) {
		return fail(io.ErrShortWrite)
	}
	line, err := readSyncRemoteLeaseLine(worker.reader)
	if err != nil {
		return fail(err)
	}
	var response struct {
		Version int            `json:"version"`
		Nonce   string         `json:"nonce"`
		Seq     uint64         `json:"seq"`
		Result  map[string]any `json:"result"`
		ClockMS int64          `json:"clockMs"`
	}
	if err := json.Unmarshal(line, &response); err != nil || response.Version != 1 || response.Nonce != worker.nonce || response.Seq != worker.sequence || response.Result == nil || response.ClockMS < worker.serverClockMS {
		return fail(fmt.Errorf("工作区租约响应序列或绑定无效"))
	}
	if _, valid := response.Result["ok"].(bool); !valid {
		return fail(fmt.Errorf("工作区租约响应证据不完整"))
	}
	if err := ctx.Err(); err != nil {
		return fail(err)
	}
	worker.serverClockMS, worker.clockReceived = response.ClockMS, time.Now()
	return response.Result, nil
}

func readSyncRemoteLeaseLine(reader *bufio.Reader) ([]byte, error) {
	var line []byte
	for {
		fragment, err := reader.ReadSlice('\n')
		if len(line)+len(fragment) > syncRemoteLeaseResponseLimit {
			return nil, fmt.Errorf("工作区租约响应超过大小限制")
		}
		line = append(line, fragment...)
		if errors.Is(err, bufio.ErrBufferFull) {
			continue
		}
		if err != nil {
			return nil, fmt.Errorf("工作区租约响应未完成: %w", err)
		}
		return line, nil
	}
}
