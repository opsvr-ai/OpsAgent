package main

import (
	"strings"
	"testing"
)

func TestAnalyzeLogsReturnsSummaryNotRawDump(t *testing.T) {
	analysis := analyzeEvidence("看看最近的系统日志", map[string]string{
		"journal": "Nov 05 10:00:01 host app[1]: ERROR failed to connect db\nNov 05 10:00:02 host app[1]: INFO retry",
	})
	if !strings.Contains(analysis, "需要关注") || !strings.Contains(analysis, "ERROR failed") {
		t.Fatalf("unexpected log analysis: %s", analysis)
	}
	if strings.Contains(analysis, "```") {
		t.Fatalf("analysis should not contain raw code fence: %s", analysis)
	}
}

func TestAnalyzeNetworkReturnsAddressesOnly(t *testing.T) {
	analysis := analyzeEvidence("查一下 IP", map[string]string{
		"interfaces": "2: eth0: <UP>\n    inet 7.24.4.68/24 brd 7.24.4.255 scope global eth0\n    inet 127.0.0.1/8 scope host lo",
	})
	if !strings.Contains(analysis, "7.24.4.68") || strings.Contains(analysis, "127.0.0.1") {
		t.Fatalf("unexpected network analysis: %s", analysis)
	}
}
