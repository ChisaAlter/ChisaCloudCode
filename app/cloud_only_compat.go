package main

import (
	"path"
	"strings"
)

func retiredWorkspaceSyncPath(value string) bool {
	clean := path.Clean(value)
	return clean == "/api/workspace-sync" || strings.HasPrefix(clean, "/api/workspace-sync/")
}

const cloudOnlyCode = "CLOUD_ONLY_DESKTOP"
const cloudOnlyMessage = "桌面端本地同步和本地执行已移除，请使用云端项目和云端运行环境。历史项目文件和本机记录保留。"

func cloudOnlyFailure() map[string]any {
	return map[string]any{"ok": false, "code": cloudOnlyCode, "error": cloudOnlyMessage}
}

// These inert methods give cached/older pages a deterministic migration error.
// No legacy implementation, process launcher, control listener or feature flag
// remains in the application. The full pre-removal source is the review baseline.
type WorkspaceBindingSelection struct {
	ServerPath   string `json:"serverPath"`
	BindingEpoch string `json:"bindingEpoch"`
}

type piAttachmentInput struct {
	Name       string `json:"name"`
	MimeType   string `json:"mimeType"`
	DataBase64 string `json:"dataBase64"`
}

type ProjectStorage struct {
	LocalBytes  *int64 `json:"localBytes"`
	ServerBytes *int64 `json:"serverBytes"`
	LocalError  string `json:"localError,omitempty"`
	ServerError string `json:"serverError,omitempty"`
}

type SyncInfo struct {
	Status     string `json:"status"`
	Detail     string `json:"detail,omitempty"`
	Code       string `json:"code,omitempty"`
	ServerPath string `json:"serverPath"`
}

func (FrontendBridge) SelectLocalFolder() map[string]any                 { return cloudOnlyFailure() }
func (FrontendBridge) ConnectWorkspace(_, _, _, _ string) map[string]any { return cloudOnlyFailure() }
func (FrontendBridge) ConnectAccountWorkspace() map[string]any           { return cloudOnlyFailure() }
func (FrontendBridge) SelectWorkspaceKey() map[string]any                { return cloudOnlyFailure() }
func (FrontendBridge) Revoke(_ string) map[string]any                    { return cloudOnlyFailure() }
func (FrontendBridge) ForgetMapping(_, _ string) map[string]any          { return cloudOnlyFailure() }
func (FrontendBridge) SwitchAccountWorkspace(_ []WorkspaceBindingSelection) map[string]any {
	return cloudOnlyFailure()
}
func (FrontendBridge) SyncProject(_ string) map[string]any                { return cloudOnlyFailure() }
func (FrontendBridge) ConfirmProjectEmpty(_, _ string) map[string]any     { return cloudOnlyFailure() }
func (FrontendBridge) GetProjectGitRecovery(_, _ string) map[string]any   { return cloudOnlyFailure() }
func (FrontendBridge) RecoverProjectGit(_, _, _, _ string) map[string]any { return cloudOnlyFailure() }
func (FrontendBridge) GetProjectSync(serverPath string) SyncInfo {
	return SyncInfo{Status: "disabled", Detail: cloudOnlyMessage, Code: cloudOnlyCode, ServerPath: serverPath}
}
func (FrontendBridge) GetProjectStorage(serverPath string) map[string]ProjectStorage {
	return map[string]ProjectStorage{serverPath: {LocalError: cloudOnlyMessage, ServerError: cloudOnlyMessage}}
}
func (FrontendBridge) PiInstall() map[string]any                    { return cloudOnlyFailure() }
func (FrontendBridge) PiGetConfig() map[string]any                  { return cloudOnlyFailure() }
func (FrontendBridge) PiSaveConfig(_ map[string]any) map[string]any { return cloudOnlyFailure() }
func (FrontendBridge) PiGetSession(_, _ string) map[string]any      { return cloudOnlyFailure() }
func (FrontendBridge) PiEvents(_, _ string, _ int64) map[string]any { return cloudOnlyFailure() }
func (FrontendBridge) PiPrompt(_, _, _, _ string, _ []piAttachmentInput) map[string]any {
	return cloudOnlyFailure()
}
func (FrontendBridge) PiRecoverSession(_, _ string) map[string]any { return cloudOnlyFailure() }
func (FrontendBridge) PiAbort(_, _ string) map[string]any          { return cloudOnlyFailure() }
func (FrontendBridge) RefreshPreviews() map[string]any             { return cloudOnlyFailure() }
func (FrontendBridge) OpenPreview(_ string) map[string]any         { return cloudOnlyFailure() }
func (FrontendBridge) StopPreview(_ string) map[string]any         { return cloudOnlyFailure() }
