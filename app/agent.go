package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// localWorkspaceAgent serves the existing workspace helper over a loopback HTTP
// endpoint. The VPS reaches it through an app-owned reverse SSH tunnel, so the
// desktop does not need a Windows OpenSSH Server, a local service or admin rights.
type localWorkspaceAgent struct {
	listener          net.Listener
	server            *http.Server
	helperPath        string
	port              int
	token             string
	ctx               context.Context
	cancel            context.CancelFunc
	mu                sync.Mutex
	closing           bool
	jobs              sync.WaitGroup
	closed            chan struct{}
	slots             chan struct{}
	admissionWait     time.Duration
	waitingHelpers    int
	waitingBytes      int
	owner             func() (sshProcessOwner, error)
	receipts          *agentReceiptStore
	temporaryReceipts string
}

type agentEnvelope struct {
	Protocol             int             `json:"protocol"`
	RootPath             string          `json:"rootPath"`
	ExpectedRootIdentity string          `json:"expectedRootIdentity"`
	Generation           string          `json:"generation"`
	Request              json.RawMessage `json:"request"`
	OperationID          string          `json:"operationId,omitempty"`
}

func startLocalWorkspaceAgent(port int) (*localWorkspaceAgent, error) {
	helperPath, _, err := installSshWorkspaceHelper(dataDir(), sshWorkspaceHelper)
	if err != nil {
		return nil, err
	}
	return startLocalWorkspaceAgentWithReceipts(port, helperPath, filepath.Join(dataDir(), "agent-operation-receipts-v1"))
}

func startLocalWorkspaceAgentWithHelper(port int, helperPath string) (*localWorkspaceAgent, error) {
	directory, err := os.MkdirTemp("", "chisa-agent-receipts-")
	if err != nil {
		return nil, err
	}
	agent, err := startLocalWorkspaceAgentWithReceipts(port, helperPath, directory)
	if err != nil {
		_ = os.Remove(directory)
		return nil, err
	}
	agent.temporaryReceipts = directory
	return agent, nil
}

func startLocalWorkspaceAgentWithReceipts(port int, helperPath, receiptDirectory string) (*localWorkspaceAgent, error) {
	if port < 0 || port > 65535 {
		return nil, fmt.Errorf("agent port must be between 0 and 65535")
	}
	listener, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", port))
	if err != nil {
		return nil, err
	}
	tokenBytes := make([]byte, 32)
	if _, err := rand.Read(tokenBytes); err != nil {
		_ = listener.Close()
		return nil, err
	}
	receipts, err := newAgentReceiptStore(receiptDirectory)
	if err != nil {
		_ = listener.Close()
		return nil, err
	}
	ctx, cancel := context.WithCancel(context.Background())
	agent := &localWorkspaceAgent{
		listener: listener, helperPath: helperPath,
		port: listener.Addr().(*net.TCPAddr).Port, token: hex.EncodeToString(tokenBytes),
		ctx: ctx, cancel: cancel, closed: make(chan struct{}), slots: make(chan struct{}, 4), admissionWait: 15 * time.Second, owner: newSshProcessOwner, receipts: receipts,
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/health", agent.handleHealth)
	mux.HandleFunc("/v1/workspace", agent.handleWorkspace)
	agent.server = &http.Server{
		Handler:           mux,
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       15 * time.Second,
		IdleTimeout:       30 * time.Second,
		MaxHeaderBytes:    16 * 1024,
		BaseContext:       func(net.Listener) context.Context { return ctx },
	}
	go func() { _ = agent.server.Serve(listener) }()
	return agent, nil
}

func (agent *localWorkspaceAgent) Close() error {
	if agent == nil || agent.server == nil {
		return nil
	}
	agent.mu.Lock()
	if agent.closing {
		done := agent.closed
		agent.mu.Unlock()
		<-done
		return nil
	}
	agent.closing = true
	agent.cancel()
	agent.mu.Unlock()
	// Cancellation owns helper trees; Close forcibly releases sockets/listener
	// then waits for all admitted helpers to reap before permitting restart.
	err := agent.server.Close()
	agent.jobs.Wait()
	if agent.temporaryReceipts != "" {
		_ = os.RemoveAll(agent.temporaryReceipts)
	}
	close(agent.closed)
	return err
}

func (agent *localWorkspaceAgent) handleHealth(writer http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodGet {
		http.Error(writer, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	writeAgentJSON(writer, http.StatusOK, map[string]any{
		"ok": true, "platform": "win32", "agentVersion": "1.0.0",
	})
}

func (agent *localWorkspaceAgent) handleWorkspace(writer http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodPost {
		http.Error(writer, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if subtle.ConstantTimeCompare([]byte(request.Header.Get("X-Chisa-Agent-Token")), []byte(agent.token)) != 1 {
		writeAgentJSON(writer, http.StatusUnauthorized, agentError("AGENT_UNAUTHORIZED", "Workspace agent token is invalid"))
		return
	}
	agent.mu.Lock()
	if agent.closing {
		agent.mu.Unlock()
		writeAgentJSON(writer, 503, agentError("AGENT_BUSY", "Workspace agent is stopping"))
		return
	}
	agent.jobs.Add(1)
	agent.mu.Unlock()
	defer agent.jobs.Done()
	body, err := io.ReadAll(io.LimitReader(request.Body, 12*1024*1024+1))
	if err != nil || len(body) > 12*1024*1024 {
		writeAgentJSON(writer, http.StatusRequestEntityTooLarge, agentError("AGENT_REQUEST_TOO_LARGE", "Workspace request exceeds the allowed size"))
		return
	}
	var envelope agentEnvelope
	if err := json.Unmarshal(body, &envelope); err != nil || envelope.Protocol != 1 || envelope.RootPath == "" || len(envelope.Request) == 0 {
		writeAgentJSON(writer, http.StatusBadRequest, agentError("AGENT_REQUEST_INVALID", "Workspace request is invalid"))
		return
	}
	if !filepath.IsAbs(envelope.RootPath) || strings.ContainsRune(envelope.RootPath, '\x00') {
		writeAgentJSON(writer, http.StatusBadRequest, agentError("AGENT_ROOT_INVALID", "Workspace root must be an absolute path"))
		return
	}
	var operation struct {
		Op          string `json:"op"`
		OperationID string `json:"operationId"`
	}
	if json.Unmarshal(envelope.Request, &operation) != nil {
		writeAgentJSON(writer, http.StatusBadRequest, agentError("AGENT_REQUEST_INVALID", "Workspace request is invalid"))
		return
	}
	if operation.Op == "operation_status" || operation.Op == "operation_cancel" {
		agent.handleOperationReceipt(writer, request, envelope, operation.Op, operation.OperationID)
		return
	}
	ctx, cancel := context.WithCancel(request.Context())
	stop := context.AfterFunc(agent.ctx, cancel)
	defer stop()
	defer cancel()
	// Wait only before dispatching this accepted request. A burst of UI reads
	// must not fail immediately merely because four PowerShell helpers are busy.
	// Recovery controls retain their independent lane while regular work waits.
	control := operation.Op == "job_status" || operation.Op == "job_cancel"
	if !control {
		if !agent.acquireHelper(ctx, len(body)) {
			writeAgentJSON(writer, http.StatusServiceUnavailable, agentError("AGENT_BUSY", "Workspace helper admission timed out, was cancelled, or reached its bounded queue limit"))
			return
		}
		defer func() { <-agent.slots }()
	}
	if ctx.Err() != nil {
		writeAgentJSON(writer, http.StatusServiceUnavailable, agentError("AGENT_BUSY", "Workspace request was cancelled before helper dispatch"))
		return
	}
	if envelope.OperationID != "" {
		if !agentMutationOperation(operation.Op) || !agentOperationIDPattern.MatchString(envelope.OperationID) {
			writeAgentJSON(writer, http.StatusBadRequest, agentError("AGENT_REQUEST_INVALID", "Mutation operation id is invalid"))
			return
		}
		if err := agent.receipts.claim(envelope, cancel); err != nil {
			writeAgentJSON(writer, http.StatusConflict, agentError("AGENT_OPERATION_DUPLICATE", "Operation identity is already claimed or unavailable; recover its receipt before retrying"))
			return
		}
	}
	response, err := agent.runHelper(ctx, body)
	if envelope.OperationID != "" {
		var failure *agentHelperFailure
		confirmed := err == nil || errors.As(err, &failure) && failure.confirmed
		agent.receipts.finish(envelope, confirmed)
	}
	if err != nil {
		writeAgentJSON(writer, http.StatusBadGateway, agentError("AGENT_HELPER_UNAVAILABLE", "Windows workspace helper could not complete the request; recover before retrying a mutation"))
		return
	}
	writer.Header().Set("content-type", "application/json")
	writer.WriteHeader(http.StatusOK)
	_, _ = writer.Write(response)
}

// acquireHelper bounds waiting separately from active process ownership. It
// claims no operation ID and launches nothing: cancellation while queued is a
// safe predispatch refusal. The handler's jobs reservation includes this wait.
func (agent *localWorkspaceAgent) acquireHelper(ctx context.Context, bodyBytes int) bool {
	if ctx.Err() != nil || agent.ctx.Err() != nil {
		return false
	}
	select {
	case agent.slots <- struct{}{}:
		if ctx.Err() != nil || agent.ctx.Err() != nil {
			<-agent.slots
			return false
		}
		return true
	default:
	}
	agent.mu.Lock()
	if agent.closing || agent.waitingHelpers >= 8 || bodyBytes > 24*1024*1024-agent.waitingBytes {
		agent.mu.Unlock()
		return false
	}
	agent.waitingHelpers++
	agent.waitingBytes += bodyBytes
	wait := agent.admissionWait
	agent.mu.Unlock()
	defer func() { agent.mu.Lock(); agent.waitingHelpers--; agent.waitingBytes -= bodyBytes; agent.mu.Unlock() }()
	timer := time.NewTimer(wait)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-agent.ctx.Done():
		return false
	case <-timer.C:
		return false
	case agent.slots <- struct{}{}:
		if ctx.Err() != nil || agent.ctx.Err() != nil {
			<-agent.slots
			return false
		}
		return true
	}
}

// Keep helper stdin gated until the Job Object owns the process. A failed
// assignment can never release a mutation payload to an unowned helper.
type agentPayloadGate struct {
	ready  chan struct{}
	ctx    context.Context
	reader *bytes.Reader
}

func (g *agentPayloadGate) Read(p []byte) (int, error) {
	select {
	case <-g.ctx.Done():
		return 0, g.ctx.Err()
	case <-g.ready:
	}
	return g.reader.Read(p)
}

type agentBoundedOutput struct {
	bytes.Buffer
	limit    int
	overflow bool
	cancel   context.CancelFunc
}

func (b *agentBoundedOutput) Write(p []byte) (int, error) {
	n := len(p)
	remaining := b.limit - b.Len()
	if n > remaining {
		if remaining > 0 {
			_, _ = b.Buffer.Write(p[:remaining])
		}
		b.overflow = true
		b.cancel()
		return n, nil
	}
	_, err := b.Buffer.Write(p)
	return n, err
}

type agentHelperFailure struct{ confirmed bool }

func (e *agentHelperFailure) Error() string { return "workspace helper could not complete the request" }

func (agent *localWorkspaceAgent) runHelper(parent context.Context, payload []byte) (response []byte, helperErr error) {
	defer func() {
		if helperErr != nil {
			var failure *agentHelperFailure
			if !errors.As(helperErr, &failure) {
				helperErr = &agentHelperFailure{confirmed: true}
			}
		}
	}()
	agent.mu.Lock()
	if agent.closing {
		agent.mu.Unlock()
		return nil, context.Canceled
	}
	agent.jobs.Add(1)
	agent.mu.Unlock()
	defer agent.jobs.Done()
	ctx, cancel := context.WithTimeout(parent, 650*time.Second)
	stop := context.AfterFunc(agent.ctx, cancel)
	defer stop()
	defer cancel()
	owner, err := agent.owner()
	if err != nil {
		return nil, err
	}
	defer owner.close()
	command := hideCommandWindow(exec.CommandContext(ctx, "powershell.exe",
		"-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", agent.helperPath))
	gate := &agentPayloadGate{ready: make(chan struct{}), ctx: ctx, reader: bytes.NewReader(payload)}
	command.Stdin = gate
	stdout := &agentBoundedOutput{limit: 16 * 1024 * 1024, cancel: cancel}
	stderr := &agentBoundedOutput{limit: 64 * 1024, cancel: cancel}
	command.Stdout, command.Stderr, command.WaitDelay = stdout, stderr, 2*time.Second
	if err := command.Start(); err != nil {
		return nil, err
	}
	if err := owner.assign(command.Process.Pid); err != nil {
		cancel()
		_ = command.Process.Kill()
		_ = command.Wait()
		return nil, err
	}
	killTree := context.AfterFunc(ctx, func() { _ = owner.cleanup() })
	defer killTree()
	if ctx.Err() == nil {
		close(gate.ready)
	}
	err = command.Wait()
	if cleanupErr := owner.cleanup(); cleanupErr != nil {
		return nil, &agentHelperFailure{confirmed: false}
	}
	if ctx.Err() != nil || stdout.overflow || stderr.overflow {
		return nil, fmt.Errorf("workspace helper interrupted or output exceeded limit")
	}
	// Structured helper refusals exit 1; retain only valid bounded JSON output.
	if stdout.Len() == 0 || !json.Valid(stdout.Bytes()) {
		if err == nil {
			err = fmt.Errorf("workspace helper returned no valid response")
		}
		return nil, err
	}
	return stdout.Bytes(), nil
}

func agentError(code, message string) map[string]any {
	return map[string]any{"ok": false, "protocol": 1, "platform": "win32", "code": code, "error": message}
}

func writeAgentJSON(writer http.ResponseWriter, status int, value any) {
	writer.Header().Set("content-type", "application/json")
	writer.WriteHeader(status)
	_ = json.NewEncoder(writer).Encode(value)
}
