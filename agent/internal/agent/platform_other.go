//go:build !windows

package agent

import (
	"fmt"
	"os"
	"os/user"
)

func detectLockOS() (bool, string) {
	// Non-Windows builds are for hub-side development only.
	return false, "unlocked"
}

func sleepOS(mode string) error {
	return fmt.Errorf("sleep (%s) is only supported on Windows", mode)
}

func unlockOS(secret, kind string) error {
	_ = kind
	return fmt.Errorf("unlock is only supported on Windows")
}

// UnlockHelper is a no-op stub on non-Windows.
func UnlockHelper(secret string) error {
	_ = secret
	return fmt.Errorf("unlock helper is only supported on Windows")
}

func UnlockHelperPrepare() error {
	return fmt.Errorf("unlock helper is only supported on Windows")
}

func currentUsernameOS() string {
	if u, err := user.Current(); err == nil {
		return u.Username
	}
	if u := os.Getenv("USER"); u != "" {
		return u
	}
	return ""
}
