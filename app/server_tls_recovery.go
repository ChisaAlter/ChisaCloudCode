package main

import (
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"log"
	"net/http"
	"net/http/httptrace"
	"reflect"
	"sync/atomic"
)

// A TLS timeout happens before the target HTTP request can be sent. Recover
// that connection establishment once, not an HTTP operation whose result may
// be unknown. Keep the same verified transport, route, and request budget.
type serverTLSRecoveryTransport struct {
	transport *http.Transport
	account   context.Context
}

func (t *serverTLSRecoveryTransport) CloseIdleConnections() { t.transport.CloseIdleConnections() }

func (t *serverTLSRecoveryTransport) RoundTrip(request *http.Request) (*http.Response, error) {
	var assigned, handshakeTimedOut atomic.Bool
	trace := &httptrace.ClientTrace{
		// Both standard H1 and H2 assign the connection before starting
		// their request writer. This latch covers ALL implicit attempts in
		// Transport.RoundTrip: never reset it on a later TLS handshake.
		GotConn: func(httptrace.GotConnInfo) { assigned.Store(true) },
		TLSHandshakeDone: func(_ tls.ConnectionState, err error) {
			if isServerTLSHandshakeTimeout(err) {
				handshakeTimedOut.Store(true)
			}
		},
	}
	first := request.WithContext(httptrace.WithClientTrace(request.Context(), trace))
	response, err := t.transport.RoundTrip(first)
	if response != nil || !isServerTLSHandshakeTimeout(err) || !handshakeTimedOut.Load() || assigned.Load() || serverTLSRecoveryCanceled(request, t.account) {
		return response, err
	}

	retry := request.Clone(first.Context())
	if request.Body != nil && request.Body != http.NoBody {
		// Transport closes the first body even when getConn fails. Never
		// reuse that closed reader, and never buffer an unrewindable stream.
		if request.GetBody == nil {
			return response, err
		}
		body, restoreErr := request.GetBody()
		if restoreErr != nil {
			return nil, fmt.Errorf("restoring request body after TLS handshake timeout: %w", restoreErr)
		}
		retry.Body = body
	}
	if serverTLSRecoveryCanceled(request, t.account) {
		if retry.Body != nil {
			retry.Body.Close()
		}
		return response, err
	}
	log.Print("[server-connection] event=tls-pre-http-reconnect attempt=2")
	// No loop: any result of this second acquisition is final. A failed TLS
	// socket was already closed by net/http; another usable pool connection
	// may satisfy this acquisition without replacing or draining the pool.
	return t.transport.RoundTrip(retry)
}

func serverTLSRecoveryCanceled(request *http.Request, account context.Context) bool {
	if request.Context().Err() != nil || account.Err() != nil {
		return true
	}
	select {
	case <-request.Cancel:
		return true
	default:
		return false
	}
}

func isServerTLSHandshakeTimeout(err error) bool {
	for cause := err; cause != nil; cause = errors.Unwrap(cause) {
		// net/http does not export this type. Match its package-qualified
		// identity, not an arbitrary error message or a general net timeout.
		typeOf := reflect.TypeOf(cause)
		if typeOf.PkgPath() == "net/http" && typeOf.Name() == "tlsHandshakeTimeoutError" {
			return true
		}
	}
	return false
}

func serverHTTPTransport(transport http.RoundTripper) (*http.Transport, bool) {
	switch transport := transport.(type) {
	case *serverTLSRecoveryTransport:
		return transport.transport, true
	case *http.Transport:
		return transport, true
	default:
		return nil, false
	}
}
