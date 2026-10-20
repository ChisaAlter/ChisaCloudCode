package main

import (
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestStartupDataDirectoryIsolation(t *testing.T) {
	t.Setenv("CHISA_DATA_DIR", "")
	t.Setenv("MYGO_ENV", "production")
	base, err := os.UserConfigDir()
	if err != nil {
		t.Fatal(err)
	}
	if got := dataDir(); got != filepath.Join(base, "ChisaCloudCode") {
		t.Fatalf("production profile changed: %q", got)
	}
	t.Setenv("MYGO_ENV", "development")
	t.Setenv("CHISA_DEV_SESSION", "startup-test")
	if got := dataDir(); got != filepath.Join(base, "ChisaCloudCode Dev", "sessions", "startup-test") {
		t.Fatalf("development profile is not isolated: %q", got)
	}
	custom := filepath.Join(t.TempDir(), "explicit-profile")
	t.Setenv("CHISA_DATA_DIR", custom)
	if got := dataDir(); got != custom {
		t.Fatalf("explicit profile ignored: %q", got)
	}
}

func TestStartupListenersChooseAvailableLoopbackPorts(t *testing.T) {
	// A previous/production window may already own the legacy fixed ports.
	var held []net.Listener
	for _, port := range []int{18792, 18082} {
		if listener, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", port)); err == nil {
			held = append(held, listener)
		}
	}
	t.Cleanup(func() {
		for _, listener := range held {
			listener.Close()
		}
	})
	if err := StartAPIProxy(); err != nil {
		t.Fatal(err)
	}
	if err := StartControlPlane("127.0.0.1:0"); err != nil {
		t.Fatal(err)
	}
	for _, port := range []int{apiProxyPort, controlPort} {
		if port == 0 || port == 18792 || port == 18082 {
			t.Fatalf("listener did not choose an independent port: %d", port)
		}
		connection, err := net.Dial("tcp", fmt.Sprintf("127.0.0.1:%d", port))
		if err != nil {
			t.Fatal(err)
		}
		connection.Close()
	}
	url := FrontendBridge{}.GetApiConnection()["webSocketUrl"].(string)
	if !strings.HasPrefix(url, fmt.Sprintf("ws://127.0.0.1:%d/channel/", apiProxyPort)) {
		t.Fatalf("bridge did not advertise the bound API port: %q", url)
	}
}
