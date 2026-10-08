package agent

import (
	"crypto/hmac"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
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
	Version     = "0.2.0"
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
	// TLS is always true for this version; lets the hub tell old agents apart.
	TLS bool `json:"tls"`
}

type Server struct {
	cfgPath   string
	cfg       *config.Config
	cert      *config.AgentCert
	startedAt time.Time

	// OnPairingChanged runs (in its own goroutine) after pair/unpair, e.g. to
	// update the firewall rule. Optional.
	OnPairingChanged func(cfg config.Config)

	mu              sync.Mutex
	unlockFails     int
	maxUnlockFails  int
	unlockWindowEnd time.Time

	pairFails     int
	pairLockUntil time.Time
}

const (
	maxPairFails  = 5
	pairLockout   = 15 * time.Minute
	maxBodyBytes  = 64 << 10
	minTokenBytes = 32
)

func NewServer(cfgPath string, cfg *config.Config, cert *config.AgentCert) *Server {
	return &Server{
		cfgPath:        cfgPath,
		cfg:            cfg,
		cert:           cert,
		startedAt:      time.Now(),
		maxUnlockFails: 3,
	}
}

func (s *Server) paired() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.cfg.Paired()
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

// ListenPort is the TCP port the agent serves on.
func (s *Server) ListenPort() int { return s.listenPort() }

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
	mux.HandleFunc("/rotate", s.auth(s.handleRotate))
	mux.HandleFunc("/unpair", s.auth(s.handleUnpair))
	return recoverPanics(limitBodies(mux))
}

// limitBodies caps request bodies; nothing the agent accepts is large.
func limitBodies(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		r.Body = http.MaxBytesReader(w, r.Body, maxBodyBytes)
		next.ServeHTTP(w, r)
	})
}

func writeErr(w http.ResponseWriter, code int, msg string) {
	writeJSON(w, code, map[string]string{"error": msg})
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
			writeErr(w, http.StatusServiceUnavailable, "agent not paired yet")
			return
		}
		got := r.Header.Get("Authorization")
		const prefix = "Bearer "
		if !strings.HasPrefix(got, prefix) || !constantTimeEqual(got[len(prefix):], tok) {
			writeErr(w, http.StatusUnauthorized, "unauthorized")
			return
		}
		next(w, r)
	}
}

// constantTimeEqual compares secrets without leaking where they differ.
// Hashing first also hides the length of the expected value.
func constantTimeEqual(a, b string) bool {
	ha := sha256.Sum256([]byte(a))
	hb := sha256.Sum256([]byte(b))
	return subtle.ConstantTimeCompare(ha[:], hb[:]) == 1
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
		TLS:          true,
	}
}

type pairReq struct {
	HostID string `json:"hostId"`
	Token  string `json:"token"`
	HubURL string `json:"hubUrl"`
	Name   string `json:"name,omitempty"`
	MAC    string `json:"mac,omitempty"`
	// Proof = hex(HMAC-SHA256(key=pairCode, "caretaker-pair-v1\n"+certSHA256))
	// where certSHA256 is the certificate the hub saw. A machine in the middle
	// presents a different certificate, so its proof never matches ours.
	Proof string `json:"proof"`
}

// ExpectedPairProof is the proof a hub must send for code and this cert.
func ExpectedPairProof(code, certSHA256 string) string {
	m := hmac.New(sha256.New, []byte(config.NormalizePairCode(code)))
	m.Write([]byte("caretaker-pair-v1\n" + certSHA256))
	return hex.EncodeToString(m.Sum(nil))
}

func (s *Server) pairLockedOut() (bool, time.Duration) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if time.Now().Before(s.pairLockUntil) {
		return true, time.Until(s.pairLockUntil)
	}
	return false, 0
}

func (s *Server) recordPairFail(remote string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.pairFails++
	Logf("pair: wrong pairing code from %s (%d/%d)", remote, s.pairFails, maxPairFails)
	if s.pairFails >= maxPairFails {
		s.pairFails = 0
		s.pairLockUntil = time.Now().Add(pairLockout)
		Logf("pair: too many wrong codes — pairing disabled for %s", pairLockout)
	}
}

func (s *Server) handlePair(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeErr(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	if s.paired() {
		writeErr(w, http.StatusConflict, "already paired")
		return
	}
	if locked, wait := s.pairLockedOut(); locked {
		w.Header().Set("Retry-After", fmt.Sprintf("%d", int(wait.Seconds())+1))
		writeErr(w, http.StatusTooManyRequests, "too many wrong pairing codes — wait 15 minutes")
		return
	}
	var req pairReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.HostID == "" || req.Token == "" || req.HubURL == "" {
		writeErr(w, http.StatusBadRequest, "hostId, token, and hubUrl required")
		return
	}
	if len(req.Token) < minTokenBytes {
		writeErr(w, http.StatusBadRequest, "token too short")
		return
	}
	if !strings.HasPrefix(req.HubURL, "http://") && !strings.HasPrefix(req.HubURL, "https://") {
		writeErr(w, http.StatusBadRequest, "hubUrl must be http(s)")
		return
	}

	s.mu.Lock()
	code := s.cfg.PairCode
	s.mu.Unlock()
	if code == "" || s.cert == nil {
		writeErr(w, http.StatusServiceUnavailable, "agent has no pairing code — run `caretaker-agent pair-code` on the PC")
		return
	}
	expected := ExpectedPairProof(code, s.cert.SHA256)
	if !hmac.Equal([]byte(strings.ToLower(req.Proof)), []byte(expected)) {
		s.recordPairFail(r.RemoteAddr)
		writeErr(w, http.StatusForbidden, "wrong pairing code — check the code shown on the PC")
		return
	}

	s.mu.Lock()
	if s.cfg.Paired() {
		s.mu.Unlock()
		writeErr(w, http.StatusConflict, "already paired")
		return
	}
	s.pairFails = 0
	s.cfg.PairCode = ""
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
		writeErr(w, http.StatusInternalServerError, "failed to save config")
		return
	}
	Logf("pair: paired with hub %s (host %s) from %s", cfgCopy.HubURL, cfgCopy.HostID, r.RemoteAddr)
	s.pairingChanged(cfgCopy)

	writeJSON(w, http.StatusOK, map[string]any{
		"ok":     true,
		"hostId": req.HostID,
		"paired": true,
	})
}

func (s *Server) pairingChanged(cfg config.Config) {
	if s.OnPairingChanged != nil {
		go s.OnPairingChanged(cfg)
	}
}

type rotateReq struct {
	Token string `json:"token"`
}

// handleRotate swaps in a new bearer token chosen by the hub.
func (s *Server) handleRotate(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeErr(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	var req rotateReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || len(req.Token) < minTokenBytes {
		writeErr(w, http.StatusBadRequest, "token of at least 32 characters required")
		return
	}
	s.mu.Lock()
	prev := s.cfg.Token
	s.cfg.Token = req.Token
	cfgCopy := *s.cfg
	s.mu.Unlock()
	if err := config.Save(s.cfgPath, &cfgCopy); err != nil {
		s.mu.Lock()
		s.cfg.Token = prev
		s.mu.Unlock()
		writeErr(w, http.StatusInternalServerError, "failed to save config")
		return
	}
	Logf("rotate: bearer token replaced by hub (from %s)", r.RemoteAddr)
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// handleUnpair forgets the hub; the agent goes back to advertising itself.
func (s *Server) handleUnpair(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeErr(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	s.mu.Lock()
	if err := s.cfg.ClearPairing(); err != nil {
		s.mu.Unlock()
		writeErr(w, http.StatusInternalServerError, "failed to create pairing code")
		return
	}
	cfgCopy := *s.cfg
	s.mu.Unlock()
	if err := config.Save(s.cfgPath, &cfgCopy); err != nil {
		writeErr(w, http.StatusInternalServerError, "failed to save config")
		return
	}
	Logf("unpair: hub removed this PC (from %s). New pairing code: %s", r.RemoteAddr, config.FormatPairCode(cfgCopy.PairCode))
	s.pairingChanged(cfgCopy)
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
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
		writeErr(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	var req sleepReq
	_ = json.NewDecoder(r.Body).Decode(&req)
	mode := req.Mode
	if mode == "" {
		mode = "sleep"
	}
	if mode != "sleep" && mode != "hibernate" {
		writeErr(w, http.StatusBadRequest, "mode must be sleep or hibernate")
		return
	}
	if err := Sleep(mode); err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
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
		writeErr(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	var req unlockReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.Secret == "" {
		writeErr(w, http.StatusBadRequest, "secret required")
		return
	}
	if len(req.Secret) > 256 {
		writeErr(w, http.StatusBadRequest, "secret too long")
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
		writeErr(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	if err := PrepareUnlock(); err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
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
