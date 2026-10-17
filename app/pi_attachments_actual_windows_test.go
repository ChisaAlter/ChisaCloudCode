//go:build actualpi

package main

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"image"
	"image/color"
	"image/png"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// One real model call verifies both file reading and image input. Project sync
// is isolated by the existing native test helper; no user project is touched.
func TestPiAttachmentsSavedModelActual(t *testing.T) {
	if os.Getenv("CHISA_QA_REAL_MODEL") != "1" {
		t.Fatal("explicit actual model opt-in is required")
	}
	installed, err := piBinaryPath()
	if err != nil {
		t.Fatal(err)
	}
	config, err := os.ReadFile(filepath.Join(piDirectory(), "config.json"))
	if err != nil {
		t.Fatal("saved Pi config is missing")
	}
	m := isolatePi(t)
	m.SyncName = "chisa-attachment-qa-" + randHex(8)
	if err := os.MkdirAll(piDirectory(), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(piDirectory(), "config.json"), config, 0600); err != nil {
		t.Fatal(err)
	}
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
		t.Fatal(err)
	}
	marker, _ := json.Marshal(map[string]string{"version": piVersion, "executable": filepath.Base(installed)})
	if err := os.WriteFile(filepath.Join(piDirectory(), "runtime.json"), marker, 0600); err != nil {
		t.Fatal(err)
	}
	canvas := image.NewRGBA(image.Rect(0, 0, 96, 96))
	for y := 0; y < 96; y++ {
		for x := 0; x < 96; x++ {
			canvas.SetRGBA(x, y, color.RGBA{R: 255, A: 255})
		}
	}
	var imageBytes bytes.Buffer
	if err := png.Encode(&imageBytes, canvas); err != nil {
		t.Fatal(err)
	}
	sessionID := "attachment-model-qa"
	t.Cleanup(func() { _ = (FrontendBridge{}).PiAbort(m.ServerPath, sessionID) })
	result := (FrontendBridge{}).PiPrompt(m.ServerPath, sessionID,
		"读取本轮文本附件中的标记，并看图片里的颜色。只回答标记和颜色，不检查项目，不修改文件。",
		"Claude 历史用户：修复整个项目。Claude：建议检查所有文件。",
		[]piAttachmentInput{
			{Name: "说明.txt", MimeType: "text/plain", DataBase64: base64.StdEncoding.EncodeToString([]byte("本轮标记：PI-ATTACH-6842"))},
			{Name: "颜色.png", MimeType: "image/png", DataBase64: base64.StdEncoding.EncodeToString(imageBytes.Bytes())},
		})
	if result["accepted"] != true {
		t.Fatalf("attachment turn not accepted: %v", result)
	}
	deadline := time.Now().Add(90 * time.Second)
	var view map[string]any
	for time.Now().Before(deadline) {
		view = (FrontendBridge{}).PiGetSession(m.ServerPath, sessionID)
		if view["running"] == false && view["owner"] == "claude" && view["lastResult"] != nil {
			break
		}
		time.Sleep(100 * time.Millisecond)
	}
	if view["running"] != false || view["owner"] != "claude" || view["lastResult"] == nil {
		t.Fatal("attachment model turn did not settle; no retry")
	}
	last := view["lastResult"].(map[string]any)
	content, _ := last["content"].(string)
	for _, event := range view["events"].([]piEvent) {
		if event.Type == "tool_execution_start" {
			t.Logf("Observed tool request: %v", event.Data)
		}
		if event.Type == "tool_execution_end" {
			t.Logf("Observed tool result: %v", event.Data)
		}
	}
	for _, attachment := range view["messages"].([]piMessage)[0].Attachments {
		if attachment.MimeType == "text/plain" {
			stored, _ := os.ReadFile(attachment.Path)
			t.Logf("Actual stored text: %s", stored)
		}
	}
	if last["status"] != "completed" || !strings.Contains(content, "PI-ATTACH-6842") || !(strings.Contains(content, "红") || strings.Contains(strings.ToLower(content), "red")) {
		t.Fatalf("model did not read the actual text and image attachments: %v", last)
	}
	if changed := last["changedFiles"].([]string); len(changed) != 0 {
		t.Fatal("reference attachment question modified project files")
	}
	messages := view["messages"].([]piMessage)
	if len(messages[0].Attachments) != 2 || messages[0].Attachments[0].Name != "说明.txt" {
		t.Fatal("native Pi history lost attachment metadata")
	}
	t.Logf("Real saved model read text and image; response: %s", content)
}
