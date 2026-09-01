import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { MYSQL_MIGRATION_TABLE_SQL } from '../src/database/mysql-migrator.ts'
import { verifyMysqlSchemaStyle } from '../src/database/mysql-schema-style.ts'

describe('MySQL schema style', () => {
  it('requires Chinese comments and the shared text collation in every migration', async () => {
    for (const name of [
      '001_service_desk.sql',
      '002_knowledge_center.sql',
      '003_knowledge_publication.sql',
      '004_knowledge_asset_binary.sql',
      '005_ticket_sla_policy.sql',
      '006_remove_ticket_priority.sql',
      '008_conversation_messages.sql',
      '009_conversation_message_reads.sql',
      '010_readable_datetime.sql',
    ]) {
      const migration = await readFile(fileURLToPath(new URL(`../migrations/mysql/${name}`, import.meta.url)), 'utf8')
      expect(verifyMysqlSchemaStyle(migration)).toEqual([])
    }
    expect(verifyMysqlSchemaStyle(MYSQL_MIGRATION_TABLE_SQL)).toEqual([])
  })

  it('reports uncommented fields, tables, and text collation drift', () => {
    const invalid = [
      'CREATE TABLE bad_table (',
      '  id BIGINT NOT NULL,',
      "  name VARCHAR(10) COMMENT '名称'",
      ') ENGINE=InnoDB;',
    ].join('\n')
    expect(verifyMysqlSchemaStyle(invalid)).toEqual([
      '第 2 行字段 id 缺少中文 COMMENT',
      '第 3 行文本字段 name 未声明统一字符集和排序规则',
      '第 4 行数据表缺少中文 COMMENT',
    ])
  })

  it('does not treat UPDATE assignments as column declarations', () => {
    expect(verifyMysqlSchemaStyle(`
UPDATE conversations SET
  created_at_readable = FROM_UNIXTIME(created_at / 1000.0);
    `)).toEqual([])
  })
})
