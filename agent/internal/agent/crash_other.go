//go:build !windows

package agent

// RedirectCrashOutput is Windows-only; other platforms keep normal stderr.
func RedirectCrashOutput(string) error { return nil }
