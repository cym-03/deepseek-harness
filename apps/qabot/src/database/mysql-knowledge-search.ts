/** Reads published knowledge chunks and vectors directly from MySQL. */
import type { Pool, RowDataPacket } from 'mysql2/promise'
import { createHash } from 'node:crypto'
import { anyCosine, embedModelKey, embedTexts, embeddingsReady, type EmbedVector } from '../kb/embed.ts'
import { embedVisionText, visionEmbeddingsConfigured, visionModelKey } from '../kb/vision-embed.ts'
import { toMysqlDate } from './mysql-time.ts'
import type { KnowledgeMediaSearch, KnowledgeSearch, KnowledgeVisionStatus } from '../kb/search.ts'
import type { KbMediaRef } from '../kb/store.ts'

interface KnowledgeHitRow extends RowDataPacket {
  id: number
  title: string
  source: string
  url: string | null
  content: string
  vector_json: unknown
}

interface VisionHitRow extends RowDataPacket {
  id: number
  title: string
  url: string | null
  vector_json: unknown
}

interface CountRow extends RowDataPacket {
  total: number
}

function parsedVector(value: unknown): EmbedVector | undefined {
  const parsed = typeof value === 'string' ? JSON.parse(value) as unknown : value
  if (Array.isArray(parsed) && parsed.every(item => typeof item === 'number' && Number.isFinite(item))) {
    return parsed as number[]
  }
  if (typeof parsed === 'object' && parsed !== null
    && Object.values(parsed).every(item => typeof item === 'number' && Number.isFinite(item))) {
    return parsed as Record<string, number>
  }
  return undefined
}

function terms(query: string): string[] {
  const split = query.split(/[\s,，。、！!？?;；:：()（）]+/).filter(term => term.length >= 2)
  return split.length > 0 ? split : [query]
}

function keywordScore(row: KnowledgeHitRow, queryTerms: readonly string[]): number {
  const text = `${row.title}\n${row.content}`
  return queryTerms.reduce((score, term) => score + (text.includes(term) ? term.length : 0), 0)
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`
}

/** MySQL-authoritative hybrid retrieval over currently effective published versions. */
export class MysqlKnowledgeSearch implements KnowledgeSearch, KnowledgeMediaSearch {
  constructor(private readonly pool: Pool) {}

  async search(query: string, limit = 5): Promise<string> {
    const normalized = query.trim()
    if (normalized === '') return '（空查询）'
    const rows = await this.activeChunks()
    const queryTerms = terms(normalized)
    const keywordHits = rows.map(row => ({ row, score: keywordScore(row, queryTerms) }))
      .filter(hit => hit.score > 0)
      .sort((left, right) => right.score - left.score)
    const vectorHits: Array<{ row: KnowledgeHitRow; score: number }> = []
    if (rows.some(row => row.vector_json !== null) && await embeddingsReady()) {
      const queryVector = await this.queryVector(normalized)
      if (queryVector !== undefined) {
        for (const row of rows) {
          const vector = parsedVector(row.vector_json)
          if (vector === undefined) continue
          const score = anyCosine(queryVector, vector)
          if (score > 0.25) vectorHits.push({ row, score })
        }
        vectorHits.sort((left, right) => right.score - left.score)
      }
    }
    const selected: KnowledgeHitRow[] = []
    const seen = new Set<number>()
    for (const hit of [...vectorHits, ...keywordHits]) {
      if (selected.length >= limit) break
      if (seen.has(hit.row.id)) continue
      seen.add(hit.row.id)
      selected.push(hit.row)
    }
    if (selected.length === 0) return `未在知识库中找到与「${normalized}」相关的内容。`
    return selected.map((row, index) => {
      const link = row.url === null || row.url === '' ? '' : `\n链接：${row.url}`
      return `【${index + 1}】${row.title}${link}\n${truncate(row.content, 2000)}`
    }).join('\n\n')
  }

  private async queryVector(query: string): Promise<EmbedVector | undefined> {
    const queryHash = createHash('sha256').update(query).digest('hex')
    const model = embedModelKey()
    const [rows] = await this.pool.execute<Array<RowDataPacket & { vector_json: unknown }>>(`
      SELECT vector_json FROM knowledge_query_embeddings WHERE query_hash = ? AND model_key = ?
    `, [queryHash, model])
    const cached = parsedVector(rows[0]?.vector_json)
    if (cached !== undefined) {
      await this.pool.execute(`
        UPDATE knowledge_query_embeddings SET last_used_at = ? WHERE query_hash = ? AND model_key = ?
      `, [toMysqlDate(Date.now()), queryHash, model])
      return cached
    }
    const [computed] = await embedTexts([query])
    if (computed === undefined) return undefined
    const now = Date.now()
    await this.pool.execute(`
      INSERT INTO knowledge_query_embeddings (
        query_hash, model_key, vector_json, created_at, last_used_at
      ) VALUES (?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE vector_json = VALUES(vector_json), last_used_at = VALUES(last_used_at)
    `, [queryHash, model, JSON.stringify(computed), toMysqlDate(now), toMysqlDate(now)])
    return computed
  }

  async hasRelevantContent(query: string): Promise<boolean> {
    const result = await this.search(query, 1)
    return !result.startsWith('未在知识库中找到') && result !== '（空查询）'
  }

  async findVisionMedia(query: string, limit = 3): Promise<KbMediaRef[]> {
    const normalized = query.trim()
    if (normalized === '' || !visionEmbeddingsConfigured()) return []
    const model = visionModelKey()
    const [rows] = await this.pool.execute<VisionHitRow[]>(`
      SELECT a.id, d.title, v.source_url AS url, e.vector_json
      FROM knowledge_assets a
      JOIN knowledge_document_versions v ON v.id = a.version_id
      JOIN knowledge_documents d ON d.id = v.document_id
      JOIN knowledge_embeddings e
        ON e.target_type = 'asset' AND e.target_id = a.id
       AND e.vector_kind = 'vision' AND e.model_key = ?
      WHERE a.asset_type = 'image' AND a.binary_data IS NOT NULL
        AND d.publication_status = 'online'
        AND v.status = 'published'
        AND (v.effective_at IS NULL OR v.effective_at <= NOW(3))
        AND (v.expires_at IS NULL OR v.expires_at > NOW(3))
    `, [model])
    if (rows.length === 0) return []
    const queryVector = await this.cachedVisionQueryVector(normalized, model)
    return rows.flatMap((row) => {
      const vector = parsedVector(row.vector_json)
      return vector === undefined ? [] : [{ row, score: anyCosine(queryVector, vector) }]
    })
      .filter(result => result.score > 0.25)
      .sort((left, right) => right.score - left.score)
      .slice(0, Math.max(1, Math.min(5, Math.trunc(limit))))
      .map(({ row }) => ({ id: row.id, title: row.title, sourceUrl: row.url }))
  }

  async visionAsset(id: number): Promise<{ mime: string; image: Buffer } | undefined> {
    const [rows] = await this.pool.execute<Array<RowDataPacket & { mime_type: string; binary_data: Buffer }>>(`
      SELECT mime_type, binary_data FROM knowledge_assets
      WHERE id = ? AND asset_type = 'image' AND binary_data IS NOT NULL
    `, [id])
    const row = rows[0]
    return row === undefined ? undefined : { mime: row.mime_type, image: Buffer.from(row.binary_data) }
  }

  async visionStatus(): Promise<KnowledgeVisionStatus> {
    const configured = visionEmbeddingsConfigured()
    const model = configured ? visionModelKey() : null
    const [assets, embeddings, cachedQueries, returnedImages] = await Promise.all([
      this.count('SELECT COUNT(*) AS total FROM knowledge_assets WHERE asset_type = \'image\' AND binary_data IS NOT NULL'),
      model === null ? 0 : this.count(`
          SELECT COUNT(*) AS total FROM knowledge_embeddings
          WHERE target_type = 'asset' AND vector_kind = 'vision' AND model_key = ?
        `, [model]),
      model === null ? 0 : this.count(`
          SELECT COUNT(*) AS total FROM knowledge_query_embeddings WHERE model_key = ?
        `, [`vision:${model}`]),
      this.count(`
        SELECT COUNT(*) AS total FROM conversation_messages
        WHERE media_json IS NOT NULL AND JSON_LENGTH(media_json) > 0
      `),
    ])
    return {
      configured,
      model,
      assets,
      embeddings,
      cachedQueries,
      returnedImages,
    }
  }

  private async count(sql: string, parameters: Array<string | number> = []): Promise<number> {
    const [rows] = await this.pool.execute<CountRow[]>(sql, parameters)
    return rows[0]?.total ?? 0
  }

  private async cachedVisionQueryVector(query: string, model: string): Promise<EmbedVector> {
    const queryHash = createHash('sha256').update(query).digest('hex')
    const cacheModel = `vision:${model}`
    const [rows] = await this.pool.execute<Array<RowDataPacket & { vector_json: unknown }>>(`
      SELECT vector_json FROM knowledge_query_embeddings WHERE query_hash = ? AND model_key = ?
    `, [queryHash, cacheModel])
    const cached = parsedVector(rows[0]?.vector_json)
    if (cached !== undefined) {
      await this.pool.execute(`
        UPDATE knowledge_query_embeddings SET last_used_at = ? WHERE query_hash = ? AND model_key = ?
      `, [toMysqlDate(Date.now()), queryHash, cacheModel])
      return cached
    }
    const computed = await embedVisionText(query)
    const now = Date.now()
    await this.pool.execute(`
      INSERT INTO knowledge_query_embeddings (
        query_hash, model_key, vector_json, created_at, last_used_at
      ) VALUES (?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE vector_json = VALUES(vector_json), last_used_at = VALUES(last_used_at)
    `, [queryHash, cacheModel, JSON.stringify(computed), toMysqlDate(now), toMysqlDate(now)])
    return computed
  }

  private async activeChunks(): Promise<KnowledgeHitRow[]> {
    const [rows] = await this.pool.query<KnowledgeHitRow[]>(`
      SELECT c.id, d.title, s.source_key AS source, v.source_url AS url, c.content, e.vector_json
      FROM knowledge_chunks c
      JOIN knowledge_document_versions v ON v.id = c.version_id
      JOIN knowledge_documents d ON d.id = v.document_id
      JOIN knowledge_sources s ON s.id = d.source_id
      LEFT JOIN knowledge_embeddings e
        ON e.target_type = 'chunk' AND e.target_id = c.id AND e.vector_kind = 'text'
      WHERE d.publication_status = 'online'
        AND v.status = 'published'
        AND (v.effective_at IS NULL OR v.effective_at <= NOW(3))
        AND (v.expires_at IS NULL OR v.expires_at > NOW(3))
      ORDER BY c.id
    `)
    return rows
  }
}
