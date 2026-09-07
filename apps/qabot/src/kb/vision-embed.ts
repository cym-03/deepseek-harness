/** DashScope 多模态向量调用，用于员工文本查询与知识库图片的跨模态检索。 */

import sharp from 'sharp'

const DEFAULT_VISION_MODEL = 'qwen3-vl-embedding'
const DEFAULT_VISION_BASE_URL = 'https://dashscope.aliyuncs.com/api/v1'
const MULTIMODAL_PATH = '/services/embeddings/multimodal-embedding/multimodal-embedding'
const MAX_VISION_REQUEST_IMAGE_BYTES = 7 * 1024 * 1024

function apiKey(): string {
  return process.env.VISION_EMBED_API_KEY ?? process.env.EMBED_API_KEY ?? ''
}

/** 配置视觉向量模型后才启用图片下载、向量化和文搜图。 */
export function visionEmbeddingsConfigured(): boolean {
  const model = process.env.VISION_EMBED_MODEL
  return model !== undefined && model.trim() !== '' && apiKey() !== ''
}

/** 当前视觉向量模型及维度组成的稳定标识。 */
export function visionModelKey(): string {
  const model = process.env.VISION_EMBED_MODEL?.trim() || DEFAULT_VISION_MODEL
  const dimension = process.env.VISION_EMBED_DIMENSION?.trim() || '1024'
  return `${model}:${dimension}`
}

async function embed(content: { text: string } | { image: string }): Promise<number[]> {
  if (!visionEmbeddingsConfigured()) throw new Error('缺少 VISION_EMBED_MODEL 或视觉向量 API Key')
  const model = process.env.VISION_EMBED_MODEL?.trim() || DEFAULT_VISION_MODEL
  const dimension = Number(process.env.VISION_EMBED_DIMENSION ?? 1024)
  if (!Number.isInteger(dimension) || dimension <= 0) {
    throw new Error('VISION_EMBED_DIMENSION 必须是正整数')
  }
  const base = (process.env.VISION_EMBED_BASE_URL ?? DEFAULT_VISION_BASE_URL).replace(/\/+$/, '')
  const res = await fetch(`${base}${MULTIMODAL_PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey()}` },
    body: JSON.stringify({
      model,
      input: { contents: [content] },
      parameters: { dimension },
    }),
  })
  const body = await res.json() as {
    output?: { embeddings?: Array<{ embedding?: number[] }> }
    message?: string
    code?: string
  }
  const vector = body.output?.embeddings?.[0]?.embedding
  if (!res.ok || vector === undefined) {
    throw new Error(`视觉向量失败: ${body.message ?? body.code ?? res.status}（${res.status}）`)
  }
  return vector
}

/** 为员工的文本查询生成视觉模型空间中的向量。 */
export async function embedVisionText(text: string): Promise<number[]> {
  return embed({ text })
}

/** Normalizes SVG boards and shrinks oversized assets for the provider request. */
export async function prepareVisionImageForEmbedding(data: Buffer, mime: string): Promise<{ data: Buffer; mime: string }> {
  const normalized = mime.toLowerCase() === 'image/svg+xml'
    ? { data: await sharp(data, { failOn: 'none' }).png().toBuffer(), mime: 'image/png' }
    : { data, mime }
  if (normalized.data.byteLength <= MAX_VISION_REQUEST_IMAGE_BYTES) return normalized
  for (const [size, quality] of [[4096, 82], [3072, 74], [2048, 66], [1536, 58]] as const) {
    const converted = await sharp(normalized.data, { failOn: 'none' })
      .rotate()
      .resize({ width: size, height: size, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality, mozjpeg: true })
      .toBuffer()
    if (converted.byteLength <= MAX_VISION_REQUEST_IMAGE_BYTES) return { data: converted, mime: 'image/jpeg' }
  }
  throw new Error('图片压缩后仍超过视觉向量服务的大小限制')
}

/** 为知识库图片生成视觉模型空间中的向量。 */
export async function embedVisionImage(data: Buffer, mime: string): Promise<number[]> {
  const prepared = await prepareVisionImageForEmbedding(data, mime)
  return embed({ image: `data:${prepared.mime};base64,${prepared.data.toString('base64')}` })
}
