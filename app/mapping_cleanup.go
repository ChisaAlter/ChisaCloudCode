package main

import (
	"context"
	"fmt"
	"sort"
	"sync"
	"time"
)

// A switch applies only to the selected inactive projects displayed to the user.
type WorkspaceBindingSelection struct {
	ServerPath   string `json:"serverPath"`
	BindingEpoch string `json:"bindingEpoch"`
}

// Caller holds serverConnectionMu; only one account transport is active at a time.
func workspaceMappingsActiveLocked() bool {
	return workspaceConnectionMatchesSession()
}

func workspaceMappingActiveLocked(m *Mapping) bool {
	return m != nil && workspaceMappingsActiveLocked() && m.ServerID == serverIdentity(store.config())
}

// Caller holds serverConnectionMu; inactive account bindings remain manageable.
func inactiveWorkspaceMappingsLocked() []*Mapping {
	inactive := []*Mapping{}
	for _, mapping := range store.mappings() {
		if !workspaceMappingActiveLocked(mapping) {
			inactive = append(inactive, mapping)
		}
	}
	return inactive
}

// ForgetMapping removes only this machine's inactive binding. It never contacts
// the old or current account's server or deletes either side's project files.
func (FrontendBridge) ForgetMapping(serverPath, bindingEpoch string) map[string]any {
	lock, _ := workspaceLocks.LoadOrStore(serverPath, &sync.Mutex{})
	mu := lock.(*sync.Mutex)
	if !mu.TryLock() {
		return map[string]any{"ok": false, "error": "工作目录正在使用中，请等待当前操作结束后再移除"}
	}
	defer mu.Unlock()
	// Keep account activation from racing local termination of its old session.
	serverConnectionMu.RLock()
	defer serverConnectionMu.RUnlock()
	m := store.findMappingByServer(serverPath)
	active := workspaceMappingActiveLocked(m)
	if m == nil || bindingEpoch == "" || m.BindingEpoch != bindingEpoch {
		return map[string]any{"ok": false, "error": "项目绑定已改变，请刷新状态后重新操作"}
	}
	if active {
		return map[string]any{"ok": false, "error": "当前账号的映射请使用项目同步中的「移除」操作"}
	}
	if err := inactiveMappingBusy(m); err != nil {
		return map[string]any{"ok": false, "error": err.Error()}
	}
	if err := terminateInactiveMappingSync(m); err != nil {
		return map[string]any{"ok": false, "error": "停止旧映射的本机同步失败，未移除绑定：" + err.Error()}
	}
	if err := removeInactiveMappingRecord(m); err != nil {
		return map[string]any{"ok": false, "error": "本机映射记录保存失败，未移除绑定"}
	}
	return map[string]any{"ok": true}
}

type accountWorkspaceSwitch struct {
	connection *serverConnection
	mappings   []*Mapping
}

// SwitchAccountWorkspace rebinds only the selected projects to the current account.
// Unselected account bindings and all old server files remain intact.
func (FrontendBridge) SwitchAccountWorkspace(bindings []WorkspaceBindingSelection) map[string]any {
	selection, cleared, err := clearAccountWorkspaceBindings(bindings)
	if err != nil {
		message := err.Error()
		if cleared > 0 {
			message = fmt.Sprintf("已解除 %d 个旧映射，其余旧映射保留；%s", cleared, message)
		}
		return map[string]any{"ok": false, "error": message, "clearedMappings": cleared, "bindingsCleared": false}
	}
	serverConnectionMu.RLock()
	ready := apiConnection == selection.connection && workspaceMappingsActiveLocked() && tunnel != nil && tunnel.controlAlive()
	serverConnectionMu.RUnlock()
	if !ready {
		if err := waitAccountWorkspace(selection.connection, true); err != nil {
			return map[string]any{"ok": false, "error": "所选项目的旧映射已解除，两端项目文件已保留；当前账号的文件同步连接失败：" + err.Error(), "clearedMappings": cleared, "bindingsCleared": true}
		}
	}
	projects := []map[string]any{}
	for _, mapping := range selection.mappings {
		result := prepareLocalProjectForConnection(selection.connection, mapping.LocalPath)
		if result["ok"] != true {
			return map[string]any{"ok": false, "error": fmt.Sprintf("所选项目的旧映射已解除；项目 %s 尚未完成切换：%v", mapping.LocalPath, result["error"]), "clearedMappings": cleared, "bindingsCleared": true, "projects": projects}
		}
		projects = append(projects, map[string]any{"localPath": result["localPath"], "serverPath": result["serverPath"]})
	}
	return map[string]any{"ok": true, "clearedMappings": cleared, "bindingsCleared": true, "tunnel": true, "projects": projects}
}

func clearAccountWorkspaceBindings(bindings []WorkspaceBindingSelection) (*accountWorkspaceSwitch, int, error) {
	serverConnectionMu.RLock()
	defer serverConnectionMu.RUnlock()
	connection := apiConnection
	if connection == nil || !connection.authenticated || connection.ctx.Err() != nil {
		return nil, 0, fmt.Errorf("请先登录当前账号，再切换文件同步")
	}
	inactive := inactiveWorkspaceMappingsLocked()
	if len(bindings) == 0 {
		return nil, 0, fmt.Errorf("旧映射列表已改变，请刷新状态后重新切换")
	}
	selected := make(map[string]string, len(bindings))
	for _, binding := range bindings {
		if binding.ServerPath == "" || binding.BindingEpoch == "" || selected[binding.ServerPath] != "" {
			return nil, 0, fmt.Errorf("旧映射列表无效，请刷新状态后重新切换")
		}
		selected[binding.ServerPath] = binding.BindingEpoch
	}
	current := []*Mapping{}
	for _, mapping := range inactive {
		if epoch, chosen := selected[mapping.ServerPath]; chosen {
			if epoch != mapping.BindingEpoch {
				return nil, 0, fmt.Errorf("所选项目绑定已改变，请刷新状态后重新切换")
			}
			current = append(current, mapping)
		}
	}
	if len(current) != len(bindings) {
		return nil, 0, fmt.Errorf("所选项目绑定已改变，请刷新状态后重新切换")
	}
	guarded := current
	if !workspaceMappingsActiveLocked() || tunnel == nil || !tunnel.controlAlive() {
		// Replacing the single transport must not interrupt an unselected task.
		guarded = store.mappings()
	}
	unlock, err := lockAccountWorkspaceMappings(guarded)
	if err != nil {
		return nil, 0, err
	}
	defer unlock()
	for _, mapping := range current {
		latest := store.findMappingByServer(mapping.ServerPath)
		if latest == nil || latest.BindingEpoch != mapping.BindingEpoch || workspaceMappingActiveLocked(latest) {
			return nil, 0, fmt.Errorf("旧映射列表已改变，请刷新状态后重新切换")
		}
	}
	for _, mapping := range guarded {
		if err := inactiveMappingBusy(mapping); err != nil {
			return nil, 0, fmt.Errorf("项目 %s：%w", mapping.LocalPath, err)
		}
	}
	cleared := 0
	for _, mapping := range current {
		if err := terminateInactiveMappingSync(mapping); err != nil {
			return nil, cleared, fmt.Errorf("停止旧映射的本机同步失败，该映射保留：%s；%w", mapping.LocalPath, err)
		}
		if err := removeInactiveMappingRecord(mapping); err != nil {
			return nil, cleared, fmt.Errorf("本机同步已停止，但旧映射记录保存失败，该记录保留：%s", mapping.LocalPath)
		}
		cleared++
	}
	return &accountWorkspaceSwitch{connection: connection, mappings: current}, cleared, nil
}

// Caller holds the account lock. TryLock avoids waiting behind an operation
// which may itself need the account lock to finish.
func lockAccountWorkspaceMappings(mappings []*Mapping) (func(), error) {
	ordered := append([]*Mapping{}, mappings...)
	sort.Slice(ordered, func(i, j int) bool { return ordered[i].ServerPath < ordered[j].ServerPath })
	locked := make([]*sync.Mutex, 0, len(ordered))
	unlock := func() {
		for i := len(locked) - 1; i >= 0; i-- {
			locked[i].Unlock()
		}
	}
	for _, mapping := range ordered {
		lock, _ := workspaceLocks.LoadOrStore(mapping.ServerPath, &sync.Mutex{})
		mu := lock.(*sync.Mutex)
		if !mu.TryLock() {
			unlock()
			return nil, fmt.Errorf("工作目录正在使用中，请等待当前操作结束后再切换：%s", mapping.LocalPath)
		}
		locked = append(locked, mu)
	}
	return unlock, nil
}

func removeInactiveMappingRecord(m *Mapping) error {
	if err := store.removeMappingBinding(m.ServerPath, m.BindingEpoch); err != nil {
		return err
	}
	if value, ok := pendingEmptyConfirmations.Load(m.ServerPath); ok && value.(pendingEmptyConfirmation).epoch == m.BindingEpoch {
		pendingEmptyConfirmations.Delete(m.ServerPath)
	}
	if value, ok := syncStopUnconfirmed.Load(m.ServerPath); ok && value.(unconfirmedSyncStop).epoch == m.BindingEpoch {
		syncStopUnconfirmed.Delete(m.ServerPath)
	}
	publishProjectSync(m)
	return nil
}

func inactiveMappingBusy(m *Mapping) error {
	if err := mappingTaskBusy(m, false); err != nil {
		return err
	}
	record, err := loadSyncRelease(m)
	if err != nil {
		return fmt.Errorf("无法确认项目的同步交还记录，未移除绑定：%w", err)
	}
	if record != nil {
		return fmt.Errorf("同步工作区尚未交还，请连接项目所属账号完成同步恢复后再操作")
	}
	if value, ok := pendingSyncReleases.Load(m.ServerPath); ok && value.(pendingSyncRelease).epoch == m.BindingEpoch {
		return fmt.Errorf("同步工作区尚未交还，请连接项目所属账号完成同步恢复后再操作")
	}
	return nil
}

// Restoring the same account needs its transport before it can release a saved
// synchronization lease. Live tasks and other workspace owners still block it.
func mappingTaskBusy(m *Mapping, allowIdlePiRecovery bool) error {
	if _, owned := cloudReservations.Load(m.ServerPath); owned {
		return fmt.Errorf("Claude 任务尚未结束，请先结束该项目任务")
	}
	if operation, ok := activeSyncOperations()[m.ServerPath]; ok && operation.BindingEpoch == m.BindingEpoch {
		return fmt.Errorf("工作目录正在同步，请等待同步结束后再切换")
	}
	piAgents.Lock()
	if err := piLoadLocked(); err != nil {
		piAgents.Unlock()
		return err
	}
	for _, session := range piAgents.sessions {
		if session.ServerPath == m.ServerPath && session.BindingEpoch == m.BindingEpoch &&
			(session.process != nil || session.Running || (!allowIdlePiRecovery && (session.Owner == "pi" || session.LeaseID != ""))) {
			piAgents.Unlock()
			return fmt.Errorf("Pi 或运行程序尚未停止，或工作区尚未交还；请先恢复或停止该项目任务")
		}
	}
	piAgents.Unlock()
	for _, preview := range previewList() {
		if preview.ServerPath == m.ServerPath && preview.Epoch == m.BindingEpoch {
			return fmt.Errorf("项目预览尚未停止，请先停止该项目预览")
		}
	}
	return nil
}

func terminateInactiveMappingSync(m *Mapping) error {
	return terminateSync(m.SyncName)
}

// An inactive project's daemon session is retained for its original account.
// Pausing by exact identifier prevents its SSH process from following a new login.
func pauseInactiveMappingSync(m *Mapping) error {
	if m.SyncName == "" {
		return nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	sessions, err := syncSessionsContext(ctx, m.SyncName)
	if err != nil {
		return err
	}
	if len(sessions) == 0 {
		return nil
	}
	if len(sessions) != 1 || sessions[0].Identifier == "" {
		return fmt.Errorf("无法确认旧项目对应的唯一同步会话")
	}
	if sessions[0].Paused {
		return nil
	}
	_, err = runMutagenContext(ctx, "sync", "pause", sessions[0].Identifier)
	return err
}
