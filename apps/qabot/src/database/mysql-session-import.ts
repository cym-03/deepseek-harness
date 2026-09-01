/** One-time importer from Qabot's legacy JSONL session directory into MySQL. */
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import * as AgentSpine from '@deepseek-ai/dsh-agent-spine-demo'
import SessionPersistenceJsonl from '@deepseek-ai/dsh-session-persistence-jsonl'
import type { SessionEvent, SessionHeader, SurfaceEventType } from '@deepseek-ai/dsh-session'
import type { Pool, PoolConnection, RowDataPacket } from 'mysql2/promise'
import { randomUUID } from 'node:crypto'
import { toMysqlDate } from './mysql-time.ts'

function eventEnvelope(event: SessionEvent): [string | null, string | null, number | null] {
  const surface = event as SessionEvent<SurfaceEventType>
  return [
    surface.sourceEventSeqs === undefined ? null : JSON.stringify(surface.sourceEventSeqs),
    surface.surfaceOp === undefined ? null : JSON.stringify(surface.surfaceOp),
    event.ignorable === true ? 1 : null,
  ]
}

async function importSession(
  connection: PoolConnection,
  header: SessionHeader,
  events: readonly SessionEvent[],
): Promise<boolean> {
  const [existing] = await connection.execute<RowDataPacket[]>(
    'SELECT session_id FROM dsh_model_sessions WHERE session_id = ?', [header.id],
  )
  if (existing.length > 0) return false
  const now = Date.now()
  await connection.execute(`
    INSERT INTO dsh_model_sessions (
      session_id, format_version, created_at, working_directory, parent_session_id,
      seed_length, origin, delegation_depth, agent_preset, incarnation, revision, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
  `, [header.id, header.version, toMysqlDate(header.createdAt), header.cwd ?? null, header.parentSession ?? null,
    header.seedLength ?? null, header.origin ?? null, header.delegationDepth ?? null, header.agentPreset ?? null,
    randomUUID(), toMysqlDate(now)])
  for (const event of events) {
    const [sourceEventSeqs, surfaceOperation, ignorable] = eventEnvelope(event)
    await connection.execute(`
      INSERT INTO dsh_model_session_events (
        session_id, event_seq, event_type, event_time, event_data,
        source_event_seqs, surface_operation, ignorable
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `, [header.id, event.seq, event.type, toMysqlDate(event.time), JSON.stringify(event.data),
      sourceEventSeqs, surfaceOperation, ignorable])
  }
  return true
}

/** Imports every readable legacy model session exactly once and retains the files as rollback evidence. */
export async function importLegacyJsonlSessions(pool: Pool, dataDir: string): Promise<number> {
  const [markers] = await pool.execute<RowDataPacket[]>(
    'SELECT import_key FROM qabot_data_imports WHERE import_key = ?', ['legacy-dsh-jsonl-v1'],
  )
  if (markers.length > 0) return 0
  const ctx = new Context()
  await ctx.plugin(AgentSpine, {
    agents: [],
    persona: '',
    includeHarnessIdentity: false,
    includeRuntimeContext: false,
    workspaceContext: false,
    skills: { enabled: false },
    toolBash: false,
    toolJobs: false,
  })
  ctx.plugin(SessionPersistenceJsonl, { root: join(dataDir, 'sessions') })
  await new Promise(resolve => setTimeout(resolve, 100))
  const connection = await pool.getConnection()
  let imported = 0
  try {
    const snapshots = await ctx.sessionPersistence.listSnapshots()
    await connection.beginTransaction()
    for (const snapshot of snapshots) {
      const loaded = await ctx.sessionPersistence.readFrom(snapshot.header.id, 0)
      if (await importSession(connection, loaded.meta, loaded.events)) imported += 1
    }
    await connection.execute(
      'INSERT INTO qabot_data_imports (import_key, imported_at, detail_json) VALUES (?, ?, ?)',
      ['legacy-dsh-jsonl-v1', toMysqlDate(Date.now()), JSON.stringify({ imported, discovered: snapshots.length })],
    )
    await connection.commit()
    return imported
  } catch (error) {
    await connection.rollback()
    throw error
  } finally {
    connection.release()
    await ctx.fiber.dispose()
  }
}
