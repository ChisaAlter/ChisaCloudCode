package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net/http"
	"net/url"
	"path"
	"sort"
	"strings"
	"time"
	"unicode/utf8"
)

const legacyMigrationTimeout = 30 * time.Second

var errLegacyMigrationStale = errors.New("legacy migration session changed")

// This gate serializes attempts, not identities already tried. Only a verified
// success on disk suppresses a later attempt; rejection, cancellation and IO
// failure are always retryable. Waiting itself is canceled with the session.
var legacyMigrationGate = make(chan struct{}, 1)

type legacyMigrationMapping struct {
	mappingID string
	path      string
}

// A snapshot never borrows mutable configuration or credentials after admission.
// Config is historical evidence only; it cannot establish a current identity.
// Every field is captured while serverConnectionMu and then Store.mu are held.
type legacyMigrationSnapshot struct {
	connection      *serverConnection
	store           *Store
	profilePath     string
	loginURL        string
	baseURL         string
	client          *http.Client
	ctx             context.Context
	cancel          context.CancelFunc
	pending         *frontendProxyRequest
	token           string
	handle          string
	generation      uint64
	tokenRevision   uint64
	serverKey       string
	accountIdentity string
	legacyServerURL string
	verifiedURL     string
	sourceSHA256    string
	mappings        []legacyMigrationMapping
	unknown         int
}

func legacyMigrationPath(value string) bool {
	return value != "" && len(value) <= 4096 && utf8.ValidString(value) &&
		strings.HasPrefix(value, "/") && value != "/" && path.Clean(value) == value &&
		!strings.Contains(value, "\\") && strings.IndexFunc(value, func(r rune) bool { return r < 32 || r == 127 }) < 0
}

func legacyMigrationServiceURL(value string) string {
	normalized, err := normalizeServiceURL(value)
	if err != nil {
		return ""
	}
	return normalized
}

// Workspace targets are authenticated metadata, never request destinations here.
// Unlike the account login endpoint they may name an internal HTTP service; the
// exact normalized value must still agree with the verified native handoff.
func legacyMigrationWorkspaceURL(value string) string {
	value = strings.TrimRight(strings.TrimSpace(value), "/")
	u, err := url.Parse(value)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Hostname() == "" || u.User != nil ||
		u.RawQuery != "" || u.Fragment != "" || u.RawPath != "" || strings.Contains(u.Path, "\\") ||
		(u.Path != "" && path.Clean(u.Path) != u.Path) {
		return ""
	}
	return u.String()
}

func captureLegacyProjectMigration(connection *serverConnection) (*legacyMigrationSnapshot, string) {
	serverConnectionMu.RLock()
	defer serverConnectionMu.RUnlock()
	if connection == nil || apiConnection != connection || serverConnectionSwitching || !connection.authenticated ||
		connection.ctx == nil || connection.ctx.Err() != nil || connection.client == nil ||
		connection.sessionHandle == "" || connection.version == 0 || connection.tokenRevision == 0 ||
		!validSessionToken(connection.accessToken) || connection.accountIdentity == "" ||
		accountIdentity(json.RawMessage(connection.accountIdentity)) != connection.accountIdentity ||
		legacyMigrationServiceURL(connection.loginURL) != connection.loginURL ||
		legacyMigrationServiceURL(connection.baseURL) != connection.baseURL ||
		connection.serverKey == "" || serverKey(connection.loginURL, connection.baseURL) != connection.serverKey {
		return nil, "session_not_current"
	}
	if claimed := tokenAccountIdentity(connection.accessToken); claimed != "" && claimed != connection.accountIdentity {
		return nil, "session_identity_mismatch"
	}
	if store == nil {
		return nil, "unknown_source"
	}
	sourceStore := store
	sourceStore.mu.Lock()
	defer sourceStore.mu.Unlock()
	cfg := sourceStore.Cfg
	if sourceStore.path == "" ||
		legacyMigrationServiceURL(cfg.LoginURL) != connection.loginURL ||
		legacyMigrationServiceURL(cfg.APIURL) != connection.baseURL ||
		legacyMigrationServiceURL(cfg.WorkspaceLoginURL) != connection.loginURL ||
		accountIdentity(json.RawMessage(cfg.WorkspaceAccount)) != connection.accountIdentity ||
		!legacyMigrationPath(cfg.WorkspaceRoot) {
		return nil, "unknown_source"
	}
	legacyServerURL := legacyMigrationWorkspaceURL(cfg.ServerURL)
	if legacyServerURL == "" {
		return nil, "unknown_source"
	}
	verifiedURL := connection.verifiedWorkspaceURL
	if verifiedURL != "" && legacyMigrationWorkspaceURL(verifiedURL) != legacyServerURL {
		return nil, "origin_identity_mismatch"
	}
	// Config.WorkspaceServerURL may be stale after a login which omitted it.
	// The connection field is set only by the verified authentication handoff.
	// If absent, require fresh service attestation before sending stored paths.
	sourceID := serverIdentity(cfg)
	if !strings.HasPrefix(sourceID, "account:") {
		return nil, "unknown_source"
	}
	sourceRaw, _ := json.Marshal(struct {
		Login, Server, Account, Root, ServerID string
	}{cfg.WorkspaceLoginURL, cfg.ServerURL, cfg.WorkspaceAccount, cfg.WorkspaceRoot, sourceID})
	snapshot := &legacyMigrationSnapshot{
		connection: connection, store: sourceStore, profilePath: sourceStore.path,
		loginURL: connection.loginURL, baseURL: connection.baseURL, token: connection.accessToken,
		handle: connection.sessionHandle, generation: connection.version, tokenRevision: connection.tokenRevision,
		serverKey: connection.serverKey, accountIdentity: connection.accountIdentity, legacyServerURL: legacyServerURL, verifiedURL: verifiedURL,
		sourceSHA256: legacyMigrationDigest("source", string(sourceRaw)),
	}
	seen := map[string]bool{}
	for _, mapping := range sourceStore.Mappings {
		if mapping == nil {
			continue
		}
		copy := *mapping
		if copy.ServerID != sourceID || copy.LocalPath == "" || !legacyMigrationPath(copy.ServerPath) ||
			!strings.HasPrefix(copy.ServerPath, cfg.WorkspaceRoot+"/") {
			snapshot.unknown++
			continue
		}
		// The retired schema has no mapping ID. Hash the entire immutable source
		// row (including its persisted binding epoch) instead of inventing an ID
		// or changing the legacy mapping file. Exact duplicate rows deduplicate.
		raw, _ := json.Marshal(copy)
		id := legacyMigrationDigest("mapping", string(raw))
		if !seen[id] {
			seen[id] = true
			snapshot.mappings = append(snapshot.mappings, legacyMigrationMapping{mappingID: id, path: copy.ServerPath})
		}
	}
	if len(snapshot.mappings) == 0 {
		return nil, "unknown_source"
	}
	if len(snapshot.mappings) > 4096 {
		return nil, "source_capacity"
	}
	parent, pending, open := reserveFrontendProxy(connection.ctx)
	if !open {
		return nil, "desktop_closed"
	}
	snapshot.ctx, snapshot.cancel = context.WithTimeout(parent, legacyMigrationTimeout)
	snapshot.pending = pending
	// Preserve the captured transport, but never follow a response's redirect
	// with credentials or adopt a caller's cookie jar.
	client := *connection.client
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	client.Jar = nil
	snapshot.client = &client
	return snapshot, ""
}

func (snapshot *legacyMigrationSnapshot) close() {
	snapshot.cancel()
	finishFrontendProxy(snapshot.pending)
}

func (snapshot *legacyMigrationSnapshot) current() bool {
	serverConnectionMu.RLock()
	defer serverConnectionMu.RUnlock()
	c := snapshot.connection
	return snapshot.ctx.Err() == nil && apiConnection == c && store == snapshot.store && !serverConnectionSwitching &&
		c.ctx != nil && c.ctx.Err() == nil && c.authenticated && c.version == snapshot.generation &&
		c.sessionHandle == snapshot.handle && c.tokenRevision == snapshot.tokenRevision && c.accessToken == snapshot.token &&
		c.serverKey == snapshot.serverKey && c.accountIdentity == snapshot.accountIdentity && c.verifiedWorkspaceURL == snapshot.verifiedURL &&
		c.loginURL == snapshot.loginURL && c.baseURL == snapshot.baseURL
}

func (snapshot *legacyMigrationSnapshot) request(method, endpoint string, payload []byte, limit int64) ([]byte, int, http.Header, error) {
	if !snapshot.current() {
		return nil, 0, nil, errLegacyMigrationStale
	}
	request, err := http.NewRequestWithContext(snapshot.ctx, method, snapshot.baseURL+endpoint, bytes.NewReader(payload))
	if err != nil {
		return nil, 0, nil, errLegacyMigrationStale
	}
	request.Header.Set("Authorization", "Bearer "+snapshot.token)
	if payload != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	// Even if a switch wins just after current(), this request is bound to the
	// old URL, old transport and old connection context. It can never resolve a
	// replacement global connection or send the old token to the new server.
	response, err := snapshot.client.Do(request)
	if err != nil {
		return nil, 0, nil, err
	}
	defer response.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(response.Body, limit+1))
	if err != nil || int64(len(raw)) > limit {
		return nil, response.StatusCode, nil, errors.New("legacy migration response unreadable")
	}
	if !snapshot.current() {
		return nil, response.StatusCode, nil, errLegacyMigrationStale
	}
	return raw, response.StatusCode, response.Header, nil
}

func (snapshot *legacyMigrationSnapshot) verifyOrigin() bool {
	if snapshot.verifiedURL != "" {
		return legacyMigrationWorkspaceURL(snapshot.verifiedURL) == snapshot.legacyServerURL && snapshot.current()
	}
	raw, status, headers, err := snapshot.request(http.MethodGet, "/api/auth/user", nil, 64*1024)
	if err != nil || status != http.StatusOK || headers.Get("X-Auth-Error") != "" {
		return false
	}
	var payload struct {
		User json.RawMessage `json:"user"`
	}
	if json.Unmarshal(raw, &payload) != nil || accountIdentity(payload.User) != snapshot.accountIdentity {
		return false
	}
	// This is service-authenticated source evidence, not a URL from the global
	// store. Without an explicit workspace target old hashes cannot establish
	// which instance owned the mapping, so automatic migration is refused.
	if legacyMigrationWorkspaceURL(headers.Get("X-Chisa-Workspace-Server-Url")) != snapshot.legacyServerURL {
		return false
	}
	instance := headers.Get("X-Chisa-Instance-Path")
	verifiedAPI := snapshot.loginURL
	if instance != "" {
		parsed, err := url.Parse(snapshot.loginURL)
		if err != nil || !strings.HasPrefix(instance, "/instances/") {
			return false
		}
		parsed.Path, parsed.RawPath = instance, ""
		verifiedAPI = legacyMigrationServiceURL(parsed.String())
	}
	return verifiedAPI != "" && verifiedAPI == snapshot.baseURL && snapshot.current()
}

func legacyMigrationRecordFor(snapshot *legacyMigrationSnapshot, mapping legacyMigrationMapping) legacyMigrationRecord {
	record := legacyMigrationRecord{
		Version: 2, MappingID: mapping.mappingID, SourceSHA256: snapshot.sourceSHA256, ServerKey: snapshot.serverKey,
		AccountSHA256: legacyMigrationDigest("account", snapshot.accountIdentity), PathSHA256: legacyMigrationDigest("path", mapping.path),
		SessionSHA256: legacyMigrationDigest("session", snapshot.handle), Generation: snapshot.generation, TokenRevision: snapshot.tokenRevision,
	}
	// Login handles, token revisions and generations are evidence, not part of
	// the durable key: a successful migration stays done after login or restart.
	record.Key = legacyMigrationDigest("key", record.MappingID, record.SourceSHA256, record.ServerKey, record.AccountSHA256, record.PathSHA256)
	return record
}

// registerLegacyProjects is a native background consumer of the originating
// authenticated connection. Unknown source ownership never causes a probe with
// ServerPath, modifies a retired mapping, or claims process-wide completion.
func registerLegacyProjects(connection *serverConnection) {
	defer func() {
		if recovered := recover(); recovered != nil {
			log.Printf("[legacy-project-migration] outcome=panic detail=%T", recovered)
		}
	}()
	snapshot, reason := captureLegacyProjectMigration(connection)
	if snapshot == nil {
		log.Printf("[legacy-project-migration] outcome=skipped reason=%s action=no_automatic_migration", reason)
		return
	}
	defer snapshot.close()
	if snapshot.unknown > 0 {
		log.Printf("[legacy-project-migration] outcome=skipped reason=unknown_source action=no_automatic_migration count=%d", snapshot.unknown)
	}
	select {
	case legacyMigrationGate <- struct{}{}:
		defer func() { <-legacyMigrationGate }()
	case <-snapshot.ctx.Done():
		return
	}
	if !snapshot.current() {
		return
	}
	state, err := openLegacyMigrationState(snapshot.profilePath)
	if err != nil {
		log.Printf("[legacy-project-migration] outcome=skipped reason=private_state_unavailable action=no_automatic_migration")
		return
	}
	defer state.close()
	pending := map[string][]legacyMigrationRecord{}
	for _, mapping := range snapshot.mappings {
		record := legacyMigrationRecordFor(snapshot, mapping)
		done, err := state.completed(record)
		if err != nil {
			log.Printf("[legacy-project-migration] outcome=skipped reason=private_state_invalid action=no_automatic_migration")
			return
		}
		if !done {
			pending[mapping.path] = append(pending[mapping.path], record)
		}
	}
	if len(pending) == 0 {
		return
	}
	if !snapshot.verifyOrigin() {
		log.Printf("[legacy-project-migration] outcome=skipped reason=origin_unverified action=no_automatic_migration")
		return
	}
	paths := make([]string, 0, len(pending))
	for serverPath := range pending {
		paths = append(paths, serverPath)
	}
	sort.Strings(paths)
	for start := 0; start < len(paths); start += 128 {
		end := start + 128
		if end > len(paths) {
			end = len(paths)
		}
		batch := paths[start:end]
		payload, _ := json.Marshal(map[string]any{"paths": batch})
		raw, status, _, err := snapshot.request(http.MethodPost, "/api/projects/register-existing", payload, 1<<20)
		if err != nil || status != http.StatusOK {
			log.Printf("[legacy-project-migration] outcome=retryable reason=request_failed status=%d", status)
			return
		}
		outcomes, ok := legacyMigrationOutcomes(raw, batch)
		if !ok {
			log.Printf("[legacy-project-migration] outcome=retryable reason=unverified_result")
			return
		}
		for _, serverPath := range batch {
			outcome := outcomes[serverPath]
			if !legacyMigrationSuccess(outcome) {
				log.Printf("[legacy-project-migration] outcome=retryable reason=path_rejected")
				continue
			}
			for _, record := range pending[serverPath] {
				if !snapshot.current() {
					return
				}
				record.Outcome, record.CompletedAt = outcome, time.Now().UTC().Format(time.RFC3339Nano)
				if err := state.complete(record); err != nil {
					log.Printf("[legacy-project-migration] outcome=retryable reason=private_state_save_failed")
					return
				}
			}
		}
	}
	log.Printf("[legacy-project-migration] outcome=finished")
}

func legacyMigrationSuccess(outcome string) bool {
	return outcome == "registered" || outcome == "existing" || outcome == "reactivated_archived"
}

func legacyMigrationOutcomes(raw []byte, paths []string) (map[string]string, bool) {
	var result struct {
		Success *bool `json:"success"`
		Results []struct {
			Path    string `json:"path"`
			Outcome string `json:"outcome"`
		} `json:"results"`
	}
	if json.Unmarshal(raw, &result) != nil || result.Success == nil || !*result.Success || len(result.Results) != len(paths) {
		return nil, false
	}
	requested := map[string]bool{}
	for _, serverPath := range paths {
		requested[serverPath] = true
	}
	outcomes := map[string]string{}
	for _, entry := range result.Results {
		if !requested[entry.Path] || outcomes[entry.Path] != "" || (!legacyMigrationSuccess(entry.Outcome) && entry.Outcome != "rejected") {
			return nil, false
		}
		outcomes[entry.Path] = entry.Outcome
	}
	return outcomes, true
}
