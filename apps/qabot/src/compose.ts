/**
 * 进程内组合 DeepSeek Harness：
 * - agent-spine-demo 提供核心脊柱（session / system-prompt / tools / agent-loop 等）
 * - llm-deepseek 挂真实 DeepSeek provider（经中转网关）
 * - agent-default-model 提供模型选择
 * - session-persistence-jsonl 持久化会话
 * - qabot-kb / qabot-ticket 挂载自研工具
 */

import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import * as AgentSpine from '@deepseek-ai/dsh-agent-spine-demo'
import * as LlmDeepseek from '@deepseek-ai/dsh-llm-deepseek'
import AgentDefaultModelConfig from '@deepseek-ai/dsh-agent-default-model'
import SessionPersistenceJsonl from '@deepseek-ai/dsh-session-persistence-jsonl'
import type { Pool } from 'mysql2/promise'
import MysqlSessionPersistence from './database/mysql-session-persistence.ts'
import * as KbTool from './plugins/kb-tool.ts'
import * as TicketTool from './plugins/ticket-tool.ts'
import type { TicketRepository } from './domain/repositories.ts'

export interface QabotComposeOptions {
  /** 系统人设（发给模型的开场指令）。 */
  persona: string
  /** 默认模型 id，如 deepseek-v4-flash。 */
  model: string
  /** 运行时数据目录（sessions/ 等）。 */
  dataDir: string
  /** 知识库 SQLite 文件路径。 */
  kbDbPath: string
  /** Knowledge retrieval provider; defaults to the local SQLite store outside MySQL mode. */
  knowledgeSearch?: import('./kb/search.ts').KnowledgeSearch
  /** 与应用服务共享的工单 Repository。 */
  tickets: TicketRepository
  /** Shared MySQL pool; when present, model session logs use MySQL instead of JSONL. */
  mysqlPool?: Pool
}

export const DEFAULT_PERSONA = `你是公司的智能问答助手，服务对象是公司员工。

回答规则：
1. 回答公司事务问题（制度、流程、报销、福利、IT、行政、考勤、值班等）前，必须先调用 kb_search 检索知识库。知识库包含本地制度文档和飞书云文档/表格。
2. 如果第一次检索结果不充分，必须换不同关键词再检索 1-2 次（例如从「报销」试到「费用」，从「值班」试到「节假日」），直到确认知识库确实没有相关内容。
3. 只要知识库有相关内容，就必须基于检索结果回答，给出你知道的部分并说明依据来源，而不是转人工。内容不完整时先回答已知部分。回答末尾用「📎 参考文档：」列出实际引用到的文档，格式为 markdown 链接 \`[文档名称](链接URL)\`（kb_search 返回的标题和「链接：」后的 URL），不要裸贴 URL。
4. 知识库中的图片或画板由系统根据相关性作为图片卡片附在回答后。检索结果包含「画板识别文字」时，必须直接使用识别文字回答，不得声称该画板未转成文字。只有结果仅包含「图片提示」且没有识别文字时，才可以说明图片细节尚未转成文字并建议查看原文。
5. 只有以下情况才调用 request_human_handoff：
   - 多次换词检索后仍确认知识库确实没有相关内容；
   - 用户明确要求转人工；
   - 投诉、举报、涉及敏感、违规或需要人工介入的事项。
6. 回答使用中文，直接给结论，默认不超过 3 个要点；用户没有要求时不复述问题、不展开背景、不重复同一依据。需要统计/计算时（如「今年值了多少个班」），基于检索到的记录尽力计算，算不出来就说明并建议转人工。
7. 不编造制度或流程；不确定的部分如实说明，不猜测。`

/** 组合 dsh 上下文。调用方负责在退出时 ctx.fiber.dispose()。 */
export async function composeDsh(options: QabotComposeOptions): Promise<Context> {
  const ctx = new Context()

  // 核心脊柱。关闭不需要的 bash/skills/workspace-context/工具，保持模型工具面干净。
  await ctx.plugin(AgentSpine, {
    agents: [],
    persona: options.persona,
    includeHarnessIdentity: false,
    includeRuntimeContext: false,
    workspaceContext: false,
    skills: { enabled: false },
    toolBash: false,
    toolJobs: false,
  })

  // DeepSeek provider。DEEPSEEK_API_KEY 从根 .env 读取（bin 已加载），
  // DEEPSEEK_BASE_URL 由启动环境导出（dsh 不允许写在 .env）。
  ctx.plugin(LlmDeepseek, {
    thinking: 'enabled',
    reasoningEffort: 'high',
    streamIdleTimeoutMs: Number(process.env.QABOT_MODEL_STREAM_IDLE_TIMEOUT_MS ?? 30_000),
    models: [
      { id: 'deepseek-v4-pro', contextWindow: 128000 },
      { id: 'deepseek-v4-flash', contextWindow: 128000 },
    ],
  })

  // 默认模型选择：创建 agent 时未显式指定则用它。
  ctx.plugin(AgentDefaultModelConfig, {
    provider: 'deepseek-official',
    model: options.model,
  })

  if (options.mysqlPool === undefined) {
    ctx.plugin(SessionPersistenceJsonl, { root: join(options.dataDir, 'sessions') })
  } else {
    ctx.plugin(MysqlSessionPersistence, { pool: options.mysqlPool })
  }

  // 自研工具。
  ctx.plugin(KbTool, options.knowledgeSearch === undefined
    ? { dbPath: options.kbDbPath }
    : { search: options.knowledgeSearch })
  ctx.plugin(TicketTool, { tickets: options.tickets })

  // 让所有插件 fiber 结算，服务就绪后再返回。
  await new Promise(resolve => setTimeout(resolve, 100))
  return ctx
}
