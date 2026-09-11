//go:build !windows

package setup

import "fmt"

// ShouldAutoLaunch is only meaningful on Windows (double-clicked installer).
func ShouldAutoLaunch() bool { return false }

// Run is Windows-only.
func Run(uninstall bool) error {
	_ = uninstall
	return fmt.Errorf("setup is only supported on Windows")
}
