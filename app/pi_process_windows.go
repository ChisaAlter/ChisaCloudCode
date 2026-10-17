//go:build windows

package main

import (
	"errors"
	"os/exec"
	"sync"
	"syscall"
	"unsafe"
)

var piKernel32 = syscall.NewLazyDLL("kernel32.dll")
var piCreateJob = piKernel32.NewProc("CreateJobObjectW")
var piSetJobInformation = piKernel32.NewProc("SetInformationJobObject")
var piAssignJob = piKernel32.NewProc("AssignProcessToJobObject")
var piCreateSnapshot = piKernel32.NewProc("CreateToolhelp32Snapshot")
var piThreadFirst = piKernel32.NewProc("Thread32First")
var piThreadNext = piKernel32.NewProc("Thread32Next")
var piOpenThread = piKernel32.NewProc("OpenThread")
var piResumeThread = piKernel32.NewProc("ResumeThread")

type piJobBasicLimits struct {
	PerProcessUserTimeLimit int64
	PerJobUserTimeLimit     int64
	LimitFlags              uint32
	MinimumWorkingSetSize   uintptr
	MaximumWorkingSetSize   uintptr
	ActiveProcessLimit      uint32
	Affinity                uintptr
	PriorityClass           uint32
	SchedulingClass         uint32
}

type piJobExtendedLimits struct {
	BasicLimits           piJobBasicLimits
	IOCounters            [6]uint64
	ProcessMemoryLimit    uintptr
	JobMemoryLimit        uintptr
	PeakProcessMemoryUsed uintptr
	PeakJobMemoryUsed     uintptr
}

type piThreadEntry struct {
	Size           uint32
	Usage          uint32
	ThreadID       uint32
	OwnerProcessID uint32
	BasePriority   int32
	DeltaPriority  int32
	Flags          uint32
}

type piProcessGuard struct {
	mu     sync.Mutex
	handle syscall.Handle
}

func preparePiProcess(cmd *exec.Cmd) {
	hideCommandWindow(cmd)
	// Assign the process to its Job Object before Pi can start any descendants.
	cmd.SysProcAttr.CreationFlags |= 0x00000004 // CREATE_SUSPENDED
}

func attachPiProcess(cmd *exec.Cmd) (*piProcessGuard, error) {
	job, _, _ := piCreateJob.Call(0, 0)
	if job == 0 {
		return nil, errors.New("CreateJobObject failed")
	}
	guard := &piProcessGuard{handle: syscall.Handle(job)}
	limits := piJobExtendedLimits{}
	limits.BasicLimits.LimitFlags = 0x00002000 // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
	ok, _, _ := piSetJobInformation.Call(job, 9, uintptr(unsafe.Pointer(&limits)), unsafe.Sizeof(limits))
	if ok == 0 {
		_ = guard.close()
		return nil, errors.New("SetInformationJobObject failed")
	}
	process, err := syscall.OpenProcess(0x0100|0x0001, false, uint32(cmd.Process.Pid)) // SET_QUOTA | TERMINATE
	if err != nil {
		_ = guard.close()
		return nil, errors.New("OpenProcess failed")
	}
	ok, _, _ = piAssignJob.Call(job, uintptr(process))
	_ = syscall.CloseHandle(process)
	if ok == 0 {
		_ = guard.close()
		return nil, errors.New("AssignProcessToJobObject failed")
	}
	snapshot, _, _ := piCreateSnapshot.Call(0x00000004, 0) // TH32CS_SNAPTHREAD
	if snapshot == ^uintptr(0) {
		_ = guard.close()
		return nil, errors.New("Thread snapshot failed")
	}
	defer syscall.CloseHandle(syscall.Handle(snapshot))
	entry := piThreadEntry{Size: uint32(unsafe.Sizeof(piThreadEntry{}))}
	ok, _, _ = piThreadFirst.Call(snapshot, uintptr(unsafe.Pointer(&entry)))
	for ok != 0 {
		if entry.OwnerProcessID == uint32(cmd.Process.Pid) {
			thread, _, _ := piOpenThread.Call(0x0002, 0, uintptr(entry.ThreadID)) // THREAD_SUSPEND_RESUME
			if thread == 0 {
				_ = guard.close()
				return nil, errors.New("OpenThread failed")
			}
			resumed, _, _ := piResumeThread.Call(thread)
			_ = syscall.CloseHandle(syscall.Handle(thread))
			if resumed == uintptr(0xffffffff) {
				_ = guard.close()
				return nil, errors.New("ResumeThread failed")
			}
			return guard, nil
		}
		entry.Size = uint32(unsafe.Sizeof(entry))
		ok, _, _ = piThreadNext.Call(snapshot, uintptr(unsafe.Pointer(&entry)))
	}
	_ = guard.close()
	return nil, errors.New("Pi primary thread not found")
}

func (g *piProcessGuard) close() error {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.handle == 0 {
		return nil
	}
	if err := syscall.CloseHandle(g.handle); err != nil {
		return err
	}
	g.handle = 0
	return nil
}
