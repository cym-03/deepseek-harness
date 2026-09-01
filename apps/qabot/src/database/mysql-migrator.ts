/** Ordered MySQL migration discovery and execution. */
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import mysql, { type Pool, type PoolConnection, type RowDataPacket } from 'mysql2/promise'
import { toMysqlDate } from './mysql-time.ts'

export interface MysqlMigration {
  version: number
  name: string
  sql: string
}

export const MYSQL_MIGRATION_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    version INT NOT NULL PRIMARY KEY COMMENT '迁移版本号',
    name VARCHAR(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL COMMENT '迁移文件名',
    dirty TINYINT NOT NULL DEFAULT 1 COMMENT '迁移是否处于未完成状态',
    applied_at BIGINT NULL COMMENT '迁移完成时间戳，Unix毫秒；迁移10后改为可读日期'
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='Qabot数据库迁移记录'
`

export async function loadMysqlMigrations(directory: string): Promise<MysqlMigration[]> {
  const entries = (await readdir(directory, { withFileTypes: true }))
    .filter(entry => entry.isFile() && entry.name.endsWith('.sql'))
    .map(entry => entry.name)
    .sort()
  const migrations: MysqlMigration[] = []
  for (const name of entries) {
    const match = /^(\d{3})_[a-z0-9_]+\.sql$/.exec(name)
    if (match === null) throw new Error(`MySQL 迁移文件名无效：${name}`)
    const version = Number(match[1])
    if (version !== migrations.length + 1) {
      throw new Error(`MySQL 迁移版本必须连续：期望 ${migrations.length + 1}，实际 ${version}`)
    }
    migrations.push({ version, name, sql: await readFile(join(directory, name), 'utf8') })
  }
  if (migrations.length === 0) throw new Error('MySQL 迁移目录为空')
  return migrations
}

interface VersionRow extends RowDataPacket {
  version: number
  dirty: number
}

interface LockRow extends RowDataPacket {
  acquired: number | null
}

interface ColumnTypeRow extends RowDataPacket {
  data_type: string
}

async function migrationAppliedAt(connection: PoolConnection, timestamp: number): Promise<number | Date> {
  const [rows] = await connection.query<ColumnTypeRow[]>(`
    SELECT DATA_TYPE AS data_type FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = 'schema_migrations' AND column_name = 'applied_at'
  `)
  return rows[0]?.data_type === 'datetime' ? toMysqlDate(timestamp) : timestamp
}

export async function migrateMysql(pool: Pool, migrations: readonly MysqlMigration[]): Promise<number[]> {
  const connection = await pool.getConnection()
  try {
    const [lockRows] = await connection.query<LockRow[]>("SELECT GET_LOCK('qabot-schema-migrations', 10) AS acquired")
    if (lockRows[0]?.acquired !== 1) throw new Error('无法获取 MySQL 迁移锁')
    await connection.query(MYSQL_MIGRATION_TABLE_SQL)
    const [versionRows] = await connection.query<VersionRow[]>('SELECT version, dirty FROM schema_migrations ORDER BY version')
    const dirty = versionRows.find(row => row.dirty === 1)
    if (dirty !== undefined) throw new Error(`MySQL 迁移 ${dirty.version} 处于未完成状态，需要人工检查后恢复`)
    const applied = new Set(versionRows.map(row => row.version))
    const completed: number[] = []
    for (const migration of migrations) {
      if (applied.has(migration.version)) continue
      await connection.execute(
        'INSERT INTO schema_migrations (version, name, dirty, applied_at) VALUES (?, ?, 1, NULL)',
        [migration.version, migration.name],
      )
      await connection.query(migration.sql)
      await connection.execute(
        'UPDATE schema_migrations SET dirty = 0, applied_at = ? WHERE version = ?',
        [await migrationAppliedAt(connection, Date.now()), migration.version],
      )
      completed.push(migration.version)
    }
    return completed
  } finally {
    try {
      await connection.query("SELECT RELEASE_LOCK('qabot-schema-migrations')")
    } finally {
      connection.release()
    }
  }
}

export function createMysqlPool(url: string, connectionLimit = 10): Pool {
  return mysql.createPool({
    uri: url,
    connectionLimit,
    multipleStatements: true,
    enableKeepAlive: true,
    timezone: '+08:00',
  })
}

export async function migrateMysqlUrl(url: string, migrations: readonly MysqlMigration[]): Promise<number[]> {
  const pool = createMysqlPool(url, 1)
  try {
    return await migrateMysql(pool, migrations)
  } finally {
    await pool.end()
  }
}
