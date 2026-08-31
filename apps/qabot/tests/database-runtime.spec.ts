import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createQabotRepositories } from '../src/database/runtime.ts'

const directories: string[] = []
const originalBackend = process.env.QABOT_DATABASE_BACKEND
const originalUrl = process.env.QABOT_DATABASE_URL
const originalMysqlUrl = process.env.QABOT_MYSQL_URL

afterEach(() => {
  if (originalBackend === undefined) delete process.env.QABOT_DATABASE_BACKEND
  else process.env.QABOT_DATABASE_BACKEND = originalBackend
  if (originalUrl === undefined) delete process.env.QABOT_DATABASE_URL
  else process.env.QABOT_DATABASE_URL = originalUrl
  if (originalMysqlUrl === undefined) delete process.env.QABOT_MYSQL_URL
  else process.env.QABOT_MYSQL_URL = originalMysqlUrl
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('database Repository selection', () => {
  it('uses one SQLite Repository bundle by default', async () => {
    delete process.env.QABOT_DATABASE_BACKEND
    const directory = mkdtempSync(join(tmpdir(), 'qabot-runtime-'))
    directories.push(directory)
    const repositories = await createQabotRepositories(directory, join(directory, 'missing'))
    try {
      const ticket = await repositories.tickets.ensureOpen({
        sessionId: 'session-1', userKey: 'employee-1', question: 'help',
      })
      expect(await repositories.tickets.get(ticket.id)).toEqual(ticket)
      await repositories.audit.append({
        actorId: 'employee-1', action: 'test', resourceType: 'ticket', resourceId: String(ticket.id), detail: null,
      })
      expect(await repositories.audit.list()).toHaveLength(1)
    } finally {
      await repositories.dispose()
    }
  })

  it('rejects PostgreSQL without an explicit connection URL', async () => {
    process.env.QABOT_DATABASE_BACKEND = 'postgres'
    delete process.env.QABOT_DATABASE_URL
    await expect(createQabotRepositories('unused', 'unused')).rejects.toThrow('QABOT_DATABASE_URL')
  })

  it('rejects MySQL without an explicit connection URL', async () => {
    process.env.QABOT_DATABASE_BACKEND = 'mysql'
    delete process.env.QABOT_MYSQL_URL
    await expect(createQabotRepositories('unused', 'unused', 'unused')).rejects.toThrow('QABOT_MYSQL_URL')
  })

  it('rejects unknown backend names', async () => {
    process.env.QABOT_DATABASE_BACKEND = 'unknown'
    await expect(createQabotRepositories('unused', 'unused')).rejects.toThrow('sqlite、mysql 或 postgres')
  })
})
