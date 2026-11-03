import type { Pool } from 'pg';
import { redactMetadata } from './redact.js';

export type AuditAction =
  | 'auth.login'
  | 'auth.local_admin'
  | 'auth.logout'
  | 'tenant.select'
  | 'tenant.access.denied'
  | 'session.create'
  | 'tool.call'
  | 'approval.decide'
  | 'connector.create'
  | 'connector.test';

export interface AuditEventInput {
  readonly tenantId?: string | null;
  readonly actorId?: string | null;
  readonly action: AuditAction;
  readonly resource?: string;
  readonly result: 'success' | 'failure' | 'denied';
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface AuditWriter {
  write(event: AuditEventInput): Promise<void>;
}

export class PgAuditWriter implements AuditWriter {
  constructor(private readonly pool: Pool) {}

  async write(event: AuditEventInput): Promise<void> {
    const metadata = redactMetadata(event.metadata ?? {});
    await this.pool.query(
      `INSERT INTO audit_events (tenant_id, actor_id, action, resource, result, metadata)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
      [
        event.tenantId ?? null,
        event.actorId ?? null,
        event.action,
        event.resource ?? null,
        event.result,
        JSON.stringify(metadata),
      ],
    );
  }
}
