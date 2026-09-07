import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { MysqlKnowledgeSourceRepository } from '../src/database/mysql-knowledge-sources.ts'
import { createMysqlPool, loadMysqlMigrations, migrateMysql } from '../src/database/mysql-migrator.ts'

const databaseUrl = process.env.QABOT_TEST_MYSQL_URL
const describeMysql = databaseUrl === undefined ? describe.skip : describe

describeMysql('MySQL online knowledge sources', () => {
  it('rejects active duplicates, soft-removes, and restores the same source record', async () => {
    if (databaseUrl === undefined) throw new Error('QABOT_TEST_MYSQL_URL is required')
    const pool = createMysqlPool(databaseUrl, 2)
    const sourceKey = `feishu:docx:${randomUUID()}`
    const repository = new MysqlKnowledgeSourceRepository(pool)
    let id = 0
    try {
      const directory = fileURLToPath(new URL('../migrations/mysql', import.meta.url))
      await migrateMysql(pool, await loadMysqlMigrations(directory))
      const created = await repository.createOrReactivate({
        sourceType: 'feishu_docx',
        sourceKey,
        title: '员工制度',
        url: 'https://example.feishu.cn/docx/test',
        group: '人事',
        submitterEmployeeId: 'employee-1',
        submitterName: '测试员工',
      })
      id = created.source.id
      expect(created.reactivated).toBe(false)
      expect(created.claimed).toBe(false)
      expect(created.source).toMatchObject({ group: '人事', submitterName: '测试员工', syncStatus: 'pending' })
      await expect(repository.createOrReactivate({
        sourceType: 'feishu_docx', sourceKey, title: '重复', url: created.source.url,
        group: '人事', submitterEmployeeId: 'employee-1', submitterName: '测试员工',
      })).rejects.toThrow('KNOWLEDGE_SOURCE_EXISTS')

      await repository.markReady(id)
      expect((await repository.get(id))?.lastSyncedAt).not.toBeNull()
      expect(await repository.update(id, '员工制度（已编辑）', '行政')).toBe(true)
      expect(await repository.get(id)).toMatchObject({ title: '员工制度（已编辑）', group: '行政' })
      expect(await repository.remove(id)).toBe(true)
      expect(await repository.list()).toEqual(expect.not.arrayContaining([expect.objectContaining({ id })]))

      const restored = await repository.createOrReactivate({
        sourceType: 'feishu_docx', sourceKey, title: '员工制度（恢复）', url: created.source.url,
        group: '其他', submitterEmployeeId: 'employee-2', submitterName: '恢复人员',
      })
      expect(restored.reactivated).toBe(true)
      expect(restored.claimed).toBe(false)
      expect(restored.source).toMatchObject({ id, title: '员工制度（恢复）', group: '其他', syncStatus: 'pending' })

      await pool.execute(`UPDATE knowledge_sources SET owner_employee_id = 'system-migration',
        submitter_name = '系统迁移' WHERE id = ?`, [id])
      const claimed = await repository.createOrReactivate({
        sourceType: 'feishu_docx', sourceKey, title: '员工制度（认领）', url: created.source.url,
        group: '人事', submitterEmployeeId: 'employee-3', submitterName: '主管', allowMigrationClaim: true,
      })
      expect(claimed).toMatchObject({ reactivated: false, claimed: true })
      expect(claimed.source).toMatchObject({ id, title: '员工制度（认领）', group: '人事',
        submitterEmployeeId: 'employee-3', submitterName: '主管', syncStatus: 'pending' })
    } finally {
      if (id > 0) await pool.execute('DELETE FROM knowledge_sources WHERE id = ?', [id])
      await pool.end()
    }
  }, 30_000)
})
