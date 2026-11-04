package main

import (
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestRunDeploymentCommandVerifiesChecksum(t *testing.T) {
	artifact := []byte("opsagent deployment artifact")
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write(artifact)
	}))
	defer server.Close()
	sum := sha256.Sum256(artifact)
	result := runDeploymentCommand(map[string]any{
		"artifactUrl": server.URL,
		"sha256":      hex.EncodeToString(sum[:]),
		"command":     "echo deployed",
		"version":     "1.2.3",
		"mode":        "apply",
	})
	if result["ok"] != true {
		t.Fatalf("deployment failed: %#v", result)
	}
	if result["artifactSha256"] != hex.EncodeToString(sum[:]) {
		t.Fatalf("unexpected checksum: %#v", result)
	}
}

func TestRunDeploymentCommandRejectsChecksumMismatch(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte("artifact"))
	}))
	defer server.Close()
	result := runDeploymentCommand(map[string]any{
		"artifactUrl": server.URL,
		"sha256":      "deadbeef",
		"command":     "echo no",
		"version":     "1.2.3",
		"mode":        "apply",
	})
	if result["ok"] != false {
		t.Fatalf("checksum mismatch was accepted: %#v", result)
	}
}
