package main

import "testing"

func TestExecAllowlist(t *testing.T) {
	if allowed, reason := execAllowed([]string{"ls", "-lah", "/opt/opsagent/logs"}); !allowed {
		t.Fatalf("ls should be allowed: %s", reason)
	}
	if allowed, _ := execAllowed([]string{"sh", "-c", "id"}); allowed {
		t.Fatal("shell should not be allowed")
	}
	if allowed, _ := execAllowed([]string{"find", "/tmp", "-delete"}); allowed {
		t.Fatal("find -delete should not be allowed")
	}
	if allowed, _ := execAllowed([]string{"systemctl", "restart", "nginx"}); allowed {
		t.Fatal("systemctl restart should not be allowed")
	}
}

func TestExecHostRunsReadOnlyCommand(t *testing.T) {
	result := execHost(map[string]any{"argv": []any{"whoami"}})
	if result["ok"] != true {
		t.Fatalf("whoami failed: %#v", result)
	}
	if result["stdout"] == "" {
		t.Fatal("expected command output")
	}
}
