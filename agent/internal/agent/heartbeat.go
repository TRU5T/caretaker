package agent

import (
	"bytes"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"time"
)

// StartHeartbeat periodically POSTs to the hub so status stays fresh.
func (s *Server) StartHeartbeat(stop <-chan struct{}) {
	client := &http.Client{Timeout: 5 * time.Second}
	tick := time.NewTicker(15 * time.Second)
	defer tick.Stop()

	send := func() {
		if !s.paired() {
			return
		}
		locked, state := DetectLockState()
		host, _ := os.Hostname()
		// The hub is usually plain HTTP, so never send the token itself:
		// sign hostId+timestamp with it instead.
		hostID := s.hostID()
		ts := time.Now().UnixMilli()
		mac := hmac.New(sha256.New, []byte(s.token()))
		fmt.Fprintf(mac, "heartbeat\n%s\n%d", hostID, ts)
		payload := map[string]any{
			"hostId": hostID,
			"ts":     ts,
			"sig":    hex.EncodeToString(mac.Sum(nil)),
			"status": Status{
				Online:                  true,
				Locked:                  locked,
				SessionState:            state,
				Hostname:                host,
				Username:                CurrentUsername(),
				UptimeSec:               int64(time.Since(s.startedAt).Seconds()),
				AgentVersion:            Version,
				UnlockAttemptsRemaining: s.attemptsRemaining(),
			},
		}
		b, _ := json.Marshal(payload)
		req, err := http.NewRequest(http.MethodPost, s.hubURL()+"/api/heartbeat", bytes.NewReader(b))
		if err != nil {
			return
		}
		req.Header.Set("Content-Type", "application/json")
		resp, err := client.Do(req)
		if err != nil {
			return
		}
		resp.Body.Close()
	}

	send()
	for {
		select {
		case <-stop:
			return
		case <-tick.C:
			send()
		}
	}
}
