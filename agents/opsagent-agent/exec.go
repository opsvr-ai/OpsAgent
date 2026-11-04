package main

import (
	"bytes"
	"context"
	"log"
	"os/exec"
	"strings"
	"time"
)

var readOnlyCommands = map[string]bool{
	"ls": true, "stat": true, "cat": true, "head": true, "tail": true,
	"find": true, "du": true, "df": true, "free": true, "ps": true,
	"ss": true, "netstat": true, "journalctl": true, "systemctl": true,
	"docker": true, "uname": true, "hostname": true, "date": true,
	"uptime": true, "whoami": true, "id": true, "wc": true, "grep": true,
	"file": true, "readlink": true, "env": true, "printenv": true,
	"getent": true, "ip": true, "lsblk": true, "mount": true,
}

func execAllowed(argv []string) (bool, string) {
	if len(argv) == 0 {
		return false, "empty_command"
	}
	command := argv[0]
	if !readOnlyCommands[command] {
		return false, "command_not_allowed"
	}
	for _, arg := range argv[1:] {
		lower := strings.ToLower(arg)
		for _, denied := range []string{"-delete", "-exec", "-execdir", "-ok", " rm ", ">", ">>"} {
			if strings.Contains(" "+lower+" ", denied) {
				return false, "unsafe_argument"
			}
		}
	}
	switch command {
	case "systemctl":
		if len(argv) < 2 || !map[string]bool{"status": true, "show": true, "list-units": true, "list-unit-files": true, "is-active": true}[argv[1]] {
			return false, "unsafe_subcommand"
		}
	case "docker":
		if len(argv) < 2 || !map[string]bool{"ps": true, "logs": true, "inspect": true, "stats": true}[argv[1]] {
			return false, "unsafe_subcommand"
		}
	}
	return true, ""
}

func execHost(input map[string]any) map[string]any {
	raw, _ := input["argv"].([]any)
	argv := make([]string, 0, len(raw))
	for _, item := range raw {
		if value, ok := item.(string); ok && value != "" {
			argv = append(argv, value)
		}
	}
	allowed, reason := execAllowed(argv)
	if !allowed {
		return map[string]any{"type": "exec", "ok": false, "error": reason, "command": strings.Join(argv, " ")}
	}
	timeout := 15 * time.Second
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	started := time.Now()
	cmd := exec.CommandContext(ctx, argv[0], argv[1:]...)
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	err := cmd.Run()
	exitCode := 0
	if err != nil {
		if exitError, ok := err.(*exec.ExitError); ok {
			exitCode = exitError.ExitCode()
		} else {
			exitCode = -1
		}
	}
	log.Printf("exec command=%s exitCode=%d duration=%s stdoutBytes=%d stderrBytes=%d",
		strings.Join(argv, " "), exitCode, time.Since(started), stdout.Len(), stderr.Len())
	return map[string]any{
		"type":       "exec",
		"ok":         exitCode == 0,
		"command":    strings.Join(argv, " "),
		"exitCode":   exitCode,
		"stdout":     truncateLog(stdout.String(), 12000),
		"stderr":     truncateLog(stderr.String(), 5000),
		"durationMs": time.Since(started).Milliseconds(),
	}
}
