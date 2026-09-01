import { describe, expect, it } from 'vitest'
import { fromMysqlDate, toMysqlDate } from '../src/database/mysql-time.ts'

describe('MySQL readable time conversion', () => {
  it('round-trips millisecond values through Date parameters', () => {
    const timestamp = Date.UTC(2026, 8, 1, 8, 23, 45, 678)
    expect(fromMysqlDate(toMysqlDate(timestamp))).toBe(timestamp)
  })

  it('reads Asia/Shanghai DATETIME(3) strings as the same instant', () => {
    expect(fromMysqlDate('2026-09-01 16:23:45.678')).toBe(Date.UTC(2026, 8, 1, 8, 23, 45, 678))
    expect(fromMysqlDate(null)).toBeNull()
  })

  it('rejects invalid application and database values', () => {
    expect(() => toMysqlDate(Number.NaN)).toThrow('有限毫秒值')
    expect(() => fromMysqlDate('2026/09/01 16:23:45')).toThrow('无法识别')
  })
})
