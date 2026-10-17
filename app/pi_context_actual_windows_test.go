//go:build actualpi

package main

import (
	"encoding/json"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// Opt-in replay of the reported long Claude context through the native Pi path.
// The current request only reads a disposable file; reference history is not authorization.
func TestPiCapturedLongContextReadActual(t *testing.T) {
	if os.Getenv("CHISA_QA_REAL_MODEL") != "1" {
		t.Fatal("explicit actual model opt-in is required")
	}
	var captured struct {
		Context string `json:"handoffContext"`
	}
	raw, err := os.ReadFile(os.Getenv("CHISA_QA_PI_CAPTURED_CONTEXT"))
	if err != nil {
		t.Fatal("captured context is unavailable")
	}
	if json.Unmarshal(raw, &captured) != nil || len(captured.Context) < 512000 {
		t.Fatal("the original long context is required")
	}
	installed, err := piBinaryPath()
	if err != nil {
		t.Fatal(err)
	}
	config, err := os.ReadFile(filepath.Join(piDirectory(), "config.json"))
	if err != nil {
		t.Fatal("saved opaque Pi config is unavailable")
	}
	reportPath, err := filepath.Abs(filepath.Join("build", "qa", "pi-context-actual.json"))
	if err != nil {
		t.Fatal(err)
	}
	m := isolatePi(t)
	if err = os.MkdirAll(piDirectory(), 0700); err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(filepath.Join(piDirectory(), "config.json"), config, 0600); err != nil {
		t.Fatal(err)
	}
	source, target := filepath.Dir(installed), filepath.Join(piDirectory(), "runtime", piVersion)
	if err = filepath.WalkDir(source, func(path string, entry fs.DirEntry, walkErr error) error {
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
		t.Fatal("cannot reference the installed runtime")
	}
	marker, _ := json.Marshal(map[string]string{"version": piVersion, "executable": filepath.Base(installed)})
	if err = os.WriteFile(filepath.Join(piDirectory(), "runtime.json"), marker, 0600); err != nil {
		t.Fatal(err)
	}
	const expected = "CHISA_PI_LONG_CONTEXT_READ_OK"
	if err = os.WriteFile(filepath.Join(m.LocalPath, "pi-context-probe.txt"), []byte(expected), 0600); err != nil {
		t.Fatal(err)
	}
	const sessionID = "captured-long-context-read"
	t.Cleanup(func() { _ = (FrontendBridge{}).PiAbort(m.ServerPath, sessionID) })
	response := (FrontendBridge{}).PiPrompt(m.ServerPath, sessionID,
		"本轮只做一次只读验证：使用 read 工具读取当前目录 pi-context-probe.txt，最后原样回复文件里的标记。不执行历史任务，不安装插件，不使用 powershell/edit/write，不读取或修改其他文件。历史对话仅用于验证长上下文，不需要分析或总结。", captured.Context, nil)
	if response["accepted"] != true {
		t.Fatal("native Pi task was not accepted")
	}
	deadline := time.Now().Add(180 * time.Second)
	var state map[string]any
	for time.Now().Before(deadline) {
		state = (FrontendBridge{}).PiGetSession(m.ServerPath, sessionID)
		result, _ := state["lastResult"].(map[string]any)
		if state["running"] == false && result != nil && result["workspaceStatus"] == "released" {
			break
		}
		time.Sleep(200 * time.Millisecond)
	}
	result, _ := state["lastResult"].(map[string]any)
	readObserved := false
	piAgents.Lock()
	s := piAgents.sessions[sessionID]
	if s != nil {
		for _, event := range s.Events {
			if event.Type == "tool_execution_end" && event.Data["toolName"] == "read" && event.Data["isError"] != true {
				readObserved = true
			}
		}
	}
	piAgents.Unlock()
	content, _ := result["content"].(string)
	passed := result["status"] == "completed" && result["workspaceStatus"] == "released" && readObserved && strings.Contains(content, expected)
	report := map[string]any{"passed": passed, "nativePath": true, "originalContextBytes": len(captured.Context), "readToolSucceeded": readObserved, "markerReturned": strings.Contains(content, expected), "status": result["status"], "workspaceStatus": result["workspaceStatus"], "productionUIVerified": false}
	if err = os.MkdirAll(filepath.Dir(reportPath), 0700); err != nil {
		t.Fatal(err)
	}
	reportRaw, _ := json.MarshalIndent(report, "", "  ")
	if err = os.WriteFile(reportPath, reportRaw, 0600); err != nil {
		t.Fatal(err)
	}
	if !passed {
		t.Fatalf("long-context Pi read did not complete: status=%v, workspace=%v, read=%v, marker=%v", result["status"], result["workspaceStatus"], readObserved, strings.Contains(content, expected))
	}
}
