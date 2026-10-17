package main

import (
	"context"
	"fmt"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

func TestAppLoggingHelperProcess(t *testing.T) {
	mode := os.Getenv("CHISA_LOGGING_HELPER")
	if mode == "" {
		return
	}
	if err := configureAppLogging(os.Getenv("CHISA_LOGGING_DIRECTORY")); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(3)
	}
	if mode == "panic" {
		go func() { panic("CHISA_UNHANDLED_BACKGROUND_PANIC") }()
		select {}
	}
	log.Println("[app-logging-helper-complete]")
	os.Exit(0)
}

func TestAppLoggingCapturesRuntimeCrash(t *testing.T) {
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	for _, mode := range []string{"normal", "panic"} {
		t.Run(mode, func(t *testing.T) {
			dir := t.TempDir()
			ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
			defer cancel()
			cmd := hideCommandWindow(exec.CommandContext(ctx, executable, "-test.run=^TestAppLoggingHelperProcess$"))
			cmd.Env = append(os.Environ(), "CHISA_LOGGING_HELPER="+mode, "CHISA_LOGGING_DIRECTORY="+dir)
			output, runErr := cmd.CombinedOutput()
			if ctx.Err() != nil {
				t.Fatalf("logging helper did not finish: %v", ctx.Err())
			}
			if mode == "normal" && runErr != nil {
				t.Fatalf("normal startup failed: %v: %s", runErr, output)
			}
			if mode == "panic" {
				failure, ok := runErr.(*exec.ExitError)
				if !ok || failure.ExitCode() != 2 {
					t.Fatalf("expected uncaught panic exit 2, got %v: %s", runErr, output)
				}
			}
			data, err := os.ReadFile(filepath.Join(dir, "app.log"))
			if err != nil {
				t.Fatal(err)
			}
			text := string(data)
			if !strings.Contains(text, "--- launch ") || !strings.Contains(text, "[app-start] pid="+strconv.Itoa(cmd.Process.Pid)+" executable=") {
				t.Fatalf("startup identity did not reach the log: %s", text)
			}
			if mode == "panic" {
				if !strings.Contains(text, "panic: CHISA_UNHANDLED_BACKGROUND_PANIC") || !strings.Contains(text, "app_logging_test.go:") {
					t.Fatalf("uncaught background panic and stack were not saved: %s", text)
				}
			} else if !strings.Contains(text, "[app-logging-helper-complete]") || strings.Contains(text, "panic:") {
				t.Fatalf("normal startup log is incomplete: %s", text)
			}
		})
	}
}

func TestAppLoggingRejectsNonDirectory(t *testing.T) {
	file := filepath.Join(t.TempDir(), "not-a-directory")
	if err := os.WriteFile(file, []byte("preserve"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := configureAppLogging(file); err == nil {
		t.Fatal("logging setup silently accepted a non-directory")
	}
	data, err := os.ReadFile(file)
	if err != nil || string(data) != "preserve" {
		t.Fatalf("logging setup changed the existing file: %q, %v", data, err)
	}
}
