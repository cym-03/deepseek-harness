import { describe, expect, it } from 'vitest'
import { answerRecommendsHumanHandoff } from '../src/handoff-policy.ts'

describe('assistant handoff recommendation fallback', () => {
  it.each([
    '知识库暂时没有可靠答案，推荐人工处理。',
    '这个问题建议联系人工协助。',
    '邮箱密码重置需要由 IT 人工处理。',
  ])('recognizes an explicit recommendation: %s', (answer) => {
    expect(answerRecommendsHumanHandoff(answer)).toBe(true)
  })

  it.each([
    '人工服务时间为 9:00–18:00。',
    '该流程由人事部门审批。',
    '如有其他问题，我可以继续为你解答。',
  ])('does not infer a recommendation from a mere mention: %s', (answer) => {
    expect(answerRecommendsHumanHandoff(answer)).toBe(false)
  })
})
