import type { Pool } from 'mysql2/promise'
import { describe, expect, it, vi } from 'vitest'
import {
  MysqlKnowledgeSourceRepository,
  type KnowledgeSourceRecord,
} from '../src/database/mysql-knowledge-sources.ts'

function migratedSource(): KnowledgeSourceRecord {
  return {
    id: 7,
    sourceType: 'feishu_docx',
    sourceKey: 'feishu:docx:migrated',
    title: '旧知识源',
    url: 'https://example.feishu.cn/docx/migrated',
    group: '其他',
    submitterEmployeeId: 'system-migration',
    submitterName: '系统迁移',
    syncStatus: 'failed',
    lastSyncedAt: null,
    lastError: '缺少提交人授权',
    removedAt: null,
    createdAt: 1,
    updatedAt: 1,
    chunks: 0,
    images: 0,
  }
}

describe('MySQL knowledge source migration claims', () => {
  it('lets an authorized caller claim an active migrated source', async () => {
    const execute = vi.fn().mockResolvedValue([{}])
    const repository = new MysqlKnowledgeSourceRepository({ execute } as unknown as Pool)
    const existing = migratedSource()
    vi.spyOn(repository, 'findByKey').mockResolvedValue(existing)
    vi.spyOn(repository, 'get').mockResolvedValue({
      ...existing,
      title: '员工手册',
      group: '人事',
      submitterEmployeeId: 'ou_submitter',
      submitterName: '陈溢敏',
      syncStatus: 'pending',
      lastError: null,
    })

    const result = await repository.createOrReactivate({
      sourceType: 'feishu_docx',
      sourceKey: existing.sourceKey,
      title: '员工手册',
      url: existing.url,
      group: '人事',
      submitterEmployeeId: 'ou_submitter',
      submitterName: '陈溢敏',
      allowMigrationClaim: true,
    })

    expect(result).toMatchObject({ claimed: true, reactivated: false })
    expect(result.source).toMatchObject({ submitterEmployeeId: 'ou_submitter', submitterName: '陈溢敏' })
    expect(execute).toHaveBeenCalledOnce()
    expect(execute.mock.calls[0]?.[1]).toEqual(expect.arrayContaining(['ou_submitter', '陈溢敏']))
  })

  it('keeps an active migrated source protected without explicit claim authority', async () => {
    const repository = new MysqlKnowledgeSourceRepository({} as Pool)
    vi.spyOn(repository, 'findByKey').mockResolvedValue(migratedSource())

    await expect(repository.createOrReactivate({
      sourceType: 'feishu_docx',
      sourceKey: 'feishu:docx:migrated',
      title: '员工手册',
      url: 'https://example.feishu.cn/docx/migrated',
      group: '人事',
      submitterEmployeeId: 'ou_submitter',
      submitterName: '普通维护人',
    })).rejects.toThrow('KNOWLEDGE_SOURCE_EXISTS')
  })

  it('assigns a migrated source when a supervisor synchronizes it', async () => {
    const execute = vi.fn().mockResolvedValue([{ affectedRows: 1 }])
    const repository = new MysqlKnowledgeSourceRepository({ execute } as unknown as Pool)

    await expect(repository.claimMigrated(7, 'ou_submitter', '陈溢敏')).resolves.toBe(true)
    expect(execute.mock.calls[0]?.[1]).toEqual(expect.arrayContaining(['ou_submitter', '陈溢敏', 7]))
  })
})
