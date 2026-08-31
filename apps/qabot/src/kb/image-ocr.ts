/**
 * 文档图片处理：
 * 1. 图片提示（默认，零权限）：从 docx 块结构提取图片说明(caption)与所在章节，
 *    生成「图片提示块」进知识库，让 agent 能提示用户查看原文。
 * 2. 图片 OCR（可选，需 drive:drive:readonly 权限下载图片）：
 *    下载图片 + qwen-vl 提取文字，完整内容进知识库。
 */

import type { KbStore } from './store.ts'
import { chunkText } from './feishu-sync.ts'

const API_BASE = 'https://open.feishu.cn/open-apis'

export interface ImageText {
  caption: string
  text: string
}

export interface ImageHint {
  token: string
  caption: string
  section: string
}

async function tenantToken(appId: string, appSecret: string): Promise<string> {
  const res = await fetch(`${API_BASE}/auth/v3/tenant_access_token/internal`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
  })
  const body = await res.json() as { code?: number; tenant_access_token?: string; msg?: string }
  if (body.code !== 0 || body.tenant_access_token === undefined) {
    throw new Error(`tenant token 失败 code=${body.code} msg=${body.msg}`)
  }
  return body.tenant_access_token
}

/** 用 qwen-vl 提取图片文字。 */
async function ocrImage(base64Data: string, mime: string): Promise<string> {
  const base = (process.env.EMBED_BASE_URL ?? '').replace(/\/+$/, '')
  const key = process.env.EMBED_API_KEY ?? ''
  if (base === '' || key === '') throw new Error('缺少 EMBED_BASE_URL/EMBED_API_KEY')
  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: 'qwen-vl-plus',
      messages: [{
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: `data:${mime};base64,${base64Data}` } },
          { type: 'text', text: '请把这张图片里的所有文字完整、逐字提取出来，包括表格、标题、数字。不要额外解释，不要编造。' },
        ],
      }],
      max_tokens: 1500,
    }),
  })
  const body = await res.json() as { choices?: Array<{ message?: { content?: string } }>; error?: { message?: string } }
  if (body.choices?.[0]?.message?.content === undefined) {
    throw new Error(`qwen-vl OCR 失败: ${body.error?.message ?? res.status}`)
  }
  return body.choices[0].message.content
}

/** 从块结构提取图片说明 + 所在章节（不下载图片，零权限）。 */
export async function collectImageCaptions(
  credentials: { appId: string; appSecret: string },
  documentId: string,
): Promise<ImageHint[]> {
  const token = await tenantToken(credentials.appId, credentials.appSecret)
  const auth = { authorization: `Bearer ${token}` }
  const hints: ImageHint[] = []
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
        // 标题块（heading1-9）
        const heading = block[`heading${bt}`] as { elements?: Array<{ text_run?: { content?: string } }> } | undefined
        const text = heading?.elements?.map(el => el.text_run?.content ?? '').join('') ?? ''
        if (text.trim() !== '') currentSection = text.trim()
      } else if (bt === 27) {
        const imageToken = block.image?.token
        if (imageToken !== undefined) {
          hints.push({ token: imageToken, caption: block.image?.caption?.content ?? '', section: currentSection })
        }
      }
    }
    pageToken = body.data?.has_more ? body.data.page_token : undefined
  } while (pageToken !== undefined && pageToken !== '')
  return hints
}

/** 下载图片并写入独立视觉索引源；下载失败不会删除现有视觉资产。 */
export async function storeVisionAssets(
  kb: KbStore,
  credentials: { appId: string; appSecret: string },
  sourceBase: string,
  hints: ImageHint[],
  docTitle: string,
  url?: string,
): Promise<number> {
  const token = await tenantToken(credentials.appId, credentials.appSecret)
  const auth = { authorization: `Bearer ${token}` }
  const activeSources = new Set(hints.map(hint => `${sourceBase}:vision:${hint.token}`))
  let stored = 0
  let failed = 0
  let firstFailure = ''
  for (const hint of hints) {
    const source = `${sourceBase}:vision:${hint.token}`
    if (kb.hasVisionAssetSource(source)) continue
    const response = await fetch(`${API_BASE}/drive/v1/medias/${hint.token}/download`, { headers: auth })
    if (!response.ok) {
      failed += 1
      if (firstFailure === '') {
        const detail = (await response.text()).replaceAll(/\s+/g, ' ').slice(0, 300)
        firstFailure = `status=${response.status}${detail === '' ? '' : ` detail=${detail}`}`
      }
      // A 403 applies to the app/document permission, not one image. Stop this run to avoid
      // repeating the same denied request for every image in every scheduled synchronization.
      if (response.status === 403) break
      continue
    }
    const mime = response.headers.get('content-type')?.split(';')[0] || 'image/png'
    const image = Buffer.from(await response.arrayBuffer())
    const description = `【文档图片】${hint.section || docTitle}`
      + (hint.caption === '' ? '' : `\n图片说明：${hint.caption}`)
    kb.upsertVisionAsset({
      source,
      title: `图片：${hint.caption || hint.section || docTitle}`,
      description,
      ...(url === undefined ? {} : { url }),
      mime,
      image,
    })
    stored += 1
  }
  if (failed > 0) {
    const permissionHint = firstFailure.startsWith('status=403')
      ? '；请为飞书应用开通“下载云文档素材”权限，发布应用版本，并将文档或知识库共享给该应用'
      : ''
    console.warn(`[kb-vision] ${docTitle} 图片下载失败 ${failed}/${hints.length}；${firstFailure}${permissionHint}`)
  }
  kb.pruneVisionAssets(sourceBase, activeSources)
  return stored
}

/** 把图片提示写入知识库（source 唯一，避免相互覆盖）。 */
export function storeImageHints(kb: KbStore, sourceBase: string, hints: ImageHint[], docTitle: string): number {
  let total = 0
  for (const [i, hint] of hints.entries()) {
    const text = `【图片提示】本部分（${hint.section || docTitle}）包含一张图片。`
      + (hint.caption !== '' ? `图片说明：${hint.caption}。` : '')
      + '图片内容未解析为文字。如果用户询问的是这张图片里的信息，请如实告知该内容以图片形式存在于文档中，给出参考文档链接，并建议用户打开原文查看，必要时可转人工。'
    const title = `图片提示：${hint.caption || hint.section || docTitle}`
    const chunks = chunkText(text)
    kb.upsertChunks(`${sourceBase}:img:${i}`, chunks, title)
    total += chunks.length
  }
  return total
}

/** 解析一个 docx 文档的所有图片并 OCR，返回 [{caption, text}]。 */
export async function ocrDocxImages(
  credentials: { appId: string; appSecret: string },
  documentId: string,
): Promise<ImageText[]> {
  const token = await tenantToken(credentials.appId, credentials.appSecret)
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
      const text = await ocrImage(buf.toString('base64'), mime)
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
