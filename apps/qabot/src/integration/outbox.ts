/** Persistent delivery queue for Qabot integrations. */
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { OutboxRepository } from '../domain/repositories.ts'

export type OutboxEventType = 'ticket.handoff'

export interface OutboxMessage {
  id: number
  idempotencyKey: string
  type: OutboxEventType
  payload: unknown
  attempts: number
}

interface OutboxRow {
  id: number
  idempotency_key: string
  event_type: OutboxEventType
  payload_json: string
  attempts: number
}

export class OutboxStore implements OutboxRepository {
  private readonly db: DatabaseSync

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    this.db = new DatabaseSync(path)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS outbox_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        idempotency_key TEXT NOT NULL UNIQUE,
        event_type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0,
        available_at INTEGER NOT NULL,
        last_error TEXT,
        created_at INTEGER NOT NULL,
        completed_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_outbox_pending
        ON outbox_messages (status, available_at, id);
    `)
  }

  enqueue(idempotencyKey: string, type: OutboxEventType, payload: unknown): boolean {
    const now = Date.now()
    const result = this.db.prepare(`
      INSERT OR IGNORE INTO outbox_messages
        (idempotency_key, event_type, payload_json, available_at, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(idempotencyKey, type, JSON.stringify(payload), now, now)
    return Number(result.changes) > 0
  }

  pending(limit = 20, now = Date.now()): OutboxMessage[] {
    const rows = this.db.prepare(`
      SELECT id, idempotency_key, event_type, payload_json, attempts
      FROM outbox_messages
      WHERE status = 'pending' AND available_at <= ?
      ORDER BY id LIMIT ?
    `).all(now, limit) as unknown as OutboxRow[]
    return rows.map(row => ({
      id: row.id,
      idempotencyKey: row.idempotency_key,
      type: row.event_type,
      payload: JSON.parse(row.payload_json) as unknown,
      attempts: row.attempts,
    }))
  }

  complete(id: number): void {
    this.db.prepare(`
      UPDATE outbox_messages SET status = 'completed', completed_at = ?, last_error = NULL WHERE id = ?
    `).run(Date.now(), id)
  }

  retry(id: number, error: string, delayMs: number, maxAttempts: number): void {
    this.db.prepare(`
      UPDATE outbox_messages
      SET attempts = attempts + 1,
          status = CASE WHEN attempts + 1 >= ? THEN 'failed' ELSE 'pending' END,
          available_at = ?, last_error = ?
      WHERE id = ?
    `).run(maxAttempts, Date.now() + delayMs, error.slice(0, 2_000), id)
  }

  count(status: 'pending' | 'completed' | 'failed'): number {
    const row = this.db.prepare('SELECT COUNT(*) AS count FROM outbox_messages WHERE status = ?').get(status) as { count: number }
    return row.count
  }

  dispose(): void {
    this.db.close()
  }
}

export type OutboxHandler = (payload: unknown, idempotencyKey: string) => Promise<void>

export class OutboxWorker {
  private running = false

  constructor(
    private readonly store: OutboxRepository,
    private readonly handlers: Readonly<Partial<Record<OutboxEventType, OutboxHandler>>>,
    private readonly maxAttempts = 8,
  ) {}

  async runOnce(): Promise<number> {
    if (this.running) return 0
    this.running = true
    let delivered = 0
    try {
      for (const message of await this.store.pending()) {
        const handler = this.handlers[message.type]
        if (handler === undefined) continue
        try {
          await handler(message.payload, message.idempotencyKey)
          await this.store.complete(message.id)
          delivered++
        } catch (error) {
          const delayMs = Math.min(60_000, 1_000 * 2 ** message.attempts)
          await this.store.retry(message.id, error instanceof Error ? error.message : String(error), delayMs, this.maxAttempts)
        }
      }
      return delivered
    } finally {
      this.running = false
    }
  }
}
