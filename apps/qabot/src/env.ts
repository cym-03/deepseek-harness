/** 极简 .env 加载：把 KEY=VALUE 写进 process.env。 */

import { existsSync, readFileSync } from 'node:fs'

export function loadEnv(path: string, options: { override?: boolean } = {}): void {
  if (!existsSync(path)) return
  const text = readFileSync(path, 'utf8')
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq < 0) continue
    const key = trimmed.slice(0, eq).trim()
    const value = trimmed.slice(eq + 1).trim()
    if (key !== '' && (options.override === true || process.env[key] === undefined)) {
      process.env[key] = value
    }
  }
}
