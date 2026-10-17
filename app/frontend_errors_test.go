package main

import (
	"bytes"
	"encoding/json"
	"log"
	"strings"
	"testing"
	"unicode/utf8"
)

func TestFrontendErrorReportLogsOnlyContext(t *testing.T) {
	var output bytes.Buffer
	writer, flags, prefix := log.Writer(), log.Flags(), log.Prefix()
	log.SetOutput(&output)
	log.SetFlags(0)
	log.SetPrefix("")
	t.Cleanup(func() {
		log.SetOutput(writer)
		log.SetFlags(flags)
		log.SetPrefix(prefix)
	})

	var report FrontendErrorReport
	err := json.Unmarshal([]byte(`{"source":"react-boundary","path":"/session/local?token=SECRET_QUERY#SECRET_FRAGMENT","message":"Render failed\nsecond line","stack":"Error: Render failed\n    at render","componentStack":"\n    at Chat","data":"SECRET_DATA","messages":["SECRET_CONVERSATION"],"headers":{"Authorization":"SECRET_AUTH"}}`), &report)
	if err != nil {
		t.Fatal(err)
	}
	(FrontendBridge{}).ReportFrontendError(report)

	line := output.String()
	if !strings.HasPrefix(line, "[frontend-error] ") || strings.Count(line, "\n") != 1 || strings.Contains(line, "\r") {
		t.Fatalf("error report is not a single structured log line: %q", line)
	}
	if strings.Contains(line, "SECRET_") {
		t.Fatalf("error report includes URL secrets or unrelated data: %q", line)
	}
	var fields map[string]string
	if err := json.Unmarshal([]byte(strings.TrimSuffix(strings.TrimPrefix(line, "[frontend-error] "), "\n")), &fields); err != nil {
		t.Fatal(err)
	}
	expected := map[string]string{
		"source":         "react-boundary",
		"path":           "/session/local",
		"message":        "Render failed\nsecond line",
		"stack":          "Error: Render failed\n    at render",
		"componentStack": "\n    at Chat",
	}
	if len(fields) != len(expected) {
		t.Fatalf("expected exactly five context fields, got %v", fields)
	}
	for name, value := range expected {
		if fields[name] != value {
			t.Errorf("%s = %q, want %q", name, fields[name], value)
		}
	}
}

func TestFrontendErrorReportBoundsUTF8Fields(t *testing.T) {
	var output bytes.Buffer
	writer, flags, prefix := log.Writer(), log.Flags(), log.Prefix()
	log.SetOutput(&output)
	log.SetFlags(0)
	log.SetPrefix("")
	t.Cleanup(func() {
		log.SetOutput(writer)
		log.SetFlags(flags)
		log.SetPrefix(prefix)
	})

	text := strings.Repeat("\u754c", 4000)
	(FrontendBridge{}).ReportFrontendError(FrontendErrorReport{
		Source:         text,
		Path:           "/" + text + "?token=SECRET_QUERY#SECRET_FRAGMENT",
		Message:        text,
		Stack:          text,
		ComponentStack: text,
	})
	var fields map[string]string
	line := strings.TrimSuffix(strings.TrimPrefix(output.String(), "[frontend-error] "), "\n")
	if err := json.Unmarshal([]byte(line), &fields); err != nil {
		t.Fatal(err)
	}
	expected := map[string]string{
		"source":         strings.Repeat("\u754c", 21),
		"path":           "/" + strings.Repeat("\u754c", 170),
		"message":        strings.Repeat("\u754c", 682),
		"stack":          strings.Repeat("\u754c", 2730),
		"componentStack": strings.Repeat("\u754c", 2730),
	}
	for name, value := range expected {
		if fields[name] != value || !utf8.ValidString(fields[name]) {
			t.Errorf("%s truncation differs or invalid UTF-8: got %d bytes, want %d", name, len(fields[name]), len(value))
		}
	}
	for _, text := range []string{"short", strings.Repeat("x", 64)} {
		if got := errorLogField(text, 64); got != text {
			t.Errorf("field within limit changed: got %q, want %q", got, text)
		}
	}
}
