package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

const accountRevocationTimeout = 5 * time.Second
const accountRevocationRetryInterval = 30 * time.Second

type pendingAccountRevocation struct {
	ID        string `json:"id"`
	ServerKey string `json:"serverKey"`
	LoginURL  string `json:"loginUrl"`
	APIURL    string `json:"apiUrl"`
	Token     string `json:"token"`
	CreatedAt int64  `json:"createdAt"`
	ExpiresAt int64  `json:"expiresAt,omitempty"`
}

func accountTokenExpiry(token string) int64 {
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return 0
	}
	raw, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return 0
	}
	var claims struct {
		Exp int64 `json:"exp"`
	}
	if json.Unmarshal(raw, &claims) != nil || claims.Exp <= 0 {
		return 0
	}
	return claims.Exp
}

func sameAccountOrigin(left, right string) bool {
	a, errA := url.Parse(left)
	b, errB := url.Parse(right)
	return errA == nil && errB == nil && a.Scheme == b.Scheme && a.Host == b.Host
}

func (pending pendingAccountRevocation) valid() bool {
	login, loginErr := normalizeServiceURL(pending.LoginURL)
	api, apiErr := normalizeServiceURL(pending.APIURL)
	if len(pending.ID) != 48 || strings.Trim(pending.ID, "0123456789abcdef") != "" || pending.CreatedAt <= 0 || !validSessionToken(pending.Token) {
		return false
	}
	return loginErr == nil && apiErr == nil && login == pending.LoginURL && api == pending.APIURL && sameAccountOrigin(login, api) && pending.ServerKey == serverKey(login, api) && pending.ExpiresAt == accountTokenExpiry(pending.Token)
}

func liveAccountRevocations(pending []pendingAccountRevocation, now int64) []pendingAccountRevocation {
	live := make([]pendingAccountRevocation, 0, len(pending))
	for _, item := range pending {
		if item.ExpiresAt == 0 || item.ExpiresAt > now {
			live = append(live, item)
		}
	}
	return live
}

// Caller holds the account lock. Capture only native credentials, never a JS
// bearer or later account. One atomic encrypted write clears active + enqueues.
func queueAccountLogoutLocked(c *serverConnection) (string, *pendingAccountRevocation, error) {
	path, err := accountCredentialPath()
	if err != nil {
		return "", nil, err
	}
	accountCredentialMu.Lock()
	defer accountCredentialMu.Unlock()
	record, err := readAccountCredentialRecord(path)
	if err != nil {
		return "", nil, err
	}
	now := time.Now().Unix()
	record.ServerKey, record.Token = "", ""
	record.Pending = liveAccountRevocations(record.Pending, now)
	token := c.accessToken
	if !c.authenticated {
		token = c.restorationToken
	}
	var pending *pendingAccountRevocation
	if validSessionToken(token) {
		item := pendingAccountRevocation{ID: randHex(24), ServerKey: c.serverKey, LoginURL: c.loginURL, APIURL: c.baseURL, Token: token, CreatedAt: now, ExpiresAt: accountTokenExpiry(token)}
		if !item.valid() {
			return "", nil, io.ErrUnexpectedEOF
		}
		pending = &item
		if item.ExpiresAt == 0 || item.ExpiresAt > now {
			record.Pending = append(record.Pending, item)
		}
	}
	if err = writeAccountCredentialRecord(path, record); err != nil {
		return "", nil, err
	}
	return path, pending, nil
}

// Use verified TLS configuration and the captured URL, but not the canceled
// account context. Redirects are never followed, including same-origin ones.
func accountRevocationClient(c *serverConnection) *http.Client {
	transport, ok := serverHTTPTransport(c.client.Transport)
	if !ok {
		return nil
	}
	return &http.Client{Transport: transport.Clone(), CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
}

// The response body is bounded and parsed as one complete JSON value. A 401 is
// terminal rejection, not a claim that this client successfully revoked a sid.
func requestAccountRevocation(ctx context.Context, client *http.Client, pending pendingAccountRevocation) string {
	if pending.ExpiresAt > 0 && pending.ExpiresAt <= time.Now().Unix() {
		return "expired"
	}
	if client == nil || !pending.valid() {
		return "pending"
	}
	ctx, cancel := context.WithTimeout(ctx, accountRevocationTimeout)
	defer cancel()
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, pending.APIURL+"/api/auth/logout", nil)
	if err != nil {
		return "pending"
	}
	request.Header.Set("Authorization", "Bearer "+pending.Token)
	request.Header.Set("Accept", "application/json")
	response, err := client.Do(request)
	if err != nil {
		return "pending"
	}
	defer response.Body.Close()
	body, err := io.ReadAll(io.LimitReader(response.Body, 64*1024+1))
	if err != nil || len(body) > 64*1024 {
		return "pending"
	}
	if response.StatusCode == http.StatusUnauthorized && (response.Header.Get("X-Auth-Error") == "invalid-token" || response.Header.Get("X-Auth-Error") == "session-expired") {
		return "rejected"
	}
	var ack struct {
		Success bool `json:"success"`
	}
	if response.StatusCode == http.StatusOK && response.Header.Get("X-Auth-Error") == "" && json.Unmarshal(body, &ack) == nil && ack.Success {
		return "revoked"
	}
	return "pending"
}

// accountCredentialMu protects the in-flight map as well as on-disk CAS updates.
// Completion writes the captured profile, even if a different one is now active.
var accountRevocationsInFlight = make(map[string]bool)

func performAccountRevocation(ctx context.Context, client *http.Client, path string, item pendingAccountRevocation) (string, bool) {
	key := path + "\n" + item.ID
	accountCredentialMu.Lock()
	if accountRevocationsInFlight[key] {
		accountCredentialMu.Unlock()
		return "pending", true
	}
	accountRevocationsInFlight[key] = true
	accountCredentialMu.Unlock()
	defer func() {
		accountCredentialMu.Lock()
		delete(accountRevocationsInFlight, key)
		accountCredentialMu.Unlock()
	}()

	status := requestAccountRevocation(ctx, client, item)
	if status == "pending" {
		return status, true
	}
	accountCredentialMu.Lock()
	defer accountCredentialMu.Unlock()
	record, err := readAccountCredentialRecord(path)
	if err != nil {
		return status, true
	}
	retained := make([]pendingAccountRevocation, 0, len(record.Pending))
	found := false
	for _, candidate := range record.Pending {
		if candidate.ID == item.ID && candidate.ServerKey == item.ServerKey && candidate.Token == item.Token {
			found = true
		} else {
			retained = append(retained, candidate)
		}
	}
	if !found {
		return status, false
	}
	record.Pending = retained
	return status, writeAccountCredentialRecord(path, record) != nil
}

// Called while the connection is initialized or published. Every retry uses the
// captured profile entry's origin and bearer, even if another target is active.
// A switch cancels this worker; the successor resumes the same persistent queue.
func startAccountRevocationRetry(c *serverConnection, immediate bool) {
	if c == nil {
		return
	}
	path, err := accountCredentialPath()
	if err != nil {
		return
	}
	c.revocationRetryOnce.Do(func() {
		client := accountRevocationClient(c)
		if client == nil {
			return
		}
		go func() {
			defer client.CloseIdleConnections()
			delay := accountRevocationRetryInterval
			if immediate {
				delay = 0
			}
			for {
				timer := time.NewTimer(delay)
				select {
				case <-c.ctx.Done():
					timer.Stop()
					return
				case <-timer.C:
				}
				accountCredentialMu.Lock()
				record, loadErr := readAccountCredentialRecord(path)
				accountCredentialMu.Unlock()
				if loadErr != nil {
					return
				}
				found := false
				for _, item := range record.Pending {
					found = true
					if c.ctx.Err() != nil {
						return
					}
					performAccountRevocation(c.ctx, client, path, item)
				}
				if !found {
					return
				}
				delay = accountRevocationRetryInterval
			}
		}()
	})
}
