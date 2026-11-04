package main

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"os"
	"path/filepath"
)

type certificateResponse struct {
	Certificate  string `json:"certificate"`
	CA           string `json:"ca"`
	SerialNumber string `json:"serialNumber"`
	ExpiresAt    string `json:"expiresAt"`
}

func enrollAgentCertificate(controlURL, agentID, agentKey, hostname string, paths agentPaths) error {
	if os.Getenv("OPSAGENT_AUTO_CSR") != "true" {
		return nil
	}
	dir := filepath.Join(paths.Root, "tls")
	certPath := os.Getenv("OPSAGENT_TLS_CERT")
	keyPath := os.Getenv("OPSAGENT_TLS_KEY")
	caPath := os.Getenv("OPSAGENT_TLS_CA")
	if certPath == "" {
		certPath = filepath.Join(dir, "agent.pem")
	}
	if keyPath == "" {
		keyPath = filepath.Join(dir, "agent-key.pem")
	}
	if caPath == "" {
		caPath = filepath.Join(dir, "ca.pem")
	}
	if _, err := os.Stat(certPath); err == nil {
		return nil
	}
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return err
	}
	csrDER, err := x509.CreateCertificateRequest(rand.Reader, &x509.CertificateRequest{
		Subject: pkix.Name{CommonName: "opsagent-" + hostname},
	}, key)
	if err != nil {
		return err
	}
	csrPEM := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE REQUEST", Bytes: csrDER})
	body, _ := json.Marshal(map[string]string{"agentKey": agentKey, "csr": string(csrPEM)})
	var response certificateResponse
	if err := post(controlURL+"/api/agents/"+agentID+"/certificate", nil, json.RawMessage(body), &response); err != nil {
		return err
	}
	if response.Certificate == "" {
		return fmt.Errorf("empty certificate")
	}
	if err := os.MkdirAll(filepath.Dir(certPath), 0o700); err != nil {
		return err
	}
	if err := os.WriteFile(certPath, []byte(response.Certificate), 0o600); err != nil {
		return err
	}
	keyDER, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		return err
	}
	if err := os.WriteFile(keyPath, pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: keyDER}), 0o600); err != nil {
		return err
	}
	if err := os.WriteFile(caPath, []byte(response.CA), 0o600); err != nil {
		return err
	}
	_ = os.Setenv("OPSAGENT_TLS_CERT", certPath)
	_ = os.Setenv("OPSAGENT_TLS_KEY", keyPath)
	_ = os.Setenv("OPSAGENT_TLS_CA", caPath)
	return nil
}
