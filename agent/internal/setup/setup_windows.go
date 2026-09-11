//go:build windows

package setup

import (
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"
	"unsafe"

	"github.com/kardianos/service"
	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"

	"github.com/TRU5T/caretaker/agent/internal/agent"
	"github.com/TRU5T/caretaker/agent/internal/config"
	"github.com/TRU5T/caretaker/agent/internal/svc"
)

const (
	uninstallKey = `SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\CaretakerAgent`
	idyes        = 6
)

// ShouldAutoLaunch is true when the user double-clicked the .exe (Explorer
// allocated a fresh console for this process alone). Command Prompt, the
// Windows service, and `caretaker-agent run` keep the existing CLI behavior.
func ShouldAutoLaunch() bool {
	if !service.Interactive() {
		return false
	}
	kernel32 := windows.NewLazySystemDLL("kernel32.dll")
	proc := kernel32.NewProc("GetConsoleProcessList")
	var pids [4]uint32
	n, _, _ := proc.Call(uintptr(unsafe.Pointer(&pids[0])), uintptr(len(pids)))
	return n <= 1
}

// Run installs (or uninstalls) the agent with UAC, a Program Files copy, and
// a Windows service — no Command Prompt required.
func Run(uninstall bool) error {
	hideConsole()
	if err := ensureElevated(uninstall); err != nil {
		if errors.Is(err, errElevationCancelled) {
			return nil
		}
		showErr(err)
		return err
	}
	if uninstall {
		if err := uninstallApp(); err != nil {
			showErr(err)
			return err
		}
		return nil
	}
	upgraded, err := installApp()
	if err != nil {
		showErr(err)
		return err
	}
	verb := "installed"
	if upgraded {
		verb = "updated"
	}
	info("Caretaker Agent",
		"Caretaker Agent "+agent.Version+" is "+verb+" and running.\n\n"+
			"Go back to the Hub in your browser → Setup, and tap Pair when this PC appears under Nearby PCs.")
	return nil
}

var errElevationCancelled = errors.New("administrator approval was declined")

func ensureElevated(uninstall bool) error {
	if windows.GetCurrentProcessToken().IsElevated() {
		return nil
	}
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	verb, _ := windows.UTF16PtrFromString("runas")
	file, _ := windows.UTF16PtrFromString(exe)
	args := "setup"
	if uninstall {
		args = "setup --uninstall"
	}
	argv, _ := windows.UTF16PtrFromString(args)
	dir, _ := windows.UTF16PtrFromString(filepath.Dir(exe))
	err = windows.ShellExecute(0, verb, file, argv, dir, windows.SW_SHOWNORMAL)
	if err != nil {
		if errno, ok := err.(syscall.Errno); ok && errno == windows.ERROR_CANCELLED {
			return errElevationCancelled
		}
		return fmt.Errorf("could not request administrator permission: %w", err)
	}
	os.Exit(0)
	return nil
}

func installApp() (upgraded bool, err error) {
	src, err := os.Executable()
	if err != nil {
		return false, err
	}
	src, err = filepath.EvalSymlinks(src)
	if err != nil {
		return false, err
	}
	dir := installDir()
	dest := filepath.Join(dir, "caretaker-agent.exe")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return false, fmt.Errorf("create %s: %w", dir, err)
	}

	svc.StopIfRunning()
	time.Sleep(300 * time.Millisecond)

	same, err := sameFile(src, dest)
	if err != nil {
		return false, err
	}
	if !same {
		if _, statErr := os.Stat(dest); statErr == nil {
			upgraded = true
		}
		if err := copyWithRetry(src, dest); err != nil {
			return false, fmt.Errorf("copy to %s: %w", dest, err)
		}
	}

	if err := svc.InstallAndStart(dest); err != nil {
		return false, fmt.Errorf("start service: %w", err)
	}
	if err := writeUninstallKey(dir, dest); err != nil {
		agent.Logf("setup: uninstall registry: %v", err)
	}
	return upgraded, nil
}

func uninstallApp() error {
	ret, _ := windows.MessageBox(0,
		windows.StringToUTF16Ptr("Remove Caretaker Agent from this PC? The Hub will no longer be able to sleep or unlock it."),
		windows.StringToUTF16Ptr("Uninstall Caretaker Agent"),
		windows.MB_YESNO|windows.MB_ICONQUESTION|windows.MB_SETFOREGROUND)
	if ret != idyes {
		return nil
	}
	if err := svc.UninstallService(); err != nil {
		return err
	}
	_ = registry.DeleteKey(registry.LOCAL_MACHINE, uninstallKey)

	dir := installDir()
	_ = os.RemoveAll(filepath.Dir(config.DefaultPath()))

	exe, err := os.Executable()
	if err != nil {
		return err
	}
	exe, _ = filepath.EvalSymlinks(exe)
	inInstallDir := strings.EqualFold(filepath.Dir(exe), dir)

	if !inInstallDir {
		_ = os.RemoveAll(dir)
		info("Caretaker Agent", "Caretaker Agent was removed.")
		return nil
	}

	// Cannot delete the running installer; finish after this process exits.
	cmd := exec.Command("cmd.exe", "/C",
		fmt.Sprintf(`ping 127.0.0.1 -n 2 >nul & rmdir /s /q "%s"`, dir))
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("schedule file removal: %w", err)
	}
	info("Caretaker Agent", "Caretaker Agent was removed.")
	return nil
}

func installDir() string {
	base := os.Getenv("ProgramFiles")
	if base == "" {
		base = `C:\Program Files`
	}
	return filepath.Join(base, "Caretaker")
}

func writeUninstallKey(dir, exe string) error {
	k, _, err := registry.CreateKey(registry.LOCAL_MACHINE, uninstallKey, registry.ALL_ACCESS)
	if err != nil {
		return err
	}
	defer k.Close()
	_ = k.SetStringValue("DisplayName", "Caretaker Agent")
	_ = k.SetStringValue("Publisher", "Caretaker")
	_ = k.SetStringValue("DisplayVersion", agent.Version)
	_ = k.SetStringValue("InstallLocation", dir)
	_ = k.SetStringValue("UninstallString", `"`+exe+`" setup --uninstall`)
	_ = k.SetDWordValue("NoModify", 1)
	_ = k.SetDWordValue("NoRepair", 1)
	if fi, err := os.Stat(exe); err == nil {
		_ = k.SetDWordValue("EstimatedSize", uint32(fi.Size()/1024))
	}
	return nil
}

func copyWithRetry(src, dst string) error {
	var err error
	for i := 0; i < 12; i++ {
		err = copyFile(src, dst)
		if err == nil {
			_ = os.Remove(dst + ":Zone.Identifier")
			return nil
		}
		time.Sleep(250 * time.Millisecond)
	}
	return err
}

func copyFile(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	tmp := dst + ".new"
	out, err := os.OpenFile(tmp, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o755)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		_ = os.Remove(tmp)
		return err
	}
	if err := out.Close(); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	_ = os.Remove(dst)
	if err := os.Rename(tmp, dst); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	return nil
}

func sameFile(a, b string) (bool, error) {
	absA, err := filepath.Abs(a)
	if err != nil {
		return false, err
	}
	absB, err := filepath.Abs(b)
	if err != nil {
		return false, err
	}
	return strings.EqualFold(absA, absB), nil
}

func hideConsole() {
	kernel32 := windows.NewLazySystemDLL("kernel32.dll")
	user32 := windows.NewLazySystemDLL("user32.dll")
	hwnd, _, _ := kernel32.NewProc("GetConsoleWindow").Call()
	if hwnd != 0 {
		user32.NewProc("ShowWindow").Call(hwnd, uintptr(windows.SW_HIDE))
	}
}

func info(title, text string) {
	_, _ = windows.MessageBox(0,
		windows.StringToUTF16Ptr(text),
		windows.StringToUTF16Ptr(title),
		windows.MB_OK|windows.MB_ICONINFORMATION|windows.MB_SETFOREGROUND)
}

func showErr(err error) {
	_, _ = windows.MessageBox(0,
		windows.StringToUTF16Ptr(err.Error()),
		windows.StringToUTF16Ptr("Caretaker Agent"),
		windows.MB_OK|windows.MB_ICONERROR|windows.MB_SETFOREGROUND)
}
