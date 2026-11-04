ALTER TABLE agent_instruction_templates
  ADD COLUMN IF NOT EXISTS scope text NOT NULL DEFAULT 'tenant';

ALTER TABLE agent_instruction_templates
  DROP CONSTRAINT IF EXISTS agent_instruction_templates_scope_check;

ALTER TABLE agent_instruction_templates
  ADD CONSTRAINT agent_instruction_templates_scope_check
  CHECK (scope IN ('private', 'tenant'));
