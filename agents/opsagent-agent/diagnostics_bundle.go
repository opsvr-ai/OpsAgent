package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
)

func truncateLog(output string, limit int) string {
	output = strings.TrimSpace(output)
	if len(output) > limit {
		return output[:limit] + "\n... (已截断)"
	}
	return output
}

func applicationLogs(applications []map[string]any) map[string]string {
	logs := map[string]string{}
	for index, app := range applications {
		if index >= 8 {
			break
		}
		name, _ := app["name"].(string)
		kind, _ := app["kind"].(string)
		if name == "" {
			continue
		}
		var output string
		switch kind {
		case "systemd":
			output = commandOutput(5*time.Second, "journalctl", "-u", name, "-n", "40", "--no-pager")
			if output == "" {
				output = commandOutput(3*time.Second, "tail", "-n", "40", "/var/log/"+name+".log")
			}
		case "docker":
			output = commandOutput(5*time.Second, "docker", "logs", "--tail", "40", name)
		}
		if output != "" {
			logs[name] = truncateLog(output, 3000)
		}
	}
	return logs
}

func extraApplicationLogs() map[string]string {
	logs := map[string]string{}
	paths := strings.Split(os.Getenv("OPSAGENT_APP_LOG_PATHS"), ",")
	for _, path := range paths {
		path = strings.TrimSpace(path)
		if path == "" {
			continue
		}
		content, err := os.ReadFile(path)
		if err != nil {
			continue
		}
		if len(content) > 3000 {
			content = content[len(content)-3000:]
		}
		logs[filepath.Base(path)] = truncateLog(string(content), 3000)
	}
	return logs
}

func systemLogs() map[string]string {
	logs := map[string]string{}
	commands := map[string][]string{
		"journal-errors": {"journalctl", "-p", "warning", "-n", "60", "--no-pager"},
		"messages":       {"tail", "-n", "60", "/var/log/messages"},
		"syslog":         {"tail", "-n", "60", "/var/log/syslog"},
	}
	for key, args := range commands {
		if output := commandOutput(5*time.Second, args[0], args[1:]...); output != "" {
			logs[key] = truncateLog(output, 2500)
		}
	}
	if output := commandOutput(3*time.Second, "dmesg", "--level=err,warn"); output != "" {
		logs["kernel"] = truncateLog(output, 2000)
	}
	return logs
}

func agentLogTail() string {
	paths := resolveAgentPaths()
	content, err := os.ReadFile(filepath.Join(paths.Logs, "agent.log"))
	if err != nil {
		return ""
	}
	limit := 16000
	if len(content) > limit {
		content = content[len(content)-limit:]
	}
	return truncateLog(string(content), limit)
}

func collectDiagnosticsBundle(metrics map[string]any, report discoveryReport) map[string]any {
	appLogs := applicationLogs(report.Applications)
	for name, output := range extraApplicationLogs() {
		appLogs[name] = output
	}
	bundle := map[string]any{
		"collectedAt":     time.Now().UTC().Format(time.RFC3339),
		"system":          report.System,
		"applications":    report.Applications,
		"agent":           report.Agent,
		"metrics":         metrics,
		"applicationLogs": appLogs,
		"systemLogs":      systemLogs(),
		"agentLog":        agentLogTail(),
	}
	for key, args := range map[string][]string{
		"processes": {"ps", "aux"},
		"disk":      {"df", "-hT"},
		"memory":    {"free", "-h"},
	} {
		if output := commandOutput(5*time.Second, args[0], args[1:]...); output != "" {
			bundle[key] = fmt.Sprintf("```text\n%s\n```", truncateLog(output, 3500))
		}
	}
	return bundle
}
