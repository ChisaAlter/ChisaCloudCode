package main

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"path/filepath"
	"runtime"
	"strconv"
	"testing"
)

func TestLocalWorkspaceAgentHealthAndProbe(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("the workspace helper requires Windows")
	}
	helper, err := filepath.Abs(filepath.Join("resources", "ssh-workspace.ps1"))
	if err != nil {
		t.Fatal(err)
	}
	agent, err := startLocalWorkspaceAgentWithHelper(0, helper)
	if err != nil {
		t.Fatal(err)
	}
	defer agent.Close()

	health, err := http.Get("http://127.0.0.1:" + strconv.Itoa(agent.port) + "/health")
	if err != nil {
		t.Fatal(err)
	}
	healthBody, _ := io.ReadAll(health.Body)
	health.Body.Close()
	if health.StatusCode != http.StatusOK || !bytes.Contains(healthBody, []byte(`"ok":true`)) {
		t.Fatalf("unexpected health response: status=%d body=%s", health.StatusCode, healthBody)
	}

	root := t.TempDir()
	payload, _ := json.Marshal(map[string]any{
		"protocol": 1,
		"rootPath": root,
		"request":  map[string]any{"op": "probe"},
	})
	request, _ := http.NewRequest(http.MethodPost, "http://127.0.0.1:"+strconv.Itoa(agent.port)+"/v1/workspace", bytes.NewReader(payload))
	request.Header.Set("content-type", "application/json")
	request.Header.Set("X-Chisa-Agent-Token", agent.token)
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(response.Body)
	response.Body.Close()
	var result map[string]any
	if err := json.Unmarshal(body, &result); err != nil {
		t.Fatalf("invalid agent response %s: %v", body, err)
	}
	if result["ok"] != true || result["rootIdentity"] == "" || result["rootPath"] == "" {
		t.Fatalf("unexpected probe response: %s", body)
	}
}

func TestLocalWorkspaceAgentRejectsInvalidEnvelope(t *testing.T) {
	helper := filepath.Join(t.TempDir(), "missing.ps1")
	agent, err := startLocalWorkspaceAgentWithHelper(0, helper)
	if err != nil {
		t.Fatal(err)
	}
	defer agent.Close()
	request, _ := http.NewRequest(http.MethodPost, "http://127.0.0.1:"+strconv.Itoa(agent.port)+"/v1/workspace", bytes.NewReader([]byte(`{"protocol":2,"rootPath":"C:\\x","request":{"op":"probe"}}`)))
	request.Header.Set("content-type", "application/json")
	request.Header.Set("X-Chisa-Agent-Token", agent.token)
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", response.StatusCode)
	}
	body, _ := io.ReadAll(response.Body)
	if !bytes.Contains(body, []byte(`AGENT_REQUEST_INVALID`)) {
		t.Fatalf("unexpected error body: %s", body)
	}

	unauthorized, err := http.Post("http://127.0.0.1:"+strconv.Itoa(agent.port)+"/v1/workspace", "application/json", bytes.NewReader([]byte(`{"protocol":1,"rootPath":"C:\\x","request":{"op":"probe"}}`)))
	if err != nil {
		t.Fatal(err)
	}
	defer unauthorized.Body.Close()
	if unauthorized.StatusCode != http.StatusUnauthorized {
		t.Fatalf("expected 401 without token, got %d", unauthorized.StatusCode)
	}
}
