package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"os"
)

// Keep an unsupported observer on the inventory path; an empty remote token
// must never turn a local-only signature into reusable policy evidence.
var observeSyncIgnoreRemoteMetadata = observeRemoteSyncMetadata

func syncIgnoreEndpointSignatureContext(ctx context.Context, m *Mapping) (string, error) {
	local, err := syncIgnoreSignature(m)
	if err != nil {
		return "", err
	}
	remote, err := observeSyncIgnoreRemoteMetadata(ctx, m)
	if err != nil {
		return "", err
	}
	if local == "" || remote.Ignore == "" {
		return "", fmt.Errorf("文件过滤的增量观察暂不可用")
	}
	key := syncGitObservationKey(ctx, m)
	return fmt.Sprintf("%x", sha256.Sum256([]byte(fmt.Sprintf("%s\x00%#v\x00%s\x00%s\x00%p\x00%p\x00%s\x00%s\x00%t", syncIgnorePolicyVersion, key.mapping, local, remote.Ignore, key.connection, key.transport, key.identity, key.keyPath, key.recovery)))), nil
}

// A daemon session can be replaced or its rules changed without any endpoint
// file event. Bind reusable inventory evidence to the live session as well.
func syncIgnoreSessionSignature(endpoint string, session syncSession) string {
	policy, _ := json.Marshal(struct {
		Identifier string
		Mode       string
		Ignore     any
	}{session.Identifier, session.Mode, session.Ignore})
	return fmt.Sprintf("%x", sha256.Sum256(append([]byte(endpoint+"\x00"), policy...)))
}

// The first create must satisfy the same inventory stability checks as an
// existing session: create starts file transfer before any later final check.
func guardedSyncIgnoreConfigurationContext(ctx context.Context, m *Mapping, before string, beforeErr error) (configuration string, contents []byte, signature string, err error) {
	configuration, err = projectSyncIgnoreConfigurationContext(ctx, m)
	if err != nil {
		return
	}
	contents, err = os.ReadFile(configuration)
	if err != nil {
		return
	}
	after, afterErr := syncIgnoreEndpointSignatureContext(ctx, m)
	if beforeErr == nil && afterErr == nil {
		if before != after {
			err = fmt.Errorf("文件过滤规则在读取期间发生改变，请重新同步")
			return
		}
		signature = after
	} else {
		// Unsupported metadata or watch loss cannot authorize stamp reuse. Two
		// matching full inventories keep that fallback safe without caching it.
		var confirmed string
		confirmed, err = projectSyncIgnoreConfigurationContext(ctx, m)
		if err != nil {
			return
		}
		var other []byte
		other, err = os.ReadFile(confirmed)
		if err != nil {
			return
		}
		if !bytes.Equal(contents, other) {
			err = fmt.Errorf("文件过滤规则持续变化，请重新同步")
			return
		}
	}
	err = workspaceSyncCurrent(ctx)
	return
}
