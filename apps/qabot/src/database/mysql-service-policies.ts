/** MySQL-backed service-group priority and SLA configuration. */
import type { Pool, ResultSetHeader, RowDataPacket } from 'mysql2/promise'
import type { TicketPriority } from '../ticket/store.ts'

export interface ServiceGroupPolicy {
  groupKey: string
  displayName: string
  defaultPriority: TicketPriority
  firstResponseMinutes: number
  resolutionMinutes: number
  enabled: boolean
  updatedAt: number
}

/** Persists service-group policy and applies its durable ticket projection. */
export interface ServicePolicyRepository {
  list(): Promise<ServiceGroupPolicy[]>
  upsert(input: Omit<ServiceGroupPolicy, 'updatedAt'>): Promise<ServiceGroupPolicy>
  applyToTicket(ticketId: number, groupKey: string): Promise<boolean>
  setTicketPriority(ticketId: number, priority: TicketPriority, expectedVersion: number): Promise<boolean>
}

interface PolicyRow extends RowDataPacket {
  group_key: string
  display_name: string
  default_priority: TicketPriority
  first_response_minutes: number
  resolution_minutes: number
  enabled: number
  updated_at: number
}

function toPolicy(row: PolicyRow): ServiceGroupPolicy {
  return {
    groupKey: row.group_key,
    displayName: row.display_name,
    defaultPriority: row.default_priority,
    firstResponseMinutes: row.first_response_minutes,
    resolutionMinutes: row.resolution_minutes,
    enabled: row.enabled === 1,
    updatedAt: row.updated_at,
  }
}

/** Owns production SLA policy reads and ticket deadline writes. */
export class MysqlServicePolicyStore implements ServicePolicyRepository {
  constructor(private readonly pool: Pool) {}

  async list(): Promise<ServiceGroupPolicy[]> {
    const [rows] = await this.pool.execute<PolicyRow[]>(`
      SELECT group_key, display_name, default_priority, first_response_minutes,
        resolution_minutes, enabled, updated_at
      FROM service_group_policies ORDER BY group_key
    `)
    return rows.map(toPolicy)
  }

  async upsert(input: Omit<ServiceGroupPolicy, 'updatedAt'>): Promise<ServiceGroupPolicy> {
    const now = Date.now()
    await this.pool.execute(`
      INSERT INTO service_group_policies (
        group_key, display_name, default_priority, first_response_minutes,
        resolution_minutes, enabled, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE display_name = VALUES(display_name),
        default_priority = VALUES(default_priority), first_response_minutes = VALUES(first_response_minutes),
        resolution_minutes = VALUES(resolution_minutes), enabled = VALUES(enabled), updated_at = VALUES(updated_at)
    `, [
      input.groupKey,
      input.displayName,
      input.defaultPriority,
      input.firstResponseMinutes,
      input.resolutionMinutes,
      input.enabled ? 1 : 0,
      now,
      now,
    ])
    const [rows] = await this.pool.execute<PolicyRow[]>(`
      SELECT group_key, display_name, default_priority, first_response_minutes,
        resolution_minutes, enabled, updated_at FROM service_group_policies WHERE group_key = ?
    `, [input.groupKey])
    const row = rows[0]
    if (row === undefined) throw new Error(`服务组策略写入失败：${input.groupKey}`)
    return toPolicy(row)
  }

  async applyToTicket(ticketId: number, groupKey: string): Promise<boolean> {
    const [policies] = await this.pool.execute<PolicyRow[]>(`
      SELECT group_key, display_name, default_priority, first_response_minutes,
        resolution_minutes, enabled, updated_at
      FROM service_group_policies WHERE group_key = ? AND enabled = 1
    `, [groupKey])
    const policy = policies[0]
    if (policy === undefined) return false
    const now = Date.now()
    const [result] = await this.pool.execute<ResultSetHeader>(`
      UPDATE tickets SET priority = ?, first_response_due_at = ?, resolution_due_at = ?,
        first_agent_response_at = NULL, updated_at = ?, version = version + 1 WHERE id = ?
    `, [
      policy.default_priority,
      now + policy.first_response_minutes * 60_000,
      now + policy.resolution_minutes * 60_000,
      now,
      ticketId,
    ])
    return result.affectedRows > 0
  }

  async setTicketPriority(ticketId: number, priority: TicketPriority, expectedVersion: number): Promise<boolean> {
    const [result] = await this.pool.execute<ResultSetHeader>(`
      UPDATE tickets SET priority = ?, updated_at = ?, version = version + 1 WHERE id = ? AND version = ?
    `, [priority, Date.now(), ticketId, expectedVersion])
    return result.affectedRows > 0
  }
}
