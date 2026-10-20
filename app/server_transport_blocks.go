package main

import (
	"bytes"
	"encoding/json"
	"log"
	"runtime"
	"sort"
	"strings"
)

type serverTransportBlockCount struct {
	Category string `json:"category"`
	State    string `json:"state"`
	Count    int    `json:"count"`
}

type serverTransportBlockSample struct {
	Point     string                      `json:"point"`
	Scope     string                      `json:"scope"`
	Truncated bool                        `json:"truncated"`
	Counts    []serverTransportBlockCount `json:"counts"`
}

// This explicit probe samples process-wide transport stacks, not a particular
// account/connection. Idle readers can legitimately be in netpoll. Only fixed
// categories and states survive parsing; raw stacks, arguments and paths never
// leave this function or enter logs/bridge results.
func sampleServerTransportBlocks(point string) serverTransportBlockSample {
	stack := make([]byte, 1<<20)
	n := runtime.Stack(stack, true)
	sample := classifyServerTransportBlocks(stack[:n], n == len(stack))
	if point != "before" && point != "after" && point != "tls-one-second" {
		point = "unknown"
	}
	sample.Point = point
	raw, _ := json.Marshal(sample)
	log.Printf("[server-transport-blocks] %s", raw)
	return sample
}

func classifyServerTransportBlocks(stack []byte, truncated bool) serverTransportBlockSample {
	type countKey struct{ category, state string }
	counts := make(map[countKey]int)
	for _, goroutine := range bytes.Split(stack, []byte("\n\n")) {
		lines := bytes.Split(goroutine, []byte("\n"))
		if len(lines) < 2 || !bytes.HasPrefix(lines[0], []byte("goroutine ")) {
			continue
		}
		frames := make(map[string]bool)
		for _, line := range lines[1:] {
			if len(line) == 0 || line[0] == '\t' || bytes.HasPrefix(line, []byte("created by ")) {
				continue
			}
			// The final '(' starts arguments; earlier ones belong to method
			// receiver syntax. Arguments and the following path line are ignored.
			if end := bytes.LastIndexByte(line, '('); end > 0 {
				frames[string(line[:end])] = true
			}
		}
		state := serverTransportWaitState(lines[0], frames)
		if category := serverTransportBlockCategory(frames); category != "" {
			if category == "h2-reader" {
				tlsRead := frames["crypto/tls.(*Conn).Read"] || frames["crypto/tls.(*Conn).readRecordOrCCS"]
				if tlsRead && (state == "read-io" || state == "mutex" || state == "channel") {
					state = "tls-" + state
				}
			}
			counts[countKey{category, state}]++
		}
	}
	sample := serverTransportBlockSample{Scope: "process", Truncated: truncated, Counts: []serverTransportBlockCount{}}
	for key, count := range counts {
		sample.Counts = append(sample.Counts, serverTransportBlockCount{key.category, key.state, count})
	}
	sort.Slice(sample.Counts, func(i, j int) bool {
		if sample.Counts[i].Category != sample.Counts[j].Category {
			return sample.Counts[i].Category < sample.Counts[j].Category
		}
		return sample.Counts[i].State < sample.Counts[j].State
	})
	return sample
}

func serverTransportWaitState(header []byte, frames map[string]bool) string {
	begin, end := bytes.IndexByte(header, '['), bytes.LastIndexByte(header, ']')
	if begin < 0 || end <= begin {
		return "other"
	}
	state := strings.TrimSpace(strings.SplitN(string(header[begin+1:end]), ",", 2)[0])
	switch state {
	case "IO wait":
		if frames["internal/poll.runtime_pollWait"] || frames["runtime.netpollblock"] {
			if frames["internal/poll.(*FD).Read"] || frames["net.(*netFD).Read"] {
				return "read-io"
			}
			if frames["internal/poll.(*FD).Write"] || frames["net.(*netFD).Write"] {
				return "write-io"
			}
		}
		return "io-wait"
	case "sync.Cond.Wait":
		return "cond"
	case "semacquire", "sync.Mutex.Lock", "sync.RWMutex.Lock", "sync.RWMutex.RLock":
		if frames["sync.(*Cond).Wait"] {
			return "cond"
		}
		return "mutex"
	case "chan receive", "chan send", "select":
		return "channel"
	case "running", "runnable", "sleep", "syscall":
		return state
	default:
		return "other"
	}
}

func serverTransportBlockCategory(frames map[string]bool) string {
	const h2 = "net/http/internal/http2."
	if frames["crypto/x509.(*Certificate).systemVerify"] || frames["syscall.CertGetCertificateChain"] || frames["syscall.CertVerifyCertificateChainPolicy"] {
		return "windows-cert-chain"
	}
	if frames[h2+"(*ClientConn).readLoop"] || frames[h2+"(*clientConnReadLoop).run"] {
		return "h2-reader"
	}
	// CONNECT's response is read in dialConn's helper goroutine. Unlike a
	// regular H1 response read, it has dialConn.func* but no persistConn.readLoop.
	dialHelper, addTLS := false, false
	for frame := range frames {
		dialHelper = dialHelper || strings.HasPrefix(frame, "net/http.(*Transport).dialConn.func")
		addTLS = addTLS || strings.HasPrefix(frame, "net/http.(*persistConn).addTLS")
	}
	if dialHelper && frames["net/http.ReadResponse"] {
		return "http-proxy-connect-read"
	}
	if dialHelper && frames["net/http.(*Request).Write"] {
		return "http-proxy-connect-write"
	}
	// This can be direct target TLS, HTTPS-proxy outer TLS, or target TLS
	// after CONNECT. It identifies client TLS without claiming which hop.
	if addTLS && (frames["crypto/tls.(*Conn).clientHandshake"] || frames["crypto/tls.(*Conn).handshakeContext"]) {
		return "http-client-tls"
	}
	if frames[h2+"transportResponseBody.Read"] && frames[h2+"(*pipe).Read"] {
		return "h2-response-body"
	}
	if frames[h2+"transportResponseBody.Close"] {
		return "h2-response-close"
	}
	if frames[h2+"(*clientStream).awaitFlowControl"] {
		return "h2-request-flow"
	}
	if frames[h2+"(*ClientConn).awaitOpenSlotForStreamLocked"] {
		return "h2-request-slot"
	}
	if frames[h2+"(*ClientConn).roundTrip"] {
		return "h2-roundtrip"
	}
	if frames[h2+"(*clientStream).writeRequest"] || frames[h2+"(*clientStream).cleanupWriteRequest"] {
		return "h2-request-writer"
	}
	return ""
}
