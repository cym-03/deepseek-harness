/**
 * 周报计算：供门户「数据报告」模块调用。
 * - 工单统计：总数、AI 解决、转人工数/率、平均服务时长、平均满意度、未解决
 * - 常问问题 Top：按字符 n-gram 余弦相似度聚类去重，聚合出现次数
 */

import type { Ticket } from '../ticket/store.ts'
import type { TicketRepository } from '../domain/repositories.ts'
import { termsOf, cosine } from '../kb/embed.ts'

export interface WeeklyReport {
  period: { since: number; until: number; label: string }
  stats: {
    totalTickets: number
    aiResolved: number
    humanHandoffs: number
    handoffRate: number | null
    avgServiceMs: number | null
    avgSatisfaction: number | null
    openTickets: number
  }
  faq: Array<{ question: string; count: number }>
}

interface QuestionItem {
  text: string
  createdAt: number
}

function questionVec(text: string): Record<string, number> {
  const vec: Record<string, number> = {}
  for (const term of termsOf(text)) vec[term] = (vec[term] ?? 0) + 1
  return vec
}

/** 字符 n-gram 聚类：相似度超过阈值的归入同一簇。 */
function clusterQuestions(items: QuestionItem[], threshold = 0.5): Array<{ question: string; count: number }> {
  const clusters: Array<{ centroid: Record<string, number>; count: number; sample: string }> = []
  for (const item of items) {
    const vec = questionVec(item.text)
    let best = -1
    let bestScore = 0
    for (let i = 0; i < clusters.length; i++) {
      const score = cosine(vec, clusters[i]!.centroid)
      if (score > bestScore) {
        best = i
        bestScore = score
      }
    }
    if (best >= 0 && bestScore >= threshold) {
      const cluster = clusters[best]!
      cluster.count += 1
      // 质心按比例更新；样本取该簇里最早出现的问题（更通用）。
      for (const [term, w] of Object.entries(vec)) {
        cluster.centroid[term] = ((cluster.centroid[term] ?? 0) * (cluster.count - 1) + w) / cluster.count
      }
    } else {
      clusters.push({ centroid: vec, count: 1, sample: item.text })
    }
  }
  return clusters
    .filter(c => c.count >= 2) // 至少出现 2 次才算「常问」
    .sort((a, b) => b.count - a.count)
    .slice(0, 10)
    .map(c => ({ question: c.sample, count: c.count }))
}

const pad = (n: number): string => String(n).padStart(2, '0')

/** 生成周报（默认最近 1 周；weeks 可传近 N 周）。 */
export async function buildWeeklyReport(
  tickets: TicketRepository,
  since?: number,
  weeks = 1,
  assignee?: string,
): Promise<WeeklyReport> {
  const until = Date.now()
  const start = since ?? until - weeks * 7 * 24 * 60 * 60 * 1000
  const list = (await tickets.list({ limit: 1000 }))
    .filter(t => t.createdAt >= start && t.createdAt <= until)
    .filter(t => assignee === undefined || assignee === '' || t.assignee === assignee)

  const total = list.length
  const humanHandoffs = list.filter(t => t.handoffReason !== null || t.status === 'waiting_agent').length
  // resolved 是 AI 正常解决；closed 兼容历史数据，但转过人工的工单不能计入 AI 解决。
  const aiResolved = list.filter(t => (t.status === 'resolved' || t.status === 'closed') && t.handoffReason === null).length
  // handoff 仍在等待人工承接，也属于未解决。
  const open = list.filter(t => t.status === 'open' || t.status === 'in_service'
    || t.status === 'waiting_agent' || t.status === 'waiting_employee' || t.status === 'reopened').length
  const rated = list.filter(t => t.satisfaction !== null)
  const timed = list.filter(t => t.serviceStart !== null && t.serviceEnd !== null)

  const avgServiceMs = timed.length > 0
    ? timed.reduce((sum, t) => sum + ((t.serviceEnd ?? 0) - (t.serviceStart ?? 0)), 0) / timed.length
    : null
  const avgSatisfaction = rated.length > 0
    ? rated.reduce((sum, t) => sum + (t.satisfaction ?? 0), 0) / rated.length
    : null

  const d = new Date(start)
  const label = `周报 ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} 起`

  const questions = list
    .filter(t => t.question.trim() !== '')
    .sort((a, b) => a.createdAt - b.createdAt)
    .map((t: Ticket) => ({ text: t.question, createdAt: t.createdAt }))

  return {
    period: { since: start, until, label },
    stats: {
      totalTickets: total,
      aiResolved,
      humanHandoffs,
      handoffRate: total > 0 ? humanHandoffs / total : null,
      avgServiceMs,
      avgSatisfaction,
      openTickets: open,
    },
    faq: clusterQuestions(questions),
  }
}
