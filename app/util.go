package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
)

func jsonResp(w http.ResponseWriter, code int, obj any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(code)
	b, _ := json.Marshal(obj)
	_, _ = w.Write(b)
}

func distDirCandidates() []string {
	var out []string
	if exe, err := os.Executable(); err == nil {
		base := filepath.Dir(exe)
		out = append(out,
			filepath.Join(base, "cloudcli-dist"),
			filepath.Join(base, "resources", "cloudcli-dist"),
		)
	}
	wd, _ := os.Getwd()
	out = append(out,
		filepath.Join(wd, "..", "cloudcli-ui", "dist"),
		filepath.Join(wd, "resources", "cloudcli-dist"),
		filepath.Join(wd, "cloudcli-dist"),
	)
	return out
}

func mutagenExe() string {
	for _, p := range []string{
		filepath.Join(exeDir(), "mutagen.exe"),
		filepath.Join(exeDir(), "resources", "mutagen.exe"),
		filepath.Join("..", "mutagen.exe"),
		filepath.Join("resources", "mutagen.exe"),
	} {
		if _, err := os.Stat(p); err == nil {
			return p
		}
	}
	return ""
}

// Installed resources and source runs use the same app-scoped SSH transport.
func mutagenSSHPath() (string, error) {
	for _, directory := range []string{
		filepath.Join(exeDir(), "sync-ssh"),
		filepath.Join(exeDir(), "resources", "sync-ssh"),
		filepath.Join("resources", "windows-amd64", "sync-ssh"),
	} {
		if _, err := os.Stat(filepath.Join(directory, "ssh.exe")); err != nil {
			continue
		}
		if _, err := os.Stat(filepath.Join(directory, "scp.exe")); err != nil {
			continue
		}
		return filepath.Abs(directory)
	}
	return "", fmt.Errorf("文件同步 SSH 组件未随应用分发")
}

func exeDir() string {
	if exe, err := os.Executable(); err == nil {
		return filepath.Dir(exe)
	}
	wd, _ := os.Getwd()
	return wd
}
