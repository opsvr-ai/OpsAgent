//go:build !windows

package main

// Windows Job Object limits are not applicable on Linux/macOS.
// Linux resource limits are applied through the systemd unit and cgroup.
func applyResourceLimits() {}
