package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func revocationRecordForTest(t *testing.T) (string, persistedAccountCredential) {
	t.Helper()
	path, err := accountCredentialPath()
	if err != nil {
		t.Fatal(err)
	}
	accountCredentialMu.Lock()
	record, err := readAccountCredentialRecord(path)
	accountCredentialMu.Unlock()
	if err != nil {
		t.Fatal(err)
	}
	return path, record
}

func logoutReceiptForTest(t *testing.T, result map[string]any) map[string]any {
	t.Helper()
	if result["ok"] != true {
		t.Fatalf("logout failed: %v", result["code"])
	}
	receipt, ok := result["receipt"].(map[string]any)
	if !ok || receipt["localCleared"] != true {
		t.Fatal("missing local-clear receipt")
	}
	return receipt
}

func TestNativeSessionV2LogoutAcknowledgesOnlyCapturedSession(t *testing.T) {
	started, release := make(chan struct{}), make(chan struct{})
	var once sync.Once
	finish := func() { once.Do(func() { close(release) }) }
	c := nativeSessionFixture(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/auth/logout" || r.Method != http.MethodPost {
			t.Error("logout used an unexpected route")
		}
		if r.Header.Get("Authorization") != "Bearer "+testSessionToken(1, "fixture", "initial") || r.URL.RawQuery != "" || r.Header.Get("Cookie") != "" {
			t.Error("logout did not use captured native bearer")
		}
		close(started)
		select {
		case <-release:
		case <-r.Context().Done():
			return
		}
		fmt.Fprint(w, `{"success":true,"message":"Logged out successfully"}`)
	})
	t.Cleanup(finish)
	reservation := reserveTestRequest(t, "api")
	done := make(chan map[string]any, 1)
	go func() { done <- (FrontendBridge{}).EndServerSessionV2(c.sessionHandle, c.tokenRevision) }()
	awaitNativeSignal(t, started, "native logout never reached upstream")
	if c.ctx.Err() == nil {
		t.Fatal("old capabilities remained active during logout I/O")
	}
	if response := (FrontendBridge{}).ServerRequest(reservation, "GET", "/api/projects", nil, ""); response.Status != 499 {
		t.Fatal("old reservation survived local logout", response.Status)
	}
	_, pending := revocationRecordForTest(t)
	if pending.Token != "" || len(pending.Pending) != 1 || pending.Pending[0].Token != c.accessToken {
		t.Fatal("local logout and pending revoke were not durably committed together")
	}

	// A different sid can log in while the old network operation is outstanding.
	serverConnectionMu.Lock()
	next, err := newServerConnection(c.loginURL, c.baseURL)
	if err != nil {
		serverConnectionMu.Unlock()
		t.Fatal(err)
	}
	next.authenticated, next.accountIdentity, next.accessToken = true, c.accountIdentity, testSessionToken(1, "fixture", "new-sid")
	err = saveAccountCredential(&persistedAccountCredential{ServerKey: next.serverKey, Token: next.accessToken})
	if err == nil {
		replaceServerConnection(next)
	}
	serverConnectionMu.Unlock()
	if err != nil {
		t.Fatal(err)
	}
	finish()
	select {
	case result := <-done:
		receipt := logoutReceiptForTest(t, result)
		if receipt["remoteRevoked"] != true || receipt["pendingRevocation"] != false || receipt["remoteStatus"] != "revoked" {
			t.Fatal("successful logout acknowledgement was not represented")
		}
		returned := result["connection"].(map[string]any)
		if returned["sessionHandle"] == next.sessionHandle {
			t.Fatal("old logout returned a successor account snapshot")
		}
	case <-time.After(6 * time.Second):
		t.Fatal("logout exceeded its bounded request budget")
	}
	_, saved := revocationRecordForTest(t)
	if len(saved.Pending) != 0 || saved.Token != next.accessToken || apiConnection != next || !next.authenticated {
		t.Fatal("late logout acknowledgement altered the new sid")
	}
}

func TestNativeSessionV2LogoutOfflineRestartRetriesOriginalOriginToken(t *testing.T) {
	var online atomic.Bool
	calls := make(chan string, 8)
	c := nativeSessionFixture(t, func(w http.ResponseWriter, r *http.Request) {
		calls <- r.Header.Get("Authorization")
		if r.URL.Path != "/api/auth/logout" {
			t.Error("retry used a different endpoint")
		}
		if !online.Load() {
			w.WriteHeader(http.StatusServiceUnavailable)
			return
		}
		fmt.Fprint(w, `{"success":true}`)
	})
	result := (FrontendBridge{}).EndServerSessionV2(c.sessionHandle, c.tokenRevision)
	receipt := logoutReceiptForTest(t, result)
	if receipt["remoteRevoked"] != false || receipt["pendingRevocation"] != true || receipt["remoteStatus"] != "pending" {
		t.Fatal("offline logout incorrectly claimed revocation")
	}
	path, saved := revocationRecordForTest(t)
	if saved.Token != "" || len(saved.Pending) != 1 || saved.Pending[0].Token != c.accessToken || saved.Pending[0].APIURL != c.baseURL || saved.Pending[0].ServerKey != c.serverKey {
		t.Fatal("retry did not retain native session binding")
	}
	ciphertext, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if runtime.GOOS == "windows" && strings.Contains(string(ciphertext), c.accessToken) {
		t.Fatal("pending revocation token was stored in plaintext")
	}
	select {
	case bearer := <-calls:
		if bearer != "Bearer "+c.accessToken {
			t.Fatal("wrong initial bearer")
		}
	default:
		t.Fatal("offline logout never attempted network")
	}

	// A same-origin restart may now have a newer persisted sid. Retry old only.
	newToken := testSessionToken(1, "fixture", "subsequent-login")
	if err := saveAccountCredential(&persistedAccountCredential{ServerKey: c.serverKey, Token: newToken}); err != nil {
		t.Fatal(err)
	}
	online.Store(true)
	if err := initializeServerConnection(); err != nil {
		t.Fatal(err)
	}
	if apiConnection.restorationToken != newToken {
		t.Fatal("restart lost new login candidate")
	}
	select {
	case bearer := <-calls:
		if bearer != "Bearer "+c.accessToken {
			t.Fatal("restart revoked newer sid")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("restart did not retry pending revoke")
	}
	// The retry response and its durable completion are independent of handler entry.
	deadline := time.Now().Add(2 * time.Second)
	for {
		_, saved = revocationRecordForTest(t)
		if len(saved.Pending) == 0 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("retry acknowledgement was not committed")
		}
		time.Sleep(time.Millisecond)
	}
	if saved.Token != newToken || apiConnection.restorationToken != newToken {
		t.Fatal("retry completion removed newer credentials")
	}
}

func TestNativeSessionV2LogoutRestartOnAnotherOriginRetriesCapturedOrigin(t *testing.T) {
	var online atomic.Bool
	retried := make(chan struct{}, 1)
	c := nativeSessionFixture(t, func(w http.ResponseWriter, r *http.Request) {
		local, _ := r.Context().Value(http.LocalAddrContextKey).(net.Addr)
		if r.URL.Path != "/api/auth/logout" || r.Method != http.MethodPost || r.URL.RawQuery != "" || r.Header.Get("Authorization") != "Bearer "+testSessionToken(1, "fixture", "initial") || local == nil || r.Host != local.String() {
			t.Error("retry changed the captured logout origin, route or bearer")
		}
		if !online.Load() {
			w.WriteHeader(http.StatusServiceUnavailable)
			return
		}
		fmt.Fprint(w, `{"success":true,"message":"Logged out successfully"}`)
		retried <- struct{}{}
	})
	logoutReceiptForTest(t, (FrontendBridge{}).EndServerSessionV2(c.sessionHandle, c.tokenRevision))
	var targetCalls atomic.Int32
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		targetCalls.Add(1)
		t.Error("old pending logout reached the replacement origin")
	}))
	defer target.Close()
	cfg := store.config()
	cfg.LoginURL, cfg.APIURL, cfg.WorkspaceServerURL = target.URL, target.URL, ""
	if err := store.updateConfig(cfg); err != nil {
		t.Fatal(err)
	}
	newKey, newToken := serverKey(target.URL, target.URL), testSessionToken(2, "replacement", "new-sid")
	if err := saveAccountCredential(&persistedAccountCredential{ServerKey: newKey, Token: newToken}); err != nil {
		t.Fatal(err)
	}
	// Simulate process restart: stop the predecessor's periodic worker first.
	apiConnection.cancel()
	online.Store(true)
	if err := initializeServerConnection(); err != nil {
		t.Fatal(err)
	}
	awaitNativeSignal(t, retried, "restart on another origin did not retry the captured origin")
	deadline := time.Now().Add(2 * time.Second)
	for {
		_, saved := revocationRecordForTest(t)
		if len(saved.Pending) == 0 {
			if saved.ServerKey != newKey || saved.Token != newToken || apiConnection.restorationToken != newToken || apiConnection.baseURL != target.URL || targetCalls.Load() != 0 {
				t.Fatal("cross-origin retry changed the replacement credential or destination")
			}
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("captured-origin acknowledgement was not committed")
		}
		time.Sleep(time.Millisecond)
	}
}

func TestNativeSessionV2LogoutRejectsRedirectAndMalformedAcknowledgement(t *testing.T) {
	var redirected atomic.Int32
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { redirected.Add(1); fmt.Fprint(w, `{"success":true}`) }))
	defer target.Close()
	for _, mode := range []string{"redirect", "malformed", "false", "trailing", "unauthorized", "rejected"} {
		t.Run(mode, func(t *testing.T) {
			c := nativeSessionFixture(t, func(w http.ResponseWriter, r *http.Request) {
				switch mode {
				case "redirect":
					http.Redirect(w, r, target.URL+"/api/auth/logout", http.StatusTemporaryRedirect)
				case "malformed":
					fmt.Fprint(w, `{"success":`)
				case "false":
					fmt.Fprint(w, `{"success":false}`)
				case "trailing":
					fmt.Fprint(w, `{"success":true}{"success":false}`)
				case "unauthorized":
					w.WriteHeader(http.StatusUnauthorized)
				case "rejected":
					w.Header().Set("X-Auth-Error", "invalid-token")
					w.WriteHeader(http.StatusUnauthorized)
				}
			})
			receipt := logoutReceiptForTest(t, (FrontendBridge{}).EndServerSessionV2(c.sessionHandle, c.tokenRevision))
			if receipt["remoteRevoked"] != false {
				t.Fatal("non-ack response claimed remote revocation")
			}
			_, saved := revocationRecordForTest(t)
			if mode == "rejected" {
				if receipt["remoteStatus"] != "rejected" || receipt["pendingRevocation"] != false || len(saved.Pending) != 0 {
					t.Fatal("recognized rejection did not terminate queue entry")
				}
			} else if receipt["pendingRevocation"] != true || len(saved.Pending) != 1 {
				t.Fatal("nonterminal response lost pending revoke")
			}
		})
	}
	if redirected.Load() != 0 {
		t.Fatal("logout followed a cross-origin redirect")
	}
}

func TestNativeSessionV2LogoutQueueLimitsPreserveRetryablePredecessor(t *testing.T) {
	for _, mode := range []string{"count", "bytes"} {
		t.Run(mode, func(t *testing.T) {
			var calls atomic.Int32
			c := nativeSessionFixture(t, func(w http.ResponseWriter, r *http.Request) { calls.Add(1) })
			path, record := revocationRecordForTest(t)
			count, token := maxPendingAccountRevocations, "old-opaque-token"
			if mode == "bytes" {
				count = 15
				token = strings.Repeat("x", 64*1024)
				c.accessToken = strings.Repeat("y", 64*1024)
			}
			for index := 0; index < count; index++ {
				record.Pending = append(record.Pending, pendingAccountRevocation{ID: randHex(24), ServerKey: c.serverKey, LoginURL: c.loginURL, APIURL: c.baseURL, Token: token, CreatedAt: time.Now().Unix()})
			}
			accountCredentialMu.Lock()
			err := writeAccountCredentialRecord(path, record)
			accountCredentialMu.Unlock()
			if err != nil {
				t.Fatal(err)
			}
			before, err := os.ReadFile(path)
			if err != nil {
				t.Fatal(err)
			}
			result := (FrontendBridge{}).EndServerSessionV2(c.sessionHandle, c.tokenRevision)
			if result["ok"] != false || result["code"] != "SESSION_SAVE_FAILED" || apiConnection != c || c.ctx.Err() != nil || !c.authenticated {
				t.Fatal("full queue did not preserve retryable predecessor")
			}
			after, err := os.ReadFile(path)
			if err != nil {
				t.Fatal(err)
			}
			if string(before) != string(after) || calls.Load() != 0 {
				t.Fatal("failed atomic logout mutated disk or attempted revocation")
			}
		})
	}
}

func TestNativeSessionV2LogoutExpiredTokenDoesNotClaimRevocation(t *testing.T) {
	var calls atomic.Int32
	c := nativeSessionFixture(t, func(w http.ResponseWriter, r *http.Request) { calls.Add(1) })
	claims, _ := json.Marshal(map[string]any{"userId": 1, "username": "fixture", "exp": time.Now().Add(-time.Second).Unix()})
	header := base64.RawURLEncoding.EncodeToString([]byte(`{"alg":"HS256","typ":"JWT"}`))
	c.accessToken = header + "." + base64.RawURLEncoding.EncodeToString(claims) + ".test-signature"
	receipt := logoutReceiptForTest(t, (FrontendBridge{}).EndServerSessionV2(c.sessionHandle, c.tokenRevision))
	if receipt["remoteRevoked"] != false || receipt["remoteStatus"] != "expired" || receipt["pendingRevocation"] != false || calls.Load() != 0 {
		t.Fatal("expired session was mislabeled or unnecessarily sent")
	}
	_, record := revocationRecordForTest(t)
	if record.Token != "" || len(record.Pending) != 0 {
		t.Fatal("expired credential retained after logout")
	}
}

func TestAccountCredentialV2RevocationBindingAndStaleCompletion(t *testing.T) {
	c := nativeSessionFixture(t, func(w http.ResponseWriter, r *http.Request) { fmt.Fprint(w, `{"success":true}`) })
	serverConnectionMu.Lock()
	path, item, err := queueAccountLogoutLocked(c)
	serverConnectionMu.Unlock()
	if err != nil {
		t.Fatal(err)
	}
	mutations := []func(*pendingAccountRevocation){func(p *pendingAccountRevocation) { p.APIURL = "https://other.invalid" }, func(p *pendingAccountRevocation) { p.ServerKey = "wrong" }, func(p *pendingAccountRevocation) { p.LoginURL += "/" }, func(p *pendingAccountRevocation) { p.ExpiresAt = time.Now().Unix() }}
	for _, mutate := range mutations {
		bad := *item
		mutate(&bad)
		if bad.valid() {
			t.Fatal("invalid native queue binding accepted")
		}
	}
	client := accountRevocationClient(c)
	defer client.CloseIdleConnections()
	status, pending := performAccountRevocation(context.Background(), client, path, *item)
	if status != "revoked" || pending {
		t.Fatal("captured revoke did not complete")
	}
}
