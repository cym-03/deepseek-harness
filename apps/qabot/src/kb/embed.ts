/**
 * 向量 embedding：
 * - 首选：远程语义 embedding（对接中继网关 /embeddings，OpenAI 兼容）。
 *   配置 EMBED_MODEL（模型名，中继需先加好），可覆盖 EMBED_BASE_URL / EMBED_API_KEY。
 * - 兜底：纯本地字符 bigram+trigram TF-IDF 稀疏向量（零依赖），语义模型不可用时自动降级。
 */

let idf: Map<string, number> | null = null
let remoteState: 'idle' | 'ready' | 'failed' = 'idle'

function charNgrams(text: string, n: number): string[] {
  const out: string[] = []
  for (let i = 0; i <= text.length - n; i++) out.push(text.slice(i, i + n))
  return out
}

/** 文本的字符 bigram+trigram 特征（兜底向量与外部聚类用）。 */
export function termsOf(text: string): string[] {
  return [...charNgrams(text, 2), ...charNgrams(text, 3)]
}

/** 远程语义 embedding 是否已配置（设置了 EMBED_MODEL）。 */
function remoteConfigured(): boolean {
  const model = process.env.EMBED_MODEL
  return model !== undefined && model.trim() !== ''
}

/**
 * 当前 embedding 模型标识：远程语义用 EMBED_MODEL 名，兜底字符向量用固定标识。
 * 用于判断已存向量是否失效——模型名变了（如 v3 → v4）就必须全量重算，内容 hash 变了就单条重算。
 */
export function embedModelKey(): string {
  const model = process.env.EMBED_MODEL
  return model !== undefined && model.trim() !== '' ? model.trim() : 'char-ngram-v1'
}

/** 扫描全库构建字符 n-gram IDF（兜底向量用）。远程模式可跳过。 */
export function buildIndex(docs: readonly { content: string }[]): void {
  const df = new Map<string, number>()
  for (const doc of docs) {
    const seen = new Set(termsOf(doc.content))
    for (const term of seen) df.set(term, (df.get(term) ?? 0) + 1)
  }
  const n = Math.max(docs.length, 1)
  const next = new Map<string, number>()
  for (const [term, count] of df) next.set(term, Math.log((n + 1) / (count + 1)) + 1)
  idf = next
}

/** 远程 /embeddings 调用。单条文本截断到安全长度，错误带上服务端信息。 */
async function remoteEmbed(texts: string[]): Promise<number[][]> {
  const base = (process.env.EMBED_BASE_URL ?? process.env.DEEPSEEK_BASE_URL ?? '').replace(/\/+$/, '')
  const key = process.env.EMBED_API_KEY ?? process.env.DEEPSEEK_API_KEY ?? ''
  const model = process.env.EMBED_MODEL ?? ''
  if (base === '' || key === '' || model === '') throw new Error('EMBED_MODEL 已设置但缺少 base/key')
  const input = texts.map(t => t.slice(0, 2000)) // 单条超长截断
  const res = await fetch(`${base}/embeddings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({ model, input }),
  })
  const body = await res.json() as { data?: Array<{ embedding: number[] }>; error?: { message?: string }; message?: string }
  if (!res.ok || body.data === undefined) {
    throw new Error(`embeddings 失败: ${body.error?.message ?? body.message ?? res.status}（${res.status}）`)
  }
  return body.data.map(d => d.embedding)
}

/** 语义模型是否可用（远程配置则探测；否则看字符索引）。 */
export async function embeddingsReady(): Promise<boolean> {
  if (remoteConfigured()) {
    if (remoteState === 'ready') return true
    if (remoteState === 'failed') return false
    try {
      await remoteEmbed(['测试'])
      remoteState = 'ready'
      console.log(`[kb] 远程语义 embedding 就绪：${process.env.EMBED_MODEL}`)
      return true
    } catch (error) {
      remoteState = 'failed'
      console.error('[kb] 远程 embedding 不可用，降级字符向量:', error instanceof Error ? error.message : error)
      return idf !== null
    }
  }
  return idf !== null
}

/** 文本向量：远程语义模式返回稠密 number[]，兜底模式返回稀疏 {term: weight}。 */
export type EmbedVector = number[] | Record<string, number>

/** 是否为稠密数组（否则为稀疏对象）。 */
export function isDenseVector(v: unknown): v is number[] {
  return Array.isArray(v)
}

/** 文本 → 向量。远程语义优先，字符 n-gram 稀疏 TF-IDF 兜底。 */
export async function embedTexts(texts: string[]): Promise<EmbedVector[]> {
  if (remoteConfigured()) {
    return remoteEmbed(texts)
  }
  if (idf === null) return texts.map(() => ({}))
  const index = idf
  return texts.map((text) => {
    const tf = new Map<string, number>()
    for (const term of termsOf(text)) tf.set(term, (tf.get(term) ?? 0) + 1)
    const vec: Record<string, number> = {}
    for (const [term, count] of tf) {
      const weight = index.get(term)
      if (weight !== undefined) vec[term] = count * weight
    }
    return vec
  })
}

/** 任意向量（稠密或稀疏）的余弦相似度。 */
export function anyCosine(a: EmbedVector, b: EmbedVector): number {
  if (isDenseVector(a) && isDenseVector(b)) return denseCosine(a, b)
  if (!isDenseVector(a) && !isDenseVector(b)) return cosine(a, b)
  return 0 // 混合格式不参与（重建索引时统一）
}

/** 稠密向量余弦相似度。 */
export function denseCosine(a: number[], b: number[]): number {
  let dot = 0
  let na = 0
  let nb = 0
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) {
    const x = a[i] ?? 0
    const y = b[i] ?? 0
    dot += x * y
    na += x * x
    nb += y * y
  }
  if (na === 0 || nb === 0) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

/** 稀疏向量余弦（report 聚类用，键 → 权重）。 */
export function cosine(a: Record<string, number>, b: Record<string, number>): number {
  let dot = 0
  let normA = 0
  let normB = 0
  for (const [term, wa] of Object.entries(a)) {
    normA += wa * wa
    const wb = b[term]
    if (wb !== undefined) dot += wa * wb
  }
  for (const wb of Object.values(b)) normB += wb * wb
  if (normA === 0 || normB === 0) return 0
  return dot / (Math.sqrt(normA) * Math.sqrt(normB))
}
