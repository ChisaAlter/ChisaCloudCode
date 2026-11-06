package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"sync"
	"time"
)

const (
	relayJournalMaxRecords      = 1024
	relayJournalMaxBytes        = int64(128 * 1024 * 1024)
	relayJournalControlBytes    = int64(32 * 1024 * 1024)
	relayJournalControlRecords  = 16
	relayJournalMaxPayloadBytes = 12 * 1024 * 1024
	relayJournalMaxResultBytes  = 16 * 1024 * 1024
	relayJournalMaxFuture       = 11 * time.Minute
	relayJournalRetention       = 5 * time.Minute
	relayJournalRecordMaxBytes  = (relayJournalMaxPayloadBytes+relayJournalMaxResultBytes)*4/3 + 8192
)

// These errors deliberately contain no payload, credentials, request ID or path.
var (
	errRelayJournalInvalid     = errors.New("invalid relay journal record; execution refused")
	errRelayJournalUnavailable = errors.New("relay journal storage unavailable; execution refused")
	errRelayJournalConflict    = errors.New("relay journal identity or result conflict; execution refused")
	errRelayJournalCapacity    = errors.New("relay journal capacity exhausted; execution refused")
	errRelayJournalExpired     = errors.New("relay journal request deadline expired; execution refused")
	errRelayJournalState       = errors.New("relay journal state does not permit execution")
	errRelayJournalClosed      = errors.New("relay journal closed; execution refused")
)

// All records returned by claim and records are deep snapshots. In particular,
// markRunning and complete do not mutate a caller's snapshot. Only a successful
// markRunning permits the caller to invoke the local Agent, once. A caller must
// also verify that the returned Epoch matches the current broker epoch.
type relayJournalRecord struct {
	Epoch         string              `json:"epoch"`
	RequestID     string              `json:"requestId"`
	PayloadSHA256 string              `json:"payloadSha256"`
	State         string              `json:"state"`
	DeadlineAt    int64               `json:"deadlineAt"`
	ReceivedAt    int64               `json:"receivedAt"`
	Payload       json.RawMessage     `json:"-"`
	Result        *agentRelayResponse `json:"-"`
	Control       bool                `json:"-"`
}

// Payload and result bytes use base64 on disk: encoding/json otherwise compacts
// RawMessage and substitutes invalid UTF-8 in strings, changing replay bytes.
type relayJournalDiskRecord struct {
	Version       int                     `json:"version"`
	Epoch         string                  `json:"epoch"`
	RequestID     string                  `json:"requestId"`
	PayloadSHA256 string                  `json:"payloadSha256"`
	State         string                  `json:"state"`
	DeadlineAt    int64                   `json:"deadlineAt"`
	ReceivedAt    int64                   `json:"receivedAt"`
	Payload       []byte                  `json:"payload"`
	Result        *relayJournalDiskResult `json:"result,omitempty"`
}

type relayJournalDiskResult struct {
	Status int    `json:"status"`
	Body   []byte `json:"body"`
}

type relayJournalLimits struct {
	records        int
	bytes          int64
	controlRecords int
	controlBytes   int64
	resultBytes    int
}

// One relay runtime owns a directory. Its workers share this mutex; separate
// processes must not open the same account/profile journal concurrently.
type relayJournal struct {
	mu               sync.Mutex
	root             *os.Root
	entries          map[string]*relayJournalRecord
	byRequest        map[string]string
	sizes            map[string]int64
	reservations     map[string]int64
	pendingResults   map[string]agentRelayResponse
	pendingInstalled map[string]bool
	syncInstalled    func(*os.File) error
	owner            *os.File
	bytes            int64
	regularBytes     int64
	reserved         int64
	regularReserved  int64
	limits           relayJournalLimits
	now              func() time.Time
	failure          error
	closed           bool
}

func newRelayJournal(directory string) (*relayJournal, error) {
	if err := relayJournalMakeDirectory(directory); err != nil {
		return nil, errRelayJournalUnavailable
	}
	root, err := os.OpenRoot(directory)
	if err != nil {
		return nil, errRelayJournalUnavailable
	}
	owner, err := lockRelayJournal(root)
	if err != nil {
		_ = root.Close()
		return nil, errRelayJournalUnavailable
	}
	journal := &relayJournal{
		root: root, owner: owner, entries: map[string]*relayJournalRecord{}, byRequest: map[string]string{},
		sizes: map[string]int64{}, reservations: map[string]int64{}, pendingResults: map[string]agentRelayResponse{}, pendingInstalled: map[string]bool{}, now: time.Now, syncInstalled: (*os.File).Sync,
		limits: relayJournalLimits{relayJournalMaxRecords, relayJournalMaxBytes, relayJournalControlRecords, relayJournalControlBytes, relayJournalMaxResultBytes},
	}
	if err := journal.loadFromDisk(); err != nil {
		_ = owner.Close()
		_ = root.Close()
		return nil, err
	}
	return journal, nil
}

// Walk each component without accepting symlinks (including directory links).
// Subsequent file operations are rooted handles, so a renamed directory cannot
// redirect a write outside this journal. Only hash-derived basenames are used.
func relayJournalMakeDirectory(directory string) error {
	absolute, err := filepath.Abs(directory)
	if err != nil || directory == "" {
		return errRelayJournalUnavailable
	}
	volume := filepath.VolumeName(absolute)
	current := volume + string(os.PathSeparator)
	relative := strings.TrimPrefix(absolute, current)
	for _, component := range strings.Split(relative, string(os.PathSeparator)) {
		if component == "" {
			continue
		}
		next := filepath.Join(current, component)
		info, err := os.Lstat(next)
		if os.IsNotExist(err) {
			if err = os.Mkdir(next, 0700); err != nil && !os.IsExist(err) {
				return errRelayJournalUnavailable
			}
			info, err = os.Lstat(next)
			if err == nil && runtime.GOOS != "windows" {
				parent, openErr := os.Open(current)
				if openErr != nil {
					return errRelayJournalUnavailable
				}
				syncErr, closeErr := parent.Sync(), parent.Close()
				if syncErr != nil || closeErr != nil {
					return errRelayJournalUnavailable
				}
			}
		}
		if err != nil || info.Mode()&os.ModeSymlink != 0 || !info.IsDir() {
			return errRelayJournalUnavailable
		}
		current = next
	}
	return nil
}

func relayJournalKey(epoch, id string) string {
	sum := sha256.Sum256([]byte(epoch + "\x00" + id))
	return hex.EncodeToString(sum[:])
}

func relayJournalDigest(payload []byte) string {
	sum := sha256.Sum256(payload)
	return hex.EncodeToString(sum[:])
}

func relayJournalHash(value string) bool {
	if len(value) != 64 {
		return false
	}
	for _, character := range value {
		if !(character >= '0' && character <= '9' || character >= 'a' && character <= 'f') {
			return false
		}
	}
	return true
}

func relayJournalIdentity(value string) bool {
	return value != "" && len(value) <= 128 && !strings.ContainsAny(value, "\x00\r\n")
}

func cloneRelayJournalRecord(record *relayJournalRecord) *relayJournalRecord {
	copy := *record
	copy.Payload = append(json.RawMessage(nil), record.Payload...)
	if record.Result != nil {
		result := *record.Result
		copy.Result = &result
	}
	return &copy
}

func encodeRelayJournalRecord(record *relayJournalRecord) ([]byte, error) {
	disk := relayJournalDiskRecord{
		Version: 2, Epoch: record.Epoch, RequestID: record.RequestID, PayloadSHA256: record.PayloadSHA256,
		State: record.State, DeadlineAt: record.DeadlineAt, ReceivedAt: record.ReceivedAt, Payload: record.Payload,
	}
	if record.Result != nil {
		disk.Result = &relayJournalDiskResult{Status: record.Result.Status, Body: []byte(record.Result.Body)}
	}
	return json.Marshal(disk)
}

func decodeRelayJournalRecord(raw []byte) (*relayJournalRecord, error) {
	var disk relayJournalDiskRecord
	if json.Unmarshal(raw, &disk) != nil || disk.Version != 2 {
		return nil, errRelayJournalInvalid
	}
	record := &relayJournalRecord{
		Epoch: disk.Epoch, RequestID: disk.RequestID, PayloadSHA256: disk.PayloadSHA256,
		State: disk.State, DeadlineAt: disk.DeadlineAt, ReceivedAt: disk.ReceivedAt, Payload: disk.Payload,
	}
	if disk.Result != nil {
		record.Result = &agentRelayResponse{Status: disk.Result.Status, Body: string(disk.Result.Body)}
	}
	if !relayJournalIdentity(record.Epoch) || !relayJournalIdentity(record.RequestID) ||
		len(record.Payload) > relayJournalMaxPayloadBytes || !json.Valid(record.Payload) ||
		!relayJournalHash(record.PayloadSHA256) || relayJournalDigest(record.Payload) != record.PayloadSHA256 ||
		record.ReceivedAt <= 0 || record.DeadlineAt <= record.ReceivedAt ||
		record.DeadlineAt-record.ReceivedAt > relayJournalMaxFuture.Milliseconds() {
		return nil, errRelayJournalInvalid
	}
	switch record.State {
	case "received", "running", "unknown":
		if record.Result != nil {
			return nil, errRelayJournalInvalid
		}
	case "completed":
		if record.Result == nil || !relayJournalValidResult(*record.Result, relayJournalMaxResultBytes) {
			return nil, errRelayJournalInvalid
		}
	default:
		return nil, errRelayJournalInvalid
	}
	return record, nil
}

func relayJournalValidResult(result agentRelayResponse, maxBytes int) bool {
	return result.Status >= 100 && result.Status <= 599 && len(result.Body) <= maxBytes
}

func (journal *relayJournal) loadFromDisk() error {
	directory, err := journal.root.Open(".")
	if err != nil {
		return errRelayJournalUnavailable
	}
	defer directory.Close()
	for {
		entries, readErr := directory.ReadDir(64)
		for _, entry := range entries {
			name := entry.Name()
			// A crash can leave only this exact temporary filename pattern.
			// Never recursively remove a directory or touch unrelated names.
			if strings.HasPrefix(name, ".relay-journal-") && strings.HasSuffix(name, ".tmp") && relayJournalHash(strings.TrimSuffix(strings.TrimPrefix(name, ".relay-journal-"), ".tmp")) {
				info, err := journal.root.Lstat(name)
				if err != nil || !info.Mode().IsRegular() || journal.root.Remove(name) != nil {
					return errRelayJournalUnavailable
				}
				continue
			}
			if !strings.HasSuffix(name, ".json") || !relayJournalHash(strings.TrimSuffix(name, ".json")) {
				continue
			}
			if len(journal.entries) >= journal.limits.records {
				return errRelayJournalCapacity
			}
			info, err := journal.root.Lstat(name)
			if err != nil || !info.Mode().IsRegular() || info.Size() <= 0 || info.Size() > relayJournalRecordMaxBytes || journal.bytes+info.Size() > journal.limits.bytes {
				return errRelayJournalInvalid
			}
			file, err := journal.root.Open(name)
			if err != nil {
				return errRelayJournalUnavailable
			}
			opened, statErr := file.Stat()
			raw, readErr := io.ReadAll(io.LimitReader(file, relayJournalRecordMaxBytes+1))
			closeErr := file.Close()
			if statErr != nil || !os.SameFile(info, opened) || readErr != nil || closeErr != nil || int64(len(raw)) != info.Size() {
				return errRelayJournalInvalid
			}
			record, err := decodeRelayJournalRecord(raw)
			key := strings.TrimSuffix(name, ".json")
			if err != nil || relayJournalKey(record.Epoch, record.RequestID) != key || journal.byRequest[record.RequestID] != "" {
				return errRelayJournalInvalid
			}
			journal.entries[key], journal.byRequest[record.RequestID], journal.sizes[key] = record, key, info.Size()
			journal.bytes += info.Size()
			if !relayControlPayload(record.Payload) {
				journal.regularBytes += info.Size()
			}
		}
		if readErr == io.EOF {
			break
		}
		if readErr != nil {
			return errRelayJournalUnavailable
		}
	}
	// Recovery is persisted before this journal can be used. A crash during
	// recovery leaves running/unknown, neither of which permits execution.
	for _, record := range journal.entries {
		if record.State == "running" {
			snapshot := cloneRelayJournalRecord(record)
			snapshot.State = "unknown"
			if err := journal.writeLocked(snapshot, 0); err != nil {
				return err
			}
		}
	}
	if err := journal.pruneLocked(journal.now().UnixMilli()); err != nil {
		return err
	}
	return nil
}

func (journal *relayJournal) readyLocked() error {
	if journal.closed {
		return errRelayJournalClosed
	}
	return journal.failure
}

func (journal *relayJournal) storageFailureLocked() error {
	journal.failure = errRelayJournalUnavailable
	return journal.failure
}

// Every claim is durable before acknowledgement. Request IDs are unique across
// epochs within the retained account/profile namespace: a matching ID returns
// its original epoch and deadline; a different digest is always a conflict.
func (journal *relayJournal) claim(epoch string, job agentRelayJob) (*relayJournalRecord, bool, error) {
	journal.mu.Lock()
	defer journal.mu.Unlock()
	if err := journal.readyLocked(); err != nil {
		return nil, false, err
	}
	now := journal.now().UnixMilli()
	if !relayJournalIdentity(epoch) || !relayJournalIdentity(job.RequestID) || len(job.Payload) > relayJournalMaxPayloadBytes || !json.Valid(job.Payload) || job.DeadlineAt <= 0 || job.DeadlineAt > now+relayJournalMaxFuture.Milliseconds() {
		return nil, false, errRelayJournalInvalid
	}
	digest := relayJournalDigest(job.Payload)
	if key := journal.byRequest[job.RequestID]; key != "" {
		record := journal.entries[key]
		if record.PayloadSHA256 != digest {
			return nil, false, errRelayJournalConflict
		}
		return cloneRelayJournalRecord(record), false, nil
	}
	if job.DeadlineAt <= now {
		return nil, false, errRelayJournalExpired
	}
	if err := journal.pruneLocked(now); err != nil {
		return nil, false, err
	}
	control := relayControlPayload(job.Payload)
	if len(journal.entries) >= journal.limits.records || !control && journal.regularCountLocked() >= journal.limits.records-journal.limits.controlRecords {
		return nil, false, errRelayJournalCapacity
	}
	record := &relayJournalRecord{Epoch: epoch, RequestID: job.RequestID, PayloadSHA256: digest, State: "received", DeadlineAt: job.DeadlineAt, ReceivedAt: now, Payload: append(json.RawMessage(nil), job.Payload...)}
	raw, err := encodeRelayJournalRecord(record)
	if err != nil {
		return nil, false, errRelayJournalInvalid
	}
	// Keep enough headroom for an atomic replacement with a small pre-exec
	// refusal even when no full-result execution reservation is available.
	if err := journal.writeLocked(record, int64(len(raw))+4096); err != nil {
		return nil, false, err
	}
	return cloneRelayJournalRecord(record), true, nil
}

func (journal *relayJournal) regularCountLocked() int {
	count := 0
	for _, record := range journal.entries {
		if !relayControlPayload(record.Payload) {
			count++
		}
	}
	return count
}

func (journal *relayJournal) currentLocked(snapshot *relayJournalRecord) (*relayJournalRecord, error) {
	if snapshot == nil {
		return nil, errRelayJournalConflict
	}
	record := journal.entries[relayJournalKey(snapshot.Epoch, snapshot.RequestID)]
	if record == nil || record.Epoch != snapshot.Epoch || record.RequestID != snapshot.RequestID || record.PayloadSHA256 != snapshot.PayloadSHA256 || record.DeadlineAt != snapshot.DeadlineAt || !bytes.Equal(record.Payload, snapshot.Payload) {
		return nil, errRelayJournalConflict
	}
	return record, nil
}

func (journal *relayJournal) markRunning(snapshot *relayJournalRecord) error {
	journal.mu.Lock()
	defer journal.mu.Unlock()
	if err := journal.readyLocked(); err != nil {
		return err
	}
	record, err := journal.currentLocked(snapshot)
	if err != nil {
		return err
	}
	if _, pending := journal.pendingResults[relayJournalKey(record.Epoch, record.RequestID)]; pending || record.State != "received" {
		return errRelayJournalState
	}
	if record.DeadlineAt <= journal.now().UnixMilli() {
		return errRelayJournalExpired
	}
	candidate := cloneRelayJournalRecord(record)
	candidate.State = "running"
	raw, err := encodeRelayJournalRecord(candidate)
	if err != nil {
		return errRelayJournalInvalid
	}
	// Include the original file, the maximum encoded completed record and
	// all other workers' reservations. Refusal occurs BEFORE local execution.
	reserve := int64(len(raw)+base64.StdEncoding.EncodedLen(journal.limits.resultBytes)) + 512
	return journal.writeLocked(candidate, reserve)
}

// complete accepts received for a refusal before dispatch, and unknown for an
// explicit uncertainty response. The caller must never turn unknown into an
// executed success. Completed bytes are immutable; identical repeats are safe.
func (journal *relayJournal) complete(snapshot *relayJournalRecord, response agentRelayResponse) error {
	journal.mu.Lock()
	defer journal.mu.Unlock()
	if err := journal.readyLocked(); err != nil {
		return err
	}
	record, err := journal.currentLocked(snapshot)
	if err != nil {
		return err
	}
	if !relayJournalValidResult(response, journal.limits.resultBytes) {
		return errRelayJournalInvalid
	}
	if record.State == "completed" {
		if record.Result != nil && *record.Result == response {
			return nil
		}
		return errRelayJournalConflict
	}
	key := relayJournalKey(record.Epoch, record.RequestID)
	if pending, exists := journal.pendingResults[key]; exists && pending != response {
		return errRelayJournalConflict
	}
	// Keep this immutable response during transient I/O failures. A received
	// refusal cannot subsequently become executable while completion retries.
	journal.pendingResults[key] = response
	candidate := cloneRelayJournalRecord(record)
	candidate.State, candidate.Result = "completed", &response
	if err := journal.writeLocked(candidate, 0); err != nil {
		return err
	}
	delete(journal.pendingResults, key)
	delete(journal.pendingInstalled, key)
	return nil
}

// metadata avoids copying payloads/results while the runtime scans recovery work.
func (journal *relayJournal) metadata() []relayJournalRecord {
	journal.mu.Lock()
	defer journal.mu.Unlock()
	records := make([]relayJournalRecord, 0, len(journal.entries))
	for _, record := range journal.entries {
		copy := *record
		copy.Control = relayControlPayload(record.Payload)
		copy.Payload, copy.Result = nil, nil
		records = append(records, copy)
	}
	sort.Slice(records, func(i, k int) bool {
		if records[i].Epoch != records[k].Epoch {
			return records[i].Epoch < records[k].Epoch
		}
		return records[i].RequestID < records[k].RequestID
	})
	return records
}

// record copies only the requested payload/result; a missing identity is a refusal.
func (journal *relayJournal) record(epoch, id string) (*relayJournalRecord, error) {
	journal.mu.Lock()
	defer journal.mu.Unlock()
	if err := journal.readyLocked(); err != nil {
		return nil, err
	}
	record := journal.entries[relayJournalKey(epoch, id)]
	if record == nil {
		return nil, errRelayJournalConflict
	}
	return cloneRelayJournalRecord(record), nil
}

func (journal *relayJournal) records() []relayJournalRecord {
	journal.mu.Lock()
	defer journal.mu.Unlock()
	records := make([]relayJournalRecord, 0, len(journal.entries))
	for _, record := range journal.entries {
		records = append(records, *cloneRelayJournalRecord(record))
	}
	sort.Slice(records, func(i, k int) bool {
		if records[i].Epoch != records[k].Epoch {
			return records[i].Epoch < records[k].Epoch
		}
		return records[i].RequestID < records[k].RequestID
	})
	return records
}

func (journal *relayJournal) prune() error {
	journal.mu.Lock()
	defer journal.mu.Unlock()
	if err := journal.readyLocked(); err != nil {
		return err
	}
	return journal.pruneLocked(journal.now().UnixMilli())
}

func (journal *relayJournal) pruneLocked(now int64) error {
	removed := false
	for key, record := range journal.entries {
		// Live running work cannot be evicted even if its deadline elapsed.
		// Recovery changes it to unknown before making it eligible for expiry.
		if record.State == "running" || now <= record.DeadlineAt+relayJournalRetention.Milliseconds() {
			continue
		}
		info, err := journal.root.Lstat(key + ".json")
		if err != nil || !info.Mode().IsRegular() || journal.root.Remove(key+".json") != nil {
			return journal.storageFailureLocked()
		}
		journal.bytes -= journal.sizes[key]
		journal.reserved -= journal.reservations[key]
		if !relayControlPayload(record.Payload) {
			journal.regularBytes -= journal.sizes[key]
			journal.regularReserved -= journal.reservations[key]
		}
		delete(journal.byRequest, record.RequestID)
		delete(journal.entries, key)
		delete(journal.sizes, key)
		delete(journal.reservations, key)
		delete(journal.pendingResults, key)
		delete(journal.pendingInstalled, key)
		removed = true
	}
	if removed && journal.syncDirectoryLocked() != nil {
		return journal.storageFailureLocked()
	}
	return nil
}

func (journal *relayJournal) writeLocked(record *relayJournalRecord, reserveAfter int64) error {
	raw, err := encodeRelayJournalRecord(record)
	if err != nil || len(raw) > relayJournalRecordMaxBytes {
		return errRelayJournalInvalid
	}
	key := relayJournalKey(record.Epoch, record.RequestID)
	if record.State == "completed" && journal.pendingInstalled[key] {
		// A previous rename installed these exact bytes but its final flush
		// failed. Reflush in place instead of needing a second full result's
		// temporary-file space; the original execution reservation still holds.
		if err := journal.flushInstalledLocked(key + ".json"); err != nil {
			return errRelayJournalUnavailable
		}
		journal.reserved -= journal.reservations[key]
		if !relayControlPayload(record.Payload) {
			journal.regularReserved -= journal.reservations[key]
		}
		journal.reservations[key] = 0
		journal.entries[key] = cloneRelayJournalRecord(record)
		delete(journal.pendingInstalled, key)
		return nil
	}
	oldSize, oldReserve, newSize := journal.sizes[key], journal.reservations[key], int64(len(raw))
	base := journal.bytes + journal.reserved - oldReserve
	if base+newSize > journal.limits.bytes || base-oldSize+newSize+reserveAfter > journal.limits.bytes {
		return errRelayJournalCapacity
	}
	regular := !relayControlPayload(record.Payload)
	if regular {
		base := journal.regularBytes + journal.regularReserved - oldReserve
		limit := journal.limits.bytes - journal.limits.controlBytes
		if base+newSize > limit || base-oldSize+newSize+reserveAfter > limit {
			return errRelayJournalCapacity
		}
	}
	name, temporary := key+".json", ".relay-journal-"+key+".tmp"
	info, err := journal.root.Lstat(name)
	if oldSize == 0 {
		if !os.IsNotExist(err) {
			return journal.storageFailureLocked()
		}
	} else if err != nil || !info.Mode().IsRegular() || info.Size() != oldSize {
		return journal.storageFailureLocked()
	}
	file, err := journal.root.OpenFile(temporary, os.O_WRONLY|os.O_CREATE|os.O_EXCL|os.O_SYNC, 0600)
	if err != nil {
		return errRelayJournalUnavailable
	}
	defer journal.root.Remove(temporary)
	if _, err = file.Write(raw); err == nil {
		err = file.Sync()
	}
	closeErr := file.Close()
	if err != nil || closeErr != nil || journal.root.Rename(temporary, name) != nil {
		return errRelayJournalUnavailable
	}
	// Track the installed size even if a later flush fails. completed is kept
	// non-executable in memory until its final flush succeeds, and complete
	// can retry the exact same immutable result after storage recovers.
	journal.bytes += newSize - oldSize
	if regular {
		journal.regularBytes += newSize - oldSize
	}
	journal.sizes[key] = newSize
	if record.State == "completed" {
		journal.pendingInstalled[key] = true
		if existing := journal.entries[key]; existing != nil && existing.State == "received" {
			candidate := cloneRelayJournalRecord(existing)
			candidate.State = "unknown"
			journal.entries[key] = candidate
		}
	}
	// Flush the installed file as well. On Windows this uses FlushFileBuffers
	// on a write-through file handle; directory fsync is a Unix operation.
	if journal.flushInstalledLocked(name) != nil {
		if record.State == "completed" {
			return errRelayJournalUnavailable
		}
		// A running rename may have committed. Poison this owner rather than
		// allowing a retry to execute from stale in-memory received state.
		return journal.storageFailureLocked()
	}
	journal.reserved += reserveAfter - oldReserve
	if regular {
		journal.regularReserved += reserveAfter - oldReserve
	}
	journal.entries[key], journal.byRequest[record.RequestID] = cloneRelayJournalRecord(record), key
	journal.sizes[key], journal.reservations[key] = newSize, reserveAfter
	return nil
}

func (journal *relayJournal) flushInstalledLocked(name string) error {
	file, err := journal.root.OpenFile(name, os.O_RDWR|os.O_SYNC, 0600)
	if err != nil {
		return errRelayJournalUnavailable
	}
	syncErr, closeErr := journal.syncInstalled(file), file.Close()
	if syncErr != nil || closeErr != nil {
		return errRelayJournalUnavailable
	}
	return journal.syncDirectoryLocked()
}

func (journal *relayJournal) syncDirectoryLocked() error {
	if runtime.GOOS == "windows" {
		return nil
	}
	directory, err := journal.root.Open(".")
	if err != nil {
		return err
	}
	syncErr, closeErr := directory.Sync(), directory.Close()
	if syncErr != nil {
		return syncErr
	}
	return closeErr
}

// close must run after all local execution/result workers have stopped.
func (journal *relayJournal) close() error {
	journal.mu.Lock()
	defer journal.mu.Unlock()
	if journal.closed {
		return nil
	}
	journal.closed = true
	rootErr, ownerErr := journal.root.Close(), journal.owner.Close()
	if rootErr != nil || ownerErr != nil {
		return errRelayJournalUnavailable
	}
	return nil
}
