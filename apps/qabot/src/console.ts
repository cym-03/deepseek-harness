/**
 * 控制台原型：命令行里模拟「员工 ↔ AI 问答」。飞书接入前的本地验证闭环。
 * 命令：/exit 退出，/tickets 看工单，/stats 看统计，/handoff 手动转人工。
 */

import readline from 'node:readline/promises'
import type { Qabot } from './runner.ts'
import type { TicketRepository } from './domain/repositories.ts'

function formatTicket(t: { id: number; status: string; question: string; serviceStart: number | null; serviceEnd: number | null; satisfaction: number | null }): string {
  const ms = t.serviceStart !== null && t.serviceEnd !== null ? t.serviceEnd - t.serviceStart : null
  const secs = ms === null ? '-' : `${Math.round(ms / 1000)}s`
  return `#${t.id} [${t.status}] ${t.question.slice(0, 24)} 服务${secs} 满意度:${t.satisfaction ?? '-'}`
}

export async function runConsole(qabot: Qabot, tickets: TicketRepository): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  console.log('公司智能问答助手（控制台原型）')
  console.log('输入问题直接回车；/exit 退出；/tickets 工单；/stats 统计；/handoff 转人工')
  try {
    while (true) {
      let line: string
      try {
        line = (await rl.question('> ')).trim()
      } catch {
        break // stdin 关闭（管道 EOF 或 Ctrl+D）
      }
      if (line === '') continue
      if (line === '/exit' || line === '/quit') break
      if (line === '/tickets') {
        for (const ticket of await tickets.list({ limit: 20 })) console.log(formatTicket(ticket))
        continue
      }
      if (line === '/stats') {
        const s = await tickets.stats()
        console.log(JSON.stringify(s, null, 2))
        continue
      }
      if (line === '/handoff') {
        // 手动模拟转人工：直接给会话建一张 handoff 工单演示。
        const ticket = await tickets.ensureOpen({ sessionId: 'manual', userKey: 'demo-user', question: '手动转人工' })
        await tickets.markHandoff(ticket.sessionId, '手动触发')
        console.log(`已创建人工工单 #${ticket.id}（原型阶段仅标记状态）`)
        continue
      }
      const start = Date.now()
      try {
        const outcome = await qabot.ask('demo-user', line)
        const elapsed = Date.now() - start
        console.log(`\n─── AI 回答（${elapsed}ms，工单 #${outcome.ticketId}）───`)
        console.log(outcome.text)
        if (outcome.reason !== undefined && outcome.reason.kind === 'error') {
          console.log(`\n[回合出错] ${outcome.reason.error.code}: ${outcome.reason.error.message}`)
        }
        if (outcome.serviceMs !== null) {
          console.log(`\n[服务时间] ${Math.round(outcome.serviceMs / 1000)}s`)
        }
        if (outcome.handoffRequested) {
          console.log('\n[系统] 已发起转人工（Phase 2 将通知飞书对应部门服务人员）')
        }
      } catch (error) {
        console.error(`\n[错误] ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  } finally {
    rl.close()
  }
}
