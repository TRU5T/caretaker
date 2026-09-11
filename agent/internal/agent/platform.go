package agent

// DetectLockState, Sleep, Unlock, CurrentUsername are implemented per-OS.

func Sleep(mode string) error {
	return sleepOS(mode)
}

func Unlock(secret, kind string) error {
	return unlockOS(secret, kind)
}

func PrepareUnlock() error {
	return unlockOS("", "prepare")
}

func DetectLockState() (locked bool, state string) {
	return detectLockOS()
}

func CurrentUsername() string {
	return currentUsernameOS()
}
