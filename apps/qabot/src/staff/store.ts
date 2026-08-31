/**
 * 服务人员名单存储：按身份/部门分组（IT、人事、行政、财务…）。
 * 数据源：SQLite（qa-admin 后台动态配置）+ data/staff.json（手动兜底，按组）。
 * staff.json 格式：{ "IT": ["ou_..."], "人事": ["ou_..."], ..., "default": ["ou_..."] }
 */

import { DatabaseSync } from 'node:sqlite'
import { existsSync, readFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

export interface StaffMember {
  openId: string
  /** 身份/部门分组（IT、人事、行政、财务…；default 为兜底组）。 */
  group: string
  name: string | null
  active: boolean
}

interface StaffRow {
  open_id: string
  group: string
  name: string | null
  active: number
}

export class StaffStore {
  private readonly db: DatabaseSync

  constructor(dbPath: string, private readonly fallbackFile?: string) {
    if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true })
    this.db = new DatabaseSync(dbPath)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS staff_members (
        open_id TEXT NOT NULL,
        group_name TEXT NOT NULL DEFAULT 'default',
        name TEXT,
        active INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (open_id, group_name)
      );
      CREATE INDEX IF NOT EXISTS idx_staff_group ON staff_members (group_name);
      CREATE TABLE IF NOT EXISTS staff_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `)
    this.importFallbackOnce()
  }

  /** 从 data/staff.json 读手动配置（{ 组名: [open_id] }），去重。 */
  private fallbackMembers(): StaffMember[] {
    if (this.fallbackFile === undefined || !existsSync(this.fallbackFile)) return []
    try {
      const parsed = JSON.parse(readFileSync(this.fallbackFile, 'utf8')) as Record<string, unknown>
      const out: StaffMember[] = []
      for (const [group, list] of Object.entries(parsed)) {
        if (!Array.isArray(list)) continue
        for (const openId of new Set(list.filter((x): x is string => typeof x === 'string'))) {
          out.push({ openId, group, name: null, active: true })
        }
      }
      return out
    } catch {
      return []
    }
  }

  private importFallbackOnce(): void {
    const imported = this.db.prepare("SELECT value FROM staff_meta WHERE key = 'fallback_imported'").get()
    if (imported !== undefined) return
    const insert = this.db.prepare(`
      INSERT OR IGNORE INTO staff_members (open_id, group_name, name, active, created_at)
      VALUES (?, ?, NULL, 1, ?)
    `)
    this.db.exec('BEGIN;')
    try {
      for (const member of this.fallbackMembers()) insert.run(member.openId, member.group, Date.now())
      this.db.prepare("INSERT INTO staff_meta (key, value) VALUES ('fallback_imported', '1')").run()
      this.db.exec('COMMIT;')
    } catch (error) {
      this.db.exec('ROLLBACK;')
      throw error
    }
  }

  /** 全部服务人员；文件配置仅在首次启动时迁入数据库。 */
  list(): StaffMember[] {
    const fromDb = this.db.prepare(
      'SELECT open_id, group_name AS "group", name, active FROM staff_members ORDER BY created_at',
    ).all() as unknown as Array<Omit<StaffRow, 'group'> & { group: string }>
    return fromDb.map(row => ({ openId: row.open_id, group: row.group, name: row.name, active: row.active === 1 }))
  }

  /** 某身份组可通知的全部 open_id；不跨组回退。 */
  notifyTargets(group?: string): string[] {
    const members = this.list().filter(m => m.active)
    if (group !== undefined) {
      return members.filter(m => m.group === group).map(m => m.openId)
    }
    return members.map(m => m.openId)
  }

  /** 所有已配置的分组名。 */
  groups(): string[] {
    const groups = new Set(this.list().map(m => m.group))
    groups.add('default')
    return [...groups]
  }

  /** 新增/更新某组的服务人员。 */
  upsert(member: { openId: string; group?: string; name?: string; active?: boolean }): void {
    const group = member.group ?? 'default'
    this.db.prepare(`
      INSERT INTO staff_members (open_id, group_name, name, active, created_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(open_id, group_name) DO UPDATE SET
        name = excluded.name,
        active = excluded.active
    `).run(
      member.openId,
      group,
      member.name ?? null,
      member.active === false ? 0 : 1,
      Date.now(),
    )
  }

  /** 删除某组的服务人员。返回是否命中。 */
  remove(openId: string, group?: string): boolean {
    if (group !== undefined) {
      const result = this.db.prepare(
        'DELETE FROM staff_members WHERE open_id = ? AND group_name = ?',
      ).run(openId, group)
      return Number(result.changes) > 0
    }
    const result = this.db.prepare('DELETE FROM staff_members WHERE open_id = ?').run(openId)
    return Number(result.changes) > 0
  }

  dispose(): void {
    this.db.close()
  }
}
