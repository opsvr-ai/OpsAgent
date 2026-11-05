ALTER TABLE model_providers
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
