//go:build !windows

package main

import (
	"os"
	"syscall"
)

func lockRelayJournal(root *os.Root) (*os.File, error) {
	file, err := root.OpenFile(".relay-owner.lock", os.O_RDWR|os.O_CREATE, 0600)
	if err != nil {
		return nil, errRelayJournalUnavailable
	}
	if err = syscall.Flock(int(file.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		file.Close()
		return nil, errRelayJournalUnavailable
	}
	return file, nil
}
