/** Static MySQL DDL rules for Qabot migrations. */
const COLUMN_LINE = /^\s{2}([a-z][a-z0-9_]*)\s+(.+),?$/
const NON_COLUMN_PREFIXES = ['PRIMARY ', 'UNIQUE ', 'KEY ', 'CONSTRAINT ', 'FOREIGN ', 'CHECK ']
const CHINESE = /[\u3400-\u9fff]/

/** Returns schema-style violations for one or more CREATE TABLE statements. */
export function verifyMysqlSchemaStyle(sql: string): string[] {
  const errors: string[] = []
  for (const [index, line] of sql.split(/\r?\n/).entries()) {
    const trimmed = line.trimStart()
    if (NON_COLUMN_PREFIXES.some(prefix => trimmed.startsWith(prefix))) continue
    if (/^[a-z][a-z0-9_]*\s*=/.test(trimmed)) continue
    const column = COLUMN_LINE.exec(line)
    if (column !== null) {
      const definition = column[2] ?? ''
      if (!/\bCOMMENT\s+'[^']+'/i.test(definition) || !CHINESE.test(definition)) {
        errors.push(`第 ${index + 1} 行字段 ${column[1]} 缺少中文 COMMENT`)
      }
      if (/\b(?:VAR)?CHAR\b|\bTEXT\b/i.test(definition)
        && !/CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci/i.test(definition)) {
        errors.push(`第 ${index + 1} 行文本字段 ${column[1]} 未声明统一字符集和排序规则`)
      }
    }
    if (/^\) ENGINE=InnoDB/i.test(trimmed)
      && (!/COMMENT='[^']+'/i.test(line) || !CHINESE.test(line))) {
      errors.push(`第 ${index + 1} 行数据表缺少中文 COMMENT`)
    }
  }
  return errors
}
