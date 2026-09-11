//go:build windows

package svc

import (
	"os/exec"
	"syscall"

	"github.com/TRU5T/caretaker/agent/internal/agent"
)

// configureRestartOnFailure tells the SCM to bring the agent back up if the
// process dies, so a crash cannot leave the PC unreachable from the hub.
func configureRestartOnFailure(name string) {
	cmd := exec.Command("sc.exe", "failure", name, "reset=", "86400",
		"actions=", "restart/5000/restart/10000/restart/30000")
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	if out, err := cmd.CombinedOutput(); err != nil {
		agent.Logf("service: could not set restart-on-failure: %v (%s)", err, out)
	}
}
