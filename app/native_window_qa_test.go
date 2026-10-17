//go:build windows && nativewindowqa

package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/egoist/mygo"
)

// This opt-in test uses the final frontend and real native bridge. Its only
// window difference from shipping main is Hidden + ShowInactive, to preserve
// the user's foreground window. The last signal keeps it alive for the real
// directory picker acceptance controlled by the parent agent after permission.
func TestMain(m *testing.M) {
	if os.Getenv("CHISA_NATIVE_WINDOW_QA") == "" {
		os.Exit(m.Run())
	}
	root := os.Getenv("CHISA_NATIVE_WINDOW_QA_ROOT")
	qa := filepath.Join(root, "qa")
	profile := filepath.Join(qa, "native-window-profile-"+randHex(4))
	for name, relative := range map[string]string{"APPDATA": "roaming", "LOCALAPPDATA": "local", "USERPROFILE": "profile", "MUTAGEN_DATA_DIRECTORY": "mutagen"} {
		path := filepath.Join(profile, relative)
		_ = os.MkdirAll(path, 0700)
		_ = os.Setenv(name, path)
	}
	_ = os.Setenv("WEBVIEW2_USER_DATA_FOLDER", filepath.Join(profile, "WebView2"))
	_ = os.Setenv("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", "--remote-debugging-port=18851")
	mygo.App.SetName("ChisaCloudCode Account Sync QA")
	mygo.App.SetPath(mygo.PathUserData, filepath.Join(profile, "mygo"))
	mygo.SetFrontend(os.DirFS(filepath.Join(root, "cloudcli-ui", "dist")))
	mygo.Bind(FrontendBridge{})
	store = loadStore(dataDir())
	cfg := store.config()
	cfg.LoginURL, cfg.APIURL = os.Getenv("CHISA_ACCOUNT_SYNC_QA_URL"), os.Getenv("CHISA_ACCOUNT_SYNC_QA_URL")
	cfg.KeyPath = migrateBridgeKey(filepath.Join(dataDir(), "bridge-key"))
	if err := store.updateConfig(cfg); err != nil {
		panic(err)
	}
	tunnel = newTunnel(cfg, cfg.KeyPath, func() {})
	if err := initializeServerConnection(); err != nil {
		panic(err)
	}
	if err := StartAPIProxy(); err != nil {
		panic(err)
	}
	if err := StartControlPlane(fmt.Sprintf("127.0.0.1:%d", controlPort)); err != nil {
		panic(err)
	}
	code := 1
	mygo.App.WhenReady(func() {
		win = mygo.NewWindow(mygo.WindowOptions{
			Title: "ChisaCloudCode Account Sync QA 0.1.5", URL: "/", Width: 1280, Height: 840,
			TitleBarStyle: mygo.TitleBarHidden, TitleBarHeight: 56, Hidden: true,
		})
		win.OnPageTitleUpdated(func(e *mygo.TitleEvent) { e.PreventDefault() })
		win.OnReadyToShow(func() { win.ShowInactive() })
		go func() { code = m.Run(); mygo.App.Quit() }()
	})
	if err := mygo.App.Run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		code = 1
	}
	stopSyncMonitor(false)
	if tunnel != nil {
		tunnel.stop()
	}
	if apiConnection != nil {
		apiConnection.cancel()
		apiConnection.client.CloseIdleConnections()
	}
	os.Exit(code)
}

func TestNativeWindowAccountSync(t *testing.T) {
	qa := filepath.Join(os.Getenv("CHISA_NATIVE_WINDOW_QA_ROOT"), "qa")
	var credentials struct {
		Username string `json:"username"`
		Password string `json:"password"`
	}
	bytes, err := os.ReadFile(os.Getenv("CHISA_ACCOUNT_SYNC_QA_CREDS"))
	if err != nil || json.Unmarshal(bytes, &credentials) != nil {
		t.Fatal("isolated account credentials unavailable")
	}
	eval := func(code string) any {
		t.Helper()
		ctx, cancel := context.WithTimeout(context.Background(), 25*time.Second)
		defer cancel()
		value, err := win.EvalContext(ctx, code)
		if err != nil {
			t.Fatal(err)
		}
		return value
	}
	wait := func(expression string) {
		t.Helper()
		deadline := time.Now().Add(60 * time.Second)
		for time.Now().Before(deadline) {
			if eval(expression) == true {
				return
			}
			time.Sleep(150 * time.Millisecond)
		}
		text := eval("document.body.innerText.slice(0,1800)")
		t.Fatalf("native UI condition timed out: %s; visible=%v", expression, text)
	}
	shot := func(name string) {
		t.Helper()
		time.Sleep(250 * time.Millisecond)
		png, err := win.CapturePage()
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(qa, name+".png"), png, 0600); err != nil {
			t.Fatal(err)
		}
		t.Log("CAPTURE", name)
	}
	wait("Boolean(document.querySelector('button') && document.body.innerText.includes('登录'))")
	eval("[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='登录').click(); return true")
	wait("Boolean(document.querySelector('#username') && document.querySelector('#password'))")
	username, _ := json.Marshal(credentials.Username)
	password, _ := json.Marshal(credentials.Password)
	eval(fmt.Sprintf("const set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set; for(const [id,value] of [['username',%s],['password',%s]]) { const el=document.getElementById(id);set.call(el,value);el.dispatchEvent(new Event('input',{bubbles:true})); } return true", username, password))
	eval("document.querySelector('#password').closest('form').requestSubmit(); return true")
	wait("Boolean([...document.querySelectorAll('button')].find(b=>(b.getAttribute('aria-label')||'').startsWith('账户菜单：qa-one')))")
	t.Log("PASS real login form accepted the fresh account")
	// Use the account menu and actual settings tab, not a standalone component.
	eval("[...document.querySelectorAll('button')].find(b=>(b.getAttribute('aria-label')||'').startsWith('账户菜单：qa-one')).click(); return true")
	wait("Boolean([...document.querySelectorAll('[role=menuitem]')].find(b=>b.textContent.trim()==='设置'))")
	eval("[...document.querySelectorAll('[role=menuitem]')].find(b=>b.textContent.trim()==='设置').click(); return true")
	wait("Boolean([...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='服务器与同步'))")
	showPanel := func() {
		t.Helper()
		eval("[...document.querySelectorAll('button')].find(b=>b.offsetParent && b.textContent.trim()==='服务器与同步').click(); return true")
		wait("document.body.innerText.includes('文件同步已连接，可以打开本机目录')")
		eval("[...document.querySelectorAll('h3')].find(e=>e.textContent==='账号服务与文件同步').parentElement.parentElement.scrollIntoView({block:'start'}); return true")
	}
	showPanel()
	if eval("Boolean([...document.querySelectorAll('summary')].find(e=>e.textContent.includes('管理员提供的连接'))?.parentElement.open)") != false {
		t.Fatal("administrator fields were not initially collapsed")
	}
	shot("account-sync-normal")
	win.SetSize(800, 760)
	wait("window.innerWidth < 850 && window.innerWidth > 700")
	showPanel()
	shot("account-sync-narrow-800")
	win.SetSize(640, 760)
	wait("window.innerWidth < 700")
	showPanel()
	shot("account-sync-narrow-640")
	win.SetSize(1280, 840)
	wait("window.innerWidth > 1000")
	showPanel()
	// A real invalid administrator instance must produce an adjacent error;
	// returning to automatic account sync clears it without opening a key picker.
	eval("[...document.querySelectorAll('summary')].find(e=>e.textContent.includes('管理员提供的连接')).click(); return true")
	eval("const el=[...document.querySelectorAll('label')].find(l=>l.textContent.includes('同步服务地址')).querySelector('input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,'http://127.0.0.1:1');el.dispatchEvent(new Event('input',{bubbles:true})); return true")
	eval("[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='使用管理员连接').click(); return true")
	wait("document.body.innerText.includes('同步实例必须与当前账号所属服务一致')")
	eval("[...document.querySelectorAll('summary')].find(e=>e.textContent.includes('管理员提供的连接')).click(); return true")
	shot("account-sync-validation-error")
	eval("[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='重新连接').click(); return true")
	wait("document.body.innerText.includes('文件同步已连接，可以打开本机目录') && !document.body.innerText.includes('同步实例必须与当前账号所属服务一致') && ![...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='连接中…')")
	t.Log("PASS actual administrator validation error and automatic account reconnect recovery")
	eval("document.querySelector('button[aria-label=\"关闭设置\"]').click(); return true")
	wait("!document.body.innerText.includes('无需另行配置')")
	shot("account-sync-ready-for-folder")
	if os.Getenv("CHISA_NATIVE_WINDOW_QA_HOLD") == "" {
		t.Log("PASS real native login, automatic sync panel, administrator validation, reconnect, and settings dismissal; system picker remains pending")
		return
	}
	local := filepath.Join(qa, "native-window-folder-带空格的本地项目")
	if err := os.MkdirAll(local, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(local, "proof.txt"), []byte("native window selected folder proof\n"), 0600); err != nil {
		t.Fatal(err)
	}
	ready, _ := json.Marshal(map[string]any{"pid": os.Getpid(), "title": "ChisaCloudCode Account Sync QA 0.1.5", "version": "0.1.5", "folder": local, "cdpPort": 18851, "userPickerInteraction": "pending explicit user permission"})
	if err := os.WriteFile(filepath.Join(qa, "native-window-ready.json"), ready, 0600); err != nil {
		t.Fatal(err)
	}
	t.Log("READY inactive real native window; parent may use the system picker only after explicit user permission")
	deadline := time.Now().Add(18 * time.Minute)
	for time.Now().Before(deadline) {
		if _, err := os.Stat(filepath.Join(qa, "native-window-finish.signal")); err == nil {
			shot("account-sync-after-folder")
			state := FrontendBridge{}.GetState()
			bytes, _ := json.Marshal(state)
			// The state does not contain the account bearer token or password.
			_ = os.WriteFile(filepath.Join(qa, "native-window-final-state.json"), bytes, 0600)
			text, _ := win.Eval("document.body.innerText")
			if strings.Contains(fmt.Sprint(text), "正在打开工作目录") {
				t.Error("opening-folder busy overlay remained after parent acceptance")
			}
			t.Log("PASS parent acceptance signal received; native window will close")
			return
		}
		time.Sleep(500 * time.Millisecond)
	}
	t.Fatal("parent acceptance signal did not arrive before QA timeout")
}
