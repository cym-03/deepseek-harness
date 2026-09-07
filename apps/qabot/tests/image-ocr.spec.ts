import { createHash } from 'node:crypto'
import sharp from 'sharp'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { collectVisualHints, storeImageHints, storeVisionAssets, type VisualHint } from '../src/kb/image-ocr.ts'
import type { KbStore } from '../src/kb/store.ts'

const originalEmbedBaseUrl = process.env.EMBED_BASE_URL
const originalEmbedApiKey = process.env.EMBED_API_KEY
const originalVisionOcrModel = process.env.VISION_OCR_MODEL
const originalVisionOcrMaxTokens = process.env.VISION_OCR_MAX_TOKENS

afterEach(() => {
  vi.unstubAllGlobals()
  if (originalEmbedBaseUrl === undefined) delete process.env.EMBED_BASE_URL
  else process.env.EMBED_BASE_URL = originalEmbedBaseUrl
  if (originalEmbedApiKey === undefined) delete process.env.EMBED_API_KEY
  else process.env.EMBED_API_KEY = originalEmbedApiKey
  if (originalVisionOcrModel === undefined) delete process.env.VISION_OCR_MODEL
  else process.env.VISION_OCR_MODEL = originalVisionOcrModel
  if (originalVisionOcrMaxTokens === undefined) delete process.env.VISION_OCR_MAX_TOKENS
  else process.env.VISION_OCR_MAX_TOKENS = originalVisionOcrMaxTokens
})

function kbStub(
  existingSources: ReadonlySet<string> = new Set(),
  states: ReadonlyMap<string, { contentHash: string; description: string }> = new Map(),
): {
  kb: KbStore
  spies: {
    upsertChunks: ReturnType<typeof vi.fn>
    upsertVisionAsset: ReturnType<typeof vi.fn>
    pruneVisionAssets: ReturnType<typeof vi.fn>
    pruneBoardTexts: ReturnType<typeof vi.fn>
    pruneVisualHints: ReturnType<typeof vi.fn>
  }
} {
  const spies = {
    upsertChunks: vi.fn(),
    upsertVisionAsset: vi.fn(),
    pruneVisionAssets: vi.fn(),
    pruneBoardTexts: vi.fn(),
    pruneVisualHints: vi.fn(),
  }
  const kb = {
    hasVisionAssetSource: vi.fn((source: string) => existingSources.has(source)),
    visionAssetState: vi.fn((source: string) => states.get(source)),
    ...spies,
  } as unknown as KbStore
  return { kb, spies }
}

const credentials = { appId: 'app-id', appSecret: 'app-secret' }
const hints: VisualHint[] = [
  { token: 'image-1', caption: '', section: '第一章', kind: 'image' },
  { token: 'image-2', caption: '', section: '第二章', kind: 'image' },
]

describe('Feishu vision asset download', () => {
  it('removes fallback chunks for visual blocks no longer present in the document', () => {
    const { kb, spies } = kbStub()

    expect(storeImageHints(kb, 'wiki:policy', [], '员工手册')).toBe(0)
    expect(spies.pruneVisualHints).toHaveBeenCalledWith('wiki:policy', new Set())
  })

  it('tells the model that matching board media is attached to the answer', () => {
    const { kb, spies } = kbStub()

    expect(storeImageHints(kb, 'wiki:policy', [
      { token: 'board-1', caption: '', section: '发展历程', kind: 'board' },
    ], '员工手册')).toBe(1)
    expect(spies.upsertChunks).toHaveBeenCalledWith(
      'wiki:policy:img:0',
      expect.arrayContaining([
        expect.stringContaining('请勿声称无法在对话中展示图片'),
      ]),
      '画板提示：发展历程',
    )
  })

  it('collects embedded boards with the nearest heading', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({
      code: 0,
      data: {
        items: [
          { block_type: 3, heading1: { elements: [{ text_run: { content: '晋升路径' } }] } },
          { block_type: 27, image: { token: 'image-1', caption: { content: '职级说明' } } },
          { block_type: 43, board: { token: 'board-1' } },
        ],
        has_more: false,
      },
    }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(collectVisualHints({ ...credentials, accessToken: 'user-token' }, 'document-1')).resolves.toEqual([
      { token: 'image-1', caption: '职级说明', section: '晋升路径', kind: 'image' },
      { token: 'board-1', caption: '', section: '晋升路径', kind: 'board' },
    ])
  })

  it('stops the document download after the first permission denial', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 0, tenant_access_token: 'token' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response('', { status: 403 }))
      .mockResolvedValueOnce(new Response('', { status: 403 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 0, data: { tmp_download_urls: [] } }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const { kb, spies } = kbStub()

    const result = await storeVisionAssets(kb, credentials, 'wiki:policy', hints, '员工手册')
    expect(result.stored).toBe(0)
    expect(result.failed).toBe(1)
    expect(result.firstFailure).toContain('status=403')
    expect(fetchMock).toHaveBeenCalledTimes(4)
    expect(spies.upsertVisionAsset).not.toHaveBeenCalled()
  })

  it('does not download a token whose image is already durable', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 0, tenant_access_token: 'token' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(Buffer.from('new-image'), {
        status: 200,
        headers: { 'content-type': 'image/png' },
      }))
    vi.stubGlobal('fetch', fetchMock)
    const { kb, spies } = kbStub(new Set(['wiki:policy:vision:image-1']))

    expect(await storeVisionAssets(kb, credentials, 'wiki:policy', hints, '员工手册')).toEqual({
      stored: 1, failed: 0, firstFailure: '',
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(spies.upsertVisionAsset).toHaveBeenCalledTimes(1)
  })

  it('redownloads an existing board and replaces it through the stable source', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 0, tenant_access_token: 'token' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(Buffer.from('updated-board'), {
        status: 200,
        headers: { 'content-type': 'image/png' },
      }))
    vi.stubGlobal('fetch', fetchMock)
    const source = 'wiki:policy:vision:board:board-1'
    const { kb, spies } = kbStub(new Set([source]))

    expect(await storeVisionAssets(kb, credentials, 'wiki:policy', [{
      token: 'board-1', caption: '', section: '晋升路径', kind: 'board',
    }], '员工手册')).toEqual({ stored: 1, failed: 0, firstFailure: '' })
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain('/board/v1/whiteboards/board-1/download_as_image')
    expect(spies.upsertVisionAsset).toHaveBeenCalledWith(expect.objectContaining({
      source,
      title: '画板：晋升路径',
      image: Buffer.from('updated-board'),
    }))
  })

  it('stores board OCR text in the searchable visual description', async () => {
    process.env.EMBED_BASE_URL = 'https://models.test/v1'
    process.env.EMBED_API_KEY = 'model-key'
    process.env.VISION_OCR_MODEL = 'vision-ocr-test'
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 0, tenant_access_token: 'token' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(Buffer.from('board-image'), {
        status: 200,
        headers: { 'content-type': 'image/png' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        choices: [{ message: { content: '专业序列：P1 → P2 → P3\n管理序列：M1 → M2' } }],
      }), { status: 200, headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)
    const { kb, spies } = kbStub()

    await expect(storeVisionAssets(kb, credentials, 'wiki:policy', [{
      token: 'board-1', caption: '', section: '员工发展九宫格', kind: 'board',
    }], '员工手册')).resolves.toEqual({ stored: 1, failed: 0, firstFailure: '' })
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body))).toMatchObject({ model: 'vision-ocr-test' })
    expect(spies.upsertVisionAsset).toHaveBeenCalledWith(expect.objectContaining({
      description: expect.stringContaining('画板识别文字：专业序列：P1 → P2 → P3'),
    }))
    expect(spies.upsertChunks).toHaveBeenCalledWith(
      'wiki:policy:board-text:board-1',
      expect.arrayContaining([expect.stringContaining('专业序列：P1 → P2 → P3')]),
      '员工发展九宫格（画板文字）',
      undefined,
    )
  })

  it('reuses stored OCR text when a board snapshot is unchanged', async () => {
    process.env.EMBED_BASE_URL = 'https://models.test/v1'
    process.env.EMBED_API_KEY = 'model-key'
    const source = 'wiki:policy:vision:board:board-1'
    const image = Buffer.from('same-board')
    const hash = createHash('sha256').update(image.toString('base64')).digest('hex')
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 0, tenant_access_token: 'token' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(image, { status: 200, headers: { 'content-type': 'image/png' } }))
    vi.stubGlobal('fetch', fetchMock)
    const { kb, spies } = kbStub(new Set([source]), new Map([[
      source,
      { contentHash: hash, description: '【画板】旧章节\n画板识别文字：职级 P1 到 P5' },
    ]]))

    await storeVisionAssets(kb, credentials, 'wiki:policy', [{
      token: 'board-1', caption: '', section: '新章节', kind: 'board',
    }], '员工手册')

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(spies.upsertVisionAsset).toHaveBeenCalledWith(expect.objectContaining({
      description: '【画板】新章节\n画板识别文字：职级 P1 到 P5',
    }))
    expect(spies.upsertChunks).toHaveBeenCalledWith(
      'wiki:policy:board-text:board-1',
      ['职级 P1 到 P5'],
      '新章节（画板文字）',
      undefined,
    )
  })

  it('refreshes an unchanged board when its stored OCR output was truncated', async () => {
    process.env.EMBED_BASE_URL = 'https://models.test/v1'
    process.env.EMBED_API_KEY = 'model-key'
    const source = 'wiki:policy:vision:board:board-1'
    const image = await sharp({
      create: { width: 100, height: 100, channels: 3, background: '#ffffff' },
    }).png().toBuffer()
    const hash = createHash('sha256').update(image.toString('base64')).digest('hex')
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 0, tenant_access_token: 'token' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(image, { status: 200, headers: { 'content-type': 'image/png' } }))
    for (const content of ['流程开始', '员工申请', '主管审批', '流程结束']) {
      fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
        choices: [{ finish_reason: 'stop', message: { content } }],
      }), { status: 200, headers: { 'content-type': 'application/json' } }))
    }
    vi.stubGlobal('fetch', fetchMock)
    const { kb, spies } = kbStub(new Set([source]), new Map([[
      source,
      { contentHash: hash, description: '【画板】章节\n画板识别文字：```json\n[{"text":"截断' },
    ]]))

    await storeVisionAssets(kb, credentials, 'wiki:policy', [{
      token: 'board-1', caption: '', section: '章节', kind: 'board',
    }], '员工手册')

    expect(fetchMock).toHaveBeenCalledTimes(6)
    expect(JSON.parse(String(fetchMock.mock.calls[5]?.[1]?.body))).toMatchObject({ max_tokens: 4096 })
    expect(spies.upsertVisionAsset).toHaveBeenCalledWith(expect.objectContaining({
      description: '【画板】章节\n画板识别文字：流程开始\n员工申请\n主管审批\n流程结束',
    }))
  })

  it('uses overlapping OCR tiles only when the full snapshot is truncated', async () => {
    process.env.EMBED_BASE_URL = 'https://models.test/v1'
    process.env.EMBED_API_KEY = 'model-key'
    process.env.VISION_OCR_MODEL = 'ocr-primary'
    const board = await sharp({
      create: { width: 100, height: 100, channels: 3, background: '#ffffff' },
    }).png().toBuffer()
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 0, tenant_access_token: 'token' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(board, {
        status: 200,
        headers: { 'content-type': 'image/png' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        choices: [{ finish_reason: 'length', message: { content: 'partial' } }],
      }), { status: 200, headers: { 'content-type': 'application/json' } }))
    for (const [index, content] of ['左上区域的完整文字内容', '右上区域的完整文字内容', '左下区域的完整文字内容', '右下区域的完整文字内容'].entries()) {
      fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
        choices: [{
          finish_reason: 'stop',
          message: { content: index === 0 ? [{ ocr_result: { words_info: [{ text: content }] } }] : content },
        }],
      }), { status: 200, headers: { 'content-type': 'application/json' } }))
    }
    vi.stubGlobal('fetch', fetchMock)
    const { kb, spies } = kbStub()

    await storeVisionAssets(kb, credentials, 'wiki:policy', [{
      token: 'board-1', caption: '', section: '密集流程', kind: 'board',
    }], '员工手册')

    expect(fetchMock).toHaveBeenCalledTimes(7)
    expect(JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body))).toMatchObject({ model: 'ocr-primary' })
    expect(JSON.parse(String(fetchMock.mock.calls[6]?.[1]?.body))).toMatchObject({ model: 'ocr-primary' })
    expect(spies.upsertVisionAsset).toHaveBeenCalledWith(expect.objectContaining({
      description: expect.stringContaining('画板识别文字：左上区域的完整文字内容'),
    }))
  })

  it('accepts an output envelope with object OCR content', async () => {
    process.env.EMBED_BASE_URL = 'https://models.test/v1'
    process.env.EMBED_API_KEY = 'model-key'
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 0, tenant_access_token: 'token' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(Buffer.from('board-image'), {
        status: 200,
        headers: { 'content-type': 'image/png' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        output: {
          choices: [{
            finish_reason: 'stop',
            message: { content: { ocr_result: { words_info: [{ text: '员工提交申请' }, { text: '主管审批' }] } } },
          }],
        },
      }), { status: 200, headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)
    const { kb, spies } = kbStub()

    await storeVisionAssets(kb, credentials, 'wiki:policy', [{
      token: 'board-1', caption: '', section: '入职流程', kind: 'board',
    }], '员工手册')

    expect(spies.upsertChunks).toHaveBeenCalledWith(
      'wiki:policy:board-text:board-1',
      ['员工提交申请\n主管审批'],
      '入职流程（画板文字）',
      undefined,
    )
  })

  it('keeps complete OCR fields from an incomplete smallest-tile structure', async () => {
    process.env.EMBED_BASE_URL = 'https://models.test/v1'
    process.env.EMBED_API_KEY = 'model-key'
    const source = 'wiki:policy:vision:board:board-1'
    const image = await sharp({
      create: { width: 100, height: 100, channels: 3, background: '#ffffff' },
    }).png().toBuffer()
    const hash = createHash('sha256').update(image.toString('base64')).digest('hex')
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 0, tenant_access_token: 'token' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(image, { status: 200, headers: { 'content-type': 'image/png' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        choices: [{ finish_reason: 'length', message: { content: 'partial outer tile' } }],
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        choices: [{ finish_reason: 'stop', message: { content: '```json\n[{"text":"2012年6月成立"},{"text":"未完成' } }],
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        choices: [{ finish_reason: 'stop', message: {} }],
      }), { status: 200 }))
    for (const content of ['研发起步', '品牌升级', '海外拓展', '产品创新', '未来规划']) {
      fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
        choices: [{ finish_reason: 'stop', message: { content } }],
      }), { status: 200 }))
    }
    vi.stubGlobal('fetch', fetchMock)
    const { kb, spies } = kbStub(new Set([source]), new Map([[
      source,
      { contentHash: hash, description: '【画板】发展历程\n画板识别文字：2012年\n2013年\n2014年\n2015年\n2016年\n2017年\n2018年\n2019年' },
    ]]))

    await storeVisionAssets(kb, credentials, 'wiki:policy', [{
      token: 'board-1', caption: '', section: '发展历程', kind: 'board',
    }], '员工手册')

    expect(fetchMock).toHaveBeenCalledTimes(10)
    expect(spies.upsertChunks).toHaveBeenCalledWith(
      'wiki:policy:board-text:board-1',
      [expect.stringContaining('2012年6月成立')],
      '发展历程（画板文字）',
      undefined,
    )
  })

  it('stops repeated board exports after Feishu reports missing user scope', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 0, tenant_access_token: 'token' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 99991679, msg: 'missing board scope' }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      }))
    vi.stubGlobal('fetch', fetchMock)
    const { kb, spies } = kbStub()
    const boards: VisualHint[] = [
      { token: 'board-1', caption: '', section: '第一章', kind: 'board' },
      { token: 'board-2', caption: '', section: '第二章', kind: 'board' },
    ]

    const result = await storeVisionAssets(kb, credentials, 'wiki:policy', boards, '员工手册')
    expect(result.failed).toBe(1)
    expect(result.firstFailure).toContain('99991679')
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(spies.upsertVisionAsset).not.toHaveBeenCalled()
  })

  it('uses a temporary URL when direct media download returns 403', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 0, tenant_access_token: 'token' }), { status: 200 }))
      .mockResolvedValueOnce(new Response('', { status: 403 }))
      .mockResolvedValueOnce(new Response('', { status: 403 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 0, data: { tmp_download_urls: [{ file_token: 'image-1', tmp_download_url: 'https://tmp.example/image' }] } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(Buffer.from('temporary-image'), { status: 200, headers: { 'content-type': 'image/jpeg' } }))
    vi.stubGlobal('fetch', fetchMock)
    const { kb, spies } = kbStub()

    expect(await storeVisionAssets(kb, credentials, 'wiki:policy', [hints[0]!], '员工手册', undefined, 'document-1')).toEqual({
      stored: 1, failed: 0, firstFailure: '',
    })
    expect(fetchMock).toHaveBeenCalledTimes(5)
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain('extra=%7B%22doc_id%22%3A%22document-1%22%2C%22doc_type%22%3A%22docx%22%7D')
    expect(String(fetchMock.mock.calls[2]?.[0])).toContain('preview_type=16')
    expect(spies.upsertVisionAsset).toHaveBeenCalledWith(expect.objectContaining({ mime: 'image/jpeg', image: Buffer.from('temporary-image') }))
  })

  it('falls back to the media preview endpoint before requesting a temporary URL', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 0, tenant_access_token: 'token' }), { status: 200 }))
      .mockResolvedValueOnce(new Response('', { status: 403 }))
      .mockResolvedValueOnce(new Response(Buffer.from('preview-image'), { status: 200, headers: { 'content-type': 'image/png' } }))
    vi.stubGlobal('fetch', fetchMock)
    const { kb, spies } = kbStub()

    expect(await storeVisionAssets(kb, credentials, 'wiki:policy', [hints[0]!], '员工手册', undefined, 'document-1')).toEqual({
      stored: 1, failed: 0, firstFailure: '',
    })
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(String(fetchMock.mock.calls[2]?.[0])).toContain('/preview_download')
    expect(String(fetchMock.mock.calls[2]?.[0])).toContain('preview_type=16')
    expect(spies.upsertVisionAsset).toHaveBeenCalledWith(expect.objectContaining({ image: Buffer.from('preview-image') }))
  })
})
