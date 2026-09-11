package agent

import (
	"fmt"
	"os"
	"path/filepath"
	"runtime/debug"
	"sync"
	"time"
)

var (
	logMu   sync.Mutex
	logPath string
)

func SetLogPath(path string) {
	logMu.Lock()
	defer logMu.Unlock()
	logPath = path
}

// SafeGo runs fn in a goroutine, logging any panic instead of letting it take
// the whole service down with it.
func SafeGo(name string, fn func()) {
	go func() {
		defer func() {
			if v := recover(); v != nil {
				Logf("PANIC in %s: %v\n%s", name, v, debug.Stack())
			}
		}()
		fn()
	}()
}

func Logf(format string, args ...any) {
	msg := fmt.Sprintf(format, args...)
	line := time.Now().Format(time.RFC3339) + " " + msg + "\n"
	fmt.Print(line)

	logMu.Lock()
	path := logPath
	logMu.Unlock()
	if path == "" {
		return
	}
	_ = os.MkdirAll(filepath.Dir(path), 0o755)
	f, err := os.OpenFile(path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		return
	}
	defer f.Close()
	_, _ = f.WriteString(line)
}
