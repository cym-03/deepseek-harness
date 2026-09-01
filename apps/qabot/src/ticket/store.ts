/**
 * 工单存储：SQLite。一次问答会话对应一张工单，
 * 记录服务起止时间、满意度、转人工信息。服务时间为 Unix 毫秒时间戳。
 */

import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type { TicketRepository } from '../domain/repositories.ts'

export type TicketStatus = 'open' | 'waiting_agent' | 'in_service' | 'waiting_employee' | 'resolved' | 'closed' | 'reopened'
export type TicketKind = 'ai' | 'human'

export interface Ticket {
  id: number
  sessionId: string
  userKey: string
  kind: TicketKind
  status: TicketStatus
  department: string | null
  assignee: string | null
  question: string
  serviceStart: number | null
  serviceEnd: number | null
  satisfaction: number | null
  handoffReason: string | null
  createdAt: number
  updatedAt: number
  version: number
}

interface TicketRow {
  id: number
  session_id: string
  user_key: string
  kind: string
  status: string
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

function rowToTicket(row: TicketRow): Ticket {
  return {
    id: row.id,
    sessionId: row.session_id,
    userKey: row.user_key,
    kind: row.kind as TicketKind,
    status: row.status as TicketStatus,
    department: row.department,
    assignee: row.assignee,
    question: row.question,
    serviceStart: row.service_start,
    serviceEnd: row.service_end,
    satisfaction: row.satisfaction,
    handoffReason: row.handoff_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    version: row.version,
  }
}

export class TicketStore implements TicketRepository {
  private readonly db: DatabaseSync

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    this.db = new DatabaseSync(path)
    const schemaVersion = (this.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
    if (schemaVersion < 1) this.db.exec(`
      CREATE TABLE IF NOT EXISTS tickets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        user_key TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'ai',
        status TEXT NOT NULL DEFAULT 'open',
        department TEXT,
        assignee TEXT,
        question TEXT NOT NULL DEFAULT '',
        service_start INTEGER,
        service_end INTEGER,
        satisfaction INTEGER,
        satisfaction_note TEXT,
        handoff_reason TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_tickets_session ON tickets (session_id);
      CREATE INDEX IF NOT EXISTS idx_tickets_status ON tickets (status);
      CREATE TABLE IF NOT EXISTS ticket_replies (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ticket_id INTEGER NOT NULL,
        message TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_ticket_replies_ticket ON ticket_replies (ticket_id);
      PRAGMA user_version = 1;
    `)
    if (schemaVersion < 2) {
      this.db.exec(`
        ALTER TABLE tickets ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
        UPDATE tickets SET status = 'waiting_agent' WHERE status = 'handoff';
        PRAGMA user_version = 2;
      `)
    }
    if (schemaVersion < 3) {
      this.db.exec(`
        ALTER TABLE tickets DROP COLUMN satisfaction_note;
        PRAGMA user_version = 3;
      `)
    }
  }

  private toTicket(id: number): Ticket | undefined {
    const row = this.db.prepare('SELECT * FROM tickets WHERE id = ?').get(id) as TicketRow | undefined
    return row === undefined ? undefined : rowToTicket(row)
  }

  /** 按 id 查工单。 */
  get(id: number): Ticket | undefined {
    return this.toTicket(id)
  }

  /** 工单回复记录。 */
  replies(ticketId: number): Array<{ id: number; message: string; createdAt: number }> {
    return this.db.prepare(
      'SELECT id, message, created_at AS createdAt FROM ticket_replies WHERE ticket_id = ? ORDER BY id',
    ).all(ticketId) as unknown as Array<{ id: number; message: string; createdAt: number }>
  }

  /** 追加一条人工回复记录。 */
  addReply(ticketId: number, message: string): number {
    const result = this.db.prepare(
      'INSERT INTO ticket_replies (ticket_id, message, created_at) VALUES (?, ?, ?)',
    ).run(ticketId, message, Date.now())
    return Number(result.lastInsertRowid)
  }

  /** 某会话的全部人工回复（服务人员回复，合并进会话消息）。 */
  repliesBySession(sessionId: string): Array<{ id: number; message: string; createdAt: number }> {
    return this.db.prepare(`
      SELECT r.id, r.message, r.created_at AS createdAt
      FROM ticket_replies r JOIN tickets t ON t.id = r.ticket_id
      WHERE t.session_id = ?
      ORDER BY r.id
    `).all(sessionId) as unknown as Array<{ id: number; message: string; createdAt: number }>
  }

  /** 按身份组过滤工单列表。 */
  listByGroup(group: string, limit = 50): Ticket[] {
    const rows = this.db.prepare(
      'SELECT * FROM tickets WHERE department = ? ORDER BY id DESC LIMIT ?',
    ).all(group, limit) as unknown as TicketRow[]
    return rows.map(rowToTicket)
  }

  /** 按 session 查最新工单。 */
  forSession(sessionId: string): Ticket | undefined {
    const row = this.db.prepare(
      'SELECT * FROM tickets WHERE session_id = ? ORDER BY id DESC LIMIT 1',
    ).get(sessionId) as TicketRow | undefined
    return row === undefined ? undefined : rowToTicket(row)
  }

  /** 会话当前是否已有未关闭工单；有则复用（并更新问题），无则新建。
   *  若是 handoff（上一轮已转人工），重置为 open——用户带着新问题回来视为新一轮服务，
   *  这样新一轮转人工能再次通知服务人员。 */
  /** 会话工单：一个会话=一个工单。复用已存在的工单（仅更新活动时间），不覆盖首问、不重置状态、不清转人工记录。 */
  ensureOpen(input: { sessionId: string; userKey: string; question: string }): Ticket {
    const existing = this.forSession(input.sessionId)
    if (existing !== undefined && existing.status !== 'closed' && existing.status !== 'resolved') {
      // 保留首问（question）与转人工记录（handoffReason/status），只更新活动时间。
      this.db.prepare('UPDATE tickets SET updated_at = ? WHERE id = ?').run(Date.now(), existing.id)
      return existing
    }
    const now = Date.now()
    const { lastInsertRowid } = this.db.prepare(`
      INSERT INTO tickets (session_id, user_key, question, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(input.sessionId, input.userKey, input.question, now, now)
    const ticket = this.toTicket(Number(lastInsertRowid))
    if (ticket === undefined) throw new Error('创建工单失败')
    return ticket
  }

  /** 记录服务开始时间（仅当尚未记录）。 */
  openService(sessionId: string): void {
    this.db.prepare(`
      UPDATE tickets
      SET service_start = COALESCE(service_start, ?), updated_at = ?
      WHERE session_id = ? AND status IN ('open', 'waiting_agent', 'reopened')
    `).run(Date.now(), Date.now(), sessionId)
  }

  /** 记录服务结束时间。 */
  closeService(sessionId: string): void {
    this.db.prepare(`
      UPDATE tickets
      SET service_end = ?, updated_at = ?
      WHERE session_id = ? AND service_end IS NULL
    `).run(Date.now(), Date.now(), sessionId)
  }

  /** 标记转人工；status 置为 handoff，记 reason 与归属身份组。 */
  markHandoff(sessionId: string, reason: string, group?: string): void {
    if (group !== undefined) {
      this.db.prepare(`
        UPDATE tickets
        SET status = 'waiting_agent', handoff_reason = ?, department = ?, updated_at = ?, version = version + 1
        WHERE session_id = ?
      `).run(reason, group, Date.now(), sessionId)
      return
    }
    this.db.prepare(`
      UPDATE tickets
      SET status = 'waiting_agent', handoff_reason = ?, updated_at = ?, version = version + 1
      WHERE session_id = ?
    `).run(reason, Date.now(), sessionId)
  }

  /** 分配给某服务人员（Phase 2 派单用）。 */
  assign(ticketId: number, assignee: string, department: string | null): void {
    this.db.prepare(`
      UPDATE tickets
      SET assignee = ?, department = ?, kind = 'human', updated_at = ?
      WHERE id = ?
    `).run(assignee, department, Date.now(), ticketId)
  }

  /** 服务人员接单：handoff/open 状态 → in_service，记录处理人。 */
  accept(ticketId: number, assignee: string, expectedVersion?: number): boolean {
    const versionClause = expectedVersion === undefined ? '' : 'AND version = ?'
    const args = expectedVersion === undefined ? [assignee, Date.now(), ticketId] : [assignee, Date.now(), ticketId, expectedVersion]
    const result = this.db.prepare(`
      UPDATE tickets
      SET status = 'in_service', assignee = ?, kind = 'human', updated_at = ?, version = version + 1
      WHERE id = ? AND status IN ('waiting_agent', 'open', 'reopened') ${versionClause}
    `).run(...args)
    return Number(result.changes) > 0
  }

  /** Adds a public agent reply and moves the ticket to waiting_employee atomically. */
  reply(ticketId: number, message: string, expectedVersion: number): number | undefined {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const result = this.db.prepare(`
        UPDATE tickets
        SET status = 'waiting_employee', updated_at = ?, version = version + 1
        WHERE id = ? AND version = ? AND status IN ('in_service', 'waiting_employee')
      `).run(Date.now(), ticketId, expectedVersion)
      if (Number(result.changes) === 0) {
        this.db.exec('ROLLBACK')
        return undefined
      }
      const replyId = this.addReply(ticketId, message)
      this.db.exec('COMMIT')
      return replyId
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  /** 转接工单到其他身份组（分类判断有误时用）：改组、清处理人、回到待接单。 */
  transfer(ticketId: number, toGroup: string, note: string | null, expectedVersion?: number): boolean {
    const versionClause = expectedVersion === undefined ? '' : 'AND version = ?'
    const args = expectedVersion === undefined
      ? [toGroup, note ?? `转接到${toGroup}`, Date.now(), ticketId]
      : [toGroup, note ?? `转接到${toGroup}`, Date.now(), ticketId, expectedVersion]
    const result = this.db.prepare(`
      UPDATE tickets
      SET department = ?, assignee = NULL, status = 'waiting_agent',
          handoff_reason = COALESCE(?, handoff_reason), updated_at = ?, version = version + 1
      WHERE id = ? AND status IN ('open', 'waiting_agent', 'in_service', 'waiting_employee', 'reopened') ${versionClause}
    `).run(...args)
    return Number(result.changes) > 0
  }

  /** 结束服务：把 open 状态的工单置为 resolved（handoff 由人工处理后走 close）。 */
  resolve(sessionId: string): void {
    this.db.prepare(`
      UPDATE tickets
      SET status = 'resolved', updated_at = ?, version = version + 1
      WHERE session_id = ? AND status = 'open'
    `).run(Date.now(), sessionId)
  }

  /** Closes inactive AI conversations and accepted human-service conversations. */
  closeStaleConversations(cutoff: number): number {
    const result = this.db.prepare(`
      UPDATE tickets
      SET status = 'closed', service_end = COALESCE(service_end, ?), updated_at = ?, version = version + 1
      WHERE updated_at <= ?
        AND ((kind = 'ai' AND status = 'open')
          OR status IN ('in_service', 'waiting_employee', 'reopened'))
    `).run(Date.now(), Date.now(), cutoff)
    return Number(result.changes)
  }

  /** 关闭工单并记录满意度（1-5）。返回是否成功。 */
  close(ticketId: number, satisfaction: number | null, expectedVersion?: number): boolean {
    const versionClause = expectedVersion === undefined ? '' : 'AND version = ?'
    const args = expectedVersion === undefined
      ? [satisfaction, Date.now(), ticketId]
      : [satisfaction, Date.now(), ticketId, expectedVersion]
    const result = this.db.prepare(`
      UPDATE tickets
      SET status = 'closed', satisfaction = ?, updated_at = ?, version = version + 1
      WHERE id = ? ${versionClause}
    `).run(...args)
    return Number(result.changes) > 0
  }

  /** 记录满意度（员工评价回调用），不改状态。返回是否命中。 */
  rate(ticketId: number, satisfaction: number, expectedVersion?: number): boolean {
    const versionClause = expectedVersion === undefined
      ? ''
      : "AND version = ? AND status IN ('resolved', 'closed') AND satisfaction IS NULL"
    const args = expectedVersion === undefined
      ? [satisfaction, Date.now(), ticketId]
      : [satisfaction, Date.now(), ticketId, expectedVersion]
    const result = this.db.prepare(`
      UPDATE tickets
      SET satisfaction = ?, updated_at = ?, version = version + 1
      WHERE id = ? ${versionClause}
    `).run(...args)
    return Number(result.changes) > 0
  }

  /** 某员工最新一条「已关闭但尚未评分」的工单（满意度闭环用）。 */
  findPendingRating(userKey: string): Ticket | undefined {
    const row = this.db.prepare(`
      SELECT * FROM tickets
      WHERE user_key = ? AND status = 'closed' AND satisfaction IS NULL
      ORDER BY id DESC LIMIT 1
    `).get(userKey) as TicketRow | undefined
    return row === undefined ? undefined : rowToTicket(row)
  }

  /** 工单列表，可按状态/处理人过滤。 */
  list(filter: { status?: TicketStatus; assignee?: string; userKey?: string; limit?: number } = {}): Ticket[] {
    const clauses: string[] = []
    const args: (string | number)[] = []
    if (filter.status !== undefined) {
      clauses.push('status = ?')
      args.push(filter.status)
    }
    if (filter.assignee !== undefined) {
      clauses.push('assignee = ?')
      args.push(filter.assignee)
    }
    if (filter.userKey !== undefined) {
      clauses.push('user_key = ?')
      args.push(filter.userKey)
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''
    const limit = filter.limit ?? 50
    args.push(limit)
    const rows = this.db.prepare(
      `SELECT * FROM tickets ${where} ORDER BY id DESC LIMIT ?`,
    ).all(...args) as unknown as TicketRow[]
    return rows.map(rowToTicket)
  }

  /** 统计：工单数、平均服务时长、平均满意度、转人工率、未解决数。 */
  stats(since?: number): {
    count: number
    handoffCount: number
    resolvedCount: number
    avgServiceMs: number | null
    avgSatisfaction: number | null
  } {
    const where = since === undefined ? '' : 'WHERE created_at >= ?'
    const args: number[] = since === undefined ? [] : [since]
    const row = this.db.prepare(`
      SELECT
        COUNT(*) AS count,
        SUM(status = 'waiting_agent') AS handoff_count,
        SUM(status IN ('resolved', 'closed')) AS resolved_count,
        AVG(service_end - service_start) AS avg_service_ms,
        AVG(satisfaction) AS avg_satisfaction
      FROM tickets ${where}
    `).all(...args)[0] as {
      count: number
      handoff_count: number | null
      resolved_count: number | null
      avg_service_ms: number | null
      avg_satisfaction: number | null
    }
    return {
      count: Number(row.count),
      handoffCount: Number(row.handoff_count ?? 0),
      resolvedCount: Number(row.resolved_count ?? 0),
      avgServiceMs: row.avg_service_ms === null ? null : Number(row.avg_service_ms),
      avgSatisfaction: row.avg_satisfaction === null ? null : Number(row.avg_satisfaction),
    }
  }

  dispose(): void {
    this.db.close()
  }
}
