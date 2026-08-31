/** PostgreSQL Repository providers for Qabot projections and integrations. */
import { randomUUID } from 'node:crypto'
import type { Sql } from 'postgres'
import type { AuditRecord } from '../audit/store.ts'
import type { Conversation } from '../conversation/store.ts'
import type { AuditRepository, ConversationRepository, OutboxRepository, TicketRepository } from '../domain/repositories.ts'
import type { OutboxEventType, OutboxMessage } from '../integration/outbox.ts'
import type { Ticket, TicketKind, TicketStatus } from '../ticket/store.ts'

interface ConversationRow {
  user_key: string
  session_id: string
  title: string
  created_at: string | number
  last_message_at: string | number
  message_count: number
}

function toConversation(row: ConversationRow): Conversation {
  return {
    userKey: row.user_key,
    sessionId: row.session_id,
    title: row.title,
    createdAt: Number(row.created_at),
    lastMessageAt: Number(row.last_message_at),
    messageCount: row.message_count,
  }
}

export class PostgresConversationRepository implements ConversationRepository {
  constructor(private readonly sql: Sql) {}

  async create(userKey: string, sessionId: string): Promise<void> {
    const now = Date.now()
    await this.sql`
      INSERT INTO conversations (user_key, session_id, title, created_at, last_message_at, message_count)
      VALUES (${userKey}, ${sessionId}, '新对话', ${now}, ${now}, 0)
      ON CONFLICT (user_key, session_id) DO NOTHING
    `
  }

  async touch(userKey: string, sessionId: string, messageCount: number, firstQuestion?: string): Promise<void> {
    await this.sql`
      UPDATE conversations
      SET title = CASE WHEN message_count = 0 AND ${firstQuestion ?? null}::text IS NOT NULL
            THEN ${firstQuestion ?? null}::text ELSE title END,
          last_message_at = ${Date.now()}, message_count = ${messageCount}
      WHERE user_key = ${userKey} AND session_id = ${sessionId}
    `
  }

  async findEmpty(userKey: string): Promise<Conversation | undefined> {
    const rows = await this.sql<ConversationRow[]>`
      SELECT user_key, session_id, title, created_at, last_message_at, message_count
      FROM conversations
      WHERE user_key = ${userKey} AND message_count = 0 AND archived_at IS NULL
      ORDER BY last_message_at DESC LIMIT 1
    `
    return rows[0] === undefined ? undefined : toConversation(rows[0])
  }

  async list(userKey: string): Promise<Conversation[]> {
    const rows = await this.sql<ConversationRow[]>`
      SELECT user_key, session_id, title, created_at, last_message_at, message_count
      FROM conversations WHERE user_key = ${userKey} AND archived_at IS NULL
      ORDER BY last_message_at DESC
    `
    return rows.map(toConversation)
  }

  async ownerOf(sessionId: string): Promise<string | undefined> {
    const rows = await this.sql<{ user_key: string }[]>`
      SELECT user_key FROM conversations WHERE session_id = ${sessionId} AND archived_at IS NULL LIMIT 1
    `
    return rows[0]?.user_key
  }

  async archive(userKey: string, sessionId: string): Promise<boolean> {
    const rows = await this.sql<{ session_id: string }[]>`
      UPDATE conversations SET archived_at = ${Date.now()}
      WHERE user_key = ${userKey} AND session_id = ${sessionId} AND archived_at IS NULL
      RETURNING session_id
    `
    return rows.length > 0
  }
}

interface AuditRow {
  id: string | number
  actor_id: string
  action: string
  resource_type: string
  resource_id: string
  detail: string | null
  created_at: string | number
}

function toAudit(row: AuditRow): AuditRecord {
  return {
    id: Number(row.id),
    actorId: row.actor_id,
    action: row.action,
    resourceType: row.resource_type,
    resourceId: row.resource_id,
    detail: row.detail,
    createdAt: Number(row.created_at),
  }
}

export class PostgresAuditRepository implements AuditRepository {
  constructor(private readonly sql: Sql) {}

  async append(input: Omit<AuditRecord, 'id' | 'createdAt'>): Promise<AuditRecord> {
    const createdAt = Date.now()
    const rows = await this.sql<AuditRow[]>`
      INSERT INTO audit_records (actor_id, action, resource_type, resource_id, detail, created_at)
      VALUES (${input.actorId}, ${input.action}, ${input.resourceType}, ${input.resourceId}, ${input.detail}, ${createdAt})
      RETURNING id, actor_id, action, resource_type, resource_id, detail, created_at
    `
    const row = rows[0]
    if (row === undefined) throw new Error('PostgreSQL 创建审计记录失败')
    return toAudit(row)
  }

  async list(limit = 100): Promise<AuditRecord[]> {
    const rows = await this.sql<AuditRow[]>`
      SELECT id, actor_id, action, resource_type, resource_id, detail, created_at
      FROM audit_records ORDER BY id DESC LIMIT ${limit}
    `
    return rows.map(toAudit)
  }
}

interface OutboxRow {
  id: string | number
  idempotency_key: string
  event_type: OutboxEventType
  payload_json: unknown
  attempts: number
}

function toOutbox(row: OutboxRow): OutboxMessage {
  return {
    id: Number(row.id),
    idempotencyKey: row.idempotency_key,
    type: row.event_type,
    payload: row.payload_json,
    attempts: row.attempts,
  }
}

export class PostgresOutboxRepository implements OutboxRepository {
  private readonly workerId = randomUUID()

  constructor(private readonly sql: Sql, private readonly leaseMs = 5 * 60_000) {}

  async enqueue(idempotencyKey: string, type: OutboxEventType, payload: unknown): Promise<boolean> {
    const now = Date.now()
    if (payload === undefined) throw new Error('Outbox payload 必须可序列化为 JSON')
    const payloadJson = JSON.stringify(payload)
    const rows = await this.sql<{ id: string | number }[]>`
      INSERT INTO outbox_messages
        (idempotency_key, event_type, payload_json, available_at, created_at)
      VALUES (${idempotencyKey}, ${type}, ${payloadJson}::jsonb, ${now}, ${now})
      ON CONFLICT (idempotency_key) DO NOTHING RETURNING id
    `
    return rows.length > 0
  }

  async pending(limit = 20, now = Date.now()): Promise<OutboxMessage[]> {
    return await this.sql.begin(async (transaction) => {
      await transaction`
        UPDATE outbox_messages
        SET status = 'pending', claimed_at = NULL, claimed_by = NULL
        WHERE status = 'processing' AND claimed_at < ${now - this.leaseMs}
      `
      const rows = await transaction<OutboxRow[]>`
        SELECT id, idempotency_key, event_type, payload_json, attempts
        FROM outbox_messages
        WHERE status = 'pending' AND available_at <= ${now}
        ORDER BY id FOR UPDATE SKIP LOCKED LIMIT ${limit}
      `
      if (rows.length === 0) return []
      const ids = rows.map(row => Number(row.id))
      await transaction`
        UPDATE outbox_messages SET status = 'processing', claimed_at = ${now}, claimed_by = ${this.workerId}
        WHERE id IN ${transaction(ids)}
      `
      return rows.map(toOutbox)
    })
  }

  async complete(id: number): Promise<void> {
    await this.sql`
      UPDATE outbox_messages SET status = 'completed', completed_at = ${Date.now()}, last_error = NULL,
        claimed_at = NULL, claimed_by = NULL
      WHERE id = ${id} AND status = 'processing' AND claimed_by = ${this.workerId}
    `
  }

  async retry(id: number, error: string, delayMs: number, maxAttempts: number): Promise<void> {
    await this.sql`
      UPDATE outbox_messages
      SET attempts = attempts + 1,
          status = CASE WHEN attempts + 1 >= ${maxAttempts} THEN 'failed' ELSE 'pending' END,
          available_at = ${Date.now() + delayMs}, last_error = ${error.slice(0, 2_000)},
          claimed_at = NULL, claimed_by = NULL
      WHERE id = ${id} AND status = 'processing' AND claimed_by = ${this.workerId}
    `
  }

  async count(status: 'pending' | 'completed' | 'failed'): Promise<number> {
    const rows = await this.sql<{ count: string | number }[]>`
      SELECT COUNT(*) AS count FROM outbox_messages WHERE status = ${status}
    `
    return Number(rows[0]?.count ?? 0)
  }
}

interface TicketRow {
  id: string | number
  session_id: string
  user_key: string
  kind: TicketKind
  status: TicketStatus
  department: string | null
  assignee: string | null
  question: string
  service_start: string | number | null
  service_end: string | number | null
  satisfaction: number | null
  handoff_reason: string | null
  created_at: string | number
  updated_at: string | number
  version: number
}

function nullableNumber(value: string | number | null): number | null {
  return value === null ? null : Number(value)
}

function toTicket(row: TicketRow): Ticket {
  return {
    id: Number(row.id),
    sessionId: row.session_id,
    userKey: row.user_key,
    kind: row.kind,
    status: row.status,
    priority: 'normal',
    department: row.department,
    assignee: row.assignee,
    question: row.question,
    serviceStart: nullableNumber(row.service_start),
    serviceEnd: nullableNumber(row.service_end),
    satisfaction: row.satisfaction,
    handoffReason: row.handoff_reason,
    firstResponseDueAt: null,
    resolutionDueAt: null,
    firstAgentResponseAt: null,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    version: row.version,
  }
}

interface ReplyRow {
  id: string | number
  message: string
  created_at: string | number
}

function toReply(row: ReplyRow): { id: number; message: string; createdAt: number } {
  return { id: Number(row.id), message: row.message, createdAt: Number(row.created_at) }
}

export class PostgresTicketRepository implements TicketRepository {
  constructor(private readonly sql: Sql) {}

  async get(id: number): Promise<Ticket | undefined> {
    const rows = await this.sql<TicketRow[]>`SELECT * FROM tickets WHERE id = ${id}`
    return rows[0] === undefined ? undefined : toTicket(rows[0])
  }

  async replies(ticketId: number): Promise<Array<{ id: number; message: string; createdAt: number }>> {
    const rows = await this.sql<ReplyRow[]>`
      SELECT id, message, created_at FROM ticket_replies WHERE ticket_id = ${ticketId} ORDER BY id
    `
    return rows.map(toReply)
  }

  async addReply(ticketId: number, message: string): Promise<number> {
    const rows = await this.sql<{ id: string | number }[]>`
      INSERT INTO ticket_replies (ticket_id, message, created_at)
      VALUES (${ticketId}, ${message}, ${Date.now()}) RETURNING id
    `
    const id = rows[0]?.id
    if (id === undefined) throw new Error('PostgreSQL 创建工单回复失败')
    return Number(id)
  }

  async repliesBySession(sessionId: string): Promise<Array<{ id: number; message: string; createdAt: number }>> {
    const rows = await this.sql<ReplyRow[]>`
      SELECT r.id, r.message, r.created_at
      FROM ticket_replies r JOIN tickets t ON t.id = r.ticket_id
      WHERE t.session_id = ${sessionId} ORDER BY r.id
    `
    return rows.map(toReply)
  }

  async listByGroup(group: string, limit = 50): Promise<Ticket[]> {
    const rows = await this.sql<TicketRow[]>`
      SELECT * FROM tickets WHERE department = ${group} ORDER BY id DESC LIMIT ${limit}
    `
    return rows.map(toTicket)
  }

  async forSession(sessionId: string): Promise<Ticket | undefined> {
    const rows = await this.sql<TicketRow[]>`
      SELECT * FROM tickets WHERE session_id = ${sessionId} ORDER BY id DESC LIMIT 1
    `
    return rows[0] === undefined ? undefined : toTicket(rows[0])
  }

  async ensureOpen(input: { sessionId: string; userKey: string; question: string }): Promise<Ticket> {
    return await this.sql.begin(async (transaction) => {
      const existing = await transaction<TicketRow[]>`
        SELECT * FROM tickets WHERE session_id = ${input.sessionId} ORDER BY id DESC LIMIT 1 FOR UPDATE
      `
      const row = existing[0]
      if (row !== undefined && row.status !== 'closed' && row.status !== 'resolved') {
        const updated = await transaction<TicketRow[]>`
          UPDATE tickets SET updated_at = ${Date.now()} WHERE id = ${row.id} RETURNING *
        `
        const current = updated[0]
        if (current === undefined) throw new Error('PostgreSQL 更新工单失败')
        return toTicket(current)
      }
      const now = Date.now()
      const inserted = await transaction<TicketRow[]>`
        INSERT INTO tickets (session_id, user_key, question, created_at, updated_at)
        VALUES (${input.sessionId}, ${input.userKey}, ${input.question}, ${now}, ${now}) RETURNING *
      `
      const created = inserted[0]
      if (created === undefined) throw new Error('PostgreSQL 创建工单失败')
      return toTicket(created)
    })
  }

  async openService(sessionId: string): Promise<void> {
    const now = Date.now()
    await this.sql`
      UPDATE tickets SET service_start = COALESCE(service_start, ${now}), updated_at = ${now}
      WHERE session_id = ${sessionId} AND status IN ('open', 'waiting_agent', 'reopened')
    `
  }

  async closeService(sessionId: string): Promise<void> {
    const now = Date.now()
    await this.sql`
      UPDATE tickets SET service_end = ${now}, updated_at = ${now}
      WHERE session_id = ${sessionId} AND service_end IS NULL
    `
  }

  async markHandoff(sessionId: string, reason: string, group?: string): Promise<void> {
    await this.sql`
      UPDATE tickets SET status = 'waiting_agent', handoff_reason = ${reason},
        department = COALESCE(${group ?? null}::text, department), updated_at = ${Date.now()}, version = version + 1
      WHERE session_id = ${sessionId}
    `
  }

  async assign(ticketId: number, assignee: string, department: string | null): Promise<void> {
    await this.sql`
      UPDATE tickets SET assignee = ${assignee}, department = ${department}, kind = 'human', updated_at = ${Date.now()}
      WHERE id = ${ticketId}
    `
  }

  async accept(ticketId: number, assignee: string, expectedVersion?: number): Promise<boolean> {
    const rows = expectedVersion === undefined
      ? await this.sql<{ id: string | number }[]>`
          UPDATE tickets SET status = 'in_service', assignee = ${assignee}, kind = 'human',
            updated_at = ${Date.now()}, version = version + 1
          WHERE id = ${ticketId} AND status IN ('waiting_agent', 'open', 'reopened') RETURNING id
        `
      : await this.sql<{ id: string | number }[]>`
          UPDATE tickets SET status = 'in_service', assignee = ${assignee}, kind = 'human',
            updated_at = ${Date.now()}, version = version + 1
          WHERE id = ${ticketId} AND status IN ('waiting_agent', 'open', 'reopened')
            AND version = ${expectedVersion} RETURNING id
        `
    return rows.length > 0
  }

  async reply(ticketId: number, message: string, expectedVersion: number): Promise<number | undefined> {
    return await this.sql.begin(async (transaction) => {
      const updated = await transaction<{ id: string | number }[]>`
        UPDATE tickets SET status = 'waiting_employee', updated_at = ${Date.now()}, version = version + 1
        WHERE id = ${ticketId} AND version = ${expectedVersion}
          AND status IN ('in_service', 'waiting_employee') RETURNING id
      `
      if (updated.length === 0) return undefined
      const replies = await transaction<{ id: string | number }[]>`
        INSERT INTO ticket_replies (ticket_id, message, created_at)
        VALUES (${ticketId}, ${message}, ${Date.now()}) RETURNING id
      `
      const id = replies[0]?.id
      if (id === undefined) throw new Error('PostgreSQL 创建工单回复失败')
      return Number(id)
    })
  }

  async transfer(ticketId: number, toGroup: string, note: string | null, expectedVersion?: number): Promise<boolean> {
    const reason = note ?? `转接到${toGroup}`
    const rows = expectedVersion === undefined
      ? await this.sql<{ id: string | number }[]>`
          UPDATE tickets SET department = ${toGroup}, assignee = NULL, status = 'waiting_agent',
            handoff_reason = COALESCE(${reason}, handoff_reason), updated_at = ${Date.now()}, version = version + 1
          WHERE id = ${ticketId} AND status IN ('open', 'waiting_agent', 'in_service', 'waiting_employee', 'reopened')
          RETURNING id
        `
      : await this.sql<{ id: string | number }[]>`
          UPDATE tickets SET department = ${toGroup}, assignee = NULL, status = 'waiting_agent',
            handoff_reason = COALESCE(${reason}, handoff_reason), updated_at = ${Date.now()}, version = version + 1
          WHERE id = ${ticketId} AND status IN ('open', 'waiting_agent', 'in_service', 'waiting_employee', 'reopened')
            AND version = ${expectedVersion} RETURNING id
        `
    return rows.length > 0
  }

  async resolve(sessionId: string): Promise<void> {
    await this.sql`
      UPDATE tickets SET status = 'resolved', updated_at = ${Date.now()}, version = version + 1
      WHERE session_id = ${sessionId} AND status = 'open'
    `
  }

  async closeStaleOpen(cutoff: number): Promise<number> {
    const now = Date.now()
    const rows = await this.sql<Array<{ id: number }>>`
      UPDATE tickets SET status = 'closed', service_end = COALESCE(service_end, ${now}),
        updated_at = ${now}, version = version + 1
      WHERE status = 'open' AND updated_at <= ${cutoff}
      RETURNING id
    `
    return rows.length
  }

  async close(ticketId: number, satisfaction: number | null, expectedVersion?: number): Promise<boolean> {
    const rows = expectedVersion === undefined
      ? await this.sql<{ id: string | number }[]>`
          UPDATE tickets SET status = 'closed', satisfaction = ${satisfaction}, updated_at = ${Date.now()},
            version = version + 1 WHERE id = ${ticketId} RETURNING id
        `
      : await this.sql<{ id: string | number }[]>`
          UPDATE tickets SET status = 'closed', satisfaction = ${satisfaction}, updated_at = ${Date.now()},
            version = version + 1 WHERE id = ${ticketId} AND version = ${expectedVersion} RETURNING id
        `
    return rows.length > 0
  }

  async rate(ticketId: number, satisfaction: number, expectedVersion?: number): Promise<boolean> {
    const rows = expectedVersion === undefined
      ? await this.sql<{ id: string | number }[]>`
          UPDATE tickets SET satisfaction = ${satisfaction}, updated_at = ${Date.now()}, version = version + 1
          WHERE id = ${ticketId} RETURNING id
        `
      : await this.sql<{ id: string | number }[]>`
          UPDATE tickets SET satisfaction = ${satisfaction}, updated_at = ${Date.now()}, version = version + 1
          WHERE id = ${ticketId} AND version = ${expectedVersion} AND status IN ('resolved', 'closed')
            AND satisfaction IS NULL RETURNING id
        `
    return rows.length > 0
  }

  async findPendingRating(userKey: string): Promise<Ticket | undefined> {
    const rows = await this.sql<TicketRow[]>`
      SELECT * FROM tickets WHERE user_key = ${userKey} AND status = 'closed' AND satisfaction IS NULL
      ORDER BY id DESC LIMIT 1
    `
    return rows[0] === undefined ? undefined : toTicket(rows[0])
  }

  async list(filter: { status?: TicketStatus; assignee?: string; userKey?: string; limit?: number } = {}): Promise<Ticket[]> {
    const status = filter.status ?? null
    const assignee = filter.assignee ?? null
    const userKey = filter.userKey ?? null
    const rows = await this.sql<TicketRow[]>`
      SELECT * FROM tickets
      WHERE (${status}::text IS NULL OR status = ${status})
        AND (${assignee}::text IS NULL OR assignee = ${assignee})
        AND (${userKey}::text IS NULL OR user_key = ${userKey})
      ORDER BY id DESC LIMIT ${filter.limit ?? 50}
    `
    return rows.map(toTicket)
  }

  async stats(since?: number): Promise<{
    count: number
    handoffCount: number
    resolvedCount: number
    avgServiceMs: number | null
    avgSatisfaction: number | null
  }> {
    const rows = await this.sql<{
      count: string | number
      handoff_count: string | number
      resolved_count: string | number
      avg_service_ms: string | number | null
      avg_satisfaction: string | number | null
    }[]>`
      SELECT COUNT(*) AS count,
        COUNT(*) FILTER (WHERE status = 'waiting_agent') AS handoff_count,
        COUNT(*) FILTER (WHERE status IN ('resolved', 'closed')) AS resolved_count,
        AVG(service_end - service_start) AS avg_service_ms,
        AVG(satisfaction) AS avg_satisfaction
      FROM tickets WHERE (${since ?? null}::bigint IS NULL OR created_at >= ${since ?? null})
    `
    const row = rows[0]
    if (row === undefined) throw new Error('PostgreSQL 工单统计失败')
    return {
      count: Number(row.count),
      handoffCount: Number(row.handoff_count),
      resolvedCount: Number(row.resolved_count),
      avgServiceMs: nullableNumber(row.avg_service_ms),
      avgSatisfaction: nullableNumber(row.avg_satisfaction),
    }
  }
}
