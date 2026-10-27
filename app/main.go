package main

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"runtime/debug"
	"time"

	"github.com/egoist/mygo"
)

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
	if dir := os.Getenv("CHISA_DATA_DIR"); dir != "" {
		return filepath.Clean(dir)
	}
	base, err := os.UserConfigDir()
	if err != nil {
		wd, _ := os.Getwd()
		return filepath.Join(wd, ".data")
	}
	name := "ChisaCloudCode"
	if os.Getenv("MYGO_ENV") == "development" {
		name += " Dev"
		if session := os.Getenv("CHISA_DEV_SESSION"); session != "" {
			return filepath.Join(base, name, "sessions", filepath.Base(session))
		}
	}
	return filepath.Join(base, name)
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
	log.Printf("[app-start] pid=%d executable=%q mode=cloud-default", os.Getpid(), executable)
	return debug.SetCrashOutput(f, debug.CrashOptions{})
}

func logShutdownStage(stage string, action func() error) error {
	started := time.Now()
	log.Printf("[app-shutdown] stage=%s event=begin", stage)
	err := action()
	log.Printf("[app-shutdown] stage=%s event=end elapsed=%s error_type=%T", stage, time.Since(started), err)
	return err
}

// Window callbacks only close admission/cancel frontend calls; they never wait
// on account locks or helper IO. The final main goroutine owns bounded draining.
func beginDesktopShutdown() {
	closeFrontendServerRequests()
	cancelFrontendProxyRequests()
	desktopSshMu.Lock()
	desktopSshClosed = true
	manager := desktopSshManager
	desktopSshMu.Unlock()
	if manager != nil {
		manager.closeAdmission()
	}
}

func drainDesktopSshShutdown(ctx context.Context, cleanupHandoff time.Duration) error {
	desktopSshMu.Lock()
	desktopSshClosed = true
	manager := desktopSshManager
	desktopSshMu.Unlock()
	if manager == nil {
		return nil
	}
	entries := manager.closeAdmission()
	if len(entries) == 0 {
		return nil
	}
	// Backend exec interruption uses an independent job_cancel channel with a
	// ten-second budget. Keep the authenticated Agent transport alive for that
	// handoff; this is bounded opportunity, not a remote database acknowledgement.
	timer := time.NewTimer(cleanupHandoff)
	defer timer.Stop()
	select {
	case <-timer.C:
	case <-ctx.Done():
		manager.stopAll(true)
		return ctx.Err()
	}
	return manager.stopAndWait(ctx, entries)
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
	if os.Getenv("MYGO_ENV") == "development" || os.Getenv("CHISA_DATA_DIR") != "" {
		mygo.App.SetPath(mygo.PathUserData, dataD)
		if os.Getenv("WEBVIEW2_USER_DATA_FOLDER") == "" {
			if err := os.Setenv("WEBVIEW2_USER_DATA_FOLDER", filepath.Join(dataD, "WebView2")); err != nil {
				log.Fatal(err)
			}
		}
	}
	store = loadStore(dataD)
	if err := initializeServerConnection(); err != nil {
		log.Println("[account-service] configuration:", err)
	}
	if err := StartAPIProxy(); err != nil {
		log.Fatal("账号连接端口被占用: ", err)
	}

	// This bounded, one-shot migration cannot enroll, start a daemon or touch
	// projects. Its result never gates account authentication or API forwarding.
	retirementContext, stopRetirement := context.WithCancel(context.Background())
	retirementDone := make(chan struct{})
	go func() {
		defer close(retirementDone)
		retireLegacySync(retirementContext, store, newLegacySyncRunner(dataD))
	}()

	mygo.App.OnBeforeQuit(func(*mygo.QuitEvent) { log.Println("[app-before-quit]") })
	mygo.App.OnWillQuit(func(*mygo.QuitEvent) { log.Println("[app-will-quit]") })
	mygo.App.OnQuit(func() { log.Println("[app-quit]") })
	mygo.App.WhenReady(func() {
		w := mygo.NewWindow(mygo.WindowOptions{
			Title: "ChisaCloudCode", URL: "/", Width: 1280, Height: 840,
			TitleBarStyle: mygo.TitleBarHidden, TitleBarHeight: 56,
		})
		win = w
		w.OnClose(func(*mygo.CloseEvent) { log.Println("[window-close-requested]") })
		w.OnClosed(func() {
			beginDesktopShutdown()
			log.Println("[window-closed]")
		})
		w.OnRenderProcessGone(func(reason string) {
			log.Printf("[webview-renderer-error] reason=%q", errorLogField(reason, 64))
		})
		w.OnDidFailLoad(func(err *mygo.LoadError) {
			log.Printf("[webview-load-error] path=%q code=%d description=%q", errorLogPath(err.URL), err.Code, errorLogField(err.Description, 2048))
		})
	})
	err := mygo.App.Run()
	log.Printf("[app-loop-return] error=%v", err)
	beginDesktopShutdown()
	shutdownContext, stopShutdown := context.WithTimeout(context.Background(), 20*time.Second)
	proxyError := logShutdownStage("frontend-proxy", func() error { return waitFrontendProxyRequests(shutdownContext) })
	shutdownError := logShutdownStage("local-agent", func() error { return drainDesktopSshShutdown(shutdownContext, 12*time.Second) })
	if shutdownError == nil {
		shutdownError = proxyError
	}
	stopShutdown()
	if shutdownError != nil {
		log.Println("[app-shutdown] stage=local-agent outcome=cleanup-unconfirmed")
	}
	stopRetirement()
	<-retirementDone
	_ = logShutdownStage("account", func() error {
		closeFrontendServerRequests()
		serverConnectionMu.Lock()
		defer serverConnectionMu.Unlock()
		if apiConnection != nil {
			apiConnection.cancel()
			apiConnection.client.CloseIdleConnections()
		}
		return nil
	})
	if shutdownError == nil {
		log.Println("[app-cleanup-complete]")
	} else {
		log.Println("[app-cleanup-incomplete]")
	}
	if err != nil {
		log.Fatal(err)
	}
}
