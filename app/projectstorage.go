package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os/exec"
	"time"
)

type ProjectStorage struct {
	LocalBytes  *int64 `json:"localBytes"`
	ServerBytes *int64 `json:"serverBytes"`
	LocalError  string `json:"localError,omitempty"`
	ServerError string `json:"serverError,omitempty"`
}

// GetProjectStorage measures one explicitly selected, account-bound project.
// File IO never holds the connection lock or scans other registered projects.
func (FrontendBridge) GetProjectStorage(serverPath string) (result map[string]ProjectStorage) {
	result = map[string]ProjectStorage{}
	serverConnectionMu.RLock()
	if !workspaceConnectionMatchesSession() {
		serverConnectionMu.RUnlock()
		return result
	}
	connection, transport := apiConnection, tunnel
	cfg := store.config()
	m := store.findMappingByServer(serverPath)
	if m == nil || m.ServerID != serverIdentity(cfg) {
		serverConnectionMu.RUnlock()
		return result
	}
	var sshArgs []string
	if transport != nil && transport.controlAlive() {
		sshArgs = transport.baseArgs()
	}
	serverConnectionMu.RUnlock()
	// Results belong to the captured account, transport and exact workspace binding.
	defer func() {
		serverConnectionMu.RLock()
		defer serverConnectionMu.RUnlock()
		current := store.findMappingByServer(serverPath)
		if apiConnection != connection || !workspaceConnectionMatchesSession() || connection.ctx.Err() != nil ||
			tunnel != transport || serverIdentity(store.config()) != serverIdentity(cfg) || current == nil ||
			current.BindingEpoch != m.BindingEpoch || current.LocalPath != m.LocalPath || current.ServerID != m.ServerID {
			result = map[string]ProjectStorage{}
		}
	}()
	item := ProjectStorage{}
	localContext, cancelLocal := context.WithTimeout(connection.ctx, 30*time.Second)
	size, err := projectAllocatedBytes(localContext, m.LocalPath)
	cancelLocal()
	if err != nil {
		item.LocalError = err.Error()
	} else {
		item.LocalBytes = &size
	}
	result[serverPath] = item
	if len(sshArgs) == 0 {
		item.ServerError = "服务器未连接"
		result[serverPath] = item
		return result
	}
	// A slow local scan must not consume the remote measurement's deadline.
	ctx, cancel := context.WithTimeout(connection.ctx, 30*time.Second)
	defer cancel()
	paths := []string{serverPath}
	request, _ := json.Marshal(paths)
	// Linux allocation counts include generated files and dependencies. Links are
	// not followed, and hard links within one project are counted once.
	worker := `import json,os,stat,sys
result={}
def fail(error):raise error
for root in json.load(sys.stdin):
 try:
  if not os.path.isdir(root) or os.path.islink(root):raise OSError('项目目录不可用')
  total=0;seen=set()
  for directory,_,files in os.walk(root,followlinks=False,onerror=fail):
   for name in files:
    info=os.stat(os.path.join(directory,name),follow_symlinks=False)
    if not stat.S_ISREG(info.st_mode):continue
    identity=(info.st_dev,info.st_ino)
    if identity in seen:continue
    seen.add(identity);total+=info.st_blocks*512
  result[root]={'bytes':total}
 except OSError as error:result[root]={'error':str(error)}
json.dump(result,sys.stdout)`
	cmd := hideCommandWindow(exec.CommandContext(ctx, sshExe(), append(sshArgs, "python3 -c "+shellQuote(worker))...))
	cmd.Stdin = bytes.NewReader(request)
	var diagnostic bytes.Buffer
	cmd.Stderr = &diagnostic
	output, err := cmd.Output()
	remote := map[string]struct {
		Bytes *int64 `json:"bytes"`
		Error string `json:"error"`
	}{}
	if err == nil {
		err = json.Unmarshal(output, &remote)
	}
	for _, serverPath := range paths {
		item := result[serverPath]
		if err != nil {
			item.ServerError = fmt.Sprintf("服务器空间统计失败: %v", err)
		} else if value, ok := remote[serverPath]; ok && (value.Bytes != nil || value.Error != "") {
			item.ServerBytes, item.ServerError = value.Bytes, value.Error
		} else {
			item.ServerError = "服务器未返回空间统计"
		}
		result[serverPath] = item
	}
	return result
}
