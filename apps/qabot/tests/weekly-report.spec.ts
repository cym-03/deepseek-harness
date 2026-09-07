import { describe, expect, it } from 'vitest'
import { clusterQuestions } from '../src/report/weekly.ts'

describe('weekly report question themes', () => {
  it('groups approximate question types and records handoff-linked knowledge gaps', () => {
    const result = clusterQuestions([
      { text: '请问公司的考勤制度怎么样？', sessionId: 'session-1', handoff: false },
      { text: '迟到和早退是怎么规定的', sessionId: 'session-2', handoff: true },
      { text: '考勤异常如何处理', sessionId: 'session-2', handoff: false },
      { text: '打印机坏了', sessionId: 'session-3', handoff: false },
    ])

    expect(result[0]).toMatchObject({ count: 3, conversationCount: 2, handoffCount: 1 })
    expect(result.some(item => item.question === '打印机坏了')).toBe(false)
  })

  it('keeps a one-off handoff question visible as a knowledge gap', () => {
    expect(clusterQuestions([
      { text: '门禁卡坏了找谁处理', sessionId: 'session-4', handoff: true },
    ])).toEqual([{ question: '设备网络', count: 1, conversationCount: 1, handoffCount: 1 }])
  })
})
