import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import * as AgentSpine from '@deepseek-ai/dsh-agent-spine-demo'
import { SessionId, type SessionEvent, type SessionHeader } from '@deepseek-ai/dsh-session'
import { describe, expect, it } from 'vitest'
import { createMysqlPool, loadMysqlMigrations, migrateMysql } from '../src/database/mysql-migrator.ts'
import MysqlSessionPersistence from '../src/database/mysql-session-persistence.ts'

const databaseUrl = process.env.QABOT_TEST_MYSQL_URL
const describeMysql = databaseUrl === undefined ? describe.skip : describe

describeMysql('MySQL model session persistence integration', () => {
  it('stores and reloads a raw DSH header and event batch', async () => {
    if (databaseUrl === undefined) throw new Error('QABOT_TEST_MYSQL_URL is required')
    const pool = createMysqlPool(databaseUrl, 2)
    const sessionId = SessionId(`test-model-session-${randomUUID()}`)
    const ctx = new Context()
    try {
      const directory = fileURLToPath(new URL('../migrations/mysql', import.meta.url))
      await migrateMysql(pool, await loadMysqlMigrations(directory))
      await ctx.plugin(AgentSpine, {
        agents: [], persona: '', includeHarnessIdentity: false, includeRuntimeContext: false,
        workspaceContext: false, skills: { enabled: false }, toolBash: false, toolJobs: false,
      })
      const persistence = new MysqlSessionPersistence(ctx, { pool })
      const header = { id: sessionId, version: 0, createdAt: Date.now(), cwd: 'D:/test' } satisfies SessionHeader
      const event = { seq: 0, type: 'test/mysql-persistence', time: Date.now(), data: 'append', ignorable: true } as SessionEvent
      await persistence.appendBatch(header, [event], false)
      const stored = await persistence.loadStored(sessionId)
      expect(stored?.meta).toMatchObject(header)
      expect(stored?.events).toEqual([event])
    } finally {
      await ctx.fiber.dispose()
      await pool.execute('DELETE FROM dsh_model_session_events WHERE session_id = ?', [sessionId])
      await pool.execute('DELETE FROM dsh_model_sessions WHERE session_id = ?', [sessionId])
      await pool.end()
    }
  }, 30_000)
})
