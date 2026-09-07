/** MySQL-authoritative registry for online knowledge sources. */
import type { Pool, ResultSetHeader, RowDataPacket } from 'mysql2/promise'
import { fromMysqlDate, type MysqlDateValue, toMysqlDate } from './mysql-time.ts'

export const KNOWLEDGE_GROUPS = ['人事', '行政', 'IT', '财务', '其他'] as const
export type KnowledgeGroup = typeof KNOWLEDGE_GROUPS[number]
export type KnowledgeSyncStatus = 'pending' | 'syncing' | 'ready' | 'failed'

export interface KnowledgeSourceRecord {
  id: number
  sourceType: string
  sourceKey: string
  title: string
  url: string
  group: KnowledgeGroup
  submitterEmployeeId: string
  submitterName: string
  syncStatus: KnowledgeSyncStatus
  lastSyncedAt: number | null
  lastError: string | null
  removedAt: number | null
  createdAt: number
  updatedAt: number
  chunks: number
  images: number
}

interface SourceRow extends RowDataPacket {
  id: number
  source_type: string
  source_key: string
  name: string
  source_url: string | null
  service_group: KnowledgeGroup
  owner_employee_id: string | null
  submitter_name: string
  sync_status: KnowledgeSyncStatus
  last_synced_at: MysqlDateValue
  last_error: string | null
  removed_at: MysqlDateValue
  created_at: MysqlDateValue
  updated_at: MysqlDateValue
  chunks: number
  images: number
}

function mapRow(row: SourceRow): KnowledgeSourceRecord {
  return {
    id: row.id,
    sourceType: row.source_type,
    sourceKey: row.source_key,
    title: row.name,
    url: row.source_url ?? '',
    group: row.service_group,
    submitterEmployeeId: row.owner_employee_id ?? 'system-migration',
    submitterName: row.submitter_name,
    syncStatus: row.sync_status,
    lastSyncedAt: fromMysqlDate(row.last_synced_at),
    lastError: row.last_error,
    removedAt: fromMysqlDate(row.removed_at),
    createdAt: fromMysqlDate(row.created_at),
    updatedAt: fromMysqlDate(row.updated_at),
    chunks: row.chunks,
    images: row.images,
  }
}

const SOURCE_SELECT = `
  SELECT s.*,
    COUNT(DISTINCT CASE WHEN v.status = 'published' THEN c.id END) AS chunks,
    COUNT(DISTINCT CASE WHEN v.status = 'published' THEN a.id END) AS images
  FROM knowledge_sources s
  LEFT JOIN knowledge_documents d ON d.source_id = s.id
  LEFT JOIN knowledge_document_versions v ON v.document_id = d.id
  LEFT JOIN knowledge_chunks c ON c.version_id = v.id
  LEFT JOIN knowledge_assets a ON a.version_id = v.id
`

/** Reads and mutates source configuration without using the legacy JSON registry. */
export class MysqlKnowledgeSourceRepository {
  constructor(private readonly pool: Pool) {}

  /** Lists active sources, including current published content counts. */
  async list(): Promise<KnowledgeSourceRecord[]> {
    const [rows] = await this.pool.query<SourceRow[]>(`${SOURCE_SELECT}
      WHERE s.enabled = 1 AND s.removed_at IS NULL
      GROUP BY s.id ORDER BY s.updated_at DESC, s.id DESC`)
    return rows.map(mapRow)
  }

  /** Gets one source regardless of removal state. */
  async get(id: number): Promise<KnowledgeSourceRecord | undefined> {
    const [rows] = await this.pool.execute<SourceRow[]>(`${SOURCE_SELECT}
      WHERE s.id = ? GROUP BY s.id`, [id])
    return rows[0] === undefined ? undefined : mapRow(rows[0])
  }

  /** Returns the existing active or removed row for one stable Feishu source key. */
  async findByKey(sourceKey: string): Promise<KnowledgeSourceRecord | undefined> {
    const [rows] = await this.pool.execute<SourceRow[]>(`${SOURCE_SELECT}
      WHERE s.source_key = ? GROUP BY s.id`, [sourceKey])
    return rows[0] === undefined ? undefined : mapRow(rows[0])
  }

  /** Creates a source, restores a removed source, or lets an authorized caller claim a migrated source. */
  async createOrReactivate(input: {
    sourceType: string
    sourceKey: string
    title: string
    url: string
    group: KnowledgeGroup
    submitterEmployeeId: string
    submitterName: string
    allowMigrationClaim?: boolean
  }): Promise<{ source: KnowledgeSourceRecord; reactivated: boolean; claimed: boolean }> {
    const existing = await this.findByKey(input.sourceKey)
    const now = Date.now()
    if (existing !== undefined && existing.removedAt === null) {
      if (existing.submitterEmployeeId !== 'system-migration' || input.allowMigrationClaim !== true) {
        throw new Error('KNOWLEDGE_SOURCE_EXISTS')
      }
      await this.pool.execute(`UPDATE knowledge_sources SET
        name = ?, source_url = ?, service_group = ?, owner_employee_id = ?, submitter_name = ?,
        sync_status = 'pending', last_error = NULL, updated_at = ? WHERE id = ?`, [input.title,
        input.url, input.group, input.submitterEmployeeId, input.submitterName, toMysqlDate(now), existing.id])
      const source = await this.get(existing.id)
      if (source === undefined) throw new Error('KNOWLEDGE_SOURCE_NOT_FOUND')
      return { source, reactivated: false, claimed: true }
    }
    if (existing !== undefined) {
      await this.pool.execute(`UPDATE knowledge_sources SET
        name = ?, source_url = ?, service_group = ?, owner_employee_id = ?, submitter_name = ?,
        enabled = 1, sync_status = 'pending', last_error = NULL, removed_at = NULL, updated_at = ?
        WHERE id = ?`, [input.title, input.url, input.group, input.submitterEmployeeId,
        input.submitterName, toMysqlDate(now), existing.id])
      const source = await this.get(existing.id)
      if (source === undefined) throw new Error('KNOWLEDGE_SOURCE_NOT_FOUND')
      return { source, reactivated: true, claimed: false }
    }
    const [result] = await this.pool.execute<ResultSetHeader>(`INSERT INTO knowledge_sources (
      source_type, source_key, name, source_url, owner_employee_id, service_group, submitter_name,
      enabled, sync_status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, 'pending', ?, ?)`, [input.sourceType, input.sourceKey,
      input.title, input.url, input.submitterEmployeeId, input.group, input.submitterName,
      toMysqlDate(now), toMysqlDate(now)])
    const source = await this.get(result.insertId)
    if (source === undefined) throw new Error('KNOWLEDGE_SOURCE_NOT_FOUND')
    return { source, reactivated: false, claimed: false }
  }

  /** Updates editable source metadata while leaving its stable URL unchanged. */
  async update(id: number, title: string, group: KnowledgeGroup): Promise<boolean> {
    const connection = await this.pool.getConnection()
    const now = toMysqlDate(Date.now())
    try {
      await connection.beginTransaction()
      const [result] = await connection.execute<ResultSetHeader>(`UPDATE knowledge_sources
        SET name = ?, service_group = ?, updated_at = ?
        WHERE id = ? AND enabled = 1 AND removed_at IS NULL`, [title, group, now, id])
      if (result.affectedRows > 0) {
        await connection.execute(`UPDATE knowledge_documents d
          JOIN knowledge_sources s ON s.id = d.source_id
          SET d.title = ?, d.updated_at = ?
          WHERE d.source_id = ? AND d.external_document_key = s.source_key`, [title, now, id])
      }
      await connection.commit()
      return result.affectedRows > 0
    } catch (error) {
      await connection.rollback()
      throw error
    } finally {
      connection.release()
    }
  }

  /** Assigns an active migration-owned source to the authorized supervisor who starts synchronization. */
  async claimMigrated(id: number, submitterEmployeeId: string, submitterName: string): Promise<boolean> {
    const [result] = await this.pool.execute<ResultSetHeader>(`UPDATE knowledge_sources SET
      owner_employee_id = ?, submitter_name = ?, sync_status = 'pending', last_error = NULL, updated_at = ?
      WHERE id = ? AND enabled = 1 AND removed_at IS NULL AND owner_employee_id = 'system-migration'`,
    [submitterEmployeeId, submitterName, toMysqlDate(Date.now()), id])
    return result.affectedRows > 0
  }

  /** Records a running synchronization. */
  async markSyncing(id: number): Promise<void> {
    await this.pool.execute(`UPDATE knowledge_sources SET sync_status = 'syncing', last_error = NULL,
      updated_at = ? WHERE id = ? AND enabled = 1 AND removed_at IS NULL`, [toMysqlDate(Date.now()), id])
  }

  /** Records a successful synchronization. */
  async markReady(id: number, warning: string | null = null): Promise<void> {
    const now = toMysqlDate(Date.now())
    await this.pool.execute(`UPDATE knowledge_sources SET sync_status = 'ready', last_synced_at = ?,
      last_error = ?, updated_at = ? WHERE id = ?`, [now, warning?.slice(0, 4000) ?? null, now, id])
  }

  /** Records a failed synchronization while preserving previously published content. */
  async markFailed(id: number, error: string): Promise<void> {
    await this.pool.execute(`UPDATE knowledge_sources SET sync_status = 'failed', last_error = ?,
      updated_at = ? WHERE id = ?`, [error.slice(0, 4000), toMysqlDate(Date.now()), id])
  }

  /** Soft-removes a source and immediately excludes its published documents from retrieval. */
  async remove(id: number): Promise<boolean> {
    const connection = await this.pool.getConnection()
    const now = toMysqlDate(Date.now())
    try {
      await connection.beginTransaction()
      const [result] = await connection.execute<ResultSetHeader>(`UPDATE knowledge_sources SET
        enabled = 0, removed_at = ?, updated_at = ? WHERE id = ? AND enabled = 1 AND removed_at IS NULL`, [now, now, id])
      if (result.affectedRows > 0) {
        await connection.execute(`UPDATE knowledge_documents SET publication_status = 'offline',
          publication_updated_at = ?, updated_at = ? WHERE source_id = ?`, [now, now, id])
      }
      await connection.commit()
      return result.affectedRows > 0
    } catch (error) {
      await connection.rollback()
      throw error
    } finally {
      connection.release()
    }
  }
}
