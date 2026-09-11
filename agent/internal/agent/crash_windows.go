//go:build windows

package agent

import (
	"os"
	"path/filepath"

	"golang.org/x/sys/windows"
)

// RedirectCrashOutput points the process stderr handle at a file.
//
// A Windows service has no console, so Go runtime output — unrecovered panics,
// fatal errors, access violations — is written to a handle that goes nowhere and
// the process just vanishes. The runtime resolves STD_ERROR_HANDLE on each
// write, so redirecting it here means those crashes end up on disk.
func RedirectCrashOutput(path string) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	f, err := os.OpenFile(path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	// Deliberately not closed: it must outlive this call to catch a crash.
	if err := windows.SetStdHandle(windows.STD_ERROR_HANDLE, windows.Handle(f.Fd())); err != nil {
		f.Close()
		return err
	}
	os.Stderr = f
	return nil
}
