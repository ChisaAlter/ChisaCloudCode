package main

import (
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"log"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
)

type Config struct {
	LoginURL           string `json:"loginUrl,omitempty"`
	APIURL             string `json:"apiUrl,omitempty"`
	WorkspaceServerURL string `json:"workspaceServerUrl,omitempty"`
	ServerURL          string `json:"serverUrl"`
	SSHHost            string `json:"sshHost"`
	SSHUser            string `json:"sshUser"`
	SSHPort            int    `json:"sshPort,omitempty"`
	KeyPath            string `json:"keyPath"`
	WorkspaceRoot      string `json:"workspaceRoot,omitempty"`
	ControlHost        string `json:"controlHost,omitempty"`
	WorkspaceAccount   string `json:"workspaceAccount,omitempty"`
	WorkspaceLoginURL  string `json:"workspaceLoginUrl,omitempty"`
	SSHKnownHostsPath  string `json:"sshKnownHostsPath,omitempty"`
	SSHHostKeyPinned   bool   `json:"sshHostKeyPinned,omitempty"`
	Token              string `json:"token"`
}
type Mapping struct {
	LocalPath    string `json:"localPath"`
	ServerPath   string `json:"serverPath"`
	SyncName     string `json:"syncName,omitempty"`
	Mode         string `json:"mode,omitempty"`
	BindingEpoch string `json:"bindingEpoch"`
	ServerID     string `json:"serverId"`
}
type Store struct {
	mu       sync.Mutex
	path     string
	Cfg      Config     `json:"config"`
	Mappings []*Mapping `json:"mappings"`
}

var store *Store

func norm(p string) string { return strings.ReplaceAll(strings.ToLower(filepath.Clean(p)), "/", "\\") }

// Bindings identify physical directories, including junction and short-name
// aliases. Keep the lexical check for temporarily unavailable saved paths.
func sameLocalDirectory(a, b string) bool {
	if norm(a) == norm(b) {
		return true
	}
	ai, ae := os.Stat(a)
	bi, be := os.Stat(b)
	return ae == nil && be == nil && ai.IsDir() && bi.IsDir() && os.SameFile(ai, bi)
}

// Managed workspaces reach the plain HTTP API through the container host;
// ServerURL is their public HTTPS endpoint and can use a different port.
// Manual connections retain their configured instance port.
func workspaceAPIPort(cfg Config) string {
	if cfg.WorkspaceAccount == "" {
		if u, err := url.Parse(cfg.ServerURL); err == nil && u.Port() != "" {
			return u.Port()
		}
	}
	return "8791"
}

// A workspace belongs to one SSH account and CloudCLI instance, not just a path.
func serverIdentity(cfg Config) string {
	if cfg.WorkspaceAccount != "" {
		// Managed SSH ports can change when the account transport is replaced.
		// Directory ownership stays with the authenticated account and instance.
		owner := strings.Join([]string{cfg.WorkspaceLoginURL, cfg.ServerURL, cfg.WorkspaceAccount, cfg.WorkspaceRoot}, "\n")
		return fmt.Sprintf("account:%x", sha256.Sum256([]byte(owner)))
	}
	identity := strings.ToLower(cfg.SSHHost) + ":" + workspaceAPIPort(cfg) + "/" + cfg.SSHUser
	if cfg.SSHPort != 0 && cfg.SSHPort != 22 {
		identity += fmt.Sprintf("/ssh:%d", cfg.SSHPort)
	}
	return identity
}

func loadStore(dir string) *Store {
	s := &Store{path: filepath.Join(dir, "state.json")}
	raw, err := os.ReadFile(s.path)
	if err == nil {
		if err = json.Unmarshal(raw, s); err != nil {
			log.Fatal("state.json 无法读取；保留原文件，停止启动：", err)
		}
		if s.Cfg.ServerURL == "" {
			var flat Config
			if err = json.Unmarshal(raw, &flat); err != nil {
				log.Fatal(err)
			}
			if flat.ServerURL != "" {
				s.Cfg = flat
			}
		}
	} else if !os.IsNotExist(err) {
		log.Fatal("无法读取连接配置：", err)
	}
	if s.Cfg.Token == "" {
		s.Cfg.Token = randHex(24)
	}
	if s.Cfg.SSHUser == "" {
		s.Cfg.SSHUser = "root"
	}
	for _, m := range s.Mappings {
		if m == nil {
			log.Fatal("state.json 包含无效的工作区记录")
		}
		if m.BindingEpoch == "" {
			m.BindingEpoch = randHex(16)
		}
		// Existing state used a single server; persist that ownership before switching.
		if m.ServerID == "" {
			m.ServerID = serverIdentity(s.Cfg)
		}
	}
	if err = s.flush(); err != nil {
		log.Fatal("连接配置保存失败：", err)
	}
	return s
}

func (s *Store) config() Config { s.mu.Lock(); defer s.mu.Unlock(); return s.Cfg }
func (s *Store) keyPathOf() string {
	if key := s.config().KeyPath; key != "" {
		return key
	}
	return filepath.Join(dataDir(), "bridge-key", "id_ed25519")
}
func (s *Store) mappings() []*Mapping {
	s.mu.Lock()
	defer s.mu.Unlock()
	items := make([]*Mapping, 0, len(s.Mappings))
	for _, m := range s.Mappings {
		copy := *m
		items = append(items, &copy)
	}
	return items
}
func (s *Store) updateConfig(cfg Config) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	old := s.Cfg
	s.Cfg = cfg
	if err := s.flushLocked(); err != nil {
		s.Cfg = old
		return err
	}
	return nil
}
func (s *Store) flush() error { s.mu.Lock(); defer s.mu.Unlock(); return s.flushLocked() }
func (s *Store) flushLocked() error {
	if err := os.MkdirAll(filepath.Dir(s.path), 0700); err != nil {
		return err
	}
	raw, err := json.MarshalIndent(struct {
		Config   Config     `json:"config"`
		Mappings []*Mapping `json:"mappings"`
	}{s.Cfg, s.Mappings}, "", "  ")
	if err != nil {
		return err
	}
	if err = os.WriteFile(s.path+".tmp", raw, 0600); err != nil {
		return err
	}
	return os.Rename(s.path+".tmp", s.path)
}
func (s *Store) findMappingByLocal(local string) *Mapping {
	for _, m := range s.mappings() {
		if sameLocalDirectory(m.LocalPath, local) {
			return m
		}
	}
	return nil
}
func (s *Store) findMappingByServer(server string) *Mapping {
	// Server paths are POSIX and case-sensitive.
	for _, m := range s.mappings() {
		if m.ServerPath == server {
			return m
		}
	}
	return nil
}
func (s *Store) addMapping(m *Mapping) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, existing := range s.Mappings {
		if sameLocalDirectory(existing.LocalPath, m.LocalPath) {
			if *existing == *m {
				return nil
			}
			return fmt.Errorf("本地目录已绑定另一项目，请使用现有绑定或先移除原绑定")
		}
		if existing.ServerPath == m.ServerPath {
			return fmt.Errorf("服务器项目路径已被另一条本机映射使用")
		}
	}
	s.Mappings = append(s.Mappings, m)
	if err := s.flushLocked(); err != nil {
		s.Mappings = s.Mappings[:len(s.Mappings)-1]
		return err
	}
	return nil
}
func (s *Store) removeMapping(server string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	old := s.Mappings
	next := make([]*Mapping, 0, len(old))
	for _, m := range old {
		if m.ServerPath != server {
			next = append(next, m)
		}
	}
	s.Mappings = next
	if err := s.flushLocked(); err != nil {
		s.Mappings = old
		return err
	}
	return nil
}

// A stale settings row cannot remove a replacement binding at the same path.
func (s *Store) removeMappingBinding(server, epoch string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	for i, m := range s.Mappings {
		if m.ServerPath != server || m.BindingEpoch != epoch {
			continue
		}
		old := s.Mappings
		next := append([]*Mapping{}, old[:i]...)
		s.Mappings = append(next, old[i+1:]...)
		if err := s.flushLocked(); err != nil {
			s.Mappings = old
			return err
		}
		return nil
	}
	return os.ErrNotExist
}

func (s *Store) updateMapping(updated *Mapping) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	for i, m := range s.Mappings {
		if m.ServerPath == updated.ServerPath && m.BindingEpoch == updated.BindingEpoch {
			copy := *updated
			s.Mappings[i] = &copy
			if err := s.flushLocked(); err != nil {
				s.Mappings[i] = m
				return err
			}
			return nil
		}
	}
	return os.ErrNotExist
}
