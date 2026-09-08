/**
 * 会话元数据存储：每用户的历史会话列表（标题/时间/消息数），供前端会话栏展示。
 * 会话与工单同源（一次对话 = 一个会话 = 一张工单），这里只存列表所需的元数据。
 */

import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type { ConversationRepository } from '../domain/repositories.ts'

export interface Conversation {
  userKey: string
  sessionId: string
  title: string
  createdAt: number
  lastMessageAt: number
  messageCount: number
}

interface ConvRow {
  user_key: string
  session_id: string
  title: string
  created_at: number
  last_message_at: number
  message_count: number
}

function rowToConv(row: ConvRow): Conversation {
  return {
    userKey: row.user_key,
    sessionId: row.session_id,
    title: row.title,
    createdAt: row.created_at,
    lastMessageAt: row.last_message_at,
    messageCount: row.message_count,
  }
}

export class ConversationStore implements ConversationRepository {
  private readonly db: DatabaseSync

  constructor(dbPath: string) {
    if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true })
    this.db = new DatabaseSync(dbPath)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS conversations (
        user_key TEXT NOT NULL,
        session_id TEXT NOT NULL,
        title TEXT NOT NULL DEFAULT '新对话',
        created_at INTEGER NOT NULL,
        last_message_at INTEGER NOT NULL,
        message_count INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (user_key, session_id)
      );
      CREATE INDEX IF NOT EXISTS idx_conv_user ON conversations (user_key, last_message_at DESC);
    `)
    const columns = this.db.prepare('PRAGMA table_info(conversations)').all() as unknown as Array<{ name: string }>
    if (!columns.some(column => column.name === 'archived_at')) {
      this.db.exec('ALTER TABLE conversations ADD COLUMN archived_at INTEGER DEFAULT NULL')
    }
  }

  /** 新建会话记录（幂等：已存在则忽略，用于重启后会话重建）。 */
  create(userKey: string, sessionId: string): void {
    const now = Date.now()
    this.db.prepare(`
      INSERT OR IGNORE INTO conversations (user_key, session_id, title, created_at, last_message_at, message_count)
      VALUES (?, ?, '新对话', ?, ?, 0)
    `).run(userKey, sessionId, now, now)
  }

  /** 更新会话（标题/时间/消息数）。 */
  touch(userKey: string, sessionId: string, messageCount: number, firstQuestion?: string): void {
    const now = Date.now()
    this.db.prepare(`
      UPDATE conversations
      SET title = CASE WHEN message_count = 0 AND ? IS NOT NULL THEN ? ELSE title END,
          last_message_at = ?, message_count = ?
      WHERE user_key = ? AND session_id = ?
    `).run(firstQuestion ?? null, firstQuestion ?? null, now, messageCount, userKey, sessionId)
  }

  /** 某用户是否已有空会话（无消息）。 */
  findEmpty(userKey: string): Conversation | undefined {
    const row = this.db.prepare(
      "SELECT * FROM conversations WHERE user_key = ? AND message_count = 0 AND title = '新对话' AND archived_at IS NULL ORDER BY last_message_at DESC LIMIT 1",
    ).get(userKey) as ConvRow | undefined
    return row === undefined ? undefined : rowToConv(row)
  }

  /** 某用户的会话列表（按最近活动倒序）。 */
  list(userKey: string): Conversation[] {
    const rows = this.db.prepare(
      'SELECT * FROM conversations WHERE user_key = ? AND archived_at IS NULL ORDER BY last_message_at DESC',
    ).all(userKey) as unknown as ConvRow[]
    return rows.map(rowToConv)
  }

  listAll(): Conversation[] {
    const rows = this.db.prepare(
      'SELECT * FROM conversations WHERE archived_at IS NULL ORDER BY last_message_at DESC',
    ).all() as unknown as ConvRow[]
    return rows.map(rowToConv)
  }

  ownerOf(sessionId: string): string | undefined {
    const row = this.db.prepare(
      'SELECT user_key FROM conversations WHERE session_id = ? AND archived_at IS NULL LIMIT 1',
    ).get(sessionId) as { user_key: string } | undefined
    return row?.user_key
  }

  archive(userKey: string, sessionId: string): boolean {
    const result = this.db.prepare(
      'UPDATE conversations SET archived_at = ? WHERE user_key = ? AND session_id = ? AND archived_at IS NULL',
    ).run(Date.now(), userKey, sessionId)
    return Number(result.changes) > 0
  }

  dispose(): void {
    this.db.close()
  }
}
