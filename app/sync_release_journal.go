package main

import (
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
)

// Persist before claiming so a restart retains the exact lease and daemon session.
type syncReleaseRecord struct {
	Root     string `json:"root"`
	Epoch    string `json:"epoch"`
	ID       string `json:"id"`
	SyncName string `json:"syncName"`
}

func syncReleaseName(m *Mapping) string {
	if m.SyncName != "" {
		return m.SyncName
	}
	return "chisa-vps-" + m.BindingEpoch
}

func syncReleasePath(m *Mapping) string {
	key := sha256.Sum256([]byte(m.ServerPath + "\x00" + m.BindingEpoch))
	return filepath.Join(dataDir(), "sync-releases", fmt.Sprintf("%x.json", key))
}

func loadSyncRelease(m *Mapping) (*syncReleaseRecord, error) {
	data, err := os.ReadFile(syncReleasePath(m))
	if os.IsNotExist(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var record syncReleaseRecord
	if err := json.Unmarshal(data, &record); err != nil {
		return nil, err
	}
	if record.Root != m.ServerPath || record.Epoch != m.BindingEpoch || record.ID == "" || record.SyncName != syncReleaseName(m) {
		return nil, fmt.Errorf("sync release record does not match the project binding")
	}
	return &record, nil
}

func saveSyncRelease(m *Mapping, id string) error {
	file := syncReleasePath(m)
	if err := os.MkdirAll(filepath.Dir(file), 0700); err != nil {
		return err
	}
	data, err := json.Marshal(syncReleaseRecord{Root: m.ServerPath, Epoch: m.BindingEpoch, ID: id, SyncName: syncReleaseName(m)})
	if err != nil {
		return err
	}
	temporary, err := os.CreateTemp(filepath.Dir(file), ".release-*")
	if err != nil {
		return err
	}
	defer os.Remove(temporary.Name())
	if _, err = temporary.Write(data); err == nil {
		err = temporary.Sync()
	}
	closeErr := temporary.Close()
	if err != nil {
		return err
	}
	if closeErr != nil {
		return closeErr
	}
	return os.Rename(temporary.Name(), file)
}

func clearSyncRelease(m *Mapping) error {
	err := os.Remove(syncReleasePath(m))
	if os.IsNotExist(err) {
		return nil
	}
	return err
}
