package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"
)

const journalTestEpoch = "test-broker-epoch-0123456789"

func journalTestOpen(t *testing.T, directory string) *relayJournal {
	t.Helper()
	journal, err := newRelayJournal(directory)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := journal.close(); err != nil {
			t.Error(err)
		}
	})
	return journal
}

func journalTestJob(id string) agentRelayJob {
	return agentRelayJob{RequestID: id, DeadlineAt: time.Now().Add(time.Minute).UnixMilli(), Payload: json.RawMessage(`{"request":{"op":"write"},"value":"secret <>&"}`)}
}

func journalTestClaim(t *testing.T, journal *relayJournal, job agentRelayJob) *relayJournalRecord {
	t.Helper()
	record, fresh, err := journal.claim(journalTestEpoch, job)
	if err != nil || !fresh || record == nil || record.State != "received" {
		t.Fatalf("claim not durably received: fresh=%v record=%+v err=%v", fresh, record, err)
	}
	return record
}

func journalTestRecord(t *testing.T, journal *relayJournal, id string) *relayJournalRecord {
	t.Helper()
	record, err := journal.record(journalTestEpoch, id)
	if err != nil {
		t.Fatal(err)
	}
	return record
}

func TestRelayJournalReceivedRetainedAndResumable(t *testing.T) {
	directory := filepath.Join(t.TempDir(), "account", "profile")
	first := journalTestOpen(t, directory)
	job := journalTestJob("received")
	job.Payload = json.RawMessage(" {\n \"request\": {\"op\":\"write\"}, \"value\": \"<>&\\u0026\" \n} ")
	record := journalTestClaim(t, first, job)
	if record.PayloadSHA256 != relayJournalDigest(job.Payload) {
		t.Fatal("payload digest did not cover exact original bytes")
	}
	path := filepath.Join(directory, relayJournalKey(journalTestEpoch, job.RequestID)+".json")
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal("claim returned without creating its file", err)
	}
	onDisk, err := decodeRelayJournalRecord(raw)
	if err != nil || onDisk.State != "received" || !bytes.Equal(onDisk.Payload, job.Payload) {
		t.Fatal("received was not durably retained", err)
	}
	if err := first.close(); err != nil {
		t.Fatal(err)
	}
	second := journalTestOpen(t, directory)
	loaded, fresh, err := second.claim(journalTestEpoch, job)
	if err != nil || fresh || !reflect.DeepEqual(loaded, record) {
		t.Fatalf("received changed across restart: fresh=%v err=%v", fresh, err)
	}
	if err := second.markRunning(loaded); err != nil {
		t.Fatal("received request could not resume", err)
	}
	if loaded.State != "received" {
		t.Fatal("markRunning mutated the caller's snapshot")
	}
	if err := second.markRunning(record); !errors.Is(err, errRelayJournalState) {
		t.Fatal("received snapshot dispatched a second time", err)
	}
}

func TestRelayJournalRunningBecomesDurableUnknown(t *testing.T) {
	directory := t.TempDir()
	first := journalTestOpen(t, directory)
	job := journalTestJob("running")
	record := journalTestClaim(t, first, job)
	if err := first.markRunning(record); err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(filepath.Join(directory, relayJournalKey(journalTestEpoch, job.RequestID)+".json"))
	if err != nil {
		t.Fatal(err)
	}
	disk, err := decodeRelayJournalRecord(raw)
	if err != nil || disk.State != "running" {
		t.Fatal("markRunning returned before running was on disk", err)
	}
	if err := first.close(); err != nil {
		t.Fatal(err)
	}
	second := journalTestOpen(t, directory)
	unknown := journalTestRecord(t, second, job.RequestID)
	if unknown.State != "unknown" || unknown.Result != nil {
		t.Fatal("uncertain execution did not become unknown", unknown.State)
	}
	if err := second.markRunning(unknown); !errors.Is(err, errRelayJournalState) {
		t.Fatal("unknown execution could run again", err)
	}
	if err := second.close(); err != nil {
		t.Fatal(err)
	}
	third := journalTestOpen(t, directory)
	if record := journalTestRecord(t, third, job.RequestID); record.State != "unknown" {
		t.Fatal("unknown recovery was not persisted")
	}
	reply := agentRelayResponse{Status: 503, Body: `{"ok":false,"code":"AGENT_EXECUTION_UNCONFIRMED"}`}
	if err := third.complete(journalTestRecord(t, third, job.RequestID), reply); err != nil {
		t.Fatal("unknown could not retain explicit uncertainty response", err)
	}
}

func TestRelayJournalCompletedResultByteIdenticalAfterReload(t *testing.T) {
	directory := t.TempDir()
	first := journalTestOpen(t, directory)
	job := journalTestJob("completed")
	record := journalTestClaim(t, first, job)
	if err := first.markRunning(record); err != nil {
		t.Fatal(err)
	}
	reply := agentRelayResponse{Status: 207, Body: "\n { \"ok\":true,\"bytes\":\"<>&\\u0026\",\"utf8\":\"中文\" }\r\n"}
	if err := first.complete(record, reply); err != nil {
		t.Fatal(err)
	}
	if err := first.complete(record, reply); err != nil {
		t.Fatal("identical completion was not idempotent", err)
	}
	if err := first.complete(record, agentRelayResponse{Status: 500, Body: "different"}); !errors.Is(err, errRelayJournalConflict) {
		t.Fatal("completed result was mutable", err)
	}
	before, err := os.ReadFile(filepath.Join(directory, relayJournalKey(journalTestEpoch, job.RequestID)+".json"))
	if err != nil {
		t.Fatal(err)
	}
	if err := first.close(); err != nil {
		t.Fatal(err)
	}
	second := journalTestOpen(t, directory)
	loaded, fresh, err := second.claim(journalTestEpoch, job)
	if err != nil || fresh || loaded.State != "completed" || loaded.Result == nil || *loaded.Result != reply {
		t.Fatalf("completed result changed on reload: fresh=%v err=%v", fresh, err)
	}
	after, err := os.ReadFile(filepath.Join(directory, relayJournalKey(journalTestEpoch, job.RequestID)+".json"))
	if err != nil || !bytes.Equal(before, after) {
		t.Fatal("duplicate claim rewrote completed bytes", err)
	}
	loaded.Result.Body = "caller mutation"
	loaded.Payload[0] = '['
	if copy := journalTestRecord(t, second, job.RequestID); copy.Result.Body != reply.Body || !bytes.Equal(copy.Payload, job.Payload) {
		t.Fatal("snapshot mutation reached journal state")
	}
	metadata := second.metadata()
	if len(metadata) != 1 || metadata[0].Payload != nil || metadata[0].Result != nil {
		t.Fatal("metadata copied payload or result bytes")
	}
}

func TestRelayJournalDigestConflictAcrossEpochAndImmutableDeadline(t *testing.T) {
	journal := journalTestOpen(t, t.TempDir())
	job := journalTestJob("duplicate-id")
	original := journalTestClaim(t, journal, job)
	duplicate := job
	duplicate.DeadlineAt += time.Minute.Milliseconds()
	previous, fresh, err := journal.claim("different-broker-epoch-012345", duplicate)
	if err != nil || fresh || previous.Epoch != original.Epoch || previous.DeadlineAt != original.DeadlineAt || len(journal.records()) != 1 {
		t.Fatal("epoch changed an existing request's identity/deadline", fresh, err)
	}
	for _, epoch := range []string{journalTestEpoch, "different-broker-epoch-012345"} {
		conflict := job
		conflict.Payload = json.RawMessage(`{"request":{"op":"remove"}}`)
		if _, _, err := journal.claim(epoch, conflict); !errors.Is(err, errRelayJournalConflict) {
			t.Fatal("reused request ID accepted different payload", err)
		}
	}
	forged := *original
	forged.DeadlineAt++
	if err := journal.markRunning(&forged); !errors.Is(err, errRelayJournalConflict) {
		t.Fatal("forged deadline accepted", err)
	}
	forged = *original
	forged.Payload = json.RawMessage(`{"other":true}`)
	if err := journal.markRunning(&forged); !errors.Is(err, errRelayJournalConflict) {
		t.Fatal("forged payload accepted", err)
	}
}

func TestRelayJournalDeadlinesFailClosedBeforeExecution(t *testing.T) {
	journal := journalTestOpen(t, t.TempDir())
	now := time.Now().Truncate(time.Millisecond)
	journal.now = func() time.Time { return now }
	for _, deadline := range []int64{0, -1, now.UnixMilli(), now.Add(-time.Second).UnixMilli(), now.Add(relayJournalMaxFuture + time.Millisecond).UnixMilli()} {
		job := journalTestJob(fmt.Sprint(deadline))
		job.DeadlineAt = deadline
		if _, _, err := journal.claim(journalTestEpoch, job); err == nil {
			t.Fatalf("invalid deadline admitted: %d", deadline)
		}
	}
	job := journalTestJob("deadline-boundary")
	job.DeadlineAt = now.Add(relayJournalMaxFuture).UnixMilli()
	record := journalTestClaim(t, journal, job)
	now = time.UnixMilli(record.DeadlineAt)
	if err := journal.markRunning(record); !errors.Is(err, errRelayJournalExpired) {
		t.Fatal("expired received request could execute", err)
	}
	reply := agentRelayResponse{Status: 408, Body: `{"ok":false,"code":"AGENT_DEADLINE_EXCEEDED"}`}
	if err := journal.complete(record, reply); err != nil {
		t.Fatal("pre-execution refusal could not be completed", err)
	}
	if err := journal.markRunning(record); !errors.Is(err, errRelayJournalState) {
		t.Fatal("completed refusal could execute", err)
	}
}

func TestRelayJournalCountBoundReservesControlLane(t *testing.T) {
	journal := journalTestOpen(t, t.TempDir())
	journal.limits.records, journal.limits.controlRecords = 3, 1
	for _, id := range []string{"regular-1", "regular-2"} {
		journalTestClaim(t, journal, journalTestJob(id))
	}
	if _, _, err := journal.claim(journalTestEpoch, journalTestJob("regular-refused")); !errors.Is(err, errRelayJournalCapacity) {
		t.Fatal("regular records consumed control record reserve", err)
	}
	control := journalTestJob("control")
	control.Payload = json.RawMessage(`{"request":{"op":"operation_status"}}`)
	journalTestClaim(t, journal, control)
	if _, _, err := journal.claim(journalTestEpoch, journalTestJob("overflow")); !errors.Is(err, errRelayJournalCapacity) {
		t.Fatal("record count bound failed closed", err)
	}
	if len(journal.records()) != 3 {
		t.Fatal("refused claim was inserted")
	}
}

func TestRelayJournalByteBoundReservesResultBeforeRunning(t *testing.T) {
	journal := journalTestOpen(t, t.TempDir())
	journal.limits.bytes, journal.limits.controlBytes, journal.limits.resultBytes = 34000, 16000, 9000
	first := journalTestClaim(t, journal, journalTestJob("first"))
	second := journalTestClaim(t, journal, journalTestJob("second"))
	controlJob := journalTestJob("control")
	controlJob.Payload = json.RawMessage(`{"request":{"op":"job_cancel"}}`)
	control := journalTestClaim(t, journal, controlJob)
	if err := journal.markRunning(first); err != nil {
		t.Fatal("first result reservation refused", err)
	}
	if err := journal.markRunning(second); !errors.Is(err, errRelayJournalCapacity) {
		t.Fatal("execution admitted without maximum-result room", err)
	}
	if actual := journalTestRecord(t, journal, second.RequestID); actual.State != "received" {
		t.Fatal("failed capacity check changed received state")
	}
	if err := journal.markRunning(control); err != nil {
		t.Fatal("regular execution starved control capacity", err)
	}
	maximum := agentRelayResponse{Status: 200, Body: strings.Repeat("x", journal.limits.resultBytes)}
	if err := journal.complete(first, maximum); err != nil {
		t.Fatal("reserved maximum result could not be persisted", err)
	}
	if err := journal.complete(control, agentRelayResponse{Status: 200, Body: "ok"}); err != nil {
		t.Fatal(err)
	}
	if journal.bytes+journal.reserved > journal.limits.bytes || journal.regularBytes+journal.regularReserved > journal.limits.bytes-journal.limits.controlBytes {
		t.Fatal("journal exceeded byte budgets")
	}
	if err := journal.complete(second, agentRelayResponse{Status: 429, Body: "busy"}); err != nil {
		t.Fatal("reserved pre-execution refusal had no room", err)
	}
	if journal.reserved != 0 || journal.regularReserved != 0 {
		t.Fatal("completed records leaked result reservations")
	}
}

func TestRelayJournalClaimByteBudgetRefusesBeforePersistence(t *testing.T) {
	directory := t.TempDir()
	journal := journalTestOpen(t, directory)
	journal.limits.bytes, journal.limits.controlBytes = 8192, 0
	job := journalTestJob("oversized-for-budget")
	job.Payload = json.RawMessage(`{"value":"` + strings.Repeat("x", 6000) + `"}`)
	if _, _, err := journal.claim(journalTestEpoch, job); !errors.Is(err, errRelayJournalCapacity) {
		t.Fatal("claim exceeded byte budget", err)
	}
	if len(journal.records()) != 0 {
		t.Fatal("failed claim left executable memory state")
	}
	if _, err := os.Stat(filepath.Join(directory, relayJournalKey(journalTestEpoch, job.RequestID)+".json")); !os.IsNotExist(err) {
		t.Fatal("failed claim left a receipt", err)
	}
}

func TestRelayJournalPruneOnlyAfterDeadlineRetentionNeverLiveRunning(t *testing.T) {
	directory := t.TempDir()
	journal := journalTestOpen(t, directory)
	now := time.Now().Truncate(time.Millisecond)
	journal.now = func() time.Time { return now }
	deadline := now.Add(time.Minute).UnixMilli()
	for _, state := range []string{"received", "completed", "unknown", "running"} {
		job := journalTestJob(state)
		job.DeadlineAt = deadline
		record := journalTestClaim(t, journal, job)
		if state == "running" || state == "unknown" {
			if err := journal.markRunning(record); err != nil {
				t.Fatal(err)
			}
		}
		if state == "unknown" {
			if err := journal.close(); err != nil {
				t.Fatal(err)
			}
			journal = journalTestOpen(t, directory)
			journal.now = func() time.Time { return now }
		}
		if state == "completed" {
			if err := journal.complete(record, agentRelayResponse{Status: 200, Body: "unchanged"}); err != nil {
				t.Fatal(err)
			}
		}
	}
	unrelated := filepath.Join(directory, "unrelated.json")
	if err := os.WriteFile(unrelated, []byte("unrelated"), 0600); err != nil {
		t.Fatal(err)
	}
	child := filepath.Join(directory, strings.Repeat("f", 64)+".other")
	if err := os.Mkdir(child, 0700); err != nil {
		t.Fatal(err)
	}
	now = time.UnixMilli(deadline).Add(relayJournalRetention)
	if err := journal.prune(); err != nil || len(journal.records()) != 4 {
		t.Fatal("prune removed a record at/before retention boundary", err)
	}
	now = now.Add(time.Millisecond)
	if err := journal.prune(); err != nil {
		t.Fatal(err)
	}
	remaining := journal.records()
	if len(remaining) != 1 || remaining[0].State != "running" {
		t.Fatal("prune retained expired records or removed live running", remaining)
	}
	if raw, err := os.ReadFile(unrelated); err != nil || string(raw) != "unrelated" {
		t.Fatal("prune touched unrelated file", err)
	}
	if info, err := os.Stat(child); err != nil || !info.IsDir() {
		t.Fatal("prune touched unrelated directory", err)
	}
	if err := journal.complete(&remaining[0], agentRelayResponse{Status: 408, Body: "finished"}); err != nil {
		t.Fatal(err)
	}
	if err := journal.prune(); err != nil || len(journal.records()) != 0 || journal.bytes != 0 || journal.reserved != 0 {
		t.Fatal("finished expired work did not release capacity", err)
	}
}

func TestRelayJournalTransientCompleteFailureRetriesSameBytesOnly(t *testing.T) {
	for _, running := range []bool{false, true} {
		t.Run(fmt.Sprint("running=", running), func(t *testing.T) {
			directory := t.TempDir()
			journal := journalTestOpen(t, directory)
			record := journalTestClaim(t, journal, journalTestJob("storage-recovery"))
			if running {
				if err := journal.markRunning(record); err != nil {
					t.Fatal(err)
				}
			}
			// A directory at the known temp basename produces a real filesystem
			// write refusal without permissions that are ignored on Windows.
			blocker := filepath.Join(directory, ".relay-journal-"+relayJournalKey(record.Epoch, record.RequestID)+".tmp")
			if err := os.Mkdir(blocker, 0700); err != nil {
				t.Fatal(err)
			}
			reply := agentRelayResponse{Status: 503, Body: "immutable-result"}
			if err := journal.complete(record, reply); !errors.Is(err, errRelayJournalUnavailable) {
				t.Fatal("storage refusal not reported", err)
			}
			if err := journal.markRunning(record); !errors.Is(err, errRelayJournalState) {
				t.Fatal("completion failure made request executable", err)
			}
			if err := journal.complete(record, agentRelayResponse{Status: 503, Body: "changed"}); !errors.Is(err, errRelayJournalConflict) {
				t.Fatal("completion failure allowed result replacement", err)
			}
			if err := os.Remove(blocker); err != nil {
				t.Fatal(err)
			}
			if err := journal.complete(record, reply); err != nil {
				t.Fatal("completion did not recover after storage returned", err)
			}
			if err := journal.close(); err != nil {
				t.Fatal(err)
			}
			reloaded := journalTestOpen(t, directory)
			actual := journalTestRecord(t, reloaded, record.RequestID)
			if actual.State != "completed" || actual.Result == nil || *actual.Result != reply {
				t.Fatal("retried completion changed on reload")
			}
		})
	}
}

func TestRelayJournalCompleteRetryAfterInstalledFlushFailure(t *testing.T) {
	journal := journalTestOpen(t, t.TempDir())
	record := journalTestClaim(t, journal, journalTestJob("flush-recovery"))
	if err := journal.markRunning(record); err != nil {
		t.Fatal(err)
	}
	journal.syncInstalled = func(*os.File) error { return errors.New("injected flush failure") }
	reply := agentRelayResponse{Status: 200, Body: strings.Repeat("exact-result", 1024)}
	if err := journal.complete(record, reply); !errors.Is(err, errRelayJournalUnavailable) {
		t.Fatal("flush failure was not returned", err)
	}
	if current := journalTestRecord(t, journal, record.RequestID); current.State == "completed" {
		t.Fatal("unflushed completion was exposed as durable")
	}
	if err := journal.markRunning(record); !errors.Is(err, errRelayJournalState) {
		t.Fatal("flush failure allowed duplicate invocation", err)
	}
	journal.syncInstalled = (*os.File).Sync
	if err := journal.complete(record, reply); err != nil {
		t.Fatal("installed completion could not reflush", err)
	}
	current := journalTestRecord(t, journal, record.RequestID)
	if current.State != "completed" || current.Result == nil || *current.Result != reply || journal.reserved != 0 {
		t.Fatal("reflush changed result or leaked reservation")
	}
}

func TestRelayJournalExclusiveOwnerAndClosedRefusal(t *testing.T) {
	directory := t.TempDir()
	first := journalTestOpen(t, directory)
	record := journalTestClaim(t, first, journalTestJob("owned"))
	if duplicate, err := newRelayJournal(directory); err == nil {
		_ = duplicate.close()
		t.Fatal("second owner could recover a live journal")
	}
	if err := first.close(); err != nil {
		t.Fatal(err)
	}
	if err := first.markRunning(record); !errors.Is(err, errRelayJournalClosed) {
		t.Fatal("closed journal allowed invocation", err)
	}
	second := journalTestOpen(t, directory)
	if err := second.markRunning(journalTestRecord(t, second, record.RequestID)); err != nil {
		t.Fatal("ownership was not released on close", err)
	}
}

func TestRelayJournalConcurrentDuplicateDispatchOnlyOnce(t *testing.T) {
	journal := journalTestOpen(t, t.TempDir())
	job := journalTestJob("concurrent-id")
	var group sync.WaitGroup
	var mutex sync.Mutex
	freshCount, runningCount := 0, 0
	for range 24 {
		group.Add(1)
		go func() {
			defer group.Done()
			record, fresh, err := journal.claim(journalTestEpoch, job)
			if err != nil {
				t.Error(err)
				return
			}
			err = journal.markRunning(record)
			mutex.Lock()
			defer mutex.Unlock()
			if fresh {
				freshCount++
			}
			if err == nil {
				runningCount++
			} else if !errors.Is(err, errRelayJournalState) {
				t.Error(err)
			}
		}()
	}
	group.Wait()
	if freshCount != 1 || runningCount != 1 {
		t.Fatal("duplicate operation admitted", freshCount, runningCount)
	}
}

func TestRelayJournalCorruptRecordsFailClosedAndPreserveUnrelated(t *testing.T) {
	for _, mutate := range []string{"malformed", "digest", "filename", "directory"} {
		t.Run(mutate, func(t *testing.T) {
			directory := t.TempDir()
			journal := journalTestOpen(t, directory)
			record := journalTestClaim(t, journal, journalTestJob("corrupted"))
			if err := journal.close(); err != nil {
				t.Fatal(err)
			}
			path := filepath.Join(directory, relayJournalKey(record.Epoch, record.RequestID)+".json")
			switch mutate {
			case "malformed":
				if err := os.WriteFile(path, []byte("{"), 0600); err != nil {
					t.Fatal(err)
				}
			case "digest":
				record.Payload = json.RawMessage(`{"changed":true}`)
				raw, _ := encodeRelayJournalRecord(record)
				if err := os.WriteFile(path, raw, 0600); err != nil {
					t.Fatal(err)
				}
			case "filename":
				if err := os.Rename(path, filepath.Join(directory, strings.Repeat("f", 64)+".json")); err != nil {
					t.Fatal(err)
				}
			case "directory":
				if err := os.Remove(path); err != nil {
					t.Fatal(err)
				}
				if err := os.Mkdir(path, 0700); err != nil {
					t.Fatal(err)
				}
			}
			if reopened, err := newRelayJournal(directory); err == nil {
				_ = reopened.close()
				t.Fatal("invalid journal allowed relay execution")
			}
		})
	}
}

func TestRelayJournalRejectsSymlinkTraversal(t *testing.T) {
	base := t.TempDir()
	target := filepath.Join(base, "target")
	if err := os.Mkdir(target, 0700); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(base, "link")
	if err := os.Symlink(target, link); err != nil {
		t.Skip("symlink creation unavailable:", err)
	}
	if journal, err := newRelayJournal(filepath.Join(link, "journal")); err == nil {
		_ = journal.close()
		t.Fatal("journal traversed symlink directory")
	}
	if _, err := os.Stat(filepath.Join(target, "journal")); !os.IsNotExist(err) {
		t.Fatal("symlink target was modified", err)
	}
}
