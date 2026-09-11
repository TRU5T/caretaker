package agent

import (
	"encoding/json"
	"fmt"
	"net"
	"time"
)

// StartBeacon advertises this agent on the LAN until paired or stop is closed.
func (s *Server) StartBeacon(stop <-chan struct{}) {
	conn, err := net.ListenPacket("udp4", ":0")
	if err != nil {
		fmt.Println("beacon: listen failed:", err)
		return
	}
	defer conn.Close()

	dst := &net.UDPAddr{IP: net.IPv4bcast, Port: BeaconPort}
	tick := time.NewTicker(3 * time.Second)
	defer tick.Stop()

	send := func() {
		if s.paired() {
			return
		}
		info := s.discoverInfo()
		b, _ := json.Marshal(info)
		_, _ = conn.WriteTo(b, dst)
	}

	send()
	for {
		select {
		case <-stop:
			return
		case <-tick.C:
			if s.paired() {
				// Keep the goroutine alive but idle so a future unpair could resume later;
				// for MVP just exit once paired.
				return
			}
			send()
		}
	}
}

func (s *Server) StopBeacon() {
	// Pairing sets token/hostId; StartBeacon exits on next tick via paired().
}
