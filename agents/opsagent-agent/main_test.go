package main

import (
	"strings"
	"testing"
)

func TestHostMetricsHasCapacityFields(t *testing.T) {
	metrics := hostMetrics()
	if len(metrics) == 0 {
		t.Fatal("expected host metrics")
	}
	if _, ok := metrics["diskTotalGB"]; !ok {
		t.Error("missing diskTotalGB")
	}
	if _, ok := metrics["diskFreeGB"]; !ok {
		t.Error("missing diskFreeGB")
	}
}

func TestRunCommandDiagnostics(t *testing.T) {
	metrics := map[string]any{"memLoadPct": 12, "diskFreeGB": 3.5}
	result := runCommand("diagnostics", metrics)
	if result["ok"] != true {
		t.Fatalf("expected ok, got %#v", result)
	}
	if result["metrics"] == nil {
		t.Fatal("diagnostics must include metrics")
	}
}

func TestRunCommandDiskAndMemory(t *testing.T) {
	metrics := map[string]any{
		"diskTotalGB":    100.0,
		"diskFreeGB":     40.0,
		"memTotalGB":     16.0,
		"memAvailableGB": 8.0,
		"memLoadPct":     50,
	}
	disk := runCommand("disk_check", metrics)
	if disk["diskFreeGB"] != 40.0 || disk["diskTotalGB"] != 100.0 {
		t.Fatalf("unexpected disk result %#v", disk)
	}
	memory := runCommand("memory_check", metrics)
	if memory["memAvailableGB"] != 8.0 || memory["memLoadPct"] != 50 {
		t.Fatalf("unexpected memory result %#v", memory)
	}
}

func TestRunCommandUnsupported(t *testing.T) {
	result := runCommand("rm_rf", map[string]any{})
	if result["ok"] != false || result["error"] != "unsupported_command" {
		t.Fatalf("unexpected result %#v", result)
	}
}

func TestRunCommandDiscovery(t *testing.T) {
	result := runCommand("discovery", map[string]any{"memTotalGB": 16.0, "diskTotalGB": 100.0, "diskFreeGB": 40.0})
	if result["ok"] != true {
		t.Fatalf("expected discovery ok, got %#v", result)
	}
	report, ok := result["discovery"].(discoveryReport)
	if !ok {
		t.Fatalf("expected discovery report, got %#v", result["discovery"])
	}
	if report.System["hostname"] == "" || report.Agent["version"] == "" {
		t.Fatalf("discovery report missing identity: %#v", report)
	}
}

func TestPatrolEventsDetectLowDiskAndHighMemory(t *testing.T) {
	t.Setenv("OPSAGENT_PATROL_DISK_FREE_PCT", "15")
	t.Setenv("OPSAGENT_PATROL_MEM_LOAD_PCT", "80")
	events := patrolEvents(map[string]any{
		"diskTotalGB":    100.0,
		"diskFreeGB":     8.0,
		"memTotalGB":     16.0,
		"memAvailableGB": 2.0,
		"memLoadPct":     87.5,
	})
	if len(events) != 2 {
		t.Fatalf("expected disk and memory events, got %#v", events)
	}
}

func TestInspectCommandAnswersDiskQuestion(t *testing.T) {
	result := runCommandWithInput("inspect", map[string]any{
		"memTotalGB": 16.0, "memAvailableGB": 8.0, "diskTotalGB": 100.0, "diskFreeGB": 40.0,
	}, map[string]any{"question": "磁盘分区什么样"})
	if result["ok"] != true {
		t.Fatalf("expected inspect ok, got %#v", result)
	}
	answer, _ := result["answer"].(string)
	if !strings.Contains(answer, "主机检查结果") || !strings.Contains(answer, "磁盘分区什么样") {
		t.Fatalf("inspect answer missing question: %s", answer)
	}
}

func TestInspectCommandAnswersUptimeQuestion(t *testing.T) {
	result := runCommandWithInput("inspect", map[string]any{
		"hostUptimeSec":  int64(90061),
		"bootTime":       "2026-11-03T08:00:00Z",
		"load1":          0.42,
		"processCount":   123,
		"memTotalGB":     16.0,
		"memAvailableGB": 8.0,
		"diskTotalGB":    100.0,
		"diskFreeGB":     40.0,
	}, map[string]any{"question": "系统运行多久了"})
	if result["ok"] != true {
		t.Fatalf("expected inspect ok, got %#v", result)
	}
	answer, _ := result["answer"].(string)
	if !strings.Contains(answer, "系统运行时长") || !strings.Contains(answer, "1 天 1 小时 1 分钟") {
		t.Fatalf("uptime missing: %s", answer)
	}
	if !strings.Contains(answer, "启动于 2026-11-03T08:00:00Z") {
		t.Fatalf("boot time missing: %s", answer)
	}
}

func TestAgentInstructionRunsReadOnlyInspect(t *testing.T) {
	result := runCommandWithInput("agent_instruction", map[string]any{
		"hostUptimeSec": int64(3661),
		"memTotalGB":    16.0, "memAvailableGB": 8.0, "diskTotalGB": 100.0, "diskFreeGB": 40.0,
	}, map[string]any{
		"instruction": "系统运行多久了",
		"intent": map[string]any{
			"kind":   "inspect",
			"params": map[string]any{"question": "系统运行多久了"},
		},
		"readOnly": true,
	})
	if result["ok"] != true {
		t.Fatalf("expected instruction ok, got %#v", result)
	}
	answer, _ := result["answer"].(string)
	if !strings.Contains(answer, "系统运行时长") {
		t.Fatalf("instruction answer missing uptime: %s", answer)
	}
}

func TestAgentInstructionRejectsUnsafeServiceName(t *testing.T) {
	result := runCommandWithInput("agent_instruction", map[string]any{}, map[string]any{
		"instruction": "重启 nginx; rm -rf /",
		"intent": map[string]any{
			"kind":   "service_restart",
			"params": map[string]any{"service": "nginx; rm -rf /"},
		},
		"readOnly": false,
	})
	if result["ok"] != false || result["error"] != "invalid service name" {
		t.Fatalf("expected invalid service name, got %#v", result)
	}
}

func TestRunCommandAIDiagnoseWithoutCredentials(t *testing.T) {
	t.Setenv("DEEPSEEK_API_KEY", "")
	result := runCommand("ai_diagnose", map[string]any{"memLoadPct": 50})
	if result["ok"] != false {
		t.Fatalf("expected missing credentials failure, got %#v", result)
	}
	if result["error"] != "model_credentials_missing" {
		t.Fatalf("unexpected error %#v", result["error"])
	}
}
