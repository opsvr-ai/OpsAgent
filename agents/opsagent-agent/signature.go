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

type commandKey struct {
	KeyID     string `json:"keyId"`
	PublicKey string `json:"publicKey"`
}

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

func verifyCommandSignature(keys []commandKey, signedPayload, signature string) (string, error) {
	if len(keys) == 0 {
		return "", fmt.Errorf("command signing key is not configured")
	}
	if signedPayload == "" || signature == "" {
		return "", fmt.Errorf("command is not signed")
	}
	decodedSignature, err := base64.StdEncoding.DecodeString(signature)
	if err != nil || len(decodedSignature) != ed25519.SignatureSize {
		return "", fmt.Errorf("invalid command signature")
	}
	var envelope commandEnvelope
	if err := json.Unmarshal([]byte(signedPayload), &envelope); err != nil {
		return "", fmt.Errorf("invalid command envelope")
	}
	verifiedKey := false
	for _, key := range keys {
		if key.KeyID != envelope.KeyID {
			continue
		}
		publicKey, err := base64.StdEncoding.DecodeString(key.PublicKey)
		if err != nil || len(publicKey) != ed25519.PublicKeySize {
			continue
		}
		if !ed25519.Verify(ed25519.PublicKey(publicKey), []byte(signedPayload), decodedSignature) {
			continue
		}
		verifiedKey = true
		break
	}
	if !verifiedKey {
		return "", fmt.Errorf("command signature verification failed")
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
