//go:build windows

package svc

import (
	"fmt"
	"os/exec"
	"syscall"

	"github.com/TRU5T/caretaker/agent/internal/agent"
)

const firewallRuleName = "Caretaker Agent"

// configureFirewall allows inbound TCP to the agent port only from remote,
// which is the hub's IP once paired, or "localsubnet" before that. The rule
// applies on every network profile because many home networks are marked
// Public by Windows; the remote-address scope is what keeps it narrow.
func configureFirewall(exe string, port int, remote string) {
	removeFirewall()
	cmd := exec.Command("netsh", "advfirewall", "firewall", "add", "rule",
		"name="+firewallRuleName,
		"dir=in",
		"action=allow",
		"program="+exe,
		"protocol=TCP",
		fmt.Sprintf("localport=%d", port),
		"remoteip="+remote,
		"enable=yes",
		"profile=any",
	)
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	if out, err := cmd.CombinedOutput(); err != nil {
		agent.Logf("service: firewall rule: %v (%s)", err, out)
		return
	}
	agent.Logf("service: firewall allows TCP %d from %s", port, remote)
}

func removeFirewall() {
	cmd := exec.Command("netsh", "advfirewall", "firewall", "delete", "rule", "name="+firewallRuleName)
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	_ = cmd.Run()
}
