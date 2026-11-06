//go:build windows

package main

import (
	"golang.org/x/sys/windows"
	"os"
)

// The kernel releases this lock if the process crashes. A second desktop must
// never recover or execute receipts owned by a still-running process.
func lockRelayJournal(root *os.Root) (*os.File, error) {
	file, err := root.OpenFile(".relay-owner.lock", os.O_RDWR|os.O_CREATE, 0600)
	if err != nil {
		return nil, errRelayJournalUnavailable
	}
	var overlapped windows.Overlapped
	err = windows.LockFileEx(windows.Handle(file.Fd()), windows.LOCKFILE_EXCLUSIVE_LOCK|windows.LOCKFILE_FAIL_IMMEDIATELY, 0, 1, 0, &overlapped)
	if err != nil {
		file.Close()
		return nil, errRelayJournalUnavailable
	}
	return file, nil
}
