/** MySQL Repository providers for Qabot projections and integrations. */
import { randomUUID } from 'node:crypto'
import type { Pool, PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise'
import type { AuditRecord } from '../audit/store.ts'
import type { Conversation } from '../conversation/store.ts'
import type {
  AuditRepository,
  ConversationMessage,
  ConversationMessageProjection,
  ConversationMessageRepository,
  ConversationRepository,
  OutboxRepository,
  TicketRepository,
} from '../domain/repositories.ts'
import type { OutboxEventType, OutboxMessage } from '../integration/outbox.ts'
import type { Ticket, TicketKind, TicketStatus } from '../ticket/store.ts'

interface ConversationRow extends RowDataPacket {
  user_key: string
  session_id: string
  title: string
  created_at: number
  last_message_at: number
  message_count: number
}

function toConversation(row: ConversationRow): Conversation {
  return {
    userKey: row.user_key,
    sessionId: row.session_id,
    title: row.title,
    createdAt: row.created_at,
    lastMessageAt: row.last_message_at,
    messageCount: row.message_count,
  }
}

export class MysqlConversationRepository implements ConversationRepository {
  constructor(private readonly pool: Pool) {}

  async create(userKey: string, sessionId: string): Promise<void> {
    const now = Date.now()
    await this.pool.execute(`
      INSERT INTO conversations (user_key, session_id, title, created_at, last_message_at, message_count)
      VALUES (?, ?, '新对话', ?, ?, 0)
      ON DUPLICATE KEY UPDATE session_id = VALUES(session_id)
    `, [userKey, sessionId, now, now])
  }

  async touch(userKey: string, sessionId: string, messageCount: number, firstQuestion?: string): Promise<void> {
    await this.pool.execute(`
      UPDATE conversations
      SET title = CASE WHEN message_count = 0 AND ? IS NOT NULL THEN ? ELSE title END,
          last_message_at = ?, message_count = ?
      WHERE user_key = ? AND session_id = ?
    `, [firstQuestion ?? null, firstQuestion ?? null, Date.now(), messageCount, userKey, sessionId])
  }

  async findEmpty(userKey: string): Promise<Conversation | undefined> {
    const [rows] = await this.pool.execute<ConversationRow[]>(`
      SELECT user_key, session_id, title, created_at, last_message_at, message_count
      FROM conversations WHERE user_key = ? AND message_count = 0 AND archived_at IS NULL
      ORDER BY last_message_at DESC LIMIT 1
    `, [userKey])
    return rows[0] === undefined ? undefined : toConversation(rows[0])
  }

  async list(userKey: string): Promise<Conversation[]> {
    const [rows] = await this.pool.execute<ConversationRow[]>(`
      SELECT user_key, session_id, title, created_at, last_message_at, message_count
      FROM conversations WHERE user_key = ? AND archived_at IS NULL ORDER BY last_message_at DESC
    `, [userKey])
    return rows.map(toConversation)
  }

  async listAll(): Promise<Conversation[]> {
    const [rows] = await this.pool.query<ConversationRow[]>(`
      SELECT user_key, session_id, title, created_at, last_message_at, message_count
      FROM conversations WHERE archived_at IS NULL ORDER BY last_message_at DESC
    `)
    return rows.map(toConversation)
  }

  async ownerOf(sessionId: string): Promise<string | undefined> {
    const [rows] = await this.pool.execute<Array<RowDataPacket & { user_key: string }>>(
      'SELECT user_key FROM conversations WHERE session_id = ? AND archived_at IS NULL LIMIT 1',
      [sessionId],
    )
    return rows[0]?.user_key
  }

  async archive(userKey: string, sessionId: string): Promise<boolean> {
    const [result] = await this.pool.execute<ResultSetHeader>(`
      UPDATE conversations SET archived_at = ?
      WHERE user_key = ? AND session_id = ? AND archived_at IS NULL
    `, [Date.now(), userKey, sessionId])
    return result.affectedRows > 0
  }
}

interface ConversationMessageRow extends RowDataPacket {
  id: number
  session_id: string
  source_type: ConversationMessage['sourceType']
  source_id: string
  source_order: number
  role: ConversationMessage['role']
  content: string
  media_json: unknown
  created_at: number
}

function parseMessageImages(value: unknown): ConversationMessage['images'] {
  if (value === null) return undefined
  const parsed = typeof value === 'string' ? JSON.parse(value) as unknown : value
  return Array.isArray(parsed) ? parsed as ConversationMessage['images'] : undefined
}

/** MySQL projection used by employee and service-desk timeline queries. */
export class MysqlConversationMessageRepository implements ConversationMessageRepository {
  constructor(private readonly pool: Pool) {}

  async upsert(messages: readonly ConversationMessageProjection[]): Promise<void> {
    if (messages.length === 0) return
    const projectedAt = Date.now()
    const connection = await this.pool.getConnection()
    await connection.beginTransaction()
    try {
      for (const message of messages) {
        await connection.execute(`
          INSERT INTO conversation_messages
            (session_id, source_type, source_id, source_order, role, content, media_json, created_at, projected_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON DUPLICATE KEY UPDATE
            source_order = VALUES(source_order), role = VALUES(role), content = VALUES(content),
            media_json = VALUES(media_json), created_at = VALUES(created_at), projected_at = VALUES(projected_at)
        `, [
          message.sessionId,
          message.sourceType,
          message.sourceId,
          message.sourceOrder,
          message.role,
          message.text,
          message.images === undefined ? null : JSON.stringify(message.images),
          message.createdAt,
          projectedAt,
        ])
      }
      await connection.commit()
      connection.release()
    } catch (error) {
      await rollbackAndRelease(connection)
      throw error
    }
  }

  async list(sessionId: string): Promise<ConversationMessage[]> {
    const [rows] = await this.pool.execute<ConversationMessageRow[]>(`
      SELECT id, session_id, source_type, source_id, source_order, role, content, media_json, created_at
      FROM conversation_messages WHERE session_id = ?
      ORDER BY created_at, source_order, id
    `, [sessionId])
    return rows.map((row) => {
      const images = parseMessageImages(row.media_json)
      return {
        id: row.id,
        sessionId: row.session_id,
        sourceType: row.source_type,
        sourceId: row.source_id,
        sourceOrder: Number(row.source_order),
        role: row.role,
        text: row.content,
        createdAt: Number(row.created_at),
        ...(images === undefined ? {} : { images }),
      }
    })
  }

  async count(sessionId?: string): Promise<number> {
    const [rows] = sessionId === undefined
      ? await this.pool.query<Array<RowDataPacket & { count: number }>>('SELECT COUNT(*) AS count FROM conversation_messages')
      : await this.pool.execute<Array<RowDataPacket & { count: number }>>(
        'SELECT COUNT(*) AS count FROM conversation_messages WHERE session_id = ?', [sessionId],
      )
    return rows[0]?.count ?? 0
  }
}

interface AuditRow extends RowDataPacket {
  id: number
  actor_id: string
  action: string
  resource_type: string
  resource_id: string
  detail: string | null
  created_at: number
}

function toAudit(row: AuditRow): AuditRecord {
  return {
    id: row.id,
    actorId: row.actor_id,
    action: row.action,
    resourceType: row.resource_type,
    resourceId: row.resource_id,
    detail: row.detail,
    createdAt: row.created_at,
  }
}

export class MysqlAuditRepository implements AuditRepository {
  constructor(private readonly pool: Pool) {}

  async append(input: Omit<AuditRecord, 'id' | 'createdAt'>): Promise<AuditRecord> {
    const createdAt = Date.now()
    const [result] = await this.pool.execute<ResultSetHeader>(`
      INSERT INTO audit_records (actor_id, action, resource_type, resource_id, detail, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `, [input.actorId, input.action, input.resourceType, input.resourceId, input.detail, createdAt])
    return { id: result.insertId, ...input, createdAt }
  }

  async list(limit = 100): Promise<AuditRecord[]> {
    const safeLimit = Math.max(1, Math.min(500, Math.trunc(limit)))
    const [rows] = await this.pool.query<AuditRow[]>(`
      SELECT id, actor_id, action, resource_type, resource_id, detail, created_at
      FROM audit_records ORDER BY id DESC LIMIT ${safeLimit}
    `)
    return rows.map(toAudit)
  }
}

interface OutboxRow extends RowDataPacket {
  id: number
  idempotency_key: string
  event_type: OutboxEventType
  payload_json: unknown
  attempts: number
}

function toOutbox(row: OutboxRow): OutboxMessage {
  return {
    id: row.id,
    idempotencyKey: row.idempotency_key,
    type: row.event_type,
    payload: typeof row.payload_json === 'string' ? JSON.parse(row.payload_json) as unknown : row.payload_json,
    attempts: row.attempts,
  }
}

function isDuplicateKeyError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ER_DUP_ENTRY'
}

async function rollbackAndRelease(connection: PoolConnection): Promise<void> {
  try {
    await connection.rollback()
  } finally {
    connection.release()
  }
}

export class MysqlOutboxRepository implements OutboxRepository {
  private readonly workerId = randomUUID()

  constructor(private readonly pool: Pool, private readonly leaseMs = 5 * 60_000) {}

  async enqueue(idempotencyKey: string, type: OutboxEventType, payload: unknown): Promise<boolean> {
    if (payload === undefined) throw new Error('Outbox payload 必须可序列化为 JSON')
    const now = Date.now()
    try {
      await this.pool.execute(`
        INSERT INTO outbox_messages
          (idempotency_key, event_type, payload_json, available_at, created_at)
        VALUES (?, ?, ?, ?, ?)
      `, [idempotencyKey, type, JSON.stringify(payload), now, now])
      return true
    } catch (error) {
      if (isDuplicateKeyError(error)) return false
      throw error
    }
  }

  async pending(limit = 20, now = Date.now()): Promise<OutboxMessage[]> {
    const connection = await this.pool.getConnection()
    await connection.beginTransaction()
    try {
      await connection.execute(`
        UPDATE outbox_messages SET status = 'pending', claimed_at = NULL, claimed_by = NULL
        WHERE status = 'processing' AND claimed_at < ?
      `, [now - this.leaseMs])
      const safeLimit = Math.max(1, Math.min(100, Math.trunc(limit)))
      const [rows] = await connection.query<OutboxRow[]>(`
        SELECT id, idempotency_key, event_type, payload_json, attempts
        FROM outbox_messages WHERE status = 'pending' AND available_at <= ?
        ORDER BY id LIMIT ${safeLimit} FOR UPDATE SKIP LOCKED
      `, [now])
      if (rows.length > 0) {
        const placeholders = rows.map(() => '?').join(', ')
        await connection.execute(`
          UPDATE outbox_messages SET status = 'processing', claimed_at = ?, claimed_by = ?
          WHERE id IN (${placeholders})
        `, [now, this.workerId, ...rows.map(row => row.id)])
      }
      await connection.commit()
      connection.release()
      return rows.map(toOutbox)
    } catch (error) {
      await rollbackAndRelease(connection)
      throw error
    }
  }

  async complete(id: number): Promise<void> {
    await this.pool.execute(`
      UPDATE outbox_messages SET status = 'completed', completed_at = ?, last_error = NULL,
        claimed_at = NULL, claimed_by = NULL
      WHERE id = ? AND status = 'processing' AND claimed_by = ?
    `, [Date.now(), id, this.workerId])
  }

  async retry(id: number, error: string, delayMs: number, maxAttempts: number): Promise<void> {
    await this.pool.execute(`
      UPDATE outbox_messages
      SET attempts = attempts + 1,
          status = CASE WHEN attempts + 1 >= ? THEN 'failed' ELSE 'pending' END,
          available_at = ?, last_error = ?, claimed_at = NULL, claimed_by = NULL
      WHERE id = ? AND status = 'processing' AND claimed_by = ?
    `, [maxAttempts, Date.now() + delayMs, error.slice(0, 2_000), id, this.workerId])
  }

  async count(status: 'pending' | 'completed' | 'failed'): Promise<number> {
    const [rows] = await this.pool.execute<Array<RowDataPacket & { count: number }>>(
      'SELECT COUNT(*) AS count FROM outbox_messages WHERE status = ?',
      [status],
    )
    return rows[0]?.count ?? 0
  }
}

interface TicketRow extends RowDataPacket {
  id: number
  session_id: string
  user_key: string
  kind: TicketKind
  status: TicketStatus
  department: string | null
  assignee: string | null
  question: string
  service_start: number | null
  service_end: number | null
  satisfaction: number | null
  handoff_reason: string | null
  created_at: number
  updated_at: number
  version: number
}

function toTicket(row: TicketRow): Ticket {
  return {
    id: row.id, sessionId: row.session_id, userKey: row.user_key, kind: row.kind, status: row.status,
    department: row.department, assignee: row.assignee, question: row.question,
    serviceStart: row.service_start, serviceEnd: row.service_end, satisfaction: row.satisfaction,
    handoffReason: row.handoff_reason,
    createdAt: row.created_at, updatedAt: row.updated_at, version: row.version,
  }
}

interface ReplyRow extends RowDataPacket { id: number; message: string; created_at: number }

function toReply(row: ReplyRow): { id: number; message: string; createdAt: number } {
  return { id: row.id, message: row.message, createdAt: row.created_at }
}

/** MySQL ticket projection with transactional reply writes and optimistic updates. */
export class MysqlTicketRepository implements TicketRepository {
  constructor(private readonly pool: Pool) {}

  async get(id: number): Promise<Ticket | undefined> {
    const [rows] = await this.pool.execute<TicketRow[]>('SELECT * FROM tickets WHERE id = ?', [id])
    return rows[0] === undefined ? undefined : toTicket(rows[0])
  }

  async replies(ticketId: number): Promise<Array<{ id: number; message: string; createdAt: number }>> {
    const [rows] = await this.pool.execute<ReplyRow[]>(
      'SELECT id, message, created_at FROM ticket_replies WHERE ticket_id = ? ORDER BY id', [ticketId],
    )
    return rows.map(toReply)
  }

  async addReply(ticketId: number, message: string): Promise<number> {
    const [result] = await this.pool.execute<ResultSetHeader>(
      'INSERT INTO ticket_replies (ticket_id, message, created_at) VALUES (?, ?, ?)', [ticketId, message, Date.now()],
    )
    return result.insertId
  }

  async repliesBySession(sessionId: string): Promise<Array<{ id: number; message: string; createdAt: number }>> {
    const [rows] = await this.pool.execute<ReplyRow[]>(`
      SELECT r.id, r.message, r.created_at FROM ticket_replies r
      JOIN tickets t ON t.id = r.ticket_id WHERE t.session_id = ? ORDER BY r.id
    `, [sessionId])
    return rows.map(toReply)
  }

  async listByGroup(group: string, limit = 50): Promise<Ticket[]> {
    const safeLimit = Math.max(1, Math.min(500, Math.trunc(limit)))
    const [rows] = await this.pool.execute<TicketRow[]>(
      `SELECT * FROM tickets WHERE department = ? ORDER BY id DESC LIMIT ${safeLimit}`, [group],
    )
    return rows.map(toTicket)
  }

  async forSession(sessionId: string): Promise<Ticket | undefined> {
    const [rows] = await this.pool.execute<TicketRow[]>(
      'SELECT * FROM tickets WHERE session_id = ? ORDER BY id DESC LIMIT 1', [sessionId],
    )
    return rows[0] === undefined ? undefined : toTicket(rows[0])
  }

  async ensureOpen(input: { sessionId: string; userKey: string; question: string }): Promise<Ticket> {
    const connection = await this.pool.getConnection()
    await connection.beginTransaction()
    try {
      const [existing] = await connection.execute<TicketRow[]>(
        'SELECT * FROM tickets WHERE session_id = ? ORDER BY id DESC LIMIT 1 FOR UPDATE', [input.sessionId],
      )
      const row = existing[0]
      let ticketId: number
      if (row !== undefined && row.status !== 'closed' && row.status !== 'resolved') {
        ticketId = row.id
        await connection.execute('UPDATE tickets SET updated_at = ? WHERE id = ?', [Date.now(), ticketId])
      } else {
        const now = Date.now()
        const [result] = await connection.execute<ResultSetHeader>(
          'INSERT INTO tickets (session_id, user_key, question, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
          [input.sessionId, input.userKey, input.question, now, now],
        )
        ticketId = result.insertId
      }
      const [tickets] = await connection.execute<TicketRow[]>('SELECT * FROM tickets WHERE id = ?', [ticketId])
      const current = tickets[0]
      if (current === undefined) throw new Error('MySQL 创建或更新工单失败')
      await connection.commit()
      connection.release()
      return toTicket(current)
    } catch (error) {
      await rollbackAndRelease(connection)
      throw error
    }
  }

  async openService(sessionId: string): Promise<void> {
    const now = Date.now()
    await this.pool.execute(`UPDATE tickets SET service_start = COALESCE(service_start, ?), updated_at = ?
      WHERE session_id = ? AND status IN ('open', 'waiting_agent', 'reopened')`, [now, now, sessionId])
  }

  async closeService(sessionId: string): Promise<void> {
    const now = Date.now()
    await this.pool.execute('UPDATE tickets SET service_end = ?, updated_at = ? WHERE session_id = ? AND service_end IS NULL',
      [now, now, sessionId])
  }

  async markHandoff(sessionId: string, reason: string, group?: string): Promise<void> {
    await this.pool.execute(`UPDATE tickets SET status = 'waiting_agent', handoff_reason = ?,
      department = COALESCE(?, department), updated_at = ?, version = version + 1 WHERE session_id = ?`,
    [reason, group ?? null, Date.now(), sessionId])
  }

  async assign(ticketId: number, assignee: string, department: string | null): Promise<void> {
    await this.pool.execute("UPDATE tickets SET assignee = ?, department = ?, kind = 'human', updated_at = ? WHERE id = ?",
      [assignee, department, Date.now(), ticketId])
  }

  async accept(ticketId: number, assignee: string, expectedVersion?: number): Promise<boolean> {
    const versionClause = expectedVersion === undefined ? '' : ' AND version = ?'
    const values = expectedVersion === undefined
      ? [assignee, Date.now(), ticketId]
      : [assignee, Date.now(), ticketId, expectedVersion]
    const [result] = await this.pool.execute<ResultSetHeader>(`UPDATE tickets SET status = 'in_service', assignee = ?,
      kind = 'human', updated_at = ?, version = version + 1
      WHERE id = ? AND status IN ('waiting_agent', 'open', 'reopened')${versionClause}`, values)
    return result.affectedRows > 0
  }

  async reply(ticketId: number, message: string, expectedVersion: number): Promise<number | undefined> {
    const connection = await this.pool.getConnection()
    await connection.beginTransaction()
    try {
      const [updated] = await connection.execute<ResultSetHeader>(`UPDATE tickets SET status = 'waiting_employee',
        updated_at = ?, version = version + 1 WHERE id = ? AND version = ?
        AND status IN ('in_service', 'waiting_employee')`, [Date.now(), ticketId, expectedVersion])
      if (updated.affectedRows === 0) {
        await connection.commit()
        connection.release()
        return undefined
      }
      const [reply] = await connection.execute<ResultSetHeader>(
        'INSERT INTO ticket_replies (ticket_id, message, created_at) VALUES (?, ?, ?)', [ticketId, message, Date.now()],
      )
      await connection.commit()
      connection.release()
      return reply.insertId
    } catch (error) {
      await rollbackAndRelease(connection)
      throw error
    }
  }

  async transfer(ticketId: number, toGroup: string, note: string | null, expectedVersion?: number): Promise<boolean> {
    const versionClause = expectedVersion === undefined ? '' : ' AND version = ?'
    const values = expectedVersion === undefined
      ? [toGroup, note ?? `转接到${toGroup}`, Date.now(), ticketId]
      : [toGroup, note ?? `转接到${toGroup}`, Date.now(), ticketId, expectedVersion]
    const [result] = await this.pool.execute<ResultSetHeader>(`UPDATE tickets SET department = ?, assignee = NULL,
      status = 'waiting_agent', handoff_reason = COALESCE(?, handoff_reason), updated_at = ?, version = version + 1
      WHERE id = ? AND status IN ('open', 'waiting_agent', 'in_service', 'waiting_employee', 'reopened')${versionClause}`, values)
    return result.affectedRows > 0
  }

  async resolve(sessionId: string): Promise<void> {
    await this.pool.execute("UPDATE tickets SET status = 'resolved', updated_at = ?, version = version + 1 WHERE session_id = ? AND status = 'open'",
      [Date.now(), sessionId])
  }

  async closeStaleOpen(cutoff: number): Promise<number> {
    const now = Date.now()
    const [result] = await this.pool.execute<ResultSetHeader>(`UPDATE tickets SET status = 'closed',
      service_end = COALESCE(service_end, ?), updated_at = ?, version = version + 1
      WHERE status = 'open' AND updated_at <= ?`, [now, now, cutoff])
    return result.affectedRows
  }

  async close(ticketId: number, satisfaction: number | null, expectedVersion?: number): Promise<boolean> {
    return await this.updateWithOptionalVersion(
      'UPDATE tickets SET status = \'closed\', satisfaction = ?, updated_at = ?, version = version + 1 WHERE id = ?',
      [satisfaction, Date.now(), ticketId], expectedVersion,
    )
  }

  async rate(ticketId: number, satisfaction: number, expectedVersion?: number): Promise<boolean> {
    const suffix = expectedVersion === undefined ? '' : " AND status IN ('resolved', 'closed') AND satisfaction IS NULL"
    return await this.updateWithOptionalVersion(
      `UPDATE tickets SET satisfaction = ?, updated_at = ?, version = version + 1 WHERE id = ?${suffix}`,
      [satisfaction, Date.now(), ticketId], expectedVersion,
    )
  }

  async findPendingRating(userKey: string): Promise<Ticket | undefined> {
    const [rows] = await this.pool.execute<TicketRow[]>(`SELECT * FROM tickets WHERE user_key = ?
      AND status = 'closed' AND satisfaction IS NULL ORDER BY id DESC LIMIT 1`, [userKey])
    return rows[0] === undefined ? undefined : toTicket(rows[0])
  }

  async list(filter: { status?: TicketStatus; assignee?: string; userKey?: string; limit?: number } = {}): Promise<Ticket[]> {
    const conditions: string[] = []
    const values: Array<string> = []
    if (filter.status !== undefined) { conditions.push('status = ?'); values.push(filter.status) }
    if (filter.assignee !== undefined) { conditions.push('assignee = ?'); values.push(filter.assignee) }
    if (filter.userKey !== undefined) { conditions.push('user_key = ?'); values.push(filter.userKey) }
    const where = conditions.length === 0 ? '' : `WHERE ${conditions.join(' AND ')}`
    const limit = Math.max(1, Math.min(500, Math.trunc(filter.limit ?? 50)))
    const [rows] = await this.pool.execute<TicketRow[]>(`SELECT * FROM tickets ${where} ORDER BY id DESC LIMIT ${limit}`, values)
    return rows.map(toTicket)
  }

  async stats(since?: number): Promise<{
    count: number
    handoffCount: number
    resolvedCount: number
    avgServiceMs: number | null
    avgSatisfaction: number | null
  }> {
    const [rows] = await this.pool.execute<Array<RowDataPacket & {
      count: number
      handoff_count: number
      resolved_count: number
      avg_service_ms: number | null
      avg_satisfaction: number | null
    }>>(`SELECT COUNT(*) AS count, SUM(status = 'waiting_agent') AS handoff_count,
      SUM(status IN ('resolved', 'closed')) AS resolved_count, AVG(service_end - service_start) AS avg_service_ms,
      AVG(satisfaction) AS avg_satisfaction FROM tickets WHERE (? IS NULL OR created_at >= ?)`, [since ?? null, since ?? null])
    const row = rows[0]
    if (row === undefined) throw new Error('MySQL 工单统计失败')
    return { count: row.count, handoffCount: row.handoff_count, resolvedCount: row.resolved_count,
      avgServiceMs: row.avg_service_ms, avgSatisfaction: row.avg_satisfaction }
  }

  private async updateWithOptionalVersion(
    sql: string,
    values: Array<string | number | null>,
    expectedVersion?: number,
  ): Promise<boolean> {
    const statement = expectedVersion === undefined ? sql : `${sql} AND version = ?`
    const parameters = expectedVersion === undefined ? values : [...values, expectedVersion]
    const [result] = await this.pool.execute<ResultSetHeader>(statement, parameters)
    return result.affectedRows > 0
  }
}
