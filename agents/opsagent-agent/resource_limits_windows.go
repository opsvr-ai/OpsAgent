//go:build windows

package main

import (
	"fmt"
	"os"
	"strconv"
	"unsafe"

	"golang.org/x/sys/windows"
)

const (
	jobObjectCpuRateControlEnable  = 0x00000001
	jobObjectCpuRateControlHardCap = 0x00000004
)

type jobObjectCpuRateControlInformation struct {
	ControlFlags uint32
	CpuRate      uint32
}

var agentJobHandle windows.Handle

// applyResourceLimits puts the agent process tree into a Windows Job Object so
// memory and CPU limits also cover child processes started by deployments.
func applyResourceLimits() {
	memoryMB := envInt("OPSAGENT_AGENT_MEMORY_LIMIT_MB")
	cpuPercent := envInt("OPSAGENT_AGENT_CPU_PERCENT")
	if memoryMB <= 0 && cpuPercent <= 0 {
		return
	}
	job, err := windows.CreateJobObject(nil, nil)
	if err != nil {
		fmt.Fprintf(os.Stderr, "agent resource limits: CreateJobObject failed: %v\n", err)
		return
	}
	agentJobHandle = job
	if memoryMB > 0 {
		var info windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION
		info.BasicLimitInformation.LimitFlags = windows.JOB_OBJECT_LIMIT_JOB_MEMORY
		info.JobMemoryLimit = uintptr(memoryMB) * 1024 * 1024
		if _, err := windows.SetInformationJobObject(
			job,
			windows.JobObjectExtendedLimitInformation,
			uintptr(unsafe.Pointer(&info)),
			uint32(unsafe.Sizeof(info)),
		); err != nil {
			fmt.Fprintf(os.Stderr, "agent resource limits: memory limit failed: %v\n", err)
		}
	}
	if cpuPercent > 0 {
		if cpuPercent > 100 {
			cpuPercent = 100
		}
		cpu := jobObjectCpuRateControlInformation{
			ControlFlags: jobObjectCpuRateControlEnable | jobObjectCpuRateControlHardCap,
			CpuRate:      uint32(cpuPercent * 100),
		}
		if _, err := windows.SetInformationJobObject(
			job,
			windows.JobObjectCpuRateControlInformation,
			uintptr(unsafe.Pointer(&cpu)),
			uint32(unsafe.Sizeof(cpu)),
		); err != nil {
			fmt.Fprintf(os.Stderr, "agent resource limits: CPU limit failed: %v\n", err)
		}
	}
	process, err := windows.GetCurrentProcess()
	if err != nil {
		fmt.Fprintf(os.Stderr, "agent resource limits: GetCurrentProcess failed: %v\n", err)
		return
	}
	if err := windows.AssignProcessToJobObject(job, process); err != nil {
		fmt.Fprintf(os.Stderr, "agent resource limits: AssignProcessToJobObject failed: %v\n", err)
	}
}

func envInt(name string) int {
	raw := os.Getenv(name)
	if raw == "" {
		return 0
	}
	value, err := strconv.Atoi(raw)
	if err != nil {
		return 0
	}
	return value
}
