//go:build windows

package config

import (
	"fmt"

	"golang.org/x/sys/windows"
)

// SYSTEM and Administrators get full control; inheritance from
// %ProgramData% (which lets every local user read) is cut off.
const privateDirSDDL = "D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)"

func restrictDir(dir string) error {
	sd, err := windows.SecurityDescriptorFromString(privateDirSDDL)
	if err != nil {
		return fmt.Errorf("build ACL: %w", err)
	}
	dacl, _, err := sd.DACL()
	if err != nil {
		return fmt.Errorf("read ACL: %w", err)
	}
	// SetNamedSecurityInfo also re-applies inheritance to files already inside.
	err = windows.SetNamedSecurityInfo(dir, windows.SE_FILE_OBJECT,
		windows.DACL_SECURITY_INFORMATION|windows.PROTECTED_DACL_SECURITY_INFORMATION,
		nil, nil, dacl, nil)
	if err != nil {
		return fmt.Errorf("restrict %s: %w", dir, err)
	}
	return nil
}
