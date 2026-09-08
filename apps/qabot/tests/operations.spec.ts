import { afterEach, describe, expect, it, vi } from 'vitest'
import { cachedHandoffReasons, clusterSimilarIssues, generateVocModelSummary, isEffectiveQuestion, MysqlOperationsRepository, normalizeFaqQuestion, summarizeHandoffReasons } from '../src/report/operations.ts'

afterEach(() => vi.unstubAllEnvs())

describe('operations analytics question rules', () => {
  it('excludes greetings, tests, and pure handoff requests from effective consultations', () => {
    expect(isEffectiveQuestion('你好')).toBe(false)
    expect(isEffectiveQuestion('请回答：测试成功')).toBe(false)
    expect(isEffectiveQuestion('转人工')).toBe(false)
    expect(isEffectiveQuestion('证明申请入口在哪里？')).toBe(true)
  })

  it('normalizes equivalent curated questions for zero-model direct answers', () => {
    expect(normalizeFaqQuestion(' 证明申请入口，在哪里？ ')).toBe('证明申请入口在哪里')
    expect(normalizeFaqQuestion('证明申请入口在哪里')).toBe('证明申请入口在哪里')
  })

  it('clusters wording variants before ranking frequent issues', () => {
    expect(clusterSimilarIssues([
      { text: '证明申请入口在哪里', count: 3 },
      { text: '请问证明申请入口在哪里？', count: 2, ticketIds: [8, 9] },
      { text: '值班表怎么查看', count: 2 },
    ], 10)).toEqual([
      { theme: '证明申请入口在哪里', count: 5, samples: ['证明申请入口在哪里', '请问证明申请入口在哪里？'], ticketIds: [8, 9] },
      { theme: '值班表怎么查看', count: 2, samples: ['值班表怎么查看'] },
    ])
  })

  it('recomputes domain using handoff, FAQ, then strongest knowledge priority', async () => {
    const execute = vi.fn().mockResolvedValue([[], []])
    const repository = new MysqlOperationsRepository({ execute } as never)
    await repository.recordTurn({ sessionId: 'session-1', ticketId: 7, question: '证明申请入口在哪里？', answer: '回答', group: '人事', knowledgeHit: true, sourceId: 9, relevance: 0.9 })
    const refreshSql = String(execute.mock.calls[1]?.[0])
    expect(refreshSql.indexOf("h.event_type='selected'")).toBeLessThan(refreshSql.indexOf('q.faq_id IS NOT NULL'))
    expect(refreshSql.indexOf('q.faq_id IS NOT NULL')).toBeLessThan(refreshSql.indexOf('q.knowledge_source_id IS NOT NULL'))
    expect(execute.mock.calls[1]?.[1]).toEqual(['session-1', 'session-1', 'session-1', 7])
  })

  it('keeps one rating per ticket and measures active service time instead of idle conversation time', async () => {
    const metric = { total: 0, completed: 0, self_service: 0, handed_off: 0, rated: 0, avg_rating: null,
      avg_resolution_ms: null, avg_ai_ms: null, avg_human_ms: null, estimated: 0 }
    const execute = vi.fn(async (sql: string) => {
      if (sql.includes('COUNT(*) AS total') && sql.includes('FROM tickets t WHERE')) return [[metric], []]
      if (sql.includes('FROM tickets t JOIN (')) return [[], []]
      if (sql.includes('FROM qa_handoff_events')) return [[], []]
      if (sql.includes('FROM qa_turn_analytics')) return [[], []]
      if (sql.includes('FROM tickets t')) return [[], []]
      return [[], []]
    })
    const repository = new MysqlOperationsRepository({ execute } as never)
    await repository.overview({ from: 1, to: 2 })
    const sql = execute.mock.calls.map(call => String(call[0])).join('\n')
    expect(sql).toContain('t.service_end<t.service_start')
    expect(sql).toContain('TIMESTAMPDIFF(MICROSECOND,t.service_start,t.service_end)/1000')
    expect(sql).not.toContain('TIMESTAMPDIFF(MICROSECOND,t.created_at,t.resolved_at)/1000')
    expect(sql).toContain('AVG(t.satisfaction) AS avg_rating')
    expect(sql).toContain('t.satisfaction IS NOT NULL AND t.updated_at>=? AND t.updated_at<?')
    expect(sql).toContain("h.event_type='suggested' AND h.trigger_question=qa_turn_analytics.question")
    expect(sql).toContain("t.satisfaction BETWEEN 1 AND 2 AND NULLIF(TRIM(t.satisfaction_comment),'') IS NOT NULL")
  })

  it('generates an evidence-bound VOC summary and falls back when the model is unavailable', async () => {
    vi.stubEnv('DEEPSEEK_API_KEY', 'test-key')
    vi.stubEnv('DEEPSEEK_BASE_URL', 'https://model.test')
    vi.stubEnv('QABOT_VOC_MODEL', 'voc-model')
    const request = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ choices: [{ message: { content: '  员工主要关注证明入口。  ' } }] }) })
    expect(await generateVocModelSummary('{"validConsultations":3}', request as never)).toBe('员工主要关注证明入口。')
    expect(request).toHaveBeenCalledWith('https://model.test/chat/completions', expect.objectContaining({ method: 'POST' }))
    const body = JSON.parse(String(request.mock.calls[0]?.[1]?.body))
    expect(body).toMatchObject({ model: 'voc-model', temperature: 0.2 })
    expect(body.messages[0].content).toContain('不得虚构')
    expect(await generateVocModelSummary('{}', vi.fn().mockRejectedValue(new Error('offline')) as never)).toBeUndefined()
  })

  it('summarizes handoff evidence with the model and reuses the unchanged result', async () => {
    vi.stubEnv('DEEPSEEK_API_KEY', 'test-key')
    vi.stubEnv('DEEPSEEK_BASE_URL', 'https://model.test')
    const input = [{ reason: '历史转人工', group: '行政', count: 2, quotes: ['转人工'],
      conversations: ['session-21 | 员工：大门锁放哪里', 'session-21 | 智能助手：暂时无法确认', 'session-21 | 员工：转人工'], ticketIds: [21] }]
    const request = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ choices: [{ message: { content: '["门禁物品信息需人工确认"]' } }] }) })
    expect(await summarizeHandoffReasons(input, request as never)).toEqual([{ ...input[0], reason: '门禁物品信息需人工确认' }])
    expect(await summarizeHandoffReasons(input, request as never)).toEqual([{ ...input[0], reason: '门禁物品信息需人工确认' }])
    expect(request).toHaveBeenCalledTimes(1)
    const body = JSON.parse(String(request.mock.calls[0]?.[1]?.body))
    expect(body.messages[0].content).toContain('不要把“要求转人工”这个动作本身当作原因')
    expect(body.messages[1].content).toContain('大门锁放哪里')
  })

  it('returns handoff fallback titles without waiting for a missing model summary', () => {
    vi.stubEnv('DEEPSEEK_API_KEY', '')
    const input = [{ reason: '历史转人工', group: '人事', count: 1, quotes: ['转人工'], conversations: ['员工：请帮我查询年假', '员工：转人工'], ticketIds: [99] }]
    expect(cachedHandoffReasons(input)).toEqual([{ ...input[0], reason: '员工主动要求人工协助' }])
  })
})
