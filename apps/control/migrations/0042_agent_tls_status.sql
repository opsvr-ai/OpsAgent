ALTER TABLE agents ADD COLUMN IF NOT EXISTS tls_cert_expires_at timestamptz;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS tls_cert_serial text;
