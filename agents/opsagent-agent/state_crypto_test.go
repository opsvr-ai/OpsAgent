package main

import (
	"strings"
	"testing"
)

func TestEncryptDecryptStateSecret(t *testing.T) {
	plaintext := "result-private-seed"
	encrypted, err := encryptStateSecret(plaintext, "state-secret")
	if err != nil {
		t.Fatal(err)
	}
	if encrypted == plaintext || !strings.HasPrefix(encrypted, encryptedStatePrefix) {
		t.Fatalf("state was not encrypted: %q", encrypted)
	}
	decrypted, err := decryptStateSecret(encrypted, "state-secret")
	if err != nil {
		t.Fatal(err)
	}
	if decrypted != plaintext {
		t.Fatalf("decrypted = %q", decrypted)
	}
	if _, err := decryptStateSecret(encrypted, "wrong-secret"); err == nil {
		t.Fatal("wrong secret accepted")
	}
}

func TestEncryptStateSecretIsIdempotentForEncryptedInput(t *testing.T) {
	encrypted, err := encryptStateSecret("seed", "secret")
	if err != nil {
		t.Fatal(err)
	}
	again, err := encryptStateSecret(encrypted, "secret")
	if err != nil {
		t.Fatal(err)
	}
	if again != encrypted {
		t.Fatal("already encrypted value was re-encrypted")
	}
}
