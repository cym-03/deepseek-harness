/** MySQL session-persistence backend for Qabot model event logs. */
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import {
  DEFAULT_PREPARED_SESSION_CACHE_SIZE,
  DEFAULT_WRITE_BATCH_MAX_DELAY_MS,
  PersistenceCoordinator,
  SessionPersistence,
  SessionPersistenceRevision,
  type PersistenceBackend,
  type SessionInspection,
  type SessionLocation,
  type SessionPersistenceSnapshot,
  type StoredPrefix,
  type StoredSuffix,
} from '@deepseek-ai/dsh-session-persistence'
import type { SessionEvent, SessionHeader, SessionId, SessionPreparation, SurfaceEventType } from '@deepseek-ai/dsh-session'
import type { Pool, PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise'
import { fromMysqlDate, type MysqlDateValue, toMysqlDate } from './mysql-time.ts'

interface SessionRow extends RowDataPacket {
  session_id: string
  format_version: number
  created_at: MysqlDateValue
  working_directory: string | null
  parent_session_id: string | null
  seed_length: number | null
  origin: string | null
  delegation_depth: number | null
  agent_preset: string | null
  incarnation: string
  revision: number
}

interface EventRow extends RowDataPacket {
  event_seq: number
  event_type: string
  event_time: MysqlDateValue
  event_data: unknown
  source_event_seqs: unknown
  surface_operation: unknown
  ignorable: number | null
}

export interface MysqlSessionPersistenceConfig {
  pool: Pool
  preparedSessionCacheSize?: number
  writeBatchMaxDelayMs?: number
}

function jsonValue(value: unknown): unknown {
  if (typeof value !== 'string') return value
  try {
    return JSON.parse(value) as unknown
  } catch {
    // mysql2 unwraps a JSON string scalar (for example event data "append")
    // to its plain string value, while objects and arrays remain JSON text.
    return value
  }
}

function rowToHeader(row: SessionRow): SessionHeader {
  return {
    id: row.session_id as SessionId,
    version: row.format_version,
    createdAt: fromMysqlDate(row.created_at),
    ...(row.working_directory === null ? {} : { cwd: row.working_directory }),
    ...(row.parent_session_id === null ? {} : { parentSession: row.parent_session_id as SessionId }),
    ...(row.seed_length === null ? {} : { seedLength: row.seed_length }),
    ...(row.origin === null ? {} : { origin: row.origin }),
    ...(row.delegation_depth === null ? {} : { delegationDepth: row.delegation_depth }),
    ...(row.agent_preset === null ? {} : { agentPreset: row.agent_preset }),
  } as SessionHeader
}

function rowToEvent(row: EventRow): SessionEvent {
  return {
    seq: row.event_seq,
    type: row.event_type,
    time: fromMysqlDate(row.event_time),
    data: jsonValue(row.event_data),
    ...(row.source_event_seqs === null ? {} : { sourceEventSeqs: jsonValue(row.source_event_seqs) }),
    ...(row.surface_operation === null ? {} : { surfaceOp: jsonValue(row.surface_operation) }),
    ...(row.ignorable === 1 ? { ignorable: true } : {}),
  } as SessionEvent
}

function revision(storeIdentity: string, row: SessionRow): ReturnType<typeof SessionPersistenceRevision> {
  return SessionPersistenceRevision(`${storeIdentity}:incarnation:${row.incarnation}:revision:${row.revision}`)
}

function eventBindings(event: SessionEvent): [string | null, string | null, number | null] {
  const surface = event as SessionEvent<SurfaceEventType>
  return [
    surface.sourceEventSeqs === undefined ? null : JSON.stringify(surface.sourceEventSeqs),
    surface.surfaceOp === undefined ? null : JSON.stringify(surface.surfaceOp),
    event.ignorable === true ? 1 : null,
  ]
}

/** Stores DSH model sessions and their append-only events in the shared Qabot MySQL database. */
export class MysqlSessionPersistence extends SessionPersistence implements PersistenceBackend<never> {
  static inject = ['sessions']

  override readonly supportsRawArtifacts = false
  override readonly name = 'qabot-session-persistence-mysql'
  private readonly coordinator: PersistenceCoordinator<never>
  private readonly storeIdentity: Promise<string>

  constructor(ctx: Context, readonly config: MysqlSessionPersistenceConfig) {
    super(ctx)
    this.storeIdentity = this.readStoreIdentity()
    this.coordinator = new PersistenceCoordinator(this.ctx, this, {
      preparedSessionCacheSize: config.preparedSessionCacheSize ?? DEFAULT_PREPARED_SESSION_CACHE_SIZE,
      writeBatchMaxDelayMs: config.writeBatchMaxDelayMs ?? DEFAULT_WRITE_BATCH_MAX_DELAY_MS,
    })
  }

  private async readStoreIdentity(): Promise<string> {
    const [rows] = await this.config.pool.query<Array<RowDataPacket & { database_name: string }>>(
      'SELECT DATABASE() AS database_name',
    )
    return `mysql:${rows[0]?.database_name ?? 'unknown'}:qabot`
  }

  locate(_meta: SessionHeader): SessionLocation | undefined { return undefined }
  create(meta: SessionHeader): Promise<void> { return this.coordinator.create(meta) }
  append(id: SessionId, events: readonly SessionEvent[]): Promise<void> { return this.coordinator.append(id, events) }
  override prepare(id: SessionId, signal?: AbortSignal): Promise<SessionPreparation> {
    return this.coordinator.prepare(id, signal)
  }
  load(id: SessionId): Promise<SessionInspection> { return this.coordinator.load(id) }
  inspect(id: SessionId, signal?: AbortSignal): Promise<SessionInspection> { return this.coordinator.inspect(id, signal) }
  readFrom(id: SessionId, fromSeq: number, signal?: AbortSignal): Promise<{ meta: SessionHeader; events: SessionEvent[] }> {
    return this.coordinator.readFrom(id, fromSeq, signal)
  }

  async loadStored(id: SessionId, signal?: AbortSignal): Promise<StoredPrefix<never> | undefined> {
    signal?.throwIfAborted()
    const connection = await this.config.pool.getConnection()
    try {
      await connection.beginTransaction()
      const row = await this.sessionRow(connection, id)
      if (row === undefined) {
        await connection.commit()
        return undefined
      }
      const [eventRows] = await connection.execute<EventRow[]>(`
        SELECT event_seq, event_type, event_time, event_data, source_event_seqs, surface_operation, ignorable
        FROM dsh_model_session_events WHERE session_id = ? ORDER BY event_seq
      `, [id])
      await connection.commit()
      signal?.throwIfAborted()
      return {
        meta: rowToHeader(row),
        events: eventRows.map(rowToEvent),
        revision: revision(await this.storeIdentity, row),
      }
    } catch (error) {
      await connection.rollback()
      throw error
    } finally {
      connection.release()
    }
  }

  async readStoredRevision(id: SessionId, signal?: AbortSignal): Promise<ReturnType<typeof SessionPersistenceRevision> | undefined> {
    signal?.throwIfAborted()
    const [rows] = await this.config.pool.execute<SessionRow[]>(
      'SELECT * FROM dsh_model_sessions WHERE session_id = ?', [id],
    )
    signal?.throwIfAborted()
    return rows[0] === undefined ? undefined : revision(await this.storeIdentity, rows[0])
  }

  async loadStoredFrom(id: SessionId, fromSeq: number, signal?: AbortSignal): Promise<StoredSuffix | undefined> {
    signal?.throwIfAborted()
    const [sessions] = await this.config.pool.execute<SessionRow[]>(
      'SELECT * FROM dsh_model_sessions WHERE session_id = ?', [id],
    )
    const row = sessions[0]
    if (row === undefined) return undefined
    const [events] = await this.config.pool.execute<EventRow[]>(`
      SELECT event_seq, event_type, event_time, event_data, source_event_seqs, surface_operation, ignorable
      FROM dsh_model_session_events WHERE session_id = ? AND event_seq >= ? ORDER BY event_seq
    `, [id, fromSeq])
    signal?.throwIfAborted()
    return { meta: rowToHeader(row), events: events.map(rowToEvent) }
  }

  async appendBatch(meta: SessionHeader, events: readonly SessionEvent[], isMaterialized: boolean): Promise<void> {
    const connection = await this.config.pool.getConnection()
    try {
      await connection.beginTransaction()
      if (!isMaterialized) await this.insertSession(connection, meta)
      for (const event of events) {
        const [sourceEventSeqs, surfaceOperation, ignorable] = eventBindings(event)
        await connection.execute(`
          INSERT INTO dsh_model_session_events (
            session_id, event_seq, event_type, event_time, event_data,
            source_event_seqs, surface_operation, ignorable
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `, [meta.id, event.seq, event.type, toMysqlDate(event.time), JSON.stringify(event.data),
          sourceEventSeqs, surfaceOperation, ignorable])
      }
      await connection.execute(
        'UPDATE dsh_model_sessions SET revision = revision + 1, updated_at = ? WHERE session_id = ?',
        [toMysqlDate(Date.now()), meta.id],
      )
      await connection.commit()
    } catch (error) {
      await connection.rollback()
      throw error
    } finally {
      connection.release()
    }
  }

  async commitRepair(meta: SessionHeader, _tornMarker: undefined, closers: readonly SessionEvent[]): Promise<void> {
    if (closers.length === 0) return
    await this.appendBatch(meta, closers, true)
  }

  async list(signal?: AbortSignal): Promise<SessionHeader[]> {
    signal?.throwIfAborted()
    const [rows] = await this.config.pool.query<SessionRow[]>('SELECT * FROM dsh_model_sessions ORDER BY created_at')
    signal?.throwIfAborted()
    return rows.map(rowToHeader)
  }

  async listSnapshots(signal?: AbortSignal): Promise<SessionPersistenceSnapshot[]> {
    signal?.throwIfAborted()
    const [identity, query] = await Promise.all([
      this.storeIdentity,
      this.config.pool.query<SessionRow[]>('SELECT * FROM dsh_model_sessions ORDER BY created_at'),
    ])
    signal?.throwIfAborted()
    return query[0].map(row => ({ header: rowToHeader(row), revision: revision(identity, row) }))
  }

  private async sessionRow(connection: PoolConnection, id: SessionId): Promise<SessionRow | undefined> {
    const [rows] = await connection.execute<SessionRow[]>('SELECT * FROM dsh_model_sessions WHERE session_id = ?', [id])
    return rows[0]
  }

  private async insertSession(connection: PoolConnection, meta: SessionHeader): Promise<ResultSetHeader> {
    const now = Date.now()
    const [result] = await connection.execute<ResultSetHeader>(`
      INSERT INTO dsh_model_sessions (
        session_id, format_version, created_at, working_directory, parent_session_id,
        seed_length, origin, delegation_depth, agent_preset, incarnation, revision, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
    `, [meta.id, meta.version, toMysqlDate(meta.createdAt), meta.cwd ?? null, meta.parentSession ?? null,
      meta.seedLength ?? null, meta.origin ?? null, meta.delegationDepth ?? null, meta.agentPreset ?? null,
      randomUUID(), toMysqlDate(now)])
    return result
  }
}

export default MysqlSessionPersistence
