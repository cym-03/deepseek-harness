import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

interface EvaluationCase {
  id: string
  category: string
  question: string
  expectedTerms: string[]
  shouldHandoff: boolean
  expectsImage: boolean
}

const evaluationPath = fileURLToPath(new URL('../evals/employee-service-desk.json', import.meta.url))

function loadEvaluationCases(): EvaluationCase[] {
  return JSON.parse(readFileSync(evaluationPath, 'utf8')) as EvaluationCase[]
}

describe('employee service desk evaluation baseline', () => {
  it('covers every launch-critical question category with stable ids', () => {
    const cases = loadEvaluationCases()
    const categories = new Set(cases.map(item => item.category))
    expect(categories).toEqual(new Set([
      'HR', '财务', 'IT', '行政', '考勤', '无答案', '敏感问题', '图片内容', '过期制度', '部门权限',
    ]))
    expect(new Set(cases.map(item => item.id)).size).toBe(cases.length)
  })

  it('requires explicit expected disposition and visual behavior', () => {
    for (const item of loadEvaluationCases()) {
      expect(item.id).toMatch(/^[a-z0-9-]+$/)
      expect(item.question.trim().length).toBeGreaterThan(0)
      expect(typeof item.shouldHandoff).toBe('boolean')
      expect(typeof item.expectsImage).toBe('boolean')
      expect(Array.isArray(item.expectedTerms)).toBe(true)
    }
  })
})
