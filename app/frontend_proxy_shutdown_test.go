package main

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"net"
	"net/http"
	"testing"
	"time"
)

func TestFrontendProxyWindowCloseCancelsHTTPAndUpgradedSocketKeepsNativeCleanup(t *testing.T) {
	preserveFrontendRequestLifecycle(t)
	httpStarted, httpCancelled := make(chan struct{}), make(chan struct{})
	wsClosed := make(chan struct{})
	release := make(chan struct{})
	connection := accountWorkspaceFixture(t, func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/hanging":
			close(httpStarted)
			select {
			case <-r.Context().Done():
				close(httpCancelled)
			case <-release:
			}
		case "/api/native-cleanup":
			_, _ = io.WriteString(w, "native cleanup available")
		case "/ws":
			conn, buffer, err := w.(http.Hijacker).Hijack()
			if err != nil {
				t.Error(err)
				return
			}
			defer conn.Close()
			_, _ = fmt.Fprint(buffer, "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n")
			buffer.Flush()
			_ = conn.SetReadDeadline(time.Now().Add(5 * time.Second))
			_, _ = buffer.ReadByte()
			close(wsClosed)
		default:
			http.NotFound(w, r)
		}
	})
	t.Cleanup(func() { close(release) })
	manager, _ := sshTestManager(t)
	preserveDesktopSshManager(t, manager)
	agent := newTestWorkspaceAgent(t, "")
	if err := StartAPIProxy(); err != nil {
		t.Fatal(err)
	}
	base := fmt.Sprintf("http://127.0.0.1:%d/channel/%s", apiProxyPort, apiProxyKey)
	httpDone := make(chan struct{})
	go func() {
		defer close(httpDone)
		response, err := http.Get(base + "/api/hanging")
		if err == nil {
			io.Copy(io.Discard, response.Body)
			response.Body.Close()
		}
	}()
	<-httpStarted
	client, err := net.DialTimeout("tcp", fmt.Sprintf("127.0.0.1:%d", apiProxyPort), time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	fmt.Fprintf(client, "GET /channel/%s/ws HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n", apiProxyKey)
	reader := bufio.NewReader(client)
	_ = client.SetReadDeadline(time.Now().Add(2 * time.Second))
	upgrade, err := http.ReadResponse(reader, nil)
	if err != nil {
		t.Fatal(err)
	}
	if upgrade.StatusCode != 101 {
		t.Fatal(upgrade.StatusCode)
	}
	serverConnectionMu.Lock()
	callback := make(chan struct{})
	go func() { beginDesktopShutdown(); close(callback) }()
	select {
	case <-callback:
	case <-time.After(time.Second):
		serverConnectionMu.Unlock()
		t.Fatal("proxy cancellation waited for account lock")
	}
	serverConnectionMu.Unlock()
	for _, done := range []<-chan struct{}{httpCancelled, httpDone, wsClosed} {
		select {
		case <-done:
		case <-time.After(2 * time.Second):
			t.Fatal("window close did not terminate proxied frontend transport")
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if err := waitFrontendProxyRequests(ctx); err != nil {
		t.Fatal(err)
	}
	response, err := http.Get(base + "/api/native-cleanup")
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != 503 {
		t.Fatal("closed proxy admitted request", response.StatusCode)
	}
	response, err = connection.client.Get(connection.baseURL + "/api/native-cleanup")
	if err != nil {
		t.Fatal("window closure canceled native authenticated client", err)
	}
	body, _ := io.ReadAll(response.Body)
	response.Body.Close()
	if string(body) != "native cleanup available" {
		t.Fatal(string(body))
	}
	if connection.ctx.Err() != nil || agent.ctx.Err() != nil {
		t.Fatal("window proxy shutdown killed native cleanup lifetime")
	}
	response, err = http.Get(fmt.Sprintf("http://127.0.0.1:%d/health", agent.port))
	if err != nil {
		t.Fatal("Agent unavailable during cleanup handoff", err)
	}
	response.Body.Close()
}
