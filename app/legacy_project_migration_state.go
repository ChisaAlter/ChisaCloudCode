package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"time"
)

const legacyMigrationStateDirectory = "legacy-project-migration-v2"

var errLegacyMigrationState = errors.New("private legacy migration state unavailable or invalid")

type legacyMigrationRecord struct {
	Version       int    `json:"version"`
	Key           string `json:"key"`
	MappingID     string `json:"mappingId"`
	SourceSHA256  string `json:"sourceSha256"`
	ServerKey     string `json:"serverKey"`
	AccountSHA256 string `json:"accountSha256"`
	PathSHA256    string `json:"pathSha256"`
	SessionSHA256 string `json:"sessionSha256"`
	Generation    uint64 `json:"generation"`
	TokenRevision uint64 `json:"tokenRevision"`
	CompletedAt   string `json:"completedAt"`
	Outcome       string `json:"outcome"`
	SHA256        string `json:"sha256"`
}

type legacyMigrationState struct {
	root  *os.Root
	owner *os.File
}

func legacyMigrationDigest(domain string, values ...string) string {
	raw, _ := json.Marshal(append([]string{"legacy-project-migration-v2", domain}, values...))
	sum := sha256.Sum256(raw)
	return hex.EncodeToString(sum[:])
}

func legacyMigrationHash(value string) bool {
	if len(value) != 64 {
		return false
	}
	_, err := hex.DecodeString(value)
	return err == nil && value == strings.ToLower(value)
}

func legacyMigrationRecordHash(record legacyMigrationRecord) string {
	record.SHA256 = ""
	raw, _ := json.Marshal(record)
	return legacyMigrationDigest("record", string(raw))
}

// Validate persisted source evidence independently of a new login incarnation.
// SHA256 detects accidental corruption; private filesystem ownership, not an
// unkeyed hash, is the trust boundary. No token, account name or path is stored.
func validLegacyMigrationRecord(record legacyMigrationRecord) bool {
	for _, value := range []string{record.Key, record.MappingID, record.SourceSHA256, record.ServerKey, record.AccountSHA256, record.PathSHA256, record.SessionSHA256, record.SHA256} {
		if !legacyMigrationHash(value) {
			return false
		}
	}
	_, err := time.Parse(time.RFC3339Nano, record.CompletedAt)
	return err == nil && record.Version == 2 && record.Generation > 0 && record.TokenRevision > 0 &&
		legacyMigrationSuccess(record.Outcome) && record.SHA256 == legacyMigrationRecordHash(record) &&
		record.Key == legacyMigrationDigest("key", record.MappingID, record.SourceSHA256, record.ServerKey, record.AccountSHA256, record.PathSHA256)
}

func sameLegacyMigrationEvidence(left, right legacyMigrationRecord) bool {
	return left.Key == right.Key && left.MappingID == right.MappingID && left.SourceSHA256 == right.SourceSHA256 &&
		left.ServerKey == right.ServerKey && left.AccountSHA256 == right.AccountSHA256 && left.PathSHA256 == right.PathSHA256
}

// Existing platform helpers supply Windows CurrentUser/SYSTEM-only ACLs and
// reparse detection. They are used only on this independent directory and its
// files, never on credentials or the retired mapping store.
func legacyMigrationLink(info os.FileInfo) bool {
	return info.Mode()&os.ModeSymlink != 0 || credentialReparsePoint(info)
}

// Where the OS exposes uid/link count, reject foreign ownership and hard links.
// Reflection keeps this private file portable without extra platform files.
func legacyMigrationPrivate(info os.FileInfo, directory bool) bool {
	if legacyMigrationLink(info) || directory != info.IsDir() || !directory && !info.Mode().IsRegular() {
		return false
	}
	if runtime.GOOS != "windows" {
		want := os.FileMode(0600)
		if directory {
			want = 0700
		}
		if info.Mode().Perm() != want {
			return false
		}
		value := reflect.Indirect(reflect.ValueOf(info.Sys()))
		if value.IsValid() && value.Kind() == reflect.Struct {
			if uid := value.FieldByName("Uid"); uid.IsValid() && uid.CanUint() && uid.Uint() != uint64(os.Getuid()) {
				return false
			}
			if links := value.FieldByName("Nlink"); !directory && links.IsValid() && links.CanUint() && links.Uint() != 1 {
				return false
			}
		}
	}
	return true
}

// Ancestors are checked before opening a rooted handle. All state reads,
// temporary writes and renames then stay relative to that captured directory.
// The application profile is never chmodded and retired mappings are never read
// or rewritten here.
func openLegacyMigrationState(profilePath string) (*legacyMigrationState, error) {
	if profilePath == "" {
		return nil, errLegacyMigrationState
	}
	profile, err := filepath.Abs(filepath.Dir(profilePath))
	if err != nil {
		return nil, errLegacyMigrationState
	}
	for current := profile; ; current = filepath.Dir(current) {
		info, err := os.Lstat(current)
		if err != nil || !info.IsDir() || legacyMigrationLink(info) {
			return nil, errLegacyMigrationState
		}
		if filepath.Dir(current) == current {
			break
		}
	}
	profileRoot, err := os.OpenRoot(profile)
	if err != nil {
		return nil, errLegacyMigrationState
	}
	defer profileRoot.Close()
	if err := profileRoot.Mkdir(legacyMigrationStateDirectory, 0700); err != nil && !os.IsExist(err) {
		return nil, errLegacyMigrationState
	}
	info, err := profileRoot.Lstat(legacyMigrationStateDirectory)
	if err != nil || legacyMigrationLink(info) || !info.IsDir() {
		return nil, errLegacyMigrationState
	}
	statePath := filepath.Join(profile, legacyMigrationStateDirectory)
	if runtime.GOOS == "windows" {
		if err := secureAccountCredential(statePath, true); err != nil {
			return nil, errLegacyMigrationState
		}
	}
	info, err = profileRoot.Lstat(legacyMigrationStateDirectory)
	if err != nil || !legacyMigrationPrivate(info, true) {
		return nil, errLegacyMigrationState
	}
	root, err := profileRoot.OpenRoot(legacyMigrationStateDirectory)
	if err != nil {
		return nil, errLegacyMigrationState
	}
	state := &legacyMigrationState{root: root}
	ok := false
	defer func() {
		if !ok {
			state.close()
		}
	}()
	opened, err := root.Stat(".")
	if err != nil || !os.SameFile(info, opened) {
		return nil, errLegacyMigrationState
	}
	// Reuse only the OS-level kernel lock primitive in our own namespace. The
	// kernel releases it after a crash; there is no persistent in-progress claim
	// that could incorrectly suppress a retry or require deleting stale locks.
	lockName := ".relay-owner.lock"
	if lockInfo, err := root.Lstat(lockName); err == nil {
		if !legacyMigrationPrivate(lockInfo, false) {
			return nil, errLegacyMigrationState
		}
	} else if !os.IsNotExist(err) {
		return nil, errLegacyMigrationState
	}
	state.owner, err = lockRelayJournal(root)
	if err != nil {
		return nil, errLegacyMigrationState
	}
	lockInfo, err := root.Lstat(lockName)
	opened, openErr := state.owner.Stat()
	if err != nil || openErr != nil || !legacyMigrationPrivate(lockInfo, false) || !os.SameFile(lockInfo, opened) {
		return nil, errLegacyMigrationState
	}
	if runtime.GOOS == "windows" {
		if err := secureAccountCredential(filepath.Join(statePath, lockName), false); err != nil {
			return nil, errLegacyMigrationState
		}
	}
	ok = true
	return state, nil
}

func (state *legacyMigrationState) close() {
	if state.owner != nil {
		state.owner.Close()
	}
	if state.root != nil {
		state.root.Close()
	}
}

func (state *legacyMigrationState) completed(expected legacyMigrationRecord) (bool, error) {
	if !legacyMigrationHash(expected.Key) {
		return false, errLegacyMigrationState
	}
	name := expected.Key + ".json"
	info, err := state.root.Lstat(name)
	if os.IsNotExist(err) {
		return false, nil
	}
	if err != nil || !legacyMigrationPrivate(info, false) || info.Size() <= 0 || info.Size() > 4096 {
		return false, errLegacyMigrationState
	}
	file, err := state.root.Open(name)
	if err != nil {
		return false, errLegacyMigrationState
	}
	opened, statErr := file.Stat()
	raw, readErr := io.ReadAll(io.LimitReader(file, 4097))
	closeErr := file.Close()
	after, afterErr := state.root.Lstat(name)
	if statErr != nil || readErr != nil || closeErr != nil || afterErr != nil ||
		!os.SameFile(info, opened) || !os.SameFile(info, after) || !legacyMigrationPrivate(after, false) || int64(len(raw)) != info.Size() {
		return false, errLegacyMigrationState
	}
	var record legacyMigrationRecord
	if json.Unmarshal(raw, &record) != nil || !validLegacyMigrationRecord(record) || !sameLegacyMigrationEvidence(record, expected) {
		return false, errLegacyMigrationState
	}
	return true, nil
}

func (state *legacyMigrationState) complete(record legacyMigrationRecord) error {
	record.SHA256 = legacyMigrationRecordHash(record)
	if !validLegacyMigrationRecord(record) {
		return errLegacyMigrationState
	}
	if done, err := state.completed(record); err != nil || done {
		return err
	}
	raw, err := json.Marshal(record)
	if err != nil || len(raw) > 4096 {
		return errLegacyMigrationState
	}
	name := record.Key + ".json"
	temporary := ".migration-" + randHex(24) + ".tmp"
	file, err := state.root.OpenFile(temporary, os.O_WRONLY|os.O_CREATE|os.O_EXCL|os.O_SYNC, 0600)
	if err != nil {
		return errLegacyMigrationState
	}
	defer state.root.Remove(temporary)
	// Directory inheritance already restricts Windows writes; explicitly secure
	// the temporary file before any source evidence is written as well.
	if runtime.GOOS == "windows" {
		err = secureAccountCredential(filepath.Join(state.root.Name(), temporary), false)
	}
	if err == nil {
		_, err = file.Write(raw)
	}
	if err == nil {
		err = file.Sync()
	}
	closeErr := file.Close()
	if err != nil || closeErr != nil {
		return errLegacyMigrationState
	}
	if _, err := state.root.Lstat(name); !os.IsNotExist(err) {
		return errLegacyMigrationState
	}
	if err := state.root.Rename(temporary, name); err != nil {
		return errLegacyMigrationState
	}
	installed, err := state.root.OpenFile(name, os.O_RDWR|os.O_SYNC, 0600)
	if err != nil {
		return errLegacyMigrationState
	}
	syncErr, closeErr := installed.Sync(), installed.Close()
	if syncErr != nil || closeErr != nil {
		return errLegacyMigrationState
	}
	if runtime.GOOS != "windows" {
		dir, err := state.root.Open(".")
		if err != nil {
			return errLegacyMigrationState
		}
		syncErr, closeErr := dir.Sync(), dir.Close()
		if syncErr != nil || closeErr != nil {
			return errLegacyMigrationState
		}
	}
	done, err := state.completed(record)
	if err != nil || !done {
		return errLegacyMigrationState
	}
	return nil
}
