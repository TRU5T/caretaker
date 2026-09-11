//go:build windows

package agent

import (
	"fmt"
	"os"
	"strings"
	"sync"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

var (
	advapi32              = windows.NewLazySystemDLL("advapi32.dll")
	procCreateProcessAsUserW = advapi32.NewProc("CreateProcessAsUserW")
	procDuplicateTokenEx     = advapi32.NewProc("DuplicateTokenEx")
	procSetTokenInformation  = advapi32.NewProc("SetTokenInformation")

	procWTSQueryUserToken = wtsapi32.NewProc("WTSQueryUserToken")
)

const (
	tokenPrimary            = 1
	securityImpersonation   = 2
	createUnicodeEnvironment = 0x00000400
	createNoWindow           = 0x08000000
	startfUseStdHandles      = 0x00000100
	startfUseShowWindow      = 0x00000001
	swHide                   = 0
)

// unlockOS performs unlock. When running as a Session-0 service, skip in-process
// input (it can partially type then fail and double-fire via the helper).
// kind "prepare" only dismisses the lock wallpaper so the PIN/password field shows.
func unlockOS(secret, kind string) error {
	exe, err := os.Executable()
	if err != nil {
		return fmt.Errorf("resolve agent exe: %w", err)
	}

	unlockMu.Lock()
	defer unlockMu.Unlock()

	useHelper := runningInSession0()
	if kind == "prepare" {
		Logf("unlock: prepare start helper=%v", useHelper)
		if !useHelper {
			if err := prepareInject(); err == nil {
				Logf("unlock: prepare ok (in-process)")
				return nil
			}
			Logf("unlock: prepare in-process failed: %v — trying helper", err)
		}
		err = runUnlockHelperInConsoleSession(exe, "", "prepare")
		if err != nil {
			Logf("unlock: prepare helper failed: %v", err)
		} else {
			Logf("unlock: prepare helper ok")
		}
		return err
	}

	Logf("unlock: start kind=%s secretLen=%d helper=%v", kind, len(secret), useHelper)
	if !useHelper {
		if err := unlockInject(secret); err == nil {
			Logf("unlock: ok (in-process)")
			return nil
		}
		Logf("unlock: in-process failed: %v — trying helper", err)
	}

	err = runUnlockHelperInConsoleSession(exe, secret, kind)
	if err != nil {
		Logf("unlock: helper failed: %v", err)
	} else {
		Logf("unlock: helper ok")
	}
	return err
}

var unlockMu sync.Mutex

func runningInSession0() bool {
	var sid uint32
	pid := windows.GetCurrentProcessId()
	if err := windows.ProcessIdToSessionId(pid, &sid); err != nil {
		return true // assume service
	}
	return sid == 0
}

// UnlockHelper is the interactive-session entrypoint (subcommand unlock-helper).
func UnlockHelper(secret string) error {
	return unlockInject(secret)
}

// UnlockHelperPrepare only pokes the lock screen (no credentials).
func UnlockHelperPrepare() error {
	return prepareInject()
}

// unlockInject: wake the credential UI with one key tap, pause, type, Enter.
func unlockInject(secret string) error {
	if locked, ok := sessionLockedWTS(); ok && !locked {
		Logf("unlock-helper: session already unlocked, nothing to type")
		return nil
	}
	if err := wakeCredentialUI(); err != nil {
		return err
	}

	// If the input desktop switches mid-word some characters land on the old
	// desktop, so clear the field and retype rather than continuing.
	var lastErr error
	for attempt := 0; attempt < 3; attempt++ {
		_ = attachInputDesktop()
		_ = clearCredentialField()
		time.Sleep(250 * time.Millisecond)
		Logf("unlock-helper: typing secret (%d chars)", len(secret))
		if lastErr = sendUnicodeString(secret); lastErr != nil {
			Logf("unlock-helper: typing interrupted: %v — retrying", lastErr)
			continue
		}
		time.Sleep(250 * time.Millisecond)
		Logf("unlock-helper: pressing Enter")
		return sendVirtualKey(0x0D)
	}
	return lastErr
}

// clearCredentialField selects all and deletes, so a partially typed secret
// does not get submitted.
func clearCredentialField() error {
	if err := sendKeyDown(0x11); err != nil { // VK_CONTROL
		return err
	}
	err := sendVirtualKey(0x41) // A
	_ = sendKeyUp(0x11)
	if err != nil {
		return err
	}
	time.Sleep(80 * time.Millisecond)
	return sendVirtualKey(0x08) // VK_BACK
}

func prepareInject() error {
	return wakeCredentialUI()
}

// wakeCredentialUI turns the display on, then taps a key until the password
// field is actually in front.
//
// On Windows 10/11 the lock screen you first see is LockApp on the Default
// desktop; the password field lives on the separate Winlogon desktop. A key tap
// dismisses LockApp and triggers the switch, but modifier keys like Shift are
// ignored — so tap Space, and keep tapping until the switch happens, since
// SendInput is only accepted by whichever desktop currently owns input.
func wakeCredentialUI() error {
	if err := ensureWindowStation(); err != nil {
		Logf("unlock-helper: ensureWindowStation: %v (continuing)", err)
	}
	wakeDisplay()

	var lastErr error
	for tap := 0; tap < 20; tap++ { // up to ~10s
		if inputDesktopName() == "Winlogon" {
			if err := attachInputDesktop(); err == nil {
				Logf("unlock-helper: credential UI ready after %d tap(s)", tap)
				time.Sleep(600 * time.Millisecond) // let the field take focus
				return nil
			}
		}
		if err := attachInputDesktop(); err != nil {
			lastErr = err
		} else if err := sendVirtualKey(0x20); err != nil { // VK_SPACE
			lastErr = err
		}
		time.Sleep(500 * time.Millisecond)
	}

	// Type anyway: the field may be up even if the desktop never reported it.
	_ = attachInputDesktop()
	Logf("unlock-helper: credential UI never appeared (last error: %v), trying %q anyway", lastErr, attachedDesktop)
	return nil
}

func inputDesktopName() string {
	const desktopAll = uintptr(0x000001FF)
	h, _, _ := procOpenInputDesktop.Call(0, 0, desktopAll)
	if h == 0 {
		return ""
	}
	name := desktopName(h)
	procCloseDesktop.Call(h)
	return name
}

func ensureWindowStation() error {
	name, err := windows.UTF16PtrFromString("winsta0")
	if err != nil {
		return err
	}
	const maxAllowed = 0x02000000
	h, _, callErr := procOpenWindowStationW.Call(uintptr(unsafe.Pointer(name)), 0, maxAllowed)
	if h == 0 {
		return fmt.Errorf("OpenWindowStation(winsta0): %v", callErr)
	}
	r, _, setErr := procSetProcessWindowStation.Call(h)
	if r == 0 {
		procCloseWindowStation.Call(h)
		return fmt.Errorf("SetProcessWindowStation: %v", setErr)
	}
	Logf("unlock-helper: SetProcessWindowStation(winsta0) ok")
	return nil
}

var attachedDesktop string

// attachInputDesktop points this thread at the desktop that currently owns
// input. Called repeatedly, so it only logs when the desktop actually changes.
func attachInputDesktop() error {
	// DESKTOP_CREATEMENU | CREATEWINDOW | ENUMERATE | HOOKCONTROL | JOURNALPLAYBACK |
	// JOURNALRECORD | READOBJECTS | SWITCHDESKTOP | WRITEOBJECTS
	const desktopAll = uintptr(0x000001FF)

	h, _, callErr := procOpenInputDesktop.Call(0, 0, desktopAll)
	if h == 0 {
		return fmt.Errorf("OpenInputDesktop: %v", callErr)
	}
	name := desktopName(h)
	if name == attachedDesktop {
		procCloseDesktop.Call(h)
		return nil
	}
	if r, _, e := procSetThreadDesktop.Call(h); r == 0 {
		procCloseDesktop.Call(h)
		return fmt.Errorf("SetThreadDesktop(%s): %v", name, e)
	}
	Logf("unlock-helper: attached to input desktop %q", name)
	attachedDesktop = name
	return nil
}

func desktopName(h uintptr) string {
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
		return "?"
	}
	return windows.UTF16ToString(buf)
}

func runUnlockHelperInConsoleSession(exe, secret, kind string) error {
	sessionID, _, _ := procWTSGetActiveConsoleSessionId.Call()
	if sessionID == 0xFFFFFFFF {
		return fmt.Errorf("no active console session")
	}

	token, source, err := tokenForSession(uint32(sessionID))
	if err != nil {
		return err
	}
	defer windows.CloseHandle(token)
	Logf("unlock: using %s token for session %d", source, sessionID)

	// The lock screen is owned by the Winlogon desktop; that is the only place
	// SendInput reaches the password field.
	return spawnUnlockHelper(exe, secret, kind, token, uint32(sessionID), `winsta0\Winlogon`)
}

func spawnUnlockHelper(exe, secret, kind string, token windows.Handle, sessionID uint32, desktop string) error {
	var sa windows.SecurityAttributes
	sa.Length = uint32(unsafe.Sizeof(sa))
	sa.InheritHandle = 1

	var stdinR, stdinW windows.Handle
	if err := windows.CreatePipe(&stdinR, &stdinW, &sa, 0); err != nil {
		return fmt.Errorf("CreatePipe: %w", err)
	}
	defer windows.CloseHandle(stdinR)
	defer windows.CloseHandle(stdinW)
	_ = windows.SetHandleInformation(stdinW, windows.HANDLE_FLAG_INHERIT, 0)

	var saErr windows.SecurityAttributes
	saErr.Length = uint32(unsafe.Sizeof(saErr))
	saErr.InheritHandle = 1
	var stderrR, stderrW windows.Handle
	if err := windows.CreatePipe(&stderrR, &stderrW, &saErr, 0); err != nil {
		return fmt.Errorf("CreatePipe stderr: %w", err)
	}
	defer windows.CloseHandle(stderrR)
	defer windows.CloseHandle(stderrW)
	_ = windows.SetHandleInformation(stderrR, windows.HANDLE_FLAG_INHERIT, 0)

	cmdLine := windows.StringToUTF16Ptr(fmt.Sprintf(`"%s" unlock-helper`, exe))

	var si windows.StartupInfo
	si.Cb = uint32(unsafe.Sizeof(si))
	si.Flags = startfUseStdHandles | startfUseShowWindow
	si.ShowWindow = swHide
	si.StdInput = stdinR
	si.StdOutput = stderrW
	si.StdErr = stderrW
	if desktop != "" {
		si.Desktop = windows.StringToUTF16Ptr(desktop)
	}

	var pi windows.ProcessInformation
	const flags = createUnicodeEnvironment | createNoWindow

	Logf("unlock: CreateProcessAsUser session=%d desktop=%q", sessionID, desktop)
	r1, _, callErr := procCreateProcessAsUserW.Call(
		uintptr(token),
		0,
		uintptr(unsafe.Pointer(cmdLine)),
		0,
		0,
		1,
		flags,
		0,
		0,
		uintptr(unsafe.Pointer(&si)),
		uintptr(unsafe.Pointer(&pi)),
	)
	if r1 == 0 {
		return fmt.Errorf("CreateProcessAsUser: %v", callErr)
	}
	defer windows.CloseHandle(pi.Process)
	defer windows.CloseHandle(pi.Thread)
	windows.CloseHandle(stdinR)
	windows.CloseHandle(stderrW)

	payload := kind + "\n" + secret + "\n"
	if _, err := syscallWrite(stdinW, []byte(payload)); err != nil {
		return fmt.Errorf("write secret to helper: %w", err)
	}
	windows.CloseHandle(stdinW)

	event, err := windows.WaitForSingleObject(pi.Process, 45000)
	if err != nil {
		return fmt.Errorf("wait helper: %w", err)
	}
	if event != windows.WAIT_OBJECT_0 {
		_ = windows.TerminateProcess(pi.Process, 1)
		return fmt.Errorf("unlock helper timed out")
	}
	var code uint32
	if err := windows.GetExitCodeProcess(pi.Process, &code); err != nil {
		return err
	}
	if stderrTxt := readAvailable(stderrR); stderrTxt != "" {
		Logf("unlock: helper stderr: %s", strings.TrimSpace(stderrTxt))
	}
	if code != 0 {
		return fmt.Errorf("unlock helper exited with code %d", code)
	}
	return nil
}

func readAvailable(h windows.Handle) string {
	var avail uint32
	r, _, _ := procPeekNamedPipe.Call(uintptr(h), 0, 0, 0, uintptr(unsafe.Pointer(&avail)), 0)
	if r == 0 || avail == 0 {
		return ""
	}
	if avail > 8192 {
		avail = 8192
	}
	buf := make([]byte, avail)
	var read uint32
	if err := windows.ReadFile(h, buf, &read, nil); err != nil {
		return ""
	}
	return string(buf[:read])
}

func syscallWrite(h windows.Handle, b []byte) (int, error) {
	var written uint32
	err := windows.WriteFile(h, b, &written, nil)
	return int(written), err
}

func tokenForSession(sessionID uint32) (windows.Handle, string, error) {
	// Prefer winlogon SYSTEM token in that session (can touch secure desktop).
	if tok, err := winlogonToken(sessionID); err == nil {
		return tok, "winlogon", nil
	} else {
		Logf("unlock: winlogon token unavailable: %v — falling back to user token", err)
	}
	// Fallback: interactive user token
	var userToken windows.Handle
	r, _, err := procWTSQueryUserToken.Call(uintptr(sessionID), uintptr(unsafe.Pointer(&userToken)))
	if r == 0 {
		return 0, "", fmt.Errorf("WTSQueryUserToken: %v (is the agent installed as a service running as LocalSystem?)", err)
	}
	defer windows.CloseHandle(userToken)

	var primary windows.Handle
	r, _, err = procDuplicateTokenEx.Call(
		uintptr(userToken),
		windows.MAXIMUM_ALLOWED,
		0,
		uintptr(securityImpersonation),
		uintptr(tokenPrimary),
		uintptr(unsafe.Pointer(&primary)),
	)
	if r == 0 {
		return 0, "", fmt.Errorf("DuplicateTokenEx: %v", err)
	}
	return primary, "user", nil
}

func winlogonToken(sessionID uint32) (windows.Handle, error) {
	snap, err := windows.CreateToolhelp32Snapshot(windows.TH32CS_SNAPPROCESS, 0)
	if err != nil {
		return 0, err
	}
	defer windows.CloseHandle(snap)

	var pe windows.ProcessEntry32
	pe.Size = uint32(unsafe.Sizeof(pe))
	if err := windows.Process32First(snap, &pe); err != nil {
		return 0, err
	}
	for {
		name := strings.ToLower(windows.UTF16ToString(pe.ExeFile[:]))
		if name == "winlogon.exe" {
			sid, err := processSessionID(pe.ProcessID)
			if err == nil && sid == sessionID {
				return duplicateProcessToken(pe.ProcessID)
			}
		}
		if err := windows.Process32Next(snap, &pe); err != nil {
			break
		}
	}
	return 0, fmt.Errorf("winlogon.exe not found in session %d", sessionID)
}

func processSessionID(pid uint32) (uint32, error) {
	var sid uint32
	err := windows.ProcessIdToSessionId(pid, &sid)
	return sid, err
}

func duplicateProcessToken(pid uint32) (windows.Handle, error) {
	hProc, err := windows.OpenProcess(windows.PROCESS_QUERY_INFORMATION, false, pid)
	if err != nil {
		// Try limited query on newer Windows
		hProc, err = windows.OpenProcess(0x1000, false, pid) // PROCESS_QUERY_LIMITED_INFORMATION
		if err != nil {
			return 0, err
		}
	}
	defer windows.CloseHandle(hProc)

	var tok windows.Token
	err = windows.OpenProcessToken(hProc, windows.TOKEN_DUPLICATE|windows.TOKEN_QUERY|windows.TOKEN_ASSIGN_PRIMARY, &tok)
	if err != nil {
		return 0, err
	}
	defer windows.CloseHandle(windows.Handle(tok))

	var primary windows.Handle
	r, _, callErr := procDuplicateTokenEx.Call(
		uintptr(tok),
		windows.MAXIMUM_ALLOWED,
		0,
		uintptr(securityImpersonation),
		uintptr(tokenPrimary),
		uintptr(unsafe.Pointer(&primary)),
	)
	if r == 0 {
		return 0, callErr
	}

	// Ensure the token is bound to the right session
	sessionID, _, _ := procWTSGetActiveConsoleSessionId.Call()
	sid := uint32(sessionID)
	r, _, callErr = procSetTokenInformation.Call(
		uintptr(primary),
		12, // TokenSessionId
		uintptr(unsafe.Pointer(&sid)),
		unsafe.Sizeof(sid),
	)
	if r == 0 {
		windows.CloseHandle(primary)
		return 0, fmt.Errorf("SetTokenInformation TokenSessionId: %v", callErr)
	}
	return primary, nil
}
