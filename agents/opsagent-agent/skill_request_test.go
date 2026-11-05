package main

import "testing"

func TestSkillRequestDistinguishesUseFromList(t *testing.T) {
	t.Setenv("OPSAGENT_HOME", t.TempDir())
	paths := resolveAgentPaths()
	if err := paths.ensure(); err != nil {
		t.Fatal(err)
	}
	if _, ok := skillRequest("你有哪些技能"); ok {
		t.Fatal("listing skills must not be treated as using a skill")
	}
	skill, ok := skillRequest("使用技能 network.status 给我分析下这台机器的网络配置")
	if !ok || skill.Name != "network.status" {
		t.Fatalf("expected network.status request, got %#v ok=%v", skill, ok)
	}
}
