//go:build !windows

package config

import "os"

func restrictDir(dir string) error {
	return os.Chmod(dir, 0o700)
}
