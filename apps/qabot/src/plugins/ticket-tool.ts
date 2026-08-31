/**
 * 工单工具：request_human_handoff —— agent 主动发起转人工的核心工具。
 * 通过 exec.agent.session 定位当前会话，标记对应工单为 handoff，并按身份组派发。
 * create/query/close 等其余工具在后续（管理后台）补充。
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { TicketRepository } from '../domain/repositories.ts'

export const name = 'qabot-ticket'
export const inject = ['tools']

export interface Config {
  /** 与 HTTP 和 Qabot 引擎共享的工单 Repository。 */
  tickets: TicketRepository
}

export function apply(ctx: Context, config: Config): void {
  ctx.tools.register(defineTool({
    name: 'request_human_handoff',
    description:
      '【最后手段】仅在以下情况调用：多次换关键词检索知识库（至少 2 次）后仍确认无相关内容、'
      + '用户明确要求转人工、或用户投诉/举报/涉及敏感违规事项。'
      + '不得因单次检索无结果就调用；能基于知识库部分回答时先回答。'
      + '调用后只建议转人工，服务类型由员工在聊天卡片中选择，不得声称已经通知服务人员。',
    parameters: {
      reason: {
        type: 'string',
        required: true,
        description: '转人工的原因，例如：用户问题超出知识库范围 / 用户要求转人工 / 投诉',
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args, exec) {
      const sessionId = exec.agent?.session.id
      if (sessionId === undefined) throw new Error('无法确定当前会话，无法发起转人工')
      // 会话若无工单，自动补一张（userKey 用 sessionId 占位，门户集成后由网关写入真实用户）。
      const ticket = await config.tickets.forSession(String(sessionId))
        ?? await config.tickets.ensureOpen({
          sessionId: String(sessionId),
          userKey: `session:${String(sessionId)}`,
          question: args.reason,
        })
      await config.tickets.openService(String(sessionId))
      return `建议转人工（工单 #${ticket.id}）：${args.reason}。请提示员工在聊天卡片中选择人事、行政、IT或财务；选择前尚未通知服务人员。`
    },
  }))
}
