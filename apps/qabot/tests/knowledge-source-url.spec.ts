import { describe, expect, it } from 'vitest'
import { parseFeishuUrl } from '../src/http/server.ts'

describe('Feishu knowledge source URLs', () => {
  it('accepts a direct spreadsheet and keeps its selected worksheet', () => {
    expect(parseFeishuUrl('https://example.feishu.cn/sheets/shtcnToken123?sheet=abc123')).toEqual({
      kind: 'sheet',
      token: 'shtcnToken123',
      sheetId: 'abc123',
    })
  })

  it('rejects unsupported Feishu URLs', () => {
    expect(parseFeishuUrl('https://example.feishu.cn/drive/folder/fldcnToken123')).toBeNull()
  })
})
