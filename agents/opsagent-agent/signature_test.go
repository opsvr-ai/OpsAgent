package main

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"fmt"
	"testing"
	"time"
)

func makeCommandKey(publicKey ed25519.PublicKey) commandKey {
	return commandKey{KeyID: commandKeyID(publicKey), PublicKey: base64.StdEncoding.EncodeToString(publicKey)}
}

func signedEnvelope(key commandKey, nonce string, expiresAt time.Time) string {
	return fmt.Sprintf(`{"expiresAt":%q,"keyId":%q,"nonce":%q,"payload":{"command":"disk_check"}}`,
		expiresAt.UTC().Format(time.RFC3339), key.KeyID, nonce)
}

func TestVerifyCommandSignature(t *testing.T) {
	publicKey, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	key := makeCommandKey(publicKey)
	payload := signedEnvelope(key, "nonce-1", time.Now().Add(time.Minute))
	signature := ed25519.Sign(privateKey, []byte(payload))
	encodedSignature := base64.StdEncoding.EncodeToString(signature)
	nonce, err := verifyCommandSignature([]commandKey{key}, payload, encodedSignature)
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
	if _, err := verifyCommandSignature([]commandKey{key}, payload+"x", encodedSignature); err == nil {
		t.Fatal("tampered payload accepted")
	}
	if _, err := verifyCommandSignature([]commandKey{key}, payload, ""); err == nil {
		t.Fatal("missing signature accepted")
	}
	if _, err := verifyCommandSignature(nil, payload, encodedSignature); err == nil {
		t.Fatal("missing public key accepted")
	}
	expired := signedEnvelope(key, "nonce-2", time.Now().Add(-time.Minute))
	expiredSignature := ed25519.Sign(privateKey, []byte(expired))
	if _, err := verifyCommandSignature([]commandKey{key}, expired, base64.StdEncoding.EncodeToString(expiredSignature)); err == nil {
		t.Fatal("expired command accepted")
	}
}

func TestVerifyCommandSignatureWithPreviousKey(t *testing.T) {
	currentPublic, currentPrivate, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	previousPublic, previousPrivate, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	currentKey := makeCommandKey(currentPublic)
	previousKey := makeCommandKey(previousPublic)
	payload := signedEnvelope(previousKey, "nonce-old", time.Now().Add(time.Minute))
	signature := ed25519.Sign(previousPrivate, []byte(payload))
	if _, err := verifyCommandSignature([]commandKey{currentKey, previousKey}, payload, base64.StdEncoding.EncodeToString(signature)); err != nil {
		t.Fatalf("previous key rejected during rotation: %v", err)
	}
	_ = currentPrivate
}
