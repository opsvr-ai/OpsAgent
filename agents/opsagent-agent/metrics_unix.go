//go:build !windows

package main

import (
	"os"
	"strconv"
	"strings"
	"syscall"
	"time"
)

func hostMetrics() map[string]any {
	metrics := map[string]any{}
	if uptime := hostUptimeSeconds(); uptime > 0 {
		metrics["hostUptimeSec"] = uptime
		metrics["bootTime"] = time.Now().Add(-time.Duration(uptime) * time.Second).UTC().Format(time.RFC3339)
	}
	if data, err := os.ReadFile("/proc/loadavg"); err == nil {
		fields := strings.Fields(string(data))
		if len(fields) >= 3 {
			for index, key := range []string{"load1", "load5", "load15"} {
				if value, err := strconv.ParseFloat(fields[index], 64); err == nil {
					metrics[key] = value
				}
			}
		}
	}
	if entries, err := os.ReadDir("/proc"); err == nil {
		processes := 0
		for _, entry := range entries {
			if _, err := strconv.Atoi(entry.Name()); err == nil {
				processes += 1
			}
		}
		if processes > 0 {
			metrics["processCount"] = processes
		}
	}
	var stat syscall.Statfs_t
	if err := syscall.Statfs("/", &stat); err == nil {
		total := float64(stat.Blocks) * float64(stat.Bsize) / 1024 / 1024 / 1024
		free := float64(stat.Bavail) * float64(stat.Bsize) / 1024 / 1024 / 1024
		metrics["diskTotalGB"] = total
		metrics["diskFreeGB"] = free
	}

	content, err := os.ReadFile("/proc/meminfo")
	if err != nil {
		return metrics
	}
	for _, line := range strings.Split(string(content), "\n") {
		fields := strings.Fields(line)
		if len(fields) < 2 {
			continue
		}
		value, err := strconv.ParseFloat(fields[1], 64)
		if err != nil {
			continue
		}
		switch fields[0] {
		case "MemTotal:":
			metrics["memTotalGB"] = value / 1024 / 1024
		case "MemAvailable:":
			metrics["memAvailableGB"] = value / 1024 / 1024
		}
	}
	total, _ := metrics["memTotalGB"].(float64)
	available, _ := metrics["memAvailableGB"].(float64)
	if total > 0 {
		metrics["memLoadPct"] = (total - available) / total * 100
	}
	return metrics
}
