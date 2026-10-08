package pair

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/TRU5T/caretaker/agent/internal/config"
)

type Options struct {
	HubURL     string
	Code       string
	AgentURL   string
	MAC        string // optional — hub already has MAC from Add PC
	Name       string
	ConfigPath string
}

func Complete(opts Options) error {
	if opts.HubURL == "" || opts.Code == "" || opts.AgentURL == "" {
		return fmt.Errorf("--hub, --code, and --agent-url are required")
	}
	cert, err := config.LoadOrCreateCert(opts.ConfigPath)
	if err != nil {
		return err
	}
	// The agent only serves HTTPS now; the hub pins the certificate we send.
	agentURL := strings.TrimRight(opts.AgentURL, "/")
	if !strings.Contains(agentURL, "://") {
		agentURL = "https://" + agentURL
	}
	agentURL = strings.Replace(agentURL, "http://", "https://", 1)

	host, _ := os.Hostname()
	name := opts.Name
	if name == "" {
		name = host
	}
	payload := map[string]string{
		"pairingCode": config.NormalizePairCode(opts.Code),
		"agentUrl":    agentURL,
		"name":        name,
		"hostname":    host,
		"certPem":     cert.PEM,
	}
	if opts.MAC != "" {
		payload["mac"] = opts.MAC
	}
	body, _ := json.Marshal(payload)
	client := &http.Client{Timeout: 15 * time.Second}
	resp, err := client.Post(strings.TrimRight(opts.HubURL, "/")+"/api/pair/complete", "application/json", bytes.NewReader(body))
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	if resp.StatusCode >= 300 {
		return fmt.Errorf("pair failed (%d): %s", resp.StatusCode, string(b))
	}
	if strings.HasPrefix(opts.HubURL, "http://") {
		fmt.Println("note: the hub URL is plain HTTP, so the token in this reply crossed the LAN unencrypted.")
		fmt.Println("      Put the hub behind HTTPS, or use one-click pairing from the Hub UI instead.")
	}
	var out struct {
		OK         bool   `json:"ok"`
		HostID     string `json:"hostId"`
		AgentToken string `json:"agentToken"`
		MAC        string `json:"mac"`
		Name       string `json:"name"`
	}
	if err := json.Unmarshal(b, &out); err != nil {
		return err
	}
	if out.AgentToken == "" || out.HostID == "" {
		return fmt.Errorf("hub reply missing token or host id")
	}
	u, err := parseListenFromAgentURL(agentURL)
	if err != nil {
		u = fmt.Sprintf(":%d", config.DefaultPort)
	}
	mac := opts.MAC
	if mac == "" {
		mac = out.MAC
	}
	if out.Name != "" {
		name = out.Name
	}
	cfg := &config.Config{
		ListenAddr: u,
		Token:      out.AgentToken,
		HubURL:     strings.TrimRight(opts.HubURL, "/"),
		HostID:     out.HostID,
		MAC:        mac,
		Name:       name,
	}
	return config.Save(opts.ConfigPath, cfg)
}

func parseListenFromAgentURL(agentURL string) (string, error) {
	if !strings.Contains(agentURL, "://") {
		agentURL = "http://" + agentURL
	}
	rest := agentURL
	if i := strings.Index(rest, "://"); i >= 0 {
		rest = rest[i+3:]
	}
	hostport := rest
	if i := strings.IndexAny(hostport, "/?"); i >= 0 {
		hostport = hostport[:i]
	}
	_, port, err := net.SplitHostPort(hostport)
	if err != nil {
		return "", err
	}
	return ":" + port, nil
}
