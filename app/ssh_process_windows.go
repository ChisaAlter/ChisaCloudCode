package main

import (
	"fmt"
	"sync"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

// The job owns only the explicit SSH foreground child. Closing its handle also
// prevents an application crash from leaving that tunnel running. This is
// lifecycle ownership, not a sandbox for Windows project/build processes.
type windowsSshProcessOwner struct {
	mu     sync.Mutex
	handle windows.Handle
}

func newSshProcessOwner() (sshProcessOwner, error) {
	handle, err := windows.CreateJobObject(nil, nil)
	if err != nil {
		return nil, err
	}
	info := windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION{}
	info.BasicLimitInformation.LimitFlags = windows.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
	if _, err := windows.SetInformationJobObject(handle, windows.JobObjectExtendedLimitInformation, uintptr(unsafe.Pointer(&info)), uint32(unsafe.Sizeof(info))); err != nil {
		windows.CloseHandle(handle)
		return nil, err
	}
	return &windowsSshProcessOwner{handle: handle}, nil
}

func (owner *windowsSshProcessOwner) assign(pid int) error {
	owner.mu.Lock()
	defer owner.mu.Unlock()
	process, err := windows.OpenProcess(windows.PROCESS_SET_QUOTA|windows.PROCESS_TERMINATE, false, uint32(pid))
	if err != nil {
		return err
	}
	defer windows.CloseHandle(process)
	return windows.AssignProcessToJobObject(owner.handle, process)
}

// Termination plus an empty process count is the proof used by mutation
// receipts. Closing a job handle alone only initiates asynchronous termination.
func (owner *windowsSshProcessOwner) cleanup() error {
	owner.mu.Lock()
	defer owner.mu.Unlock()
	if owner.handle == 0 {
		return fmt.Errorf("process ownership is closed")
	}
	if err := windows.TerminateJobObject(owner.handle, 1); err != nil {
		return err
	}
	var info struct {
		User, Kernel, PeriodUser, PeriodKernel                           int64
		PageFaults, TotalProcesses, ActiveProcesses, TerminatedProcesses uint32
	}
	deadline := time.Now().Add(5 * time.Second)
	for {
		if err := windows.QueryInformationJobObject(owner.handle, windows.JobObjectBasicAccountingInformation, uintptr(unsafe.Pointer(&info)), uint32(unsafe.Sizeof(info)), nil); err != nil {
			return err
		}
		if info.ActiveProcesses == 0 {
			return nil
		}
		if time.Now().After(deadline) {
			return fmt.Errorf("process tree cleanup not confirmed")
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func (owner *windowsSshProcessOwner) close() {
	owner.mu.Lock()
	defer owner.mu.Unlock()
	if owner.handle != 0 {
		windows.CloseHandle(owner.handle)
		owner.handle = 0
	}
}
