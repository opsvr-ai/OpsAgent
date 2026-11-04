package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestCertificateNeedsRenewalForMissingOrInvalidFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "agent.pem")
	if !certificateNeedsRenewal(path) {
		t.Fatal("missing certificate should require renewal")
	}
	if err := os.WriteFile(path, []byte("not a certificate"), 0o600); err != nil {
		t.Fatal(err)
	}
	if !certificateNeedsRenewal(path) {
		t.Fatal("invalid certificate should require renewal")
	}
}
