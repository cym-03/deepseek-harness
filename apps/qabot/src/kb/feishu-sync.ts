/**
 * 飞书知识源同步：把飞书云文档、电子表格与多维表格内容拉取进知识库。
 * - docx：GET docx/v1/documents/{id}/raw_content 拿纯文本（SDK）
 * - sheet：查询工作表后分块读取单元格内容
 * - bitable：GET bitable/v1/apps/{app_token}/tables/{table_id}/records 逐页拉（原生 fetch，SDK 封装不全）
 * 需要应用权限：docx:document:readonly、sheets:spreadsheet:readonly、bitable:app:readonly。
 */

import * as lark from '@larksuiteoapi/node-sdk'
import type { KbStore } from './store.ts'
import { collectVisualHints, storeImageHints, storeVisionAssets } from './image-ocr.ts'
import { visionEmbeddingsConfigured } from './vision-embed.ts'
import { feishuContentToken, type FeishuContentCredentials } from './feishu-auth.ts'

const API_BASE = 'https://open.feishu.cn/open-apis'

export interface DocxSource {
  /** 文档 id（URL 中 /docx/ 后的部分）。 */
  id: string
  /** 显示名（默认用文档 id）。 */
  title?: string
  /** 原文链接（参考文档用）。 */
  url?: string
  /** 是否参与自动同步；仅永久失效的来源会被系统自动停用。 */
  enabled?: boolean
}

export interface BitableSource {
  /** 多维表格 app_token（URL 中 /base/ 后的部分）。 */
  appToken: string
  /** 表 id（URL 中 ?table= 后的部分），必填。 */
  tableId: string
  title?: string
  /** FAQ 表：问题/答案列名。不配则整行转文本。 */
  fields?: { question?: string; answer?: string }
  /** 原文链接（参考文档用）。 */
  url?: string
  enabled?: boolean
}

export interface SheetSource {
  /** 电子表格 token（URL 中 /sheets/ 后的部分）。 */
  spreadsheetToken: string
  /** 可选的工作表 id；缺省时同步所有可见工作表。 */
  sheetId?: string
  title?: string
  /** 原文链接（参考文档用）。 */
  url?: string
  enabled?: boolean
}

export interface WikiSource {
  /** 知识库节点 token（URL 中 /wiki/ 后的部分），可指向文档或表格。 */
  nodeToken: string
  /** 若是多维表格节点，需提供表 id（URL 中 ?table= 后）。 */
  tableId?: string
  title?: string
  /** FAQ 表：问题/答案列名。 */
  fields?: { question?: string; answer?: string }
  /** 原文链接（参考文档用，如 https://xxx.feishu.cn/wiki/<nodeToken>）。 */
  url?: string
  enabled?: boolean
}

export interface FeishuKbSourcesConfig {
  docx: DocxSource[]
  sheets: SheetSource[]
  bitable: BitableSource[]
  wiki: WikiSource[]
}

/** 按空行分段 + 超长切块（与本地 ingest 同策略）。 */
export function chunkText(text: string): string[] {
  const chunks: string[] = []
  for (const paragraph of text.split(/\n\s*\n/).map(p => p.trim()).filter(p => p.length > 0)) {
    if (paragraph.length <= 600) {
      chunks.push(paragraph)
    } else {
      for (let i = 0; i < paragraph.length; i += 600) chunks.push(paragraph.slice(i, i + 600))
    }
  }
  return chunks
}

function valueToText(value: unknown, depth = 0): string {
  if (depth > 3) return ''
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number') {
    // 多维表格的日期字段是毫秒时间戳。用本地时区格式化（toISOString 是 UTC，
    // 会在中国时区把日期往前推一天，例如 8月8日 00:00 +08:00 → UTC 8月7日）。
    if (value > 1e11) {
      const d = new Date(value)
      const pad = (n: number): string => String(n).padStart(2, '0')
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
    }
    return String(value)
  }
  if (typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) {
    return value.map(v => valueToText(v, depth + 1)).filter(Boolean).join('、')
  }
  if (typeof value === 'object') {
    // Bitable 富字段：文本/人员/链接等对象的常见取法。
    const obj = value as Record<string, unknown>
    if (typeof obj.text === 'string') return obj.text
    if (typeof obj.name === 'string') return obj.name
    if (typeof obj.link === 'string') return obj.link
    if (Array.isArray(obj.text)) return obj.text.map(t => valueToText(t, depth + 1)).filter(Boolean).join('、')
    return Object.entries(obj).map(([k, v]) => `${k}:${valueToText(v, depth + 1)}`).join(' ')
  }
  return ''
}

interface SyncResult {
  synced: number
  failed: number
  errors: string[]
  disabledWiki: string[]
}

async function syncDocumentImages(
  kb: KbStore,
  credentials: FeishuContentCredentials,
  documentId: string,
  sourceBase: string,
  title: string,
  url?: string,
): Promise<{ hintChunks: number; visionAssets: number }> {
  const hints = await collectVisualHints(credentials, documentId)
  const hintChunks = storeImageHints(kb, sourceBase, hints, title)
  const visionResult = visionEmbeddingsConfigured()
    ? await storeVisionAssets(kb, credentials, sourceBase, hints, title, url, documentId)
    : { stored: 0, failed: 0, firstFailure: '' }
  if (visionResult.failed > 0) {
    throw new Error(`视觉素材下载失败：${visionResult.firstFailure}`)
  }
  return { hintChunks, visionAssets: visionResult.stored }
}

/** 同步飞书云文档、电子表格和多维表格到知识库。 */
export async function syncFeishuSources(
  client: lark.Client,
  kb: KbStore,
  sources: FeishuKbSourcesConfig,
  credentials: FeishuContentCredentials & { autoPublish?: boolean },
): Promise<SyncResult> {
  const result: SyncResult = { synced: 0, failed: 0, errors: [], disabledWiki: [] }
  const requestOptions = credentials.accessToken === undefined
    ? undefined
    : lark.withUserAccessToken(credentials.accessToken)

  // ── docx 云文档 ──
  for (const source of sources.docx) {
    if (source.enabled === false) continue
    try {
      const resp = await client.docx.v1.document.rawContent({ path: { document_id: source.id } }, requestOptions)
      if (resp.code !== 0 || resp.data?.content === undefined) {
        throw new Error(`docx ${source.id} 拉取失败 code=${resp.code} msg=${resp.msg}`)
      }
      const title = source.title ?? source.id
      const chunks = chunkText(resp.data.content)
      const staged = kb.stageChunks(`feishu:docx:${source.id}`, chunks, title, source.url)
      if (staged.changed && credentials.autoPublish === true && staged.versionId !== undefined) {
        kb.publishVersion(staged.versionId, 'system-sync')
      } else if (credentials.autoPublish === true) {
        kb.setPublication(`feishu:docx:${source.id}`, true)
      }
      result.synced += chunks.length
      try {
        const images = await syncDocumentImages(
          kb,
          credentials,
          source.id,
          `feishu:docx:${source.id}`,
          title,
          source.url,
        )
        result.synced += images.hintChunks + images.visionAssets
        if (images.visionAssets > 0) {
          console.log(`[kb-sync] docx 视觉索引：${images.visionAssets} 张`)
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        result.errors.push(`视觉素材同步失败：${message}`)
        console.error('[kb-sync] docx 视觉素材同步失败:', message)
      }
      console.log(`[kb-sync] docx「${title}」→ ${chunks.length} 块`)
    } catch (error) {
      result.failed += 1
      result.errors.push(error instanceof Error ? error.message : String(error))
      console.error('[kb-sync] docx 同步失败:', error instanceof Error ? error.message : error)
    }
  }

  // ── Bitable 多维表格 ──
  const token = await feishuContentToken(credentials)
  for (const source of sources.bitable) {
    if (source.enabled === false) continue
    try {
      const rows = await fetchBitableRecords(token, source.appToken, source.tableId)
      const texts = rows.map(row => formatRecord(row, source.fields)).filter(t => t.length > 0)
      const title = source.title ?? '多维表格'
      const chunks = texts.flatMap(chunkText)
      const staged = kb.stageChunks(`bitable:${source.appToken}:${source.tableId}`, chunks, title, source.url)
      if (staged.changed && credentials.autoPublish === true && staged.versionId !== undefined) {
        kb.publishVersion(staged.versionId, 'system-sync')
      } else if (credentials.autoPublish === true) {
        kb.setPublication(`bitable:${source.appToken}:${source.tableId}`, true)
      }
      result.synced += chunks.length
      console.log(`[kb-sync] bitable「${title}」→ ${rows.length} 行 / ${chunks.length} 块`)
    } catch (error) {
      result.failed += 1
      result.errors.push(error instanceof Error ? error.message : String(error))
      console.error('[kb-sync] bitable 同步失败:', error instanceof Error ? error.message : error)
    }
  }

  // ── 直接电子表格链接 ──
  for (const source of sources.sheets) {
    if (source.enabled === false) continue
    try {
      const texts = await fetchSpreadsheetTexts(token, source.spreadsheetToken, source.sheetId)
      const title = source.title ?? '电子表格'
      const chunks = texts.flatMap(chunkText)
      const sourceKey = `sheet:${source.spreadsheetToken}:${source.sheetId ?? ''}`
      const staged = kb.stageChunks(sourceKey, chunks, title, source.url)
      if (staged.changed && credentials.autoPublish === true && staged.versionId !== undefined) {
        kb.publishVersion(staged.versionId, 'system-sync')
      } else if (credentials.autoPublish === true) {
        kb.setPublication(sourceKey, true)
      }
      result.synced += chunks.length
      console.log(`[kb-sync] 电子表格「${title}」→ ${texts.length} 行 / ${chunks.length} 块`)
    } catch (error) {
      result.failed += 1
      result.errors.push(error instanceof Error ? error.message : String(error))
      console.error('[kb-sync] 电子表格同步失败:', error instanceof Error ? error.message : error)
    }
  }

  // ── wiki 知识库节点（解析底层对象后按 docx/bitable 处理）──
  for (const source of sources.wiki) {
    if (source.enabled === false) continue
    try {
      const node = await resolveWikiNode(token, source.nodeToken)
      if (node.obj_type === 'docx' || node.obj_type === 'doc') {
        const resp = await client.docx.v1.document.rawContent({ path: { document_id: node.obj_token } }, requestOptions)
        if (resp.code !== 0 || resp.data?.content === undefined) {
          throw new Error(`wiki 文档拉取失败 code=${resp.code} msg=${resp.msg}`)
        }
        const title = source.title ?? node.title ?? node.obj_token
        const chunks = chunkText(resp.data.content)
        const staged = kb.stageChunks(`wiki:${source.nodeToken}`, chunks, title, source.url)
        if (staged.changed && credentials.autoPublish === true && staged.versionId !== undefined) {
          kb.publishVersion(staged.versionId, 'system-sync')
        } else if (credentials.autoPublish === true) {
          kb.setPublication(`wiki:${source.nodeToken}`, true)
        }
        result.synced += chunks.length
        try {
          const images = await syncDocumentImages(
            kb,
            credentials,
            node.obj_token,
            `wiki:${source.nodeToken}`,
            title,
            source.url,
          )
          result.synced += images.hintChunks + images.visionAssets
          if (images.visionAssets > 0) {
            console.log(`[kb-sync] wiki 视觉索引：${images.visionAssets} 张`)
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          result.errors.push(`视觉素材同步失败：${message}`)
          console.error('[kb-sync] wiki 视觉素材同步失败:', message)
        }
        console.log(`[kb-sync] wiki 文档「${title}」→ ${chunks.length} 块`)
      } else if (node.obj_type === 'bitable') {
        if (source.tableId === undefined) {
          throw new Error(`wiki 节点 ${source.nodeToken} 是多维表格，需要 tableId（URL ?table= 后）`)
        }
        const rows = await fetchBitableRecords(token, node.obj_token, source.tableId)
        const texts = rows.map(row => formatRecord(row, source.fields)).filter(t => t.length > 0)
        const title = source.title ?? node.title ?? '多维表格'
        const chunks = texts.flatMap(chunkText)
        const staged = kb.stageChunks(`wiki:${source.nodeToken}`, chunks, title, source.url)
        if (staged.changed && credentials.autoPublish === true && staged.versionId !== undefined) {
          kb.publishVersion(staged.versionId, 'system-sync')
        } else if (credentials.autoPublish === true) {
          kb.setPublication(`wiki:${source.nodeToken}`, true)
        }
        result.synced += chunks.length
        console.log(`[kb-sync] wiki 表格「${title}」→ ${rows.length} 行 / ${chunks.length} 块`)
      } else if (node.obj_type === 'sheet') {
        const texts = await fetchSpreadsheetTexts(token, node.obj_token, sheetIdFromUrl(source.url))
        const title = source.title ?? node.title ?? '电子表格'
        const chunks = texts.flatMap(chunkText)
        const staged = kb.stageChunks(`wiki:${source.nodeToken}`, chunks, title, source.url)
        if (staged.changed && credentials.autoPublish === true && staged.versionId !== undefined) {
          kb.publishVersion(staged.versionId, 'system-sync')
        } else if (credentials.autoPublish === true) {
          kb.setPublication(`wiki:${source.nodeToken}`, true)
        }
        result.synced += chunks.length
        console.log(`[kb-sync] wiki 电子表格「${title}」→ ${texts.length} 行 / ${chunks.length} 块`)
      } else {
        throw new Error(`wiki 节点类型 ${node.obj_type} 暂不支持（仅 docx/sheet/bitable）`)
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      result.failed += 1
      result.errors.push(message)
      // 131005 表示节点已删除或当前租户下不存在。它不是网络抖动，继续定时重试只会制造噪音。
      if (message.includes('code=131005')) result.disabledWiki.push(source.nodeToken)
      console.error('[kb-sync] wiki 同步失败:', message)
    }
  }

  // 同步完成后补齐向量（语义检索用）。
  try {
    const embedded = await kb.embedMissing()
    if (embedded > 0) console.log(`[kb-sync] 已补齐 ${embedded} 个向量`)
    const visionEmbedded = await kb.embedVisionMissing()
    if (visionEmbedded > 0) console.log(`[kb-sync] 已补齐 ${visionEmbedded} 个视觉向量`)
  } catch (error) {
    console.error('[kb-sync] 向量化失败:', error instanceof Error ? error.message : error)
  }

  return result
}

interface WikiNodeInfo {
  obj_type: string
  obj_token: string
  title: string | undefined
}

interface SpreadsheetSheet {
  sheetId: string
  title: string
  rowCount: number
  columnCount: number
}

function sheetIdFromUrl(url: string | undefined): string | undefined {
  if (url === undefined) return undefined
  try {
    const parsed = new URL(url)
    return parsed.searchParams.get('sheet') ?? parsed.searchParams.get('sheetId') ?? undefined
  } catch {
    return undefined
  }
}

function spreadsheetColumnName(columnCount: number): string {
  let value = columnCount
  let name = ''
  while (value > 0) {
    value -= 1
    name = String.fromCharCode(65 + (value % 26)) + name
    value = Math.floor(value / 26)
  }
  return name
}

/** Converts one worksheet's returned cell matrix into searchable row records. */
export function formatSpreadsheetRows(title: string, values: unknown[][]): string[] {
  const rows = values.map(row => row.map(cell => valueToText(cell).trim()))
  const firstContentRow = rows.findIndex(row => row.some(Boolean))
  if (firstContentRow < 0) return []
  const headers = rows[firstContentRow] ?? []
  const result = [`工作表：${title}\n表头：${headers.filter(Boolean).join('、')}`]
  for (let index = firstContentRow + 1; index < rows.length; index += 1) {
    const row = rows[index] ?? []
    if (!row.some(Boolean)) continue
    const fields = row.flatMap((value, column) => {
      if (value === '') return []
      return [`${headers[column] || `列${column + 1}`}：${value}`]
    })
    result.push(`工作表：${title}\n${fields.join('\n')}`)
  }
  return result
}

/** Reads visible worksheets with the submitter's Feishu access token. */
export async function fetchSpreadsheetTexts(
  token: string,
  spreadsheetToken: string,
  requestedSheetId?: string,
): Promise<string[]> {
  const queryUrl = `${API_BASE}/sheets/v3/spreadsheets/${encodeURIComponent(spreadsheetToken)}/sheets/query`
  const queryResponse = await fetch(queryUrl, { headers: { authorization: `Bearer ${token}` } })
  const queryBody = await queryResponse.json() as {
    code?: number
    msg?: string
    data?: { sheets?: Array<{
      sheet_id?: string
      title?: string
      hidden?: boolean
      grid_properties?: { row_count?: number; column_count?: number }
    }> }
  }
  if (queryBody.code !== 0) {
    throw new Error(`电子表格工作表列表失败 code=${queryBody.code} msg=${queryBody.msg}`)
  }
  const sheets: SpreadsheetSheet[] = (queryBody.data?.sheets ?? []).flatMap((sheet) => {
    if (sheet.sheet_id === undefined || sheet.hidden === true) return []
    if (requestedSheetId !== undefined && sheet.sheet_id !== requestedSheetId) return []
    return [{
      sheetId: sheet.sheet_id,
      title: sheet.title ?? sheet.sheet_id,
      rowCount: Math.max(0, sheet.grid_properties?.row_count ?? 0),
      columnCount: Math.max(0, sheet.grid_properties?.column_count ?? 0),
    }]
  })
  if (requestedSheetId !== undefined && sheets.length === 0) {
    throw new Error(`电子表格中未找到工作表 ${requestedSheetId}`)
  }

  const texts: string[] = []
  for (const sheet of sheets) {
    if (sheet.rowCount === 0 || sheet.columnCount === 0) continue
    const rows: unknown[][] = []
    const rowsPerRequest = Math.max(1, Math.floor(5_000 / sheet.columnCount))
    for (let startRow = 1; startRow <= sheet.rowCount; startRow += rowsPerRequest) {
      const endRow = Math.min(sheet.rowCount, startRow + rowsPerRequest - 1)
      const range = `${sheet.sheetId}!A${startRow}:${spreadsheetColumnName(sheet.columnCount)}${endRow}`
      const valuesUrl = `${API_BASE}/sheets/v2/spreadsheets/${encodeURIComponent(spreadsheetToken)}/values/${encodeURIComponent(range)}`
      const valuesResponse = await fetch(valuesUrl, { headers: { authorization: `Bearer ${token}` } })
      const valuesBody = await valuesResponse.json() as {
        code?: number
        msg?: string
        data?: { valueRange?: { values?: unknown[][] }; value_range?: { values?: unknown[][] } }
      }
      if (valuesBody.code !== 0) {
        throw new Error(`电子表格单元格读取失败 code=${valuesBody.code} msg=${valuesBody.msg}`)
      }
      rows.push(...(valuesBody.data?.valueRange?.values ?? valuesBody.data?.value_range?.values ?? []))
    }
    texts.push(...formatSpreadsheetRows(sheet.title, rows))
  }
  return texts
}

/** 解析知识库节点，拿到底层对象类型与 token。 */
async function resolveWikiNode(token: string, nodeToken: string): Promise<WikiNodeInfo> {
  const url = `${API_BASE}/wiki/v2/spaces/get_node?token=${encodeURIComponent(nodeToken)}`
  const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } })
  const body = await res.json() as {
    code?: number
    msg?: string
    data?: { node?: { obj_type?: string; obj_token?: string; title?: string } }
  }
  if (body.code !== 0 || body.data?.node?.obj_type === undefined || body.data.node.obj_token === undefined) {
    throw new Error(`wiki 节点解析失败 code=${body.code} msg=${body.msg}`)
  }
  return {
    obj_type: body.data.node.obj_type,
    obj_token: body.data.node.obj_token,
    title: body.data.node.title,
  }
}

/** 逐页拉多维表格记录。 */
async function fetchBitableRecords(
  token: string,
  appToken: string,
  tableId: string,
): Promise<Array<Record<string, unknown>>> {
  const records: Array<Record<string, unknown>> = []
  let pageToken: string | undefined
  do {
    const url = new URL(`${API_BASE}/bitable/v1/apps/${appToken}/tables/${tableId}/records`)
    url.searchParams.set('page_size', '100')
    if (pageToken !== undefined) url.searchParams.set('page_token', pageToken)
    const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } })
    const body = await res.json() as {
      code?: number
      msg?: string
      data?: {
        items?: Array<{ fields?: Record<string, unknown> }>
        page_token?: string
        has_more?: boolean
      }
    }
    if (body.code !== 0) {
      throw new Error(`bitable 记录失败 code=${body.code} msg=${body.msg}`)
    }
    for (const item of body.data?.items ?? []) {
      records.push(item.fields ?? {})
    }
    pageToken = body.data?.has_more ? body.data.page_token : undefined
  } while (pageToken !== undefined && pageToken !== '')
  return records
}

/** 把 Bitable 一行转成文本。FAQ 表用 question/answer 列；否则整行 key: value。 */
function formatRecord(fields: Record<string, unknown>, columns?: BitableSource['fields']): string {
  if (columns !== undefined && columns.question !== undefined && columns.answer !== undefined) {
    const q = valueToText(fields[columns.question])
    const a = valueToText(fields[columns.answer])
    if (q !== '' || a !== '') return `问题：${q}\n答案：${a}`
  }
  const parts: string[] = []
  for (const [key, value] of Object.entries(fields)) {
    const text = valueToText(value)
    if (text !== '') parts.push(`${key}：${text}`)
  }
  return parts.join('\n')
}
