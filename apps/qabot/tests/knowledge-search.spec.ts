import { afterEach, describe, expect, it } from 'vitest'
import {
  mergeMentionedVisionMatches,
  removeSupersededBoardHints,
  selectVisionMatches,
  visionTitleMatchesContext,
} from '../src/kb/search.ts'

const originalThresholds = {
  strong: process.env.VISION_MEDIA_STRONG_SCORE,
  cluster: process.env.VISION_MEDIA_CLUSTER_SCORE,
  margin: process.env.VISION_MEDIA_CLUSTER_MARGIN,
}

afterEach(() => {
  if (originalThresholds.strong === undefined) delete process.env.VISION_MEDIA_STRONG_SCORE
  else process.env.VISION_MEDIA_STRONG_SCORE = originalThresholds.strong
  if (originalThresholds.cluster === undefined) delete process.env.VISION_MEDIA_CLUSTER_SCORE
  else process.env.VISION_MEDIA_CLUSTER_SCORE = originalThresholds.cluster
  if (originalThresholds.margin === undefined) delete process.env.VISION_MEDIA_CLUSTER_MARGIN
  else process.env.VISION_MEDIA_CLUSTER_MARGIN = originalThresholds.margin
})

describe('visual result confidence', () => {
  it('rejects a lone weak image even when it exceeds the former threshold', () => {
    expect(selectVisionMatches([
      { item: 'employee-development-grid', score: 0.3577 },
      { item: 'unrelated-training', score: 0.2112 },
    ], 3)).toEqual([])
  })

  it('rejects the observed proof-question false positive', () => {
    expect(selectVisionMatches([
      { item: 'offboarding-board', score: 0.3898 },
      { item: 'resignation-board', score: 0.3649 },
    ], 3)).toEqual([])
  })

  it('keeps a strong match without appending weaker images', () => {
    expect(selectVisionMatches([
      { item: 'promotion-grid', score: 0.4627 },
      { item: 'unrelated-training', score: 0.271 },
    ], 3)).toEqual(['promotion-grid'])
  })

  it('keeps a corroborating cluster for a visually documented topic', () => {
    expect(selectVisionMatches([
      { item: '2019-history', score: 0.4252 },
      { item: '2018-history', score: 0.4222 },
      { item: 'generic-employee-grid', score: 0.3159, corroborates: false },
      { item: 'office', score: 0.2964 },
    ], 3)).toEqual(['2019-history', '2018-history'])
  })
})

describe('visual title grounding', () => {
  it('rejects a workflow board related only through generic process terms', () => {
    expect(visionTitleMatchesContext(
      '画板：（三）入职流程',
      '【画板】（三）入职流程\n填写职位信息\n人力资源部负责人审批',
      '证明申请入口在哪里？',
      '证明申请入口：飞书 → 工作台 → 审批 → 证明开具。',
    )).toBe(false)
  })

  it('keeps a related visual from another document', () => {
    expect(visionTitleMatchesContext(
      '画板：财务报销流程',
      '【画板】财务报销流程\n画板识别文字：提交财务报销申请并完成审批',
      '报销费用需要经过哪些步骤？',
      '请先提交财务报销申请。',
    )).toBe(true)
  })

  it('rejects an onboarding board for an offboarding question', () => {
    expect(visionTitleMatchesContext(
      '画板：（三）入职流程',
      '【画板】（三）入职流程\n填写入职资料\n办理工牌',
      '员工离职流程是什么？',
      '离职前需要提交离职申请并完成工作交接。',
    )).toBe(false)
  })

  it('keeps an offboarding board for an offboarding question', () => {
    expect(visionTitleMatchesContext(
      '画板：离职流程',
      '【画板】离职流程\n画板识别文字：提交离职申请\n完成工作交接',
      '员工离职流程是什么？',
      '离职前需要提交离职申请并完成工作交接。',
    )).toBe(true)
  })

  it('rejects a contract-renewal board for an explicit offboarding question', () => {
    expect(visionTitleMatchesContext(
      '画板：（二）劳动合同的续订',
      '【画板】（二）劳动合同的续订\n劳动合同续订审批',
      '员工离职流程是什么？',
      '合同期内离职需要提前申请并完成离职交接。',
    )).toBe(false)
  })

  it('rejects a board whose OCR content does not support its matching title', () => {
    expect(visionTitleMatchesContext(
      '画板：报销审批流程',
      '【画板】报销审批流程\n画板识别文字：新员工填写入职资料并领取工牌',
      '报销审批需要经过哪些步骤？',
      '请提交报销申请。',
    )).toBe(false)
  })

  it('does not let an answer introduce a board topic absent from the question', () => {
    expect(visionTitleMatchesContext(
      '画板：（三）入职流程',
      '【画板】（三）入职流程\n画板识别文字：新员工填写入职资料并领取工牌',
      '请展示报销审批流程图。',
      '入职体检费用可以在转正后申请报销。',
    )).toBe(false)
  })

  it('rejects a board without usable OCR text', () => {
    expect(visionTitleMatchesContext(
      '画板：报销审批流程',
      '【画板】报销审批流程',
      '报销审批需要经过哪些步骤？',
      '请提交报销申请。',
    )).toBe(false)
  })

  it('rejects an unlabeled document image even when its generic title is cited', () => {
    expect(visionTitleMatchesContext(
      '图片：员工手册',
      '【文档图片】员工手册',
      '公司的发展历程是什么？',
      '参考文档：员工手册',
    )).toBe(false)
  })
})

describe('answer-supported visual results', () => {
  const candidates = [
    { item: { id: 1, title: '图片：2025年全员合照' }, title: '图片：2025年全员合照', description: '【文档图片】员工手册\n图片说明：2025年全员合照' },
    { item: { id: 2, title: '图片：工厂独立生产流水线' }, title: '图片：工厂独立生产流水线', description: '【文档图片】员工手册\n图片说明：工厂独立生产流水线' },
    { item: { id: 3, title: '画板：发展历程' }, title: '画板：发展历程', description: '【画板】发展历程' },
    { item: { id: 4, title: '图片：员工手册' }, title: '图片：员工手册', description: '【文档图片】员工手册' },
    { item: { id: 5, title: '画板：二、🚀发展历程' }, title: '画板：二、🚀发展历程', description: '【画板】二、🚀发展历程' },
  ]

  it('prepends explicitly named images without admitting generic source labels', () => {
    expect(mergeMentionedVisionMatches(
      [candidates[2]!.item],
      candidates,
      '相关素材包括2025年全员合照和工厂独立生产流水线，来源为员工手册。',
      3,
    )).toEqual([candidates[0]!.item, candidates[1]!.item, candidates[2]!.item])
  })

  it('deduplicates an answer mention already selected by vector retrieval', () => {
    expect(mergeMentionedVisionMatches(
      [candidates[2]!.item],
      candidates,
      '可查看发展历程画板。',
      3,
    )).toEqual([candidates[2]!.item])
  })

  it('attaches a numbered board when the answer names its topic without the number', () => {
    expect(mergeMentionedVisionMatches(
      [],
      [candidates[4]!],
      '根据「🚀发展历程」章节，公司于 2012 年成立。',
      3,
    )).toEqual([candidates[4]!.item])
  })
})

describe('board OCR text retrieval', () => {
  it('removes a placeholder when the same board has usable OCR text', () => {
    const rows = [
      { title: '员工手册', content: '二、发展历程' },
      { title: '画板提示：二、发展历程', content: '【画板提示】画板内容未解析为文字' },
      { title: '画板：二、发展历程', content: '画板识别文字：2012年公司成立' },
      { title: '图片提示：全员合照', content: '图片说明：2025年全员合照' },
    ]

    expect(removeSupersededBoardHints(rows)).toEqual([rows[2], rows[0], rows[3]])
  })
})
