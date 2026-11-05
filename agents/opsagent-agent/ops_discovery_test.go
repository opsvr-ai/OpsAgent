package main

import "testing"

func TestOperationalSkillReturnsEvidence(t *testing.T) {
	for _, name := range []string{"ops.tools", "performance.analysis", "system.configuration"} {
		result := operationalSkillResult(name)
		if result == nil {
			t.Fatalf("missing operational skill %s", name)
		}
		if result["analysis"] == "" {
			t.Fatalf("missing analysis for %s", name)
		}
		evidence, ok := result["evidence"].(map[string]string)
		if !ok || evidence["report"] == "" {
			t.Fatalf("missing report evidence for %s", name)
		}
	}
}

func TestOperationalIntent(t *testing.T) {
	if got := operationalIntent("发现系统安装了哪些运维客户端"); got != "ops.tools" {
		t.Fatalf("unexpected intent %q", got)
	}
	if got := operationalIntent("分析一下系统性能瓶颈"); got != "performance.analysis" {
		t.Fatalf("unexpected intent %q", got)
	}
	if got := operationalIntent("采集操作系统配置详情"); got != "system.configuration" {
		t.Fatalf("unexpected intent %q", got)
	}
}
