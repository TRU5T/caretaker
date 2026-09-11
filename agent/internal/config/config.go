package config

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
)

const DefaultPort = 7842

type Config struct {
	ListenAddr string `json:"listenAddr"`
	Token      string `json:"token"`
	HubURL     string `json:"hubUrl,omitempty"`
	HostID     string `json:"hostId,omitempty"`
	MAC        string `json:"mac,omitempty"`
	Name       string `json:"name,omitempty"`
}

func DefaultPath() string {
	if runtime.GOOS == "windows" {
		base := os.Getenv("PROGRAMDATA")
		if base == "" {
			base = `C:\ProgramData`
		}
		return filepath.Join(base, "Caretaker", "agent.json")
	}
	home, _ := os.UserHomeDir()
	if home == "" {
		home = "."
	}
	return filepath.Join(home, ".config", "caretaker", "agent.json")
}

func LoadOrCreate(path string) (*Config, error) {
	cfg := &Config{
		ListenAddr: fmt.Sprintf(":%d", DefaultPort),
		Token:      "",
	}
	if b, err := os.ReadFile(path); err == nil {
		if err := json.Unmarshal(b, cfg); err != nil {
			return nil, fmt.Errorf("parse config: %w", err)
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}

	if v := os.Getenv("CARETAKER_AGENT_TOKEN"); v != "" {
		cfg.Token = v
	}
	if v := os.Getenv("CARETAKER_HUB_URL"); v != "" {
		cfg.HubURL = v
	}
	if v := os.Getenv("CARETAKER_HOST_ID"); v != "" {
		cfg.HostID = v
	}
	if v := os.Getenv("CARETAKER_AGENT_PORT"); v != "" {
		p, err := strconv.Atoi(v)
		if err != nil {
			return nil, fmt.Errorf("CARETAKER_AGENT_PORT: %w", err)
		}
		cfg.ListenAddr = fmt.Sprintf(":%d", p)
	}
	if cfg.Token == "" {
		// Allow first-run without token only for local testing; warn via empty check in server
	}
	return cfg, nil
}

func Save(path string, cfg *Config) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	b, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}
