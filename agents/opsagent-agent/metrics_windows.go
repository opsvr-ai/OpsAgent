//go:build windows

package main

import (
	"syscall"
	"unsafe"
)

var (
	kernel32           = syscall.NewLazyDLL("kernel32.dll")
	globalMemoryStatus = kernel32.NewProc("GlobalMemoryStatusEx")
	getDiskFreeSpaceEx = kernel32.NewProc("GetDiskFreeSpaceExW")
)

type memoryStatusEx struct {
	Length               uint32
	MemoryLoad           uint32
	TotalPhys            uint64
	AvailPhys            uint64
	TotalPageFile        uint64
	AvailPageFile        uint64
	TotalVirtual         uint64
	AvailVirtual         uint64
	AvailExtendedVirtual uint64
}

func hostMetrics() map[string]any {
	metrics := map[string]any{}
	var memory memoryStatusEx
	memory.Length = uint32(unsafe.Sizeof(memory))
	if ok, _, _ := globalMemoryStatus.Call(uintptr(unsafe.Pointer(&memory))); ok != 0 {
		metrics["memTotalGB"] = float64(memory.TotalPhys) / 1024 / 1024 / 1024
		metrics["memAvailableGB"] = float64(memory.AvailPhys) / 1024 / 1024 / 1024
		metrics["memLoadPct"] = memory.MemoryLoad
	}

	path, err := syscall.UTF16PtrFromString("C:\\")
	if err == nil {
		var freeAvailable, total, free uint64
		if ok, _, _ := getDiskFreeSpaceEx.Call(
			uintptr(unsafe.Pointer(path)),
			uintptr(unsafe.Pointer(&freeAvailable)),
			uintptr(unsafe.Pointer(&total)),
			uintptr(unsafe.Pointer(&free)),
		); ok != 0 {
			metrics["diskTotalGB"] = float64(total) / 1024 / 1024 / 1024
			metrics["diskFreeGB"] = float64(freeAvailable) / 1024 / 1024 / 1024
		}
	}
	return metrics
}
