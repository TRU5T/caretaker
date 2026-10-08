package config

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/hex"
	"encoding/pem"
	"errors"
	"fmt"
	"math/big"
	"os"
	"path/filepath"
	"time"
)

// AgentCert is the agent's long-lived self-signed TLS identity. The hub pins
// it at pairing time, so it is never validated against a CA or hostname.
type AgentCert struct {
	TLS     tls.Certificate
	PEM     string
	SHA256  string // lowercase hex of the certificate DER
	CertDER []byte
}

// CertPaths returns where the certificate and key live next to the config.
func CertPaths(cfgPath string) (certFile, keyFile string) {
	dir := filepath.Dir(cfgPath)
	return filepath.Join(dir, "agent-cert.pem"), filepath.Join(dir, "agent-key.pem")
}

// LoadOrCreateCert reads the agent certificate, generating one on first run.
func LoadOrCreateCert(cfgPath string) (*AgentCert, error) {
	certFile, keyFile := CertPaths(cfgPath)
	certPEM, certErr := os.ReadFile(certFile)
	keyPEM, keyErr := os.ReadFile(keyFile)
	if certErr == nil && keyErr == nil {
		return parseCert(certPEM, keyPEM)
	}
	if (certErr != nil && !errors.Is(certErr, os.ErrNotExist)) || (keyErr != nil && !errors.Is(keyErr, os.ErrNotExist)) {
		return nil, fmt.Errorf("read agent certificate: %v %v", certErr, keyErr)
	}

	if err := EnsurePrivateDir(filepath.Dir(cfgPath)); err != nil {
		return nil, err
	}
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, err
	}
	serial, err := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 127))
	if err != nil {
		return nil, err
	}
	host, _ := os.Hostname()
	tmpl := &x509.Certificate{
		SerialNumber: serial,
		Subject:      pkix.Name{CommonName: "caretaker-agent " + host},
		NotBefore:    time.Now().Add(-time.Hour),
		NotAfter:     time.Now().AddDate(20, 0, 0),
		// Self-signed and used as its own trust anchor by the hub's pin
		IsCA:                  true,
		BasicConstraintsValid: true,
		KeyUsage:              x509.KeyUsageDigitalSignature | x509.KeyUsageCertSign,
		ExtKeyUsage:           []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		return nil, err
	}
	keyDER, err := x509.MarshalECPrivateKey(key)
	if err != nil {
		return nil, err
	}
	certPEM = pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})
	keyPEM = pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: keyDER})
	if err := os.WriteFile(keyFile, keyPEM, 0o600); err != nil {
		return nil, err
	}
	if err := os.WriteFile(certFile, certPEM, 0o600); err != nil {
		return nil, err
	}
	return parseCert(certPEM, keyPEM)
}

func parseCert(certPEM, keyPEM []byte) (*AgentCert, error) {
	pair, err := tls.X509KeyPair(certPEM, keyPEM)
	if err != nil {
		return nil, fmt.Errorf("parse agent certificate: %w", err)
	}
	der := pair.Certificate[0]
	sum := sha256.Sum256(der)
	return &AgentCert{
		TLS:     pair,
		PEM:     string(certPEM),
		SHA256:  hex.EncodeToString(sum[:]),
		CertDER: der,
	}, nil
}
