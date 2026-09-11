//go:build !windows

package svc

// configureRestartOnFailure is a Windows SCM concept; elsewhere it is a no-op.
func configureRestartOnFailure(string) {}
