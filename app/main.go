package main

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"log"
	"net/url"
	"os"
	"path/filepath"
	"runtime/debug"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/egoist/mygo"
)

var tunnel *Tunnel

var win *mygo.Window

func randHex(n int) string {
	b := make([]byte, n)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

func b64encode(s string) string {
	return base64.StdEncoding.EncodeToString([]byte(s))
}

func dataDir() string {
	base, err := os.UserConfigDir()
	if err != nil {
		wd, _ := os.Getwd()
		return filepath.Join(wd, ".data")
	}
	return filepath.Join(base, "ChisaCloudCode")
}

func migrateBridgeKey(toDir string) string {
	legacy := filepath.Join(os.Getenv("USERPROFILE"), ".local-bridge", "id_ed25519")
	target := filepath.Join(toDir, "id_ed25519")
	if _, err := os.Stat(target); err == nil {
		return target
	}
	if _, err := os.Stat(legacy); err == nil {
		_ = os.MkdirAll(toDir, 0o755)
		for _, sfx := range []string{"", ".pub"} {
			b, err := os.ReadFile(legacy + sfx)
			if err == nil {
				_ = os.WriteFile(target+sfx, b, 0o600)
			}
		}
		log.Println("[bridge] 已迁移 SSH 密钥")
	}
	return target
}

// workspaceRoot 探测所连实例允许的工作区根（WORKSPACES_ROOT），结果按端口缓存。
// 探测逻辑：用户实例 env（含 SERVER_PORT）优先，其次主实例 env。
func detectWorkspaceRoot(ctx context.Context, transport *Tunnel, cfg Config, port string) string {
	if root := cfg.WorkspaceRoot; root != "" {
		return root
	}
	script := fmt.Sprintf(`
p=%s
for f in /etc/cloudcli-users/*.env; do
  if grep -q "^SERVER_PORT=$p$" "$f" 2>/dev/null; then
    grep "^WORKSPACES_ROOT=" "$f" | head -1 | cut -d= -f2-
    exit 0
  fi
done
if grep -q -- "--port $p" /etc/systemd/system/cloudcli.service 2>/dev/null; then
  grep "^WORKSPACES_ROOT=" /etc/cloudcli.env 2>/dev/null | head -1 | cut -d= -f2-
  exit 0
fi
grep "^WORKSPACES_ROOT=" /etc/cloudcli.env 2>/dev/null | head -1 | cut -d= -f2-
`, port)
	out, err := transport.ExecRemoteContext(ctx, strings.TrimSpace(script))
	if err != nil {
		return ""
	}
	root := strings.TrimSpace(strings.ReplaceAll(out, "\r", ""))
	lines := strings.Split(root, "\n")
	if len(lines) > 0 {
		root = strings.TrimSpace(lines[len(lines)-1])
	}
	if root == "" || !strings.HasPrefix(root, "/") {
		return ""
	}
	return root
}

// Opening a folder completes the initial VPS sync before exposing the project.
func prepareLocalProject(localPath string) map[string]any {
	serverConnectionMu.RLock()
	connection := apiConnection
	serverConnectionMu.RUnlock()
	return prepareLocalProjectForConnection(connection, localPath)
}

func prepareLocalProjectForConnection(connection *serverConnection, localPath string) map[string]any {
	serverConnectionMu.RLock()
	existing := store.findMappingByLocal(localPath)
	foreign := apiConnection == connection && connection != nil && connection.authenticated && existing != nil && !workspaceMappingActiveLocked(existing)
	serverConnectionMu.RUnlock()
	if foreign {
		return map[string]any{"ok": false, "error": errWorkspaceMappingsConflict.Error(), "action": "manage-mappings", "localPath": localPath}
	}
	if err := waitAccountWorkspace(connection, false); err != nil {
		result := map[string]any{"ok": false, "error": err.Error()}
		serverConnectionMu.RLock()
		if err == errWorkspaceMappingsConflict && len(inactiveWorkspaceMappingsLocked()) > 0 {
			result["action"] = "manage-mappings"
		}
		serverConnectionMu.RUnlock()
		return result
	}
	ctx, cancel, err := bindWorkspaceSyncConnection(connection.ctx)
	if err != nil {
		return map[string]any{"ok": false, "error": err.Error()}
	}
	defer cancel()
	ctx, timeout := context.WithTimeout(ctx, workspaceSyncTimeout)
	defer timeout()
	snapshot := ctx.Value(workspaceSyncConnectionKey{}).(*workspaceSyncConnection)
	fi, err := os.Stat(localPath)
	if err != nil || !fi.IsDir() {
		return map[string]any{"ok": false, "error": "路径不存在或不是文件夹"}
	}
	if m := store.findMappingByLocal(localPath); m != nil {
		if m.ServerID != serverIdentity(snapshot.cfg) {
			return map[string]any{"ok": false, "error": errWorkspaceMappingsConflict.Error(), "action": "manage-mappings", "localPath": localPath}
		}
		if result := syncProjectWithEmptyConfirmationContext(ctx, m.ServerPath, ""); result["ok"] != true {
			return result
		}
		if err := workspaceSyncCurrent(ctx); err != nil {
			return map[string]any{"ok": false, "error": err.Error()}
		}
		return map[string]any{"ok": true, "localPath": m.LocalPath, "serverPath": m.ServerPath, "reused": true}
	}
	base := filepath.Base(localPath)
	name := sanitizeName(base)
	wsID := randHex(3)
	cfg := snapshot.cfg
	port := "8791"
	if u, err := url.Parse(cfg.ServerURL); err == nil && u.Port() != "" {
		port = u.Port()
	}
	if number, err := strconv.Atoi(port); err != nil || number < 1 || number > 65535 {
		return map[string]any{"ok": false, "error": "服务器端口无效"}
	}
	root := detectWorkspaceRoot(ctx, snapshot.tunnel, cfg, port)
	if root == "" {
		root = "/srv/workspaces/" + cfg.SSHUser
	}
	serverPath := fmt.Sprintf("%s/local/%s-%s", root, name, wsID)

	script := fmt.Sprintf(`
set -e
BASE=%s
mkdir -p "$BASE"
D="$BASE/%s-%s"
mkdir -p "$D"
echo "$D"
`, shellQuote(root+"/local"), name, wsID)
	serverPath, err = snapshot.tunnel.ExecRemoteContext(ctx, script)
	if err != nil {
		return map[string]any{"ok": false, "error": "服务器创建项目目录失败: " + err.Error()}
	}

	m := &Mapping{LocalPath: localPath, ServerPath: serverPath, BindingEpoch: randHex(16), ServerID: serverIdentity(cfg)}
	serverConnectionMu.RLock()
	if ctx.Err() != nil || !snapshot.currentLocked() {
		serverConnectionMu.RUnlock()
		return map[string]any{"ok": false, "error": "文件同步账号或连接已改变，请重新打开工作目录"}
	}
	err = store.addMapping(m)
	serverConnectionMu.RUnlock()
	if err != nil {
		return map[string]any{"ok": false, "error": "本地映射保存失败"}
	}
	if result := syncProjectWithEmptyConfirmationContext(ctx, m.ServerPath, ""); result["ok"] != true {
		return result
	}
	if err := workspaceSyncCurrent(ctx); err != nil {
		return map[string]any{"ok": false, "error": err.Error()}
	}
	return map[string]any{"ok": true, "localPath": localPath, "serverPath": serverPath}
}

// Revocation stops synchronization and removes the capability, preserving files.
func revokeMapping(serverPath string) map[string]any {
	serverConnectionMu.RLock()
	connection := apiConnection
	m := store.findMappingByServer(serverPath)
	owned := workspaceMappingActiveLocked(m)
	serverConnectionMu.RUnlock()
	if m == nil {
		return map[string]any{"ok": false, "error": "映射不存在"}
	}
	if !owned {
		return map[string]any{"ok": false, "error": "此项目属于其他账号，请使用该项目的「切换到当前账号」操作"}
	}
	lock, _ := workspaceLocks.LoadOrStore(serverPath, &sync.Mutex{})
	mu := lock.(*sync.Mutex)
	mu.Lock()
	defer mu.Unlock()
	if _, owned := cloudReservations.Load(serverPath); owned {
		return map[string]any{"ok": false, "error": "Claude 正在使用工作区，请先结束任务"}
	}
	if err := stopProjectPi(serverPath); err != nil {
		return map[string]any{"ok": false, "error": "停止本地 Pi 和运行程序失败，未撤销绑定"}
	}
	if err := stopProjectPreviews(serverPath); err != nil {
		return map[string]any{"ok": false, "error": "停止项目预览失败，未撤销绑定"}
	}
	serverConnectionMu.RLock()
	defer serverConnectionMu.RUnlock()
	current := store.findMappingByServer(serverPath)
	if apiConnection != connection || current == nil || current.BindingEpoch != m.BindingEpoch || !workspaceMappingActiveLocked(current) {
		return map[string]any{"ok": false, "error": "账号连接已切换，未撤销绑定"}
	}
	if err := inactiveMappingBusy(m); err != nil {
		return map[string]any{"ok": false, "error": "工作区尚未交还，请先恢复同步再移除：" + err.Error()}
	}
	if err := terminateSync(m.SyncName); err != nil {
		return map[string]any{"ok": false, "error": "停止项目同步失败，未移除绑定：" + err.Error()}
	}
	// Revocation removes capability metadata, never project files or user history.
	if _, err := tunnel.ExecRemote("rm -f -- " + shellQuote(serverPath+"/.chisa-bridge.json")); err != nil {
		return map[string]any{"ok": false, "error": "撤销服务器绑定失败"}
	}
	if err := store.removeMapping(serverPath); err != nil {
		return map[string]any{"ok": false, "error": "本地撤销记录保存失败"}
	}
	publishProjectSync(m)
	return map[string]any{"ok": true}
}

func sanitizeName(base string) string {
	var b strings.Builder
	for _, r := range base {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9', r == '-', r == '_', r > 127:
			b.WriteRune(r)
		default:
			b.WriteRune('-')
		}
	}
	name := b.String()
	if len(name) > 50 {
		end := 50
		for !utf8.RuneStart(name[end]) {
			end--
		}
		name = name[:end]
	}
	if name == "" || name == "-" {
		name = "local-project"
	}
	return name
}

func configureAppLogging(dir string) error {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	f, err := os.OpenFile(filepath.Join(dir, "app.log"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		return err
	}
	log.SetOutput(f)
	fmt.Fprintf(f, "--- launch %s ---\n", time.Now().Format(time.RFC3339))
	executable, _ := os.Executable()
	log.Printf("[app-start] pid=%d executable=%q", os.Getpid(), executable)
	// GUI launches have no reliable stderr; keep runtime crashes in the same log.
	return debug.SetCrashOutput(f, debug.CrashOptions{})
}

func main() {
	mygo.Bind(FrontendBridge{})
	if os.Getenv("MYGO_GENERATE") != "" {
		if err := mygo.App.Run(); err != nil {
			os.Exit(1)
		}
		return
	}
	if err := configureAppLogging(dataDir()); err != nil {
		log.Printf("[app-diagnostics-error] %v", err)
	}

	dataD := dataDir()
	keyPath := migrateBridgeKey(filepath.Join(dataD, "bridge-key"))
	store = loadStore(dataDir())
	cfg := store.config()
	if cfg.KeyPath == "" {
		cfg.KeyPath = keyPath
	}
	if err := store.updateConfig(cfg); err != nil {
		log.Fatal(err)
	}

	tunnel = newTunnel(cfg, cfg.KeyPath, func() {})
	if err := initializeServerConnection(); err != nil {
		log.Println("[account-service] configuration:", err)
	}
	if err := StartAPIProxy(); err != nil {
		log.Fatal("账号连接端口被占用: ", err)
	}

	if err := StartControlPlane(fmt.Sprintf("127.0.0.1:%d", controlPort)); err != nil {
		log.Fatal("控制面端口被占用: ", err)
	}

	// Account login/restoration authorizes the separate workspace connection.

	mygo.App.OnBeforeQuit(func(*mygo.QuitEvent) { log.Println("[app-before-quit]") })
	mygo.App.OnWillQuit(func(*mygo.QuitEvent) { log.Println("[app-will-quit]") })
	mygo.App.OnQuit(func() { log.Println("[app-quit]") })
	mygo.App.WhenReady(func() {
		w := mygo.NewWindow(mygo.WindowOptions{
			Title:          "ChisaCloudCode",
			URL:            "/",
			Width:          1280,
			Height:         840,
			TitleBarStyle:  mygo.TitleBarHidden,
			TitleBarHeight: 56,
		})
		win = w
		w.OnClose(func(*mygo.CloseEvent) { log.Println("[window-close-requested]") })
		w.OnClosed(func() { log.Println("[window-closed]") })
		w.OnRenderProcessGone(func(reason string) {
			log.Printf("[webview-renderer-error] reason=%q", errorLogField(reason, 64))
		})
		w.OnDidFailLoad(func(err *mygo.LoadError) {
			log.Printf("[webview-load-error] path=%q code=%d description=%q", errorLogPath(err.URL), err.Code, errorLogField(err.Description, 2048))
		})
	})

	err := mygo.App.Run()
	log.Printf("[app-loop-return] error=%v", err)
	if err != nil {
		stopSyncMonitor(true)
		log.Fatal(err)
	}
	stopSyncMonitor(true)
	if err := stopAllPi(); err != nil {
		log.Println("[pi] cleanup:", err)
	}
	tunnel.stop()
	_ = stopProjectPreviews("")
	log.Println("[app-cleanup-complete]")
}
