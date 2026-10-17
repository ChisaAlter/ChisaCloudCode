//go:build actualpi

package main

import (
	"context"
	"errors"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

type piNoNetworkTransport struct{}

func (piNoNetworkTransport) RoundTrip(*http.Request) (*http.Response, error) {
	return nil, errors.New("actual cached Pi install must not download")
}

// Explicit opt-in: this installs the pinned official cached ZIP in real APPDATA.
// It does not open Pi config, contact a model, or change PATH/registry.
func TestPiCachedOfficialInstallActual(t *testing.T) {
	if os.Getenv("CHISA_QA_REAL_PI") != "1" {
		t.Fatal("set CHISA_QA_REAL_PI=1 to authorize the actual cached installation")
	}
	if _, err := piBinaryPath(); err == nil {
		t.Fatal("Pi is already installed; cache installation would not be exercised")
	}
	archive := filepath.Join(piDirectory(), "runtime", "pi-windows-x64.zip")
	if info, err := os.Stat(archive); err != nil || info.IsDir() {
		t.Fatal("pinned official cached ZIP is missing")
	}
	previous := http.DefaultTransport
	http.DefaultTransport = piNoNetworkTransport{}
	t.Cleanup(func() { http.DefaultTransport = previous })
	if result := (FrontendBridge{}).PiInstall(); result["ok"] != true {
		t.Fatalf("production cached install failed: %v", result)
	}
	binary, err := piBinaryPath()
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	cmd := hideCommandWindow(exec.CommandContext(ctx, binary, "--version"))
	cmd.Env = append(os.Environ(), "PI_CODING_AGENT_DIR="+t.TempDir())
	output, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("official Pi --version failed: %v", err)
	}
	if version := strings.TrimSpace(string(output)); version != piVersion {
		t.Fatalf("official Pi reported version %q; want %s", version, piVersion)
	}
	t.Logf("production cache install completed without network; official Pi --version=%s", piVersion)
}
