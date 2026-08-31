/** Durable audit records for privileged Qabot operations. */
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { AuditRepository } from '../domain/repositories.ts'

export interface AuditRecord {
  id: number
  actorId: string
  action: string
  resourceType: string
  resourceId: string
  detail: string | null
  createdAt: number
}

interface AuditRow {
  id: number
  actor_id: string
  action: string
  resource_type: string
  resource_id: string
  detail: string | null
  created_at: number
}

export class AuditStore implements AuditRepository {
  private readonly db: DatabaseSync

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    this.db = new DatabaseSync(path)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS audit_records (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        actor_id TEXT NOT NULL,
        action TEXT NOT NULL,
        resource_type TEXT NOT NULL,
        resource_id TEXT NOT NULL,
        detail TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_audit_resource
        ON audit_records (resource_type, resource_id, id DESC);
      CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_records (actor_id, id DESC);
    `)
  }

  append(input: Omit<AuditRecord, 'id' | 'createdAt'>): AuditRecord {
    const createdAt = Date.now()
    const result = this.db.prepare(`
      INSERT INTO audit_records (actor_id, action, resource_type, resource_id, detail, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(input.actorId, input.action, input.resourceType, input.resourceId, input.detail, createdAt)
    return { id: Number(result.lastInsertRowid), ...input, createdAt }
  }

  list(limit = 100): AuditRecord[] {
    const rows = this.db.prepare('SELECT * FROM audit_records ORDER BY id DESC LIMIT ?').all(limit) as unknown as AuditRow[]
    return rows.map(row => ({
      id: row.id,
      actorId: row.actor_id,
      action: row.action,
      resourceType: row.resource_type,
      resourceId: row.resource_id,
      detail: row.detail,
      createdAt: row.created_at,
    }))
  }

  dispose(): void {
    this.db.close()
  }
}
