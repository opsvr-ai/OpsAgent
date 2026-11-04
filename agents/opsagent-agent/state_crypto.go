package main

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"fmt"
	"io"
	"strings"
)

const encryptedStatePrefix = "enc:v1:"

func stateKey(secret string) []byte {
	sum := sha256.Sum256([]byte(secret))
	return sum[:]
}

func encryptStateSecret(plaintext, secret string) (string, error) {
	if secret == "" || plaintext == "" || strings.HasPrefix(plaintext, encryptedStatePrefix) {
		return plaintext, nil
	}
	block, err := aes.NewCipher(stateKey(secret))
	if err != nil {
		return "", err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}
	nonce := make([]byte, gcm.NonceSize())
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return "", err
	}
	ciphertext := gcm.Seal(nil, nonce, []byte(plaintext), nil)
	return encryptedStatePrefix + base64.StdEncoding.EncodeToString(append(nonce, ciphertext...)), nil
}

func decryptStateSecret(encoded, secret string) (string, error) {
	if !strings.HasPrefix(encoded, encryptedStatePrefix) {
		return encoded, nil
	}
	if secret == "" {
		return "", fmt.Errorf("state secret is required to decrypt agent state")
	}
	raw, err := base64.StdEncoding.DecodeString(strings.TrimPrefix(encoded, encryptedStatePrefix))
	if err != nil {
		return "", err
	}
	block, err := aes.NewCipher(stateKey(secret))
	if err != nil {
		return "", err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}
	if len(raw) < gcm.NonceSize() {
		return "", fmt.Errorf("encrypted state is truncated")
	}
	nonce, ciphertext := raw[:gcm.NonceSize()], raw[gcm.NonceSize():]
	plaintext, err := gcm.Open(nil, nonce, ciphertext, nil)
	if err != nil {
		return "", fmt.Errorf("decrypt agent state: %w", err)
	}
	return string(plaintext), nil
}
