import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import postgres from 'postgres'
import { describe, expect, it } from 'vitest'
import { loadPostgresMigrations, migratePostgres } from '../src/database/postgres-migrator.ts'
import {
  PostgresAuditRepository,
  PostgresConversationRepository,
  PostgresOutboxRepository,
  PostgresTicketRepository,
} from '../src/database/postgres-repositories.ts'

const databaseUrl = process.env.QABOT_TEST_POSTGRES_URL
const describePostgres = databaseUrl === undefined ? describe.skip : describe

describePostgres('PostgreSQL Repository integration', () => {
  it('matches conversation, audit, and claimed Outbox behavior', async () => {
    if (databaseUrl === undefined) throw new Error('QABOT_TEST_POSTGRES_URL is required')
    const sql = postgres(databaseUrl, { max: 2 })
    const suffix = randomUUID()
    const userKey = `test-user-${suffix}`
    const sessionId = `test-session-${suffix}`
    const outboxKey = `test-outbox-${suffix}`
    try {
      const directory = fileURLToPath(new URL('../migrations/postgres', import.meta.url))
      await migratePostgres(sql, await loadPostgresMigrations(directory))
      const conversations = new PostgresConversationRepository(sql)
      await conversations.create(userKey, sessionId)
      await conversations.touch(userKey, sessionId, 1, '测试问题')
      expect(await conversations.list(userKey)).toEqual([
        expect.objectContaining({ userKey, sessionId, title: '测试问题', messageCount: 1 }),
      ])
      expect(await conversations.archive(userKey, sessionId)).toBe(true)
      expect(await conversations.list(userKey)).toEqual([])

      const audit = new PostgresAuditRepository(sql)
      const record = await audit.append({
        actorId: userKey,
        action: 'test.action',
        resourceType: 'test',
        resourceId: suffix,
        detail: null,
      })
      expect(record).toMatchObject({ actorId: userKey, action: 'test.action', resourceId: suffix })

      const tickets = new PostgresTicketRepository(sql)
      const ticket = await tickets.ensureOpen({ sessionId, userKey, question: '需要人工帮助' })
      await tickets.markHandoff(sessionId, '需要人工', 'it')
      const waiting = await tickets.get(ticket.id)
      expect(waiting).toMatchObject({ status: 'waiting_agent', department: 'it', version: 2 })
      if (waiting === undefined) throw new Error('expected waiting ticket')
      expect(await tickets.accept(ticket.id, 'agent-1', waiting.version)).toBe(true)
      expect(await tickets.accept(ticket.id, 'agent-2', waiting.version)).toBe(false)
      const accepted = await tickets.get(ticket.id)
      if (accepted === undefined) throw new Error('expected accepted ticket')
      expect(await tickets.reply(ticket.id, '已处理', accepted.version)).toBeTypeOf('number')
      const replied = await tickets.get(ticket.id)
      if (replied === undefined) throw new Error('expected replied ticket')
      expect(await tickets.closeStaleConversations(Date.now() + 1)).toBeGreaterThanOrEqual(1)
      const closed = await tickets.get(ticket.id)
      if (closed === undefined) throw new Error('expected closed ticket')
      expect(await tickets.rate(ticket.id, 5, closed.version)).toBe(true)
      expect(await tickets.rate(ticket.id, 1, closed.version)).toBe(false)

      const outbox = new PostgresOutboxRepository(sql)
      expect(await outbox.enqueue(outboxKey, 'ticket.handoff', { ticketId: ticket.id })).toBe(true)
      expect(await outbox.enqueue(outboxKey, 'ticket.handoff', { ticketId: ticket.id })).toBe(false)
      const claimed = (await outbox.pending(100)).find(message => message.idempotencyKey === outboxKey)
      expect(claimed).toBeDefined()
      if (claimed !== undefined) await outbox.complete(claimed.id)
    } finally {
      await sql`DELETE FROM outbox_messages WHERE idempotency_key = ${outboxKey}`
      await sql`DELETE FROM audit_records WHERE actor_id = ${userKey}`
      await sql`DELETE FROM ticket_replies WHERE ticket_id IN (SELECT id FROM tickets WHERE user_key = ${userKey})`
      await sql`DELETE FROM tickets WHERE user_key = ${userKey}`
      await sql`DELETE FROM conversations WHERE user_key = ${userKey}`
      await sql.end({ timeout: 5 })
    }
  }, 30_000)
})
