/** Projects the local retrieval index into the durable MySQL knowledge schema. */
import { createHash } from 'node:crypto'
import type { Pool, PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise'
import type {
  KnowledgeStorageDocument,
  KnowledgeStorageSnapshot,
  KnowledgeStorageVersion,
} from '../kb/store.ts'
import { toMysqlDate } from './mysql-time.ts'

interface IdRow extends RowDataPacket { id: number }
interface NumberRow extends RowDataPacket { value: number }
type SqlValue = string | number | Date | null | Buffer

/** Counts written by one complete knowledge projection. */
export interface KnowledgeProjectionResult {
  documents: number
  versions: number
  chunks: number
  embeddings: number
  assets: number
}

function sourceType(source: string): string {
  if (source.startsWith('manual:')) return 'manual'
  if (source.startsWith('feishu:docx:')) return 'feishu_docx'
  if (source.startsWith('bitable:')) return 'feishu_bitable'
  if (source.startsWith('wiki:')) return 'feishu_wiki'
  return 'knowledge'
}

function versionHash(document: KnowledgeStorageDocument): string {
  return createHash('sha256').update(JSON.stringify(document.chunks.map(chunk => chunk.content))).digest('hex')
}

function vectorDimensions(vector: number[] | Record<string, number>): number {
  return Array.isArray(vector) ? vector.length : Object.keys(vector).length
}

async function findId(connection: PoolConnection, sql: string, values: SqlValue[]): Promise<number | undefined> {
  const [rows] = await connection.execute<IdRow[]>(sql, values)
  return rows[0]?.id
}

async function sourceId(connection: PoolConnection, document: KnowledgeStorageDocument, now: number): Promise<number> {
  await connection.execute(`
    INSERT INTO knowledge_sources (
      source_type, source_key, name, source_url, owner_employee_id, enabled, created_at, updated_at
    ) VALUES (?, ?, ?, ?, NULL, 1, ?, ?)
    ON DUPLICATE KEY UPDATE name = VALUES(name), source_url = VALUES(source_url), updated_at = VALUES(updated_at)
  `, [sourceType(document.source), document.source, document.title, document.url, toMysqlDate(now), toMysqlDate(now)])
  const id = await findId(connection, 'SELECT id FROM knowledge_sources WHERE source_key = ?', [document.source])
  if (id === undefined) throw new Error(`知识来源投影失败：${document.source}`)
  return id
}

async function documentId(
  connection: PoolConnection,
  sourceIdValue: number,
  document: KnowledgeStorageDocument,
  now: number,
): Promise<number> {
  await connection.execute(`
    INSERT INTO knowledge_documents (
      source_id, external_document_key, title, owner_employee_id, confidentiality,
      publication_status, publication_updated_at, created_at, updated_at
    ) VALUES (?, ?, ?, NULL, 'internal', ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE title = VALUES(title), publication_status = VALUES(publication_status),
      publication_updated_at = VALUES(publication_updated_at), updated_at = VALUES(updated_at)
  `, [sourceIdValue, document.source, document.title, document.online ? 'online' : 'offline',
    toMysqlDate(now), toMysqlDate(now), toMysqlDate(now)])
  const id = await findId(connection, `
    SELECT id FROM knowledge_documents WHERE source_id = ? AND external_document_key = ?
  `, [sourceIdValue, document.source])
  if (id === undefined) throw new Error(`知识文档投影失败：${document.source}`)
  return id
}

async function ensureVersion(
  connection: PoolConnection,
  documentIdValue: number,
  version: Omit<KnowledgeStorageVersion, 'localId' | 'source' | 'title'>,
): Promise<number> {
  const existing = await findId(connection, `
    SELECT id FROM knowledge_document_versions WHERE document_id = ? AND content_hash = ?
  `, [documentIdValue, version.contentHash])
  if (existing !== undefined) {
    await connection.execute(`
      UPDATE knowledge_document_versions SET status = ?, source_url = ?, effective_at = ?, expires_at = ?,
        created_by = ?, published_at = ?, archived_at = COALESCE(archived_at, ?) WHERE id = ?
    `, [
      version.status,
      version.url,
      toMysqlDate(version.effectiveAt),
      toMysqlDate(version.expiresAt),
      version.reviewedBy,
      toMysqlDate(version.publishedAt),
      toMysqlDate(version.status === 'archived' ? Date.now() : null),
      existing,
    ])
    return existing
  }
  const [numberRows] = await connection.execute<NumberRow[]>(`
    SELECT COALESCE(MAX(version_no), 0) + 1 AS value FROM knowledge_document_versions WHERE document_id = ?
  `, [documentIdValue])
  const versionNo = numberRows[0]?.value ?? 1
  const [result] = await connection.execute<ResultSetHeader>(`
    INSERT INTO knowledge_document_versions (
      document_id, version_no, status, content_hash, source_url, effective_at, expires_at,
      created_by, created_at, published_at, archived_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [
    documentIdValue,
    versionNo,
    version.status,
    version.contentHash,
    version.url,
    toMysqlDate(version.effectiveAt),
    toMysqlDate(version.expiresAt),
    version.reviewedBy,
    toMysqlDate(version.createdAt),
    toMysqlDate(version.publishedAt),
    toMysqlDate(version.status === 'archived' ? Date.now() : null),
  ])
  return result.insertId
}

async function replaceVersionChunks(
  connection: PoolConnection,
  versionId: number,
  chunks: readonly string[],
  sectionTitle: string,
  createdAt: number,
): Promise<number[]> {
  const [oldChunks] = await connection.execute<IdRow[]>('SELECT id FROM knowledge_chunks WHERE version_id = ?', [versionId])
  if (oldChunks.length > 0) {
    await connection.query('DELETE FROM knowledge_embeddings WHERE target_type = ? AND target_id IN (?)', ['chunk', oldChunks.map(row => row.id)])
  }
  await connection.execute('DELETE FROM knowledge_chunks WHERE version_id = ?', [versionId])
  const ids: number[] = []
  for (let index = 0; index < chunks.length; index += 1) {
    const content = chunks[index]
    if (content === undefined) continue
    const hash = createHash('sha256').update(content).digest('hex')
    const [result] = await connection.execute<ResultSetHeader>(`
      INSERT INTO knowledge_chunks (
        version_id, chunk_no, content, content_hash, section_title, page_no, created_at
      ) VALUES (?, ?, ?, ?, ?, NULL, ?)
    `, [versionId, index, content, hash, sectionTitle, toMysqlDate(createdAt)])
    ids.push(result.insertId)
  }
  return ids
}

async function replaceCurrentAssets(
  connection: PoolConnection,
  versionId: number,
  document: KnowledgeStorageDocument,
  chunkIds: readonly number[],
  now: number,
): Promise<void> {
  const [oldAssets] = await connection.execute<IdRow[]>('SELECT id FROM knowledge_assets WHERE version_id = ?', [versionId])
  if (oldAssets.length > 0) {
    await connection.query('DELETE FROM knowledge_embeddings WHERE target_type = ? AND target_id IN (?)', ['asset', oldAssets.map(row => row.id)])
  }
  await connection.execute('DELETE FROM knowledge_assets WHERE version_id = ?', [versionId])
  for (let index = 0; index < document.chunks.length; index += 1) {
    const chunk = document.chunks[index]
    const chunkId = chunkIds[index]
    if (chunk === undefined || chunkId === undefined) continue
    for (const embedding of chunk.embeddings.filter(item => item.kind === 'text')) {
      await connection.execute(`
        INSERT INTO knowledge_embeddings (
          target_type, target_id, vector_kind, model_key, dimensions, content_hash,
          vector_json, created_at, updated_at
        ) VALUES ('chunk', ?, 'text', ?, ?, ?, ?, ?, ?)
      `, [chunkId, embedding.model, vectorDimensions(embedding.vector), embedding.contentHash,
        JSON.stringify(embedding.vector), toMysqlDate(now), toMysqlDate(now)])
    }
    if (chunk.asset === null) continue
    const [assetResult] = await connection.execute<ResultSetHeader>(`
      INSERT INTO knowledge_assets (
        version_id, asset_key, asset_type, mime_type, storage_url, content_hash,
        description, binary_data, created_at
      ) VALUES (?, ?, 'image', ?, ?, ?, ?, ?, ?)
    `, [
      versionId,
      String(chunk.localId),
      chunk.asset.mime,
      `qabot://knowledge/assets/${chunk.localId}`,
      chunk.asset.contentHash,
      chunk.content,
      chunk.asset.image,
      toMysqlDate(now),
    ])
    for (const embedding of chunk.embeddings.filter(item => item.kind === 'vision')) {
      await connection.execute(`
        INSERT INTO knowledge_embeddings (
          target_type, target_id, vector_kind, model_key, dimensions, content_hash,
          vector_json, created_at, updated_at
        ) VALUES ('asset', ?, 'vision', ?, ?, ?, ?, ?, ?)
      `, [assetResult.insertId, embedding.model, vectorDimensions(embedding.vector), embedding.contentHash,
        JSON.stringify(embedding.vector), toMysqlDate(now), toMysqlDate(now)])
    }
  }
}

/** MySQL projection for documents, review versions, chunks, assets, and already-computed vectors. */
export class MysqlKnowledgeProjection {
  constructor(private readonly pool: Pool) {}

  /** Writes one consistent snapshot and returns projected row counts. */
  async replace(snapshot: KnowledgeStorageSnapshot): Promise<KnowledgeProjectionResult> {
    const connection = await this.pool.getConnection()
    const now = Date.now()
    const documents = [...snapshot.documents]
    for (const version of snapshot.versions) {
      if (documents.some(document => document.source === version.source)) continue
      documents.push({
        source: version.source,
        title: version.title,
        url: version.url,
        online: false,
        effectiveAt: null,
        expiresAt: null,
        currentVersionId: null,
        chunks: [],
      })
    }
    let versionCount = 0
    let chunkCount = 0
    try {
      await connection.beginTransaction()
      if (documents.length === 0) {
        await connection.execute("UPDATE knowledge_documents SET publication_status = 'offline', publication_updated_at = ?, updated_at = ?",
          [toMysqlDate(now), toMysqlDate(now)])
      } else {
        await connection.query(`
          UPDATE knowledge_documents d
          JOIN knowledge_sources s ON s.id = d.source_id
          SET d.publication_status = 'offline', d.publication_updated_at = ?, d.updated_at = ?
          WHERE s.source_key NOT IN (?)
        `, [toMysqlDate(now), toMysqlDate(now), documents.map(document => document.source)])
      }
      for (const document of documents) {
        const sourceIdValue = await sourceId(connection, document, now)
        const documentIdValue = await documentId(connection, sourceIdValue, document, now)
        const storedVersions = snapshot.versions.filter(version => version.source === document.source)
        const currentHash = versionHash(document)
        const currentStored = storedVersions.find(version => version.localId === document.currentVersionId)
        const allVersions = document.chunks.length > 0 && (currentStored === undefined || currentStored.contentHash !== currentHash)
          ? [...storedVersions, {
            localId: -1,
            source: document.source,
            title: document.title,
            url: document.url,
            contentHash: currentHash,
            chunks: document.chunks.map(chunk => chunk.content),
            status: 'published' as const,
            createdAt: now,
            publishedAt: now,
            effectiveAt: document.effectiveAt,
            expiresAt: document.expiresAt,
            reviewedBy: null,
          }]
          : storedVersions
        for (const version of allVersions) {
          const versionId = await ensureVersion(connection, documentIdValue, version)
          const chunkIds = await replaceVersionChunks(connection, versionId, version.chunks, version.title, version.createdAt)
          versionCount += 1
          chunkCount += chunkIds.length
          if (document.chunks.length > 0 && version.contentHash === currentHash) {
            await replaceCurrentAssets(connection, versionId, document, chunkIds, now)
          }
        }
      }
      await connection.commit()
      const [[embeddingRow], [assetRow]] = await Promise.all([
        this.pool.execute<NumberRow[]>('SELECT COUNT(*) AS value FROM knowledge_embeddings'),
        this.pool.execute<NumberRow[]>('SELECT COUNT(*) AS value FROM knowledge_assets'),
      ])
      return {
        documents: documents.length,
        versions: versionCount,
        chunks: chunkCount,
        embeddings: embeddingRow[0]?.value ?? 0,
        assets: assetRow[0]?.value ?? 0,
      }
    } catch (error) {
      await connection.rollback()
      throw error
    } finally {
      connection.release()
    }
  }
}
