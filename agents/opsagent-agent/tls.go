package main

import (
	"crypto/tls"
	"crypto/x509"
	"net/http"
	"os"
	"time"
)

// newHTTPClient returns a client that supports externally provisioned mTLS.
// Certificates are supplied by the installer; no CA/CSR lifecycle is embedded.
func newHTTPClient(timeout time.Duration) *http.Client {
	transport := http.DefaultTransport.(*http.Transport).Clone()
	config := &tls.Config{MinVersion: tls.VersionTLS12}
	if caFile := os.Getenv("OPSAGENT_TLS_CA"); caFile != "" {
		if pem, err := os.ReadFile(caFile); err == nil {
			pool := x509.NewCertPool()
			if pool.AppendCertsFromPEM(pem) {
				config.RootCAs = pool
			}
		}
	}
	certFile := os.Getenv("OPSAGENT_TLS_CERT")
	keyFile := os.Getenv("OPSAGENT_TLS_KEY")
	if certFile != "" && keyFile != "" {
		if pair, err := tls.LoadX509KeyPair(certFile, keyFile); err == nil {
			config.Certificates = []tls.Certificate{pair}
		}
	}
	transport.TLSClientConfig = config
	return &http.Client{Timeout: timeout, Transport: transport}
}
