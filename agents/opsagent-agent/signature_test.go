package main

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"testing"
)

func TestVerifyCommandSignature(t *testing.T) {
	publicKey, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	payload := `{"command":"disk_check","nested":{"a":1}}`
	signature := ed25519.Sign(privateKey, []byte(payload))
	encodedPublic := base64.StdEncoding.EncodeToString(publicKey)
	encodedSignature := base64.StdEncoding.EncodeToString(signature)
	if err := verifyCommandSignature(encodedPublic, payload, encodedSignature); err != nil {
		t.Fatalf("valid signature rejected: %v", err)
	}
	if err := verifyCommandSignature(encodedPublic, payload+"x", encodedSignature); err == nil {
		t.Fatal("tampered payload accepted")
	}
	if err := verifyCommandSignature(encodedPublic, payload, ""); err == nil {
		t.Fatal("missing signature accepted")
	}
	if err := verifyCommandSignature("", payload, encodedSignature); err == nil {
		t.Fatal("missing public key accepted")
	}
}
