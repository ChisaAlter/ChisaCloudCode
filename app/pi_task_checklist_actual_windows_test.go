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

// Two safe real-model turns through PiPrompt. The saved DPAPI configuration is
// copied opaquely; only the production runtime decrypts it. Lease/sync transport
// remains mocked, and neither the installed sessions nor user projects are used.
func TestPiTaskChecklistActual(t *testing.T) {
	if os.Getenv("CHISA_QA_REAL_MODEL") != "1" {
		t.Fatal("explicit actual model opt-in is required")
	}
	binary, err := piBinaryPath()
	if err != nil {
		t.Fatal(err)
	}
	config, err := os.ReadFile(filepath.Join(piDirectory(), "config.json"))
	if err != nil {
		t.Fatal("saved opaque Pi configuration is unavailable")
	}
	reportPath, err := filepath.Abs(filepath.Join("build", "qa", "pi-task-checklist-actual.json"))
	if err != nil {
		t.Fatal(err)
	}
	m := isolatePi(t)
	if err := os.MkdirAll(piDirectory(), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(piDirectory(), "config.json"), config, 0600); err != nil {
		t.Fatal(err)
	}
	source, target := filepath.Dir(binary), filepath.Join(piDirectory(), "runtime", piVersion)
	if err := filepath.WalkDir(source, func(path string, entry fs.DirEntry, failure error) error {
		if failure != nil {
			return failure
		}
		relative, err := filepath.Rel(source, path)
		if err != nil {
			return err
		}
		to := filepath.Join(target, relative)
		if entry.IsDir() {
			return os.MkdirAll(to, 0700)
		}
		return os.Link(path, to)
	}); err != nil {
		t.Fatal("cannot reference installed Pi runtime privately")
	}
	installed, _ := json.Marshal(map[string]string{"version": piVersion, "executable": filepath.Base(binary)})
	if err := os.WriteFile(filepath.Join(piDirectory(), "runtime.json"), installed, 0600); err != nil {
		t.Fatal(err)
	}
	marker := "PI_THIS_TURN_" + randHex(8)
	if err := os.WriteFile(filepath.Join(m.LocalPath, "round-marker.txt"), []byte(marker), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(m.LocalPath, "docs", "features"), 0700); err != nil {
		t.Fatal(err)
	}
	checklist := "# 本机验收清单\n1. 使用 read 读取 round-marker.txt，最终答复必须原样记录这个本轮唯一标记。\n2. 使用 powershell 执行只读命令：(Get-Item -LiteralPath './round-marker.txt').Length 。最终答复记录实际输出的字节数。\n3. 本轮不要修改文件，不要启动程序或安装软件。说明桌面视觉验收需要人工操作。\n"
	if err := os.WriteFile(filepath.Join(m.LocalPath, "docs", "features", "projects-steward-acceptance.md"), []byte(checklist), 0600); err != nil {
		t.Fatal(err)
	}
	history := strings.Repeat("Claude 工具结果：旧检查记录，仅供参考。\n", 10000) + "\n用户：开发完成了？\nClaude：是的，开发部分已完成。P1-P4 全部完成，26/26、12/12、54/54、79/90。需要你自己在本机验收。"
	const sessionID = "task-checklist-actual"
	t.Cleanup(func() { _ = (FrontendBridge{}).PiAbort(m.ServerPath, sessionID) })
	waitResult := func() (map[string]any, map[string]any) {
		t.Helper()
		deadline := time.Now().Add(180 * time.Second)
		for time.Now().Before(deadline) {
			state := (FrontendBridge{}).PiGetSession(m.ServerPath, sessionID)
			last, _ := state["lastResult"].(map[string]any)
			if state["running"] == false && last != nil && last["workspaceStatus"] == "released" {
				return state, last
			}
			time.Sleep(200 * time.Millisecond)
		}
		t.Fatal("real model task did not settle within 180 seconds")
		return nil, nil
	}
	const exactRequest = "按 docs/features/projects-steward-acceptance.md 在本机走一遍"
	if result := (FrontendBridge{}).PiPrompt(m.ServerPath, sessionID, exactRequest, history, nil); result["accepted"] != true {
		t.Fatal("native checklist task was not accepted")
	}
	state, first := waitResult()
	firstContent, _ := first["content"].(string)
	read, shell := false, false
	piAgents.Lock()
	s := piAgents.sessions[sessionID]
	for _, event := range s.Events {
		if event.Type == "tool_execution_end" && event.Data["isError"] == false {
			read = read || event.Data["toolName"] == "read"
			shell = shell || event.Data["toolName"] == "powershell"
		}
	}
	piAgents.Unlock()
	firstPassed := first["status"] == "completed" && read && shell && strings.Contains(firstContent, marker) && first["failedToolCalls"] == 0
	report := map[string]any{"passed": false, "nativePath": true, "realInstalledPiRuntime": true, "actualModel": true, "workspaceLeaseAndSynchronization": "mocked private mapping; actual Mutagen covered separately", "productionUIVerified": false, "request": exactRequest, "claudeReferenceChars": len(history), "checklist": map[string]any{"passed": firstPassed, "readSucceeded": read, "powershellSucceeded": shell, "newMarkerReturned": strings.Contains(firstContent, marker), "result": first}, "followup": "not run"}
	writeReport := func() {
		t.Helper()
		if err := os.MkdirAll(filepath.Dir(reportPath), 0700); err != nil {
			t.Fatal(err)
		}
		raw, _ := json.MarshalIndent(report, "", "  ")
		if err := os.WriteFile(reportPath, raw, 0600); err != nil {
			t.Fatal(err)
		}
	}
	if !firstPassed {
		writeReport()
		t.Fatalf("checklist task failed: status=%v read=%t powershell=%t marker=%t; report=%s", first["status"], read, shell, strings.Contains(firstContent, marker), reportPath)
	}
	if result := (FrontendBridge{}).PiPrompt(m.ServerPath, sessionID, "不用调用工具，只回复：PI_PLAIN_REPLY_OK", history, nil); result["accepted"] != true {
		t.Fatal("plain follow-up task was not accepted")
	}
	state, second := waitResult()
	secondContent, _ := second["content"].(string)
	secondPassed := second["status"] == "completed" && second["toolCalls"] == 0 && strings.TrimSpace(secondContent) == "PI_PLAIN_REPLY_OK"
	piAgents.Lock()
	sessionFile := piAgents.sessions[sessionID].SessionFile
	piAgents.Unlock()
	raw, err := os.ReadFile(sessionFile)
	if err != nil {
		t.Fatal(err)
	}
	promptLengths := []int{}
	for _, line := range strings.Split(string(raw), "\n") {
		var entry map[string]any
		if json.Unmarshal([]byte(line), &entry) == nil && entry["type"] == "message" {
			message, _ := entry["message"].(map[string]any)
			if message["role"] == "user" {
				text := piMessageText(message["content"])
				promptLengths = append(promptLengths, len(text))
				if len(text) > 5000 || strings.Contains(text, "26/26") {
					secondPassed = false
				}
			}
		}
	}
	report["followup"] = map[string]any{"passed": secondPassed, "result": second, "promptBytesByTurn": promptLengths, "runtimeReused": state["runtimeActive"] == true}
	report["passed"] = firstPassed && secondPassed && len(promptLengths) == 2
	writeReport()
	if report["passed"] != true {
		t.Fatalf("plain answer or context size regression; report=%s", reportPath)
	}
	t.Logf("real native checklist read+PowerShell/new marker passed; plain follow-up toolCalls=0; promptBytes=%v; report=%s", promptLengths, reportPath)
}
