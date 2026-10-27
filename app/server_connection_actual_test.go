//go:build windows

package main

import (
	"bufio"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"os"
	"strings"
	"testing"
	"time"
)

// This opt-in check uses a temporary account on the real server and never reads another user's password.
func TestAccountLiveGatewayNoSSH(t *testing.T) {
	credentialsPath := os.Getenv("CHISA_LOGIN_QA_CREDS")
	serviceURL := os.Getenv("CHISA_LOGIN_QA_URL")
	if credentialsPath == "" || serviceURL == "" {
		t.Skip("real account gateway credentials not supplied")
	}
	var credentials struct {
		Username string `json:"username"`
		Password string `json:"password"`
	}
	raw, err := os.ReadFile(credentialsPath)
	if err != nil {
		t.Fatal(err)
	}
	if err = json.Unmarshal(raw, &credentials); err != nil {
		t.Fatal(err)
	}
	previousStore, previousConnection := store, apiConnection
	t.Setenv("APPDATA", t.TempDir())
	store = loadStore(dataDir())
	store.Cfg.LoginURL = serviceURL
	if err := initializeServerConnection(); err != nil {
		t.Fatal(err)
	}
	defer func() {
		if apiConnection != nil {
			apiConnection.cancel()
		}
		store, apiConnection = previousStore, previousConnection
	}()
	bridge := FrontendBridge{}
	body, _ := json.Marshal(credentials)
	login := bridge.ServerRequest(bridge.BeginServerRequest(), "POST", "/api/auth/login", map[string]string{"Content-Type": "application/json"}, base64.StdEncoding.EncodeToString(body))
	if login.Status != 200 {
		t.Fatalf("real login returned HTTP %d", login.Status)
	}
	var session struct {
		Token string `json:"token"`
		User  struct {
			Username string `json:"username"`
		} `json:"user"`
	}
	raw, _ = base64.StdEncoding.DecodeString(login.BodyB64)
	if err := json.Unmarshal(raw, &session); err != nil || session.User.Username != credentials.Username {
		t.Fatal("incorrect real account identity")
	}
	expectedInstance := os.Getenv("CHISA_LOGIN_QA_INSTANCE")
	if expectedInstance == "" {
		expectedInstance = "user2"
	}
	if apiConnection.baseURL != serviceURL+"/instances/"+expectedInstance {
		t.Fatal("account routing depended on SSH or selected the wrong instance")
	}
	for _, endpoint := range []string{"/api/auth/user", "/api/projects"} {
		response := bridge.ServerRequest(bridge.BeginServerRequest(), "GET", endpoint, map[string]string{"Authorization": "Bearer " + session.Token}, "")
		if response.Status != 200 {
			t.Fatalf("real protected endpoint %s returned %d", endpoint, response.Status)
		}
	}
	otherInstance := "main"
	if expectedInstance == "main" {
		otherInstance = "user2"
	}
	request, _ := http.NewRequest("GET", serviceURL+"/instances/"+otherInstance+"/api/auth/user", nil)
	request.Header.Set("Authorization", "Bearer "+session.Token)
	response, err := apiConnection.client.Do(request)
	if err != nil {
		t.Fatal("cross-instance check could not connect")
	}
	response.Body.Close()
	if response.StatusCode != 401 {
		t.Fatalf("another instance accepted this account: %d", response.StatusCode)
	}
	if err := StartAPIProxy(); err != nil {
		t.Fatal(err)
	}
	client, err := net.DialTimeout("tcp", fmt.Sprintf("127.0.0.1:%d", apiProxyPort), 5*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	client.SetDeadline(time.Now().Add(15 * time.Second))
	fmt.Fprintf(client, "GET /channel/%s/ws?token=%s HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n", apiProxyKey, session.Token)
	status, err := bufio.NewReader(client).ReadString('\n')
	if err != nil || !strings.Contains(status, "101") {
		t.Fatal("real authenticated chat websocket did not upgrade")
	}
	bridge.EndServerSession(apiConnection.version)
	t.Log("Real encrypted login, account routing, protected APIs, cross-instance rejection, chat connection and logout passed without SSH")
}
