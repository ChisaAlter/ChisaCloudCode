package main

import (
	"crypto/sha256"
	"fmt"
	"strings"
	"testing"
)

func TestWorkspaceAPIPortAndTunnelForwarding(t *testing.T) {
	for _, test := range []struct {
		name    string
		url     string
		account string
		port    string
		host    string
	}{
		{"account public HTTPS 2096", "https://example.invalid:2096", "account-1", "8791", "host.docker.internal"},
		{"account instance public HTTPS 2096", "https://example.invalid:2096/instances/account-1", "account-1", "8791", "host.docker.internal"},
		{"account public HTTPS default", "https://example.invalid", "account-1", "8791", "host.docker.internal"},
		{"manual HTTPS explicit port", "https://example.invalid:2096", "", "2096", "127.0.0.1"},
		{"manual HTTP custom port", "http://manual.test:9123", "", "9123", "127.0.0.1"},
		{"manual HTTP default", "http://manual.test", "", "8791", "127.0.0.1"},
		{"manual HTTPS default", "https://manual.test", "", "8791", "127.0.0.1"},
	} {
		t.Run(test.name, func(t *testing.T) {
			cfg := Config{ServerURL: test.url, WorkspaceAccount: test.account, SSHHost: "SSH.Example", SSHUser: "user"}
			if got := workspaceAPIPort(cfg); got != test.port {
				t.Fatalf("workspace API port = %q, want %q", got, test.port)
			}
			args := newTunnel(cfg, "", nil).forwardArgs()
			want := fmt.Sprintf("127.0.0.1:%d:%s:%s", apiLocalPort, test.host, test.port)
			if len(args) != 5 || args[1] != "-L" || args[2] != want {
				t.Fatalf("SSH forwarding args = %v, want API forward %q", args, want)
			}
			if test.account == "" {
				wantIdentity := "ssh.example:" + test.port + "/user"
				if got := serverIdentity(cfg); got != wantIdentity {
					t.Fatalf("manual identity = %q, want %q", got, wantIdentity)
				}
			}
		})
	}
}

func TestWorkspaceAPIPortPreservesManagedIdentity(t *testing.T) {
	cfg := Config{
		WorkspaceLoginURL: "https://example.invalid:2096", ServerURL: "https://example.invalid:2096/instances/account-1",
		WorkspaceAccount: "account-1", WorkspaceRoot: "/srv/workspaces/account-1", SSHPort: 22001,
	}
	owner := strings.Join([]string{cfg.WorkspaceLoginURL, cfg.ServerURL, cfg.WorkspaceAccount, cfg.WorkspaceRoot}, "\n")
	want := fmt.Sprintf("account:%x", sha256.Sum256([]byte(owner)))
	if got := serverIdentity(cfg); got != want {
		t.Fatalf("managed identity changed for existing mappings: %q, want %q", got, want)
	}
	cfg.SSHPort++
	if got := serverIdentity(cfg); got != want {
		t.Fatal("managed identity changed with its SSH transport port")
	}
	cfg.ServerURL = "https://example.invalid:2096/instances/account-2"
	if serverIdentity(cfg) == want {
		t.Fatal("managed identity no longer distinguishes public instances")
	}
}
