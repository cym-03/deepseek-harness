import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { KbStore } from '../src/kb/store.ts'
import { fetchSpreadsheetTexts, formatSpreadsheetRows, syncFeishuSources } from '../src/kb/feishu-sync.ts'

const tempDirs: string[] = []

function tempDb(): string {
  const directory = mkdtempSync(join(tmpdir(), 'qabot-feishu-sheet-'))
  tempDirs.push(directory)
  return join(directory, 'kb.db')
}

afterEach(() => {
  vi.unstubAllGlobals()
  for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('Feishu spreadsheet synchronization', () => {
  it('formats the first populated row as headers and preserves later row meaning', () => {
    expect(formatSpreadsheetRows('常见问答', [
      [],
      ['类型', '问题', '答案'],
      ['在职证明', '怎么申请', '在门户提交'],
    ])).toEqual([
      '工作表：常见问答\n表头：类型、问题、答案',
      '工作表：常见问答\n类型：在职证明\n问题：怎么申请\n答案：在门户提交',
    ])
  })

  it('queries visible worksheets and reads their cells with the supplied user token', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        code: 0,
        data: { sheets: [
          { sheet_id: 'sheet-a', title: '常见问答', grid_properties: { row_count: 2, column_count: 2 } },
          { sheet_id: 'hidden', title: '隐藏', hidden: true, grid_properties: { row_count: 1, column_count: 1 } },
        ] },
      })))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        code: 0,
        data: { valueRange: { values: [['问题', '答案'], ['怎么申请', '在门户提交']] } },
      })))
    vi.stubGlobal('fetch', fetchMock)

    await expect(fetchSpreadsheetTexts('user-token', 'spreadsheet-token')).resolves.toEqual([
      '工作表：常见问答\n表头：问题、答案',
      '工作表：常见问答\n问题：怎么申请\n答案：在门户提交',
    ])
    expect(fetchMock).toHaveBeenNthCalledWith(1,
      'https://open.feishu.cn/open-apis/sheets/v3/spreadsheets/spreadsheet-token/sheets/query',
      { headers: { authorization: 'Bearer user-token' } },
    )
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('publishes a directly submitted spreadsheet as searchable knowledge', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        code: 0,
        data: { sheets: [{ sheet_id: 'sheet-a', title: '证明申请', grid_properties: { row_count: 2, column_count: 2 } }] },
      })))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        code: 0,
        data: { valueRange: { values: [['类型', '入口'], ['在职证明', '工作台审批']] } },
      }))))
    const kb = new KbStore(tempDb())

    const result = await syncFeishuSources({} as never, kb, {
      docx: [],
      sheets: [{ spreadsheetToken: 'spreadsheet-token', title: '证明入口', url: 'https://example.feishu.cn/sheets/spreadsheet-token' }],
      bitable: [],
      wiki: [],
    }, { appId: 'app-id', appSecret: 'app-secret', accessToken: 'user-token', autoPublish: true })

    expect(result).toMatchObject({ failed: 0, synced: 2 })
    await expect(kb.search('在职证明入口', 5)).resolves.toContain('工作台审批')
    kb.dispose()
  })
})
