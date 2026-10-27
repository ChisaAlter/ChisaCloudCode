package main

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
)

// The account lock protects only snapshots and fences. IO uses the exact
// authenticated connection captured by the native call, never a JS credential.
func registerSshAgent(ctx context.Context, scope sshAccountScope, profile SshTunnelProfile, token string) error {
	serverConnectionMu.RLock()
	connection := scope.connection
	current := connection != nil && apiConnection == connection && connection.authenticated && connection.accountIdentity == scope.identity && connection.version == scope.version && scope.ctx.Err() == nil && connection.ctx.Err() == nil
	accessToken := ""
	if current {
		accessToken = connection.accessToken
	}
	serverConnectionMu.RUnlock()
	if !current {
		return sshFailure("SSH_ACCOUNT_CHANGED", "账号连接已改变，Agent 登记已取消。")
	}
	if accessToken == "" {
		return sshFailure("SSH_ACCOUNT_REQUIRED", "账号登录凭据不可用，请重新登录后登记 Agent。")
	}
	fields := map[string]any{"id": profile.ID, "name": profile.Name, "port": profile.RemotePort, "token": token}
	if profile.AgentTransport == "relay" {
		fields["delivery"] = "relay"
	}
	payload, _ := json.Marshal(fields)
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, strings.TrimRight(connection.baseURL, "/")+"/api/ssh-workspaces/agent/connections", bytes.NewReader(payload))
	if err != nil {
		return sshFailure("SSH_AGENT_REGISTRATION_FAILED", "无法创建 Agent 登记请求。")
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Authorization", "Bearer "+accessToken)
	response, err := connection.client.Do(request)
	if err != nil {
		return sshFailure("SSH_AGENT_REGISTRATION_FAILED", "Agent 登记连接失败或超时，请重试。")
	}
	defer response.Body.Close()
	raw, readErr := io.ReadAll(io.LimitReader(response.Body, 64*1024+1))
	serverConnectionMu.Lock()
	defer serverConnectionMu.Unlock()
	if apiConnection != connection || !connection.authenticated || connection.accountIdentity != scope.identity || connection.version != scope.version || scope.ctx.Err() != nil {
		return sshFailure("SSH_ACCOUNT_CHANGED", "账号连接已改变，Agent 登记已取消。")
	}
	if ctx.Err() != nil {
		return sshFailure("SSH_AGENT_REGISTRATION_FAILED", "Agent 登记请求超时或中断，请重试。")
	}
	if response.StatusCode != http.StatusOK || readErr != nil || len(raw) > 64*1024 {
		return sshFailure("SSH_AGENT_REGISTRATION_FAILED", "账号服务未能确认 Agent 登记，请重试。")
	}
	var result struct {
		OK         bool `json:"ok"`
		Connection struct {
			ID        string `json:"id"`
			Port      int    `json:"port"`
			Transport string `json:"transport"`
		} `json:"connection"`
	}
	if json.Unmarshal(raw, &result) != nil || !result.OK || result.Connection.ID != profile.ID || result.Connection.Port != profile.RemotePort || result.Connection.Transport != "agent" {
		return sshFailure("SSH_AGENT_REGISTRATION_FAILED", "账号服务返回的 Agent 登记身份无效，请重试。")
	}
	recordNativeRefreshedToken(connection, response.Header, response.StatusCode)
	return nil
}
