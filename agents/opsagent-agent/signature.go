package main

import (
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"sync"
	"time"
)

type commandEnvelope struct {
	KeyID     string          `json:"keyId"`
	Nonce     string          `json:"nonce"`
	ExpiresAt string          `json:"expiresAt"`
	Payload   json.RawMessage `json:"payload"`
}

var seenCommandNonces sync.Map

func commandKeyID(publicKey []byte) string {
	sum := sha256.Sum256(publicKey)
	return hex.EncodeToString(sum[:])[:16]
}

func verifyCommandSignature(publicKeyBase64, signedPayload, signature string) (string, error) {
	if publicKeyBase64 == "" {
		return "", fmt.Errorf("command signing key is not configured")
	}
	if signedPayload == "" || signature == "" {
		return "", fmt.Errorf("command is not signed")
	}
	publicKey, err := base64.StdEncoding.DecodeString(publicKeyBase64)
	if err != nil || len(publicKey) != ed25519.PublicKeySize {
		return "", fmt.Errorf("invalid command public key")
	}
	decodedSignature, err := base64.StdEncoding.DecodeString(signature)
	if err != nil || len(decodedSignature) != ed25519.SignatureSize {
		return "", fmt.Errorf("invalid command signature")
	}
	if !ed25519.Verify(ed25519.PublicKey(publicKey), []byte(signedPayload), decodedSignature) {
		return "", fmt.Errorf("command signature verification failed")
	}
	var envelope commandEnvelope
	if err := json.Unmarshal([]byte(signedPayload), &envelope); err != nil {
		return "", fmt.Errorf("invalid command envelope")
	}
	if envelope.KeyID != commandKeyID(publicKey) {
		return "", fmt.Errorf("command key id mismatch")
	}
	if envelope.Nonce == "" {
		return "", fmt.Errorf("command nonce missing")
	}
	expiresAt, err := time.Parse(time.RFC3339, envelope.ExpiresAt)
	if err != nil {
		return "", fmt.Errorf("invalid command expiry")
	}
	if time.Now().After(expiresAt) {
		return "", fmt.Errorf("command expired")
	}
	return envelope.Nonce, nil
}

func commandNonceSeen(nonce string) bool {
	_, seen := seenCommandNonces.LoadOrStore(nonce, true)
	return seen
}
