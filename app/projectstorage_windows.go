package main

import (
	"context"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"syscall"
	"unsafe"
)

var storageFileInformation = syscall.NewLazyDLL("kernel32.dll").NewProc("GetFileInformationByHandleEx")

// AllocationSize reflects the filesystem's actual storage for compressed and
// sparse files too; summing logical lengths would misreport their disk usage.
func projectAllocatedBytes(ctx context.Context, root string) (int64, error) {
	info, err := os.Lstat(root)
	if err != nil {
		return 0, err
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return 0, fmt.Errorf("项目目录不可用")
	}
	type fileIdentity struct{ volume, high, low uint32 }
	seen := map[fileIdentity]bool{}
	var total int64
	err = filepath.WalkDir(root, func(path string, entry fs.DirEntry, walkErr error) error {
		if err := ctx.Err(); err != nil {
			return err
		}
		if walkErr != nil {
			return walkErr
		}
		if !entry.Type().IsRegular() {
			return nil
		}
		name, err := syscall.UTF16PtrFromString(path)
		if err != nil {
			return err
		}
		handle, err := syscall.CreateFile(name, 0, syscall.FILE_SHARE_READ|syscall.FILE_SHARE_WRITE|syscall.FILE_SHARE_DELETE, nil, syscall.OPEN_EXISTING, 0, 0)
		if err != nil {
			return err
		}
		defer syscall.CloseHandle(handle)
		var identity syscall.ByHandleFileInformation
		if err = syscall.GetFileInformationByHandle(handle, &identity); err != nil {
			return err
		}
		key := fileIdentity{identity.VolumeSerialNumber, identity.FileIndexHigh, identity.FileIndexLow}
		if seen[key] {
			return nil
		}
		var standard struct {
			AllocationSize int64
			EndOfFile      int64
			NumberOfLinks  uint32
			DeletePending  byte
			Directory      byte
		}
		// FileStandardInfo is class 1 in FILE_INFO_BY_HANDLE_CLASS.
		ok, _, callErr := storageFileInformation.Call(uintptr(handle), 1, uintptr(unsafe.Pointer(&standard)), unsafe.Sizeof(standard))
		if ok == 0 {
			return callErr
		}
		seen[key] = true
		total += standard.AllocationSize
		return nil
	})
	return total, err
}
