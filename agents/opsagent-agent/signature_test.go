package main

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"testing"
	"time"
)

func signedEnvelope(privateKey ed25519.PrivateKey, publicKey ed25519.PublicKey, nonce string, expiresAt time.Time) string {
	sum := sha256.Sum256(publicKey)
	keyID := hex.EncodeToString(sum[:])[:16]
	return fmt.Sprintf(`{"expiresAt":%q,"keyId":%q,"nonce":%q,"payload":{"command":"disk_check"}}`,
		expiresAt.UTC().Format(time.RFC3339), keyID, nonce)
}

func TestVerifyCommandSignature(t *testing.T) {
	publicKey, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	payload := signedEnvelope(privateKey, publicKey, "nonce-1", time.Now().Add(time.Minute))
	signature := ed25519.Sign(privateKey, []byte(payload))
	encodedPublic := base64.StdEncoding.EncodeToString(publicKey)
	encodedSignature := base64.StdEncoding.EncodeToString(signature)
	nonce, err := verifyCommandSignature(encodedPublic, payload, encodedSignature)
	if err != nil {
		t.Fatalf("valid signature rejected: %v", err)
	}
	if nonce != "nonce-1" {
		t.Fatalf("nonce = %q", nonce)
	}
	if commandNonceSeen(nonce) {
		t.Fatal("first nonce marked as seen before replay check")
	}
	if !commandNonceSeen(nonce) {
		t.Fatal("replayed nonce not detected")
	}
	if _, err := verifyCommandSignature(encodedPublic, payload+"x", encodedSignature); err == nil {
		t.Fatal("tampered payload accepted")
	}
	if _, err := verifyCommandSignature(encodedPublic, payload, ""); err == nil {
		t.Fatal("missing signature accepted")
	}
	if _, err := verifyCommandSignature("", payload, encodedSignature); err == nil {
		t.Fatal("missing public key accepted")
	}
	expired := signedEnvelope(privateKey, publicKey, "nonce-2", time.Now().Add(-time.Minute))
	expiredSignature := ed25519.Sign(privateKey, []byte(expired))
	if _, err := verifyCommandSignature(encodedPublic, expired, base64.StdEncoding.EncodeToString(expiredSignature)); err == nil {
		t.Fatal("expired command accepted")
	}
}
