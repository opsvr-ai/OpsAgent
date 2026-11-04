package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestAgentPathsLayoutAndSnapshots(t *testing.T) {
	root := t.TempDir()
	t.Setenv("OPSAGENT_HOME", root)
	t.Setenv("OPSAGENT_AGENT_CONFIG", "")
	t.Setenv("OPSAGENT_LOG_DIR", "")
	t.Setenv("OPSAGENT_SNAPSHOT_DIR", "")
	t.Setenv("OPSAGENT_TOOLS_DIR", "")
	paths := resolveAgentPaths()
	if paths.Bin != filepath.Join(root, "bin") || paths.Logs != filepath.Join(root, "logs") || paths.Snapshots != filepath.Join(root, "snapshots") {
		t.Fatalf("unexpected layout: %#v", paths)
	}
	if paths.Config != filepath.Join(root, "config", "agent.env") {
		t.Fatalf("unexpected config path: %s", paths.Config)
	}
	if err := paths.ensure(); err != nil {
		t.Fatal(err)
	}
	for _, directory := range []string{paths.Bin, paths.Logs, paths.Snapshots, paths.Tools, paths.Run} {
		if info, err := os.Stat(directory); err != nil || !info.IsDir() {
			t.Fatalf("directory missing: %s", directory)
		}
	}
	if err := paths.writeSnapshot("discovery.json", map[string]any{"ok": true}); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(paths.Snapshots, "discovery.json")); err != nil {
		t.Fatalf("snapshot missing: %v", err)
	}
}

func TestMaskSecrets(t *testing.T) {
	if mask("abcdefghijklmnop") != "abcd...mnop" {
		t.Fatal("unexpected mask")
	}
	if mask("short") != "***" {
		t.Fatal("unexpected short mask")
	}
}
