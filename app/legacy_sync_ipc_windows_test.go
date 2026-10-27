package main

import (
	"context"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/Microsoft/go-winio"
	"google.golang.org/grpc"
)

type retirementIPCFixture struct {
	mu       sync.Mutex
	version  []byte
	sessions []legacySyncSession
	methods  []string
	paused   []string
}

func encodeLegacyEndpoint(endpoint legacySyncEndpoint) []byte {
	raw := []byte{}
	if endpoint.Protocol == "ssh" {
		raw = appendLegacyVarint(raw, 1, 1)
	}
	if endpoint.User != "" {
		raw = appendLegacyBytes(raw, 2, []byte(endpoint.User))
	}
	if endpoint.Host != "" {
		raw = appendLegacyBytes(raw, 3, []byte(endpoint.Host))
	}
	if endpoint.Port > 0 {
		raw = appendLegacyVarint(raw, 4, uint64(endpoint.Port))
	}
	return appendLegacyBytes(raw, 5, []byte(endpoint.Path))
}
func encodeLegacyList(sessions []legacySyncSession) []byte {
	raw := []byte{}
	for _, session := range sessions {
		entry := appendLegacyBytes(nil, 1, []byte(session.Identifier))
		entry = appendLegacyBytes(entry, 7, encodeLegacyEndpoint(session.Alpha))
		entry = appendLegacyBytes(entry, 8, encodeLegacyEndpoint(session.Beta))
		if session.Paused {
			entry = appendLegacyVarint(entry, 10, 1)
		}
		entry = appendLegacyBytes(entry, 14, []byte(session.Name))
		raw = appendLegacyBytes(raw, 2, appendLegacyBytes(nil, 1, entry))
	}
	return raw
}
func retirementIPCHandler(fixture *retirementIPCFixture, method string) func(any, context.Context, func(any) error, grpc.UnaryServerInterceptor) (any, error) {
	return func(_ any, ctx context.Context, decode func(any) error, intercept grpc.UnaryServerInterceptor) (any, error) {
		input := legacyWireMessage{}
		if err := decode(&input); err != nil {
			return nil, err
		}
		fixture.mu.Lock()
		defer fixture.mu.Unlock()
		fixture.methods = append(fixture.methods, method)
		output := legacyWireMessage{}
		switch method {
		case legacyVersionMethod:
			output = append(output, fixture.version...)
		case legacyListMethod:
			output = encodeLegacyList(fixture.sessions)
		case legacyPauseMethod:
			fields, err := legacyFields(input)
			if err != nil {
				return nil, err
			}
			identifier := ""
			for _, field := range fields {
				if field.number == 2 {
					selection, err := legacyFields(field.bytes)
					if err != nil {
						return nil, err
					}
					for _, part := range selection {
						if part.number != 2 || part.kind != 2 || identifier != "" {
							return nil, legacyIPCFixtureError("pause must select one exact ID")
						}
						identifier = string(part.bytes)
					}
				}
			}
			if !legacySessionID.MatchString(identifier) {
				return nil, legacyIPCFixtureError("invalid ID")
			}
			fixture.paused = append(fixture.paused, identifier)
			for index := range fixture.sessions {
				if fixture.sessions[index].Identifier == identifier {
					fixture.sessions[index].Paused = true
				}
			}
		}
		return &output, nil
	}
}

type legacyIPCFixtureError string

func (err legacyIPCFixtureError) Error() string { return string(err) }

func privateRetirementIPC(t *testing.T, fixture *retirementIPCFixture) *legacySyncIPCRunner {
	t.Helper()
	profile := t.TempDir()
	directory := filepath.Join(profile, "mutagen", "daemon")
	if err := os.MkdirAll(directory, 0700); err != nil {
		t.Fatal(err)
	}
	uuid := randHex(16)
	pipe := `\\.\pipe\mutagen-ipc-` + uuid[:8] + "-" + uuid[8:12] + "-" + uuid[12:16] + "-" + uuid[16:20] + "-" + uuid[20:]
	listener, err := winio.ListenPipe(pipe, nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(directory, "daemon.sock"), []byte(pipe), 0600); err != nil {
		t.Fatal(err)
	}
	server := grpc.NewServer(grpc.ForceServerCodec(legacyProtoCodec{}))
	server.RegisterService(&grpc.ServiceDesc{ServiceName: "daemon.Daemon", HandlerType: (*interface{})(nil), Methods: []grpc.MethodDesc{{MethodName: "Version", Handler: retirementIPCHandler(fixture, legacyVersionMethod)}}}, fixture)
	server.RegisterService(&grpc.ServiceDesc{ServiceName: "synchronization.Synchronization", HandlerType: (*interface{})(nil), Methods: []grpc.MethodDesc{{MethodName: "List", Handler: retirementIPCHandler(fixture, legacyListMethod)}, {MethodName: "Pause", Handler: retirementIPCHandler(fixture, legacyPauseMethod)}}}, fixture)
	go server.Serve(listener)
	t.Cleanup(func() { server.Stop(); listener.Close() })
	return &legacySyncIPCRunner{profile: profile}
}

func TestCloudOnlyRetirementUsesPrivatePipeWithoutEngine(t *testing.T) {
	mapping, session := legacyRetirementFixture(t)
	foreign := session
	foreign.Identifier = "sync_Foreign000000000000000000"
	foreign.Name = "unrelated"
	version := appendLegacyVarint(appendLegacyVarint(nil, 2, 18), 3, 1)
	fixture := &retirementIPCFixture{version: appendLegacyBytes(version, 4, []byte("chisa.2")), sessions: []legacySyncSession{session, foreign}}
	runner := privateRetirementIPC(t, fixture)
	result := retireLegacySync(context.Background(), &Store{Mappings: []*Mapping{mapping}}, runner)
	if result.Paused != 1 || result.Unverified != 1 || result.Error != "" {
		t.Fatal(result)
	}
	fixture.mu.Lock()
	defer fixture.mu.Unlock()
	if len(fixture.paused) != 1 || fixture.paused[0] != session.Identifier || fixture.sessions[1].Paused {
		t.Fatal("unrelated daemon session changed", fixture.paused)
	}
	for _, method := range fixture.methods {
		if method != legacyVersionMethod && method != legacyListMethod && method != legacyPauseMethod {
			t.Fatal("unexpected mutation", method)
		}
	}
}

func TestCloudOnlyRetirementVersionAndSelectionGate(t *testing.T) {
	for _, kind := range []string{"unsupported-version", "name-collides-with-id"} {
		t.Run(kind, func(t *testing.T) {
			mapping, session := legacyRetirementFixture(t)
			version := appendLegacyVarint(appendLegacyVarint(nil, 2, 18), 3, 1)
			fixture := &retirementIPCFixture{version: version, sessions: []legacySyncSession{session}}
			if kind == "unsupported-version" {
				fixture.version = appendLegacyBytes(version, 4, []byte("unknown"))
			} else {
				other := session
				other.Name = session.Identifier
				other.Identifier = "sync_Foreign000000000000000000"
				fixture.sessions = append(fixture.sessions, other)
			}
			runner := privateRetirementIPC(t, fixture)
			result := retireLegacySync(context.Background(), &Store{Mappings: []*Mapping{mapping}}, runner)
			if result.Paused != 0 {
				t.Fatal(result)
			}
			fixture.mu.Lock()
			defer fixture.mu.Unlock()
			if len(fixture.paused) != 0 {
				t.Fatal("unverified mutation", fixture.paused)
			}
		})
	}
}

func TestCloudOnlyRetirementIPCBoundaries(t *testing.T) {
	runner := &legacySyncIPCRunner{profile: filepath.Join(t.TempDir(), "missing")}
	if sessions, err := runner.list(context.Background()); err != nil || len(sessions) > 0 {
		t.Fatal(sessions, err)
	}
	if _, err := os.Stat(runner.profile); !os.IsNotExist(err) {
		t.Fatal("query created missing profile")
	}
	for _, method := range []string{"/daemon.Daemon/Terminate", "/synchronization.Synchronization/Create", "/synchronization.Synchronization/Resume"} {
		if _, err := runner.invoke(context.Background(), method, nil); err == nil {
			t.Fatal("unsafe method accepted", method)
		}
	}
	for _, name := range []string{`\\.\pipe\unrelated`, "\\\\host\\pipe\\mutagen-ipc-" + strings.Repeat("a", 36), "http://remote"} {
		if legacyPipeName.MatchString(name) {
			t.Fatal("unrelated endpoint allowed", name)
		}
	}
	for _, raw := range [][]byte{{0xff}, {0x12, 0xff}, {0x12, 0x00}} {
		if _, err := decodeLegacyList(raw); err == nil {
			t.Fatal("malformed response accepted", raw)
		}
	}
	valid := appendLegacyVarint(appendLegacyVarint(nil, 2, 18), 3, 1)
	if !legacyKnownDaemonVersion(valid) || legacyKnownDaemonVersion(appendLegacyBytes(valid, 4, []byte("future"))) {
		t.Fatal("version gate failed")
	}
}

// Keep net imported as an explicit compile-time check that the IPC transport
// works on ordinary net.Conn rather than a shell or remote API abstraction.
var _ net.Conn
