//go:build windows

package main

import (
	"context"
	"os/exec"
	"time"
)

func restartService(service string) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	output, err := exec.CommandContext(ctx, "sc.exe", "restart", service).CombinedOutput()
	return string(output), err
}
