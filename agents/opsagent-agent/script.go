package main

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

const maxScriptBytes = 32 * 1024

func runScriptCommand(input map[string]any) map[string]any {
	result := map[string]any{"type": "script", "ok": false}
	if os.Getenv("OPSAGENT_ALLOW_SCRIPTS") != "true" {
		result["error"] = "script_execution_disabled"
		return result
	}
	script := ""
	if input != nil {
		if value, ok := input["script"].(string); ok {
			script = value
		}
	}
	if strings.TrimSpace(script) == "" {
		result["error"] = "script_required"
		return result
	}
	if len(script) > maxScriptBytes {
		result["error"] = "script_too_large"
		return result
	}
	timeout := 60
	if input != nil {
		if value, ok := input["timeoutSeconds"].(float64); ok && value > 0 && value <= 300 {
			timeout = int(value)
		}
	}
	extension := ".sh"
	interpreter := "/bin/sh"
	args := []string{}
	if runtime.GOOS == "windows" {
		extension = ".ps1"
		interpreter = "powershell"
		args = []string{"-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File"}
	}
	directory := filepath.Join(resolveAgentPaths().Workspace, "scripts")
	if err := os.MkdirAll(directory, 0o750); err != nil {
		result["error"] = err.Error()
		return result
	}
	file, err := os.CreateTemp(directory, "script-*"+extension)
	if err != nil {
		result["error"] = err.Error()
		return result
	}
	path := file.Name()
	defer os.Remove(path)
	if err := os.WriteFile(path, []byte(script), 0o640); err != nil {
		_ = file.Close()
		result["error"] = err.Error()
		return result
	}
	_ = file.Close()
	args = append(args, path)
	ctx, cancel := context.WithTimeout(context.Background(), time.Duration(timeout)*time.Second)
	defer cancel()
	command := exec.CommandContext(ctx, interpreter, args...)
	command.Dir = resolveAgentPaths().Root
	output, err := command.CombinedOutput()
	text := strings.TrimSpace(string(output))
	result["output"] = text
	result["exitCode"] = 0
	if err != nil {
		result["ok"] = false
		result["error"] = err.Error()
		if exitErr, ok := err.(*exec.ExitError); ok {
			result["exitCode"] = exitErr.ExitCode()
		}
	} else {
		result["ok"] = true
	}
	result["interpreter"] = fmt.Sprintf("%s %s", interpreter, strings.Join(args[:len(args)-1], " "))
	return result
}
