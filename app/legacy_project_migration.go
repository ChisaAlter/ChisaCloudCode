package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"strings"
	"sync"
	"time"
)

// Legacy projects were opened through a local directory plus a server path. The
// project list is built from the backend's `projects` table, and session history
// is stored per project path, so a path that was never registered server-side
// has no list entry even though its directory and history still exist. This
// registers only the previously used server paths, only against the account and
// backend the mapping was created for, and never creates a directory, clones a
// repository or uploads files.
var legacyProjectMigration = struct {
	sync.Mutex
	done map[string]bool
}{done: map[string]bool{}}

// legacyMigratableServerPaths returns the distinct server paths of mappings that
// belong to the currently authenticated account and instance identity.
func legacyMigratableServerPaths(current string) []string {
	if current == "" {
		return nil
	}
	seen := map[string]bool{}
	paths := []string{}
	for _, mapping := range store.mappings() {
		if mapping == nil || mapping.ServerID != current {
			continue
		}
		serverPath := strings.TrimSpace(mapping.ServerPath)
		// The authority to register comes from the mapping, so it must still look
		// like the absolute workspace path the old client stored; a mutated or
		// truncated value must never reach the backend as a host path probe.
		if !strings.HasPrefix(serverPath, "/") || serverPath == "/" ||
			strings.ContainsAny(serverPath, "\x00\r\n") || seen[serverPath] {
			continue
		}
		seen[serverPath] = true
		paths = append(paths, serverPath)
	}
	return paths
}

func legacyProjectMigrationClaim(identity string) bool {
	legacyProjectMigration.Lock()
	defer legacyProjectMigration.Unlock()
	if legacyProjectMigration.done[identity] {
		return false
	}
	legacyProjectMigration.done[identity] = true
	return true
}

// registerLegacyProjects is best effort: a failure never blocks login or project
// use, and the next start retries because the claim only lives in this process.
func registerLegacyProjects(connection *serverConnection) {
	// A background migration must never take the account request path down: this
	// runs concurrently with login, and any panic here would kill the process.
	defer func() {
		if recovered := recover(); recovered != nil {
			log.Printf("[legacy-project-migration] outcome=panic detail=%T", recovered)
		}
	}()
	if connection == nil || connection.accessToken == "" || connection.baseURL == "" || store == nil {
		return
	}
	identity := serverIdentity(store.config())
	paths := legacyMigratableServerPaths(identity)
	if len(paths) == 0 || !legacyProjectMigrationClaim(identity) {
		return
	}

	payload, err := json.Marshal(map[string]any{"paths": paths})
	if err != nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	request, err := http.NewRequestWithContext(ctx, http.MethodPost,
		strings.TrimRight(connection.baseURL, "/")+"/api/projects/register-existing", bytes.NewReader(payload))
	if err != nil {
		return
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Authorization", "Bearer "+connection.accessToken)

	client := connection.client
	if client == nil {
		client = &http.Client{Timeout: 30 * time.Second}
	}
	response, err := client.Do(request)
	if err != nil {
		// Never log the path list or the token; only the failure kind.
		log.Printf("[legacy-project-migration] outcome=error detail=%T", err)
		return
	}
	defer response.Body.Close()
	raw, readErr := io.ReadAll(io.LimitReader(response.Body, 1<<20))
	if readErr != nil || response.StatusCode != http.StatusOK {
		log.Printf("[legacy-project-migration] outcome=rejected status=%d", response.StatusCode)
		return
	}

	var result struct {
		Results []struct {
			Outcome string `json:"outcome"`
		} `json:"results"`
	}
	if err := json.Unmarshal(raw, &result); err != nil {
		log.Printf("[legacy-project-migration] outcome=unreadable status=%d", response.StatusCode)
		return
	}
	counts := map[string]int{}
	for _, entry := range result.Results {
		counts[entry.Outcome]++
	}
	log.Printf("[legacy-project-migration] outcome=done registered=%d existing=%d reactivated=%d rejected=%d",
		counts["registered"], counts["existing"], counts["reactivated_archived"], counts["rejected"])
	// A rejected path means the legacy directory is not visible to this backend
	// (wrong mount or a different server); surface that once, without paths.
	if counts["rejected"] > 0 {
		log.Printf("[legacy-project-migration] warn=%s", fmt.Sprintf("%d legacy project paths were not registered", counts["rejected"]))
	}
}
