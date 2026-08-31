import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { createMysqlPool, loadMysqlMigrations, migrateMysql } from '../src/database/mysql-migrator.ts'
import {
  MysqlAuditRepository,
  MysqlConversationRepository,
  MysqlOutboxRepository,
  MysqlTicketRepository,
} from '../src/database/mysql-repositories.ts'

const databaseUrl = process.env.QABOT_TEST_MYSQL_URL
const describeMysql = databaseUrl === undefined ? describe.skip : describe

describeMysql('MySQL Repository integration', () => {
  it('matches conversation, ticket, audit, and claimed Outbox behavior', async () => {
    if (databaseUrl === undefined) throw new Error('QABOT_TEST_MYSQL_URL is required')
    const pool = createMysqlPool(databaseUrl, 2)
    const suffix = randomUUID()
    const userKey = `test-user-${suffix}`
    const sessionId = `test-session-${suffix}`
    const outboxKey = `test-outbox-${suffix}`
    try {
      const directory = fileURLToPath(new URL('../migrations/mysql', import.meta.url))
      await migrateMysql(pool, await loadMysqlMigrations(directory))
      const conversations = new MysqlConversationRepository(pool)
      await conversations.create(userKey, sessionId)
      await conversations.touch(userKey, sessionId, 1, '测试问题')
      expect(await conversations.list(userKey)).toEqual([
        expect.objectContaining({ userKey, sessionId, title: '测试问题', messageCount: 1 }),
      ])

      const audit = new MysqlAuditRepository(pool)
      expect(await audit.append({ actorId: userKey, action: 'test.action', resourceType: 'test', resourceId: suffix, detail: null }))
        .toMatchObject({ actorId: userKey, resourceId: suffix })

      const tickets = new MysqlTicketRepository(pool)
      const ticket = await tickets.ensureOpen({ sessionId, userKey, question: '需要人工帮助' })
      await tickets.markHandoff(sessionId, '需要人工', 'IT')
      const waiting = await tickets.get(ticket.id)
      if (waiting === undefined) throw new Error('expected waiting ticket')
      expect(await tickets.accept(ticket.id, 'agent-1', waiting.version)).toBe(true)
      expect(await tickets.accept(ticket.id, 'agent-2', waiting.version)).toBe(false)
      const accepted = await tickets.get(ticket.id)
      if (accepted === undefined) throw new Error('expected accepted ticket')
      expect(await tickets.reply(ticket.id, '已处理', accepted.version)).toBeTypeOf('number')

      const outbox = new MysqlOutboxRepository(pool)
      expect(await outbox.enqueue(outboxKey, 'ticket.handoff', { ticketId: ticket.id })).toBe(true)
      expect(await outbox.enqueue(outboxKey, 'ticket.handoff', { ticketId: ticket.id })).toBe(false)
      const claimed = (await outbox.pending(100)).find(message => message.idempotencyKey === outboxKey)
      expect(claimed).toBeDefined()
      if (claimed !== undefined) await outbox.complete(claimed.id)
    } finally {
      await pool.execute('DELETE FROM outbox_messages WHERE idempotency_key = ?', [outboxKey])
      await pool.execute('DELETE FROM audit_records WHERE actor_id = ?', [userKey])
      await pool.execute('DELETE FROM ticket_replies WHERE ticket_id IN (SELECT id FROM tickets WHERE user_key = ?)', [userKey])
      await pool.execute('DELETE FROM tickets WHERE user_key = ?', [userKey])
      await pool.execute('DELETE FROM conversations WHERE user_key = ?', [userKey])
      await pool.end()
    }
  }, 30_000)
})
