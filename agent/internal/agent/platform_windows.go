//go:build windows

package agent

import (
	"fmt"
	"os"
	"os/exec"
	"syscall"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

var (
	user32                        = windows.NewLazySystemDLL("user32.dll")
	procOpenInputDesktop          = user32.NewProc("OpenInputDesktop")
	procOpenDesktopW              = user32.NewProc("OpenDesktopW")
	procOpenWindowStationW        = user32.NewProc("OpenWindowStationW")
	procSetProcessWindowStation   = user32.NewProc("SetProcessWindowStation")
	procGetProcessWindowStation   = user32.NewProc("GetProcessWindowStation")
	procGetThreadDesktop          = user32.NewProc("GetThreadDesktop")
	procCloseDesktop              = user32.NewProc("CloseDesktop")
	procCloseWindowStation        = user32.NewProc("CloseWindowStation")
	procGetUserObjectInformationW = user32.NewProc("GetUserObjectInformationW")
	procSetThreadDesktop          = user32.NewProc("SetThreadDesktop")
	procSendInput                 = user32.NewProc("SendInput")
	procVkKeyScanW                = user32.NewProc("VkKeyScanW")
	procMapVirtualKeyW            = user32.NewProc("MapVirtualKeyW")

	powrprof            = windows.NewLazySystemDLL("powrprof.dll")
	procSetSuspendState = powrprof.NewProc("SetSuspendState")

	kernel32                         = windows.NewLazySystemDLL("kernel32.dll")
	procWTSGetActiveConsoleSessionId = kernel32.NewProc("WTSGetActiveConsoleSessionId")
	procPeekNamedPipe                = kernel32.NewProc("PeekNamedPipe")
	procSetThreadExecutionState      = kernel32.NewProc("SetThreadExecutionState")

	wtsapi32                       = windows.NewLazySystemDLL("wtsapi32.dll")
	procWTSQuerySessionInformation = wtsapi32.NewProc("WTSQuerySessionInformationW")
	procWTSFreeMemory              = wtsapi32.NewProc("WTSFreeMemory")
)

const (
	uoIObjectName    = 2
	inputKeyboard    = 1
	inputMouse       = 0
	keyeventfKeyup   = 0x0002
	keyeventfUnicode = 0x0004

	mouseeventfMove      = 0x0001
	mouseeventfLeftDown  = 0x0002
	mouseeventfLeftUp    = 0x0004
	mouseeventfAbsolute  = 0x8000

	wtsSessionInfoEx = 25

	// MSDN WTSINFOEX_LEVEL1 SessionFlags
	wtsSessionStateLock   = 0x00000000
	wtsSessionStateUnlock = 0x00000001
)

// inputKeyboard64 matches sizeof(INPUT)==40 on Windows amd64.
type inputKeyboard64 struct {
	Type      uint32
	_pad0     uint32
	WVk       uint16
	WScan     uint16
	DwFlags   uint32
	Time      uint32
	ExtraInfo uint64
	_pad1     [8]byte
}

// inputMouse64 matches sizeof(INPUT)==40 on Windows amd64.
type inputMouse64 struct {
	Type      uint32
	_pad0     uint32
	Dx        int32
	Dy        int32
	MouseData uint32
	DwFlags   uint32
	Time      uint32
	ExtraInfo uint64
}

func detectLockOS() (bool, string) {
	// Prefer WTS session flags — works from a Windows service (Session 0).
	// OpenInputDesktop often fails in services and must NOT be treated as locked.
	if locked, ok := sessionLockedWTS(); ok {
		if locked {
			return true, "locked"
		}
		return false, "unlocked"
	}

	h, _, _ := procOpenInputDesktop.Call(0, 0, 0x02000000) // MAXIMUM_ALLOWED
	if h == 0 {
		return false, "unknown"
	}
	defer procCloseDesktop.Call(h)

	var needed uint32
	buf := make([]uint16, 256)
	ret, _, _ := procGetUserObjectInformationW.Call(
		h,
		uoIObjectName,
		uintptr(unsafe.Pointer(&buf[0])),
		uintptr(len(buf)*2),
		uintptr(unsafe.Pointer(&needed)),
	)
	if ret == 0 {
		return false, "unknown"
	}
	name := windows.UTF16ToString(buf)
	if name == "Winlogon" || name == "Disconnect" {
		return true, "locked"
	}
	return false, "unlocked"
}

func sessionLockedWTS() (locked bool, ok bool) {
	sessionID, _, _ := procWTSGetActiveConsoleSessionId.Call()
	if sessionID == 0xFFFFFFFF {
		return false, false
	}

	var buf uintptr
	var bytes uint32
	r, _, _ := procWTSQuerySessionInformation.Call(
		0, // WTS_CURRENT_SERVER_HANDLE
		sessionID,
		uintptr(wtsSessionInfoEx),
		uintptr(unsafe.Pointer(&buf)),
		uintptr(unsafe.Pointer(&bytes)),
	)
	if r == 0 || buf == 0 {
		return false, false
	}
	defer procWTSFreeMemory.Call(buf)

	// WTSINFOEX: DWORD Level; then WTSINFOEX_LEVEL1 union payload.
	// Layout (amd64): Level(4) + pad(4) + SessionId(4) + SessionState(4) + SessionFlags(4) ...
	type wtsInfoExHeader struct {
		Level        uint32
		_pad         uint32
		SessionId    uint32
		SessionState uint32
		SessionFlags uint32
	}
	if bytes < uint32(unsafe.Sizeof(wtsInfoExHeader{})) {
		return false, false
	}
	info := (*wtsInfoExHeader)(unsafe.Pointer(buf))
	if info.Level != 1 {
		return false, false
	}

	switch info.SessionFlags {
	case wtsSessionStateLock:
		return true, true
	case wtsSessionStateUnlock:
		return false, true
	default:
		// Some builds inverted the flags historically — treat unknown as not-ok
		// so callers can fall back.
		return false, false
	}
}

func sleepOS(mode string) error {
	switch mode {
	case "hibernate":
		cmd := exec.Command("shutdown", "/h")
		cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
		if err := cmd.Start(); err != nil {
			r, _, callErr := procSetSuspendState.Call(1, 0, 0)
			if r == 0 {
				return fmt.Errorf("hibernate failed: %v / %v", err, callErr)
			}
		}
		return nil
	default:
		r, _, callErr := procSetSuspendState.Call(0, 0, 0)
		if r == 0 {
			cmd := exec.Command("rundll32.exe", "powrprof.dll,SetSuspendState", "0,1,0")
			cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
			if err := cmd.Run(); err != nil {
				return fmt.Errorf("sleep failed: %v / %v", callErr, err)
			}
		}
		return nil
	}
}

func sendUnicodeString(s string) error {
	for i, r := range s {
		var err error
		if r <= 0x7f {
			err = sendASCIIRune(r)
		} else {
			err = sendUnicode(uint16(r), false)
			if err == nil {
				err = sendUnicode(uint16(r), true)
			}
		}
		if err != nil {
			return fmt.Errorf("char[%d]: %w", i, err)
		}
		time.Sleep(45 * time.Millisecond)
	}
	return nil
}

func sendASCIIRune(r rune) error {
	ret, _, _ := procVkKeyScanW.Call(uintptr(uint16(r)))
	if ret == 0xFFFFFFFF || ret == 0xFFFF {
		// Fallback to unicode
		if err := sendUnicode(uint16(r), false); err != nil {
			return err
		}
		return sendUnicode(uint16(r), true)
	}
	vk := uint16(ret & 0xff)
	shiftState := byte((ret >> 8) & 0xff)
	needShift := shiftState&1 != 0

	if needShift {
		if err := sendKeyDown(0x10); err != nil { // VK_SHIFT
			return err
		}
	}
	err := sendVirtualKey(vk)
	if needShift {
		_ = sendKeyUp(0x10)
	}
	return err
}

func sendUnicode(scan uint16, up bool) error {
	var flags uint32 = keyeventfUnicode
	if up {
		flags |= keyeventfKeyup
	}
	in := inputKeyboard64{
		Type:    inputKeyboard,
		WScan:   scan,
		DwFlags: flags,
	}
	return sendInputRetry(unsafe.Pointer(&in), unsafe.Sizeof(in), "unicode")
}

func sendVirtualKey(vk uint16) error {
	if err := sendKeyDown(vk); err != nil {
		return err
	}
	return sendKeyUp(vk)
}

func sendKeyDown(vk uint16) error {
	scan, _, _ := procMapVirtualKeyW.Call(uintptr(vk), 0) // MAPVK_VK_TO_VSC
	in := inputKeyboard64{Type: inputKeyboard, WVk: vk, WScan: uint16(scan)}
	return sendInputRetry(unsafe.Pointer(&in), unsafe.Sizeof(in), "keydown")
}

func sendKeyUp(vk uint16) error {
	scan, _, _ := procMapVirtualKeyW.Call(uintptr(vk), 0)
	in := inputKeyboard64{Type: inputKeyboard, WVk: vk, WScan: uint16(scan), DwFlags: keyeventfKeyup}
	return sendInputRetry(unsafe.Pointer(&in), unsafe.Sizeof(in), "keyup")
}

// wakeDisplay powers the monitor back on. This needs no desktop access, so it
// works even while SendInput is still being denied.
func wakeDisplay() {
	const (
		esContinuous      = 0x80000000
		esDisplayRequired = 0x00000002
	)
	procSetThreadExecutionState.Call(uintptr(esContinuous | esDisplayRequired))
	procSetThreadExecutionState.Call(uintptr(esContinuous))
}

func sendInputRetry(ptr unsafe.Pointer, size uintptr, what string) error {
	var last error
	for attempt := 0; attempt < 3; attempt++ {
		n, _, err := procSendInput.Call(1, uintptr(ptr), size)
		if n != 0 {
			return nil
		}
		last = err
		time.Sleep(200 * time.Millisecond)
	}
	return fmt.Errorf("SendInput %s: %v", what, last)
}

func currentUsernameOS() string {
	if u := os.Getenv("USERNAME"); u != "" {
		return u
	}
	return ""
}
