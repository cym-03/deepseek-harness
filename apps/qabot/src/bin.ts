/**
 * qabot 入口。子命令：
 *   console  控制台原型（默认）：命令行模拟问答 + 工单
 *   feishu   飞书网关：长连接接收消息，问答 + 工单
 *   ingest   把 docs/ 目录索引进知识库
 *
 * 启动前需要：DEEPSEEK_BASE_URL 由 shell 导出（不允许写 .env）；
 * DEEPSEEK_API_KEY / FEISHU_APP_ID / FEISHU_APP_SECRET 放根 .env。
 */

import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadEnv } from './env.ts'
import { composeDsh, DEFAULT_PERSONA } from './compose.ts'
import { KbStore } from './kb/store.ts'
import { ingestDir } from './kb/ingest.ts'
import { Qabot } from './runner.ts'
import { runConsole } from './console.ts'
import { FeishuGateway } from './feishu/gateway.ts'
import { FeishuNotificationAdapter } from './feishu/notify.ts'
import { startHttpServer } from './http/server.ts'
import { StaffStore } from './staff/store.ts'
import { KbSourcesStore } from './kb/sources.ts'
import { syncFeishuSources } from './kb/feishu-sync.ts'
import { enableFileLog } from './log.ts'
import * as lark from '@larksuiteoapi/node-sdk'
import { OutboxWorker, type OutboxHandler } from './integration/outbox.ts'
import { loadPostgresMigrations, migratePostgresUrl } from './database/postgres-migrator.ts'
import { createQabotRepositories, type QabotRepositories } from './database/runtime.ts'
import { loadMysqlMigrations, migrateMysqlUrl } from './database/mysql-migrator.ts'

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..')
const appDir = join(root, 'apps', 'qabot')
const dataDir = join(appDir, 'data')
const kbDbPath = join(dataDir, 'kb.db')
const kbDocDir = join(appDir, 'docs')
const postgresMigrationsDir = join(appDir, 'migrations', 'postgres')
const mysqlMigrationsDir = join(appDir, 'migrations', 'mysql')

/** 组合 dsh 上下文并构建引擎（console / feishu 共用）。调用方负责 dispose。 */
async function buildQabot(): Promise<{ qabot: Qabot; repositories: QabotRepositories; dispose(): Promise<void> }> {
  const repositories = await createQabotRepositories(dataDir, postgresMigrationsDir, mysqlMigrationsDir)
  let ctx
  try {
    ctx = await composeDsh({
      persona: DEFAULT_PERSONA,
      model: process.env.DSH_QABOT_MODEL ?? 'deepseek-v4-flash',
      dataDir,
      kbDbPath,
      tickets: repositories.tickets,
    })
  } catch (error) {
    await repositories.dispose()
    throw error
  }
  const qabot = new Qabot(ctx, repositories.tickets, repositories.conversations)
  return {
    qabot,
    repositories,
    dispose: async () => {
      await qabot.dispose()
      await ctx.fiber.dispose()
      await repositories.dispose()
    },
  }
}

async function cmdIngest(): Promise<void> {
  const store = new KbStore(kbDbPath)
  try {
    const total = await ingestDir(store, kbDocDir)
    console.log(`知识库索引完成：${total} 个分块（目录 ${kbDocDir}）`)
    const embedded = await store.embedMissing()
    console.log(`向量化完成：${embedded} 个（语义检索 ${embedded > 0 ? '已启用' : '未启用（无本地模型或已有向量）'}）`)
  } finally {
    store.dispose()
  }
}

async function cmdMigratePostgres(): Promise<void> {
  const url = process.env.QABOT_DATABASE_URL
  if (url === undefined || url.trim() === '') throw new Error('migrate-postgres 需要 QABOT_DATABASE_URL')
  const migrations = await loadPostgresMigrations(postgresMigrationsDir)
  const applied = await migratePostgresUrl(url, migrations)
  console.log(applied.length === 0 ? 'PostgreSQL 数据库已是最新版本' : `PostgreSQL 已执行迁移：${applied.join(', ')}`)
}

async function cmdMigrateMysql(): Promise<void> {
  const url = process.env.QABOT_MYSQL_URL
  if (url === undefined || url.trim() === '') throw new Error('migrate-mysql 需要 QABOT_MYSQL_URL')
  const applied = await migrateMysqlUrl(url, await loadMysqlMigrations(mysqlMigrationsDir))
  console.log(applied.length === 0 ? 'MySQL 数据库已是最新版本' : `MySQL 已执行迁移：${applied.join(', ')}`)
}

async function cmdConsole(): Promise<void> {
  const { qabot, repositories, dispose } = await buildQabot()
  try {
    await runConsole(qabot, repositories.tickets)
  } finally {
    await dispose()
  }
}

async function cmdFeishu(): Promise<void> {
  const appId = process.env.FEISHU_APP_ID
  const appSecret = process.env.FEISHU_APP_SECRET
  if (appId === undefined || appSecret === undefined) {
    console.error('缺少 FEISHU_APP_ID / FEISHU_APP_SECRET（放根 .env）')
    process.exitCode = 1
    return
  }
  const { qabot, dispose } = await buildQabot()
  const gateway = new FeishuGateway({ appId, appSecret }, qabot)
  // 优雅退出：Ctrl+C 时清理。
  let shuttingDown = false
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return
    shuttingDown = true
    console.log('\n[feishu] 正在退出…')
    await dispose()
    process.exit(0)
  }
  process.on('SIGINT', () => { void shutdown() })
  process.on('SIGTERM', () => { void shutdown() })
  try {
    await gateway.start()
    console.log('[feishu] 网关运行中，Ctrl+C 退出')
    await new Promise<void>(() => {}) // 常驻
  } finally {
    await dispose()
  }
}

/** 启动 HTTP 服务（供门户 NestJS smart-qa 模块薄代理）。 */
async function cmdServe(): Promise<void> {
  const { qabot, repositories, dispose } = await buildQabot()
  const { tickets, audit, outbox } = repositories
  const kb = new KbStore(kbDbPath)
  const projectKnowledge = repositories.knowledge === undefined
    ? undefined
    : async (): Promise<void> => {
      const result = await repositories.knowledge?.replace(kb.storageSnapshot())
      if (result !== undefined) {
        console.log(`[kb-storage] MySQL 投影完成 documents=${result.documents} versions=${result.versions} chunks=${result.chunks} embeddings=${result.embeddings} assets=${result.assets}`)
      }
    }
  // 启动时检查向量索引：只补算失效分块（内容 hash / embedding 模型版本变更），其余复用已存向量。
  try {
    const n = await kb.embedMissing()
    console.log(n > 0
      ? `[kb] 向量增量补算 ${n} 条（内容变更/模型变更），其余复用已存向量`
      : '[kb] 向量索引已是最新，无需重建')
    const vision = await kb.embedVisionMissing()
    if (vision > 0) console.log(`[kb] 视觉向量增量补算 ${vision} 条`)
    await projectKnowledge?.()
  } catch (error) {
    console.error('[kb] 向量索引失败:', error instanceof Error ? error.message : error)
  }
  const staff = new StaffStore(join(dataDir, 'staff.db'), join(appDir, 'data', 'staff.json'))
  const appId = process.env.FEISHU_APP_ID
  const appSecret = process.env.FEISHU_APP_SECRET
  const feishu = appId !== undefined && appSecret !== undefined
    ? { appId, appSecret, client: new lark.Client({ appId, appSecret }) }
    : undefined
  const adapter = feishu !== undefined
    ? new FeishuNotificationAdapter({
      appId: feishu.appId,
      appSecret: feishu.appSecret,
      getStaff: group => staff.notifyTargets(group),
    })
    : undefined
  if (adapter === undefined) {
    console.warn('[serve] 未配置 FEISHU_APP_ID/SECRET，转人工通知将静默跳过')
  }
  const parsePayload = (payload: unknown): Record<string, unknown> => {
    if (typeof payload !== 'object' || payload === null) throw new Error('Outbox payload 必须是对象')
    return payload as Record<string, unknown>
  }
  const handlers: Partial<Record<'ticket.handoff', OutboxHandler>> = {}
  if (adapter !== undefined) {
    handlers['ticket.handoff'] = async (payload) => {
      const value = parsePayload(payload)
      const { ticketId, ticketVersion } = value
      if (typeof ticketId !== 'number' || typeof ticketVersion !== 'number') {
        throw new Error('ticket.handoff 缺少 ticketId 或 ticketVersion')
      }
      const ticket = await tickets.get(ticketId)
      if (ticket === undefined) throw new Error(`工单 ${ticketId} 不存在`)
      if (ticket.version !== ticketVersion || ticket.status !== 'waiting_agent') return
      await adapter.notifyHandoff(ticket)
    }
  }
  const outboxWorker = new OutboxWorker(outbox, handlers)
  const outboxIntervalMs = Number(process.env.QABOT_OUTBOX_INTERVAL_MS ?? 1_000)
  if (!Number.isFinite(outboxIntervalMs) || outboxIntervalMs < 100) {
    throw new Error('QABOT_OUTBOX_INTERVAL_MS 必须是不小于 100 的数字')
  }
  const outboxTimer = setInterval(() => { void outboxWorker.runOnce() }, outboxIntervalMs)
  outboxTimer.unref()
  void outboxWorker.runOnce()
  // 飞书知识源（云文档/多维表格）同步入口。
  const kbSources = new KbSourcesStore(join(dataDir, 'kb-sources.json'))
  const syncFeishu = feishu !== undefined
    ? async () => {
      const result = await syncFeishuSources(feishu.client, kb, kbSources.load(), { appId: feishu.appId, appSecret: feishu.appSecret })
      const disabled = kbSources.disableWiki(result.disabledWiki)
      if (disabled > 0) console.warn(`[kb-sync] 已自动停用 ${disabled} 个不存在的 wiki 知识源`)
      await projectKnowledge?.()
      return result
    }
    : undefined
  const port = Number(process.env.QABOT_PORT ?? 3100)
  // QABOT 只作为门户后端的内部服务，默认禁止局域网直接访问。
  const host = process.env.QABOT_HOST ?? '127.0.0.1'
  enableFileLog(join(dataDir, 'qabot.log'))
  let shuttingDown = false
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return
    shuttingDown = true
    console.log('\n[serve] 正在退出…')
    await dispose()
    process.exit(0)
  }
  process.on('SIGINT', () => { void shutdown() })
  process.on('SIGTERM', () => { void shutdown() })
  await startHttpServer({
    port,
    host,
    qabot,
    tickets,
    kb,
    staff,
    audit,
    outbox,
    ...projectKnowledge !== undefined ? { projectKnowledge } : {},
    ...syncFeishu !== undefined ? { sources: kbSources, syncFeishu } : {},
  })

  // 定时同步知识库（飞书文档/表格变更自动拉取）。QABOT_SYNC_INTERVAL_MINUTES=0 关闭，默认 30 分钟。
  if (syncFeishu !== undefined) {
    const intervalMin = Number(process.env.QABOT_SYNC_INTERVAL_MINUTES ?? 30)
    if (Number.isFinite(intervalMin) && intervalMin > 0) {
      let syncing = false
      const runSync = async (): Promise<void> => {
        if (syncing) return
        syncing = true
        try {
          const result = await syncFeishu()
          console.log(`[kb-sync] 定时同步完成 synced=${result.synced} failed=${result.failed}`)
          if (result.errors.length > 0) {
            console.error('[kb-sync] 定时同步部分失败:', result.errors.join('; '))
          }
        } catch (error) {
          console.error('[kb-sync] 定时同步异常:', error instanceof Error ? error.message : error)
        } finally {
          syncing = false
        }
      }
      const timer = setInterval(() => { void runSync() }, intervalMin * 60 * 1000)
      timer.unref()
      console.log(`[kb-sync] 定时同步已启用：每 ${intervalMin} 分钟`)
      // 启动后先跑一次
      void runSync()
    }
  }

  await new Promise<void>(() => {}) // 常驻
}

async function main(): Promise<void> {
  // 根 .env 是 qabot 的配置事实来源。Windows 登录会话或任务计划中可能残留
  // 旧的 DEEPSEEK_API_KEY；若不覆盖，会出现“文件已更新但服务仍使用旧密钥”的假象。
  loadEnv(join(root, '.env'), { override: true })
  const sub = process.argv[2] ?? 'console'
  if (sub === 'ingest') {
    await cmdIngest()
  } else if (sub === 'migrate-postgres') {
    await cmdMigratePostgres()
  } else if (sub === 'migrate-mysql') {
    await cmdMigrateMysql()
  } else if (sub === 'console' || sub === 'dev') {
    await cmdConsole()
  } else if (sub === 'feishu') {
    await cmdFeishu()
  } else if (sub === 'serve') {
    await cmdServe()
  } else {
    console.error(`未知子命令：${sub}（可用：console | feishu | serve | ingest | migrate-postgres | migrate-mysql）`)
    process.exitCode = 1
  }
}

void main()
