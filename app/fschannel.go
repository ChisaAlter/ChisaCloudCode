package main

import (
	"crypto/subtle"
	"encoding/json"
	"net/http"
)

// No direct Windows filesystem fallback is exposed by this endpoint.
func registerFSEndpoints(mux *http.ServeMux) {
	mux.HandleFunc("/workspace/rpc", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			jsonResp(w, 405, map[string]any{"error": "method not allowed"})
			return
		}
		if subtle.ConstantTimeCompare([]byte(r.Header.Get("X-Bridge-Token")), []byte(store.config().Token)) != 1 {
			jsonResp(w, 401, map[string]any{"error": "unauthorized"})
			return
		}
		m := store.findMappingByServer(r.Header.Get("X-Cwd"))
		serverConnectionMu.RLock()
		ready := workspaceConnectionMatchesSession()
		serverConnectionMu.RUnlock()
		if !ready || m == nil || m.ServerID != serverIdentity(store.config()) || m.BindingEpoch != r.Header.Get("X-Binding-Epoch") {
			jsonResp(w, 409, map[string]any{"error": "工作区绑定已失效", "code": "STALE_BINDING"})
			return
		}
		var request map[string]any
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 16*1024*1024)).Decode(&request); err != nil {
			jsonResp(w, 400, map[string]any{"error": "invalid request"})
			return
		}
		ctx, cancel, err := workspaceRequestContext(r)
		if err != nil {
			jsonResp(w, 400, map[string]any{"error": err.Error(), "code": "INVALID_REQUEST"})
			return
		}
		defer cancel()
		jsonResp(w, 200, workspaceRPCContext(ctx, m, request))
	})
}
