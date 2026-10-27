package main

import (
	"context"
	"errors"
	"io"
	"net"
	"os"
	"regexp"

	"github.com/Microsoft/go-winio"
)

var legacyPipeName = regexp.MustCompile(`^\\\\\.\\pipe\\mutagen-ipc-[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$`)

func dialLegacySyncEndpoint(ctx context.Context, endpoint string) (net.Conn, error) {
	info, err := os.Lstat(endpoint)
	if err != nil || !info.Mode().IsRegular() || info.Size() > 256 {
		return nil, errors.New("unverified legacy pipe file")
	}
	file, err := os.Open(endpoint)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	opened, err := file.Stat()
	if err != nil || !os.SameFile(info, opened) {
		return nil, errors.New("legacy pipe file changed")
	}
	raw, err := io.ReadAll(io.LimitReader(file, 257))
	if err != nil {
		return nil, err
	}
	if !legacyPipeName.Match(raw) {
		return nil, errors.New("unverified legacy pipe name")
	}
	return winio.DialPipeContext(ctx, string(raw))
}
