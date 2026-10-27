package main

import (
	"os"
	"testing"
	"time"
)

// Opt-in process holder for the real reverse-tunnel smoke test. It starts the
// same embedded agent used by the desktop and keeps it alive for the external
// VPS probe; ordinary test runs skip it.
func TestAgentSmokeServe(t *testing.T) {
	if os.Getenv("CHISA_AGENT_SMOKE") != "1" {
		t.Skip("set CHISA_AGENT_SMOKE=1 to hold the local agent for a reverse-tunnel probe")
	}
	agent, err := startLocalWorkspaceAgent(18765)
	if err != nil {
		t.Fatal(err)
	}
	defer agent.Close()
	if tokenFile := os.Getenv("CHISA_AGENT_SMOKE_TOKEN_FILE"); tokenFile != "" {
		if err := os.WriteFile(tokenFile, []byte(agent.token), 0600); err != nil {
			t.Fatal(err)
		}
	}
	seconds := 90
	if raw := os.Getenv("CHISA_AGENT_SMOKE_SECONDS"); raw != "" {
		if parsed, parseErr := time.ParseDuration(raw + "s"); parseErr == nil {
			seconds = int(parsed / time.Second)
		}
	}
	t.Logf("agent listening on %d", agent.port)
	time.Sleep(time.Duration(seconds) * time.Second)
}
