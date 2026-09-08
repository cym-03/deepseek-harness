/** MySQL-backed operations analytics, curated FAQs, actions, VOC cache, and readable audit pages. */
import { createHash } from 'node:crypto'
import type { Pool, PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise'
import type { PortalIdentity } from '../security/identity.ts'
import { fromMysqlDate, toMysqlDate, type MysqlDateValue } from '../database/mysql-time.ts'

export const OPERATIONS_GROUPS = ['人事', '行政', 'IT', '财务', '其他'] as const
export type OperationsGroup = (typeof OPERATIONS_GROUPS)[number]

export interface OperationsRange {
  from: number
  to: number
  group?: OperationsGroup
}

export interface CuratedFaqInput {
  group: OperationsGroup
  question: string
  answer: string
  enabled: boolean
  sortOrder: number
  links: Array<{ title: string; url: string }>
  images: Array<{ id?: number; fileName: string; mimeType: string; base64?: string }>
}

interface CountRow extends RowDataPacket {
  total: number
}
interface TicketMetricRow extends RowDataPacket {
  total: number
  completed: number
  self_service: number
  handed_off: number
  rated: number
  avg_rating: number | null
  avg_resolution_ms: number | null
  avg_ai_ms: number | null
  avg_human_ms: number | null
  estimated: number
}
interface DomainMetricRow extends RowDataPacket {
  service_group: string
  consultations: number
  completed: number
  self_service: number
  handed_off: number
  rated: number
  avg_rating: number | null
}
interface AttentionRow extends RowDataPacket {
  service_group: string
  question: string
  knowledge_hit: number | null
  total: number
}
interface VoiceRow extends RowDataPacket {
  ticket_id: number
  service_group: string
  rating: number
  comment: string
  rated_at: MysqlDateValue
}
interface RatingMetricRow extends RowDataPacket {
  rated: number
  avg_rating: number | null
}
interface DomainRatingRow extends RowDataPacket {
  service_group: string
  avg_rating: number | null
}
interface FaqRow extends RowDataPacket {
  id: number
  service_group: OperationsGroup
  question: string
  normalized_question: string
  answer: string
  sort_order: number
  enabled: number
  usage_count: number
  created_by_name: string
  updated_at: MysqlDateValue
}

const EMPTY_MESSAGES = new Set([
  '你好',
  '您好',
  '在吗',
  '谢谢',
  '谢谢你',
  '再见',
  '好的',
  '收到',
  '转人工',
  '人工服务',
  '人工客服',
  '测试',
  '测试成功',
])

/** Normalizes a question for exact curated-answer matching. */
export function normalizeFaqQuestion(value: string): string {
  return value.toLowerCase().replace(/[\s，。！？、；：,.!?;:'"“”‘’（）()【】\[\]]/g, '')
}

function similarity(left: string, right: string): number {
  const grams = (value: string): Set<string> => {
    const result = new Set<string>()
    for (let index = 0; index < value.length - 1; index++) result.add(value.slice(index, index + 2))
    if (result.size === 0 && value !== '') result.add(value)
    return result
  }
  const a = grams(left),
    b = grams(right)
  const intersection = [...a].filter(item => b.has(item)).length
  return intersection / Math.max(1, new Set([...a, ...b]).size)
}

export interface SimilarIssue {
  text: string
  count: number
  group?: string
  ticketIds?: number[]
}

/** Groups wording variants into one operational issue without claiming that an answer was wrong. */
export function clusterSimilarIssues(
  items: SimilarIssue[],
  limit: number,
): Array<{ theme: string; count: number; samples: string[]; group?: string; ticketIds?: number[] }> {
  const clusters: Array<{
    theme: string
    normalized: string
    count: number
    samples: string[]
    group?: string
    ticketIds: number[]
  }> = []
  for (const item of [...items].sort((left, right) => right.count - left.count)) {
    const normalized = normalizeFaqQuestion(item.text)
    const target = clusters.find((cluster) => {
      if (cluster.group !== item.group) return false
      const shorter = normalized.length <= cluster.normalized.length ? normalized : cluster.normalized
      const longer = normalized.length > cluster.normalized.length ? normalized : cluster.normalized
      return (shorter.length >= 4 && longer.includes(shorter)) || similarity(normalized, cluster.normalized) >= 0.55
    })
    if (target === undefined) {
      clusters.push({
        theme: item.text,
        normalized,
        count: item.count,
        samples: [item.text],
        ticketIds: [...(item.ticketIds ?? [])],
        ...(item.group === undefined ? {} : { group: item.group }),
      })
      continue
    }
    target.count += item.count
    if (!target.samples.includes(item.text) && target.samples.length < 3) target.samples.push(item.text)
    target.ticketIds.push(...(item.ticketIds ?? []).filter(id => !target.ticketIds.includes(id)))
  }
  return clusters
    .sort((left, right) => right.count - left.count)
    .slice(0, limit)
    .map(({ normalized: _normalized, ticketIds, ...cluster }) => ({
      ...cluster,
      ...(ticketIds.length === 0 ? {} : { ticketIds }),
    }))
}

function parseIds(value: string | null): number[] {
  return String(value ?? '')
    .split(',')
    .map(Number)
    .filter(Number.isInteger)
}

function canManage(identity: PortalIdentity, group: string): boolean {
  return (
    identity.roles.includes('SystemAdmin') ||
    identity.departmentIds.map(item => (item === 'default' ? '其他' : item)).includes(group)
  )
}

/** Returns whether text is a business question included in analytics. */
export function isEffectiveQuestion(value: string): boolean {
  const normalized = normalizeFaqQuestion(value).replace(
    /^(请问|麻烦问下|麻烦问一下|我想问一下|我想咨询|想咨询一下)/,
    '',
  )
  return normalized.length >= 2 && !EMPTY_MESSAGES.has(normalized) && !/^(请.*回答|回答).*(测试|成功)/.test(normalized)
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator > 0 ? numerator / denominator : null
}

function metric(row: TicketMetricRow) {
  return {
    validConsultations: Number(row.total),
    completed: Number(row.completed),
    selfServiceRate: ratio(Number(row.self_service), Number(row.completed)),
    handoffRate: ratio(Number(row.handed_off), Number(row.total)),
    satisfaction: row.avg_rating === null ? null : Number(row.avg_rating),
    ratingCount: Number(row.rated),
    ratingRate: ratio(Number(row.rated), Number(row.completed)),
    avgResolutionMs: row.avg_resolution_ms === null ? null : Number(row.avg_resolution_ms),
    avgAiResolutionMs: row.avg_ai_ms === null ? null : Number(row.avg_ai_ms),
    avgHumanResolutionMs: row.avg_human_ms === null ? null : Number(row.avg_human_ms),
    estimatedResolutionCount: Number(row.estimated),
  }
}

function previousRange(range: OperationsRange): OperationsRange {
  const duration = range.to - range.from
  return { from: range.from - duration, to: range.from, ...(range.group === undefined ? {} : { group: range.group }) }
}

function groupSql(group?: OperationsGroup): { clause: string; values: string[] } {
  return group === undefined
    ? { clause: '', values: [] }
    : { clause: " AND COALESCE(t.analytics_domain, '其他') = ?", values: [group] }
}

function percentChange(current: number | null, previous: number | null): number | null {
  if (current === null || previous === null || previous === 0) return null
  return (current - previous) / Math.abs(previous)
}

interface VocModelChoice {
  message?: { content?: unknown }
}

/** Generates a concise evidence-bound VOC summary, or yields undefined so callers can use the rule fallback. */
export async function generateVocModelSummary(
  data: string,
  request: typeof fetch = fetch,
): Promise<string | undefined> {
  const key = process.env.DEEPSEEK_API_KEY?.trim()
  if (key === undefined || key === '') return undefined
  const base = (process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com').replace(/\/+$/, '')
  try {
    const response = await request(`${base}/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: process.env.QABOT_VOC_MODEL ?? process.env.DSH_QABOT_MODEL ?? 'deepseek-v4-flash',
        temperature: 0.2,
        max_tokens: 500,
        messages: [
          {
            role: 'system',
            content:
              '你是企业员工服务运营分析助手。只使用输入数据，用中文生成不超过300字的VOC摘要；概括主要咨询声音、转人工与差评主题、知识缺口和一项优先行动。不得虚构答错、人数、原因或趋势。',
          },
          { role: 'user', content: data },
        ],
      }),
    })
    if (!response.ok) return undefined
    const payload = (await response.json()) as { choices?: VocModelChoice[] }
    const content = payload.choices?.[0]?.message?.content
    return typeof content === 'string' && content.trim() !== '' ? content.trim() : undefined
  } catch {
    return undefined
  }
}

type HandoffSummaryItem = {
  reason: string
  group: string
  count: number
  quotes: string[]
  conversations?: string[]
  ticketIds: number[]
}
const handoffSummaryCache = new Map<string, string[]>()
const handoffSummaryPending = new Set<string>()

function handoffFallback(item: HandoffSummaryItem): string {
  if (!['历史转人工', '员工选择转人工'].includes(item.reason)) return item.reason
  return /(转人工|人工客服|人工协助|找人工)/.test(item.quotes.join('；'))
    ? '员工主动要求人工协助'
    : '员工问题需人工进一步处理'
}

function handoffEvidence(item: HandoffSummaryItem): { content: string; hash: string } {
  const content = JSON.stringify({
    group: item.group,
    conversations: item.conversations ?? item.quotes.map(quote => `员工：${quote}`),
  })
  return { content, hash: createHash('sha256').update(content).digest('hex') }
}

/** Returns cached titles immediately and refreshes missing model summaries without delaying the overview response. */
export function cachedHandoffReasons(items: HandoffSummaryItem[]): HandoffSummaryItem[] {
  const result = items.map((item) => {
    const { hash } = handoffEvidence(item)
    return { ...item, reason: handoffSummaryCache.get(hash)?.[0] ?? handoffFallback(item) }
  })
  for (const item of items) {
    const { hash } = handoffEvidence(item)
    if (handoffSummaryCache.has(hash) || handoffSummaryPending.has(hash)) continue
    handoffSummaryPending.add(hash)
    void summarizeHandoffReasons([item]).finally(() => handoffSummaryPending.delete(hash))
  }
  return result
}

/** Returns concise evidence-bound titles for handoff groups and reuses titles while the grouped evidence is unchanged. */
export async function summarizeHandoffReasons(
  items: HandoffSummaryItem[],
  request: typeof fetch = fetch,
): Promise<HandoffSummaryItem[]> {
  if (items.length === 0) return items
  const fallback = items.map(handoffFallback)
  const key = process.env.DEEPSEEK_API_KEY?.trim()
  if (key === undefined || key === '') {
    return items.map((item, index) => ({ ...item, reason: fallback[index] ?? handoffFallback(item) }))
  }
  const base = (process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com').replace(/\/+$/, '')
  return Promise.all(
    items.map(async (item, index) => {
      const { content: evidence, hash } = handoffEvidence(item)
      const cached = handoffSummaryCache.get(hash)?.[0]
      if (cached !== undefined) return { ...item, reason: cached }
      try {
        const response = await request(`${base}/chat/completions`, {
          method: 'POST',
          headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
          body: JSON.stringify({
            model: process.env.QABOT_VOC_MODEL ?? process.env.DSH_QABOT_MODEL ?? 'deepseek-v4-flash',
            temperature: 0.1,
            max_tokens: 400,
            messages: [
              {
                role: 'system',
                content:
                  '你是员工服务运营分析助手。阅读转人工会话的完整上下文，归纳导致转人工的具体业务问题或未解决需求，不要把“要求转人工”这个动作本身当作原因。只有会话中完全没有业务问题时，才可归纳为“员工直接请求人工服务”。只输出包含一个标题的JSON字符串数组；标题8至20个汉字，不得编造事实或输出百分比。',
              },
              { role: 'user', content: evidence },
            ],
          }),
        })
        if (response.ok) {
          const payload = (await response.json()) as { choices?: VocModelChoice[] }
          const rawContent = payload.choices?.[0]?.message?.content
          const content = typeof rawContent === 'string' ? rawContent.trim() : ''
          const parsed = JSON.parse(content.replace(/^```(?:json)?\s*|\s*```$/g, '')) as unknown
          const title =
            Array.isArray(parsed) && parsed.length === 1 && typeof parsed[0] === 'string' ? parsed[0].trim() : ''
          if (title.length >= 4 && title.length <= 30) {
            if (handoffSummaryCache.size >= 100) handoffSummaryCache.clear()
            handoffSummaryCache.set(hash, [title])
            return { ...item, reason: title }
          }
        }
      } catch {
        // Model and response failures use the deterministic evidence-bound title below.
      }
      return { ...item, reason: fallback[index] ?? handoffFallback(item) }
    }),
  )
}

const AUDIT_ACTION_NAMES: Record<string, string> = {
  'ticket.accept': '接收工单',
  'ticket.reply': '回复员工',
  'ticket.transfer': '转接工单',
  'ticket.close': '结束服务',
  'staff.upsert': '维护服务人员',
  'staff.remove': '移除服务人员',
  'knowledge.source.add': '新增知识源',
  'knowledge.source.restore': '恢复知识源',
  'knowledge.source.edit': '编辑知识源',
  'knowledge.source.sync': '同步知识源',
  'knowledge.source.sync_failed': '知识源同步失败',
  'knowledge.source.remove': '移除知识源',
  'faq.create': '新增常见问题',
  'faq.update': '编辑常见问题',
  'faq.remove': '移除常见问题',
  'action.create': '新增改进行动',
  'action.update': '更新改进行动',
  'faq.create_failed': '新增常见问题',
  'faq.update_failed': '编辑常见问题',
  'faq.remove_failed': '移除常见问题',
  'action.create_failed': '新增改进行动',
  'action.update_failed': '更新改进行动',
}

/** Operations repository whose authoritative data is MySQL. */
export class MysqlOperationsRepository {
  constructor(private readonly pool: Pool) {}

  async overview(range: OperationsRange): Promise<Record<string, unknown>> {
    const [
      current,
      previous,
      currentRatings,
      previousRatings,
      domains,
      domainRatings,
      attention,
      handoffs,
      unanswered,
      lowRatings,
      voices,
    ] = await Promise.all([
      this.ticketMetrics(range),
      this.ticketMetrics(previousRange(range)),
      this.ratingMetrics(range),
      this.ratingMetrics(previousRange(range)),
      this.domainMetrics(range),
      this.domainRatings(range),
      this.attentionIssues(range),
      this.handoffReasons(range),
      this.unanswered(range),
      this.lowRatings(range),
      this.employeeVoices(range),
    ])
    const currentBase = metric(current)
    const previousBase = metric(previous)
    const currentMetric = {
      ...currentBase,
      satisfaction: currentRatings.avg_rating === null ? null : Number(currentRatings.avg_rating),
      ratingCount: Number(currentRatings.rated),
      ratingRate: ratio(Number(currentRatings.rated), currentBase.completed),
    }
    const previousMetric = {
      ...previousBase,
      satisfaction: previousRatings.avg_rating === null ? null : Number(previousRatings.avg_rating),
      ratingCount: Number(previousRatings.rated),
      ratingRate: ratio(Number(previousRatings.rated), previousBase.completed),
    }
    const total = currentMetric.validConsultations
    return {
      period: range,
      previousPeriod: previousRange(range),
      metrics: {
        ...currentMetric,
        changes: {
          selfServiceRate: percentChange(currentMetric.selfServiceRate, previousMetric.selfServiceRate),
          handoffRate: percentChange(currentMetric.handoffRate, previousMetric.handoffRate),
          satisfaction: percentChange(currentMetric.satisfaction, previousMetric.satisfaction),
          avgResolutionMs: percentChange(currentMetric.avgResolutionMs, previousMetric.avgResolutionMs),
        },
      },
      domains: domains.map(row => ({
        group: row.service_group,
        consultations: Number(row.consultations),
        share: ratio(Number(row.consultations), total),
        selfServiceRate: ratio(Number(row.self_service), Number(row.completed)),
        handoffRate: ratio(Number(row.handed_off), Number(row.consultations)),
        satisfaction: domainRatings.find(item => item.service_group === row.service_group)?.avg_rating ?? null,
        attention: attention
          .filter(item => item.service_group === row.service_group)
          .slice(0, 3)
          .map(item => ({
            question: item.question,
            reason: item.knowledge_hit === 1 ? '智能回答后仍转人工' : '知识库缺少资料',
            count: Number(item.total),
          })),
      })),
      causes: {
        handoff: cachedHandoffReasons(handoffs),
        unanswered,
        lowRatings,
      },
      voices,
    }
  }

  private async ticketMetrics(range: OperationsRange): Promise<TicketMetricRow> {
    const scoped = groupSql(range.group)
    const [rows] = await this.pool.execute<TicketMetricRow[]>(
      `
      SELECT COUNT(*) AS total,
        SUM(t.status IN ('resolved','closed')) AS completed,
        SUM(t.status IN ('resolved','closed') AND t.kind = 'ai' AND NOT EXISTS(
          SELECT 1 FROM qa_handoff_events h WHERE h.session_id=t.session_id AND h.event_type='selected')) AS self_service,
        SUM(EXISTS(SELECT 1 FROM qa_handoff_events h WHERE h.session_id=t.session_id AND h.event_type='selected')) AS handed_off,
        SUM(t.satisfaction IS NOT NULL) AS rated, AVG(t.satisfaction) AS avg_rating,
        AVG(IF(t.service_start IS NULL OR t.service_end IS NULL OR t.service_end<t.service_start, NULL,
          TIMESTAMPDIFF(MICROSECOND,t.service_start,t.service_end)/1000)) AS avg_resolution_ms,
        AVG(IF(t.kind='ai' AND t.service_start IS NOT NULL AND t.service_end>=t.service_start,
          TIMESTAMPDIFF(MICROSECOND,t.service_start,t.service_end)/1000,NULL)) AS avg_ai_ms,
        AVG(IF(t.kind='human' AND t.service_start IS NOT NULL AND t.service_end>=t.service_start,
          TIMESTAMPDIFF(MICROSECOND,t.service_start,t.service_end)/1000,NULL)) AS avg_human_ms,
        SUM(t.resolution_time_estimated=1) AS estimated
      FROM tickets t WHERE t.created_at >= ? AND t.created_at < ?${scoped.clause}
    `,
      [toMysqlDate(range.from), toMysqlDate(range.to), ...scoped.values],
    )
    return (
      rows[0] ??
      ({
        total: 0,
        completed: 0,
        self_service: 0,
        handed_off: 0,
        rated: 0,
        avg_rating: null,
        avg_resolution_ms: null,
        avg_ai_ms: null,
        avg_human_ms: null,
        estimated: 0,
      } as TicketMetricRow)
    )
  }

  private async domainMetrics(range: OperationsRange): Promise<DomainMetricRow[]> {
    const scoped = groupSql(range.group)
    const [rows] = await this.pool.execute<DomainMetricRow[]>(
      `
      SELECT COALESCE(t.analytics_domain,'其他') AS service_group, COUNT(*) AS consultations,
        SUM(t.status IN ('resolved','closed')) AS completed,
        SUM(t.status IN ('resolved','closed') AND t.kind='ai' AND NOT EXISTS(
          SELECT 1 FROM qa_handoff_events h WHERE h.session_id=t.session_id AND h.event_type='selected')) AS self_service,
        SUM(EXISTS(SELECT 1 FROM qa_handoff_events h WHERE h.session_id=t.session_id AND h.event_type='selected')) AS handed_off,
        SUM(t.satisfaction IS NOT NULL) AS rated, AVG(t.satisfaction) AS avg_rating
      FROM tickets t WHERE t.created_at >= ? AND t.created_at < ?${scoped.clause}
      GROUP BY COALESCE(t.analytics_domain,'其他') ORDER BY consultations DESC
    `,
      [toMysqlDate(range.from), toMysqlDate(range.to), ...scoped.values],
    )
    return rows
  }

  private async ratingMetrics(range: OperationsRange): Promise<RatingMetricRow> {
    const scoped = groupSql(range.group)
    const [rows] = await this.pool.execute<RatingMetricRow[]>(
      `
      SELECT COUNT(*) AS rated,AVG(t.satisfaction) AS avg_rating FROM tickets t
      WHERE t.satisfaction IS NOT NULL AND t.updated_at>=? AND t.updated_at<?${scoped.clause}
    `,
      [toMysqlDate(range.from), toMysqlDate(range.to), ...scoped.values],
    )
    return rows[0] ?? ({ rated: 0, avg_rating: null } as RatingMetricRow)
  }

  private async domainRatings(range: OperationsRange): Promise<DomainRatingRow[]> {
    const scoped = groupSql(range.group)
    const [rows] = await this.pool.execute<DomainRatingRow[]>(
      `
      SELECT COALESCE(t.analytics_domain,'其他') AS service_group,AVG(t.satisfaction) AS avg_rating FROM tickets t
      WHERE t.satisfaction IS NOT NULL AND t.updated_at>=? AND t.updated_at<?${scoped.clause}
      GROUP BY COALESCE(t.analytics_domain,'其他')
    `,
      [toMysqlDate(range.from), toMysqlDate(range.to), ...scoped.values],
    )
    return rows
  }

  private async attentionIssues(range: OperationsRange): Promise<AttentionRow[]> {
    const group = range.group === undefined ? '' : ' AND h.service_group = ?'
    const [rows] = await this.pool.execute<AttentionRow[]>(
      `
      SELECT h.service_group,h.trigger_question AS question,MAX(q.knowledge_hit) AS knowledge_hit,COUNT(DISTINCT h.id) AS total
      FROM qa_handoff_events h LEFT JOIN qa_turn_analytics q
        ON q.session_id=h.session_id AND q.question=h.trigger_question
      WHERE h.event_type='selected' AND h.created_at>=? AND h.created_at<?${group}
        AND h.trigger_question NOT IN ('转人工','人工服务','人工客服')
      GROUP BY h.service_group,h.trigger_question ORDER BY total DESC
    `,
      [toMysqlDate(range.from), toMysqlDate(range.to), ...(range.group === undefined ? [] : [range.group])],
    )
    return rows
  }

  private async employeeVoices(range: OperationsRange): Promise<Array<Record<string, unknown>>> {
    const scoped = groupSql(range.group)
    const [rows] = await this.pool.execute<VoiceRow[]>(
      `
      SELECT t.id AS ticket_id,COALESCE(t.analytics_domain,'其他') AS service_group,t.satisfaction AS rating,
        COALESCE(NULLIF(TRIM(t.satisfaction_comment),''),'未填写文字评价') AS comment,t.updated_at AS rated_at
      FROM tickets t WHERE t.satisfaction IS NOT NULL AND t.updated_at>=? AND t.updated_at<?${scoped.clause}
      ORDER BY t.updated_at DESC,t.id DESC LIMIT 50
    `,
      [toMysqlDate(range.from), toMysqlDate(range.to), ...scoped.values],
    )
    return rows.map(row => ({
      ticketId: row.ticket_id,
      group: row.service_group,
      rating: Number(row.rating),
      comment: row.comment,
      ratedAt: fromMysqlDate(row.rated_at),
    }))
  }

  private async handoffReasons(range: OperationsRange): Promise<HandoffSummaryItem[]> {
    const group = range.group === undefined ? '' : ' AND service_group = ?'
    const [rows] = await this.pool.execute<
      Array<
        RowDataPacket & {
          reason_type: string
          service_group: string
          total: number
          samples: string
          conversations: string
          ticket_ids: string
        }
      >
    >(
      `
      SELECT h.reason_type, h.service_group, 1 AS total, h.trigger_question AS samples,
        GROUP_CONCAT(CONCAT(CASE cm.role WHEN 'user' THEN '员工' WHEN 'assistant' THEN '智能助手' WHEN 'human' THEN '人工客服' ELSE '系统' END,
          '：', REPLACE(REPLACE(LEFT(cm.content, 600), '\\r', ' '), '\\n', ' '))
          ORDER BY cm.created_at, cm.source_order, cm.id SEPARATOR '\\n') AS conversations,
        CAST(h.ticket_id AS CHAR) AS ticket_ids
      FROM qa_handoff_events h
      LEFT JOIN conversation_messages cm ON cm.session_id=h.session_id
      WHERE h.event_type='selected' AND h.created_at >= ? AND h.created_at < ?${group.replace('service_group', 'h.service_group')}
      GROUP BY h.id,h.reason_type,h.service_group,h.trigger_question,h.ticket_id,h.created_at
      ORDER BY h.created_at DESC LIMIT 10
    `,
      [toMysqlDate(range.from), toMysqlDate(range.to), ...(range.group === undefined ? [] : [range.group])],
    )
    return rows.map(row => ({
      reason: row.reason_type,
      group: row.service_group,
      count: Number(row.total),
      quotes: String(row.samples ?? '')
        .split('\n')
        .filter(Boolean)
        .slice(0, 3),
      conversations: String(row.conversations ?? '')
        .split('\n')
        .filter(Boolean),
      ticketIds: parseIds(row.ticket_ids),
    }))
  }

  private async unanswered(range: OperationsRange): Promise<unknown[]> {
    const group = range.group === undefined ? '' : ' AND service_group = ?'
    const [rows] = await this.pool.execute<
      Array<RowDataPacket & { question: string; service_group: string; total: number; ticket_ids: string }>
    >(
      `
      SELECT question,service_group,COUNT(*) AS total,GROUP_CONCAT(DISTINCT ticket_id ORDER BY ticket_id DESC) AS ticket_ids FROM qa_turn_analytics
      WHERE faq_id IS NULL AND (knowledge_hit=0 OR relevance IS NULL)
        AND EXISTS(SELECT 1 FROM qa_handoff_events h WHERE h.session_id=qa_turn_analytics.session_id
          AND h.event_type='suggested' AND h.trigger_question=qa_turn_analytics.question)
        AND created_at >= ? AND created_at < ?${group}
      GROUP BY service_group,normalized_question,question ORDER BY total DESC LIMIT 200
    `,
      [toMysqlDate(range.from), toMysqlDate(range.to), ...(range.group === undefined ? [] : [range.group])],
    )
    return clusterSimilarIssues(
      rows.map(row => ({
        text: row.question,
        count: Number(row.total),
        group: row.service_group,
        ticketIds: parseIds(row.ticket_ids),
      })),
      10,
    ).map(cluster => ({
      question: cluster.theme,
      group: cluster.group,
      count: cluster.count,
      samples: cluster.samples,
      ticketIds: cluster.ticketIds ?? [],
    }))
  }

  private async lowRatings(range: OperationsRange): Promise<unknown[]> {
    const scoped = groupSql(range.group)
    const [rows] = await this.pool.execute<
      Array<
        RowDataPacket & { comment: string; service_group: string; rating: number; total: number; ticket_ids: string }
      >
    >(
      `
      SELECT TRIM(t.satisfaction_comment) AS comment,
        COALESCE(t.analytics_domain,'其他') AS service_group,MIN(t.satisfaction) AS rating,COUNT(*) AS total,
        GROUP_CONCAT(DISTINCT t.id ORDER BY t.id DESC) AS ticket_ids FROM tickets t
      WHERE t.satisfaction BETWEEN 1 AND 2 AND NULLIF(TRIM(t.satisfaction_comment),'') IS NOT NULL
        AND t.updated_at >= ? AND t.updated_at < ?${scoped.clause}
      GROUP BY COALESCE(t.analytics_domain,'其他'),TRIM(t.satisfaction_comment) ORDER BY total DESC LIMIT 100
    `,
      [toMysqlDate(range.from), toMysqlDate(range.to), ...scoped.values],
    )
    return clusterSimilarIssues(
      rows.map(row => ({
        text: row.comment,
        count: Number(row.total),
        group: row.service_group,
        ticketIds: parseIds(row.ticket_ids),
      })),
      5,
    ).map(cluster => ({
      theme: cluster.theme,
      group: cluster.group,
      count: cluster.count,
      samples: cluster.samples,
      ticketIds: cluster.ticketIds ?? [],
    }))
  }

  async recordTurn(input: {
    sessionId: string
    ticketId: number
    question: string
    answer: string
    group: OperationsGroup
    knowledgeHit: boolean
    sourceId?: number
    relevance?: number
    faqId?: number
  }): Promise<void> {
    if (!isEffectiveQuestion(input.question)) return
    await this.pool.execute(
      `INSERT INTO qa_turn_analytics
      (session_id,ticket_id,question,normalized_question,answer,service_group,knowledge_hit,knowledge_source_id,relevance,faq_id,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [
        input.sessionId,
        input.ticketId,
        input.question,
        normalizeFaqQuestion(input.question),
        input.answer,
        input.group,
        input.knowledgeHit ? 1 : 0,
        input.sourceId ?? null,
        input.relevance ?? null,
        input.faqId ?? null,
        toMysqlDate(Date.now()),
      ],
    )
    await this.refreshTicketDomain(input.ticketId, input.sessionId)
  }

  async recordHandoff(input: {
    sessionId: string
    ticketId: number
    type: 'suggested' | 'selected'
    question: string
    reason: string
    group: OperationsGroup
  }): Promise<void> {
    await this.pool.execute(
      `INSERT INTO qa_handoff_events
      (session_id,ticket_id,event_type,trigger_question,reason_type,reason_text,service_group,created_at)
      VALUES (?,?,?,?,?,?,?,?)`,
      [
        input.sessionId,
        input.ticketId,
        input.type,
        input.question,
        input.reason,
        input.reason,
        input.group,
        toMysqlDate(Date.now()),
      ],
    )
    if (input.type === 'selected') {
      await this.refreshTicketDomain(input.ticketId, input.sessionId)
    }
  }

  private async refreshTicketDomain(ticketId: number, sessionId: string): Promise<void> {
    await this.pool.execute(
      `UPDATE tickets SET analytics_domain=COALESCE(
      (SELECT h.service_group FROM qa_handoff_events h WHERE h.session_id=? AND h.event_type='selected' ORDER BY h.created_at DESC,h.id DESC LIMIT 1),
      (SELECT q.service_group FROM qa_turn_analytics q WHERE q.session_id=? AND q.faq_id IS NOT NULL ORDER BY q.created_at DESC,q.id DESC LIMIT 1),
      (SELECT q.service_group FROM qa_turn_analytics q WHERE q.session_id=? AND q.knowledge_source_id IS NOT NULL ORDER BY q.relevance DESC,q.created_at DESC,q.id DESC LIMIT 1),
      '其他') WHERE id=?`,
      [sessionId, sessionId, sessionId, ticketId],
    )
  }

  async listFaqs(group?: OperationsGroup, enabledOnly = false): Promise<unknown[]> {
    const where = [group === undefined ? undefined : 'f.service_group=?', enabledOnly ? 'f.enabled=1' : undefined]
      .filter(Boolean)
      .join(' AND ')
    const [rows] = await this.pool.execute<FaqRow[]>(
      `SELECT f.* FROM curated_faqs f ${where === '' ? '' : `WHERE ${where}`}
      ORDER BY f.service_group, f.sort_order, f.id`,
      group === undefined ? [] : [group],
    )
    return await Promise.all(rows.map(async row => this.faqPayload(row)))
  }

  private async faqPayload(row: FaqRow): Promise<Record<string, unknown>> {
    const [links, images] = await Promise.all([
      this.pool.execute<Array<RowDataPacket & { id: number; title: string; url: string }>>(
        'SELECT id,title,url FROM curated_faq_links WHERE faq_id=? ORDER BY sort_order,id',
        [row.id],
      ),
      this.pool.execute<Array<RowDataPacket & { id: number; file_name: string; mime_type: string }>>(
        'SELECT id,file_name,mime_type FROM curated_faq_assets WHERE faq_id=? ORDER BY sort_order,id',
        [row.id],
      ),
    ])
    return {
      id: row.id,
      group: row.service_group,
      question: row.question,
      answer: row.answer,
      sortOrder: row.sort_order,
      enabled: row.enabled === 1,
      usageCount: Number(row.usage_count),
      createdByName: row.created_by_name,
      updatedAt: fromMysqlDate(row.updated_at),
      links: links[0].map(item => ({ id: item.id, title: item.title, url: item.url })),
      images: images[0].map(item => ({ id: item.id, fileName: item.file_name, mimeType: item.mime_type })),
    }
  }

  async createFaq(identity: PortalIdentity, input: CuratedFaqInput): Promise<Record<string, unknown>> {
    return await this.withFaqTransaction(identity, input)
  }

  async updateFaq(identity: PortalIdentity, id: number, input: CuratedFaqInput): Promise<Record<string, unknown>> {
    return await this.withFaqTransaction(identity, input, id)
  }

  private async withFaqTransaction(
    identity: PortalIdentity,
    input: CuratedFaqInput,
    id?: number,
  ): Promise<Record<string, unknown>> {
    validateFaq(input)
    const connection = await this.pool.getConnection()
    await connection.beginTransaction()
    try {
      const now = toMysqlDate(Date.now())
      let faqId = id
      if (id === undefined) {
        const [count] = await connection.execute<CountRow[]>(
          'SELECT COUNT(*) AS total FROM curated_faqs WHERE service_group=? AND enabled=1 FOR UPDATE',
          [input.group],
        )
        if (input.enabled && Number(count[0]?.total ?? 0) >= 5) throw new Error('FAQ_GROUP_LIMIT')
        const [result] = await connection.execute<ResultSetHeader>(
          `INSERT INTO curated_faqs
          (service_group,question,normalized_question,answer,sort_order,enabled,created_by,created_by_name,updated_by,updated_by_name,created_at,updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
          [
            input.group,
            input.question.trim(),
            normalizeFaqQuestion(input.question),
            input.answer.trim(),
            input.sortOrder,
            input.enabled ? 1 : 0,
            identity.employeeId,
            identity.displayName,
            identity.employeeId,
            identity.displayName,
            now,
            now,
          ],
        )
        faqId = result.insertId
      } else {
        const [current] = await connection.execute<Array<RowDataPacket & { enabled: number; service_group: string }>>(
          'SELECT enabled,service_group FROM curated_faqs WHERE id=? FOR UPDATE',
          [id],
        )
        if (current[0] === undefined) throw new Error('FAQ_NOT_FOUND')
        if (!canManage(identity, current[0].service_group) || !canManage(identity, input.group))
          throw new Error('FORBIDDEN')
        if (input.enabled && (current[0].enabled !== 1 || current[0].service_group !== input.group)) {
          const [count] = await connection.execute<CountRow[]>(
            'SELECT COUNT(*) AS total FROM curated_faqs WHERE service_group=? AND enabled=1 AND id<>?',
            [input.group, id],
          )
          if (Number(count[0]?.total ?? 0) >= 5) throw new Error('FAQ_GROUP_LIMIT')
        }
        await connection.execute(
          `UPDATE curated_faqs SET service_group=?,question=?,normalized_question=?,answer=?,sort_order=?,enabled=?,
          updated_by=?,updated_by_name=?,updated_at=? WHERE id=?`,
          [
            input.group,
            input.question.trim(),
            normalizeFaqQuestion(input.question),
            input.answer.trim(),
            input.sortOrder,
            input.enabled ? 1 : 0,
            identity.employeeId,
            identity.displayName,
            now,
            id,
          ],
        )
        await connection.execute('DELETE FROM curated_faq_links WHERE faq_id=?', [id])
        const retained = input.images.flatMap(image => (image.id === undefined ? [] : [image.id]))
        if (retained.length === 0) await connection.execute('DELETE FROM curated_faq_assets WHERE faq_id=?', [id])
        else
          await connection.execute(
            `DELETE FROM curated_faq_assets WHERE faq_id=? AND id NOT IN (${retained.map(() => '?').join(',')})`,
            [id, ...retained],
          )
      }
      if (faqId === undefined) throw new Error('FAQ_SAVE_FAILED')
      await this.insertFaqChildren(connection, faqId, input, now)
      await connection.commit()
      const [rows] = await this.pool.execute<FaqRow[]>('SELECT * FROM curated_faqs WHERE id=?', [faqId])
      const saved = rows[0]
      if (saved === undefined) throw new Error('FAQ_SAVE_FAILED')
      return await this.faqPayload(saved)
    } catch (error) {
      await connection.rollback()
      throw error
    } finally {
      connection.release()
    }
  }

  private async insertFaqChildren(
    connection: PoolConnection,
    faqId: number,
    input: CuratedFaqInput,
    now: Date,
  ): Promise<void> {
    for (const [index, link] of input.links.entries())
      await connection.execute('INSERT INTO curated_faq_links (faq_id,title,url,sort_order) VALUES (?,?,?,?)', [
        faqId,
        link.title.trim(),
        link.url.trim(),
        index,
      ])
    for (const [index, item] of input.images.entries()) {
      if (item.id !== undefined) {
        await connection.execute('UPDATE curated_faq_assets SET sort_order=? WHERE id=? AND faq_id=?', [
          index,
          item.id,
          faqId,
        ])
        continue
      }
      if (item.base64 === undefined) continue
      await connection.execute(
        'INSERT INTO curated_faq_assets (faq_id,file_name,mime_type,binary_data,sort_order,created_at) VALUES (?,?,?,?,?,?)',
        [faqId, item.fileName, item.mimeType, Buffer.from(item.base64, 'base64'), index, now],
      )
    }
  }

  async removeFaq(identity: PortalIdentity, id: number): Promise<boolean> {
    const [rows] = await this.pool.execute<Array<RowDataPacket & { service_group: string }>>(
      'SELECT service_group FROM curated_faqs WHERE id=?',
      [id],
    )
    if (rows[0] === undefined) return false
    if (!canManage(identity, rows[0].service_group)) throw new Error('FORBIDDEN')
    const [result] = await this.pool.execute<ResultSetHeader>('DELETE FROM curated_faqs WHERE id=?', [id])
    return result.affectedRows > 0
  }

  async recommendations(): Promise<Record<string, unknown>> {
    const groups = Object.fromEntries(
      await Promise.all(OPERATIONS_GROUPS.map(async group => [group, await this.listFaqs(group, true)])),
    )
    const [rows] = await this.pool.query<FaqRow[]>(`SELECT f.* FROM curated_faqs f LEFT JOIN curated_faq_usage u
      ON u.faq_id=f.id AND u.matched_at >= DATE_SUB(NOW(3),INTERVAL 30 DAY)
      WHERE f.enabled=1 GROUP BY f.id ORDER BY COUNT(u.id) DESC,f.sort_order,f.id LIMIT 5`)
    return { common: await Promise.all(rows.map(row => this.faqPayload(row))), groups }
  }

  async matchFaq(question: string): Promise<Record<string, unknown> | undefined> {
    const normalized = normalizeFaqQuestion(question)
    const [exact] = await this.pool.execute<FaqRow[]>(
      'SELECT * FROM curated_faqs WHERE enabled=1 AND normalized_question=? ORDER BY sort_order,id LIMIT 1',
      [normalized],
    )
    if (exact[0] !== undefined) return await this.faqPayload(exact[0])
    const [rows] = await this.pool.query<FaqRow[]>('SELECT * FROM curated_faqs WHERE enabled=1 ORDER BY sort_order,id')
    const ranked = rows
      .map(row => ({ row, score: similarity(normalized, row.normalized_question) }))
      .sort((a, b) => b.score - a.score)
    const threshold = Number(process.env.QABOT_FAQ_DIRECT_THRESHOLD ?? 0.86)
    const margin = Number(process.env.QABOT_FAQ_DIRECT_MARGIN ?? 0.12)
    const best = ranked[0],
      second = ranked[1]
    if (best === undefined || best.score < threshold || best.score - (second?.score ?? 0) < margin) return undefined
    return await this.faqPayload(best.row)
  }

  async recordFaqUse(faqId: number, sessionId: string, question: string): Promise<void> {
    await this.pool.execute(
      'INSERT INTO curated_faq_usage (faq_id,session_id,employee_question,matched_at) VALUES (?,?,?,?)',
      [faqId, sessionId, question, toMysqlDate(Date.now())],
    )
    await this.pool.execute('UPDATE curated_faqs SET usage_count=usage_count+1 WHERE id=?', [faqId])
  }

  async faqAsset(id: number): Promise<{ mime: string; body: Buffer } | undefined> {
    const [rows] = await this.pool.execute<Array<RowDataPacket & { mime_type: string; binary_data: Buffer }>>(
      'SELECT mime_type,binary_data FROM curated_faq_assets WHERE id=?',
      [id],
    )
    return rows[0] === undefined ? undefined : { mime: rows[0].mime_type, body: Buffer.from(rows[0].binary_data) }
  }

  async voc(range: OperationsRange, identity: PortalIdentity): Promise<Record<string, unknown>> {
    const overview = await this.overview(range)
    const data = JSON.stringify({ metrics: overview.metrics, causes: overview.causes })
    const hash = createHash('sha256').update(data).digest('hex')
    const group = range.group ?? '全部'
    const [cached] = await this.pool.execute<Array<RowDataPacket & { summary: string; generated_at: MysqlDateValue }>>(
      'SELECT summary,generated_at FROM operations_voc_cache WHERE service_group=? AND period_from=? AND period_to=? AND data_hash=?',
      [group, toMysqlDate(range.from), toMysqlDate(range.to), hash],
    )
    if (cached[0] !== undefined)
      return { summary: cached[0].summary, cached: true, generatedAt: fromMysqlDate(cached[0].generated_at) }
    const metrics = overview.metrics as Record<string, unknown>
    const causes = overview.causes as Record<string, unknown>
    const top = (causes.unanswered as Array<{ question: string }>)[0]?.question
    const modelSummary = await generateVocModelSummary(data)
    const summary =
      modelSummary ??
      `本周期共有 ${metrics.validConsultations ?? 0} 次有效咨询。员工主要声音集中在${top === undefined ? '日常制度与服务入口' : `“${top}”`}；建议优先补齐未命中知识，并跟进低评分评价中反复出现的问题。`
    await this.pool.execute(
      `INSERT INTO operations_voc_cache
      (service_group,period_from,period_to,data_hash,summary,generated_by,generated_at) VALUES (?,?,?,?,?,?,NOW(3))`,
      [group, toMysqlDate(range.from), toMysqlDate(range.to), hash, summary, identity.employeeId],
    )
    return { summary, cached: false, generatedAt: Date.now(), fallback: modelSummary === undefined }
  }

  async auditPage(page: number, pageSize: number, from?: number, to?: number): Promise<Record<string, unknown>> {
    const conditions: string[] = []
    const values: Array<Date> = []
    if (from !== undefined) {
      conditions.push('l.created_at>=?')
      values.push(toMysqlDate(from))
    }
    if (to !== undefined) {
      conditions.push('l.created_at<?')
      values.push(toMysqlDate(to))
    }
    const where = conditions.length === 0 ? '' : `WHERE ${conditions.join(' AND ')}`
    const [count] = await this.pool.execute<CountRow[]>(
      `SELECT COUNT(*) AS total FROM operation_audit_logs l ${where}`,
      values,
    )
    const offset = (page - 1) * pageSize
    const [rows] = await this.pool.execute<
      Array<
        RowDataPacket & {
          id: number
          actor_id: string
          actor_name: string
          action_code: string
          action_name: string
          content: string
          result: string
          resource_type: string | null
          resource_id: string | null
          source_title: string | null
          created_at: MysqlDateValue
        }
      >
    >(
      `SELECT l.id,l.actor_id,COALESCE(u.name,l.actor_name,l.actor_id) AS actor_name,l.action_code,l.action_name,l.content,l.result,
        l.resource_type,l.resource_id,ks.name AS source_title,l.created_at
       FROM operation_audit_logs l LEFT JOIN users u ON BINARY u.id=BINARY l.actor_id OR BINARY u.feishu_open_id=BINARY l.actor_id OR BINARY u.feishu_user_id=BINARY l.actor_id
       LEFT JOIN knowledge_sources ks ON l.resource_type IN ('knowledge-source','知识源') AND ks.id=CAST(l.resource_id AS UNSIGNED)
       ${where} ORDER BY l.created_at DESC,l.id DESC LIMIT ${pageSize} OFFSET ${offset}`,
      values,
    )
    return {
      page,
      pageSize,
      total: Number(count[0]?.total ?? 0),
      records: rows.map(row => ({
        id: row.id,
        time: fromMysqlDate(row.created_at),
        operation: AUDIT_ACTION_NAMES[row.action_code] ?? row.action_name,
        content: readableAuditContent(row),
        result: row.result,
        operator: row.actor_id === 'system-sync' ? '系统自动同步' : row.actor_name || row.actor_id,
      })),
    }
  }
}

function readableAuditContent(row: {
  content: string
  result: string
  resource_type: string | null
  resource_id: string | null
  source_title: string | null
}): string {
  const failure = row.result === '失败' ? row.content.match(/：(.+)$/)?.[1] : undefined
  const suffix = failure === undefined ? '' : ` · ${failure}`
  if (row.source_title !== null) return `知识源「${row.source_title}」${suffix}`
  const resource =
    row.resource_type === 'ticket' ? '工单' : row.resource_type === 'staff' ? '服务人员' : row.resource_type
  if (resource !== null && row.resource_id !== null) return `${resource} ${row.resource_id}${suffix}`
  return row.content
    .replace(/\{[^{}]{0,1000}\}/g, '操作详情')
    .replace(
      /\b(?:ticket|staff|knowledge-source)\b/g,
      match => ({ ticket: '工单', staff: '服务人员', 'knowledge-source': '知识源' })[match] ?? match,
    )
}

function validateFaq(input: CuratedFaqInput): void {
  if (!OPERATIONS_GROUPS.includes(input.group) || input.question.trim() === '' || input.answer.trim() === '')
    throw new Error('FAQ_INVALID')
  if (input.links.length > 5 || input.images.length > 3) throw new Error('FAQ_ATTACHMENT_LIMIT')
  for (const link of input.links) {
    if (link.title.trim() === '' || !/^https?:\/\//.test(link.url)) throw new Error('FAQ_LINK_INVALID')
  }
  for (const image of input.images) {
    if (image.id !== undefined) continue
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(image.mimeType) || image.base64 === undefined)
      throw new Error('FAQ_IMAGE_TYPE_INVALID')
    if (Buffer.byteLength(image.base64, 'base64') > 10 * 1024 * 1024) throw new Error('FAQ_IMAGE_TOO_LARGE')
  }
}
