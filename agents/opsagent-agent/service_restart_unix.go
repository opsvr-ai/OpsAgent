//go:build !windows

package main

import (
	"context"
	"os/exec"
	"time"
)

func controlService(action string, service string) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	output, err := exec.CommandContext(ctx, "systemctl", action, service).CombinedOutput()
	return string(output), err
}

func serviceStatus(service string) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	output, err := exec.CommandContext(ctx, "systemctl", "is-active", service).CombinedOutput()
	return string(output), err
}
