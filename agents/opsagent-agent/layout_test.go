package main

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestEnsureCreatesAgentLayoutAndSkills(t *testing.T) {
	root := t.TempDir()
	t.Setenv("OPSAGENT_HOME", root)
	paths := resolveAgentPaths()
	if err := paths.ensure(); err != nil {
		t.Fatal(err)
	}
	for _, directory := range []string{
		paths.Bin, paths.Skills, paths.State, paths.Sessions, paths.Checkpoints, paths.Workspace,
	} {
		if info, err := os.Stat(directory); err != nil || !info.IsDir() {
			t.Fatalf("missing directory %s: %v", directory, err)
		}
	}
	for _, skill := range []string{"network-status", "disk-usage", "agent-health"} {
		if _, err := os.Stat(filepath.Join(paths.Skills, skill, "SKILL.md")); err != nil {
			t.Fatalf("missing seeded skill %s: %v", skill, err)
		}
	}
	config, err := os.ReadFile(paths.Config)
	if err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{"OPSAGENT_SKILLS_DIR=", "OPSAGENT_STATE_DIR=", "OPSAGENT_WORKSPACE_DIR="} {
		if !strings.Contains(string(config), key) {
			t.Fatalf("config missing %s: %s", key, config)
		}
	}
	found, ok := findSkill("network.status")
	if !ok || found.Name != "network.status" {
		t.Fatalf("expected builtin network skill, got %#v", found)
	}
}

func TestFileCheckpointStorePersists(t *testing.T) {
	store, err := newFileCheckpointStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	if _, ok, err := store.Get(ctx, "session/1"); err != nil || ok {
		t.Fatalf("expected missing checkpoint, got ok=%v err=%v", ok, err)
	}
	if err := store.Set(ctx, "session/1", []byte(`{"step":1}`)); err != nil {
		t.Fatal(err)
	}
	value, ok, err := store.Get(ctx, "session/1")
	if err != nil || !ok || string(value) != `{"step":1}` {
		t.Fatalf("unexpected checkpoint value=%q ok=%v err=%v", value, ok, err)
	}
}
