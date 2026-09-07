import type { KbMediaRef } from './store.ts'

/** Minimal knowledge retrieval API shared by the model tool and HTTP routing. */
export interface KnowledgeSearch {
  search(query: string, limit?: number): Promise<string>
  hasRelevantContent(query: string): Promise<boolean>
}

export interface KnowledgeVisionStatus {
  configured: boolean
  model: string | null
  assets: number
  embeddings: number
  cachedQueries: number
  returnedImages: number
}

/** MySQL-capable visual retrieval used by employee chat and asset delivery. */
export interface KnowledgeMediaSearch {
  findVisionMedia(query: string, limit?: number, supportingText?: string): Promise<KbMediaRef[]>
  visionAsset(id: number): Promise<{ mime: string; image: Buffer } | undefined>
  visionStatus(): Promise<KnowledgeVisionStatus>
}

/** Metadata used to attach images that the generated answer names explicitly. */
export interface MentionedVisionCandidate<T> {
  item: T
  title: string
  description: string
}

function boardTopic(title: string): string {
  return normalizedVisualText(title
    .replace(/^(?:画板提示|画板)[:：]\s*/, '')
    .replace(/[（(]画板文字[）)]$/, ''))
}

/** Removes a board placeholder when the same candidate set contains its OCR text. */
export function removeSupersededBoardHints<T extends { title: string; content: string }>(rows: readonly T[]): T[] {
  const ocrTopics = new Set(rows.flatMap((row) => {
    const hasOcr = /画板识别文字：\S/.test(row.content) || /[（(]画板文字[）)]$/.test(row.title)
    return hasOcr ? [boardTopic(row.title)] : []
  }))
  return rows
    .filter(row => !/^画板提示[:：]/.test(row.title) || !ocrTopics.has(boardTopic(row.title)))
    .map((row, index) => ({ row, index, ocr: /画板识别文字：\S/.test(row.content) }))
    .sort((left, right) => Number(right.ocr) - Number(left.ocr) || left.index - right.index)
    .map(item => item.row)
}

function explicitMediaLabels(title: string, description: string): string[] {
  const captionLabels = [...description.matchAll(/图片说明：([^\n]+)/g)]
    .flatMap(match => match[1] === undefined ? [] : [match[1].trim()])
  const boardTitle = title.match(/^画板：(.+)$/)?.[1]?.trim()
  if (boardTitle === undefined) return captionLabels
  const topic = boardTitle.replace(/^[（(]?[一二三四五六七八九十0-9]+[）)]?[、.．-]?\s*/, '').trim()
  return topic === boardTitle ? [...captionLabels, boardTitle] : [...captionLabels, boardTitle, topic]
}

const GENERIC_VISUAL_TERMS = new Set([
  '公司', '员工', '信息', '图片', '申请', '审批', '流程', '相关', '管理', '说明', '画板',
])

function normalizedVisualText(value: string): string {
  return value.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')
}

/** Requires an automatic visual match to share a specific title term with the question or answer. */
export function visionTitleMatchesContext(title: string, description: string, query: string, supportingText: string): boolean {
  if (/^图片：/.test(title) && !/图片说明：\S/.test(description)) return false
  const rawTitle = title.replace(/^(?:图片|画板)[:：]\s*/, '').replace(/^[（(]?[一二三四五六七八九十0-9]+[）)]?[、.．-]?\s*/, '')
  const normalizedTitle = normalizedVisualText(rawTitle)
  const context = normalizedVisualText(`${query}\n${supportingText}`)
  for (let index = 0; index < normalizedTitle.length - 1; index += 1) {
    const term = normalizedTitle.slice(index, index + 2)
    if (!GENERIC_VISUAL_TERMS.has(term) && context.includes(term)) return true
  }
  return false
}

/**
 * Prepends assets named by the answer to vector matches without another embedding request.
 * Generic document-image labels are excluded because they would attach every uncaptioned image from a cited source.
 */
export function mergeMentionedVisionMatches<T extends { id: number }>(
  vectorMatches: readonly T[],
  candidates: readonly MentionedVisionCandidate<T>[],
  supportingText: string,
  limit: number,
): T[] {
  const cappedLimit = Math.max(1, Math.min(5, Math.trunc(limit)))
  const mentioned = supportingText === '' ? [] : candidates.flatMap((candidate) => {
    const positions = explicitMediaLabels(candidate.title, candidate.description)
      .map(label => supportingText.indexOf(label))
      .filter(position => position >= 0)
    return positions.length === 0 ? [] : [{ item: candidate.item, position: Math.min(...positions) }]
  }).sort((left, right) => left.position - right.position).map(match => match.item)
  const merged = new Map<number, T>()
  for (const item of [...mentioned, ...vectorMatches]) merged.set(item.id, item)
  return [...merged.values()].slice(0, cappedLimit)
}

/** A scored visual candidate before confidence filtering. */
export interface VisionMatch<T> {
  item: T
  score: number
  corroborates?: boolean
}

function configuredScore(name: string, fallback: number): number {
  const parsed = Number(process.env[name] ?? fallback)
  return Number.isFinite(parsed) && parsed >= -1 && parsed <= 1 ? parsed : fallback
}

/**
 * Keeps a strong visual match, or a lower-scoring cluster whose independent images agree on the query.
 * A lone weak result is rejected so a generally similar diagram does not appear under unrelated answers.
 */
export function selectVisionMatches<T>(matches: readonly VisionMatch<T>[], limit: number): T[] {
  const strongScore = configuredScore('VISION_MEDIA_STRONG_SCORE', 0.45)
  const clusterScore = configuredScore('VISION_MEDIA_CLUSTER_SCORE', 0.40)
  const clusterMargin = configuredScore('VISION_MEDIA_CLUSTER_MARGIN', 0.02)
  const sorted = [...matches]
    .filter(match => Number.isFinite(match.score))
    .sort((left, right) => right.score - left.score)
  const first = sorted[0]
  if (first === undefined) return []
  const hasStrongMatch = first.score >= strongScore
  const corroborating = sorted.filter(match => match.corroborates !== false)
  const clusterFirst = corroborating[0]
  const clusterSecond = corroborating[1]
  const hasCorroboratingCluster = clusterFirst !== undefined
    && clusterFirst.score >= clusterScore
    && clusterSecond !== undefined
    && clusterSecond.score >= clusterScore
    && clusterFirst.score - clusterSecond.score <= clusterMargin
  if (!hasStrongMatch && !hasCorroboratingCluster) return []
  const cutoff = hasStrongMatch
    ? strongScore
    : Math.max(clusterScore, first.score - clusterMargin)
  return sorted
    .filter(match => match.score >= cutoff && (hasStrongMatch || match.corroborates !== false))
    .slice(0, Math.max(1, Math.min(5, Math.trunc(limit))))
    .map(match => match.item)
}
