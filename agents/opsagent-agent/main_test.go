package main

import "testing"

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
