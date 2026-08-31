/**
 * 知识库 ingest：扫描 docs 目录下的文本文件（md/txt），按段落分块后写入 KbStore。
 */

import { readdir, readFile } from 'node:fs/promises'
import { join, relative, extname } from 'node:path'
import type { KbStore } from './store.ts'

const SUPPORTED = new Set(['.md', '.txt', '.markdown'])

/** 按空行分段，再把过长段落切成 ~600 字符的块。 */
function chunkText(text: string): string[] {
  const paragraphs = text
    .split(/\n\s*\n/)
    .map(part => part.trim())
    .filter(part => part.length > 0)
  const chunks: string[] = []
  for (const paragraph of paragraphs) {
    if (paragraph.length <= 600) {
      chunks.push(paragraph)
      continue
    }
    for (let i = 0; i < paragraph.length; i += 600) {
      chunks.push(paragraph.slice(i, i + 600))
    }
  }
  return chunks
}

/** 递归收集支持的文档文件。 */
async function collectFiles(dir: string): Promise<string[]> {
  const out: string[] = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      out.push(...await collectFiles(full))
    } else if (SUPPORTED.has(extname(entry.name))) {
      out.push(full)
    }
  }
  return out
}

/** 把 docs 目录（递归）索引进知识库。返回写入的分块数。 */
export async function ingestDir(store: KbStore, dir: string): Promise<number> {
  const files = await collectFiles(dir)
  let total = 0
  for (const file of files) {
    const text = await readFile(file, 'utf8')
    const title = file.split(/[\\/]/).pop() ?? file
    const source = relative(dir, file)
    const chunks = chunkText(text)
    store.upsertChunks(source, chunks, title)
    total += chunks.length
  }
  return total
}
