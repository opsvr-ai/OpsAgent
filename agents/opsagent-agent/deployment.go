package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"os"
	"os/exec"
	"runtime"
	"time"
)

func runDeploymentCommand(input map[string]any) map[string]any {
	result := map[string]any{"type": "deployment_execute", "ok": false}
	artifactURL, _ := input["artifactUrl"].(string)
	expected, _ := input["sha256"].(string)
	command, _ := input["command"].(string)
	version, _ := input["version"].(string)
	mode, _ := input["mode"].(string)
	if artifactURL == "" || expected == "" || command == "" {
		result["error"] = "artifactUrl, sha256 and command are required"
		return result
	}
	started := time.Now()
	client := newHTTPClient(120 * time.Second)
	response, err := client.Get(artifactURL)
	if err != nil {
		result["error"] = fmt.Sprintf("download artifact: %v", err)
		return result
	}
	defer response.Body.Close()
	if response.StatusCode >= 300 {
		result["error"] = fmt.Sprintf("artifact returned %d", response.StatusCode)
		return result
	}
	temp, err := os.CreateTemp("", "opsagent-deploy-*")
	if err != nil {
		result["error"] = err.Error()
		return result
	}
	tempPath := temp.Name()
	defer os.Remove(tempPath)
	hasher := sha256.New()
	written, err := io.Copy(io.MultiWriter(temp, hasher), io.LimitReader(response.Body, 100*1024*1024+1))
	closeErr := temp.Close()
	if err != nil || closeErr != nil {
		result["error"] = "write artifact failed"
		return result
	}
	if written > 100*1024*1024 {
		result["error"] = "artifact exceeds 100 MB"
		return result
	}
	actual := hex.EncodeToString(hasher.Sum(nil))
	if actual != expected {
		result["error"] = "artifact checksum mismatch"
		result["expectedSha256"] = expected
		result["actualSha256"] = actual
		return result
	}

	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()
	var commandLine string
	var args []string
	if runtime.GOOS == "windows" {
		commandLine = "cmd"
		args = []string{"/c", command}
	} else {
		commandLine = "/bin/sh"
		args = []string{"-c", command}
	}
	cmd := exec.CommandContext(ctx, commandLine, args...)
	cmd.Env = append(os.Environ(),
		"OPSAGENT_ARTIFACT="+tempPath,
		"OPSAGENT_VERSION="+version,
		"OPSAGENT_DEPLOY_MODE="+mode,
	)
	output, runErr := cmd.CombinedOutput()
	text := string(output)
	if len(text) > 12000 {
		text = text[:12000] + "…"
	}
	result["output"] = text
	result["artifactSha256"] = actual
	result["artifactBytes"] = written
	result["durationMs"] = time.Since(started).Milliseconds()
	result["mode"] = mode
	if runErr != nil {
		result["error"] = runErr.Error()
		return result
	}
	result["ok"] = true
	return result
}
