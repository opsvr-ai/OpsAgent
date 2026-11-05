package main

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestPlatformAnalyzeUsesControlPlaneModel(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/agents/a-1/analyze" {
			t.Fatalf("unexpected path %s", r.URL.Path)
		}
		if r.Header.Get("x-opsagent-enrollment-token") != "token" {
			t.Fatalf("missing enrollment token")
		}
		w.Header().Set("content-type", "application/json")
		_, _ = w.Write([]byte(`{"analysis":"磁盘可用空间不足，建议清理日志"}`))
	}))
	defer server.Close()

	analysis, err := platformAnalyze(server.URL, "a-1", "key", "token", map[string]any{"diskFreePct": 4}, []patrolEvent{
		{Fingerprint: "disk-low", Severity: "critical", Title: "磁盘可用空间不足"},
	}, "分析异常")
	if err != nil {
		t.Fatal(err)
	}
	if analysis != "磁盘可用空间不足，建议清理日志" {
		t.Fatalf("unexpected analysis %q", analysis)
	}
}
