package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"
)

const maxAccountCredentialBytes = 1024 * 1024
const maxPendingAccountRevocations = 32

// Active credentials and pending revocations share one DPAPI-protected atomic
// record. A crash can never publish a local logout without its captured revoke.
// Config.Token remains an unrelated legacy key and never contains this record.
type persistedAccountCredential struct {
	Version   int                        `json:"version"`
	ServerKey string                     `json:"serverKey"`
	Token     string                     `json:"token"`
	Pending   []pendingAccountRevocation `json:"pendingRevocations,omitempty"`
}

// Network completion can update a captured profile after a new account logs in.
// Serialize every credential read/modify/write, always inside the account lock
// when both locks are needed. Background completion never acquires that lock.
var accountCredentialMu sync.Mutex

func accountCredentialPath() (string, error) {
	if store == nil || store.path == "" {
		return "", fmt.Errorf("account profile is not configured")
	}
	root, err := filepath.Abs(filepath.Dir(store.path))
	if err != nil {
		return "", err
	}
	return filepath.Join(root, "account-session-v2", "credential.bin"), nil
}

func safeCredentialAncestors(path string) error {
	for current := path; ; current = filepath.Dir(current) {
		info, err := os.Lstat(current)
		if err == nil {
			if info.Mode()&os.ModeSymlink != 0 || credentialReparsePoint(info) {
				return fmt.Errorf("account credential path is a link")
			}
		} else if !os.IsNotExist(err) {
			return err
		}
		if filepath.Dir(current) == current {
			return nil
		}
	}
}

func readAccountCredentialRecord(path string) (persistedAccountCredential, error) {
	var record persistedAccountCredential
	if err := safeCredentialAncestors(path); err != nil {
		return record, err
	}
	info, err := os.Lstat(path)
	if os.IsNotExist(err) {
		return persistedAccountCredential{Version: 3}, nil
	}
	if err != nil {
		return record, err
	}
	if !info.Mode().IsRegular() || info.Size() > maxAccountCredentialBytes+64*1024 {
		return record, fmt.Errorf("invalid account credential file")
	}
	if err = secureAccountCredential(filepath.Dir(path), true); err != nil {
		return record, err
	}
	if err = secureAccountCredential(path, false); err != nil {
		return record, err
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return record, err
	}
	plain, err := unprotectAccountCredential(raw)
	if err != nil {
		return record, fmt.Errorf("account credential cannot be decrypted")
	}
	if len(plain) > maxAccountCredentialBytes || json.Unmarshal(plain, &record) != nil || (record.Version != 2 && record.Version != 3) || len(record.Pending) > maxPendingAccountRevocations {
		return record, fmt.Errorf("invalid account credential record")
	}
	seen := make(map[string]bool, len(record.Pending))
	for _, pending := range record.Pending {
		if !pending.valid() || seen[pending.ID] || record.Version != 3 {
			return record, fmt.Errorf("invalid pending account revocation")
		}
		seen[pending.ID] = true
	}
	return record, nil
}

func loadAccountCredential(key string) (string, error) {
	path, err := accountCredentialPath()
	if err != nil {
		return "", err
	}
	accountCredentialMu.Lock()
	defer accountCredentialMu.Unlock()
	record, err := readAccountCredentialRecord(path)
	if err != nil {
		return "", err
	}
	if record.ServerKey != key || !validSessionToken(record.Token) {
		return "", nil
	}
	return record.Token, nil
}

// nil is a durable tombstone. Saving/clearing active credentials always retains
// unrelated pending revocations, including when a network acknowledgement races
// with a new login. An unreadable record is never overwritten and lost silently.
func saveAccountCredential(record *persistedAccountCredential) error {
	path, err := accountCredentialPath()
	if err != nil {
		return err
	}
	accountCredentialMu.Lock()
	defer accountCredentialMu.Unlock()
	value, err := readAccountCredentialRecord(path)
	if err != nil {
		return err
	}
	value.ServerKey, value.Token = "", ""
	if record != nil {
		value.ServerKey, value.Token = record.ServerKey, record.Token
	}
	value.Pending = liveAccountRevocations(value.Pending, time.Now().Unix())
	return writeAccountCredentialRecord(path, value)
}

// Caller holds accountCredentialMu. The same file replacement commits both the
// active tombstone and the revocation queue; there is no two-file crash window.
func writeAccountCredentialRecord(path string, value persistedAccountCredential) error {
	value.Version = 3
	if len(value.Pending) > maxPendingAccountRevocations {
		return fmt.Errorf("pending account revocation limit reached")
	}
	plain, err := json.Marshal(value)
	if err != nil {
		return err
	}
	if len(plain) > maxAccountCredentialBytes {
		return fmt.Errorf("account credential size limit reached")
	}
	if err = safeCredentialAncestors(path); err != nil {
		return err
	}
	dir := filepath.Dir(path)
	if err = os.MkdirAll(dir, 0700); err != nil {
		return err
	}
	if err = secureAccountCredential(dir, true); err != nil {
		return err
	}
	raw, err := protectAccountCredential(plain)
	if err != nil {
		return err
	}
	temporary, err := os.CreateTemp(dir, "credential-*.tmp")
	if err != nil {
		return err
	}
	temporaryPath := temporary.Name()
	defer os.Remove(temporaryPath)
	if err = secureAccountCredential(temporaryPath, false); err == nil {
		_, err = temporary.Write(raw)
	}
	if err == nil {
		err = temporary.Sync()
	}
	closeErr := temporary.Close()
	if err != nil {
		return err
	}
	if closeErr != nil {
		return closeErr
	}
	return os.Rename(temporaryPath, path)
}
