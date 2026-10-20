package main

import (
	"bytes"
	"encoding/json"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"testing"
	"time"

	"golang.org/x/sys/windows"
)

// Only copied test executables enter these roles. They never open SSH or read
// the user's profile; the actual wrapper main runs against a private child tool.
func init() {
	switch os.Getenv("CHISA_SYNC_SSH_TEST_ROLE") {
	case "wrapper":
		if filepath.Base(filepath.Dir(os.Args[0])) != "OpenSSH" {
			main()
			os.Exit(0)
		}
		if os.Getenv("CHISA_SYNC_SSH_TEST_EXIT") == "1" {
			encoded, _ := json.Marshal(os.Args[1:])
			_ = os.WriteFile(os.Getenv("CHISA_SYNC_SSH_TEST_STATE"), encoded, 0600)
			os.Exit(37)
		}
	case "control":
	default:
		return
	}
	_ = os.WriteFile(os.Getenv("CHISA_SYNC_SSH_TEST_STATE"), []byte(strconv.Itoa(os.Getpid())), 0600)
	time.Sleep(time.Minute)
	os.Exit(0)
}

func copyTransportTestExecutable(t *testing.T, target string) {
	t.Helper()
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Dir(target), 0700); err != nil {
		t.Fatal(err)
	}
	input, err := os.Open(executable)
	if err != nil {
		t.Fatal(err)
	}
	defer input.Close()
	output, err := os.Create(target)
	if err != nil {
		t.Fatal(err)
	}
	_, copyErr := io.Copy(output, input)
	closeErr := output.Close()
	if copyErr != nil || closeErr != nil {
		t.Fatal(copyErr, closeErr)
	}
}

func privateTransportWrapper(t *testing.T) (string, string) {
	t.Helper()
	root := t.TempDir()
	config := filepath.Join(root, "roaming", "ChisaCloudCode", "sync-ssh.conf")
	if err := os.MkdirAll(filepath.Dir(config), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(config, []byte("Host private-test\n"), 0600); err != nil {
		t.Fatal(err)
	}
	wrapper := filepath.Join(root, "transport", "ssh.exe")
	copyTransportTestExecutable(t, wrapper)
	copyTransportTestExecutable(t, filepath.Join(root, "windows", "System32", "OpenSSH", "ssh.exe"))
	t.Setenv("CHISA_DATA_DIR", "")
	t.Setenv("APPDATA", filepath.Join(root, "roaming"))
	t.Setenv("WINDIR", filepath.Join(root, "windows"))
	t.Setenv("CHISA_SYNC_SSH_TEST_ROLE", "wrapper")
	state := filepath.Join(root, "child-state")
	t.Setenv("CHISA_SYNC_SSH_TEST_STATE", state)
	return wrapper, state
}

func waitTransportChild(t *testing.T, state string) windows.Handle {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if raw, err := os.ReadFile(state); err == nil {
			if pid, err := strconv.Atoi(string(raw)); err == nil {
				handle, err := windows.OpenProcess(windows.SYNCHRONIZE|windows.PROCESS_TERMINATE, false, uint32(pid))
				if err != nil {
					t.Fatal(err)
				}
				t.Cleanup(func() { _ = windows.TerminateProcess(handle, 99); windows.CloseHandle(handle) })
				return handle
			}
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("private child did not start")
	return 0
}

func TestTransportWrapperExitTerminatesOnlyOwnedChild(t *testing.T) {
	wrapper, state := privateTransportWrapper(t)
	var output bytes.Buffer
	command := exec.Command(wrapper, "private-test")
	command.Stdout, command.Stderr = &output, &output
	command.WaitDelay = time.Second
	if err := command.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = command.Process.Kill() })
	child := waitTransportChild(t, state)
	controlState := filepath.Join(t.TempDir(), "control-state")
	control := exec.Command(wrapper)
	control.Env = append(os.Environ(), "CHISA_SYNC_SSH_TEST_ROLE=control", "CHISA_SYNC_SSH_TEST_STATE="+controlState)
	if err := control.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = control.Process.Kill(); _ = control.Wait() })
	controlHandle := waitTransportChild(t, controlState)
	if err := command.Process.Kill(); err != nil {
		t.Fatal(err)
	}
	_ = command.Wait()
	if result, err := windows.WaitForSingleObject(child, 3000); err != nil || result != windows.WAIT_OBJECT_0 {
		t.Fatalf("OpenSSH child survived forced wrapper exit: result=%d err=%v output=%s", result, err, &output)
	}
	if result, err := windows.WaitForSingleObject(controlHandle, 0); err != nil || result != uint32(windows.WAIT_TIMEOUT) {
		t.Fatalf("wrapper cleanup affected the unrelated control process: result=%d err=%v", result, err)
	}
}

func TestSyncSSHConfigPath(t *testing.T) {
	for _, test := range []struct {
		name     string
		override string
		appData  string
		want     string
		wantErr  bool
	}{
		{name: "default", appData: `C:\private\roaming`, want: `C:\private\roaming\ChisaCloudCode\sync-ssh.conf`},
		{name: "absolute override", override: `C:\native QA\profile`, appData: `C:\other`, want: `C:\native QA\profile\sync-ssh.conf`},
		{name: "clean relative override", override: `qa\unused\..\profile\`, appData: `C:\other`, want: `qa\profile\sync-ssh.conf`},
		{name: "override without user config", override: `C:\qa\profile`, want: `C:\qa\profile\sync-ssh.conf`},
		{name: "missing user config", wantErr: true},
	} {
		t.Run(test.name, func(t *testing.T) {
			t.Setenv("CHISA_DATA_DIR", test.override)
			t.Setenv("APPDATA", test.appData)
			got, err := syncSSHConfigPath()
			if (err != nil) != test.wantErr || got != test.want {
				t.Fatalf("syncSSHConfigPath() = %q, %v; want %q, error=%v", got, err, test.want, test.wantErr)
			}
		})
	}
}

func TestTransportWrapperPreservesArgumentsAndExitStatus(t *testing.T) {
	for _, override := range []bool{false, true} {
		name := "default profile"
		if override {
			name = "explicit profile"
		}
		t.Run(name, func(t *testing.T) {
			wrapper, state := privateTransportWrapper(t)
			config := filepath.Join(os.Getenv("APPDATA"), "ChisaCloudCode", "sync-ssh.conf")
			if override {
				profile := filepath.Join(t.TempDir(), "native QA profile")
				if err := os.MkdirAll(profile, 0700); err != nil {
					t.Fatal(err)
				}
				config = filepath.Join(profile, "sync-ssh.conf")
				if err := os.WriteFile(config, []byte("Host explicit-profile\n"), 0600); err != nil {
					t.Fatal(err)
				}
				t.Setenv("CHISA_DATA_DIR", profile)
			}
			t.Setenv("CHISA_SYNC_SSH_TEST_EXIT", "1")
			output, err := exec.Command(wrapper, "-V", "private argument").CombinedOutput()
			exitError, ok := err.(*exec.ExitError)
			if !ok || exitError.ExitCode() != 37 {
				t.Fatalf("child exit status was not preserved: %v %s", err, output)
			}
			raw, err := os.ReadFile(state)
			var args []string
			if err != nil || json.Unmarshal(raw, &args) != nil || len(args) != 4 || args[0] != "-F" || args[1] != config || args[2] != "-V" || args[3] != "private argument" {
				t.Fatalf("transport arguments changed (want config %q): %q %v", config, raw, err)
			}
		})
	}
}
