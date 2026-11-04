package main

import (
	"crypto/ed25519"
	"encoding/base64"
	"fmt"
)

func verifyCommandSignature(publicKeyBase64, signedPayload, signature string) error {
	if publicKeyBase64 == "" {
		return fmt.Errorf("command signing key is not configured")
	}
	if signedPayload == "" || signature == "" {
		return fmt.Errorf("command is not signed")
	}
	publicKey, err := base64.StdEncoding.DecodeString(publicKeyBase64)
	if err != nil || len(publicKey) != ed25519.PublicKeySize {
		return fmt.Errorf("invalid command public key")
	}
	decodedSignature, err := base64.StdEncoding.DecodeString(signature)
	if err != nil || len(decodedSignature) != ed25519.SignatureSize {
		return fmt.Errorf("invalid command signature")
	}
	if !ed25519.Verify(ed25519.PublicKey(publicKey), []byte(signedPayload), decodedSignature) {
		return fmt.Errorf("command signature verification failed")
	}
	return nil
}
