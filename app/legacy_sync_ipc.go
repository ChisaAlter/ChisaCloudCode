package main

import (
	"context"
	"errors"
	"net"
	"os"
	"path/filepath"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/protobuf/encoding/protowire"
)

// This retirement-only client deliberately imports no Mutagen implementation.
// The stable 0.18.1 protobuf fields below expose only Version, List and Pause.
// There is no command runner, engine, resume, create, terminate or daemon start.
const legacyVersionMethod = "/daemon.Daemon/Version"
const legacyListMethod = "/synchronization.Synchronization/List"
const legacyPauseMethod = "/synchronization.Synchronization/Pause"

type legacyWireMessage []byte
type legacyProtoCodec struct{}

func (legacyProtoCodec) Name() string { return "proto" }
func (legacyProtoCodec) Marshal(value any) ([]byte, error) {
	message, ok := value.(*legacyWireMessage)
	if !ok {
		return nil, errors.New("invalid retirement message")
	}
	return []byte(*message), nil
}
func (legacyProtoCodec) Unmarshal(raw []byte, value any) error {
	message, ok := value.(*legacyWireMessage)
	if !ok {
		return errors.New("invalid retirement response")
	}
	*message = append((*message)[:0], raw...)
	return nil
}

func appendLegacyBytes(message []byte, number protowire.Number, value []byte) []byte {
	return protowire.AppendBytes(protowire.AppendTag(message, number, protowire.BytesType), value)
}
func appendLegacyVarint(message []byte, number protowire.Number, value uint64) []byte {
	return protowire.AppendVarint(protowire.AppendTag(message, number, protowire.VarintType), value)
}

type legacyWireField struct {
	number  protowire.Number
	kind    protowire.Type
	bytes   []byte
	integer uint64
}

func legacyFields(message []byte) ([]legacyWireField, error) {
	fields := []legacyWireField{}
	for len(message) > 0 {
		number, kind, n := protowire.ConsumeTag(message)
		if n < 0 {
			return nil, errors.New("invalid legacy tag")
		}
		message = message[n:]
		field := legacyWireField{number: number, kind: kind}
		switch kind {
		case protowire.BytesType:
			field.bytes, n = protowire.ConsumeBytes(message)
		case protowire.VarintType:
			field.integer, n = protowire.ConsumeVarint(message)
		default:
			n = protowire.ConsumeFieldValue(number, kind, message)
		}
		if n < 0 {
			return nil, errors.New("invalid legacy field")
		}
		message = message[n:]
		fields = append(fields, field)
	}
	return fields, nil
}
func legacyKnownDaemonVersion(raw []byte) bool {
	fields, err := legacyFields(raw)
	if err != nil {
		return false
	}
	parts := map[protowire.Number]uint64{}
	tag := ""
	seen := map[protowire.Number]bool{}
	for _, field := range fields {
		if field.number <= 4 {
			if seen[field.number] {
				return false
			}
			seen[field.number] = true
		}
		switch field.number {
		case 1, 2, 3:
			if field.kind != protowire.VarintType {
				return false
			}
			parts[field.number] = field.integer
		case 4:
			if field.kind != protowire.BytesType {
				return false
			}
			tag = string(field.bytes)
		}
	}
	if parts[1] != 0 || parts[2] != 18 || parts[3] != 1 {
		return false
	}
	// chisa.5 is the fork build shipped by the last synchronization release, so a
	// user upgrading from it must still be retired. Only the CLI wrapper changed
	// across these tags (cmd/mutagen/sync/pause.go, pkg/mutagen/version.go); the
	// daemon-side Version, List and Pause RPCs used here are the upstream 0.18.1
	// messages, so an unknown tag still fails closed below.
	switch tag {
	case "", "chisa.1", "chisa.2", "chisa.3", "chisa.4", "chisa.5":
		return true
	}
	return false
}
func decodeLegacyEndpoint(raw []byte) (legacySyncEndpoint, error) {
	endpoint := legacySyncEndpoint{Protocol: "local"}
	fields, err := legacyFields(raw)
	if err != nil {
		return endpoint, err
	}
	seen := map[protowire.Number]bool{}
	for _, field := range fields {
		if seen[field.number] && field.number <= 5 {
			return endpoint, errors.New("ambiguous legacy endpoint")
		}
		seen[field.number] = true
		switch field.number {
		case 1:
			if field.kind != protowire.VarintType {
				return endpoint, errors.New("invalid protocol")
			}
			switch field.integer {
			case 0:
				endpoint.Protocol = "local"
			case 1:
				endpoint.Protocol = "ssh"
			default:
				return endpoint, errors.New("unsupported protocol")
			}
		case 2, 3, 5:
			if field.kind != protowire.BytesType {
				return endpoint, errors.New("invalid endpoint string")
			}
			switch field.number {
			case 2:
				endpoint.User = string(field.bytes)
			case 3:
				endpoint.Host = string(field.bytes)
			case 5:
				endpoint.Path = string(field.bytes)
			}
		case 4:
			if field.kind != protowire.VarintType || field.integer > 65535 {
				return endpoint, errors.New("invalid endpoint port")
			}
			endpoint.Port = uint32(field.integer)
		case 6, 8:
			if len(field.bytes) > 0 {
				return endpoint, errors.New("unverified endpoint overrides")
			}
		case 7:
			if field.kind != protowire.VarintType || field.integer != 0 {
				return endpoint, errors.New("unexpected endpoint kind")
			}
		}
	}
	return endpoint, nil
}
func decodeLegacySession(raw []byte) (legacySyncSession, error) {
	session := legacySyncSession{}
	fields, err := legacyFields(raw)
	if err != nil {
		return session, err
	}
	seen := map[protowire.Number]bool{}
	for _, field := range fields {
		switch field.number {
		case 1, 7, 8, 10, 14:
			if seen[field.number] {
				return session, errors.New("ambiguous legacy session")
			}
			seen[field.number] = true
			if field.number == 10 {
				if field.kind != protowire.VarintType || field.integer > 1 {
					return session, errors.New("invalid paused flag")
				}
				session.Paused = field.integer == 1
				continue
			}
			if field.kind != protowire.BytesType {
				return session, errors.New("invalid session identity")
			}
			switch field.number {
			case 1:
				session.Identifier = string(field.bytes)
			case 14:
				session.Name = string(field.bytes)
			case 7:
				session.Alpha, err = decodeLegacyEndpoint(field.bytes)
			case 8:
				session.Beta, err = decodeLegacyEndpoint(field.bytes)
			}
			if err != nil {
				return session, err
			}
		}
	}
	if !seen[1] || !seen[7] || !seen[8] || !seen[14] {
		return session, errors.New("missing legacy session identity")
	}
	return session, nil
}
func decodeLegacyList(raw []byte) ([]legacySyncSession, error) {
	fields, err := legacyFields(raw)
	if err != nil {
		return nil, err
	}
	sessions := []legacySyncSession{}
	for _, field := range fields {
		if field.number != 2 {
			continue
		}
		if field.kind != protowire.BytesType {
			return nil, errors.New("invalid legacy list")
		}
		state, err := legacyFields(field.bytes)
		if err != nil {
			return nil, err
		}
		found := false
		for _, item := range state {
			if item.number != 1 {
				continue
			}
			if found || item.kind != protowire.BytesType {
				return nil, errors.New("ambiguous legacy state")
			}
			found = true
			session, err := decodeLegacySession(item.bytes)
			if err != nil {
				return nil, err
			}
			sessions = append(sessions, session)
		}
		if !found {
			return nil, errors.New("missing legacy state")
		}
	}
	return sessions, nil
}

type legacySyncIPCRunner struct {
	profile    string
	connection *grpc.ClientConn
}

func newLegacySyncRunner(profile string) legacySyncRunner {
	return &legacySyncIPCRunner{profile: profile}
}
func (runner *legacySyncIPCRunner) Close() error {
	if runner.connection != nil {
		return runner.connection.Close()
	}
	return nil
}
func legacySafeEndpoint(profile string) (string, error) {
	absolute, err := filepath.Abs(profile)
	if err != nil {
		return "", err
	}
	// Missing profile/endpoint means there is no daemon to contact. Check each
	// existing directory rather than following a symlink to another profile.
	for _, directory := range []string{absolute, filepath.Join(absolute, "mutagen"), filepath.Join(absolute, "mutagen", "daemon")} {
		info, err := os.Lstat(directory)
		if err != nil {
			return "", err
		}
		if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
			return "", errors.New("unverified legacy profile directory")
		}
	}
	endpoint := filepath.Join(absolute, "mutagen", "daemon", "daemon.sock")
	info, err := os.Lstat(endpoint)
	if err != nil {
		return "", err
	}
	if info.Mode()&os.ModeSymlink != 0 {
		return "", errors.New("unverified legacy endpoint")
	}
	return endpoint, nil
}
func (runner *legacySyncIPCRunner) connect(ctx context.Context) (bool, error) {
	if runner.connection != nil {
		return true, nil
	}
	endpoint, err := legacySafeEndpoint(runner.profile)
	if os.IsNotExist(err) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	bounded, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	connection, err := grpc.DialContext(bounded, "passthrough:///legacy-retirement", grpc.WithTransportCredentials(insecure.NewCredentials()), grpc.WithContextDialer(func(ctx context.Context, _ string) (net.Conn, error) { return dialLegacySyncEndpoint(ctx, endpoint) }), grpc.WithBlock(), grpc.WithDefaultCallOptions(grpc.ForceCodec(legacyProtoCodec{}), grpc.MaxCallRecvMsgSize(16*1024*1024)))
	if err != nil {
		return false, errors.New("legacy daemon unavailable")
	}
	runner.connection = connection
	version, err := runner.invoke(ctx, legacyVersionMethod, nil)
	if err != nil || !legacyKnownDaemonVersion(version) {
		connection.Close()
		runner.connection = nil
		return false, errors.New("legacy daemon version unverified")
	}
	return true, nil
}
func (runner *legacySyncIPCRunner) invoke(ctx context.Context, method string, input []byte) ([]byte, error) {
	if method != legacyVersionMethod && method != legacyListMethod && method != legacyPauseMethod {
		return nil, errors.New("legacy synchronization method disabled")
	}
	if runner.connection == nil {
		return nil, errors.New("legacy daemon not connected")
	}
	bounded, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	request, response := legacyWireMessage(input), legacyWireMessage{}
	if err := runner.connection.Invoke(bounded, method, &request, &response); err != nil {
		return nil, errors.New("legacy synchronization operation unconfirmed")
	}
	return []byte(response), nil
}
func (runner *legacySyncIPCRunner) list(ctx context.Context) ([]legacySyncSession, error) {
	connected, err := runner.connect(ctx)
	if err != nil {
		return nil, err
	}
	if !connected {
		return nil, nil
	}
	// All=true is used only for a metadata query. Mutating selections below
	// always have exactly one full immutable identifier and All=false.
	request := appendLegacyBytes(nil, 1, appendLegacyVarint(nil, 1, 1))
	raw, err := runner.invoke(ctx, legacyListMethod, request)
	if err != nil {
		return nil, err
	}
	return decodeLegacyList(raw)
}
func (runner *legacySyncIPCRunner) pause(ctx context.Context, identifier string) error {
	if !legacySessionID.MatchString(identifier) {
		return errors.New("invalid legacy session identifier")
	}
	// Guard the CLI-compatible selection namespace: an unrelated session with
	// a friendly Name equal to this identifier must never also be selected.
	sessions, err := runner.list(ctx)
	if err != nil {
		return err
	}
	matches := 0
	for _, session := range sessions {
		if session.Identifier == identifier {
			matches++
		}
		if session.Name == identifier {
			return errors.New("legacy identifier collides with session name")
		}
	}
	if matches != 1 {
		return errors.New("legacy session identity changed")
	}
	selection := appendLegacyBytes(nil, 2, []byte(identifier))
	request := appendLegacyBytes(nil, 1, []byte("chisa-cloud-only-retirement"))
	request = appendLegacyBytes(request, 2, selection)
	_, err = runner.invoke(ctx, legacyPauseMethod, request)
	return err
}
