package main

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
	"testing"
)

func TestProjectStorageCountsAllocationAndDeduplicatesHardLinks(t *testing.T) {
	root := t.TempDir()
	file := filepath.Join(root, "source.bin")
	if err := os.WriteFile(file, bytes.Repeat([]byte("source"), 12000), 0600); err != nil {
		t.Fatal(err)
	}
	before, err := projectAllocatedBytes(context.Background(), root)
	if err != nil || before <= 0 {
		t.Fatalf("real file allocation: bytes=%d error=%v", before, err)
	}
	if err = os.Link(file, filepath.Join(root, "hard-link.bin")); err != nil {
		t.Fatal(err)
	}
	after, err := projectAllocatedBytes(context.Background(), root)
	if err != nil || after != before {
		t.Fatalf("hard link must not double-count disk allocation: before=%d after=%d error=%v", before, after, err)
	}
	dependency := filepath.Join(root, "node_modules")
	if err = os.Mkdir(dependency, 0700); err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(filepath.Join(dependency, "dependency.bin"), bytes.Repeat([]byte("dependency"), 1000), 0600); err != nil {
		t.Fatal(err)
	}
	withDependency, err := projectAllocatedBytes(context.Background(), root)
	if err != nil || withDependency <= after {
		t.Fatalf("generated and dependency files must remain included: before=%d after=%d error=%v", after, withDependency, err)
	}
}

func TestProjectStorageOfflineAndMissingPathsStayUnavailable(t *testing.T) {
	previousStore, previousTunnel := store, tunnel
	t.Cleanup(func() { store, tunnel = previousStore, previousTunnel })
	previousConnection := apiConnection
	connection, err := newServerConnection("https://storage.test:8791", "https://storage.test:8791")
	if err != nil {
		t.Fatal(err)
	}
	connection.authenticated = true
	apiConnection = connection
	t.Cleanup(func() { connection.cancel(); apiConnection = previousConnection })
	cfg := Config{SSHHost: "storage.test", SSHUser: "test", ServerURL: "https://storage.test:8791", WorkspaceServerURL: "https://storage.test:8791"}
	local := t.TempDir()
	if err := os.WriteFile(filepath.Join(local, "source.bin"), bytes.Repeat([]byte("s"), 8193), 0600); err != nil {
		t.Fatal(err)
	}
	store = &Store{Cfg: cfg, Mappings: []*Mapping{
		{LocalPath: local, ServerPath: "/srv/available", ServerID: serverIdentity(cfg)},
		{LocalPath: filepath.Join(local, "missing"), ServerPath: "/srv/missing", ServerID: serverIdentity(cfg)},
	}}
	tunnel = nil
	result := (FrontendBridge{}).GetProjectStorage("/srv/available")
	available := result["/srv/available"]
	if available.LocalBytes == nil || *available.LocalBytes <= 0 || available.LocalError != "" {
		t.Fatalf("offline local filesystem must still be measured: %+v", available)
	}
	if available.ServerBytes != nil || available.ServerError != "服务器未连接" {
		t.Fatalf("offline server must not become a fake zero: %+v", available)
	}
	if len(result) != 1 {
		t.Fatal("measurement scanned unrelated projects")
	}
	missing := (FrontendBridge{}).GetProjectStorage("/srv/missing")["/srv/missing"]
	if missing.LocalBytes != nil || missing.LocalError == "" || missing.ServerBytes != nil {
		t.Fatalf("missing directory must remain unavailable: %+v", missing)
	}
	connection.authenticated = false
	if result := (FrontendBridge{}).GetProjectStorage("/srv/available"); len(result) != 0 {
		t.Fatal("signed-out account exposed workspace storage")
	}
}
