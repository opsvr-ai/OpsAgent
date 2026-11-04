package main

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestAgentStateAndConfigRoundTrip(t *testing.T) {
	root := t.TempDir()
	t.Setenv("OPSAGENT_HOME", root)
	t.Setenv("OPSAGENT_AGENT_CONFIG", "")
	paths := resolveAgentPaths()
	if err := paths.ensure(); err != nil {
		t.Fatal(err)
	}
	config := "OPSAGENT_CONTROL_URL=http://control:8080\nOPSAGENT_TENANT_ID=tenant-1\n"
	if err := os.WriteFile(paths.Config, []byte(config), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("OPSAGENT_CONTROL_URL", "")
	t.Setenv("OPSAGENT_TENANT_ID", "")
	loadAgentConfig(paths.Config)
	if os.Getenv("OPSAGENT_CONTROL_URL") != "http://control:8080" || os.Getenv("OPSAGENT_TENANT_ID") != "tenant-1" {
		t.Fatal("config values were not loaded")
	}
	state := agentState{AgentID: "a-1", AgentKey: "secret-key", Hostname: "host-1", ControlURL: "http://control:8080"}
	if err := saveAgentState(paths, state); err != nil {
		t.Fatal(err)
	}
	loaded, err := loadAgentState(paths)
	if err != nil {
		t.Fatal(err)
	}
	if loaded.AgentID != "a-1" || loaded.AgentKey != "secret-key" {
		t.Fatalf("unexpected state: %#v", loaded)
	}
	info, err := os.Stat(filepath.Join(filepath.Dir(paths.Config), "agent-state.json"))
	if err != nil {
		t.Fatal(err)
	}
	if runtime.GOOS != "windows" && info.Mode().Perm() != 0o600 {
		t.Fatalf("state permissions = %o", info.Mode().Perm())
	}
}
