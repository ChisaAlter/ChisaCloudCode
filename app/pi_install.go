package main

import (
	"archive/zip"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"
)

var piInstallMu sync.Mutex

func piBinaryPath() (string, error) {
	raw, err := os.ReadFile(filepath.Join(piDirectory(), "runtime.json"))
	if err != nil {
		return "", fmt.Errorf("请先安装本地 Pi")
	}
	var installed struct {
		Version    string `json:"version"`
		Executable string `json:"executable"`
	}
	if err = json.Unmarshal(raw, &installed); err != nil || installed.Version != piVersion {
		return "", fmt.Errorf("Pi 运行时版本不匹配，请安装 Pi %s", piVersion)
	}
	root := filepath.Join(piDirectory(), "runtime", piVersion)
	path := filepath.Join(root, installed.Executable)
	rel, err := filepath.Rel(root, path)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) || filepath.IsAbs(rel) {
		return "", fmt.Errorf("Pi 运行时路径无效")
	}
	if info, err := os.Stat(path); err != nil || info.IsDir() {
		return "", fmt.Errorf("Pi 运行时文件缺失，请重新安装")
	}
	return path, nil
}

// The desktop installs a pinned official release; no global npm or PATH changes.
func (FrontendBridge) PiInstall() map[string]any {
	piInstallMu.Lock()
	defer piInstallMu.Unlock()
	if _, err := piBinaryPath(); err == nil {
		return map[string]any{"ok": true, "version": piVersion}
	}
	if runtime.GOOS != "windows" {
		return map[string]any{"ok": false, "error": "此 Pi 执行端用于 Windows 桌面客户端"}
	}
	asset, digest := "pi-windows-x64.zip", "37a2ee3c5222a73efc78b49f571748f11a74f4dbe160da3030a404da71f464e7"
	if runtime.GOARCH == "arm64" {
		asset, digest = "pi-windows-arm64.zip", "4eb7c89f12c523d28069fed66f2ceb2466f909e41c87a6367a52728cec938b15"
	}
	if runtime.GOARCH != "amd64" && runtime.GOARCH != "arm64" {
		return map[string]any{"ok": false, "error": "Pi 不支持当前 Windows 架构"}
	}
	err := installPiArchive(asset, digest)
	if err != nil {
		return map[string]any{"ok": false, "error": "Pi 安装失败：" + err.Error()}
	}
	return map[string]any{"ok": true, "version": piVersion}
}

func installPiArchive(asset, digest string) error {
	root := filepath.Join(piDirectory(), "runtime")
	if err := os.MkdirAll(root, 0700); err != nil {
		return err
	}
	archivePath := filepath.Join(root, asset)
	// A timed-out download can be completed externally on another network route.
	// Reuse only the exact pinned official archive after checking all its bytes.
	cached := false
	if archive, openErr := os.Open(archivePath); openErr == nil {
		hash := sha256.New()
		size, readErr := io.Copy(hash, io.LimitReader(archive, 100*1024*1024+1))
		closeErr := archive.Close()
		cached = readErr == nil && closeErr == nil && size <= 100*1024*1024 && hex.EncodeToString(hash.Sum(nil)) == digest
	}
	if !cached {
		client := &http.Client{Timeout: 5 * time.Minute}
		request, _ := http.NewRequest(http.MethodGet, "https://github.com/earendil-works/pi/releases/download/v"+piVersion+"/"+asset, nil)
		request.Header.Set("User-Agent", "ChisaCloudCode")
		response, err := client.Do(request)
		if err != nil {
			return err
		}
		defer response.Body.Close()
		if response.StatusCode != http.StatusOK {
			return fmt.Errorf("官方安装包下载返回 HTTP %d", response.StatusCode)
		}
		archive, err := os.OpenFile(archivePath, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0600)
		if err != nil {
			return err
		}
		hash := sha256.New()
		size, copyErr := io.Copy(io.MultiWriter(archive, hash), io.LimitReader(response.Body, 100*1024*1024+1))
		closeErr := archive.Close()
		if copyErr != nil {
			return copyErr
		}
		if closeErr != nil {
			return closeErr
		}
		if size > 100*1024*1024 || hex.EncodeToString(hash.Sum(nil)) != digest {
			return fmt.Errorf("官方安装包 SHA256 校验失败")
		}
	}
	reader, err := zip.OpenReader(archivePath)
	if err != nil {
		return err
	}
	defer reader.Close()
	incoming := filepath.Join(root, "incoming-"+randHex(6))
	if err = os.Mkdir(incoming, 0700); err != nil {
		return err
	}
	executable := ""
	for _, file := range reader.File {
		name := filepath.FromSlash(file.Name)
		target := filepath.Join(incoming, name)
		rel, relErr := filepath.Rel(incoming, target)
		if relErr != nil || filepath.IsAbs(name) || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) || file.Mode()&os.ModeSymlink != 0 {
			return fmt.Errorf("安装包包含无效路径")
		}
		if file.FileInfo().IsDir() {
			if err = os.MkdirAll(target, 0700); err != nil {
				return err
			}
			continue
		}
		if err = os.MkdirAll(filepath.Dir(target), 0700); err != nil {
			return err
		}
		input, openErr := file.Open()
		if openErr != nil {
			return openErr
		}
		output, openErr := os.OpenFile(target, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
		if openErr != nil {
			input.Close()
			return openErr
		}
		_, copyErr := io.Copy(output, input)
		input.Close()
		closeErr := output.Close()
		if copyErr != nil {
			return copyErr
		}
		if closeErr != nil {
			return closeErr
		}
		if strings.EqualFold(filepath.Base(target), "pi.exe") {
			if executable != "" {
				return fmt.Errorf("安装包包含多个 Pi 主程序")
			}
			executable = rel
		}
	}
	if executable == "" {
		return fmt.Errorf("安装包没有 Pi 主程序")
	}
	final := filepath.Join(root, piVersion)
	if _, statErr := os.Stat(final); statErr == nil {
		// Repair an incomplete installation only after the replacement is verified.
		// Preserve the old runtime instead of recursively deleting any directory.
		absoluteRoot, pathErr := filepath.Abs(root)
		if pathErr != nil {
			return pathErr
		}
		absoluteFinal, pathErr := filepath.Abs(final)
		if pathErr != nil || filepath.Dir(absoluteFinal) != absoluteRoot {
			return fmt.Errorf("Pi 运行时替换路径无效")
		}
		if err = os.Rename(final, filepath.Join(absoluteRoot, "before-"+piVersion+"-"+randHex(6))); err != nil {
			return err
		}
	} else if !os.IsNotExist(statErr) {
		return statErr
	}
	if err = os.Rename(incoming, final); err != nil {
		return err
	}
	marker, _ := json.Marshal(map[string]string{"version": piVersion, "executable": executable})
	if err = os.WriteFile(filepath.Join(piDirectory(), "runtime.json.tmp"), marker, 0600); err != nil {
		return err
	}
	return os.Rename(filepath.Join(piDirectory(), "runtime.json.tmp"), filepath.Join(piDirectory(), "runtime.json"))
}
