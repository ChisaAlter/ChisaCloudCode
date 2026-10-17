package main

import (
	"context"
	"fmt"
	"net/http"
	"strconv"
	"sync"
	"time"
)

const workspaceSyncTimeout = 620 * time.Second
const serverRequestTimeout = 2000 * time.Second
const workspaceDeadlineHeader = "X-Chisa-Deadline-Ms"

func workspaceRequestContext(r *http.Request) (context.Context, context.CancelFunc, error) {
	deadline := time.Now().Add(workspaceSyncTimeout)
	if raw := r.Header.Get(workspaceDeadlineHeader); raw != "" {
		milliseconds, err := strconv.ParseInt(raw, 10, 64)
		if err != nil || milliseconds <= 0 {
			return nil, nil, fmt.Errorf("invalid workspace deadline")
		}
		if requested := time.UnixMilli(milliseconds); requested.Before(deadline) {
			deadline = requested
		}
	}
	ctx, cancel := context.WithDeadline(r.Context(), deadline)
	return ctx, cancel, nil
}

// A canceled waiter never enters the workspace or leaves its mutex held.
func lockWorkspace(ctx context.Context, serverPath string) (func(), error) {
	lock, _ := workspaceLocks.LoadOrStore(serverPath, &sync.Mutex{})
	mu := lock.(*sync.Mutex)
	return lockContext(ctx, mu)
}

func lockContext(ctx context.Context, mu *sync.Mutex) (func(), error) {
	acquired := make(chan func())
	go func() {
		mu.Lock()
		select {
		case acquired <- mu.Unlock:
		case <-ctx.Done():
			mu.Unlock()
		}
	}()
	select {
	case unlock := <-acquired:
		if err := ctx.Err(); err != nil {
			unlock()
			return nil, err
		}
		return unlock, nil
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}
