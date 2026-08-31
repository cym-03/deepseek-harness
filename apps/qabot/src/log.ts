/**
 * 文件日志：把 console 输出同时写入日志文件（追加），便于服务常驻时排查。
 */

import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

function format(level: string, args: unknown[]): string {
  const time = new Date().toISOString().replace('T', ' ').slice(0, 19)
  const body = args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')
  return `[${time}] [${level}] ${body}`
}

/** 启用文件日志（幂等）。默认写 data/qabot.log。 */
export function enableFileLog(path: string): void {
  try { mkdirSync(dirname(path), { recursive: true }) } catch { /* 忽略 */ }
  const origLog = console.log
  const origError = console.error
  const origWarn = console.warn

  console.log = (...args) => {
    origLog(...args)
    try { appendFileSync(path, format('INFO', args) + '\n', 'utf8') } catch { /* 磁盘满等，忽略 */ }
  }
  console.warn = (...args) => {
    origWarn(...args)
    try { appendFileSync(path, format('WARN', args) + '\n', 'utf8') } catch { /* 忽略 */ }
  }
  console.error = (...args) => {
    origError(...args)
    try { appendFileSync(path, format('ERROR', args) + '\n', 'utf8') } catch { /* 忽略 */ }
  }
}
