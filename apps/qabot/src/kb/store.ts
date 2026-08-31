/**
 * 知识库存储：node:sqlite。
 * - FTS5 trigram 全文索引（关键词检索，中文按词 OR 兜底）
 * - 向量语义检索（本地 embedding，embedMissing 后可用），检索时混合两者。
 */

import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname } from 'node:path'
import { embedTexts, embeddingsReady, buildIndex, anyCosine, embedModelKey, type EmbedVector } from './embed.ts'
import {
  embedVisionImage,
  embedVisionText,
  visionEmbeddingsConfigured,
  visionModelKey,
} from './vision-embed.ts'

export interface KbChunk {
  /** 文档标题。 */
  title: string
  /** 来源路径/标识。 */
  source: string
  /** 分块后的文本内容。 */
  content: string
}

export interface KbHit {
  title: string
  source: string
  content: string
}

/** 可返回给员工聊天界面的知识库图片引用。 */
export interface KbMediaRef {
  id: number
  title: string
  sourceUrl: string | null
}

interface DocRow {
  id: number
  title: string
  source: string
  content: string
  url: string | null
}

/** Optional publication window applied to every chunk of one reviewed version. */
export interface KnowledgePublicationWindow {
  effectiveAt?: number | null
  expiresAt?: number | null
}

const TEXT_VECTOR_KIND = 'text'
const VISION_VECTOR_KIND = 'vision'

function embeddingContentHash(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}

/** 只有员工明确需要视觉材料时才调用跨模态查询，避免普通文本问答消耗视觉额度。 */
function hasVisionIntent(query: string): boolean {
  return /图片|图表|流程图|截图|照片|示意图|结构图|组织架构图|看图|查看图|展示图/.test(query)
}

/** 按字节截断文本（UTF-8），避免把 emoji 之类切断。 */
function truncate(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text
  let end = 0
  for (let size = 0; size < maxBytes; end += 1) {
    size += Buffer.byteLength(text[end] ?? '', 'utf8')
  }
  return `${text.slice(0, end)}…`
}

/** FTS5 MATCH 短语转义：双引号包裹，内部引号翻倍。 */
function phrase(query: string): string {
  return `"${query.replaceAll('"', '""')}"`
}

export class KbStore {
  private readonly db: DatabaseSync

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    this.db = new DatabaseSync(path)
    this.db.exec('PRAGMA foreign_keys = ON;')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS docs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        source TEXT NOT NULL,
        content TEXT NOT NULL,
        url TEXT,
        hash TEXT,
        online INTEGER NOT NULL DEFAULT 1,
        effective_at INTEGER,
        expires_at INTEGER,
        version_id INTEGER
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS docs_fts USING fts5(
        content,
        tokenize = 'trigram',
        content = 'docs',
        content_rowid = 'id'
      );
      CREATE TRIGGER IF NOT EXISTS docs_ai AFTER INSERT ON docs BEGIN
        INSERT INTO docs_fts (rowid, content) VALUES (new.id, new.content);
      END;
      CREATE TRIGGER IF NOT EXISTS docs_ad AFTER DELETE ON docs BEGIN
        INSERT INTO docs_fts (docs_fts, rowid, content) VALUES ('delete', old.id, old.content);
      END;
      -- 向量表：FK 级联删除（docs 删除自动清向量），持久保留，由 embedMissing 增量补算。
      CREATE TABLE IF NOT EXISTS embeddings (
        doc_id INTEGER NOT NULL REFERENCES docs(id) ON DELETE CASCADE,
        vector TEXT NOT NULL,
        model TEXT,
        hash TEXT,
        vector_kind TEXT NOT NULL DEFAULT 'text',
        PRIMARY KEY (doc_id, vector_kind)
      );
      -- 知识库录入审核（表单提交飞书链接，主管审核后入库）。
      CREATE TABLE IF NOT EXISTS kb_pending (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        url TEXT NOT NULL,
        title TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at INTEGER NOT NULL,
        reviewed_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS knowledge_versions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source TEXT NOT NULL,
        title TEXT NOT NULL,
        url TEXT,
        content_hash TEXT NOT NULL,
        chunks_json TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending_review',
        created_at INTEGER NOT NULL,
        published_at INTEGER,
        effective_at INTEGER,
        expires_at INTEGER,
        reviewed_by TEXT
      );
      CREATE UNIQUE INDEX IF NOT EXISTS uq_knowledge_version_hash
        ON knowledge_versions (source, content_hash);
      CREATE INDEX IF NOT EXISTS idx_knowledge_version_review
        ON knowledge_versions (status, created_at DESC);
      CREATE TABLE IF NOT EXISTS vision_assets (
        doc_id INTEGER PRIMARY KEY REFERENCES docs(id) ON DELETE CASCADE,
        mime TEXT NOT NULL,
        image BLOB NOT NULL,
        content_hash TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS vision_query_cache (
        model TEXT NOT NULL,
        query_hash TEXT NOT NULL,
        vector TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (model, query_hash)
      );
      CREATE TABLE IF NOT EXISTS conversation_media (
        session_id TEXT NOT NULL,
        message_order INTEGER NOT NULL,
        doc_id INTEGER NOT NULL REFERENCES docs(id) ON DELETE CASCADE,
        rank INTEGER NOT NULL,
        PRIMARY KEY (session_id, message_order, doc_id)
      );
    `)
    // 兼容旧库：补 url / hash 列。
    for (const col of ['url TEXT', 'hash TEXT']) {
      try {
        this.db.exec(`ALTER TABLE docs ADD COLUMN ${col}`)
      } catch {
        // 列已存在
      }
    }
    for (const col of [
      'online INTEGER NOT NULL DEFAULT 1',
      'effective_at INTEGER',
      'expires_at INTEGER',
      'version_id INTEGER',
    ]) {
      try {
        this.db.exec(`ALTER TABLE docs ADD COLUMN ${col}`)
      } catch {
        // 列已存在
      }
    }
    for (const col of ['effective_at INTEGER', 'expires_at INTEGER']) {
      try {
        this.db.exec(`ALTER TABLE knowledge_versions ADD COLUMN ${col}`)
      } catch {
        // 列已存在
      }
    }
    // 兼容旧向量库：缺少元数据的记录保持失效，由 embedMissing 安全地重算一次。
    for (const col of ['model TEXT', 'hash TEXT', "vector_kind TEXT NOT NULL DEFAULT 'text'"]) {
      try {
        this.db.exec(`ALTER TABLE embeddings ADD COLUMN ${col}`)
      } catch {
        // 列已存在
      }
    }
    const embeddingPk = this.db.prepare('PRAGMA table_info(embeddings)').all() as unknown as Array<{
      name: string
      pk: number
    }>
    const hasKindPrimaryKey = embeddingPk.some(column => column.name === 'vector_kind' && column.pk > 0)
    if (!hasKindPrimaryKey) {
      this.db.exec(`
        BEGIN;
        CREATE TABLE embeddings_next (
          doc_id INTEGER NOT NULL REFERENCES docs(id) ON DELETE CASCADE,
          vector TEXT NOT NULL,
          model TEXT,
          hash TEXT,
          vector_kind TEXT NOT NULL DEFAULT 'text',
          PRIMARY KEY (doc_id, vector_kind)
        );
        INSERT INTO embeddings_next (doc_id, vector, model, hash, vector_kind)
        SELECT doc_id, vector, model, hash, vector_kind FROM embeddings;
        DROP TABLE embeddings;
        ALTER TABLE embeddings_next RENAME TO embeddings;
        COMMIT;
      `)
    }
  }

  /**
   * 增量补算向量：只处理「失效」分块，其余复用已存向量。
   * 判定失效：无向量记录 / embedding 模型版本变更（全库重算）/ 文档内容 hash 变更（单条重算）。
   * 向量表持久保留，不会每次启动重建。返回本次嵌入条数。
   */
  async embedMissing(): Promise<number> {
    const now = Date.now()
    const all = this.db.prepare(`
      SELECT id, content FROM docs
      WHERE online = 1
        AND (effective_at IS NULL OR effective_at <= ?)
        AND (expires_at IS NULL OR expires_at > ?)
    `).all(now, now) as unknown as Array<{ id: number; content: string }>
    if (all.length === 0) return 0
    buildIndex(all) // 兜底字符向量用 IDF；远程语义模式忽略
    const docs = all.map(doc => ({ ...doc, hash: embeddingContentHash(doc.content) }))
    const configuredModel = embedModelKey()
    // 本地 TF-IDF 的权重依赖全库；把语料指纹纳入版本，语料变化时整体更新。
    const model = configuredModel === 'char-ngram-v1'
      ? `${configuredModel}:${embeddingContentHash(docs.map(doc => doc.hash).sort().join(':'))}`
      : configuredModel
    const rows = this.db.prepare(`
      SELECT doc_id, model, hash
      FROM embeddings
      WHERE vector_kind = ?
    `).all(TEXT_VECTOR_KIND) as unknown as Array<{ doc_id: number; model: string | null; hash: string | null }>
    const existing = new Map(rows.map(row => [row.doc_id, row]))
    const stale = docs.filter((doc) => {
      const row = existing.get(doc.id)
      return row === undefined || row.model !== model || row.hash !== doc.hash
    })
    if (stale.length === 0) return 0
    const insert = this.db.prepare(`
      INSERT INTO embeddings (doc_id, vector, model, hash, vector_kind)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(doc_id, vector_kind) DO UPDATE SET
        vector = excluded.vector,
        model = excluded.model,
        hash = excluded.hash,
        vector_kind = excluded.vector_kind
    `)
    this.db.exec('BEGIN;')
    try {
      const BATCH = 10 // DashScope text-embedding-v4 单次最多 10 条
      for (let i = 0; i < stale.length; i += BATCH) {
        const batch = stale.slice(i, i + BATCH)
        const vectors = await embedTexts(batch.map(d => d.content))
        for (let j = 0; j < batch.length; j++) {
          const doc = batch[j]
          const vector = vectors[j]
          if (doc !== undefined && vector !== undefined) {
            insert.run(doc.id, JSON.stringify(vector), model, doc.hash, TEXT_VECTOR_KIND)
          }
        }
      }
      this.db.exec('COMMIT;')
    } catch (error) {
      this.db.exec('ROLLBACK;')
      throw error
    }
    return stale.length
  }

  /** 持久化一张知识库图片及其可展示说明，返回关联文档 id。 */
  upsertVisionAsset(input: {
    source: string
    title: string
    description: string
    url?: string
    mime: string
    image: Buffer
  }): number {
    this.upsertChunks(input.source, [input.description], input.title, input.url)
    const row = this.db.prepare(
      'SELECT id FROM docs WHERE source = ? ORDER BY id DESC LIMIT 1',
    ).get(input.source) as { id: number } | undefined
    if (row === undefined) throw new Error(`视觉知识条目未写入：${input.source}`)
    const hash = embeddingContentHash(input.image.toString('base64'))
    this.db.prepare(`
      INSERT INTO vision_assets (doc_id, mime, image, content_hash)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(doc_id) DO UPDATE SET
        mime = excluded.mime,
        image = excluded.image,
        content_hash = excluded.content_hash
    `).run(row.id, input.mime, input.image, hash)
    return row.id
  }

  /** Returns whether a downloaded image token already has a durable local asset. */
  hasVisionAssetSource(source: string): boolean {
    return this.db.prepare(`
      SELECT 1
      FROM docs d
      JOIN vision_assets a ON a.doc_id = d.id
      WHERE d.source = ?
      LIMIT 1
    `).get(source) !== undefined
  }

  /** 删除一个文档来源中已不存在的图片及其文本、视觉向量。 */
  pruneVisionAssets(sourceBase: string, activeSources: ReadonlySet<string>): number {
    const rows = this.db.prepare(
      'SELECT id, source FROM docs WHERE source LIKE ?',
    ).all(`${sourceBase}:vision:%`) as unknown as Array<{ id: number; source: string }>
    const stale = rows.filter(row => !activeSources.has(row.source))
    const remove = this.db.prepare('DELETE FROM docs WHERE id = ?')
    this.db.exec('BEGIN;')
    try {
      for (const row of stale) remove.run(row.id)
      this.db.exec('COMMIT;')
    } catch (error) {
      this.db.exec('ROLLBACK;')
      throw error
    }
    return stale.length
  }

  /** 按图片内容与视觉模型标识增量补算视觉向量。 */
  async embedVisionMissing(): Promise<number> {
    if (!visionEmbeddingsConfigured()) return 0
    const model = visionModelKey()
    const rows = this.db.prepare(`
      SELECT a.doc_id, a.mime, a.image, a.content_hash, e.model, e.hash
      FROM vision_assets a
      JOIN docs d ON d.id = a.doc_id
      LEFT JOIN embeddings e ON e.doc_id = a.doc_id AND e.vector_kind = ?
      WHERE d.online = 1
        AND (d.effective_at IS NULL OR d.effective_at <= ?)
        AND (d.expires_at IS NULL OR d.expires_at > ?)
    `).all(VISION_VECTOR_KIND, Date.now(), Date.now()) as unknown as Array<{
      doc_id: number
      mime: string
      image: Uint8Array
      content_hash: string
      model: string | null
      hash: string | null
    }>
    const configuredLimit = Number(process.env.VISION_EMBED_MAX_PER_SYNC ?? 20)
    if (!Number.isInteger(configuredLimit) || configuredLimit <= 0) {
      throw new Error('VISION_EMBED_MAX_PER_SYNC 必须是正整数')
    }
    const stale = rows
      .filter(row => row.model !== model || row.hash !== row.content_hash)
      .slice(0, configuredLimit)
    if (stale.length === 0) return 0
    const insert = this.db.prepare(`
      INSERT INTO embeddings (doc_id, vector, model, hash, vector_kind)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(doc_id, vector_kind) DO UPDATE SET
        vector = excluded.vector,
        model = excluded.model,
        hash = excluded.hash
    `)
    this.db.exec('BEGIN;')
    try {
      for (const row of stale) {
        const vector = await embedVisionImage(Buffer.from(row.image), row.mime)
        insert.run(row.doc_id, JSON.stringify(vector), model, row.content_hash, VISION_VECTOR_KIND)
      }
      this.db.exec('COMMIT;')
    } catch (error) {
      this.db.exec('ROLLBACK;')
      throw error
    }
    return stale.length
  }

  /**
   * 文搜图并返回可展示图片。查询向量按模型版本和问题内容持久缓存，重复提问不再次消耗额度。
   */
  async findVisionMedia(query: string, limit = 3): Promise<KbMediaRef[]> {
    const q = query.trim()
    if (q === '' || !hasVisionIntent(q) || !visionEmbeddingsConfigured()) return []
    const rows = this.db.prepare(`
      SELECT d.id, d.title, d.url, e.vector
      FROM docs d
      JOIN embeddings e ON e.doc_id = d.id
      JOIN vision_assets a ON a.doc_id = d.id
      WHERE e.vector_kind = ? AND e.model = ?
        AND d.online = 1
        AND (d.effective_at IS NULL OR d.effective_at <= ?)
        AND (d.expires_at IS NULL OR d.expires_at > ?)
    `).all(VISION_VECTOR_KIND, visionModelKey(), Date.now(), Date.now()) as unknown as Array<{
      id: number
      title: string
      url: string | null
      vector: string
    }>
    if (rows.length === 0) return []
    const queryVector = await this.cachedVisionQueryVector(q)
    return rows.map(row => ({
      row,
      score: anyCosine(queryVector, JSON.parse(row.vector) as EmbedVector),
    })).filter(result => result.score > 0.25)
      .sort((left, right) => right.score - left.score)
      .slice(0, Math.max(1, Math.min(5, Math.trunc(limit))))
      .map(({ row }) => ({ id: row.id, title: row.title, sourceUrl: row.url }))
  }

  /** 保存某条助手消息实际返回的图片，供刷新会话时恢复。 */
  setConversationMedia(sessionId: string, messageOrder: number, media: readonly KbMediaRef[]): void {
    const remove = this.db.prepare('DELETE FROM conversation_media WHERE session_id = ? AND message_order = ?')
    const insert = this.db.prepare(`
      INSERT INTO conversation_media (session_id, message_order, doc_id, rank)
      VALUES (?, ?, ?, ?)
    `)
    this.db.exec('BEGIN;')
    try {
      remove.run(sessionId, messageOrder)
      media.forEach((item, rank) => insert.run(sessionId, messageOrder, item.id, rank))
      this.db.exec('COMMIT;')
    } catch (error) {
      this.db.exec('ROLLBACK;')
      throw error
    }
  }

  /** 读取会话中已返回的图片引用，按助手消息序号分组。 */
  conversationMedia(sessionId: string): Map<number, KbMediaRef[]> {
    const rows = this.db.prepare(`
      SELECT m.message_order, d.id, d.title, d.url
      FROM conversation_media m
      JOIN docs d ON d.id = m.doc_id
      WHERE m.session_id = ?
      ORDER BY m.message_order, m.rank
    `).all(sessionId) as unknown as Array<{
      message_order: number
      id: number
      title: string
      url: string | null
    }>
    const grouped = new Map<number, KbMediaRef[]>()
    for (const row of rows) {
      const list = grouped.get(row.message_order) ?? []
      list.push({ id: row.id, title: row.title, sourceUrl: row.url })
      grouped.set(row.message_order, list)
    }
    return grouped
  }

  /** 读取一张知识库原图。 */
  visionAsset(id: number): { mime: string; image: Buffer } | undefined {
    const row = this.db.prepare(
      'SELECT mime, image FROM vision_assets WHERE doc_id = ?',
    ).get(id) as { mime: string; image: Uint8Array } | undefined
    return row === undefined ? undefined : { mime: row.mime, image: Buffer.from(row.image) }
  }

  /** 返回视觉检索的只读运行状态，不调用任何模型。 */
  visionStatus(): {
    configured: boolean
    model: string | null
    assets: number
    embeddings: number
    cachedQueries: number
    returnedImages: number
  } {
    const configured = visionEmbeddingsConfigured()
    const model = configured ? visionModelKey() : null
    const count = (sql: string, ...params: string[]): number => {
      const row = this.db.prepare(sql).get(...params) as { total: number }
      return row.total
    }
    return {
      configured,
      model,
      assets: count('SELECT COUNT(*) AS total FROM vision_assets'),
      embeddings: model === null ? 0 : count(
        'SELECT COUNT(*) AS total FROM embeddings WHERE vector_kind = ? AND model = ?',
        VISION_VECTOR_KIND,
        model,
      ),
      cachedQueries: model === null ? 0 : count(
        'SELECT COUNT(*) AS total FROM vision_query_cache WHERE model = ?',
        model,
      ),
      returnedImages: count('SELECT COUNT(*) AS total FROM conversation_media'),
    }
  }

  /** 清空知识库。 */
  clear(): void {
    this.db.exec('DELETE FROM docs;')
  }

  /**
   * 增量写入分块（diff）：只删除/新增内容变化的分块，未变化的保留原 id（向量复用）。
   * 这样定时同步时 embedding 只补变化部分，节省 API 额度。
   */
  upsertChunks(
    source: string,
    chunks: readonly string[],
    title: string,
    url?: string,
    publication: KnowledgePublicationWindow & { online?: boolean; versionId?: number | null } = {},
  ): void {
    const existing = this.db.prepare('SELECT id, hash FROM docs WHERE source = ?').all(source) as unknown as Array<{ id: number; hash: string | null }>
    const newHashes = chunks.map(chunk => createHash('sha1').update(chunk).digest('hex'))
    const existingByHash = new Map(existing.filter(r => r.hash !== null).map(r => [r.hash as string, r.id]))
    const newHashSet = new Set(newHashes)

    this.db.exec('BEGIN;')
    try {
      // 删除内容已变/被移除的旧块（级联清向量）。
      const toDelete = existing.filter(r => r.hash === null || !newHashSet.has(r.hash)).map(r => r.id)
      if (toDelete.length > 0) {
        const placeholders = toDelete.map(() => '?').join(',')
        this.db.prepare(`DELETE FROM docs WHERE id IN (${placeholders})`).run(...toDelete)
      }
      // 插入新增块。
      const insert = this.db.prepare(`
        INSERT INTO docs (
          title, source, content, url, hash, online, effective_at, expires_at, version_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i]
        const hash = newHashes[i]
        if (chunk === undefined || hash === undefined || existingByHash.has(hash)) continue
        insert.run(
          title,
          source,
          chunk,
          url ?? null,
          hash,
          publication.online === false ? 0 : 1,
          publication.effectiveAt ?? null,
          publication.expiresAt ?? null,
          publication.versionId ?? null,
        )
      }
      this.db.prepare(`
        UPDATE docs SET title = ?, url = ?, online = ?, effective_at = ?, expires_at = ?, version_id = ?
        WHERE source = ?
      `).run(
        title,
        url ?? null,
        publication.online === false ? 0 : 1,
        publication.effectiveAt ?? null,
        publication.expiresAt ?? null,
        publication.versionId ?? null,
        source,
      )
      this.db.exec('COMMIT;')
    } catch (error) {
      this.db.exec('ROLLBACK;')
      throw error
    }
  }

  /** 手工写入一段文本（qa-admin 知识库管理用）。source 按标题稳定，重写同标题即替换。 */
  ingestText(title: string, content: string): number {
    const source = `manual:${title}`
    const chunks: string[] = []
    const paragraphs = content.split(/\n\s*\n/).map(p => p.trim()).filter(p => p.length > 0)
    for (const paragraph of paragraphs) {
      if (paragraph.length <= 600) {
        chunks.push(paragraph)
      } else {
        for (let i = 0; i < paragraph.length; i += 600) chunks.push(paragraph.slice(i, i + 600))
      }
    }
    this.upsertChunks(source, chunks, title)
    return chunks.length
  }

  /** Stores changed source content as a reviewable version without changing employee retrieval. */
  stageChunks(source: string, chunks: readonly string[], title: string, url?: string): { changed: boolean; versionId?: number } {
    const normalized = [...chunks]
    const contentHash = embeddingContentHash(JSON.stringify(normalized))
    const current = this.db.prepare(
      'SELECT content FROM docs WHERE source = ? ORDER BY id',
    ).all(source) as unknown as Array<{ content: string }>
    if (current.length > 0 && embeddingContentHash(JSON.stringify(current.map(row => row.content))) === contentHash) {
      return { changed: false }
    }
    const existing = this.db.prepare(
      'SELECT id FROM knowledge_versions WHERE source = ? AND content_hash = ? LIMIT 1',
    ).get(source, contentHash) as { id: number } | undefined
    if (existing !== undefined) return { changed: false, versionId: existing.id }
    const result = this.db.prepare(`
      INSERT INTO knowledge_versions (source, title, url, content_hash, chunks_json, status, created_at)
      VALUES (?, ?, ?, ?, ?, 'pending_review', ?)
    `).run(source, title, url ?? null, contentHash, JSON.stringify(normalized), Date.now())
    return { changed: true, versionId: Number(result.lastInsertRowid) }
  }

  /** Publishes one reviewed version and archives the previous published version for the source. */
  publishVersion(
    versionId: number,
    reviewer: string,
    publication: KnowledgePublicationWindow = {},
  ): boolean {
    const effectiveAt = publication.effectiveAt ?? null
    const expiresAt = publication.expiresAt ?? null
    if (effectiveAt !== null && (!Number.isFinite(effectiveAt) || effectiveAt < 0)) return false
    if (expiresAt !== null && (!Number.isFinite(expiresAt) || expiresAt < 0)) return false
    if (effectiveAt !== null && expiresAt !== null && expiresAt <= effectiveAt) return false
    const version = this.db.prepare(`
      SELECT id, source, title, url, chunks_json
      FROM knowledge_versions WHERE id = ? AND status = 'pending_review'
    `).get(versionId) as { id: number; source: string; title: string; url: string | null; chunks_json: string } | undefined
    if (version === undefined) return false
    const chunks = JSON.parse(version.chunks_json) as string[]
    this.upsertChunks(version.source, chunks, version.title, version.url ?? undefined, {
      online: true,
      effectiveAt,
      expiresAt,
      versionId,
    })
    const now = Date.now()
    this.db.prepare("UPDATE knowledge_versions SET status = 'archived' WHERE source = ? AND status = 'published'").run(version.source)
    this.db.prepare(`
      UPDATE knowledge_versions SET status = 'published', published_at = ?, effective_at = ?, expires_at = ?, reviewed_by = ?
      WHERE id = ? AND status = 'pending_review'
    `).run(now, effectiveAt, expiresAt, reviewer, versionId)
    return true
  }

  /** Rejects one staged version without changing the currently published chunks. */
  rejectVersion(versionId: number, reviewer: string): boolean {
    const result = this.db.prepare(`
      UPDATE knowledge_versions SET status = 'rejected', reviewed_by = ?
      WHERE id = ? AND status = 'pending_review'
    `).run(reviewer, versionId)
    return Number(result.changes) > 0
  }

  /** Lists document versions awaiting review. */
  pendingVersions(): Array<{ id: number; source: string; title: string; url: string | null; contentHash: string; createdAt: number }> {
    return this.db.prepare(`
      SELECT id, source, title, url, content_hash AS contentHash, created_at AS createdAt
      FROM knowledge_versions WHERE status = 'pending_review' ORDER BY created_at DESC
    `).all() as unknown as Array<{ id: number; source: string; title: string; url: string | null; contentHash: string; createdAt: number }>
  }

  /** Returns the staged and currently published chunks for a review diff. */
  versionDiff(versionId: number): { id: number; source: string; title: string; current: string[]; proposed: string[] } | undefined {
    const version = this.db.prepare(`
      SELECT id, source, title, chunks_json FROM knowledge_versions WHERE id = ?
    `).get(versionId) as { id: number; source: string; title: string; chunks_json: string } | undefined
    if (version === undefined) return undefined
    const current = this.db.prepare(
      'SELECT content FROM docs WHERE source = ? ORDER BY id',
    ).all(version.source) as unknown as Array<{ content: string }>
    return {
      id: version.id,
      source: version.source,
      title: version.title,
      current: current.map(row => row.content),
      proposed: JSON.parse(version.chunks_json) as string[],
    }
  }

  /** 知识库条目列表（按来源聚合，含原文链接）。 */
  list(): Array<{
    source: string
    title: string
    chunks: number
    url: string | null
    publicationStatus: 'online' | 'scheduled' | 'offline'
    effectiveAt: number | null
    expiresAt: number | null
  }> {
    const now = Date.now()
    return this.db.prepare(`
      SELECT source, title, COUNT(*) AS chunks, MAX(url) AS url,
        CASE
          WHEN MIN(online) = 0 THEN 'offline'
          WHEN MIN(effective_at) IS NOT NULL AND MIN(effective_at) > ? THEN 'scheduled'
          WHEN MAX(expires_at) IS NOT NULL AND MAX(expires_at) <= ? THEN 'offline'
          ELSE 'online'
        END AS publicationStatus,
        MIN(effective_at) AS effectiveAt,
        MAX(expires_at) AS expiresAt
      FROM docs GROUP BY source, title ORDER BY MIN(id)
    `).all(now, now) as unknown as Array<{
      source: string
      title: string
      chunks: number
      url: string | null
      publicationStatus: 'online' | 'scheduled' | 'offline'
      effectiveAt: number | null
      expiresAt: number | null
    }>
  }

  /** Changes whether one source participates in retrieval without deleting its versions or vectors. */
  setPublication(source: string, online: boolean): boolean {
    const result = this.db.prepare('UPDATE docs SET online = ? WHERE source = ?').run(online ? 1 : 0, source)
    return Number(result.changes) > 0
  }

  /** 按来源删除（触发 FTS 同步删除）。 */
  remove(source: string): void {
    this.db.prepare('DELETE FROM docs WHERE source = ?').run(source)
  }

  // ── 知识库录入审核 ──
  addPending(url: string, title: string): { id: number } {
    const { lastInsertRowid } = this.db.prepare(
      'INSERT INTO kb_pending (url, title, created_at) VALUES (?, ?, ?)',
    ).run(url, title, Date.now())
    return { id: Number(lastInsertRowid) }
  }

  listPending(): Array<{ id: number; url: string; title: string; status: string; createdAt: number }> {
    return this.db.prepare(
      'SELECT id, url, title, status, created_at AS createdAt FROM kb_pending ORDER BY id DESC',
    ).all() as unknown as Array<{ id: number; url: string; title: string; status: string; createdAt: number }>
  }

  setPendingStatus(id: number, status: 'approved' | 'rejected'): boolean {
    const result = this.db.prepare(
      'UPDATE kb_pending SET status = ?, reviewed_at = ? WHERE id = ? AND status = \'pending\'',
    ).run(status, Date.now(), id)
    return Number(result.changes) > 0
  }

  /** 修改待审核条目（链接/标题）。 */
  updatePending(id: number, url: string, title: string): boolean {
    const result = this.db.prepare(
      'UPDATE kb_pending SET url = ?, title = ? WHERE id = ? AND status = \'pending\'',
    ).run(url, title, id)
    return Number(result.changes) > 0
  }

  /** 文档总数。 */
  count(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM docs').get() as { n: number }
    return row.n
  }

  /** 检索知识库（向量 + 关键词混合），返回格式化片段。 */
  async search(query: string, limit = 5): Promise<string> {
    const q = query.trim()
    if (q === '') return '（空查询）'
    const kwHits = this.searchKeywords(q, limit)
    const [vecHits, visionHits] = await Promise.all([
      this.searchVector(q, limit),
      (hasVisionIntent(q) ? this.searchVision(q, limit) : Promise.resolve([])).catch((error: unknown) => {
        console.error('[kb-vision] 查询失败，降级为文本检索:', error instanceof Error ? error.message : error)
        return []
      }),
    ])
    // 合并：文本语义、视觉语义优先，关键词命中补充去重。
    const seen = new Set<number>()
    const merged: DocRow[] = []
    for (const row of [...vecHits, ...visionHits, ...kwHits]) {
      if (merged.length >= limit) break
      if (seen.has(row.id)) continue
      seen.add(row.id)
      merged.push(row)
    }
    if (merged.length === 0) {
      return `未在知识库中找到与「${q}」相关的内容。`
    }
    return merged.map((row, index) => {
      const excerpt = truncate(row.content, 2000)
      const link = row.url !== null && row.url !== '' ? `\n链接：${row.url}` : ''
      return `【${index + 1}】${row.title}${link}\n${excerpt}`
    }).join('\n\n')
  }

  /** 判断问题是否存在可供 AI 回答的知识命中；向量服务异常时保留关键词降级。 */
  async hasRelevantContent(query: string): Promise<boolean> {
    const q = query.trim()
    if (q === '') return false
    if (this.searchKeywords(q, 1).length > 0) return true
    const [textHits, visionHits] = await Promise.all([
      this.searchVector(q, 1).catch(() => []),
      hasVisionIntent(q) ? this.searchVision(q, 1).catch(() => []) : Promise.resolve([]),
    ])
    return textHits.length > 0 || visionHits.length > 0
  }

  /** 关键词检索（FTS 精确 + 按词 OR）。 */
  private searchKeywords(query: string, limit: number): DocRow[] {
    const ftsHits = query.length >= 3 ? this.searchFts(query, limit) : []
    const termHits = this.searchTerms(query, limit)
    const seen = new Set(ftsHits.map(r => r.id))
    return [...ftsHits, ...termHits.filter(r => !seen.has(r.id))].slice(0, limit)
  }

  /** 向量语义检索：embedding 余弦相似度。索引未构建时返回空。 */
  private async searchVector(query: string, limit: number): Promise<DocRow[]> {
    if (!await embeddingsReady()) return []
    const rows = this.db.prepare(
      `SELECT d.id, d.title, d.source, d.content, d.url, e.vector
       FROM docs d JOIN embeddings e ON e.doc_id = d.id
       WHERE e.vector_kind = ?
         AND d.online = 1
         AND (d.effective_at IS NULL OR d.effective_at <= ?)
         AND (d.expires_at IS NULL OR d.expires_at > ?)`,
    ).all(TEXT_VECTOR_KIND, Date.now(), Date.now()) as unknown as Array<DocRow & { vector: string }>
    if (rows.length === 0) return []
    const [qvec] = await embedTexts([query])
    if (qvec === undefined || Object.keys(qvec).length === 0) return []
    const scored = rows.map((row) => {
      const vec = JSON.parse(row.vector) as EmbedVector
      return { row, score: anyCosine(qvec, vec) }
    }).sort((a, b) => b.score - a.score)
      .filter(x => x.score > 0.25) // 语义相似度阈值，过滤噪声（原 0.05 太松）
    return scored.slice(0, limit).map(x => x.row)
  }

  /** 文本查询与图片向量做跨模态余弦检索。 */
  private async searchVision(query: string, limit: number): Promise<DocRow[]> {
    if (!visionEmbeddingsConfigured()) return []
    const rows = this.db.prepare(`
      SELECT d.id, d.title, d.source, d.content, d.url, e.vector
      FROM docs d JOIN embeddings e ON e.doc_id = d.id
      WHERE e.vector_kind = ? AND e.model = ?
        AND d.online = 1
        AND (d.effective_at IS NULL OR d.effective_at <= ?)
        AND (d.expires_at IS NULL OR d.expires_at > ?)
    `).all(VISION_VECTOR_KIND, visionModelKey(), Date.now(), Date.now()) as unknown as Array<DocRow & { vector: string }>
    if (rows.length === 0) return []
    const queryVector = await this.cachedVisionQueryVector(query)
    return rows.map(row => ({
      row,
      score: anyCosine(queryVector, JSON.parse(row.vector) as EmbedVector),
    })).filter(result => result.score > 0.25)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(result => result.row)
  }

  private async cachedVisionQueryVector(query: string): Promise<EmbedVector> {
    const model = visionModelKey()
    const queryHash = embeddingContentHash(query.trim())
    const cached = this.db.prepare(`
      SELECT vector FROM vision_query_cache WHERE model = ? AND query_hash = ?
    `).get(model, queryHash) as { vector: string } | undefined
    if (cached !== undefined) return JSON.parse(cached.vector) as EmbedVector
    const vector = await embedVisionText(query)
    this.db.prepare(`
      INSERT INTO vision_query_cache (model, query_hash, vector, created_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(model, query_hash) DO NOTHING
    `).run(model, queryHash, JSON.stringify(vector), Date.now())
    return vector
  }

  /** FTS5 trigram 检索（查询需 ≥3 字符）。 */
  private searchFts(query: string, limit: number): DocRow[] {
    try {
      return this.db.prepare(`
        SELECT d.id, d.title, d.source, d.content, d.url
        FROM docs_fts
        JOIN docs d ON d.id = docs_fts.rowid
        WHERE docs_fts MATCH ?
          AND d.online = 1
          AND (d.effective_at IS NULL OR d.effective_at <= ?)
          AND (d.expires_at IS NULL OR d.expires_at > ?)
        ORDER BY bm25(docs_fts)
        LIMIT ?
      `).all(phrase(query), Date.now(), Date.now(), limit) as unknown as DocRow[]
    } catch {
      // trigram 对特殊语法可能报错，回落按词匹配
      return []
    }
  }

  /** 按词 OR 匹配：把查询拆成词，命中任意词的行按「命中词数×词长」排序。
   *  解决中文短语/词序问题（如「陈溢敏 值班」匹配「值班：陈溢敏」）。 */
  private searchTerms(query: string, limit: number): DocRow[] {
    const terms = query.split(/[\s,，。、！!？?;；:：()（）]+/).filter(t => t.length >= 2)
    if (terms.length === 0) return []
    const all = this.db.prepare(`
      SELECT id, title, source, content, url FROM docs
      WHERE online = 1
        AND (effective_at IS NULL OR effective_at <= ?)
        AND (expires_at IS NULL OR expires_at > ?)
    `).all(Date.now(), Date.now()) as unknown as DocRow[]
    const scored = all.map((row) => {
      const hay = `${row.title}\n${row.content}`
      let score = 0
      let firstPos = Number.MAX_SAFE_INTEGER
      for (const term of terms) {
        const at = hay.indexOf(term)
        if (at !== -1) {
          score += term.length
          firstPos = Math.min(firstPos, at)
        }
      }
      return { row, score, firstPos }
    }).filter(x => x.score > 0)
      .sort((a, b) => b.score - a.score || a.firstPos - b.firstPos)
    return scored.slice(0, limit).map(x => x.row)
  }

  dispose(): void {
    this.db.close()
  }
}
