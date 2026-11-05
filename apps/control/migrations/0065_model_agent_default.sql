ALTER TABLE model_providers
  ADD COLUMN IF NOT EXISTS is_agent_default boolean NOT NULL DEFAULT false;

CREATE UNIQUE INDEX IF NOT EXISTS model_providers_agent_default
  ON model_providers (tenant_id)
  WHERE is_agent_default;
