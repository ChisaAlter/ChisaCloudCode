package main

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
)

const piVersion = "1.0.2"

// Pi credentials belong to the Windows client, never to the VPS bridge config.
type piConfig struct {
	Provider     string `json:"provider"`
	Model        string `json:"model"`
	BaseURL      string `json:"baseUrl"`
	API          string `json:"api"`
	ProtectedKey string `json:"protectedKey,omitempty"`
}

var piConfigMu sync.Mutex

func piDirectory() string { return filepath.Join(dataDir(), "pi") }

func readPiConfig() (piConfig, error) {
	var cfg piConfig
	raw, err := os.ReadFile(filepath.Join(piDirectory(), "config.json"))
	if os.IsNotExist(err) {
		return cfg, nil
	}
	if err != nil {
		return cfg, err
	}
	err = json.Unmarshal(raw, &cfg)
	return cfg, err
}

func piConfigView(cfg piConfig) map[string]any {
	_, err := piBinaryPath()
	return map[string]any{"ok": true, "installed": err == nil, "version": piVersion,
		"provider": cfg.Provider, "model": cfg.Model, "baseUrl": cfg.BaseURL, "api": cfg.API,
		"hasApiKey": cfg.ProtectedKey != "", "configured": cfg.Provider != "" && cfg.Model != "" && cfg.ProtectedKey != ""}
}

func (FrontendBridge) PiGetConfig() map[string]any {
	piConfigMu.Lock()
	defer piConfigMu.Unlock()
	cfg, err := readPiConfig()
	if err != nil {
		return map[string]any{"ok": false, "error": "无法读取 Pi 配置：" + err.Error()}
	}
	return piConfigView(cfg)
}

func (FrontendBridge) PiSaveConfig(input map[string]any) map[string]any {
	if piRuntimeActive() {
		return map[string]any{"ok": false, "error": "请先停止本地 Pi 和它运行的程序，再修改模型配置"}
	}
	piConfigMu.Lock()
	defer piConfigMu.Unlock()
	previous, err := readPiConfig()
	if err != nil {
		return map[string]any{"ok": false, "error": err.Error()}
	}
	value := func(key string) string { v, _ := input[key].(string); return strings.TrimSpace(v) }
	cfg := piConfig{Provider: value("provider"), Model: value("model"), BaseURL: strings.TrimRight(value("baseUrl"), "/"), API: value("api")}
	if cfg.Provider == "" || cfg.Model == "" {
		return map[string]any{"ok": false, "error": "请填写模型服务商和模型名称"}
	}
	if strings.ContainsAny(cfg.Provider, "\x00\r\n") || strings.ContainsAny(cfg.Model, "\x00\r\n") {
		return map[string]any{"ok": false, "error": "模型配置包含无效字符"}
	}
	if cfg.BaseURL != "" {
		u, parseErr := url.Parse(cfg.BaseURL)
		if parseErr != nil || (u.Scheme != "https" && u.Scheme != "http") || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
			return map[string]any{"ok": false, "error": "请填写有效的 API 地址，不要在地址中包含密钥"}
		}
	}
	if cfg.Provider == "custom" {
		if cfg.BaseURL == "" {
			return map[string]any{"ok": false, "error": "自定义模型需要 API 地址"}
		}
		if cfg.API != "openai-completions" && cfg.API != "openai-responses" && cfg.API != "anthropic-messages" {
			return map[string]any{"ok": false, "error": "请选择模型服务支持的 API 类型"}
		}
	}
	key := value("apiKey")
	if key != "" {
		protected, protectErr := protectPiSecret([]byte(key))
		if protectErr != nil {
			return map[string]any{"ok": false, "error": "无法保护模型密钥：" + protectErr.Error()}
		}
		cfg.ProtectedKey = base64.StdEncoding.EncodeToString(protected)
	} else if cfg.Provider == previous.Provider && cfg.BaseURL == previous.BaseURL {
		cfg.ProtectedKey = previous.ProtectedKey
	}
	if cfg.ProtectedKey == "" {
		return map[string]any{"ok": false, "error": "请填写这个模型服务的 API 密钥"}
	}
	if err := os.MkdirAll(piDirectory(), 0700); err != nil {
		return map[string]any{"ok": false, "error": err.Error()}
	}
	raw, err := json.MarshalIndent(cfg, "", "  ")
	if err == nil {
		err = os.WriteFile(filepath.Join(piDirectory(), "config.json.tmp"), raw, 0600)
	}
	if err == nil {
		err = os.Rename(filepath.Join(piDirectory(), "config.json.tmp"), filepath.Join(piDirectory(), "config.json"))
	}
	if err != nil {
		return map[string]any{"ok": false, "error": "Pi 配置保存失败：" + err.Error()}
	}
	return piConfigView(cfg)
}

// piRuntimeSpec writes only an environment reference into Pi's model registry.
// The decrypted key is supplied to the child process, not through argv or RPC.
func piRuntimeSpec() (string, []string, []string, error) {
	piConfigMu.Lock()
	defer piConfigMu.Unlock()
	cfg, err := readPiConfig()
	if err != nil {
		return "", nil, nil, err
	}
	if cfg.Provider == "" || cfg.Model == "" || cfg.ProtectedKey == "" {
		return "", nil, nil, fmt.Errorf("请先在设置中配置 Pi 的模型和 API 密钥")
	}
	binary, err := piBinaryPath()
	if err != nil {
		return "", nil, nil, err
	}
	protected, err := base64.StdEncoding.DecodeString(cfg.ProtectedKey)
	if err != nil {
		return "", nil, nil, fmt.Errorf("Pi 密钥无法读取")
	}
	key, err := unprotectPiSecret(protected)
	if err != nil {
		return "", nil, nil, fmt.Errorf("Pi 密钥解密失败，请重新填写")
	}
	agentDir := filepath.Join(piDirectory(), "agent")
	if err := os.MkdirAll(agentDir, 0700); err != nil {
		return "", nil, nil, err
	}
	provider := cfg.Provider
	modelDefinition := map[string]any{"apiKey": "$CHISA_PI_API_KEY"}
	if cfg.BaseURL != "" {
		modelDefinition["baseUrl"] = cfg.BaseURL
	}
	if provider == "custom" {
		provider = "chisa-local"
		modelDefinition["api"] = cfg.API
		model := map[string]any{"id": cfg.Model, "input": []string{"text", "image"}}
		officialOpenAI := cfg.BaseURL == "https://api.minimax.cn/v1" || cfg.BaseURL == "https://api.minimax.io/v1"
		officialAnthropic := cfg.API == "anthropic-messages" && cfg.BaseURL == "https://api.minimax.io/anthropic"
		if cfg.Model == "MiniMax-M3.1-Flash-Preview" && (officialOpenAI || officialAnthropic) {
			// MiniMax documents a 1M context; Pi otherwise defaults custom models to 128k.
			model["contextWindow"], model["maxTokens"] = 1_000_000, 16384
		}
		modelDefinition["models"] = []map[string]any{model}
	}
	registry, err := json.Marshal(map[string]any{"providers": map[string]any{provider: modelDefinition}})
	if err != nil {
		return "", nil, nil, err
	}
	if err = os.WriteFile(filepath.Join(agentDir, "models.json"), registry, 0600); err != nil {
		return "", nil, nil, err
	}
	settings, _ := json.Marshal(map[string]any{"defaultTools": []string{"read", "powershell", "edit", "write"}})
	if err = os.WriteFile(filepath.Join(agentDir, "settings.json"), settings, 0600); err != nil {
		return "", nil, nil, err
	}
	args := []string{"--mode", "rpc", "--provider", provider, "--model", cfg.Model, "--tools", "read,powershell,edit,write", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes"}
	environment := append(os.Environ(), "PI_CODING_AGENT_DIR="+agentDir, "CHISA_PI_API_KEY="+string(key))
	return binary, args, environment, nil
}
