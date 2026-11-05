package main

import (
	"fmt"
	"net/url"
	"os"
	"strconv"
	"strings"
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

type patrolPolicy struct {
	AgentID         string      `json:"agentId"`
	Enabled         bool        `json:"enabled"`
	IntervalSeconds int         `json:"intervalSeconds"`
	DiskFreePct     float64     `json:"diskFreePct"`
	MemLoadPct      float64     `json:"memLoadPct"`
	Load1           float64     `json:"load1"`
	Watch           patrolWatch `json:"watch"`
}

type patrolWatch struct {
	Processes []string `json:"processes"`
	Ports     []string `json:"ports"`
	Services  []string `json:"services"`
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
	return patrolEventsWithThresholds(
		metrics,
		threshold("OPSAGENT_PATROL_DISK_FREE_PCT", 15),
		threshold("OPSAGENT_PATROL_MEM_LOAD_PCT", 85),
		0,
		patrolWatch{},
	)
}

func patrolEventsWithThresholds(metrics map[string]any, diskThreshold, memThreshold, loadThreshold float64, watch patrolWatch) []patrolEvent {
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
		if freePct < diskThreshold {
			severity := "warning"
			if freePct < 5 {
				severity = "critical"
			}
			events = append(events, patrolEvent{
				Fingerprint: "disk-low",
				Severity:    severity,
				Title:       "磁盘可用空间不足",
				Detail:      fmt.Sprintf("根分区可用 %.1f%%，低于阈值 %.1f%%（可用 %.1f GB / 总量 %.1f GB）", freePct, diskThreshold, diskFree, diskTotal),
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
	if loadThreshold > 0 {
		load1 := number("load1")
		if load1 > loadThreshold {
			events = append(events, patrolEvent{
				Fingerprint: "load-high",
				Severity:    "warning",
				Title:       "系统负载过高",
				Detail:      fmt.Sprintf("1 分钟负载 %.2f，高于阈值 %.2f", load1, loadThreshold),
				Metric:      map[string]any{"load1": load1, "load1Threshold": loadThreshold},
				DetectedAt:  now,
			})
		}
	}
	for _, name := range watch.Processes {
		if strings.TrimSpace(name) == "" {
			continue
		}
		if commandOutput(2*time.Second, "pgrep", "-f", name) == "" {
			events = append(events, patrolEvent{
				Fingerprint: "watch-process-" + name,
				Severity:    "critical",
				Title:       "重要进程未运行",
				Detail:      fmt.Sprintf("标记为重要的进程 %s 未发现。", name),
				Metric:      map[string]any{"process": name},
				DetectedAt:  now,
			})
		}
	}
	for _, port := range watch.Ports {
		port = strings.TrimSpace(port)
		if port == "" {
			continue
		}
		listeners := commandOutput(2*time.Second, "ss", "-lnt")
		if !strings.Contains(listeners, ":"+port+" ") && !strings.Contains(listeners, ":"+port+"\n") {
			events = append(events, patrolEvent{
				Fingerprint: "watch-port-" + port,
				Severity:    "critical",
				Title:       "重要端口未监听",
				Detail:      fmt.Sprintf("标记为重要的端口 %s 未监听。", port),
				Metric:      map[string]any{"port": port},
				DetectedAt:  now,
			})
		}
	}
	for _, service := range watch.Services {
		service = strings.TrimSpace(service)
		if service == "" {
			continue
		}
		status := commandOutput(2*time.Second, "systemctl", "is-active", service)
		if status != "active" {
			events = append(events, patrolEvent{
				Fingerprint: "watch-service-" + service,
				Severity:    "critical",
				Title:       "重要服务未运行",
				Detail:      fmt.Sprintf("标记为重要的服务 %s 状态为 %s。", service, status),
				Metric:      map[string]any{"service": service, "status": status},
				DetectedAt:  now,
			})
		}
	}
	return events
}

func defaultPatrolPolicy() patrolPolicy {
	return patrolPolicy{
		Enabled:         true,
		IntervalSeconds: 30,
		DiskFreePct:     threshold("OPSAGENT_PATROL_DISK_FREE_PCT", 15),
		MemLoadPct:      threshold("OPSAGENT_PATROL_MEM_LOAD_PCT", 85),
		Load1:           0,
	}
}

func loadPatrolPolicy(controlURL, agentID, agentKey string) (patrolPolicy, error) {
	var policy patrolPolicy
	endpoint := controlURL + "/api/agents/" + agentID + "/patrol-policy/agent?agentKey=" + url.QueryEscape(agentKey)
	if _, err := getJSON(endpoint, &policy); err != nil {
		return defaultPatrolPolicy(), err
	}
	if policy.IntervalSeconds < 30 {
		policy.IntervalSeconds = 30
	}
	if policy.DiskFreePct <= 0 {
		policy.DiskFreePct = 15
	}
	if policy.MemLoadPct <= 0 {
		policy.MemLoadPct = 85
	}
	return policy, nil
}
