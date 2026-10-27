package main

import (
	"context"
	"crypto/sha256"
	"fmt"
	"log"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"
)

type legacySyncEndpoint struct {
	Protocol string `json:"protocol"`
	Host     string `json:"host"`
	User     string `json:"user"`
	Port     uint32 `json:"port"`
	Path     string `json:"path"`
}

type legacySyncSession struct {
	Name       string             `json:"name"`
	Identifier string             `json:"identifier"`
	Paused     bool               `json:"paused"`
	Alpha      legacySyncEndpoint `json:"alpha"`
	Beta       legacySyncEndpoint `json:"beta"`
}

type legacySyncRetirement struct {
	Status     string `json:"status"`
	Paused     int    `json:"paused"`
	Unverified int    `json:"unverified"`
	Error      string `json:"error,omitempty"`
}

var legacySyncState = struct {
	sync.Mutex
	value legacySyncRetirement
}{value: legacySyncRetirement{Status: "pending"}}

func legacySyncRetirementSnapshot() legacySyncRetirement {
	legacySyncState.Lock()
	defer legacySyncState.Unlock()
	return legacySyncState.value
}

func publishLegacySyncRetirement(result legacySyncRetirement) {
	legacySyncState.Lock()
	legacySyncState.value = result
	legacySyncState.Unlock()
	// Do not log endpoint paths, private keys, tokens or CLI output.
	log.Printf("[legacy-sync-retirement] status=%s paused=%d unverified=%d", result.Status, result.Paused, result.Unverified)
}

type legacySyncRunner interface {
	list(context.Context) ([]legacySyncSession, error)
	pause(context.Context, string) error
}

var legacyBindingEpoch = regexp.MustCompile(`^[a-f0-9]{32}$`)
var legacyManagedServerID = regexp.MustCompile(`^account:[a-f0-9]{64}$`)
var legacyManualServerID = regexp.MustCompile(`^([a-zA-Z0-9_.-]+):([0-9]+)/([a-zA-Z0-9_.-]+)(?:/ssh:([0-9]+))?$`)
var legacySessionID = regexp.MustCompile(`^sync_[a-zA-Z0-9]{16,128}$`)

// This reproduces the old app's alias identity without loading keys, changing
// SSH config or contacting the old account. Inactive account mappings qualify
// independently; a new cloud login never inherits their connection or lease.
func legacySyncAlias(mapping *Mapping) string {
	identity := mapping.ServerID
	if !legacyManagedServerID.MatchString(identity) {
		parts := legacyManualServerID.FindStringSubmatch(identity)
		if parts == nil {
			return ""
		}
		identity = parts[3] + "@" + parts[1]
		if parts[4] != "" && parts[4] != "22" {
			identity += ":" + parts[4]
		}
	}
	digest := sha256.Sum256([]byte(identity))
	return fmt.Sprintf("chisa-sync-%x", digest[:6])
}

func legacySessionMatchesMapping(session legacySyncSession, mapping *Mapping) bool {
	if mapping == nil || !legacyBindingEpoch.MatchString(mapping.BindingEpoch) ||
		mapping.SyncName != "chisa-vps-"+mapping.BindingEpoch || session.Name != mapping.SyncName ||
		!legacySessionID.MatchString(session.Identifier) || !filepath.IsAbs(mapping.LocalPath) ||
		mapping.ServerPath == "/" || !strings.HasPrefix(mapping.ServerPath, "/") || strings.ContainsAny(mapping.ServerPath, "\x00\r\n") {
		return false
	}
	alias := legacySyncAlias(mapping)
	return alias != "" && session.Alpha.Protocol == "local" && session.Alpha.Host == "" && session.Alpha.User == "" && session.Alpha.Port == 0 &&
		norm(session.Alpha.Path) == norm(mapping.LocalPath) && session.Beta.Protocol == "ssh" && session.Beta.Host == alias &&
		session.Beta.User == "" && session.Beta.Port == 0 && session.Beta.Path == mapping.ServerPath
}

// A name is only discovery metadata. Duplicate names/IDs, missing epochs and
// mismatched endpoints are never authority to pause another process's session.
func verifiedLegacySessions(sessions []legacySyncSession, mappings []*Mapping) ([]legacySyncSession, int) {
	verified := []legacySyncSession{}
	unverified := 0
	for _, session := range sessions {
		nameCount, idCount, matches := 0, 0, 0
		for _, other := range sessions {
			if other.Name == session.Name {
				nameCount++
			}
			if other.Identifier == session.Identifier || other.Name == session.Identifier {
				idCount++
			}
		}
		for _, mapping := range mappings {
			if legacySessionMatchesMapping(session, mapping) {
				matches++
			}
		}
		if nameCount == 1 && idCount == 1 && matches == 1 {
			verified = append(verified, session)
		} else {
			unverified++
		}
	}
	return verified, unverified
}

func retireLegacySync(parent context.Context, saved *Store, runner legacySyncRunner) legacySyncRetirement {
	if closer, ok := runner.(interface{ Close() error }); ok {
		defer closer.Close()
	}
	ctx, cancel := context.WithTimeout(parent, 45*time.Second)
	defer cancel()
	result := legacySyncRetirement{Status: "checking"}
	publishLegacySyncRetirement(result)
	sessions, err := runner.list(ctx)
	if err != nil {
		result.Status, result.Error = "unconfirmed", "无法确认旧同步是否已停止；云端连接可继续使用。"
		publishLegacySyncRetirement(result)
		return result
	}
	verified, skipped := verifiedLegacySessions(sessions, saved.mappings())
	result.Unverified = skipped
	for _, session := range verified {
		if !session.Paused {
			if err := runner.pause(ctx, session.Identifier); err != nil {
				result.Error = "部分旧同步暂停未确认；未操作身份不明的会话。"
				continue
			}
		}
		// Re-read after the daemon acknowledges pause. An external controller
		// replacing the name cannot make a different session count as stopped.
		current, err := runner.list(ctx)
		if err != nil {
			result.Error = "旧同步暂停后的状态未确认。"
			continue
		}
		confirmed := false
		for _, observed := range current {
			if observed.Identifier == session.Identifier && observed.Name == session.Name && observed.Alpha == session.Alpha && observed.Beta == session.Beta && observed.Paused {
				confirmed = true
			}
		}
		if confirmed {
			result.Paused++
		} else {
			result.Error = "旧同步暂停后的身份或状态已改变，未继续操作。"
		}
	}
	switch {
	case result.Error != "":
		result.Status = "unconfirmed"
	case result.Unverified > 0:
		result.Status = "unverified"
	case len(sessions) == 0:
		result.Status = "not-running"
	default:
		result.Status = "paused"
	}
	publishLegacySyncRetirement(result)
	return result
}
