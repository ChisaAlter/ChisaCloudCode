package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
)

type accountWorkspaceError struct {
	Code    string
	Message string
}

func (err *accountWorkspaceError) Error() string { return err.Message }

// Managed transports run sandbox operations through the same authenticated account service.
func accountWorkspaceRPC(ctx context.Context, endpoint string, payload map[string]any) (map[string]any, error) {
	serverConnectionMu.RLock()
	connection := apiConnection
	cfg := store.config()
	snapshot, _ := ctx.Value(workspaceSyncConnectionKey{}).(*workspaceSyncConnection)
	allowRecovery, _ := ctx.Value(workspaceRecoveryContextKey{}).(bool)
	allowRecovery = allowRecovery || (snapshot != nil && snapshot.allowRecovery)
	if ctx.Err() != nil || (snapshot != nil && !snapshot.currentLocked()) || connection == nil || !connection.authenticated || cfg.WorkspaceAccount != connection.accountIdentity || cfg.WorkspaceLoginURL != connection.loginURL {
		serverConnectionMu.RUnlock()
		return nil, fmt.Errorf("工作区账号连接已改变")
	}
	if connection.workspaceRecoveryOnly && endpoint == "/api/workspace-sync/worker" && !allowRecovery {
		serverConnectionMu.RUnlock()
		return nil, fmt.Errorf("工作区正在恢复交还，请先完成恢复再操作项目")
	}
	accessToken := connection.accessToken
	serverConnectionMu.RUnlock()
	operation, cancel := context.WithCancel(ctx)
	defer cancel()
	stopCancellation := context.AfterFunc(connection.ctx, cancel)
	defer stopCancellation()
	body, err := json.Marshal(payload)
	if err != nil {
		return nil, err
	}
	request, err := http.NewRequestWithContext(operation, http.MethodPost, connection.baseURL+endpoint, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	request.Header.Set("Authorization", "Bearer "+accessToken)
	request.Header.Set("Content-Type", "application/json")
	response, err := connection.client.Do(request)
	if err != nil {
		return nil, fmt.Errorf("工作区账号服务请求失败")
	}
	defer response.Body.Close()
	var result map[string]any
	var responseError struct {
		Error struct {
			Code    string `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
	}
	var decodeErr error
	if response.StatusCode == http.StatusOK {
		decodeErr = json.NewDecoder(io.LimitReader(response.Body, 64*1024*1024+1)).Decode(&result)
	} else {
		decodeErr = json.NewDecoder(io.LimitReader(response.Body, 64*1024)).Decode(&responseError)
	}
	serverConnectionMu.Lock()
	current := apiConnection == connection && connection.authenticated && connection.ctx.Err() == nil && operation.Err() == nil
	if current {
		recordNativeRefreshedToken(connection, response.Header, response.StatusCode)
	}
	serverConnectionMu.Unlock()
	if !current {
		return nil, fmt.Errorf("工作区账号连接已改变")
	}
	if response.StatusCode != http.StatusOK {
		if decodeErr == nil && responseError.Error.Code != "" {
			message := responseError.Error.Message
			if message == "" {
				message = fmt.Sprintf("工作区账号服务请求失败（HTTP %d）", response.StatusCode)
			}
			return nil, &accountWorkspaceError{Code: responseError.Error.Code, Message: message}
		}
		return nil, fmt.Errorf("工作区账号服务请求失败（HTTP %d）", response.StatusCode)
	}
	if decodeErr != nil {
		return nil, fmt.Errorf("工作区账号服务响应无效")
	}
	return result, nil
}
