import { createHash, randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type { ResultSetHeader } from 'mysql2/promise'
import { afterEach, describe, expect, it } from 'vitest'
import { MysqlKnowledgeSearch } from '../src/database/mysql-knowledge-search.ts'
import { createMysqlPool, loadMysqlMigrations, migrateMysql } from '../src/database/mysql-migrator.ts'
import { toMysqlDate } from '../src/database/mysql-time.ts'

const databaseUrl = process.env.QABOT_TEST_MYSQL_URL
const describeMysql = databaseUrl === undefined ? describe.skip : describe
const originalVision = {
  model: process.env.VISION_EMBED_MODEL,
  key: process.env.VISION_EMBED_API_KEY,
  dimension: process.env.VISION_EMBED_DIMENSION,
}

afterEach(() => {
  if (originalVision.model === undefined) delete process.env.VISION_EMBED_MODEL
  else process.env.VISION_EMBED_MODEL = originalVision.model
  if (originalVision.key === undefined) delete process.env.VISION_EMBED_API_KEY
  else process.env.VISION_EMBED_API_KEY = originalVision.key
  if (originalVision.dimension === undefined) delete process.env.VISION_EMBED_DIMENSION
  else process.env.VISION_EMBED_DIMENSION = originalVision.dimension
})

describeMysql('MySQL knowledge media integration', () => {
  it('retrieves only the newest published document version', async () => {
    if (databaseUrl === undefined) throw new Error('QABOT_TEST_MYSQL_URL is required')
    const pool = createMysqlPool(databaseUrl, 2)
    const suffix = randomUUID()
    let sourceId = 0
    let documentId = 0
    const versionIds: number[] = []
    try {
      const directory = fileURLToPath(new URL('../migrations/mysql', import.meta.url))
      await migrateMysql(pool, await loadMysqlMigrations(directory))
      const now = toMysqlDate(Date.now())
      const [source] = await pool.execute<ResultSetHeader>(`
        INSERT INTO knowledge_sources
          (source_type, source_key, name, source_url, enabled, created_at, updated_at)
        VALUES ('manual', ?, '排班版本测试', 'https://example.test/roster', 1, ?, ?)
      `, [`test-current-version-${suffix}`, now, now])
      sourceId = source.insertId
      const [document] = await pool.execute<ResultSetHeader>(`
        INSERT INTO knowledge_documents
          (source_id, external_document_key, title, confidentiality, publication_status,
           publication_updated_at, created_at, updated_at)
        VALUES (?, ?, '排班版本测试', 'internal', 'online', ?, ?, ?)
      `, [sourceId, suffix, now, now, now])
      documentId = document.insertId
      for (const [index, content] of ['旧排班日期九月十九', '新排班日期九月二十二'].entries()) {
        const contentHash = createHash('sha256').update(`${suffix}-${content}`).digest('hex')
        const [version] = await pool.execute<ResultSetHeader>(`
          INSERT INTO knowledge_document_versions
            (document_id, version_no, status, content_hash, source_url, created_at, published_at)
          VALUES (?, ?, 'published', ?, 'https://example.test/roster', ?, ?)
        `, [documentId, index + 1, contentHash, now, now])
        versionIds.push(version.insertId)
        await pool.execute(`
          INSERT INTO knowledge_chunks
            (version_id, chunk_no, content, content_hash, section_title, created_at)
          VALUES (?, 0, ?, ?, '排班版本测试', ?)
        `, [version.insertId, content, contentHash, now])
      }

      const search = new MysqlKnowledgeSearch(pool)
      expect(await search.search('旧排班日期九月十九')).toMatch(/^未在知识库中找到/)
      expect(await search.search('新排班日期九月二十二')).toContain('新排班日期九月二十二')
    } finally {
      if (versionIds.length > 0) await pool.query('DELETE FROM knowledge_chunks WHERE version_id IN (?)', [versionIds])
      if (versionIds.length > 0) await pool.query('DELETE FROM knowledge_document_versions WHERE id IN (?)', [versionIds])
      if (documentId > 0) await pool.execute('DELETE FROM knowledge_documents WHERE id = ?', [documentId])
      if (sourceId > 0) await pool.execute('DELETE FROM knowledge_sources WHERE id = ?', [sourceId])
      await pool.end()
    }
  }, 30_000)

  it('recalls a related image without visual keywords and serves its binary data', async () => {
    if (databaseUrl === undefined) throw new Error('QABOT_TEST_MYSQL_URL is required')
    process.env.VISION_EMBED_MODEL = 'test-vision-model'
    process.env.VISION_EMBED_API_KEY = 'unused-because-query-is-cached'
    process.env.VISION_EMBED_DIMENSION = '2'
    const pool = createMysqlPool(databaseUrl, 2)
    const suffix = randomUUID()
    const query = '财务报销要经过哪些步骤'
    const model = 'test-vision-model:2'
    const cacheModel = `vision:${model}`
    const queryHash = createHash('sha256').update(query).digest('hex')
    const contentHash = createHash('sha256').update(suffix).digest('hex')
    let sourceId = 0
    let documentId = 0
    let versionId = 0
    let assetId = 0
    try {
      const directory = fileURLToPath(new URL('../migrations/mysql', import.meta.url))
      await migrateMysql(pool, await loadMysqlMigrations(directory))
      const now = toMysqlDate(Date.now())
      const [source] = await pool.execute<ResultSetHeader>(`
        INSERT INTO knowledge_sources
          (source_type, source_key, name, source_url, enabled, created_at, updated_at)
        VALUES ('manual', ?, '测试视觉知识', 'https://example.test/knowledge', 1, ?, ?)
      `, [`test-vision-${suffix}`, now, now])
      sourceId = source.insertId
      const [document] = await pool.execute<ResultSetHeader>(`
        INSERT INTO knowledge_documents
          (source_id, external_document_key, title, confidentiality, publication_status,
           publication_updated_at, created_at, updated_at)
        VALUES (?, ?, '财务报销制度', 'internal', 'online', ?, ?, ?)
      `, [sourceId, suffix, now, now, now])
      documentId = document.insertId
      const [version] = await pool.execute<ResultSetHeader>(`
        INSERT INTO knowledge_document_versions
          (document_id, version_no, status, content_hash, source_url, created_at, published_at)
        VALUES (?, 1, 'published', ?, 'https://example.test/knowledge', ?, ?)
      `, [documentId, contentHash, now, now])
      versionId = version.insertId
      const [asset] = await pool.execute<ResultSetHeader>(`
        INSERT INTO knowledge_assets
          (version_id, asset_key, asset_type, mime_type, storage_url, content_hash,
           description, binary_data, created_at)
        VALUES (?, 'diagram', 'image', 'image/png', 'qabot://test/diagram', ?,
                '财务报销审批流程', ?, ?)
      `, [versionId, contentHash, Buffer.from('test-image'), now])
      assetId = asset.insertId
      await pool.execute(`
        INSERT INTO knowledge_embeddings
          (target_type, target_id, vector_kind, model_key, dimensions, content_hash,
           vector_json, created_at, updated_at)
        VALUES ('asset', ?, 'vision', ?, 2, ?, '[1,0]', ?, ?)
      `, [assetId, model, contentHash, now, now])
      await pool.execute(`
        INSERT INTO knowledge_query_embeddings
          (query_hash, model_key, vector_json, created_at, last_used_at)
        VALUES (?, ?, '[1,0]', ?, ?)
      `, [queryHash, cacheModel, now, now])

      const search = new MysqlKnowledgeSearch(pool)
      expect(await search.findVisionMedia(query)).toEqual([{
        id: assetId,
        title: '财务报销制度',
        sourceUrl: 'https://example.test/knowledge',
      }])
      expect(await search.visionAsset(assetId)).toEqual({
        mime: 'image/png',
        image: Buffer.from('test-image'),
      })
      const status = await search.visionStatus()
      expect(status.configured).toBe(true)
      expect(status.model).toBe(model)
      expect(status.assets).toBeGreaterThanOrEqual(1)
      expect(status.embeddings).toBeGreaterThanOrEqual(1)
      expect(status.cachedQueries).toBeGreaterThanOrEqual(1)
    } finally {
      await pool.execute('DELETE FROM knowledge_query_embeddings WHERE query_hash = ? AND model_key = ?', [queryHash, cacheModel])
      if (assetId > 0) await pool.execute("DELETE FROM knowledge_embeddings WHERE target_type = 'asset' AND target_id = ?", [assetId])
      if (versionId > 0) await pool.execute('DELETE FROM knowledge_document_versions WHERE id = ?', [versionId])
      if (documentId > 0) await pool.execute('DELETE FROM knowledge_documents WHERE id = ?', [documentId])
      if (sourceId > 0) await pool.execute('DELETE FROM knowledge_sources WHERE id = ?', [sourceId])
      await pool.end()
    }
  }, 30_000)
})
