//go:build !windows

package main

import (
	"context"
	"errors"
	"net"
	"os"
)

func dialLegacySyncEndpoint(ctx context.Context, endpoint string) (net.Conn, error) {
	info, err := os.Lstat(endpoint)
	if err != nil {
		return nil, err
	}
	if info.Mode()&os.ModeSocket == 0 {
		return nil, errors.New("unverified legacy socket")
	}
	return (&net.Dialer{}).DialContext(ctx, "unix", endpoint)
}
