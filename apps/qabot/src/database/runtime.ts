/** Selects and owns Qabot business-data Repository providers. */
import { join } from 'node:path'
import postgres from 'postgres'
import type { Pool } from 'mysql2/promise'
import { AuditStore } from '../audit/store.ts'
import { ConversationStore } from '../conversation/store.ts'
import type {
  AuditRepository,
  ConversationMessageRepository,
  ConversationRepository,
  OutboxRepository,
  StaffRepository,
  TicketRepository,
} from '../domain/repositories.ts'
import { OutboxStore } from '../integration/outbox.ts'
import { TicketStore } from '../ticket/store.ts'
import { createMysqlPool, loadMysqlMigrations, migrateMysql } from './mysql-migrator.ts'
import { MysqlKnowledgeProjection } from './mysql-knowledge-projection.ts'
import { MysqlKnowledgeSearch } from './mysql-knowledge-search.ts'
import { MysqlKnowledgeSourceRepository } from './mysql-knowledge-sources.ts'
import {
  MysqlAuditRepository,
  MysqlConversationMessageRepository,
  MysqlConversationRepository,
  MysqlOutboxRepository,
  MysqlStaffRepository,
  MysqlTicketRepository,
} from './mysql-repositories.ts'
import { loadPostgresMigrations, migratePostgres } from './postgres-migrator.ts'
import {
  PostgresAuditRepository,
  PostgresConversationRepository,
  PostgresOutboxRepository,
  PostgresTicketRepository,
} from './postgres-repositories.ts'

export interface QabotRepositories {
  conversations: ConversationRepository
  tickets: TicketRepository
  audit: AuditRepository
  outbox: OutboxRepository
  messages?: ConversationMessageRepository
  knowledge?: MysqlKnowledgeProjection
  knowledgeSearch?: MysqlKnowledgeSearch
  knowledgeSources?: MysqlKnowledgeSourceRepository
  staff?: StaffRepository
  mysqlPool?: Pool
  dispose(): Promise<void>
}

export async function createQabotRepositories(
  dataDir: string,
  postgresMigrationsDir: string,
  mysqlMigrationsDir?: string,
): Promise<QabotRepositories> {
  const backend = process.env.QABOT_DATABASE_BACKEND ?? 'sqlite'
  if (backend === 'sqlite') {
    const conversations = new ConversationStore(join(dataDir, 'conversations.db'))
    const tickets = new TicketStore(join(dataDir, 'tickets.db'))
    const audit = new AuditStore(join(dataDir, 'audit.db'))
    const outbox = new OutboxStore(join(dataDir, 'outbox.db'))
    return {
      conversations,
      tickets,
      audit,
      outbox,
      dispose: () => {
        outbox.dispose()
        audit.dispose()
        tickets.dispose()
        conversations.dispose()
        return Promise.resolve()
      },
    }
  }
  if (backend === 'mysql') {
    const url = process.env.QABOT_MYSQL_URL
    if (url === undefined || url.trim() === '') throw new Error('MySQL 后端需要 QABOT_MYSQL_URL')
    if (mysqlMigrationsDir === undefined) throw new Error('MySQL 后端需要迁移目录')
    const pool = createMysqlPool(url)
    try {
      await migrateMysql(pool, await loadMysqlMigrations(mysqlMigrationsDir))
    } catch (error) {
      await pool.end()
      throw error
    }
    const staff = new MysqlStaffRepository(pool)
    return {
      conversations: new MysqlConversationRepository(pool),
      messages: new MysqlConversationMessageRepository(pool),
      tickets: new MysqlTicketRepository(pool),
      audit: new MysqlAuditRepository(pool),
      outbox: new MysqlOutboxRepository(pool),
      knowledge: new MysqlKnowledgeProjection(pool),
      knowledgeSearch: new MysqlKnowledgeSearch(pool),
      knowledgeSources: new MysqlKnowledgeSourceRepository(pool),
      staff,
      mysqlPool: pool,
      dispose: async () => { await pool.end() },
    }
  }
  if (backend !== 'postgres') throw new Error('QABOT_DATABASE_BACKEND 必须是 sqlite、mysql 或 postgres')
  const url = process.env.QABOT_DATABASE_URL
  if (url === undefined || url.trim() === '') throw new Error('PostgreSQL 后端需要 QABOT_DATABASE_URL')
  const sql = postgres(url, { max: 10, idle_timeout: 20, connect_timeout: 10 })
  try {
    await migratePostgres(sql, await loadPostgresMigrations(postgresMigrationsDir))
  } catch (error) {
    await sql.end({ timeout: 5 })
    throw error
  }
  return {
    conversations: new PostgresConversationRepository(sql),
    tickets: new PostgresTicketRepository(sql),
    audit: new PostgresAuditRepository(sql),
    outbox: new PostgresOutboxRepository(sql),
    dispose: async () => { await sql.end({ timeout: 5 }) },
  }
}
