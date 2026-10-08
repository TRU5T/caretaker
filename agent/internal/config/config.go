package config

import (
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
)

const DefaultPort = 7842

type Config struct {
	ListenAddr string `json:"listenAddr"`
	Token      string `json:"token"`
	HubURL     string `json:"hubUrl,omitempty"`
	HostID     string `json:"hostId,omitempty"`
	MAC        string `json:"mac,omitempty"`
	Name       string `json:"name,omitempty"`
	// PairCode is shown on this PC (installer dialog, agent.log) while
	// unpaired. The hub must prove it knows the code before /pair succeeds.
	PairCode string `json:"pairCode,omitempty"`
}

// Paired reports whether the agent has been claimed by a hub.
func (c *Config) Paired() bool {
	return c.Token != "" && c.HostID != ""
}

// ClearPairing forgets the hub and issues a fresh pairing code.
func (c *Config) ClearPairing() error {
	code, err := NewPairCode()
	if err != nil {
		return err
	}
	c.Token = ""
	c.HostID = ""
	c.HubURL = ""
	c.PairCode = code
	return nil
}

// Pairing-code alphabet: no 0/O/1/I/L. Must match the hub's.
const codeAlphabet = "23456789ABCDEFGHJKMNPQRSTUVWXYZ"

const PairCodeLength = 10 // 50 bits

// NewPairCode returns a uniformly random code like "K7Q2M9XW4C".
func NewPairCode() (string, error) {
	out := make([]byte, 0, PairCodeLength)
	buf := make([]byte, 32)
	limit := byte(256 - 256%len(codeAlphabet))
	for len(out) < PairCodeLength {
		if _, err := rand.Read(buf); err != nil {
			return "", err
		}
		for _, b := range buf {
			if b < limit {
				out = append(out, codeAlphabet[int(b)%len(codeAlphabet)])
				if len(out) == PairCodeLength {
					break
				}
			}
		}
	}
	return string(out), nil
}

// FormatPairCode renders a code as "XXXXX-XXXXX" for display.
func FormatPairCode(code string) string {
	if len(code) == PairCodeLength {
		return code[:5] + "-" + code[5:]
	}
	return code
}

// NormalizePairCode strips separators and uppercases user input.
func NormalizePairCode(code string) string {
	var b strings.Builder
	for _, r := range strings.ToUpper(code) {
		if (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') {
			b.WriteRune(r)
		}
	}
	return b.String()
}

// EnsurePairCode makes sure an unpaired agent at path has a pairing code on
// disk and returns it ("" when already paired).
func EnsurePairCode(path string) (string, error) {
	cfg, err := LoadOrCreate(path)
	if err != nil {
		return "", err
	}
	if cfg.Paired() {
		return "", nil
	}
	if cfg.PairCode != "" {
		return cfg.PairCode, nil
	}
	code, err := NewPairCode()
	if err != nil {
		return "", err
	}
	cfg.PairCode = code
	if err := Save(path, cfg); err != nil {
		return "", err
	}
	return code, nil
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
	return cfg, nil
}

func Save(path string, cfg *Config) error {
	if err := EnsurePrivateDir(filepath.Dir(path)); err != nil {
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

// EnsurePrivateDir creates dir and restricts it to the service account and
// administrators. It holds the bearer token and the TLS private key.
func EnsurePrivateDir(dir string) error {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	return restrictDir(dir)
}
