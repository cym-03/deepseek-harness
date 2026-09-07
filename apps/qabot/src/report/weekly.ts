/** Aggregates service volume, employee feedback, repeated question themes, and handoff-linked knowledge gaps. */
import type { ConversationMessageRepository, TicketRepository } from '../domain/repositories.ts'
import { cosine, termsOf } from '../kb/embed.ts'

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
  faq: Array<{ question: string; count: number; conversationCount: number; handoffCount: number }>
  feedback: Array<{ ticketId: number; question: string; rating: number; comment: string | null; ratedAt: number }>
}

interface QuestionItem { text: string; sessionId: string; handoff: boolean }

const QUESTION_FILLERS = /请问|麻烦问下|麻烦问一下|我想问一下|我想咨询|想咨询一下|能不能|可不可以|可以吗|怎么办|怎么样|如何|怎么|是什么|有没有|一下|呢|啊|呀|吗|的规定|规定/g
const TOPIC_RULES: ReadonlyArray<[string, RegExp]> = [
  ['考勤休假', /考勤|迟到|早退|请假|休假|年假|病假|事假|调休|加班|值班/],
  ['薪酬福利', /薪资|工资|奖金|社保|公积金|福利|补贴/],
  ['报销财务', /报销|发票|付款|财务|费用|借款/],
  ['账号权限', /账号|登录|密码|权限|系统|飞书/],
  ['设备网络', /电脑|网络|打印机|设备|工位|门禁/],
  ['入转调离', /入职|离职|转岗|调岗|合同|试用|转正/],
  ['绩效制度', /绩效|制度|员工手册|奖惩/],
]

function normalizedQuestion(text: string): string {
  return text.toLowerCase().replace(/[\s，。！？、；：,.!?;:'"“”‘’（）()【】\[\]]/g, '').replace(QUESTION_FILLERS, '')
}

function meaningfulQuestion(text: string): boolean {
  const normalized = normalizedQuestion(text)
  return normalized.length >= 2
    && !/^(你好|您好|在吗|谢谢|谢谢你|再见|好的|好吧|好叭|好滴|嗯|哦|收到|转人工|人工服务|人工客服|测试|测试成功|回答测试成功)$/.test(normalized)
    && !/^(请.*回答|回答).*(测试|成功)/.test(normalized)
    && !/(转人工|人工转)/.test(normalized)
}

function questionVec(text: string): Record<string, number> {
  const vec: Record<string, number> = {}
  for (const term of termsOf(normalizedQuestion(text))) vec[term] = (vec[term] ?? 0) + 1
  return vec
}

function topicOf(text: string): string | undefined {
  return TOPIC_RULES.find(([, pattern]) => pattern.test(text))?.[0]
}

function related(left: string, right: string, score: number): boolean {
  const a = normalizedQuestion(left)
  const b = normalizedQuestion(right)
  if (a !== '' && b !== '' && (a.includes(b) || b.includes(a))) return true
  const leftTopic = topicOf(left)
  return (leftTopic !== undefined && leftTopic === topicOf(right)) || score >= 0.34
}

/** Groups approximate question types without calling a model or consuming model quota. */
export function clusterQuestions(items: QuestionItem[]): WeeklyReport['faq'] {
  const clusters: Array<{
    centroid: Record<string, number>
    sample: string
    topic?: string
    count: number
    sessions: Set<string>
    handoffSessions: Set<string>
  }> = []
  for (const item of items.filter(item => meaningfulQuestion(item.text))) {
    const vec = questionVec(item.text)
    let best = -1
    let bestScore = 0
    for (let i = 0; i < clusters.length; i++) {
      const candidate = clusters[i]
      if (candidate === undefined) continue
      const score = cosine(vec, candidate.centroid)
      if (related(item.text, candidate.sample, score) && score >= bestScore) {
        best = i
        bestScore = score
      }
    }
    if (best < 0) {
      const topic = topicOf(item.text)
      clusters.push({
        centroid: vec,
        sample: item.text,
        ...(topic === undefined ? {} : { topic }),
        count: 1,
        sessions: new Set([item.sessionId]),
        handoffSessions: new Set(item.handoff ? [item.sessionId] : []),
      })
      continue
    }
    const cluster = clusters[best]
    if (cluster === undefined) continue
    cluster.count += 1
    cluster.sessions.add(item.sessionId)
    if (item.handoff) cluster.handoffSessions.add(item.sessionId)
    if (item.text.length < cluster.sample.length) cluster.sample = item.text
    for (const [term, weight] of Object.entries(vec)) {
      cluster.centroid[term] = ((cluster.centroid[term] ?? 0) * (cluster.count - 1) + weight) / cluster.count
    }
  }
  return clusters.filter(cluster => cluster.count >= 2 || cluster.handoffSessions.size > 0)
    .sort((left, right) => right.count - left.count || right.handoffSessions.size - left.handoffSessions.size).slice(0, 10)
    .map(cluster => ({
      question: cluster.topic ?? cluster.sample,
      count: cluster.count,
      conversationCount: cluster.sessions.size,
      handoffCount: cluster.handoffSessions.size,
    }))
}

const pad = (value: number): string => String(value).padStart(2, '0')

/** Builds the operations report from tickets and all persisted user messages. */
export async function buildWeeklyReport(
  tickets: TicketRepository,
  since?: number,
  weeks = 1,
  assignee?: string,
  messages?: ConversationMessageRepository,
): Promise<WeeklyReport> {
  const until = Date.now()
  const start = since ?? until - weeks * 7 * 24 * 60 * 60 * 1000
  const list = (await tickets.list({ limit: 1000 })).filter(ticket => ticket.createdAt >= start && ticket.createdAt <= until)
    .filter(ticket => assignee === undefined || assignee === '' || ticket.assignee === assignee)
  const humanHandoffs = list.filter(ticket => ticket.handoffReason !== null || ticket.status === 'waiting_agent').length
  const rated = list.filter(ticket => ticket.satisfaction !== null)
  const timed = list.filter(ticket => ticket.serviceStart !== null && ticket.serviceEnd !== null)
  const questionItems = (await Promise.all(list.map(async (ticket): Promise<QuestionItem[]> => {
    const projected = messages === undefined
      ? []
      : (await messages.list(ticket.sessionId)).filter(message => message.role === 'user')
    const source = projected.length > 0
      ? projected.map(message => ({ text: message.text, sessionId: ticket.sessionId, handoff: false }))
      : ticket.question.trim() === '' ? [] : [{ text: ticket.question, sessionId: ticket.sessionId, handoff: false }]
    if (ticket.handoffReason !== null) {
      for (let i = source.length - 1; i >= 0; i--) {
        const question = source[i]
        if (question !== undefined && meaningfulQuestion(question.text)) {
          question.handoff = true
          break
        }
      }
    }
    return source
  }))).flat()
  const date = new Date(start)
  return {
    period: { since: start, until, label: `周报 ${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} 起` },
    stats: {
      totalTickets: list.length,
      aiResolved: list.filter(ticket => (ticket.status === 'resolved' || ticket.status === 'closed') && ticket.handoffReason === null).length,
      humanHandoffs,
      handoffRate: list.length > 0 ? humanHandoffs / list.length : null,
      avgServiceMs: timed.length > 0
        ? timed.reduce((sum, ticket) => sum + ((ticket.serviceEnd ?? 0) - (ticket.serviceStart ?? 0)), 0) / timed.length
        : null,
      avgSatisfaction: rated.length > 0 ? rated.reduce((sum, ticket) => sum + (ticket.satisfaction ?? 0), 0) / rated.length : null,
      openTickets: list.filter(ticket => (
        ['open', 'in_service', 'waiting_agent', 'waiting_employee', 'reopened'].includes(ticket.status)
      )).length,
    },
    faq: clusterQuestions(questionItems),
    feedback: rated.sort((left, right) => right.updatedAt - left.updatedAt).map(ticket => ({
      ticketId: ticket.id,
      question: ticket.question,
      rating: ticket.satisfaction ?? 0,
      comment: ticket.satisfactionComment,
      ratedAt: ticket.updatedAt,
    })),
  }
}
