/** 飞书文档视觉素材处理，包括普通图片和嵌入画板。 */

import { createHash } from 'node:crypto'
import sharp from 'sharp'
import type { KbStore } from './store.ts'
import { chunkText } from './feishu-sync.ts'
import { feishuContentToken, type FeishuContentCredentials } from './feishu-auth.ts'
import { prepareVisionImageForEmbedding } from './vision-embed.ts'

const API_BASE = 'https://open.feishu.cn/open-apis'
const BOARD_TEXT_MARKER = '画板识别文字：'

export interface ImageText {
  caption: string
  text: string
}

export interface VisualHint {
  token: string
  caption: string
  section: string
  kind: 'image' | 'board'
}

/** Try the direct stream, Feishu's preview stream, then its temporary URL for 403 variants. */
async function downloadMedia(auth: Record<string, string>, token: string, documentId?: string): Promise<Response> {
  const extra = documentId === undefined ? undefined : JSON.stringify({ doc_id: documentId, doc_type: 'docx' })
  const directUrl = new URL(`${API_BASE}/drive/v1/medias/${token}/download`)
  if (extra !== undefined) directUrl.searchParams.set('extra', extra)
  const direct = await fetch(directUrl, { headers: auth })
  if (direct.status !== 403) return direct
  const previewUrl = new URL(`${API_BASE}/drive/v1/medias/${token}/preview_download`)
  previewUrl.searchParams.set('preview_type', '16')
  const preview = await fetch(previewUrl, { headers: auth })
  if (preview.ok) return preview
  const temporaryUrl = new URL(`${API_BASE}/drive/v1/medias/batch_get_tmp_download_url`)
  temporaryUrl.searchParams.set('file_tokens', token)
  if (extra !== undefined) temporaryUrl.searchParams.set('extra', extra)
  const temporary = await fetch(temporaryUrl, { headers: auth })
  const temporaryText = await temporary.text()
  if (!temporary.ok) return new Response(temporaryText, { status: temporary.status, headers: temporary.headers })
  const body = JSON.parse(temporaryText) as { data?: { tmp_download_urls?: Array<string | { tmp_download_url?: string }> } }
  const entry = body.data?.tmp_download_urls?.[0]
  const url = typeof entry === 'string' ? entry : entry?.tmp_download_url
  if (url === undefined) return new Response(temporaryText, { status: 403, headers: temporary.headers })
  const resolved = await fetch(url)
  return resolved.ok ? resolved : direct
}

/** Downloads one board snapshot with the same submitter identity used to read the parent document. */
async function downloadBoard(auth: Record<string, string>, token: string): Promise<Response> {
  return fetch(`${API_BASE}/board/v1/whiteboards/${encodeURIComponent(token)}/download_as_image`, { headers: auth })
}

function visualSource(sourceBase: string, hint: VisualHint): string {
  return hint.kind === 'board'
    ? `${sourceBase}:vision:board:${hint.token}`
    : `${sourceBase}:vision:${hint.token}`
}

function ocrConfigured(): boolean {
  return (process.env.EMBED_BASE_URL ?? '').trim() !== ''
    && (process.env.EMBED_API_KEY ?? '').trim() !== ''
}

/** Extracts searchable text from one visual snapshot through the configured OpenAI-compatible endpoint. */
async function ocrImage(image: Buffer, mime: string, forceTiled = false): Promise<string> {
  const base = (process.env.EMBED_BASE_URL ?? '').replace(/\/+$/, '')
  const key = process.env.EMBED_API_KEY ?? ''
  if (base === '' || key === '') throw new Error('缺少 EMBED_BASE_URL/EMBED_API_KEY')
  const prepared = await prepareVisionImageForEmbedding(image, mime)
  const maxTokens = Number(process.env.VISION_OCR_MAX_TOKENS ?? 4096)
  if (!Number.isInteger(maxTokens) || maxTokens <= 0) throw new Error('VISION_OCR_MAX_TOKENS 必须是正整数')
  const request = async (
    model: string,
    input: { data: Buffer; mime: string } = prepared,
    acceptPartialStructure = false,
  ): Promise<string | undefined> => {
    const res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model,
        messages: [{
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: `data:${input.mime};base64,${input.data.toString('base64')}` } },
            { type: 'text', text: '提取画板中所有可见文字，保留标题、层级、节点关系、表格、日期和数字。只输出识别结果；无法辨认的内容不要猜测。' },
          ],
        }],
        max_tokens: maxTokens,
      }),
    })
    const body = await res.json() as {
      choices?: Array<{ finish_reason?: string; message?: { content?: unknown } }>
      output?: { choices?: Array<{ finish_reason?: string; message?: { content?: unknown } }> }
      error?: { message?: string }
    }
    const choice = body.choices?.[0] ?? body.output?.choices?.[0]
    const content = ocrResponseText(choice?.message?.content)
    if (!res.ok) {
      throw new Error(`${model} OCR 失败: ${body.error?.message ?? res.status}`)
    }
    if (choice?.finish_reason === 'length') return undefined
    if (content === undefined) {
      if (choice?.finish_reason === 'stop') return ''
      throw new Error(`${model} OCR 失败: ${body.error?.message ?? res.status}`)
    }
    return normalizeOcrText(content, acceptPartialStructure)
  }
  const primaryModel = process.env.VISION_OCR_MODEL?.trim() || 'qwen-vl-ocr'
  if (!forceTiled) {
    const primary = await request(primaryModel)
    if (primary !== undefined) return primary
  }
  const split = async (data: Buffer): Promise<Buffer[]> => {
    const metadata = await sharp(data, { failOn: 'none' }).metadata()
    if (metadata.width === undefined || metadata.height === undefined) throw new Error('无法读取画板图片尺寸')
    const tileWidth = Math.min(metadata.width, Math.ceil(metadata.width * 0.55))
    const tileHeight = Math.min(metadata.height, Math.ceil(metadata.height * 0.55))
    const positions = [
      { left: 0, top: 0 },
      { left: metadata.width - tileWidth, top: 0 },
      { left: 0, top: metadata.height - tileHeight },
      { left: metadata.width - tileWidth, top: metadata.height - tileHeight },
    ]
    return Promise.all(positions.map(position => sharp(data, { failOn: 'none' })
      .extract({ ...position, width: tileWidth, height: tileHeight })
      .png()
      .toBuffer()))
  }
  const recognizeRegion = async (data: Buffer, canSplit: boolean): Promise<string[]> => {
    const text = await request(primaryModel, { data, mime: 'image/png' }, !canSplit)
    if (text !== undefined) return text.split('\n').map(line => line.trim()).filter(line => line !== '')
    if (!canSplit) throw new Error(`分区 OCR 输出超过 ${maxTokens} tokens`)
    const nested: string[] = []
    for (const tile of await split(data)) nested.push(...await recognizeRegion(tile, false))
    return nested
  }
  const lines: string[] = []
  for (const tile of await split(prepared.data)) lines.push(...await recognizeRegion(tile, true))
  return [...new Set(lines)].join('\n')
}

function contentHash(image: Buffer): string {
  return createHash('sha256').update(image.toString('base64')).digest('hex')
}

function normalizeOcrText(value: string, acceptPartialStructure = false): string | undefined {
  const trimmed = value.trim()
  if (!/^```json\s*/i.test(trimmed)) return trimmed
  const complete = trimmed.endsWith('```')
  if (!complete && !acceptPartialStructure) return undefined
  const jsonText = trimmed.replace(/^```json\s*/i, '').replace(/```$/, '').trim()
  try {
    const parsed = JSON.parse(jsonText) as unknown
    const lines: string[] = []
    const visit = (entry: unknown): void => {
      if (Array.isArray(entry)) {
        for (const item of entry) visit(item)
        return
      }
      if (typeof entry !== 'object' || entry === null) return
      for (const [key, item] of Object.entries(entry)) {
        if ((key === 'text' || key === 'label') && typeof item === 'string' && item.trim() !== '') {
          lines.push(item.trim())
        } else {
          visit(item)
        }
      }
    }
    visit(parsed)
    return lines.length === 0 ? undefined : lines.join('\n')
  } catch {
    if (!acceptPartialStructure) return undefined
    const lines: string[] = []
    const fields = /"(?:text|label)"\s*:\s*("(?:\\.|[^"\\])*")/g
    for (const match of jsonText.matchAll(fields)) {
      const literal = match[1]
      if (literal === undefined) continue
      try {
        const text = JSON.parse(literal) as string
        if (text.trim() !== '') lines.push(text.trim())
      } catch {
        // Ignore only the final incomplete JSON string; complete fields remain usable.
      }
    }
    return lines.length === 0 ? undefined : lines.join('\n')
  }
}

function ocrResponseText(content: unknown): string | undefined {
  if (typeof content === 'string') return content
  const lines: string[] = []
  const visit = (entry: unknown): void => {
    if (Array.isArray(entry)) {
      for (const item of entry) visit(item)
      return
    }
    if (typeof entry !== 'object' || entry === null) return
    for (const [key, value] of Object.entries(entry)) {
      if ((key === 'text' || key === 'label') && typeof value === 'string' && value.trim() !== '') {
        lines.push(value.trim())
      } else {
        visit(value)
      }
    }
  }
  visit(content)
  return lines.length === 0 ? undefined : lines.join('\n')
}

function needsTiledOcr(text: string): boolean {
  const lines = text.split('\n').map(line => line.trim()).filter(line => line !== '')
  const headingOnly = lines.length === 1 && lines[0] !== undefined
    && lines[0].length <= 12 && /流程|说明|标题/.test(lines[0])
  const yearLabelsOnly = lines.length >= 8 && lines.every(line => /^\d{4}年$/.test(line))
  return headingOnly || yearLabelsOnly
}

function storedBoardText(description: string): string | undefined {
  const marker = `\n${BOARD_TEXT_MARKER}`
  const position = description.indexOf(marker)
  if (position < 0) return undefined
  const text = normalizeOcrText(description.slice(position + marker.length))
  return text === undefined || needsTiledOcr(text) ? undefined : text
}

/** Collects downloadable images and boards with their nearest document heading. */
export async function collectVisualHints(
  credentials: FeishuContentCredentials,
  documentId: string,
): Promise<VisualHint[]> {
  const token = await feishuContentToken(credentials)
  const auth = { authorization: `Bearer ${token}` }
  const hints: VisualHint[] = []
  let currentSection = ''
  let pageToken: string | undefined
  do {
    const url = new URL(`${API_BASE}/docx/v1/documents/${documentId}/blocks`)
    url.searchParams.set('page_size', '500')
    if (pageToken !== undefined) url.searchParams.set('page_token', pageToken)
    const res = await fetch(url, { headers: auth })
    const body = await res.json() as {
      code?: number
      data?: {
        items?: Array<{
          block_type?: number
          image?: { token?: string; caption?: { content?: string } }
          board?: { token?: string }
          [key: string]: unknown
        }>
        has_more?: boolean
        page_token?: string
      }
    }
    if (body.code !== 0) break
    for (const block of body.data?.items ?? []) {
      const bt = block.block_type ?? 0
      if (bt >= 3 && bt <= 11) {
        const heading = block[`heading${bt - 2}`] as { elements?: Array<{ text_run?: { content?: string } }> } | undefined
        const text = heading?.elements?.map(el => el.text_run?.content ?? '').join('') ?? ''
        if (text.trim() !== '') currentSection = text.trim()
      } else if (block.image?.token !== undefined) {
        hints.push({
          token: block.image.token,
          caption: block.image.caption?.content ?? '',
          section: currentSection,
          kind: 'image',
        })
      } else if (block.board?.token !== undefined) {
        hints.push({ token: block.board.token, caption: '', section: currentSection, kind: 'board' })
      }
    }
    pageToken = body.data?.has_more ? body.data.page_token : undefined
  } while (pageToken !== undefined && pageToken !== '')
  return hints
}

/** Downloads visual assets and replaces changed bytes without removing the last usable copy on failure. */
export async function storeVisionAssets(
  kb: KbStore,
  credentials: FeishuContentCredentials,
  sourceBase: string,
  hints: VisualHint[],
  docTitle: string,
  url?: string,
  documentId?: string,
): Promise<{ stored: number; failed: number; firstFailure: string }> {
  const token = await feishuContentToken(credentials)
  const auth = { authorization: `Bearer ${token}` }
  const activeSources = new Set(hints.map(hint => visualSource(sourceBase, hint)))
  const activeBoardTextSources = new Set(
    hints.filter(hint => hint.kind === 'board').map(hint => `${sourceBase}:board-text:${hint.token}`),
  )
  const deniedKinds = new Set<VisualHint['kind']>()
  let stored = 0
  let failed = 0
  let firstFailure = ''
  let firstFailureKind: VisualHint['kind'] | undefined
  let firstFailureWasPermissionDenied = false
  for (const hint of hints) {
    const source = visualSource(sourceBase, hint)
    if (hint.kind === 'image' && kb.hasVisionAssetSource(source)) continue
    if (deniedKinds.has(hint.kind)) continue
    const response = hint.kind === 'board'
      ? await downloadBoard(auth, hint.token)
      : await downloadMedia(auth, hint.token, documentId)
    if (!response.ok) {
      failed += 1
      const detail = (await response.text()).replaceAll(/\s+/g, ' ').slice(0, 300)
      const permissionDenied = response.status === 403
        || (response.status === 400 && detail.includes('99991679'))
      if (firstFailure === '') {
        const requestId = response.headers.get('x-tt-logid') ?? response.headers.get('x-request-id')
        firstFailure = `status=${response.status}${requestId === null ? '' : ` request_id=${requestId}`}${detail === '' ? '' : ` detail=${detail}`}`
        firstFailureKind = hint.kind
        firstFailureWasPermissionDenied = permissionDenied
      }
      if (permissionDenied) deniedKinds.add(hint.kind)
      continue
    }
    const mime = response.headers.get('content-type')?.split(';')[0] || 'image/png'
    const image = Buffer.from(await response.arrayBuffer())
    const label = hint.kind === 'board' ? '画板' : '文档图片'
    let description = `【${label}】${hint.section || docTitle}`
      + (hint.caption === '' ? '' : `\n图片说明：${hint.caption}`)
    if (hint.kind === 'board' && ocrConfigured()) {
      const current = kb.visionAssetState(source)
      const sameSnapshot = current?.contentHash === contentHash(image)
      let boardText = sameSnapshot
        ? storedBoardText(current.description)
        : undefined
      if (boardText === undefined) {
        try {
          boardText = await ocrImage(image, mime, sameSnapshot && current !== undefined)
        } catch (error) {
          failed += 1
          if (firstFailure === '') {
            firstFailure = `画板文字识别失败：${error instanceof Error ? error.message : String(error)}`
            firstFailureKind = 'board'
          }
          continue
        }
      }
      description += `\n${BOARD_TEXT_MARKER}${boardText === '' ? '未识别到可用文字' : boardText}`
      kb.upsertChunks(
        `${sourceBase}:board-text:${hint.token}`,
        chunkText(boardText === '' ? '未识别到可用文字' : boardText),
        `${hint.section || docTitle}（画板文字）`,
        url,
      )
    }
    kb.upsertVisionAsset({
      source,
      title: `${hint.kind === 'board' ? '画板' : '图片'}：${hint.caption || hint.section || docTitle}`,
      description,
      ...(url === undefined ? {} : { url }),
      mime,
      image,
    })
    stored += 1
  }
  if (failed > 0) {
    const permissionHint = firstFailureWasPermissionDenied
      ? firstFailureKind === 'board'
        ? '；请确认应用已开通 board:whiteboard:node:read，且知识源提交人仍可访问该画板'
        : '；请确认应用已开通 docs:document.media:download，且知识源提交人仍可访问该文档'
      : ''
    console.warn(`[kb-vision] ${docTitle} 视觉素材下载失败 ${failed}/${hints.length}；${firstFailure}${permissionHint}`)
  }
  kb.pruneVisionAssets(sourceBase, activeSources)
  if (ocrConfigured()) kb.pruneBoardTexts(sourceBase, activeBoardTextSources)
  return { stored, failed, firstFailure }
}

/** Writes a text fallback for each visual asset so its source remains explainable without visual retrieval. */
export function storeImageHints(kb: KbStore, sourceBase: string, hints: VisualHint[], docTitle: string): number {
  let total = 0
  const activeSources = new Set<string>()
  for (const [i, hint] of hints.entries()) {
    const label = hint.kind === 'board' ? '画板' : '图片'
    const text = `【${label}提示】本部分（${hint.section || docTitle}）包含${hint.kind === 'board' ? '一个画板' : '一张图片'}。`
      + (hint.caption !== '' ? `图片说明：${hint.caption}。` : '')
      + `${label}内容未解析为文字，但系统会把匹配的视觉素材作为图片卡片附在回答后。`
      + '请勿声称无法在对话中展示图片；可以说明图片内的细节未转成文字，并在需要精确辨认时建议用户查看原文。'
    const title = `${label}提示：${hint.caption || hint.section || docTitle}`
    const chunks = chunkText(text)
    const source = `${sourceBase}:img:${i}`
    activeSources.add(source)
    kb.upsertChunks(source, chunks, title)
    total += chunks.length
  }
  kb.pruneVisualHints(sourceBase, activeSources)
  return total
}

/** 解析一个 docx 文档的所有图片并 OCR，返回 [{caption, text}]。 */
export async function ocrDocxImages(
  credentials: FeishuContentCredentials,
  documentId: string,
): Promise<ImageText[]> {
  const token = await feishuContentToken(credentials)
  const auth = { authorization: `Bearer ${token}` }

  // 1. 拉取所有块，找出图片块（block_type 27）。
  const images: Array<{ token: string; caption: string }> = []
  let pageToken: string | undefined
  do {
    const url = new URL(`${API_BASE}/docx/v1/documents/${documentId}/blocks`)
    url.searchParams.set('page_size', '500')
    if (pageToken !== undefined) url.searchParams.set('page_token', pageToken)
    const res = await fetch(url, { headers: auth })
    const body = await res.json() as {
      code?: number
      msg?: string
      data?: {
        items?: Array<{
          block_type?: number
          image?: { token?: string; caption?: { content?: string } }
        }>
        has_more?: boolean
        page_token?: string
      }
    }
    if (body.code !== 0) throw new Error(`blocks 失败 code=${body.code} msg=${body.msg}`)
    for (const block of body.data?.items ?? []) {
      if (block.block_type === 27 && block.image?.token !== undefined) {
        images.push({ token: block.image.token, caption: block.image.caption?.content ?? '' })
      }
    }
    pageToken = body.data?.has_more ? body.data.page_token : undefined
  } while (pageToken !== undefined && pageToken !== '')

  if (images.length === 0) return []

  // 2. 逐张下载 + OCR。
  const results: ImageText[] = []
  for (const img of images) {
    try {
      const dl = await fetch(`${API_BASE}/drive/v1/medias/${img.token}/download`, { headers: auth })
      if (!dl.ok) {
        console.warn(`[kb-ocr] 图片下载失败 ${img.token.slice(0, 8)}… status=${dl.status}`)
        continue
      }
      const buf = Buffer.from(await dl.arrayBuffer())
      const mime = 'image/png' // 飞书图片块默认 PNG；按需可探测
      const text = await ocrImage(buf, mime)
      if (text.trim() !== '') {
        results.push({ caption: img.caption, text })
        console.log(`[kb-ocr] 图片「${img.caption || img.token.slice(0, 8)}」OCR 完成，${text.length} 字`)
      }
    } catch (error) {
      console.error('[kb-ocr] 图片 OCR 失败:', error instanceof Error ? error.message : error)
    }
  }
  return results
}

/** 把 OCR 文本写入知识库（source 前缀 image:）。 */
export function storeOcrChunks(kb: KbStore, sourceBase: string, images: ImageText[]): number {
  let total = 0
  for (const img of images) {
    const title = `图片：${img.caption || '未命名'}`
    const chunks = chunkText(img.text)
    kb.upsertChunks(`${sourceBase}:image`, chunks, title)
    total += chunks.length
  }
  return total
}
