package main

import (
	"context"
	"crypto/tls"
	"fmt"
	"io"
	"net/http"
	"sync"
	"time"
)

// ProbeServerHTTPTransport compares the current pool with an independent HTTP/1
// pool using the same verified TLS/account configuration. It only reads running
// session metadata. Credentials and response contents never leave the connection.
// This explicit diagnostic does not replace the product client or replay work.
func (FrontendBridge) ProbeServerHTTPTransport() map[string]any {
	serverConnectionMu.RLock()
	connection := apiConnection
	ready := connection != nil && connection.authenticated && connection.accessToken != "" && connection.ctx.Err() == nil
	serverConnectionMu.RUnlock()
	if !ready {
		return map[string]any{"ok": false, "code": "ACCOUNT_NOT_READY"}
	}
	transport, ok := serverHTTPTransport(connection.client.Transport)
	if !ok {
		return map[string]any{"ok": false, "code": "UNSUPPORTED_TRANSPORT"}
	}
	sampleServerTransportBlocks("before")
	defer sampleServerTransportBlocks("after")
	http1Transport := transport.Clone()
	http1Transport.Protocols = new(http.Protocols)
	http1Transport.Protocols.SetHTTP1(true)
	http1Transport.ForceAttemptHTTP2 = false
	http1Transport.TLSNextProto = map[string]func(string, *tls.Conn) http.RoundTripper{}
	if http1Transport.TLSClientConfig == nil {
		http1Transport.TLSClientConfig = &tls.Config{MinVersion: tls.VersionTLS12}
	}
	http1Transport.TLSClientConfig.NextProtos = []string{"http/1.1"}
	defer http1Transport.CloseIdleConnections()
	http1Client := *connection.client
	http1Client.Transport = &serverTLSRecoveryTransport{transport: http1Transport, account: connection.ctx}

	clients := []*http.Client{connection.client, &http1Client}
	modes := []string{"default-pool", "http1-pool"}
	results := make([]map[string]any, 0, 4)
	for round := 1; round <= 2; round++ {
		if round > 1 {
			timer := time.NewTimer(5 * time.Second)
			select {
			case <-timer.C:
			case <-connection.ctx.Done():
				timer.Stop()
				return map[string]any{"ok": false, "code": "CONNECTION_CHANGED", "samples": results}
			}
		}
		ctx, cancel := context.WithTimeout(connection.ctx, 15*time.Second)
		pair := make([]map[string]any, 2)
		var done sync.WaitGroup
		done.Add(2)
		for index, client := range clients {
			go func(index int, client *http.Client) {
				defer done.Done()
				pair[index] = probeServerHTTP(ctx, connection, client, modes[index], round)
			}(index, client)
		}
		done.Wait()
		cancel()
		results = append(results, pair...)
	}
	serverConnectionMu.RLock()
	current := apiConnection == connection && connection.ctx.Err() == nil
	serverConnectionMu.RUnlock()
	return map[string]any{"ok": current, "connectionVersion": connection.version, "samples": results}
}

func probeServerHTTP(ctx context.Context, connection *serverConnection, client *http.Client, mode string, round int) map[string]any {
	const endpoint = "/api/providers/sessions/running"
	started := time.Now()
	trace := newServerRequestTrace(started, connection.version, http.MethodGet, endpoint)
	result := map[string]any{"mode": mode, "round": round}
	serverConnectionMu.RLock()
	current := apiConnection == connection && connection.authenticated && connection.ctx.Err() == nil
	accessToken := connection.accessToken
	serverConnectionMu.RUnlock()
	if !current {
		result["error"] = "connection-changed"
		return result
	}
	request, err := http.NewRequestWithContext(trace.context(ctx), http.MethodGet, connection.baseURL+endpoint, nil)
	if err != nil {
		result["error"] = "invalid-request"
		return result
	}
	request.Header.Set("Authorization", "Bearer "+accessToken)
	var bytes int64
	var expected int64 = -1
	response, err := client.Do(request)
	if err == nil {
		trace.response(response)
		expected = response.ContentLength
		bytes, err = io.Copy(io.Discard, io.LimitReader(response.Body, 64*1024*1024+1))
		response.Body.Close()
		if bytes > 64*1024*1024 {
			err = fmt.Errorf("response exceeds bridge limit")
		}
		if err == nil {
			trace.complete()
			serverConnectionMu.Lock()
			if apiConnection == connection && connection.ctx.Err() == nil && ctx.Err() == nil {
				recordNativeRefreshedToken(connection, response.Header, response.StatusCode)
			}
			serverConnectionMu.Unlock()
		}
	}
	trace.log("probe-"+mode, err, int(bytes), expected)
	trace.mu.Lock()
	result["phase"], result["protocol"], result["status"] = trace.phase, trace.protocol, trace.status
	result["conn"], result["reused"], result["wasIdle"] = trace.connection, trace.reused, trace.wasIdle
	result["idleMs"] = trace.idleTime.Milliseconds()
	trace.mu.Unlock()
	result["elapsedMs"], result["bytes"], result["expected"] = time.Since(started).Milliseconds(), bytes, expected
	result["error"] = serverRequestErrorClass(err)
	return result
}
