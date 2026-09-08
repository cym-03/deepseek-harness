import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

interface EvaluationCase {
  id: string
  domain: string
  scenario: 'normal_answer' | 'manual_required' | 'knowledge_missing' | 'safe_refusal' | 'out_of_scope'
  question: string
  expectedTerms: string[]
  expectedImageTopics: string[]
}

const evaluationPath = fileURLToPath(new URL('../evals/employee-service-desk.json', import.meta.url))

function loadEvaluationCases(): EvaluationCase[] {
  return JSON.parse(readFileSync(evaluationPath, 'utf8')) as EvaluationCase[]
}

describe('employee service desk evaluation baseline', () => {
  it('covers every launch-critical question category with stable ids', () => {
    const cases = loadEvaluationCases()
    const domains = new Set(cases.map(item => item.domain))
    expect(domains).toEqual(new Set([
      '人事', '财务', 'IT', '行政', '考勤', '视觉内容', '知识缺失', '业务范围外', '安全拒答',
    ]))
    expect(new Set(cases.map(item => item.id)).size).toBe(cases.length)
  })

  it('separates answer, handoff, refusal, missing-knowledge, and out-of-scope scenarios', () => {
    const scenarios = new Set(loadEvaluationCases().map(item => item.scenario))
    expect(scenarios).toEqual(new Set([
      'normal_answer', 'manual_required', 'knowledge_missing', 'safe_refusal', 'out_of_scope',
    ]))
  })

  it('covers each business domain with multiple questions', () => {
    const cases = loadEvaluationCases()
    for (const domain of ['人事', '财务', 'IT', '行政', '考勤', '视觉内容']) {
      expect(cases.filter(item => item.domain === domain).length).toBeGreaterThanOrEqual(3)
    }
  })

  it('requires explicit expected text and visual topics', () => {
    for (const item of loadEvaluationCases()) {
      expect(item.id).toMatch(/^[a-z0-9-]+$/)
      expect(item.question.trim().length).toBeGreaterThan(0)
      expect(Array.isArray(item.expectedTerms)).toBe(true)
      expect(Array.isArray(item.expectedImageTopics)).toBe(true)
    }
  })
})
