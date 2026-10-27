package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sync"
	"time"
)

var agentOperationIDPattern = regexp.MustCompile(`^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$`)

type agentOperationReceipt struct {
	OperationID      string `json:"operationId"`
	RootPath         string `json:"rootPath"`
	RootIdentity     string `json:"rootIdentity"`
	Generation       string `json:"generation"`
	State            string `json:"state"`
	CleanupConfirmed bool   `json:"cleanupConfirmed"`
	cancel           context.CancelFunc
	done             chan struct{}
}

type agentReceiptStore struct {
	mu        sync.Mutex
	directory string
	active    map[string]*agentOperationReceipt
}

func newAgentReceiptStore(directory string) (*agentReceiptStore, error) {
	if err := os.MkdirAll(directory, 0700); err != nil {
		return nil, err
	}
	return &agentReceiptStore{directory: directory, active: map[string]*agentOperationReceipt{}}, nil
}
func agentMutationOperation(op string) bool {
	return op == "write" || op == "mkdir" || op == "rename" || op == "copy" || op == "remove"
}
func (s *agentReceiptStore) path(id string) string { return filepath.Join(s.directory, id+".json") }
func receiptFor(envelope agentEnvelope, id, state string) *agentOperationReceipt {
	return &agentOperationReceipt{OperationID: id, RootPath: envelope.RootPath, RootIdentity: envelope.ExpectedRootIdentity, Generation: envelope.Generation, State: state}
}
func sameReceipt(r *agentOperationReceipt, envelope agentEnvelope) bool {
	return r.RootPath == envelope.RootPath && r.RootIdentity == envelope.ExpectedRootIdentity && r.Generation == envelope.Generation
}
func (s *agentReceiptStore) write(r *agentOperationReceipt, exclusive bool) error {
	raw, err := json.Marshal(r)
	if err != nil {
		return err
	}
	flags := os.O_WRONLY | os.O_CREATE | os.O_EXCL
	path := s.path(r.OperationID)
	if !exclusive {
		file, err := os.CreateTemp(s.directory, ".receipt-*.tmp")
		if err != nil {
			return err
		}
		name := file.Name()
		defer os.Remove(name)
		if err = file.Chmod(0600); err == nil {
			_, err = file.Write(raw)
		}
		if err == nil {
			err = file.Sync()
		}
		closeErr := file.Close()
		if err == nil {
			err = closeErr
		}
		if err != nil {
			return err
		}
		return os.Rename(name, path)
	}
	file, err := os.OpenFile(path, flags, 0600)
	if err != nil {
		return err
	}
	_, err = file.Write(raw)
	if err == nil {
		err = file.Sync()
	}
	closeErr := file.Close()
	if err == nil {
		err = closeErr
	}
	return err
}
func (s *agentReceiptStore) load(id string) (*agentOperationReceipt, error) {
	if r := s.active[id]; r != nil {
		return r, nil
	}
	stats, err := os.Lstat(s.path(id))
	if err != nil {
		return nil, err
	}
	if !stats.Mode().IsRegular() || stats.Size() > 16*1024 {
		return nil, errors.New("invalid receipt")
	}
	raw, err := os.ReadFile(s.path(id))
	if err != nil {
		return nil, err
	}
	var r agentOperationReceipt
	if json.Unmarshal(raw, &r) != nil || r.OperationID != id {
		return nil, errors.New("invalid receipt")
	}
	if r.State == "running" {
		r.State, r.CleanupConfirmed = "unknown", false
	}
	return &r, nil
}
func (s *agentReceiptStore) claim(envelope agentEnvelope, cancel context.CancelFunc) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	r := receiptFor(envelope, envelope.OperationID, "running")
	if err := s.write(r, true); err != nil {
		return err
	}
	r.cancel, r.done = cancel, make(chan struct{})
	s.active[r.OperationID] = r
	return nil
}
func (s *agentReceiptStore) finish(envelope agentEnvelope, confirmed bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	r := s.active[envelope.OperationID]
	if r == nil {
		return
	}
	r.State, r.CleanupConfirmed = "unknown", false
	if confirmed {
		r.State, r.CleanupConfirmed = "completed", true
	}
	if err := s.write(r, false); err != nil {
		r.State, r.CleanupConfirmed = "unknown", false
	}
	r.cancel = nil
	close(r.done)
	r.done = nil
	delete(s.active, r.OperationID)
}
func (agent *localWorkspaceAgent) handleOperationReceipt(writer http.ResponseWriter, request *http.Request, envelope agentEnvelope, op, id string) {
	if !agentOperationIDPattern.MatchString(id) || envelope.ExpectedRootIdentity == "" || envelope.Generation == "" {
		writeAgentJSON(writer, 400, agentError("AGENT_REQUEST_INVALID", "Operation receipt identity is invalid"))
		return
	}
	s := agent.receipts
	s.mu.Lock()
	r, err := s.load(id)
	if os.IsNotExist(err) && op == "operation_cancel" {
		r = receiptFor(envelope, id, "cancelled")
		r.CleanupConfirmed = true
		err = s.write(r, true)
	}
	if os.IsNotExist(err) {
		r = receiptFor(envelope, id, "not_found")
		err = nil
	}
	if err != nil {
		s.mu.Unlock()
		writeAgentJSON(writer, 502, agentError("AGENT_RECEIPT_UNAVAILABLE", "Operation receipt cannot be safely read"))
		return
	}
	if !sameReceipt(r, envelope) {
		s.mu.Unlock()
		writeAgentJSON(writer, 409, agentError("AGENT_OPERATION_CONFLICT", "Operation id belongs to another workspace identity"))
		return
	}
	var done <-chan struct{}
	if op == "operation_cancel" && r.cancel != nil {
		r.cancel()
		done = r.done
	}
	s.mu.Unlock()
	if done != nil {
		select {
		case <-done:
		case <-request.Context().Done():
			return
		case <-time.After(5 * time.Second):
		}
	}
	s.mu.Lock()
	r, err = s.load(id)
	if os.IsNotExist(err) {
		r = receiptFor(envelope, id, "not_found")
		err = nil
	}
	if err != nil {
		s.mu.Unlock()
		writeAgentJSON(writer, 502, agentError("AGENT_RECEIPT_UNAVAILABLE", "Operation receipt cannot be safely read"))
		return
	}
	result := map[string]any{"ok": true, "protocol": 1, "platform": "win32", "rootPath": r.RootPath, "rootIdentity": r.RootIdentity, "generation": r.Generation, "operationId": id, "state": r.State, "cleanupConfirmed": r.CleanupConfirmed}
	s.mu.Unlock()
	writeAgentJSON(writer, http.StatusOK, result)
}
