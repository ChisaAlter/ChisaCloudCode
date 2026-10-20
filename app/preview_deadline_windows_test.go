package main

import (
	"encoding/json"
	"net/http"
	"sync/atomic"
	"testing"
	"time"
)

func TestPreviewOpenDeadlineCancelsStatusAndReleasesPreviewOperations(t *testing.T) {
	const project = "/srv/workspaces/deadline-project"
	const epoch = "preview-deadline-epoch"
	entered, cancelled := make(chan struct{}), make(chan struct{})
	var inspections atomic.Int32
	connection := previewRecoveryFixture(t, func(w http.ResponseWriter, r *http.Request) {
		var request map[string]string
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
			t.Error(err)
			return
		}
		switch request["op"] {
		case "list":
			_ = json.NewEncoder(w).Encode(map[string]any{"previews": []managedPreviewRecord{{ID: recoveredPreviewID, ServerPath: project, BindingEpoch: epoch, RemoteHost: "172.18.0.9", RemotePort: 3000}}})
		case "inspect":
			if inspections.Add(1) != 1 {
				t.Error("a canceled Open retried its preview request")
			}
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusOK)
			w.(http.Flusher).Flush()
			close(entered)
			<-r.Context().Done()
			close(cancelled)
		case "remove":
			_, _ = w.Write([]byte(`{"ok":true}`))
		default:
			t.Error("unexpected preview operation", request)
		}
	})
	m := &Mapping{LocalPath: t.TempDir(), ServerPath: project, BindingEpoch: epoch, ServerID: serverIdentity(store.config()), Mode: "vps"}
	if err := store.addMapping(m); err != nil {
		t.Fatal(err)
	}
	previews.Lock()
	previews.items[recoveredPreviewID] = Preview{ID: recoveredPreviewID, ServerPath: project, Epoch: epoch, RemoteEpoch: epoch, Managed: true, ServerID: m.ServerID, LocalURL: "http://127.0.0.1:1"}
	previews.Unlock()
	result := make(chan map[string]any, 1)
	started := time.Now()
	go func() { result <- (FrontendBridge{}).OpenPreview(recoveredPreviewID) }()
	select {
	case <-entered:
	case <-time.After(3 * time.Second):
		connection.cancel()
		t.Fatal("Open did not reach the stalled status body")
	}
	select {
	case view := <-result:
		if view["ok"] != false || time.Since(started) < 9*time.Second {
			t.Fatal("Open did not honor its ten-second deadline", view, time.Since(started))
		}
	case <-time.After(12 * time.Second):
		connection.cancel()
		<-result
		t.Fatal("Open discarded its ten-second context while reading status")
	}
	select {
	case <-cancelled:
	case <-time.After(time.Second):
		t.Fatal("deadline did not cancel the pending HTTP response body")
	}
	if connection.ctx.Err() != nil {
		t.Fatal("one canceled Open closed the account connection")
	}
	if stopped := (FrontendBridge{}).StopPreview(recoveredPreviewID); stopped["ok"] != true {
		t.Fatal("canceled Open left the shared preview lock held", stopped)
	}
}
