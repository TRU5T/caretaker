package agent

import (
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"os"
	"runtime/debug"
	"strings"
	"sync"
	"time"

	"github.com/TRU5T/caretaker/agent/internal/config"
)

const (
	Version     = "0.1.0"
	BeaconPort  = 7843
	BeaconMagic = "caretaker-agent"
)

type Status struct {
	Online                  bool   `json:"online"`
	Locked                  bool   `json:"locked"`
	SessionState            string `json:"sessionState"`
	Hostname                string `json:"hostname"`
	Username                string `json:"username,omitempty"`
	UptimeSec               int64  `json:"uptimeSec"`
	AgentVersion            string `json:"agentVersion"`
	UnlockAttemptsRemaining int    `json:"unlockAttemptsRemaining"`
}

type DiscoverInfo struct {
	Service      string   `json:"service"`
	Version      string   `json:"version"`
	Hostname     string   `json:"hostname"`
	Paired       bool     `json:"paired"`
	Port         int      `json:"port"`
	MACs         []string `json:"macs"`
	Addresses    []string `json:"addresses"`
	PreferredMAC string   `json:"preferredMac,omitempty"`
}

type Server struct {
	cfgPath   string
	cfg       *config.Config
	startedAt time.Time

	mu              sync.Mutex
	unlockFails     int
	maxUnlockFails  int
	unlockWindowEnd time.Time
}

func NewServer(cfgPath string, cfg *config.Config) *Server {
	return &Server{
		cfgPath:        cfgPath,
		cfg:            cfg,
		startedAt:      time.Now(),
		maxUnlockFails: 3,
	}
}

func (s *Server) paired() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.cfg.Token != "" && s.cfg.HostID != ""
}

func (s *Server) token() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.cfg.Token
}

func (s *Server) hubURL() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.cfg.HubURL
}

func (s *Server) hostID() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.cfg.HostID
}

func (s *Server) listenPort() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	addr := s.cfg.ListenAddr
	if strings.HasPrefix(addr, ":") {
		var p int
		_, _ = fmt.Sscanf(addr, ":%d", &p)
		if p > 0 {
			return p
		}
	}
	if _, port, err := net.SplitHostPort(addr); err == nil {
		var p int
		_, _ = fmt.Sscanf(port, "%d", &p)
		if p > 0 {
			return p
		}
	}
	return config.DefaultPort
}

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/health", s.handleHealth)
	mux.HandleFunc("/discover", s.handleDiscover)
	mux.HandleFunc("/pair", s.handlePair)
	mux.HandleFunc("/status", s.auth(s.handleStatus))
	mux.HandleFunc("/sleep", s.auth(s.handleSleep))
	mux.HandleFunc("/unlock", s.auth(s.handleUnlock))
	mux.HandleFunc("/prepare", s.auth(s.handlePrepare))
	return recoverPanics(mux)
}

// recoverPanics keeps one bad request from taking the whole service down.
func recoverPanics(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer func() {
			if v := recover(); v != nil {
				Logf("PANIC handling %s %s: %v\n%s", r.Method, r.URL.Path, v, debug.Stack())
				http.Error(w, `{"error":"internal error"}`, http.StatusInternalServerError)
			}
		}()
		next.ServeHTTP(w, r)
	})
}

func (s *Server) auth(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		tok := s.token()
		if tok == "" {
			http.Error(w, `{"error":"agent not paired yet"}`, http.StatusServiceUnavailable)
			return
		}
		got := r.Header.Get("Authorization")
		const prefix = "Bearer "
		if len(got) < len(prefix) || got[:len(prefix)] != prefix || got[len(prefix):] != tok {
			http.Error(w, `{"error":"unauthorized"}`, http.StatusUnauthorized)
			return
		}
		next(w, r)
	}
}

func (s *Server) handleHealth(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"ok":      true,
		"version": Version,
		"paired":  s.paired(),
	})
}

func (s *Server) handleDiscover(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, s.discoverInfo())
}

func (s *Server) discoverInfo() DiscoverInfo {
	host, _ := os.Hostname()
	macs, addrs := LocalIdentity()
	pref := ""
	if len(macs) > 0 {
		pref = macs[0]
	}
	s.mu.Lock()
	if s.cfg.MAC != "" {
		pref = s.cfg.MAC
	}
	s.mu.Unlock()
	return DiscoverInfo{
		Service:      BeaconMagic,
		Version:      Version,
		Hostname:     host,
		Paired:       s.paired(),
		Port:         s.listenPort(),
		MACs:         macs,
		Addresses:    addrs,
		PreferredMAC: pref,
	}
}

type pairReq struct {
	HostID string `json:"hostId"`
	Token  string `json:"token"`
	HubURL string `json:"hubUrl"`
	Name   string `json:"name,omitempty"`
	MAC    string `json:"mac,omitempty"`
}

func (s *Server) handlePair(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
		return
	}
	if s.paired() {
		http.Error(w, `{"error":"already paired"}`, http.StatusConflict)
		return
	}
	var req pairReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.HostID == "" || req.Token == "" || req.HubURL == "" {
		http.Error(w, `{"error":"hostId, token, and hubUrl required"}`, http.StatusBadRequest)
		return
	}

	s.mu.Lock()
	s.cfg.HostID = req.HostID
	s.cfg.Token = req.Token
	s.cfg.HubURL = strings.TrimRight(req.HubURL, "/")
	if req.Name != "" {
		s.cfg.Name = req.Name
	}
	if req.MAC != "" {
		s.cfg.MAC = req.MAC
	} else if s.cfg.MAC == "" {
		macs, _ := LocalIdentity()
		if len(macs) > 0 {
			s.cfg.MAC = macs[0]
		}
	}
	cfgCopy := *s.cfg
	s.mu.Unlock()

	if err := config.Save(s.cfgPath, &cfgCopy); err != nil {
		http.Error(w, `{"error":"failed to save config"}`, http.StatusInternalServerError)
		return
	}

	s.StopBeacon()

	writeJSON(w, http.StatusOK, map[string]any{
		"ok":     true,
		"hostId": req.HostID,
		"paired": true,
	})
}

func (s *Server) handleStatus(w http.ResponseWriter, _ *http.Request) {
	locked, state := DetectLockState()
	host, _ := os.Hostname()
	user := CurrentUsername()
	writeJSON(w, http.StatusOK, Status{
		Online:                  true,
		Locked:                  locked,
		SessionState:            state,
		Hostname:                host,
		Username:                user,
		UptimeSec:               int64(time.Since(s.startedAt).Seconds()),
		AgentVersion:            Version,
		UnlockAttemptsRemaining: s.attemptsRemaining(),
	})
}

type sleepReq struct {
	Mode string `json:"mode"`
}

func (s *Server) handleSleep(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
		return
	}
	var req sleepReq
	_ = json.NewDecoder(r.Body).Decode(&req)
	mode := req.Mode
	if mode == "" {
		mode = "sleep"
	}
	if err := Sleep(mode); err != nil {
		http.Error(w, `{"error":"`+err.Error()+`"}`, http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

type unlockReq struct {
	Secret string `json:"secret"`
	Kind   string `json:"kind"`
}

func (s *Server) handleUnlock(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
		return
	}
	var req unlockReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.Secret == "" {
		http.Error(w, `{"error":"secret required"}`, http.StatusBadRequest)
		return
	}
	if s.attemptsRemaining() <= 0 {
		writeJSON(w, http.StatusOK, map[string]any{
			"ok":                false,
			"locked":            true,
			"message":           "too many unlock attempts — wait before retrying",
			"attemptsRemaining": 0,
		})
		return
	}

	locked, _ := DetectLockState()
	if !locked {
		s.resetAttempts()
		writeJSON(w, http.StatusOK, map[string]any{
			"ok":                true,
			"locked":            false,
			"message":           "already unlocked",
			"attemptsRemaining": s.attemptsRemaining(),
		})
		return
	}

	kind := req.Kind
	if kind == "" {
		kind = "pin"
	}
	err := Unlock(req.Secret, kind)
	// Dismiss + type takes a few seconds; wait before re-checking lock state.
	time.Sleep(2800 * time.Millisecond)
	lockedAfter, _ := DetectLockState()
	if err != nil {
		s.recordFail()
		writeJSON(w, http.StatusOK, map[string]any{
			"ok":                false,
			"locked":            lockedAfter,
			"message":           err.Error(),
			"attemptsRemaining": s.attemptsRemaining(),
		})
		return
	}
	if lockedAfter {
		s.recordFail()
		writeJSON(w, http.StatusOK, map[string]any{
			"ok":                false,
			"locked":            true,
			"message":           "still locked — try Show login field first, then unlock again",
			"attemptsRemaining": s.attemptsRemaining(),
		})
		return
	}
	s.resetAttempts()
	writeJSON(w, http.StatusOK, map[string]any{
		"ok":                true,
		"locked":            false,
		"message":           "unlocked",
		"attemptsRemaining": s.attemptsRemaining(),
	})
}

func (s *Server) handlePrepare(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
		return
	}
	if err := PrepareUnlock(); err != nil {
		http.Error(w, `{"error":"`+err.Error()+`"}`, http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"ok":      true,
		"message": "lock screen poked — password/PIN field should be visible",
	})
}

func (s *Server) attemptsRemaining() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	if time.Now().After(s.unlockWindowEnd) && s.unlockFails > 0 {
		s.unlockFails = 0
	}
	left := s.maxUnlockFails - s.unlockFails
	if left < 0 {
		return 0
	}
	return left
}

func (s *Server) recordFail() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.unlockFails++
	s.unlockWindowEnd = time.Now().Add(15 * time.Minute)
}

func (s *Server) resetAttempts() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.unlockFails = 0
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

// LocalIdentity returns non-loopback MACs and IPv4 addresses.
func LocalIdentity() (macs []string, addrs []string) {
	ifs, err := net.Interfaces()
	if err != nil {
		return nil, nil
	}
	seenMAC := map[string]bool{}
	seenIP := map[string]bool{}
	for _, iface := range ifs {
		if iface.Flags&net.FlagUp == 0 || iface.Flags&net.FlagLoopback != 0 {
			continue
		}
		name := strings.ToLower(iface.Name)
		if strings.Contains(name, "docker") || strings.Contains(name, "veth") || strings.Contains(name, "br-") {
			continue
		}
		if len(iface.HardwareAddr) == 6 {
			mac := strings.ToUpper(iface.HardwareAddr.String())
			if !seenMAC[mac] {
				seenMAC[mac] = true
				macs = append(macs, mac)
			}
		}
		list, err := iface.Addrs()
		if err != nil {
			continue
		}
		for _, a := range list {
			var ip net.IP
			switch v := a.(type) {
			case *net.IPNet:
				ip = v.IP
			case *net.IPAddr:
				ip = v.IP
			}
			if ip == nil || ip.IsLoopback() {
				continue
			}
			ip4 := ip.To4()
			if ip4 == nil {
				continue
			}
			s := ip4.String()
			if !seenIP[s] {
				seenIP[s] = true
				addrs = append(addrs, s)
			}
		}
	}
	return macs, addrs
}
