package main

import (
	"compress/zlib"
	"context"
	"encoding/base64"
	"io"
	"regexp"
	"strings"
	"testing"
	"time"
	"unicode/utf16"
)

func TestSyncRemoteJobCommandFitsWindowsGitWorkerTransport(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	ctx = syncLeaseContext(ctx, "exact-test-lease")
	mapping := &Mapping{ServerPath: "/workspaces/project with ' quotes", BindingEpoch: "test-epoch"}
	for name, worker := range map[string]string{"apply": syncGitApplyWorker, "seed": syncGitSeedWorker} {
		t.Run(name, func(t *testing.T) {
			script := "setpriv --reuid=1000 --regid=1000 --clear-groups env HOME=/nonexistent python3 -c " + shellQuote(worker)
			remote, err := syncRemoteJobCommand(ctx, mapping, "shell", script)
			if err != nil {
				t.Fatal(err)
			}
			// Leave space for the SSH executable, host, configuration and flags.
			if length := len(utf16.Encode([]rune(remote))); length >= 24000 {
				t.Fatalf("remote command still exceeds safe Windows argument budget: %d", length)
			}
			encoded := regexp.MustCompile(`[A-Za-z0-9+/]{100,}={0,2}`).FindString(remote)
			if encoded == "" {
				t.Fatal("large embedded worker was not compressed")
			}
			data, err := base64.StdEncoding.DecodeString(encoded)
			if err != nil {
				t.Fatal(err)
			}
			reader, err := zlib.NewReader(strings.NewReader(string(data)))
			if err != nil {
				t.Fatal(err)
			}
			decoded, err := io.ReadAll(reader)
			reader.Close()
			if err != nil || string(decoded) != script {
				t.Fatalf("compressed worker changed script bytes: %v", err)
			}
		})
	}
}

func TestSyncRemoteJobCommandRetainsLeaseAndDeadlineGates(t *testing.T) {
	mapping := &Mapping{ServerPath: "/workspaces/fixture", BindingEpoch: "epoch"}
	if _, err := syncRemoteJobCommand(context.Background(), mapping, "shell", strings.Repeat("x", 40000)); err == nil {
		t.Fatal("large script bypassed exact lease gate")
	}
	ctx := syncLeaseContext(context.Background(), "lease")
	if _, err := syncRemoteJobCommand(ctx, mapping, "shell", "true"); err == nil {
		t.Fatal("command bypassed total deadline gate")
	}
	ctx, cancel := context.WithTimeout(ctx, time.Minute)
	cancel()
	if _, err := syncRemoteJobCommand(ctx, mapping, "shell", "true"); err == nil {
		t.Fatal("canceled operation produced a remote command")
	}
}
