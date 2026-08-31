import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { loadMysqlMigrations } from '../src/database/mysql-migrator.ts'

const directories: string[] = []

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'qabot-mysql-migrations-'))
  directories.push(directory)
  return directory
}

describe('MySQL migration discovery', () => {
  it('loads consecutive migrations in version order', async () => {
    const directory = temporaryDirectory()
    writeFileSync(join(directory, '002_second.sql'), 'SELECT 2;')
    writeFileSync(join(directory, '001_first.sql'), 'SELECT 1;')
    expect((await loadMysqlMigrations(directory)).map(migration => migration.version)).toEqual([1, 2])
  })

  it('rejects gaps and invalid filenames before connecting', async () => {
    const gap = temporaryDirectory()
    writeFileSync(join(gap, '002_second.sql'), 'SELECT 2;')
    await expect(loadMysqlMigrations(gap)).rejects.toThrow('版本必须连续')
    const invalid = temporaryDirectory()
    writeFileSync(join(invalid, 'manual.sql'), 'SELECT 1;')
    await expect(loadMysqlMigrations(invalid)).rejects.toThrow('文件名无效')
  })
})
