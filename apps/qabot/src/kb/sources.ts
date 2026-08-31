/**
 * 飞书知识源配置存储：读写 data/kb-sources.json。
 * 格式：{ "docx": [{ id, title? }], "bitable": [{ appToken, tableId?, title?, fields? }] }
 */

import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { FeishuKbSourcesConfig } from './feishu-sync.ts'

const EMPTY: FeishuKbSourcesConfig = { docx: [], bitable: [], wiki: [] }

export class KbSourcesStore {
  constructor(private readonly file: string) {}

  load(): FeishuKbSourcesConfig {
    if (!existsSync(this.file)) return structuredClone(EMPTY)
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<FeishuKbSourcesConfig>
      return {
        docx: Array.isArray(parsed.docx) ? parsed.docx : [],
        bitable: Array.isArray(parsed.bitable) ? parsed.bitable : [],
        wiki: Array.isArray(parsed.wiki) ? parsed.wiki : [],
      }
    } catch {
      return structuredClone(EMPTY)
    }
  }

  save(config: FeishuKbSourcesConfig): void {
    mkdirSync(dirname(this.file), { recursive: true })
    writeFileSync(this.file, JSON.stringify(config, null, 2), 'utf8')
  }

  disableWiki(nodeTokens: string[]): number {
    if (nodeTokens.length === 0) return 0
    const targets = new Set(nodeTokens)
    const config = this.load()
    let changed = 0
    config.wiki = config.wiki.map((source) => {
      if (!targets.has(source.nodeToken) || source.enabled === false) return source
      changed += 1
      return { ...source, enabled: false }
    })
    if (changed > 0) this.save(config)
    return changed
  }
}
