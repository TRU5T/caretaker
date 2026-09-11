//go:build windows

package svc

import (
	"os/exec"
	"syscall"

	"github.com/TRU5T/caretaker/agent/internal/agent"
)

const firewallRuleName = "Caretaker Agent"

func configureFirewall(exe string) {
	removeFirewall()
	cmd := exec.Command("netsh", "advfirewall", "firewall", "add", "rule",
		"name="+firewallRuleName,
		"dir=in",
		"action=allow",
		"program="+exe,
		"enable=yes",
		"profile=any",
	)
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	if out, err := cmd.CombinedOutput(); err != nil {
		agent.Logf("service: firewall rule: %v (%s)", err, out)
	}
}

func removeFirewall() {
	cmd := exec.Command("netsh", "advfirewall", "firewall", "delete", "rule", "name="+firewallRuleName)
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	_ = cmd.Run()
}
