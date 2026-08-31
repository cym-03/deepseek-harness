/** Ordered PostgreSQL migration discovery and execution. */
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import postgres, { type Sql } from 'postgres'

export interface PostgresMigration {
  version: number
  name: string
  sql: string
}

/** Loads consecutive `NNN_name.sql` files in version order. */
export async function loadPostgresMigrations(directory: string): Promise<PostgresMigration[]> {
  const entries = (await readdir(directory, { withFileTypes: true }))
    .filter(entry => entry.isFile() && entry.name.endsWith('.sql'))
    .map(entry => entry.name)
    .sort()
  const migrations: PostgresMigration[] = []
  for (const name of entries) {
    const match = /^(\d{3})_[a-z0-9_]+\.sql$/.exec(name)
    if (match === null) throw new Error(`PostgreSQL 迁移文件名无效：${name}`)
    const version = Number(match[1])
    if (version !== migrations.length + 1) {
      throw new Error(`PostgreSQL 迁移版本必须连续：期望 ${migrations.length + 1}，实际 ${version}`)
    }
    migrations.push({ version, name, sql: await readFile(join(directory, name), 'utf8') })
  }
  if (migrations.length === 0) throw new Error('PostgreSQL 迁移目录为空')
  return migrations
}

/** Applies pending migrations under a database-scoped advisory lock. */
export async function migratePostgres(sql: Sql, migrations: readonly PostgresMigration[]): Promise<number[]> {
  await sql`SELECT pg_advisory_lock(hashtext('qabot-schema-migrations'))`
  try {
    await sql`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at BIGINT NOT NULL
      )
    `
    const appliedRows = await sql<{ version: number }[]>`SELECT version FROM schema_migrations ORDER BY version`
    const applied = new Set(appliedRows.map(row => row.version))
    const completed: number[] = []
    for (const migration of migrations) {
      if (applied.has(migration.version)) continue
      await sql.begin(async (transaction) => {
        await transaction.unsafe(migration.sql)
        await transaction`
          INSERT INTO schema_migrations (version, applied_at)
          VALUES (${migration.version}, ${Date.now()})
        `
      })
      completed.push(migration.version)
    }
    return completed
  } finally {
    await sql`SELECT pg_advisory_unlock(hashtext('qabot-schema-migrations'))`
  }
}

/** Connects to the configured database, migrates it, and closes the connection. */
export async function migratePostgresUrl(url: string, migrations: readonly PostgresMigration[]): Promise<number[]> {
  const sql = postgres(url, { max: 1, idle_timeout: 5, connect_timeout: 10 })
  try {
    return await migratePostgres(sql, migrations)
  } finally {
    await sql.end({ timeout: 5 })
  }
}
