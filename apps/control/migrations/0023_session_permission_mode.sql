ALTER TABLE runtime_sessions
  ADD COLUMN IF NOT EXISTS permission_mode text NOT NULL DEFAULT 'danger-full-access';

ALTER TABLE runtime_sessions
  DROP CONSTRAINT IF EXISTS runtime_sessions_permission_mode_check;

ALTER TABLE runtime_sessions
  ADD CONSTRAINT runtime_sessions_permission_mode_check
  CHECK (permission_mode IN ('read-only', 'workspace-write', 'danger-full-access', 'auto-review'));
