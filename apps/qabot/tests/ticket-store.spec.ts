import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { TicketStore } from '../src/ticket/store.ts'

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('ticket migrations and concurrency', () => {
  it('migrates handoff tickets and adds a monotonic version', () => {
    const directory = mkdtempSync(join(tmpdir(), 'qabot-ticket-'))
    temporaryDirectories.push(directory)
    const path = join(directory, 'tickets.db')
    const legacy = new DatabaseSync(path)
    legacy.exec(`
      CREATE TABLE tickets (
        id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, user_key TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'ai', status TEXT NOT NULL DEFAULT 'open', department TEXT,
        assignee TEXT, question TEXT NOT NULL DEFAULT '', service_start INTEGER, service_end INTEGER,
        satisfaction INTEGER, satisfaction_note TEXT, handoff_reason TEXT, created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE ticket_replies (id INTEGER PRIMARY KEY AUTOINCREMENT, ticket_id INTEGER NOT NULL,
        message TEXT NOT NULL, created_at INTEGER NOT NULL);
      INSERT INTO tickets (session_id, user_key, status, created_at, updated_at)
        VALUES ('session-1', 'employee-1', 'handoff', 1, 1);
      PRAGMA user_version = 1;
    `)
    legacy.close()

    const store = new TicketStore(path)
    try {
      expect(store.get(1)).toMatchObject({ status: 'waiting_agent', version: 1 })
    } finally {
      store.dispose()
    }
    const migrated = new DatabaseSync(path)
    try {
      const columns = migrated.prepare('PRAGMA table_info(tickets)').all() as unknown as Array<{ name: string }>
      expect(columns.some(column => column.name === 'satisfaction_note')).toBe(false)
      expect(columns.some(column => column.name === 'satisfaction_comment')).toBe(true)
      expect((migrated.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(4)
    } finally {
      migrated.close()
    }
  })

  it('rejects stale agent updates and advances the state version', () => {
    const store = new TicketStore(':memory:')
    try {
      const opened = store.ensureOpen({ sessionId: 'session-1', userKey: 'employee-1', question: 'help' })
      store.markHandoff(opened.sessionId, '需要人工', 'it')
      const waiting = store.get(opened.id)
      if (waiting === undefined) throw new Error('expected waiting ticket')
      expect(waiting).toMatchObject({ status: 'waiting_agent', version: 2 })
      expect(store.accept(opened.id, 'agent-1', waiting.version)).toBe(true)
      expect(store.accept(opened.id, 'agent-2', waiting.version)).toBe(false)
      const accepted = store.get(opened.id)
      if (accepted === undefined) throw new Error('expected accepted ticket')
      expect(accepted).toMatchObject({ status: 'in_service', assignee: 'agent-1', version: 3 })
      expect(store.reply(opened.id, '已处理，请确认', accepted.version)).toBeTypeOf('number')
      expect(store.reply(opened.id, '重复回复', accepted.version)).toBeUndefined()
      expect(store.get(opened.id)).toMatchObject({ status: 'waiting_employee', version: 4 })
      expect(store.replies(opened.id)).toHaveLength(1)
      expect(store.close(opened.id, null, 4)).toBe(true)
      expect(store.rate(opened.id, 4, '处理得很快', 5)).toBe(true)
      expect(store.rate(opened.id, 2, null, 5)).toBe(false)
      expect(store.get(opened.id)).toMatchObject({ status: 'closed', satisfaction: 4, satisfactionComment: '处理得很快', version: 6 })
    } finally {
      store.dispose()
    }
  })

  it('auto-closes stale AI and accepted human conversations but keeps unaccepted handoffs', () => {
    const store = new TicketStore(':memory:')
    try {
      const ai = store.ensureOpen({ sessionId: 'ai-session', userKey: 'employee-1', question: 'policy' })
      const waiting = store.ensureOpen({ sessionId: 'waiting-session', userKey: 'employee-2', question: 'help' })
      store.markHandoff(waiting.sessionId, '需要人工', '人事')
      const accepted = store.ensureOpen({ sessionId: 'accepted-session', userKey: 'employee-3', question: 'help' })
      store.markHandoff(accepted.sessionId, '需要人工', 'IT')
      expect(store.accept(accepted.id, 'agent-1')).toBe(true)
      const replied = store.ensureOpen({ sessionId: 'replied-session', userKey: 'employee-4', question: 'help' })
      store.markHandoff(replied.sessionId, '需要人工', '行政')
      expect(store.accept(replied.id, 'agent-2')).toBe(true)
      const repliedAccepted = store.get(replied.id)
      if (repliedAccepted === undefined) throw new Error('expected accepted ticket')
      expect(store.reply(replied.id, '请确认处理结果', repliedAccepted.version)).toBeTypeOf('number')

      expect(store.closeStaleConversations(Date.now() + 1)).toBe(3)
      expect(store.get(ai.id)?.status).toBe('closed')
      expect(store.get(waiting.id)?.status).toBe('waiting_agent')
      expect(store.get(accepted.id)?.status).toBe('closed')
      expect(store.get(replied.id)?.status).toBe('closed')
    } finally {
      store.dispose()
    }
  })

  it('transfers an active AI-service ticket to a selected human service group', () => {
    const store = new TicketStore(':memory:')
    try {
      const opened = store.ensureOpen({ sessionId: 'ai-transfer', userKey: 'employee-1', question: '需要人工处理' })

      expect(store.transfer(opened.id, '人事', null, opened.version)).toBe(true)
      expect(store.transfer(opened.id, '行政', null, opened.version)).toBe(false)
      store.assign(opened.id, '刘小诗', '人事')
      expect(store.get(opened.id)).toMatchObject({
        status: 'waiting_agent',
        kind: 'human',
        department: '人事',
        assignee: '刘小诗',
        version: opened.version + 1,
      })
    } finally {
      store.dispose()
    }
  })
})
