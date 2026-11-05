package main

import (
	"fmt"
	"os"
	"strconv"
	"time"
)

type patrolEvent struct {
	Fingerprint string         `json:"fingerprint"`
	Severity    string         `json:"severity"`
	Title       string         `json:"title"`
	Detail      string         `json:"detail"`
	Metric      map[string]any `json:"metric"`
	Analysis    string         `json:"analysis,omitempty"`
	Resolved    bool           `json:"resolved,omitempty"`
	DetectedAt  string         `json:"detectedAt"`
}

func threshold(name string, fallback float64) float64 {
	raw := os.Getenv(name)
	if raw == "" {
		return fallback
	}
	value, err := strconv.ParseFloat(raw, 64)
	if err != nil {
		return fallback
	}
	return value
}

func patrolEvents(metrics map[string]any) []patrolEvent {
	events := []patrolEvent{}
	now := time.Now().UTC().Format(time.RFC3339)
	number := func(key string) float64 {
		switch value := metrics[key].(type) {
		case float64:
			return value
		case int:
			return float64(value)
		case int64:
			return float64(value)
		default:
			return 0
		}
	}
	diskTotal := number("diskTotalGB")
	diskFree := number("diskFreeGB")
	if diskTotal > 0 {
		freePct := diskFree / diskTotal * 100
		thresholdPct := threshold("OPSAGENT_PATROL_DISK_FREE_PCT", 15)
		if freePct < thresholdPct {
			severity := "warning"
			if freePct < 5 {
				severity = "critical"
			}
			events = append(events, patrolEvent{
				Fingerprint: "disk-low",
				Severity:    severity,
				Title:       "磁盘可用空间不足",
				Detail:      fmt.Sprintf("根分区可用 %.1f%%，低于阈值 %.1f%%（可用 %.1f GB / 总量 %.1f GB）", freePct, thresholdPct, diskFree, diskTotal),
				Metric:      map[string]any{"diskFreePct": freePct, "diskFreeGB": diskFree, "diskTotalGB": diskTotal},
				DetectedAt:  now,
			})
		}
	}
	memTotal := number("memTotalGB")
	memAvailable := number("memAvailableGB")
	memLoad := number("memLoadPct")
	if memLoad == 0 && memTotal > 0 {
		memLoad = (memTotal - memAvailable) / memTotal * 100
	}
	memThreshold := threshold("OPSAGENT_PATROL_MEM_LOAD_PCT", 85)
	if memLoad > memThreshold {
		severity := "warning"
		if memLoad > 95 {
			severity = "critical"
		}
		events = append(events, patrolEvent{
			Fingerprint: "memory-high",
			Severity:    severity,
			Title:       "内存使用率过高",
			Detail:      fmt.Sprintf("内存使用率 %.1f%%，高于阈值 %.1f%%（可用 %.1f GB / 总量 %.1f GB）", memLoad, memThreshold, memAvailable, memTotal),
			Metric:      map[string]any{"memLoadPct": memLoad, "memAvailableGB": memAvailable, "memTotalGB": memTotal},
			DetectedAt:  now,
		})
	}
	return events
}
