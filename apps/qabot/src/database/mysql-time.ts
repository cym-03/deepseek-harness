/** Converts between MySQL readable dates and Qabot's millisecond time values. */

/** A date value returned by the MySQL driver. */
export type MysqlDateValue = Date | string

const MYSQL_DATE = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?$/

/** Converts a Unix millisecond value to a MySQL `DATETIME(3)` parameter. */
export function toMysqlDate(value: number): Date
/** Converts an optional Unix millisecond value to a MySQL `DATETIME(3)` parameter. */
export function toMysqlDate(value: number | null): Date | null
export function toMysqlDate(value: number | null): Date | null {
  if (value === null) return null
  if (!Number.isFinite(value)) throw new Error(`MySQL 时间必须是有限毫秒值：${value}`)
  return new Date(value)
}

/** Converts a MySQL `DATETIME(3)` value in Asia/Shanghai to Unix milliseconds. */
export function fromMysqlDate(value: MysqlDateValue): number
/** Converts an optional MySQL `DATETIME(3)` value in Asia/Shanghai to Unix milliseconds. */
export function fromMysqlDate(value: MysqlDateValue | null): number | null
export function fromMysqlDate(value: MysqlDateValue | null): number | null {
  if (value === null) return null
  if (value instanceof Date) {
    const timestamp = value.getTime()
    if (!Number.isFinite(timestamp)) throw new Error('MySQL 返回了无效日期')
    return timestamp
  }
  const match = MYSQL_DATE.exec(value)
  if (match === null) throw new Error(`MySQL 返回了无法识别的日期：${value}`)
  const [, year, month, day, hour, minute, second, milliseconds = '0'] = match
  const timestamp = Date.UTC(
    Number(year), Number(month) - 1, Number(day), Number(hour) - 8,
    Number(minute), Number(second), Number(milliseconds.padEnd(3, '0')),
  )
  if (!Number.isFinite(timestamp)) throw new Error(`MySQL 返回了无效日期：${value}`)
  return timestamp
}
