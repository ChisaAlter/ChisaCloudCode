//go:build actualpi

package main

import (
	"encoding/json"
	"fmt"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"
	"unsafe"
)

func piQAOwnedGUI(t *testing.T, p *piProcess, executable string) []uint32 {
	t.Helper()
	var list struct {
		Assigned uint32
		Count    uint32
		PIDs     [64]uintptr
	}
	p.guard.mu.Lock()
	job := p.guard.handle
	p.guard.mu.Unlock()
	query := piKernel32.NewProc("QueryInformationJobObject")
	ok, _, _ := query.Call(uintptr(job), 3, uintptr(unsafe.Pointer(&list)), unsafe.Sizeof(list), 0)
	if ok == 0 || list.Count > uint32(len(list.PIDs)) {
		t.Fatal("cannot inspect this Pi job's process ownership")
	}
	result := []uint32{}
	for _, pid := range list.PIDs[:list.Count] {
		handle, err := syscall.OpenProcess(0x1000, false, uint32(pid))
		if err != nil {
			continue
		}
		var name [32768]uint16
		size := uint32(len(name))
		ok, _, _ := piKernel32.NewProc("QueryFullProcessImageNameW").Call(uintptr(handle), 0, uintptr(unsafe.Pointer(&name[0])), uintptr(unsafe.Pointer(&size)))
		_ = syscall.CloseHandle(handle)
		if ok != 0 && strings.EqualFold(filepath.Clean(syscall.UTF16ToString(name[:size])), filepath.Clean(executable)) {
			result = append(result, uint32(pid))
		}
	}
	return result
}

func piQAWindowTitles(pids []uint32) []string {
	user32 := syscall.NewLazyDLL("user32.dll")
	titles := []string{}
	callback := syscall.NewCallback(func(window, _ uintptr) uintptr {
		var pid uint32
		user32.NewProc("GetWindowThreadProcessId").Call(window, uintptr(unsafe.Pointer(&pid)))
		for _, expected := range pids {
			if pid != expected {
				continue
			}
			visible, _, _ := user32.NewProc("IsWindowVisible").Call(window)
			var text [512]uint16
			count, _, _ := user32.NewProc("GetWindowTextW").Call(window, uintptr(unsafe.Pointer(&text[0])), uintptr(len(text)))
			if visible != 0 && count > 0 {
				titles = append(titles, syscall.UTF16ToString(text[:count]))
			}
		}
		return 1
	})
	user32.NewProc("EnumWindows").Call(callback, 0)
	return titles
}

// Explicit opt-in, one real saved-model task in the root-owned GUI fixture.
// Credentials are copied as opaque DPAPI bytes; only production decrypts them.
func TestPiSavedMiniMaxNativeToolsActual(t *testing.T) {
	if os.Getenv("CHISA_QA_REAL_MODEL") != "1" {
		t.Fatal("explicit actual model opt-in is required")
	}
	installed, err := piBinaryPath()
	if err != nil {
		t.Fatal(err)
	}
	config, err := os.ReadFile(filepath.Join(piDirectory(), "config.json"))
	if err != nil {
		t.Fatal("saved Pi DPAPI config is missing")
	}
	project, err := filepath.Abs(filepath.Join("build", "pi-agent-integration", "project"))
	if err != nil {
		t.Fatal(err)
	}
	gui := filepath.Join(project, "gui-demo.exe")
	if _, err := os.Stat(gui); err != nil {
		t.Fatal("root-owned native GUI fixture is missing")
	}
	m := isolatePi(t)
	m.LocalPath, m.ServerPath = project, "/srv/pi-real-model-qa"
	if err := os.MkdirAll(piDirectory(), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(piDirectory(), "config.json"), config, 0600); err != nil {
		t.Fatal(err)
	}
	// Hard links reference the official installed assets without a large copy or
	// junction/reparse-point cleanup. The existing installed runtime stays intact.
	source := filepath.Dir(installed)
	target := filepath.Join(piDirectory(), "runtime", piVersion)
	if err := filepath.WalkDir(source, func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		rel, err := filepath.Rel(source, path)
		if err != nil {
			return err
		}
		to := filepath.Join(target, rel)
		if entry.IsDir() {
			return os.MkdirAll(to, 0700)
		}
		return os.Link(path, to)
	}); err != nil {
		t.Fatal("cannot reference installed official runtime with private hard links")
	}
	marker, _ := json.Marshal(map[string]string{"version": piVersion, "executable": filepath.Base(installed)})
	if err := os.WriteFile(filepath.Join(piDirectory(), "runtime.json"), marker, 0600); err != nil {
		t.Fatal(err)
	}
	sessionID := fmt.Sprintf("real-model-%d", time.Now().UnixNano())
	report := map[string]any{"sessionId": sessionID, "piVersion": piVersion, "taskAttempts": 1, "visualAcceptance": false}
	reportPath := filepath.Join(filepath.Dir(project), "go-real-minimax-result.json")
	t.Cleanup(func() {
		state := (FrontendBridge{}).PiGetSession(m.ServerPath, sessionID)
		report["summary"] = map[string]any{"sessionId": state["sessionId"], "owner": state["owner"], "running": state["running"], "runtimeActive": state["runtimeActive"], "lastResult": state["lastResult"]}
		_ = (FrontendBridge{}).PiAbort(m.ServerPath, sessionID)
		encoded, _ := json.MarshalIndent(report, "", "  ")
		if err := os.WriteFile(reportPath, encoded, 0600); err != nil {
			t.Errorf("cannot save sanitized actual result")
		}
		workspaceLocks.Delete(m.ServerPath)
	})
	controlExe, _ := os.Executable()
	control := hideCommandWindow(exec.Command(controlExe, "-test.run=^TestPiJobHelperProcess$"))
	control.Env = append(os.Environ(), "CHISA_PI_JOB_HELPER=child")
	if err := control.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = control.Process.Kill(); _ = control.Wait() })
	controlHandle, err := syscall.OpenProcess(0x00100000, false, uint32(control.Process.Pid))
	if err != nil {
		t.Fatal(err)
	}
	defer syscall.CloseHandle(controlHandle)
	markerText := "ChisaCloudCode native Pi QA " + sessionID
	prompt := "仅验证当前目录的三个本地原生工具，各执行一次：先用 read 读取 CLAUDE.md；再用 write 写入 pi-qa-result.txt，正文严格为 " + markerText + "；最后用 powershell 执行 Start-Process -FilePath .\\gui-demo.exe 原生启动窗口，不等待GUI退出。禁止安装、联网、浏览其他目录或凭据、修改其他文件。完成后只报告实际读写及启动结果。"
	if response := (FrontendBridge{}).PiPrompt(m.ServerPath, sessionID, prompt, "", nil); response["accepted"] != true {
		t.Fatalf("real task was not accepted: %v", response)
	}
	deadline := time.Now().Add(150 * time.Second)
	var state map[string]any
	for time.Now().Before(deadline) {
		state = (FrontendBridge{}).PiGetSession(m.ServerPath, sessionID)
		if state["running"] == false && state["owner"] == "claude" && state["lastResult"] != nil {
			break
		}
		time.Sleep(100 * time.Millisecond)
	}
	if state["running"] != false || state["owner"] != "claude" || state["lastResult"] == nil {
		t.Fatal("one real model task did not settle and automatically release within 150 seconds; no retry")
	}
	last := state["lastResult"].(map[string]any)
	if last["status"] != "completed" {
		t.Fatalf("real model task failed: %v", last)
	}
	if failures, ok := last["observedToolFailures"].([]map[string]any); ok && len(failures) != 0 {
		t.Fatalf("real tool failure: %v", last)
	}
	seen := map[string]bool{}
	piAgents.Lock()
	s := piAgents.sessions[sessionID]
	p := s.process
	for _, event := range s.Events {
		if event.Type == "tool_execution_end" && event.Data["isError"] == false {
			name, _ := event.Data["toolName"].(string)
			seen[name] = true
		}
	}
	piAgents.Unlock()
	report["successfulNativeTools"] = seen
	for _, name := range []string{"read", "write", "powershell"} {
		if !seen[name] {
			t.Fatalf("real task did not successfully execute %s", name)
		}
	}
	actual, err := os.ReadFile(filepath.Join(project, "pi-qa-result.txt"))
	if err != nil || strings.TrimSpace(string(actual)) != markerText {
		t.Fatal("actual native write content does not match this task")
	}
	if p == nil || state["runtimeActive"] != true {
		t.Fatal("settled task lost its runtime")
	}
	owned := piQAOwnedGUI(t, p, gui)
	if len(owned) == 0 {
		t.Fatal("no native GUI process is owned by the actual Pi job")
	}
	handles := []syscall.Handle{}
	for _, pid := range owned {
		handle, err := syscall.OpenProcess(0x00100000, false, pid)
		if err != nil {
			t.Fatal(err)
		}
		handles = append(handles, handle)
		defer syscall.CloseHandle(handle)
	}
	report["guiPIDs"], report["windowTitlesAfterSettled"] = owned, piQAWindowTitles(owned)
	if state["owner"] != "claude" || state["runtimeActive"] != true || piWorkspaceOwned(m.ServerPath) {
		t.Fatal("real settled automatic release failed or stopped native runtime")
	}
	for _, handle := range handles {
		if status, err := syscall.WaitForSingleObject(handle, 0); err != nil || status != syscall.WAIT_TIMEOUT {
			t.Fatal("automatic idle release killed native GUI")
		}
	}
	report["guiAliveAfterAutomaticRelease"], report["windowTitlesAfterAutomaticRelease"] = true, piQAWindowTitles(owned)
	if response := (FrontendBridge{}).PiAbort(m.ServerPath, sessionID); response["ok"] != true || response["runtimeActive"] != false {
		t.Fatal("real explicit abort did not stop native runtime")
	}
	for _, handle := range handles {
		if status, err := syscall.WaitForSingleObject(handle, 3000); err != nil || status != syscall.WAIT_OBJECT_0 {
			t.Fatal("explicit Abort left native GUI running")
		}
	}
	if status, err := syscall.WaitForSingleObject(controlHandle, 0); err != nil || status != syscall.WAIT_TIMEOUT {
		t.Fatal("native abort affected unrelated control process")
	}
	report["guiStoppedAfterAbort"], report["outsideControlAliveAfterAbort"] = true, true
	t.Log("real saved-model read/write/powershell settled; native GUI retained after automatic idle release and stopped by Abort; unrelated control remained alive")
}
