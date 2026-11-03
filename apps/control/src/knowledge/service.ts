import type { Pool } from 'pg';

export interface KnowledgeDocument {
  readonly id: string;
  readonly title: string;
  readonly body: string;
  readonly status: string;
}

export class KnowledgeService {
  constructor(private readonly pool: Pool) {}

  async create(input: {
    tenantId: string;
    actorId: string;
    title: string;
    body: string;
  }): Promise<KnowledgeDocument> {
    const result = await this.pool.query(
      `INSERT INTO knowledge_documents (tenant_id, title, body, created_by)
       VALUES ($1, $2, $3, $4)
       RETURNING id, title, body, status`,
      [input.tenantId, input.title, input.body, input.actorId],
    );
    return this.map(result.rows[0]);
  }

  async list(tenantId: string, query?: string): Promise<KnowledgeDocument[]> {
    const result = query
      ? await this.pool.query(
          `SELECT id, title, body, status FROM knowledge_documents
           WHERE tenant_id = $1 AND (title ILIKE $2 OR body ILIKE $2)
           ORDER BY updated_at DESC`,
          [tenantId, `%${query}%`],
        )
      : await this.pool.query(
          `SELECT id, title, body, status FROM knowledge_documents
           WHERE tenant_id = $1 ORDER BY updated_at DESC`,
          [tenantId],
        );
    return result.rows.map((row) => this.map(row));
  }

  async publish(tenantId: string, id: string): Promise<KnowledgeDocument | null> {
    const result = await this.pool.query(
      `UPDATE knowledge_documents SET status = 'published', updated_at = now()
       WHERE tenant_id = $1 AND id = $2
       RETURNING id, title, body, status`,
      [tenantId, id],
    );
    return result.rows[0] ? this.map(result.rows[0]) : null;
  }

  private map(row: {
    id: string;
    title: string;
    body: string;
    status: string;
  }): KnowledgeDocument {
    return { id: row.id, title: row.title, body: row.body, status: row.status };
  }
}
